import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AccountSelection, ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { SelectField } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProviderAccounts } from "./use-provider-accounts";

export function AccountSelectionField({
  serverId,
  provider,
  value,
  onChange,
  disabled,
  compact = false,
}: {
  serverId: string;
  provider: string;
  value?: AccountSelection;
  onChange: (selection: AccountSelection) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const accounts = useProviderAccounts(serverId);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const options = useMemo(
    () => [
      { id: "automatic", value: "automatic", label: t("providerAccounts.automatic") },
      { id: "default", value: "default", label: t("providerAccounts.hostAccount") },
      ...(accounts.data?.accounts ?? [])
        .filter(
          (account) =>
            account.provider === provider && account.ownership === "managed" && !account.removedAt,
        )
        .map((account) => ({
          id: account.id,
          value: account.id,
          label: account.label,
          description: account.identity?.email ?? t(`providerAccounts.auth.${account.authState}`),
        })),
    ],
    [accounts.data, provider, t],
  );
  const defaultKind = defaultSelection(accounts.data?.accounts ?? [], provider);
  const selected = value?.kind === "fixed" ? value.accountId : (value?.kind ?? defaultKind);
  const display = useMemo(
    () =>
      options.find((option) => option.value === selected) ?? {
        label: t("providerAccounts.missingAccount"),
      },
    [options, selected, t],
  );
  const change = useCallback(
    (id: string) =>
      onChange(
        id === "automatic" || id === "default" ? { kind: id } : { kind: "fixed", accountId: id },
      ),
    [onChange],
  );
  const next =
    selected === "automatic"
      ? accounts.data?.next.find((entry) => entry.provider === provider)
      : null;
  const nextText = useNextAccountText(accounts.data, next);
  if (!supportsProvider(accounts.supported, provider)) return null;
  return (
    <View style={compact ? styles.compact : undefined}>
      <SelectField
        label={compact ? "" : t("providerAccounts.account")}
        value={selected}
        selectedDisplay={display}
        options={options}
        onChange={change}
        placeholder={t("providerAccounts.account")}
        emptyText={t("common.empty.noResults")}
        disabled={disabled || !accounts.connected}
        loading={accounts.isPending}
        size={size}
        triggerTestID="provider-account-selection"
      />
      {!compact && next ? (
        <Text style={styles.text} testID="provider-account-next">
          {nextText}
        </Text>
      ) : null}
      {!compact && accounts.isError ? (
        <Text style={styles.error}>{t("providerAccounts.loadError")}</Text>
      ) : null}
    </View>
  );
}

function useNextAccountText(
  data: ReturnType<typeof useProviderAccounts>["data"],
  next: { accountId: string | null; reason: string } | null | undefined,
): string | null {
  const { t } = useTranslation();
  const account = data?.accounts.find((entry) => entry.id === next?.accountId);
  return account ? t("providerAccounts.next", { account: account.label }) : (next?.reason ?? null);
}

const styles = StyleSheet.create((theme) => ({
  compact: { maxWidth: 220, minWidth: 120 },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));

function defaultSelection(accounts: ProviderAccount[], provider: string): "automatic" | "default" {
  return accounts.some(
    (account) =>
      account.provider === provider &&
      account.ownership === "managed" &&
      account.enabled &&
      !account.removedAt,
  )
    ? "automatic"
    : "default";
}

function supportsProvider(supported: boolean, provider: string): boolean {
  return supported && (provider === "claude" || provider === "codex");
}
