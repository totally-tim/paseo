import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { applicableAccountUsage } from "./account-view-model";
import { ProviderUsageCard } from "@/provider-usage/card";
import { useProviderAccounts } from "./use-provider-accounts";

export function AccountUsageTooltip({
  serverId,
  accountId,
  provider,
  model,
}: {
  serverId: string;
  accountId: string;
  provider?: string | null;
  model?: string | null;
}) {
  const { t } = useTranslation();
  const accounts = useProviderAccounts(serverId);
  const account = accounts.data?.accounts.find((entry) => entry.id === accountId);
  const entry = accounts.data?.usage.find((item) => item.accountId === accountId);
  const usage = useMemo(() => applicableAccountUsage(entry?.usage, model), [entry, model]);
  const providerLabel =
    ({ claude: "Claude", codex: "Codex" } as Record<string, string>)[provider ?? ""] ?? provider;
  return (
    <View style={styles.section} testID="agent-account-usage">
      <Text style={styles.title}>
        {providerLabel} {model ? `· ${model}` : ""}
      </Text>
      <Text style={styles.title}>{account?.label ?? t("providerAccounts.missingAccount")}</Text>
      {account?.identity?.email ? (
        <Text style={styles.detail}>{account.identity.email}</Text>
      ) : null}
      {usage ? (
        <ProviderUsageCard usage={usage} compact showIdentity={false} showResetDates />
      ) : (
        <Text style={styles.detail}>{t("providerAccounts.usageUnavailable")}</Text>
      )}
      {entry?.stale ? (
        <Text style={styles.detail}>{t("providerAccounts.lastReported")}</Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderAccent,
    paddingTop: theme.spacing[2],
    marginTop: theme.spacing[2],
    gap: theme.spacing[1.5],
    maxWidth: 300,
  },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
