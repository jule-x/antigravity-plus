import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { PluginHookAgent, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { PROVIDER_ID } from "./provider.ts";
import { CLI_SUMMARIES_DB } from "./session-list.ts";

type PaseoApi = PluginHookContext["paseo"];
type PaseoAgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;

/** Host daemon packages resolved from the Paseo plugin runner when available. */
const HOST_MODULES = [
  "@getpaseo/client/internal/daemon-client",
  "@getpaseo/server/daemon-control",
  "ws",
] as const;

/** Backoff schedule while waiting for agy to finish writing its async conversation title. */
const DEFAULT_RETRY_DELAYS_MS = [0, 1500, 3000, 5000] as const;
const RENAME_TIMEOUT_MS = 10_000;
const MAX_TITLE_LENGTH = 120;
const MAX_TIMELINE_PAGES = 10;

interface SqliteDatabase {
  prepare(sql: string): { get(param: string): { title?: unknown } | undefined };
  close(): void;
}

interface HostDaemonClient {
  connect(): Promise<void>;
  updateAgent(agentId: string, updates: { name?: string }): Promise<void>;
  close(): Promise<void>;
}

/**
 * The provisional title Paseo assigns an agent from its first prompt when none is set:
 * first non-empty line, collapsed whitespace, at most 60 characters.
 */
export function provisionalTitle(prompt: string): string | null {
  const line = prompt
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  const collapsed = line?.replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return collapsed || null;
}

/** Extracts agy's native conversation UUID from Paseo's plugin-wrapped `runtimeInfo.sessionId`. */
export function extractAgySessionId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("plugin:")) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice("plugin:".length));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "data" in parsed &&
        typeof parsed.data === "object" &&
        parsed.data !== null &&
        "sessionId" in parsed.data &&
        typeof parsed.data.sessionId === "string"
      ) {
        const inner = parsed.data.sessionId.trim();
        return inner || null;
      }
    } catch {
      return null;
    }
    return null;
  }
  return /^[0-9A-Za-z-]+$/.test(trimmed) ? trimmed : null;
}

/** Reads agy's generated conversation title from `conversation_summaries.db`. */
export function readAgyTitle(sessionId: string, databasePath = CLI_SUMMARIES_DB): string | null {
  if (!sessionId || !existsSync(databasePath)) return null;
  let db: SqliteDatabase | null = null;
  try {
    // Paseo bundles plugins without import.meta.url; getBuiltinModule needs no base path.
    const sqlite = process.getBuiltinModule("node:sqlite") as
      | {
          DatabaseSync: new (location: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase;
        }
      | undefined;
    if (!sqlite?.DatabaseSync) return null;
    db = new sqlite.DatabaseSync(databasePath, { readOnly: true, timeout: 200 });
    const row = db
      .prepare("SELECT title FROM conversation_summaries WHERE conversation_id = ?")
      .get(sessionId);
    if (!row || typeof row.title !== "string") return null;
    const normalized = row.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
    return normalized || null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors.
    }
  }
}

function socketTarget(listen: string): { url: string; socketPath?: string } | null {
  if (listen.startsWith("unix://") || listen.startsWith("/")) {
    const socketPath = listen.replace(/^unix:\/\//, "");
    return { url: `ws+unix://${socketPath}:/ws`, socketPath };
  }
  if (/^[^/\s]+:\d+$/.test(listen)) return { url: `ws://${listen}/ws` };
  return null;
}

/**
 * Updates an agent's title through the host daemon's `updateAgent` RPC.
 * Paseo's public plugin SDK (0.16.x) does not yet expose `agent.setTitle` or a provider title
 * event, so this connects through the host runner's own daemon client and silently degrades to
 * `false` if the host layout changes.
 */
export async function renameHostAgent(agentId: string, title: string): Promise<boolean> {
  const entry = process.argv[1];
  if (!entry) return false;
  let client: HostDaemonClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hostRequire = createRequire(entry);
    const load = (id: string) => import(pathToFileURL(hostRequire.resolve(id)).href);
    const [clientModule, control, ws] = await Promise.all(HOST_MODULES.map(load));
    const home: string = process.env.PASEO_HOME || control.resolvePaseoHome(process.env);
    const listen: unknown = (await control.readDaemonInstance(home))?.listen;
    if (typeof listen !== "string" || !listen.trim()) return false;
    const target = socketTarget(listen.trim());
    if (!target) return false;
    const WebSocketCtor = ws.default ?? ws.WebSocket;
    client = new clientModule.DaemonClient({
      url: target.url,
      clientId: "cid_antigravity_plus_title_sync",
      clientType: "cli",
      localCredential: () => control.readLocalCredentialForTarget(home, listen) ?? undefined,
      connectTimeoutMs: RENAME_TIMEOUT_MS,
      webSocketFactory: (
        url: string,
        config?: { headers?: Record<string, string>; protocols?: string | string[] },
      ) =>
        new WebSocketCtor(url, config?.protocols, {
          headers: config?.headers,
          ...(target.socketPath ? { socketPath: target.socketPath } : {}),
        }),
      reconnect: { enabled: false },
    }) as HostDaemonClient;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("rename timed out")), RENAME_TIMEOUT_MS);
      timer.unref();
    });
    await Promise.race([
      (async () => {
        await client!.connect();
        await client!.updateAgent(agentId, { name: title });
      })(),
      timeout,
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    await client?.close().catch(() => {});
  }
}

