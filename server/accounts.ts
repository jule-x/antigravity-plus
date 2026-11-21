import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashAccountKey, type UsageReport } from "@getpaseo/plugin/server/usage";
import type { AccountNotice } from "../shared/accounts-rpc.ts";

export interface KeychainStore {
  read(service: string, account: string): Promise<string | null>;
  write(service: string, account: string, value: string): Promise<void>;
  remove(service: string, account: string): Promise<void>;
}

export const SLOT_SERVICE = "gemini";
export const SLOT_ACCOUNT = "antigravity";
export const VAULT_SERVICE = "antigravity-plus.account";

export function slotEmail(raw: string): string {
  try {
    const prefix = "go-keyring-base64:";
    const json = raw.startsWith(prefix) ? Buffer.from(raw.slice(prefix.length), "base64").toString() : raw;
    const { id_token_email: email, auth_method: method, token } = JSON.parse(json);
    if ((method === undefined || method === "consumer") && typeof email === "string" &&
        email.trim() && typeof token?.access_token === "string" && token.access_token) return email.trim().toLowerCase();
  } catch { /* Never include credential bytes in errors. */ }
  throw new Error("The credential entry does not contain a supported Antigravity consumer login");
}

export function accountId(email: string): string {
  return hashAccountKey(`antigravity:${email.trim().toLowerCase()}`);
}

export interface Account {
  id: string;
  email: string;
  nickname?: string;
  addedAt: string;
  snapshot?: { report: UsageReport; readAt: string };
}

interface Registry {
  accounts: Account[];
  activeAccountId: string | null;
}

interface Journal {
  operation: "switch" | "add";
  previous: Registry;
  phase: string;
  // Set durably before the first operation that can change the shared slot.
  restoreSlot: boolean;
  newAccountId?: string;
  reopenIds?: string[];
}

interface State extends Registry {
  journal?: Journal;
  removing?: string;
  reloadPending?: boolean;
  pendingReopen?: string[];
}

interface MetadataFile {
  read(): string;
  write(contents: string): void;
}

function metadataFile(file: string): MetadataFile {
  return {
    read: () => readFileSync(file, "utf8"),
    write(contents) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + "." + randomUUID() + ".tmp";
      writeFileSync(tmp, contents, { mode: 0o600, flush: true });
      renameSync(tmp, file);
    },
  };
}

export interface AccountOptions {
  keychain: KeychainStore;
  file: string | MetadataFile;
  busyAgents(): Promise<string[]>;
  login(): Promise<void>;
  reset(): void;
  reload(ids?: readonly string[]): Promise<void>;
  verify(id: string): Promise<UsageReport>;
  beforeSlotChange?(): Promise<void>;
  beforeReplace?(remember: (ids: readonly string[]) => void): Promise<void>;
}

export class AccountManager {
  private state: State;
  private options: AccountOptions;
  private metadata: MetadataFile;
  private locked = false;
  private opening = false;
  private polling?: Promise<void>;
  private notice: AccountNotice | null = null;
  epoch = 0;

  constructor(options: AccountOptions) {
    this.options = options;
    this.metadata = typeof options.file === "string" ? metadataFile(options.file) : options.file;
    try {
      this.state = JSON.parse(this.metadata.read());
      if (!Array.isArray(this.state.accounts) || !("activeAccountId" in this.state)) throw new Error("Invalid account registry");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { accounts: [], activeAccountId: null };
    }
  }

  get busy() { return this.locked || !!this.state.journal || !!this.state.reloadPending; }
  get allowOpen() { return !this.busy || this.opening; }
  get allowTurn() { return !this.busy; }

  snapshot() {
    return {
      accounts: structuredClone(this.state.accounts), activeAccountId: this.state.activeAccountId,
      notice: this.notice, busy: this.busy,
    };
  }

  private save(next: State) {
    this.metadata.write(JSON.stringify(next));
    this.state = next;
  }

  private slot() { return this.options.keychain.read(SLOT_SERVICE, SLOT_ACCOUNT); }

  private async restore(id: string | null) {
    if (!id) {
      await this.options.keychain.remove(SLOT_SERVICE, SLOT_ACCOUNT);
      if (await this.slot() !== null) throw new Error("Could not clear the active login");
      return;
    }
    const raw = await this.options.keychain.read(VAULT_SERVICE, id);
    if (!raw || accountId(slotEmail(raw)) !== id) throw new Error("Vault entry missing or mismatched");
    await this.options.keychain.write(SLOT_SERVICE, SLOT_ACCOUNT, raw);
    if (await this.slot() !== raw) throw new Error("Credential readback did not match the selected account");
  }

