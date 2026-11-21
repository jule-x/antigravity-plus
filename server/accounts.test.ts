import assert from "node:assert/strict";
import test from "node:test";
import { AccountManager, accountId, type KeychainStore, type AccountOptions, SLOT_ACCOUNT, SLOT_SERVICE, VAULT_SERVICE } from "./accounts.ts";

const a = "a@example.com";
const b = "b@example.com";
const aid = accountId(a);
const bid = accountId(b);
const report = { status: "available" as const, windows: [] };
function credential(email: string, generation = 1) {
  return "go-keyring-base64:" + Buffer.from(JSON.stringify({
    id_token_email: email, token: { access_token: `test-only-${generation}` }, writer_id: generation,
  })).toString("base64");
}

class MemoryKeychain implements KeychainStore {
  entries = new Map<string, string>();
  async read(service: string, account: string) { return this.entries.get(service + "/" + account) ?? null; }
  async write(service: string, account: string, value: string) { this.entries.set(service + "/" + account, value); }
  async remove(service: string, account: string) { this.entries.delete(service + "/" + account); }
  slot() { return this.read(SLOT_SERVICE, SLOT_ACCOUNT); }
  login(email: string, generation = 1) { return this.write(SLOT_SERVICE, SLOT_ACCOUNT, credential(email, generation)); }
}

class Metadata {
  contents = JSON.stringify({ accounts: [], activeAccountId: null });
  failAt?: string;
  read() { return this.contents; }
  write(contents: string) {
    const phase = JSON.parse(contents).journal?.phase;
    if (this.failAt && phase === this.failAt) {
      this.failAt = undefined;
      throw new Error("simulated disk failure");
    }
    this.contents = contents;
  }
}

async function setup() {
  const keychain = new MemoryKeychain();
  await keychain.login(a);
  const file = new Metadata();
  const calls: string[] = [];
  const options: AccountOptions = {
    keychain, file, busyAgents: async () => [],
    login: () => keychain.login(b),
    reset: () => { calls.push("reset"); },
    reload: async () => { calls.push("reload"); },
    verify: async id => { calls.push("verify " + id); return report; },
  };
  const manager = new AccountManager(options);
  await manager.initialize();
  await manager.add();
  calls.length = 0;
  return { options, manager, keychain, file, calls };
}

test("switch preserves refreshed source credentials, previous quota, and shared-slot bytes", async () => {
  const { manager, keychain, calls, file } = await setup();
  assert.equal(manager.recordReport(aid, manager.epoch, report), true);
  await keychain.login(a, 2);
  await manager.switch(bid);
  assert.equal(await keychain.read(VAULT_SERVICE, aid), credential(a, 2));
  assert.equal(await keychain.slot(), credential(b));
  assert.equal(manager.snapshot().activeAccountId, bid);
  assert.deepEqual(calls, ["reset", "reload", "verify " + bid]);
  assert(manager.snapshot().accounts.every(account => !!account.snapshot?.readAt));
  assert(!file.contents.includes(credential(a, 2)));
  assert(!file.contents.includes("test-only"));
  assert.equal(JSON.parse(file.contents).journal, undefined);
});

for (const phase of ["check", "backup", "stop", "replace", "activate", "reset", "reload", "verify"]) {
  for (const point of [phase, phase + ":done"]) {
    test("switch rolls back if journal persistence fails at " + point, async () => {
      const { file, manager, keychain } = await setup();
      await keychain.login(a, 2);
      file.failAt = point;
      await assert.rejects(manager.switch(bid), /disk failure/);
      assert.equal(await keychain.slot(), credential(a, 2));
      assert.equal(manager.snapshot().activeAccountId, aid);
      assert.equal(JSON.parse(file.contents).journal, undefined);
      assert.equal(manager.busy, false);
    });
  }
}

test("startup replays incomplete rollback even when the active slot is empty", async () => {
  const { options, manager, keychain, file, calls } = await setup();
  options.reload = async () => { throw new Error("simulated backend shutdown"); };
  await assert.rejects(manager.switch(bid), /recovery is pending/);
  assert(file.contents.includes('"journal"'));
  await keychain.remove(SLOT_SERVICE, SLOT_ACCOUNT);
  options.reload = async () => { calls.push("recovered"); };
  const recovered = new AccountManager(options);
  assert.equal(recovered.allowTurn, false);
  await recovered.initialize();
  assert.equal(await keychain.slot(), credential(a));
  assert.equal(recovered.snapshot().activeAccountId, aid);
  assert.equal(calls.at(-1), "recovered");
  assert(recovered.allowTurn);
});

test("a running turn prevents both switch and login with agent identifiers", async () => {
  const { options, manager, keychain } = await setup();
  options.busyAgents = async () => ["test-agent"];
  const entries = new Map(keychain.entries);
  await assert.rejects(manager.switch(bid), /test-agent/);
  await assert.rejects(manager.add(), /test-agent/);
  assert.deepEqual(keychain.entries, entries);
});

test("new and duplicate login retain the original account unless activated", async () => {
  const { manager, options, keychain } = await setup();
  assert.equal(manager.snapshot().accounts.length, 2);
  assert.equal(await keychain.slot(), credential(a));
  options.login = () => keychain.login(b, 3);
  await manager.add(true);
  assert.equal(manager.snapshot().accounts.length, 2);
  assert.equal(await keychain.slot(), credential(b, 3));
  assert.equal(await keychain.read(VAULT_SERVICE, bid), credential(b, 3));
  assert.equal(manager.snapshot().activeAccountId, bid);
});

