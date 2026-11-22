import { createHash } from "node:crypto";
import { runAcpProvider, type AcpOptions, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderLaunch,
  ProviderRegistration,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { latestModelIds, openAgyStream } from "./agy-stream.ts";
import { execAgy, installedWindowsAgy, resolveAgyLaunch } from "./agy-launch.ts";
import { refreshSessionList } from "./session-list.ts";
import { DEFAULT_MODE, withBypassMode, withModelThinking } from "./catalog.ts";
import { launchContext, wrapConnection } from "./session-wrapper.ts";
import { AGY_ENV, SUBAGENT_GUIDANCE } from "./subagents.ts";
import { classifyCommand, keepsTurnOpen, mapToolCall } from "./tool-calls.ts";

export const PROVIDER_ID = "antigravity-plus";
const LABEL = "Antigravity+";
/** agy 1.5.8 added context window updates to ACP sessions; earlier ACP lacks them. */
const MIN_AGY = [1, 5, 8] as const;
/** Bump when the catalog this plugin builds changes shape, so Paseo drops its cached copy. */
const CATALOG_REVISION = 3;

/** Additive Paseo 0.17.1+ ACP options (safely ignored on 0.16.x hosts). */
type ExtendedAcpOptions = AcpOptions & {
  loadReplayQuietPeriodMs?: number;
  deferTurnOnRunningTools?: {
    keepsTurnOpen?: typeof keepsTurnOpen;
  };
};

/** Additive Paseo 0.17.1+ ACP transformer hooks (safely ignored on 0.16.x hosts). */
type ExtendedAcpTransformer = AcpTransformer & {
  command?: typeof classifyCommand;
};

/** Adds Bypass as an explicit choice, applies the configured default mode, classifies commands/skills, and maps native tool cards. */
function createCatalogTransformer(defaultMode: () => string): ExtendedAcpTransformer {
  return {
    discover(catalog) {
      return {
        ...catalog,
        modes: withBypassMode(catalog.modes),
        defaultMode: defaultMode(),
        models: withModelThinking(catalog.models, latestModelIds()),
      };
    },
    command: classifyCommand,
    toolCall: mapToolCall,
  };
}

function compareVersion(version: string): number | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== MIN_AGY[index]) return parts[index] - MIN_AGY[index];
  }
  return 0;
}

async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const { stdout } = await execAgy(["--version"], 10_000, launch);
    const version = stdout.trim();
    const comparison = compareVersion(version);
    if (comparison === null) {
      return { available: false, diagnostic: `Could not read the agy version from "${version}".` };
    }
    if (comparison < 0) {
      return {
        available: false,
        diagnostic: `agy ${version} is too old for Antigravity+. Run \`agy update\` to get ${MIN_AGY.join(".")} or later.`,
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      diagnostic: `agy did not start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ProviderAccounts {
  ready(): Promise<void>;
  activeId(): string | null;
  canOpen(): boolean;
  guard(connection: ProviderConnection): ProviderConnection;
  rememberLaunch(launch: ProviderLaunch): void;
}

export interface ProviderOptions {
  /** Ensures host preferences have been loaded before reading `defaultMode`. */
  ready?(): Promise<void>;
  /** Mode for new sessions when none is requested; defaults to agy's native Default mode. */
  defaultMode?(): string;
}

export function createAntigravityPlusProvider(
  accounts?: ProviderAccounts,
  options?: ProviderOptions,
): ProviderRegistration {
  const resolveDefaultMode = () => options?.defaultMode?.() ?? DEFAULT_MODE;
  const catalogTransformer = createCatalogTransformer(resolveDefaultMode);
  return {
    id: PROVIDER_ID,
    label: LABEL,
    icon: "icon.svg",
    command: [installedWindowsAgy() ?? "agy", "acp"],
    description: "Antigravity CLI through its ACP server, with history, permissions and skills",
    async status(request) {
      const launch = resolveAgyLaunch(request.launch);
      if (!launch) {
        return {
          available: false,
          diagnostic: "agy not found on PATH. Install Antigravity, then run `agy` and sign in.",
        };
      }
      accounts?.rememberLaunch(launch);
      return getStatus(launch);
    },
    async getCatalogCacheKey(request) {
      const launch = resolveAgyLaunch(request.launch);
      if (!launch) return undefined;
      await Promise.all([accounts?.ready(), options?.ready?.()]);
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(
          JSON.stringify([
            PROVIDER_ID,
            CATALOG_REVISION,
            resolveDefaultMode(),
            accounts?.activeId(),
            launch.command,
            launch.args,
            env,
          ]),
        )
        .digest("hex");
    },
    async connect(request) {
      const launch = resolveAgyLaunch(request.launch);
      if (!launch) throw new Error("The daemon must supply the agy launch command");
      await Promise.all([accounts?.ready(), options?.ready?.()]);
      if (accounts && !accounts.canOpen()) throw new Error("Account change in progress");
      accounts?.rememberLaunch(launch);
      // Fill the Import session list in the background so the dialog opens without agy's start-up wait.
      void refreshSessionList(launch, AGY_ENV);
      const inner = await runAcpProvider({
        id: PROVIDER_ID,
        label: LABEL,
        icon: "icon.svg",
        connector: () => {
          if (accounts && !accounts.canOpen()) throw new Error("Account change in progress");
          const context = launchContext.getStore();
          const agy = openAgyStream(launch, context?.env ?? { ...AGY_ENV }, {
            canProbe: accounts?.canOpen,
            policy: context?.policy,
            cwd: context?.cwd,
            appendSystemPrompt: SUBAGENT_GUIDANCE,
          });
          context?.register?.(agy);
          return agy.stream;
        },
        transformers: [catalogTransformer],
        // agy sends commands and skills right after session/new|load, can stream trailing
        // replay chunks after load, and can yield while non-daemon background tools still run.
        acpOptions: {
          waitForInitialCommands: true,
          loadReplayQuietPeriodMs: 200,
          deferTurnOnRunningTools: { keepsTurnOpen },
        } as ExtendedAcpOptions,
      }).connect({ ...request, launch });
      const connection = wrapConnection(inner, request.capabilities, {
        modelIds: latestModelIds,
        env: AGY_ENV,
        defaultMode: resolveDefaultMode,
      });
      return accounts?.guard(connection) ?? connection;
    },
  };
}
