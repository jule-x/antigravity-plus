import { useEffect, useRef, useState } from "react";
import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { ExternalLink, Modal, SettingsAction, SettingsInput, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { ErrorMessage } from "./error-message.tsx";
import { messages } from "./messages.ts";
import { accountsRpc, type LoginStatus } from "../shared/accounts-rpc.ts";

export function AddAccount({ close, refresh }: { close(): void; refresh(): Promise<void> }) {
  const { t } = useTranslation(messages);
  const begin = useRpc(accountsRpc.add);
  const read = useRpc(accountsRpc.loginStatus);
  const send = useRpc(accountsRpc.loginSubmit);
  const cancel = useRpc(accountsRpc.loginCancel);
  const [makeActive, setMakeActive] = useState(false);
  const [id, setId] = useState("");
  const [status, setStatus] = useState<LoginStatus | null>(null);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<{ detail: string } | { key: "startError" | "submitError" | "cancelError" } | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [sending, setSending] = useState(false);
  const live = useRef(true);
  const owned = useRef("");
  const release = useRef(cancel);
  release.current = cancel;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (owned.current) void release.current({ id: owned.current }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await read({id});
        if (stopped) return;
        setDisconnected(false);
        setStatus(next);
        if (next.phase === "done" || next.phase === "failed") {
          owned.current = "";
          setId("");
          setValue("");
          void refresh();
          if (next.phase === "done") close();
          else { setStatus(null); setProblem({ detail: next.message }); }
          return;
        }
      } catch {
        if (stopped) return;
        setDisconnected(true);
      }
      timer = setTimeout(() => void poll(), 750);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, read]);

  async function start() {
    setProblem(null);
    setStatus({ phase: "starting" });
    try {
      const result = await begin({makeActive});
      if (!live.current) { await cancel(result); return; }
      owned.current = result.id;
      setId(result.id);
    } catch (error) {
      if (live.current) {
        setProblem(error instanceof Error ? { detail: error.message } : { key: "startError" });
        setStatus(null);
      }
    }
  }

  async function submit() {
    setSending(true);
    setProblem(null);
    try {
      await send({id, value});
      setValue("");
      setStatus({ phase: "submitted" });
    } catch {
      setProblem({ key: "submitError" });
    } finally { setSending(false); }
  }

  async function dismiss() {
    if (!id) { close(); return; }
    try {
      await cancel({id});
      setValue("");
      setStatus({ phase: "finishing" });
    } catch { setProblem({ key: "cancelError" }); }
  }

  const finishing = status?.phase === "finishing";
  return <Modal open title={t("add")} onOpenChange={open => { if (!open && !finishing) void dismiss(); }}>
    <Modal.Content>
      <SettingsSwitch label={t("useNewLogin")} value={makeActive} onValueChange={setMakeActive} disabled={!!status} />
      {!status && <SettingsAction label={t("signIn")} actionLabel={t("start")} onPress={() => void start()} />}
      {status?.phase === "starting" && <SettingsRow label={t("waitingLink")} />}
      {status?.phase === "input" && <>
        <ExternalLink href={status.url}>{t("openLogin")}</ExternalLink>
        <SettingsInput label={t("authCode")} secureTextEntry onChangeText={setValue} />
        <SettingsAction label={t("sendCode")} actionLabel={t("submit")} disabled={!value.trim() || sending} onPress={() => void submit()} />
      </>}
      {status?.phase === "submitted" && <SettingsRow label={t("waitingLogin")} />}
      {finishing && <SettingsRow label={t("finishing")} />}
      {disconnected && <SettingsRow label={t("reconnecting")} />}
      {problem && <ErrorMessage message={"detail" in problem ? problem.detail : t(problem.key)} />}
      <SettingsAction label={t("closeLogin")} actionLabel={t("cancel")} disabled={finishing} onPress={() => void dismiss()} />
    </Modal.Content>
  </Modal>;
}
