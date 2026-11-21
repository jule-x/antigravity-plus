import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { accountId, SLOT_SERVICE, SLOT_ACCOUNT, type AccountManager, type KeychainStore } from "./accounts.ts";
import { execAgy } from "./agy-launch.ts";
import {
  availableModelsSchema,
  googlePoolWindows,
  quotaSummarySchema,
  summaryCoversGoogle,
  summaryWindows,
} from "./quota-windows.ts";

const API_BASE = "https://daily-cloudcode-pa.googleapis.com/v1internal";
/** Fallback CLI version when `agy --version` cannot be read; backend gates Gemini/Argon groups on `antigravity/cli/`. */
const FALLBACK_CLI_VERSION = "1.5.11";
/** Providers whose sessions run on agy's own login. */
const AGY_PROVIDERS = new Set(["antigravity-plus", "antigravity"]);
/** Treat a token this close to expiry as expired; a fetch takes a few seconds. */
const EXPIRY_MARGIN_MS = 60_000;
/** Paseo gives each login fetch 20 seconds, so the agy refresh must finish well inside it. */
const REFRESH_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 6_000;

const input = z.object({ accountId: z.string().min(1) }).strict();

const credentialSchema = z.object({
  token: z.object({ access_token: z.string().min(1), expiry: z.string().optional() }),
  id_token_email: z.string().min(1),
});

type Credential = z.infer<typeof credentialSchema>;

async function readCredential(store: KeychainStore, id: string): Promise<Credential> {
  const raw = await store.read(SLOT_SERVICE, SLOT_ACCOUNT);
  if (!raw) throw new Error("No agy login in the system credential store");
  const prefix = "go-keyring-base64:";
  const json = raw.startsWith(prefix)
    ? Buffer.from(raw.slice(prefix.length), "base64").toString("utf8")
    : raw;
  let credential: Credential;
  try {
    credential = credentialSchema.parse(JSON.parse(json));
  } catch {
    throw new Error("Could not decode the agy login");
  }
  if (accountId(credential.id_token_email) !== id) throw new Error("The active Antigravity account changed");
  return credential;
}

