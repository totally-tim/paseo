import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { ComboboxItem } from "@/components/ui/combobox";
import type { SelectFieldRenderOptionInput } from "@/components/ui/select-field";
import { formatResetLabel } from "@/provider-usage/format";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import type { ProviderUsage } from "@/provider-usage/types";
import { activeCapacityLimit } from "./account-view-model";

/**
 * What a row in the account picker shows besides its label. The automatic row has
 * help text and nothing else; every other row stands for an account and can carry
 * an identity and a usage reading.
 */
export interface AccountOptionDetail {
  help?: string;
  account?: ProviderAccount;
  /** Already narrowed to the windows that apply to the selected model. */
  usage?: ProviderUsage | null;
  stale?: boolean;
  /** The model the agent will start on, which decides whether a capacity limit applies. */
  model?: string | null;
}

export function AccountSelectionOption({
  option,
  selected,
  active,
  onPress,
  detail,
}: SelectFieldRenderOptionInput<string> & { detail: AccountOptionDetail | undefined }) {
  const body = useMemo(() => (detail ? <AccountOptionBody detail={detail} /> : null), [detail]);
  return (
    <ComboboxItem
      label={option.label}
      body={body}
      disabled={option.disabled}
      selected={selected}
      active={active}
      onPress={onPress}
      testID={`account-option-${option.id}`}
    />
  );
}

function AccountOptionBody({ detail }: { detail: AccountOptionDetail }) {
  const { help, account } = detail;
  const email = account?.identity?.email;
  const ready = Boolean(account && account.enabled && account.authState === "ready");
  return (
    <>
      {help ? <Text style={styles.text}>{help}</Text> : null}
      {email ? (
        <Text style={styles.text} numberOfLines={1}>
          {email}
        </Text>
      ) : null}
      {account && !ready ? <AccountOptionStatus account={account} /> : null}
      {account && ready ? <AccountOptionCapacity account={account} model={detail.model} /> : null}
      {account && ready ? <AccountOptionUsage detail={detail} accountId={account.id} /> : null}
    </>
  );
}

function AccountOptionStatus({ account }: { account: ProviderAccount }) {
  const { t } = useTranslation();
  return (
    <Text style={styles.text}>
      {account.enabled
        ? t(`providerAccounts.auth.${account.authState}`)
        : t("providerAccounts.disabled")}
    </Text>
  );
}

function AccountOptionCapacity({
  account,
  model,
}: {
  account: ProviderAccount;
  model: string | null | undefined;
}) {
  const { t } = useTranslation();
  const limit = activeCapacityLimit(account, model);
  if (!limit) return null;
  const reset = formatResetLabel(limit.resetsAt);
  const label = limit.model
    ? t("providerAccounts.capacityLimitModel", { model: limit.model })
    : t("providerAccounts.capacityExhausted");
  return (
    <Text style={styles.limit} testID={`account-option-capacity-${account.id}`}>
      {reset ? `${label} · ${reset}` : label}
    </Text>
  );
}

function AccountOptionUsage({
  detail,
  accountId,
}: {
  detail: AccountOptionDetail;
  accountId: string;
}) {
  const { t } = useTranslation();
  const windows = detail.usage?.windows ?? [];
  if (windows.length === 0) {
    return <Text style={styles.text}>{t("providerAccounts.usageUnavailable")}</Text>;
  }
  return (
    <View style={styles.usage} testID={`account-option-usage-${accountId}`}>
      {windows.map((window) => (
        <ProviderUsageWindowBar key={window.id} window={window} />
      ))}
      {detail.stale ? <Text style={styles.text}>{t("providerAccounts.stale")}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  limit: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  usage: { gap: theme.spacing[2], paddingTop: theme.spacing[1] },
}));
