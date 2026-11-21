import { useEffect, useSyncExternalStore } from "react";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useTranslation, type PluginClientContext } from "@getpaseo/plugin/client";
import { accountsRpc, type AccountsView } from "../shared/accounts-rpc.ts";
import { messages } from "./messages.ts";

/** One poll per installation while the screen or a matching composer is visible. */
export function createAccountStore(client: PluginClientContext) {
  let current: { view: AccountsView | null; error: string | null } = { view: null, error: null };
  let revision = 0;
  let reading = false;
  let announced: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();

  async function refresh(initial = false) {
    const requested = ++revision;
    reading = true;
    try {
      const view = await client.rpc(initial ? accountsRpc.list : accountsRpc.status, {});
      if (revision !== requested) return;
      current = { view, error: null };
    } catch (error) {
      if (revision !== requested) return;
      current = { view: current.view, error: error instanceof Error ? error.message : String(error) };
    }
    reading = false;
    for (const listener of listeners) listener();
  }

  const dispose = () => {
    clearInterval(timer);
    timer = undefined;
    reading = false;
    revision++;
  };
  return {
    read: () => current,
    takeNotice() {
      const notice = current.view?.notice ?? null;
      const key = notice?.kind === "active" ? `active:${notice.email}` : notice?.kind ?? null;
      if (key === announced) return null;
      announced = key;
      return notice;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!timer) {
        void refresh(true);
        timer = setInterval(() => { if (!reading) void refresh(); }, 10_000);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) dispose();
      };
    },
    refresh, dispose,
  };
}
export type AccountStore = ReturnType<typeof createAccountStore>;

export function useAccountView(store: AccountStore) {
  const state = useSyncExternalStore(store.subscribe, store.read);
  const toast = useToast();
  const { t } = useTranslation(messages);
  useEffect(() => {
    const notice = store.takeNotice();
    if (notice) toast.show(notice.kind === "active" ? t("activeChanged", { email: notice.email }) : t("signedOut"), { variant: "info" });
  }, [store, state.view?.notice, toast, t]);
  return state;
}