test("cancelled or failed login restores source and unlocks operations", async () => {
  const { manager, options, keychain } = await setup();
  options.login = async () => {};
  await assert.rejects(manager.add(), /cancelled/);
  options.login = async () => { throw new Error("login timed out"); };
  await assert.rejects(manager.add(), /timed out/);
  assert.equal(await keychain.slot(), credential(a));
  assert.equal(manager.snapshot().activeAccountId, aid);
  assert.equal(manager.busy, false);
});

test("reconciliation handles same, known, new and empty slots", async () => {
  const { manager, keychain, calls } = await setup();
  await manager.reconcile();
  assert.deepEqual(calls, []);
  await keychain.login(b, 2);
  await assert.rejects(manager.switch(aid), /outside Paseo/);
  assert.equal(manager.snapshot().activeAccountId, bid);
  assert.equal(await keychain.read(VAULT_SERVICE, bid), credential(b, 2));
  assert.deepEqual(manager.snapshot().notice, { kind: "active", email: b });
  await keychain.login("c@example.com");
  await manager.reconcile();
  assert.equal(manager.snapshot().accounts.length, 3);
  await keychain.remove(SLOT_SERVICE, SLOT_ACCOUNT);
  await manager.reconcile();
  assert.equal(manager.snapshot().activeAccountId, null);
  assert.deepEqual(manager.snapshot().notice, { kind: "signed-out" });
});

test("transactions exclude other mutations and invalidate old quota reads", async () => {
  const { manager, options } = await setup();
  const epoch = manager.epoch;
  let started!: () => void;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  options.login = async () => { started(); await pending; };
  const adding = manager.add();
  await entered;
  assert.equal(manager.allowTurn, false);
  assert.equal(manager.allowOpen, false);
  await assert.rejects(manager.switch(bid), /already running/);
  await manager.reconcile();
  finish();
  await assert.rejects(adding);
  assert.equal(manager.recordReport(aid, epoch, report), false);
});

test("removal only accepts standby accounts and clears vault and metadata", async () => {
  const { manager, keychain } = await setup();
  await assert.rejects(manager.remove(aid), /Switch away/);
  await manager.rename(bid, " Second ");
  assert.equal(manager.snapshot().accounts.find(a => a.id === bid)?.nickname, "Second");
  await manager.remove(bid);
  assert.equal(await keychain.read(VAULT_SERVICE, bid), null);
  assert.equal(manager.snapshot().accounts.length, 1);
});

test("standby enrollment stops idle writers before clearing the slot and reopens on the source", async () => {
  const { options, manager, keychain } = await setup();
  const events: string[] = [];
  options.beforeReplace = async () => {
    assert.equal(await keychain.slot(), credential(a));
    assert.equal(manager.allowTurn, false);
    events.push("stop");
  };
  options.login = async () => {
    assert.equal(await keychain.slot(), null);
    await keychain.login(b);
    events.push("login");
  };
  options.reload = async () => {
    assert.equal(await keychain.slot(), credential(a));
    assert.equal(manager.allowOpen, true);
    assert.equal(manager.allowTurn, false);
    events.push("reload");
  };
  await manager.add();
  assert.deepEqual(events, ["stop", "login", "reload"]);
});

test("a writer finishing during shutdown is backed up before replacing the slot", async () => {
  const { options, manager, keychain } = await setup();
  options.beforeReplace = async () => { await keychain.login(a, 4); };
  await manager.switch(bid);
  assert.equal(await keychain.read(VAULT_SERVICE, aid), credential(a, 4));
});

test("mismatched vault identity is rejected before activating the target", async () => {
  const { manager, keychain } = await setup();
  await keychain.write(VAULT_SERVICE, bid, credential(a));
  await assert.rejects(manager.switch(bid), /mismatched/);
  assert.equal(await keychain.slot(), credential(a));
  assert.equal(manager.snapshot().activeAccountId, aid);
});

test("an eligibility failure is surfaced after restoring and reopening the source", async () => {
  const { options, manager, keychain, calls } = await setup();
  options.verify = async () => { throw new Error("Verify at https://example.com/verify"); };
  await assert.rejects(manager.switch(bid), /https:\/\/example.com\/verify/);
  assert.equal(await keychain.slot(), credential(a));
  assert.equal(manager.snapshot().activeAccountId, aid);
  assert.deepEqual(calls, ["reset", "reload", "reset", "reload"]);
});

test("an external switch during a turn defers reload until agents become idle", async () => {
  const { options, manager, keychain, calls } = await setup();
  options.busyAgents = async () => ["session"];
  await keychain.login(b);
  await manager.reconcile();
  assert.equal(manager.snapshot().activeAccountId, bid);
  assert.equal(manager.allowTurn, false);
  assert(!calls.includes("reload"));
  options.busyAgents = async () => [];
  await manager.reconcile();
  assert.equal(manager.allowTurn, true);
  assert.equal(calls.at(-1), "reload");
});

test("startup reopens the idle agents recorded before a previous process stopped them", async () => {
  const { manager, options, file } = await setup();
  let stopped = false;
  options.beforeReplace = async remember => {
    if (!stopped) {
      remember(["agent-one", "agent-two"]);
      stopped = true;
    } else {
      remember([]);
    }
  };
  options.reload = async () => { throw new Error("host connection lost"); };
  await assert.rejects(manager.switch(bid), /recovery is pending/);
  assert.deepEqual(JSON.parse(file.contents).journal.reopenIds, ["agent-one", "agent-two"]);
  let reopened;
  options.reload = async ids => { reopened = ids; };
  const restarted = new AccountManager(options);
  await restarted.initialize();
  assert.deepEqual(reopened, ["agent-one", "agent-two"]);
  assert.equal(restarted.snapshot().activeAccountId, aid);
  assert.equal(JSON.parse(file.contents).journal, undefined);
});
