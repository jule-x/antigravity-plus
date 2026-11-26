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
import { parseAgyUsage, summaryWindows, type QuotaSummary } from "./quota-windows.ts";

/** Providers whose sessions run on agy's own login. */
const AGY_PROVIDERS = new Set(["antigravity-plus", "antigravity"]);
/** Treat a token this close to expiry as expired; a fetch takes a few seconds. */
const EXPIRY_MARGIN_MS = 60_000;
/** Paseo gives each login fetch 20 seconds, so the agy refresh must finish well inside it. */
const REFRESH_TIMEOUT_MS = 12_000;
/** `agy -p /usage` takes about 6 to 8 seconds. */
const USAGE_TIMEOUT_MS = 15_000;

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

/**
 * Quota comes only from the official CLI (`agy -p /usage`). Google told third-party clients that
 * calling its internal `cloudcode-pa` quota APIs can get an account flagged, so nothing here
 * sends agy's token anywhere.
 */
export function createAccountQuota(store: KeychainStore, getLaunch: () => ProviderLaunch | undefined): AccountQuota {
  return new AccountQuota(store, async () => {
    const { stdout } = await execAgy(["-p", "/usage", "--output-format", "json"], USAGE_TIMEOUT_MS, getLaunch());
    return usageReport(parseAgyUsage(stdout));
  }, async () => {
    await execAgy(["models"], REFRESH_TIMEOUT_MS, getLaunch()).catch(() => undefined);
  });
}

export class AccountQuota {
  private refreshing = new Map<string, Promise<void>>();
  private writers = new Set<Promise<void>>();
  private store: KeychainStore;
  private request: () => Promise<UsageReport>;
  private runRefresh: () => Promise<void>;

  constructor(store: KeychainStore, request: () => Promise<UsageReport>, runRefresh: () => Promise<void>) {
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
    return this.request();
  }

  async verify(id: string): Promise<UsageReport> {
    const report = await this.fetch(id);
    if (report.status === "available") return report;
    throw new Error(report.status === "error" ? report.error : `Antigravity quota unavailable (${report.problem.kind})`);
  }
}

function usageReport(summary: QuotaSummary): UsageReport {
  const windows = summaryWindows(summary);
  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "Antigravity reported no quota windows" });
  }
  return { status: "available", windows };
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
