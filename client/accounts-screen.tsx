import { useState } from "react";
import { useRpc, useTranslation, type PluginHostProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import {
  Loading, Modal, ScrollView, SettingsAction, SettingsInput, SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { accountsRpc, type AccountView } from "../shared/accounts-rpc.ts";
import { ErrorMessage } from "./error-message.tsx";
import { AddAccount } from "./add-account.tsx";
import { accountLabel, quotaSummary } from "./account-choice.ts";
import { messages } from "./messages.ts";
import { QuotaDetails } from "./quota-details.tsx";
import { useAccountView, type AccountStore } from "./store.ts";

function AccountQuota({ account, active, quotaError, theme }: { account: AccountView; active: boolean; quotaError: boolean; theme: PluginHostProps["theme"] }) {
  const { t, locale } = useTranslation(messages);
  const [choice, setChoice] = useState<boolean | null>(null);
  const summary = quotaSummary(account, active, quotaError);
  const expanded = choice ?? active;
  const label = summary.depleted ? t(active ? "depleted" : "snapshotDepleted")
    : summary.minimum === null ? t("unknown") : t(active ? "remaining" : "snapshotRemaining", {
      percent: summary.minimum.toLocaleString(locale, { maximumFractionDigits: 1 }),
    });
  return <>
    <SettingsAction label={label} actionLabel={t(expanded ? "hideQuota" : "showQuota")}
      onPress={() => setChoice(!expanded)} />
    {expanded && <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}><QuotaDetails account={account} active={active} theme={theme} /></View>}
  </>;
}

type Dialog = { kind: "switch" | "remove" | "rename"; account: AccountView } | { kind: "add" };

export function AccountsScreen({ store, confirmId, theme }: { store: AccountStore; confirmId?: string; theme: PluginHostProps["theme"] }) {
  const { t } = useTranslation(messages);
  const { view, error } = useAccountView(store);
  const switchAccount = useRpc(accountsRpc.switch);
  const remove = useRpc(accountsRpc.remove);
  const rename = useRpc(accountsRpc.rename);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [nickname, setNickname] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const target = view?.accounts.find((account) => account.id === confirmId && account.id !== view.activeAccountId);
  const current = dialog ?? (!dismissed && target ? { kind: "switch" as const, account: target } : null);
  function close() {
    setDismissed(true);
    setDialog(null);
    setProblem("");
  }
  function open(next: Dialog) {
    setProblem("");
    setNickname(next.kind === "rename" ? next.account.nickname ?? "" : "");
    setDialog(next);
  }
  async function submit() {
    if (!current || current.kind === "add" || pending) return;
    setPending(true);
    setProblem("");
    try {
      switch (current.kind) {
        case "switch": await switchAccount({ id: current.account.id }); break;
        case "remove": await remove({ id: current.account.id }); break;
        case "rename": await rename({ id: current.account.id, nickname }); break;
      }
      close();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await store.refresh();
      setPending(false);
    }
  }
  if (!view && !error) return <Loading />;
  // Another client can own a live operation, or an interrupted journal can need a retry.
  // The server distinguishes the two under its mutex. Keep recovery reachable in both cases.
  const disabled = pending;
  const title = t(current?.kind === "switch" ? "switchTitle" : current?.kind === "remove" ? "deleteTitle" : "renameTitle");
  return <>
    <ScrollView contentContainerStyle={{ gap: 16, padding: 16 }}>
      {error && <ErrorMessage message={error} />}
      {!view?.activeAccountId && <SettingsRow label={t("signedOut")} />}
      {view?.accounts.map((account) => {
        const active = account.id === view.activeAccountId;
        return <SettingsSection key={account.id} title={accountLabel(account)}>
          <SettingsRow label={t(active ? "active" : "standby")} hint={account.email} />
          <AccountQuota account={account} active={active} quotaError={view.quotaError} theme={theme} />
          {!active && <SettingsAction label={t("useAccount")} actionLabel={t("switchAccount")}
            disabled={disabled} onPress={() => open({ kind: "switch", account })} />}
          <SettingsAction label={t("nickname")} actionLabel={t("rename")} disabled={disabled} onPress={() => open({ kind: "rename", account })} />
          {!active && <SettingsAction label={t("remove")} actionLabel={t("delete")}
            disabled={disabled} onPress={() => open({ kind: "remove", account })} />}
        </SettingsSection>;
      })}
      <SettingsAction label={t("signIn")} actionLabel={t("add")} disabled={disabled} onPress={() => open({ kind: "add" })} />
    </ScrollView>
    {current?.kind === "add" && <AddAccount close={close} refresh={store.refresh} />}
    {current && current.kind !== "add" && <Modal open title={title} onOpenChange={(visible) => { if (!visible && !pending) close(); }}>
      <Modal.Content>
        <SettingsRow label={accountLabel(current.account)} hint={current.account.email} />
        {current.kind === "rename" && <SettingsInput label={t("nickname")} initialValue={nickname} onChangeText={setNickname} disabled={disabled} />}
        {current.kind === "switch" && <SettingsRow label={t("switchWarning")} />}
        {problem && <ErrorMessage message={problem} />}
        <SettingsAction label={title} actionLabel={t(pending ? "working" : "confirm")} disabled={disabled} onPress={() => void submit()} />
        <SettingsAction label={t("closeDialog")} actionLabel={t("cancel")} disabled={pending} onPress={close} />
      </Modal.Content>
    </Modal>}
  </>;
}