  private async reload() {
    this.opening = true;
    try { await this.options.reload(this.state.journal?.reopenIds ?? this.state.pendingReopen); } finally { this.opening = false; }
  }

  private async idle() {
    const labels = await this.options.busyAgents();
    if (labels.length) throw new Error("Wait for active turns: " + labels.join(", "));
  }

  private async beforeReplace() {
    await this.options.beforeReplace?.(ids => {
      const journal = this.state.journal;
      if (!journal) throw new Error("Missing account journal before stopping agents");
      const reopenIds = [...new Set([...(journal.reopenIds ?? []), ...ids])];
      this.save({ ...this.state, journal: { ...journal, reopenIds } });
    });
  }

  private async recover() {
    const { journal, removing } = this.state;
    if (removing) {
      await this.options.keychain.remove(VAULT_SERVICE, removing);
      this.save({ ...this.state, accounts: this.state.accounts.filter(a => a.id !== removing), removing: undefined });
    }
    if (!journal) return;
    if (journal.restoreSlot) {
      await this.idle();
      await this.options.beforeSlotChange?.();
      await this.beforeReplace();
      await this.restore(journal.previous.activeAccountId);
      this.save({ ...this.state, ...journal.previous });
      this.options.reset();
      await this.reload();
    }
    if (journal.newAccountId) await this.options.keychain.remove(VAULT_SERVICE, journal.newAccountId);
    this.save(journal.previous);
  }

  private async observe() {
    const raw = await this.slot();
    const email = raw && slotEmail(raw);
    const id = email ? accountId(email) : null;
    const previous = this.state.activeAccountId;
    if (id !== previous) {
      let accounts = this.state.accounts;
      if (id && email && raw) {
        await this.options.keychain.write(VAULT_SERVICE, id, raw);
        if (!accounts.some(a => a.id === id)) accounts = [...accounts, { id, email, addedAt: new Date().toISOString() }];
      }
      // A signed-out slot has no login with which to reopen a session. The next
      // successful sign-in or explicit switch will reopen the idle agents.
      const reloadPending = id !== null && (this.state.accounts.length > 0 || !!this.state.reloadPending);
      this.save({ ...this.state, accounts, activeAccountId: id, reloadPending });
      this.epoch++;
      this.options.reset();
      this.notice = email ? { kind: "active", email } : { kind: "signed-out" };
    }
    if (!id) this.notice = { kind: "signed-out" };
    if (this.state.reloadPending && !(await this.options.busyAgents()).length) {
      await this.options.beforeSlotChange?.();
      await this.reload();
      this.save({ ...this.state, reloadPending: false, pendingReopen: undefined });
    }
    return id !== previous;
  }

  initialize() { return this.reconcile(); }

  reconcile(): Promise<void> {
    if (this.locked) return Promise.resolve();
    if (!this.polling) {
      this.polling = (async () => {
        await this.recover();
        await this.observe();
      })().finally(() => { this.polling = undefined; });
    }
    return this.polling;
  }

  isCurrent(id: string, epoch: number) {
    return !this.busy && this.epoch === epoch && this.state.activeAccountId === id;
  }

  recordReport(id: string, epoch: number, report: UsageReport) {
    if (!this.isCurrent(id, epoch)) return false;
    if (report.status === "available") this.storeReport(id, report);
    return true;
  }

  private storeReport(id: string, report: UsageReport) {
    const snapshot = { report, readAt: new Date().toISOString() };
    this.save({ ...this.state, accounts: this.state.accounts.map(a => a.id === id ? { ...a, snapshot } : a) });
  }

  private async exclusive(work: () => Promise<void>) {
    if (this.locked) throw new Error("An account operation is already running");
    this.locked = true;
    try {
      await this.polling;
      await this.recover();
      await work();
    } finally { this.locked = false; }
  }

  private mark(phase: string, fields: Partial<Journal> = {}) {
    const journal = this.state.journal;
    if (!journal) throw new Error("Missing account journal");
    this.save({ ...this.state, journal: { ...journal, phase, ...fields } });
  }

  private async step<T>(phase: string, action: () => Promise<T>): Promise<T> {
    this.mark(phase);
    const result = await action();
    this.mark(phase + ":done");
    return result;
  }

