import { homedir } from "node:os";
import { join } from "node:path";
import { spawnProcess, type PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { accountsRpc } from "./shared/accounts-rpc.ts";
import { DEFAULT_PERMISSION_MODE, PREFERENCES_SETTINGS, type PermissionModeId } from "./shared/settings.ts";
import { AccountManager } from "./server/accounts.ts";
import { AccountLogins } from "./server/interactive-login.ts";
import { AccountRuntime } from "./server/account-runtime.ts";
import { resolveAgyLaunch } from "./server/agy-launch.ts";
import { captureAgyProcesses, resetObservedModels } from "./server/agy-stream.ts";
import { MacKeychainStore } from "./server/keychain.ts";
import { createAntigravityPlusProvider } from "./server/provider.ts";
import { createAccountQuota, createAntigravityUsageSource } from "./server/quota.ts";
import { drainSessionListProbe, refreshSessionList } from "./server/session-list.ts";
import { AGY_ENV } from "./server/subagents.ts";
import { registerTitleSync } from "./server/title-sync.ts";
import { WindowsKeychainStore } from "./server/windows-keychain.ts";

export default function contribute(server: PluginServerContext) {
  const runtime = new AccountRuntime();
  const windows = process.platform === "win32";
  const supported = windows || process.platform === "darwin";
  const keychain = windows ? new WindowsKeychainStore() : new MacKeychainStore();
  let launch: ProviderLaunch | undefined;
  const quota = createAccountQuota(keychain, () => launch);
  const logins = new AccountLogins(() => {
    const resolved = resolveAgyLaunch(launch);
    return spawnProcess(resolved?.command ?? (windows ? "agy.exe" : "agy"), [...(resolved?.args ?? ["acp"]), "--login"], {
      env: resolved?.env ?? process.env, stdio: "pipe",
    });
  });
  let quotaError = false;
  const accounts = new AccountManager({
    keychain,
    file: join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "antigravity-plus", "accounts.json"),
    busyAgents: () => runtime.busyAgents(),
    beforeSlotChange: async () => {
      await Promise.all([quota.drainRefreshes(), drainSessionListProbe(), captureAgyProcesses(true).wait()]);
    },
    beforeReplace: async remember => {
      remember(await runtime.rememberOpenAgents());
      const old = captureAgyProcesses();
      old.stop();
      await old.wait();
    },
    login: () => logins.run(),
    reset: () => {
      quotaError = false;
      quota.reset();
      resetObservedModels();
    },
    reload: async ids => {
      const oldProcesses = captureAgyProcesses();
      await runtime.reload(ids);
      await oldProcesses.wait();
      if (launch) await refreshSessionList(launch, AGY_ENV);
    },
    verify: id => quota.verify(id),
  });
  let initialized = false;
  let starting: Promise<void> | undefined;
  function ready() {
    if (!supported || initialized) return Promise.resolve();
    starting ??= accounts.initialize().then(() => { initialized = true; }).finally(() => { starting = undefined; });
    return starting;
  }
  void ready().catch(() => { /* Retry on the next request, where Paseo can display the error. */ });

  const preferences = server.registerSettings(PREFERENCES_SETTINGS);
  let defaultMode: PermissionModeId = DEFAULT_PERMISSION_MODE;
  const preferencesReady = preferences
    .read()
    .then((state) => {
      if (state.status === "ready") defaultMode = state.values.defaultMode;
    })
    .catch(() => {
      // Keep the safe default ("default") if host settings cannot be read yet.
    });
  const stopPreferences = preferences.subscribe((state) => {
    defaultMode = state.status === "ready" ? state.values.defaultMode : DEFAULT_PERMISSION_MODE;
  });

  server.registerProvider(createAntigravityPlusProvider(supported ? {
    async ready() {
      if (accounts.busy && accounts.allowOpen) return; // The recovery itself is reopening an agent.
      try {
        await ready();
      } catch (error) {
        // Standalone provider use (including API-key sessions) does not require the vault.
        // An outstanding account transition must finish before any provider process starts.
        if (accounts.busy) throw error;
      }
    },
    activeId: () => accounts.snapshot().activeAccountId,
    canOpen: () => accounts.allowOpen,
    rememberLaunch: value => { launch = value; },
    guard: connection => {
      connection.onEvent(event => {
        if (event.type === "session.turn" && event.state === "failed" &&
          /quota|resource[_ ]exhausted|rate limit|\b429\b/i.test(event.error?.message ?? "")) quotaError = true;
        if (event.type === "session.turn" && event.state === "completed") quotaError = false;
      });
      return runtime.guard(connection, accounts);
    },
  } : undefined, {
    ready: () => preferencesReady,
    defaultMode: () => defaultMode,
  }));
  const source = createAntigravityUsageSource(accounts, quota);
  server.registerUsageSource({
    ...source,
    async discover(scope) { if (!supported) return []; await ready(); return source.discover(scope); },
  });
  let lastPoll = 0;
  let lastAccount: string | null = null;
  let reading: Promise<void> | undefined;
  const view = async () => {
    await ready();
    if (supported) await accounts.reconcile();
    const state = accounts.snapshot();
    const id = state.activeAccountId;
    if (id && !state.busy && !reading && (id !== lastAccount || Date.now() - lastPoll >= 60_000)) {
      lastAccount = id;
      lastPoll = Date.now();
      reading = source.fetch({ accountId: id }).then(() => {}, () => {}).finally(() => { reading = undefined; });
    }
    return { ...state, quotaError };
  };
  server.handle(accountsRpc.list, (_, ctx) => { runtime.attach(ctx.paseo); return view(); });
  server.handle(accountsRpc.status, (_, ctx) => { runtime.attach(ctx.paseo); return view(); });
  const mutate = async (work: () => Promise<void>) => {
    if (!supported) throw new Error("Antigravity+ account management requires macOS or Windows");
    await ready();
    await work();
    return {ok: true as const};
  };
  server.handle(accountsRpc.switch, ({id}, ctx) => { runtime.attach(ctx.paseo); return mutate(() => accounts.switch(id)); });
  server.handle(accountsRpc.add, ({makeActive}, ctx) => {
    runtime.attach(ctx.paseo);
    return logins.begin(async () => { await mutate(() => accounts.add(makeActive)); });
  });
  server.handle(accountsRpc.loginStatus, ({id}) => logins.status(id));
  server.handle(accountsRpc.loginSubmit, ({id, value}) => {
    logins.attempt(id).submit(value);
    return { ok: true as const };
  });
  server.handle(accountsRpc.loginCancel, ({id}) => {
    logins.attempt(id).cancel();
    return { ok: true as const };
  });
  server.handle(accountsRpc.remove, ({id}, ctx) => { runtime.attach(ctx.paseo); return mutate(() => accounts.remove(id)); });
  server.handle(accountsRpc.rename, ({id, nickname}, ctx) => {
    runtime.attach(ctx.paseo);
    return mutate(() => accounts.rename(id, nickname));
  });
  const detachOpen = server.addHook("agent.open.before", async (_, ctx) => { runtime.attach(ctx.paseo); });
  const stopTitleSync = registerTitleSync(server);
  return async () => { await logins.dispose(); detachOpen(); stopTitleSync(); stopPreferences(); };
}
