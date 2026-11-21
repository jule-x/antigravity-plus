import { useState } from "react";
import {
  useComposer, useTranslation, type PluginButtonContentProps, type PluginButtonIconProps, type PluginButtonRegistration,
  type PluginClientContext, type PluginHostProps, type PluginSidebarItemProps, type PluginText,
} from "@getpaseo/plugin/client";
import { Action, Icon, Loading, Modal, ScrollView, SettingsAction, SettingsRow, SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { AccountsScreen } from "./client/accounts-screen.tsx";
import { composerChoice } from "./client/account-choice.ts";
import { ErrorMessage } from "./client/error-message.tsx";
import { messages } from "./client/messages.ts";
import { ActiveQuotaHeading, QuotaDetails } from "./client/quota-details.tsx";
import { SettingsScreen } from "./client/settings-screen.tsx";
import { createAccountStore, useAccountView } from "./client/store.ts";

export default function contribute(client: PluginClientContext) {
  const store = createAccountStore(client);
  const screenId = "accounts";
  const title = messages.message("accounts");
  const screen = client.addScreen({
    id: screenId, title,
    Component: ({ params, theme }) => <AccountsScreen key={params.request || "accounts"} store={store} confirmId={params.confirm} theme={theme} />,
  });
  const sidebar = client.addSidebarHeaderItem({
    id: screenId, title,
    Component: ({ currentScreen, openScreen }: PluginSidebarItemProps) => <SidebarRow icon="Users"
      active={currentScreen?.screenId === screenId} onPress={() => openScreen({ screenId })} />,
  });
  const settings = client.addSettingsScreen({
    id: "settings",
    title: "Antigravity+",
    icon: "Shield",
    Component: SettingsScreen,
  });

  function useActiveQuota() {
    const { view, error } = useAccountView(store);
    const active = view?.accounts.find((account) => account.id === view.activeAccountId);
    const choice = view && active ? composerChoice(view, active) : undefined;
    return { view, error, active, choice };
  }

  function QuotaIcon({ size, color, theme }: PluginButtonIconProps) {
    const depleted = useActiveQuota().choice?.depleted;
    return <Icon name={depleted ? "CircleAlert" : "Gauge"} size={size} color={depleted ? theme.colors.statusWarning : color} />;
  }

  function QuotaContent({ close, theme }: { close(): void; theme: PluginHostProps["theme"] }) {
    const { t } = useTranslation(messages);
    const { view, error, active, choice } = useActiveQuota();
    const confirmId = choice?.confirmId;
    return <>
      {!view && !error && <Loading />}
      {error && <ErrorMessage message={error} />}
      {view && !active && <SettingsRow label={t("signedOut")} />}
      {active && <>
        <ActiveQuotaHeading account={active} theme={theme} />
        {choice?.depleted && <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{t("depleted")}</Text>}
        <QuotaDetails account={active} active theme={theme} />
      </>}
      <SettingsAction label={t("accounts")} actionLabel={t("manage")} onPress={() => {
        close();
        client.openScreen({ screenId, params: confirmId ? { confirm: confirmId, request: String(Date.now()) } : {} });
      }} />
    </>;
  }

  function QuotaPopover({ close, layout, theme }: PluginButtonContentProps) {
    return <ScrollView style={{ width: layout.compact ? "100%" : 320, maxHeight: 380 }} contentContainerStyle={{ gap: 12, padding: 12 }}>
      <QuotaContent close={close} theme={theme} />
    </ScrollView>;
  }

  function QuotaAction({ theme }: PluginHostProps) {
    const { t } = useTranslation(messages);
    const [open, setOpen] = useState(false);
    const depleted = useActiveQuota().choice?.depleted;
    return <>
      <Action title={t("quota")} icon={depleted ? "CircleAlert" : "Gauge"} onPress={() => setOpen(true)} />
      {open && <Modal title={t("quota")} open onOpenChange={setOpen}>
        <Modal.Content>
          <QuotaContent close={() => setOpen(false)} theme={theme} />
        </Modal.Content>
      </Modal>}
    </>;
  }

  const composer = client.addComposerItem({
    id: "quota",
    Component: (props) => useComposer().agent.provider === "antigravity-plus" ? <QuotaAction {...props} /> : null,
  });

  const lifetime = new AbortController();
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration<PluginText> }>();
  function remove(id: string) {
    pills.get(id)?.registration.remove();
    pills.delete(id);
  }
  function register(agent: { id: string; provider: string; workspaceId?: string; archivedAt?: string | null }) {
    if (lifetime.signal.aborted) return;
    const { id, workspaceId } = agent;
    if (agent.provider !== "antigravity-plus" || !workspaceId || agent.archivedAt) { remove(id); return; }
    if (pills.get(id)?.workspaceId === workspaceId) return;
    remove(id);
    const registration = client.addComposerPill({
      id: "active-account", workspaceId, agentId: id,
      button: { title: messages.message("quota"), icon: QuotaIcon, behavior: { kind: "popover", Content: QuotaPopover } },
    });
    pills.set(id, { workspaceId, registration });
  }
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) return subscription.release();
    subscription.subscribe({
      snapshot: ({ entries }) => {
        const ids = new Set(entries.map(({ agent }) => agent.id));
        for (const id of pills.keys()) if (!ids.has(id)) remove(id);
        for (const { agent } of entries) register(agent);
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") register(update.agent);
        else remove(update.agentId);
      },
    });
  }).catch((error) => {
    if (!lifetime.signal.aborted) console.error("Antigravity+ agent observation failed", error);
  });
  return () => {
    lifetime.abort();
    for (const id of pills.keys()) remove(id);
    composer();
    settings();
    sidebar();
    screen();
    store.dispose();
  };
}