  private transaction(operation: Journal["operation"], action: () => Promise<void>) {
    return this.exclusive(async () => {
      this.epoch++;
      await this.idle();
      await this.options.beforeSlotChange?.();
      if (await this.observe()) throw new Error("Active login changed outside Paseo. Review accounts and try again.");
      if (this.state.reloadPending) throw new Error("Waiting for active turns to finish");
      const previous = { accounts: this.state.accounts, activeAccountId: this.state.activeAccountId };
      this.save({ ...this.state, journal: { operation, previous, phase: "start", restoreSlot: false } });
      try {
        const id = previous.activeAccountId;
        const raw = await this.step("check", async () => {
          const value = await this.slot();
          if ((value ? accountId(slotEmail(value)) : null) !== id) {
            throw new Error("The active login changed during preparation");
          }
          return value;
        });
        await this.step("backup", async () => {
          if (id && raw) await this.options.keychain.write(VAULT_SERVICE, id, raw);
        });
        await action();
        this.save({ ...this.state, journal: undefined });
        this.notice = null;
      } catch (error) {
        try { await this.recover(); } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Account operation failed and recovery is pending: " + String(recoveryError));
        }
        throw error;
      }
    });
  }

  private async stopWriters() {
    await this.step("stop", async () => {
      await this.beforeReplace();
      // A final refresh can land while the idle transports are shutting down.
      const raw = await this.slot();
      const previous = this.state.activeAccountId;
      if ((raw ? accountId(slotEmail(raw)) : null) !== previous) {
        // The external login already owns the slot. Reopen against it and
        // let reconciliation adopt it instead of overwriting its credential.
        this.save({ ...this.state, pendingReopen: this.state.journal?.reopenIds, journal: undefined, reloadPending: true });
        await this.observe();
        throw new Error("Active login changed while stopping idle agents");
      }
      if (raw && previous) await this.options.keychain.write(VAULT_SERVICE, previous, raw);
    });
  }

  private async activate(id: string) {
    await this.step("activate", async () => this.save({ ...this.state, activeAccountId: id }));
    await this.step("reset", async () => this.options.reset());
    await this.step("reload", () => this.reload());
    await this.step("verify", async () => {
      const report = await this.options.verify(id);
      if (report.status !== "available") throw new Error("Quota unavailable for selected account");
      const raw = await this.slot();
      if (!raw || accountId(slotEmail(raw)) !== id) throw new Error("Active login changed during verification");
      this.storeReport(id, report);
    });
  }

  switch(id: string) {
    return this.transaction("switch", async () => {
      if (!this.state.accounts.some(a => a.id === id)) throw new Error("Unknown account");
      if (id === this.state.activeAccountId) return;
      this.mark("replace", { restoreSlot: true });
      await this.stopWriters();
      await this.step("replace", () => this.restore(id));
      await this.activate(id);
    });
  }

  add(makeActive = false) {
    return this.transaction("add", async () => {
      const previous = this.state.activeAccountId;
      this.mark("clear", { restoreSlot: true });
      await this.stopWriters();
      await this.step("clear", () => this.restore(null));
      await this.step("login", () => this.options.login());
      const raw = await this.slot();
      if (!raw) throw new Error("Login cancelled or incomplete");
      const email = slotEmail(raw);
      const id = accountId(email);
      const known = this.state.accounts.some(a => a.id === id);
      this.mark("enroll", known ? {} : { newAccountId: id });
      await this.step("enroll", async () => {
        await this.options.keychain.write(VAULT_SERVICE, id, raw);
        if (!known) this.save({ ...this.state, accounts: [...this.state.accounts, { id, email, addedAt: new Date().toISOString() }] });
      });
      if (makeActive || !previous) await this.activate(id);
      else {
        await this.step("restore", () => this.restore(previous));
        await this.step("reload", () => this.reload());
      }
    });
  }

  remove(id: string) {
    return this.exclusive(async () => {
      await this.observe();
      if (id === this.state.activeAccountId) throw new Error("Switch away before removing the active account");
      if (!this.state.accounts.some(a => a.id === id)) throw new Error("Unknown account");
      this.save({ ...this.state, removing: id });
      await this.recover();
    });
  }

  rename(id: string, nickname: string) {
    return this.exclusive(async () => {
      if (!this.state.accounts.some(a => a.id === id)) throw new Error("Unknown account");
      this.save({ ...this.state, accounts: this.state.accounts.map(a => a.id === id ? { ...a, nickname: nickname.trim() || undefined } : a) });
    });
  }
}