function expiresAt(credential: Credential): number | null {
  const parsed = credential.token.expiry ? Date.parse(credential.token.expiry) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isExpired(credential: Credential): boolean {
  const expiry = expiresAt(credential);
  return expiry !== null && expiry - EXPIRY_MARGIN_MS <= Date.now();
}

async function readAgyVersion(launch: ProviderLaunch | undefined): Promise<string> {
  try {
    const { stdout } = await execAgy(["--version"], 5_000, launch);
    return /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? FALLBACK_CLI_VERSION;
  } catch {
    return FALLBACK_CLI_VERSION;
  }
}

export function createAccountQuota(store: KeychainStore, getLaunch: () => ProviderLaunch | undefined): AccountQuota {
  let lastLaunch: ProviderLaunch | undefined;
  let version: Promise<string> | undefined;
  return new AccountQuota(store, async token => {
    const launch = getLaunch();
    if (!version || lastLaunch !== launch) {
      lastLaunch = launch;
      version = readAgyVersion(launch);
    }
    return requestReport(token, `antigravity/cli/${await version}`);
  }, async () => {
    await execAgy(["models"], REFRESH_TIMEOUT_MS, getLaunch()).catch(() => undefined);
  });
}

class EligibilityError extends Error {}

function optionalQuotaData(error: unknown): null {
  if (error instanceof EligibilityError) throw error;
  return null;
}

class HttpRejected extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Antigravity quota request was rejected (${status})`);
    this.status = status;
  }
}

async function post(method: string, token: string, body: unknown, userAgent: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}:${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": userAgent,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    if (/eligibility check failed|not eligible|verify your account/i.test(body)) {
      // Only expose the verification URL, never the full API response.
      const verification = /https:\/\/(?:[a-z0-9-]+\.)*google\.com\/[^\s"<>\\]*/i.exec(body)?.[0];
      throw new EligibilityError(`Antigravity account verification required${verification ? " · " + verification : ""}`);
    }
    if (response.status === 401 || response.status === 403) throw new HttpRejected(response.status);
  }
  if (!response.ok) throw new Error(`Antigravity quota request ${method} failed (${response.status})`);
  return response.json();
}

export class AccountQuota {
  private refreshing = new Map<string, Promise<void>>();
  private writers = new Set<Promise<void>>();
  private store: KeychainStore;
  private request: (token: string) => Promise<UsageReport>;
  private runRefresh: () => Promise<void>;

  constructor(store: KeychainStore, request: (token: string) => Promise<UsageReport>, runRefresh: () => Promise<void>) {
    this.store = store;
    this.request = request;
    this.runRefresh = runRefresh;
  }

  async drainRefreshes(): Promise<void> {
    await Promise.allSettled(this.writers);
  }

  reset(): void {
    this.refreshing.clear();
  }

  async fetch(id: string, current = () => true): Promise<UsageReport> {
    const check = () => {
      if (!current()) throw new Error("The active Antigravity account changed");
    };
    const read = async () => {
      check();
      const credential = await readCredential(this.store, id);
      check();
      return credential;
    };
    const refresh = async () => {
      await read();
      check(); // Start the writer synchronously after checking the transaction guard.
      let pending = this.refreshing.get(id);
      if (!pending) {
        const writer = this.runRefresh().finally(() => {
          this.writers.delete(writer);
          if (this.refreshing.get(id) === writer) this.refreshing.delete(id);
        });
        pending = writer;
        this.writers.add(writer);
        this.refreshing.set(id, writer);
      }
      await pending;
    };
    try {
      return await this.measure(read, refresh);
    } finally {
      // Errors can contain an account-specific verification URL, so verify
      // ownership of error responses as well as successful measurements.
      await read();
    }
  }

  private async measure(read: () => Promise<Credential>, refresh: () => Promise<void>): Promise<UsageReport> {
    let credential = await read();
    if (isExpired(credential)) {
      await refresh();
      credential = await read();
    }
    if (isExpired(credential)) {
      return unavailable({
        kind: "expired",
        expiresAt: new Date(expiresAt(credential) ?? Date.now()).toISOString(),
        refreshedBy: "agy",
      });
    }
    let rejectedStatus: number;
    try {
      return await this.request(credential.token.access_token);
    } catch (error) {
      if (!(error instanceof HttpRejected)) throw error;
      rejectedStatus = error.status;
    }
    // Rejected before the stored expiry (revoked token, clock skew): let agy refresh once.
    await refresh();
    const refreshed = await read();
    if (refreshed.token.access_token === credential.token.access_token) {
      return unavailable({ kind: "rejected", status: rejectedStatus, refreshedBy: "agy" });
    }
    try {
      return await this.request(refreshed.token.access_token);
    } catch (error) {
      if (error instanceof HttpRejected) {
        return unavailable({ kind: "rejected", status: error.status, refreshedBy: "agy" });
      }
      throw error;
    }
  }

  async verify(id: string): Promise<UsageReport> {
    const report = await this.fetch(id);
    if (report.status === "available") return report;
    throw new Error(report.status === "error" ? report.error : `Antigravity quota unavailable (${report.problem.kind})`);
  }
}

async function requestReport(token: string, userAgent: string): Promise<UsageReport> {
  const [summaryRaw, tierRaw] = await Promise.all([
    post("retrieveUserQuotaSummary", token, {}, userAgent),
    post(
      "loadCodeAssist",
      token,
      { metadata: { ideType: "ANTIGRAVITY", pluginType: "GEMINI" } },
      userAgent,
    ).catch(optionalQuotaData),
  ]);
  const summary = quotaSummarySchema.parse(summaryRaw);
  const tier = z
    .object({
      paidTier: z.object({ name: z.string() }).optional(),
      currentTier: z.object({ name: z.string() }).optional(),
    })
    .safeParse(tierRaw);
  const windows = [...summaryWindows(summary)];
  if (!summaryCoversGoogle(summary)) {
    const modelsRaw = await post("fetchAvailableModels", token, {}, userAgent).catch(optionalQuotaData);
    if (modelsRaw !== null) {
      windows.push(...googlePoolWindows(availableModelsSchema.parse(modelsRaw), summary));
    }
  }
  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "Antigravity reported no quota windows" });
  }
  return {
    status: "available",
    planLabel: tier.success ? (tier.data.paidTier?.name ?? tier.data.currentTier?.name) : undefined,
    windows,
  };
}

type QuotaAccounts = Pick<AccountManager, "reconcile" | "snapshot" | "isCurrent" | "recordReport" | "epoch">;

function cachedReport(snapshot?: { report: UsageReport; readAt: string }): UsageReport {
  if (!snapshot) return unavailable({ kind: "no_quota", detail: "No quota snapshot for this account yet" });
  if (snapshot.report.status !== "available") return snapshot.report;
  return {
    ...snapshot.report,
    windows: snapshot.report.windows.map(window => {
      const resetPassed = window.resetsAt && Date.parse(window.resetsAt) <= Date.now();
      const suffix = resetPassed ? "cached · reset passed, recovery expected" : "cached";
      return {
        ...window,
        label: `${window.label} (${suffix})`,
        shortLabel: `${window.shortLabel || window.label} (${suffix})`,
      };
    }),
    details: [...(snapshot.report.details ?? []), { id: "snapshot", label: "Last measured", value: snapshot.readAt }],
  };
}

export function createAntigravityUsageSource(manager: QuotaAccounts, quota: AccountQuota): UsageSourceRegistration {
  return {
    id: "antigravity-quota",
    label: "Antigravity",
    icon: "icon.svg",
    input,
    async discover(scope: UsageScope): Promise<UsageAccount[]> {
      if (scope.kind === "session" && (!AGY_PROVIDERS.has(scope.provider) || scope.env.GEMINI_API_KEY)) return [];
      await manager.reconcile();
      const { accounts } = manager.snapshot();
      return accounts.map(account => ({
        key: account.id,
        label: account.nickname || account.email,
        harness: "Antigravity",
        input: { accountId: account.id },
      }));
    },
    async fetch(value) {
      const { accountId: id } = input.parse(value);
      const cached = () => cachedReport(manager.snapshot().accounts.find(a => a.id === id)?.snapshot);
      const initial = manager.snapshot();
      if (initial.activeAccountId !== id) return cached();
      await manager.reconcile();
      const epoch = manager.epoch;
      const current = () => manager.isCurrent(id, epoch);
      if (!current()) return cached();
      try {
        const report = await quota.fetch(id, current);
        return manager.recordReport(id, epoch, report) ? report : cached();
      } catch (error) {
        if (!current()) return cached();
        throw error;
      }
    },
  };
}
