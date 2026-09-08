import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AccountSelection, ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { SelectField } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ProviderUsageCard } from "@/provider-usage/card";
import { useProviderAccounts } from "./use-provider-accounts";
import { selectedAccount } from "./selection-summary";

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
      {
        id: "automatic",
        value: "automatic",
        label: t("providerAccounts.automatic"),
        description: t("providerAccounts.automaticHelp"),
      },
      {
        id: "default",
        value: "default",
        label: t("providerAccounts.hostAccount"),
        disabled:
          accounts.data?.accounts.find((account) => account.id === `default:${provider}`)
            ?.enabled === false,
        description: t("providerAccounts.externalHelp"),
      },
      ...(accounts.data?.accounts ?? [])
        .filter(
          (account) =>
            account.provider === provider && account.ownership === "managed" && !account.removedAt,
        )
        .map((account) => ({
          id: account.id,
          value: account.id,
          label: account.label,
          disabled: !account.enabled || account.authState !== "ready",
          description:
            account.authState === "ready" && account.enabled
              ? (account.identity?.email ?? t("providerAccounts.auth.ready"))
              : t(
                  account.enabled
                    ? `providerAccounts.auth.${account.authState}`
                    : "providerAccounts.disabled",
                ),
        })),
    ],
    [accounts.data, provider, t],
  );
  const defaultKind = defaultSelection(accounts.data?.accounts ?? [], provider);
  const selection = useMemo(() => value ?? { kind: defaultKind }, [value, defaultKind]);
  const selected = value?.kind === "fixed" ? value.accountId : (value?.kind ?? defaultKind);
  const display = useMemo(
    () => ({
      label:
        options.find((option) => option.value === selected)?.label ??
        t("providerAccounts.missingAccount"),
    }),
    [options, selected, t],
  );
  const change = useCallback(
    (id: string) =>
      onChange(
        id === "automatic" || id === "default" ? { kind: id } : { kind: "fixed", accountId: id },
      ),
    [onChange],
  );
  if (!supportsProvider(accounts.supported, provider)) return null;
  return (
    <View style={compact ? styles.compact : undefined}>
      <SelectField
        label={t("providerAccounts.account")}
        field={!compact}
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
      {!compact ? (
        <AccountSelectionDetails data={accounts.data} provider={provider} selection={selection} />
      ) : null}
      {!compact && accounts.isError ? (
        <Text style={styles.error}>{t("providerAccounts.loadError")}</Text>
      ) : null}
    </View>
  );
}

function AccountSelectionDetails({
  data,
  provider,
  selection,
}: {
  data: ReturnType<typeof useProviderAccounts>["data"];
  provider: string;
  selection: AccountSelection;
}) {
  const { t } = useTranslation();
  const account = selectedAccount(data, provider, selection);
  const usageEntry = data?.usage.find((entry) => entry.accountId === account?.id);

  return (
    <>
      {selection.kind === "automatic" ? (
        <Text style={styles.text}>{t("providerAccounts.automaticHelp")}</Text>
      ) : null}
      {account && usageEntry ? (
        <View testID="provider-account-selected-usage">
          <ProviderUsageCard usage={usageEntry.usage} compact showIdentity={false} />
          {usageEntry.stale ? (
            <Text style={styles.text}>{t("providerAccounts.lastReported")}</Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
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