async function readFirstUserPrompt(agent: PaseoAgentHandle): Promise<string | null> {
  type Cursor = NonNullable<Parameters<typeof agent.timeline.refetch>[0]>["cursor"];
  let cursor: Cursor;
  for (let pageIndex = 0; pageIndex < MAX_TIMELINE_PAGES; pageIndex += 1) {
    const page = await agent.timeline.refetch({
      direction: "after",
      projection: "projected",
      limit: 12,
      ...(cursor ? { cursor } : {}),
    });
    if (page.error || (page.reset && cursor)) return null;
    for (const entry of page.entries) {
      if (entry.item.type === "user_message" && typeof entry.item.text === "string" && entry.item.text.trim()) {
        return entry.item.text;
      }
    }
    if (!page.hasNewer || !page.endCursor) return null;
    if (cursor && page.endCursor.epoch === cursor.epoch && page.endCursor.seq <= cursor.seq) return null;
    cursor = page.endCursor;
  }
  return null;
}

export interface TitleSyncDeps {
  readTitle?(sessionId: string): string | null;
  rename?(agentId: string, title: string): Promise<boolean>;
  retryDelaysMs?: readonly number[];
  delay?(ms: number, signal: AbortSignal): Promise<boolean>;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Copies agy's auto-generated conversation title onto the Paseo agent after a turn finishes,
 * as long as the agent still has no title or Paseo's 60-character provisional title.
 */
export function createTitleSyncer(deps: TitleSyncDeps = {}) {
  const readTitle = deps.readTitle ?? readAgyTitle;
  const rename = deps.rename ?? renameHostAgent;
  const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const delay = deps.delay ?? abortableDelay;
  const inFlight = new Set<string>();
  /** Agents already synced or confirmed to carry a user/explicit title. */
  const settled = new Set<string>();
  const controller = new AbortController();

  async function waitForAgyTitle(sessionId: string): Promise<string | null> {
    for (const ms of retryDelaysMs) {
      if (!(await delay(ms, controller.signal))) return null;
      const title = readTitle(sessionId);
      if (title) return title;
    }
    return null;
  }

  async function sync(
    agent: Pick<PluginHookAgent, "id" | "provider" | "background">,
    paseo: PaseoApi,
  ): Promise<boolean> {
    if (controller.signal.aborted) return false;
    if (agent.provider !== PROVIDER_ID || agent.background) return false;
    if (inFlight.has(agent.id) || settled.has(agent.id)) return false;
    inFlight.add(agent.id);
    try {
      const handle = paseo.agents.ref(agent.id);
      const snapshot = await handle.refresh();
      if (!snapshot) return false;
      const currentTitle = (snapshot.agent.title ?? "").trim();
      if (currentTitle) {
        const firstPrompt = await readFirstUserPrompt(handle);
        const provisional = firstPrompt ? provisionalTitle(firstPrompt) : null;
        if (!provisional || currentTitle !== provisional) {
          // Explicit or user-edited title: leave it untouched.
          settled.add(agent.id);
          return false;
        }
      }
      const agySessionId = extractAgySessionId(snapshot.agent.runtimeInfo?.sessionId);
      if (!agySessionId) return false;
      const agyTitle = await waitForAgyTitle(agySessionId);
      if (!agyTitle || controller.signal.aborted) return false;
      if (agyTitle === currentTitle) {
        settled.add(agent.id);
        return false;
      }
      // Re-check right before renaming in case the user or another plugin renamed it while waiting.
      const latest = await handle.refresh();
      if (!latest || (latest.agent.title ?? "").trim() !== currentTitle) {
        settled.add(agent.id);
        return false;
      }
      const ok = await rename(agent.id, agyTitle);
      if (!ok) return false;
      settled.add(agent.id);
      if (currentTitle && latest.agent.workspaceId) {
        try {
          const workspace = paseo.workspaces.ref(latest.agent.workspaceId);
          const wsSnapshot = await workspace.refresh();
          if (wsSnapshot?.name === currentTitle) await workspace.setTitle(agyTitle);
        } catch {
          // Workspace title sync is best-effort.
        }
      }
      return true;
    } finally {
      inFlight.delete(agent.id);
    }
  }

  return {
    sync,
    dispose() {
      controller.abort();
      inFlight.clear();
      settled.clear();
    },
  };
}

export function registerTitleSync(server: PluginServerContext): () => void {
  const syncer = createTitleSyncer();
  const removeHook = server.addHook("agent.turn.after", async (payload, context) => {
    if (!context?.paseo) return;
    // Do not block the host hook lifecycle while waiting for agy's async summary title.
    void syncer.sync(payload.agent, context.paseo).catch((error: unknown) => {
      console.error(
        `[antigravity-plus] title sync failed for ${payload.agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });
  return () => {
    removeHook();
    syncer.dispose();
  };
}
