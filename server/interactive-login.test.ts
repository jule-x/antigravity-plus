import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { AccountManager, SLOT_ACCOUNT, SLOT_SERVICE } from "./accounts.ts";
import { AccountLogins } from "./interactive-login.ts";

const url = "https://accounts.google.com/o/oauth2/auth?state=fixture-state&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback";
const code = "fixture-input";
const callback = "https://antigravity.google/oauth-callback?code=" + code;
const slot = SLOT_SERVICE + "/" + SLOT_ACCOUNT;

function credential(email: string) {
  return JSON.stringify({ id_token_email: email, token: { access_token: "fixture" } });
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killSignal?: string;
  kill(signal: string) { this.killSignal = signal; return true; }
  close(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
  prompt() {
    this.stderr.write("Open this link in a browser to log in with Google:\r\n\r\n  ");
    this.stderr.write(url.slice(0, 40));
    this.stderr.write(url.slice(40) + "\r\n");
    this.stdout.write("Then paste the authorization code, or the full URL of the page you land on, and press Enter:");
  }
}

async function fixture(promptTimeout = 2000, loginTimeout = 3000) {
  const child = new FakeChild();
  const events = new EventEmitter();
  const spawned = new Promise<void>(resolve => events.once("spawn", resolve));
  const logins = new AccountLogins(() => {
    events.emit("spawn");
    return child as unknown as ChildProcessWithoutNullStreams;
  }, promptTimeout, loginTimeout, async childProcess => { childProcess.kill("SIGKILL"); });
  const entries = new Map([[slot, credential("a@example.com")]]);
  let metadata = '{"accounts":[],"activeAccountId":null}';
  const manager = new AccountManager({
    keychain: {
      read: async (service, account) => entries.get(service + "/" + account) ?? null,
      write: async (service, account, value) => { entries.set(service + "/" + account, value); },
      remove: async (service, account) => { entries.delete(service + "/" + account); },
    },
    file: {
      read: () => metadata,
      write: next => {
        for (const secret of [code, "fixture-state", url]) assert(!next.includes(secret));
        metadata = next;
      },
    },
    busyAgents: async () => [], login: () => logins.run(),
    reset() {}, reload: async () => {}, verify: async () => ({status: "available", windows: []}),
  });
  await manager.initialize();
  const {id} = logins.begin(() => manager.add());
  await spawned;
  assert.equal(entries.get(slot), undefined);
  return { child, attempt: logins.attempt(id), entries, manager };
}

for (const input of [code, callback]) {
  test("interactive add forwards one line and restores the previous account after " +
    (input === code ? "a code" : "a full callback URL"), async () => {
    const {child, attempt, entries, manager} = await fixture();
    child.prompt();
    assert.deepEqual(attempt.status, {phase: "input", url});
    attempt.submit(input);
    assert.deepEqual(attempt.status, {phase: "submitted"});
    assert.equal(child.stdin.read()?.toString(), input + "\n");
    assert.throws(() => attempt.submit(input), /not waiting/);
    // Piped stdin does not echo a newline after the prompt.
    child.stdout.write("Logged in as b@example.com.\r\n");
    entries.set(slot, credential("b@example.com"));
    child.close(0);
    await setImmediate();
    assert.deepEqual(attempt.status, {phase: "done"});
    assert.equal(entries.get(slot), credential("a@example.com"));
    assert.equal(manager.snapshot().accounts.length, 2);
  });
}

for (const mode of ["invalid code", "early exit", "cancel", "timeout", "unknown output"] as const) {
  test("interactive add rolls back after " + mode, async () => {
    const {child, attempt, entries, manager} = await fixture(mode === "unknown output" ? 10 : 2000, mode === "timeout" ? 15 : 3000);
    if (mode === "unknown output") child.stdout.write("New prompt format\nhttps://example.com/other\n");
    else child.prompt();
    if (mode === "invalid code") {
      attempt.submit(code);
      child.stderr.write("Rejected: " + code + " " + url + "\n");
      child.close(1);
    } else if (mode === "early exit") {
      child.close(0);
    } else {
      if (mode === "cancel") attempt.cancel();
      else await new Promise(resolve => setTimeout(resolve, 35));
      assert.equal(child.killSignal, "SIGKILL");
      assert.equal(manager.busy, true);
      assert.equal(entries.get(slot), undefined);
      child.close(null);
    }
    await setImmediate();
    assert.equal(attempt.status.phase, "failed");
    assert.doesNotMatch(attempt.status.message, /fixture-input|fixture-state|accounts\.google/);
    assert.equal(manager.snapshot().accounts.length, 1);
    assert.equal(manager.busy, false);
    assert.equal(entries.get(slot), credential("a@example.com"));
  });
}
