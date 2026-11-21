import { useTranslation } from "@getpaseo/plugin/client";
import { SettingsRow, ExternalLink } from "@getpaseo/plugin/client/ui";
import { messages } from "./messages.ts";

export function ErrorMessage({ message }: { message: string }) {
  const { t } = useTranslation(messages);
  const link = message.match(/https:\/\/[^\s"'<>]+/)?.[0];
  return <SettingsRow label={message}>{link && <ExternalLink href={link}>{t("verification")}</ExternalLink>}</SettingsRow>;
}
