import { Text, View } from "react-native";
import { useTranslation, type PluginHostProps } from "@getpaseo/plugin/client";
import type { AccountView } from "../shared/accounts-rpc.ts";
import { accountLabel, remaining, windows } from "./account-choice.ts";
import { ErrorMessage } from "./error-message.tsx";
import { messages } from "./messages.ts";

export function QuotaDetails({ account, active, theme }: { account: AccountView; active: boolean; theme: PluginHostProps["theme"] }) {
  const { t, locale } = useTranslation(messages);
  const { colors } = theme;
  const muted = { color: colors.foregroundMuted, fontSize: 12 };
  const time = (value: string) => new Date(value).toLocaleString(locale);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const snapshot = account.snapshot;
  if (!snapshot) return <Text style={muted}>{t("unknown")}</Text>;
  const report = snapshot.report;
  const problem = report.status === "unavailable" ? report.problem : null;
  const measured = windows(account);
  return <View style={{ gap: 12 }}>
    <Text style={muted}>{t(active ? "lastReading" : "snapshot", { time: time(snapshot.readAt) })}</Text>
    {report.status === "error" && <ErrorMessage message={report.error} />}
    {problem && <>
      <Text style={muted}>{t("unavailable")}</Text>
      {problem.kind === "no_quota" ? <ErrorMessage message={problem.detail} /> : <Text style={muted}>{problem.kind === "expired"
        ? t("expired", { time: time(problem.expiresAt) }) : t("rejected", { status: problem.status })}</Text>}
    </>}
    {report.status === "available" && !measured.length && <Text style={muted}>{t("unknown")}</Text>}
    {measured.map((window) => {
      const percent = remaining(window);
      const description = percent === null ? t("unknown") : t("remaining", { percent: number.format(percent) });
      const color = percent === 0 ? colors.statusDanger : percent !== null && percent <= 20 ? colors.statusWarning : colors.accent;
      const reset = window.resetsAt;
      const elapsed = !active && reset && Date.parse(reset) <= Date.now();
      const [group, period] = window.label.split(" · ");
      const duration = /^(\d+)-(day|hour|minute|second)$/.exec(period ?? "");
      const named = { Weekly: "weekly", Daily: "daily", Monthly: "monthly" } as const;
      const unit = { day: "days", hour: "hours", minute: "minutes", second: "seconds" } as const;
      const label = period && Object.hasOwn(named, period) ? `${group} · ${t(named[period as keyof typeof named])}`
        : duration ? `${group} · ${t(unit[duration[2] as keyof typeof unit], { amount: duration[1] })}` : window.label;
      return <View key={window.id} style={{ gap: 5 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 8 }}>
          <Text style={{ color: colors.foreground, fontSize: 13 }}>{label}</Text>
          <Text style={muted}>{description}</Text>
        </View>
        <View accessibilityRole={percent === null ? undefined : "progressbar"}
          accessibilityLabel={label} aria-valuemin={percent === null ? undefined : 0}
          aria-valuemax={percent === null ? undefined : 100} aria-valuenow={percent ?? undefined}
          aria-valuetext={percent === null ? undefined : description}
          style={{ height: 5, borderRadius: 3, overflow: "hidden", backgroundColor: colors.surface2 }}>
          {percent !== null && <View style={{ height: "100%", width: `${percent}%`, backgroundColor: color }} />}
        </View>
        {reset && <Text style={muted}>{t("reset", { time: time(reset) })}{elapsed ? ` · ${t("resetPassed")}` : ""}</Text>}
      </View>;
    })}
  </View>;
}

export function ActiveQuotaHeading({ account, theme }: { account: AccountView; theme: PluginHostProps["theme"] }) {
  const { t } = useTranslation(messages);
  return <View style={{ gap: 3 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{accountLabel(account)}</Text>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t("active")}</Text>
  </View>;
}
