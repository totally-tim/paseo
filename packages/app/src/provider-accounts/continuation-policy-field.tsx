import { useCallback } from "react";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentContinuationPolicy } from "@getpaseo/protocol/agent-continuation";
import { Switch } from "@/components/ui/switch";
import { useHostFeature } from "@/runtime/host-features";
import { useProviderAccounts } from "./use-provider-accounts";

export function ContinuationPolicyField({
  serverId,
  provider,
  value,
  onChange,
  disabled,
}: {
  serverId: string;
  provider: string;
  value?: AgentContinuationPolicy;
  onChange: (policy: AgentContinuationPolicy | undefined) => void;
  disabled?: boolean;
}) {
  const supported = useHostFeature(serverId, "agentContinuation");
  const catalog = useProviderAccounts(serverId);
  const enable = useCallback(
    (enabled: boolean) => onChange(enabled ? { accountIds: [] } : undefined),
    [onChange],
  );
  if (provider !== "claude" && provider !== "codex") return null;
  const accounts =
    catalog.data?.accounts.filter(
      (account) => account.provider === provider && !account.removedAt,
    ) ?? [];
  const selected = value?.accountIds ?? [];
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.label}>Automatically continue using these accounts</Text>
        <Switch
          value={Boolean(value)}
          disabled={disabled || !supported}
          accessibilityLabel="Automatically continue using these accounts"
          testID="profile-continuation-enable"
          onValueChange={enable}
        />
      </View>
      {!supported ? (
        <Text style={styles.description}>Update this host to enable automatic continuation.</Text>
      ) : null}
      {value ? (
        <>
          <Text style={styles.description}>
            Select the accounts this task may use after a confirmed limit. Newly connected accounts
            stay excluded. This applies to future ordinary agents.
          </Text>
          {accounts.map((account) => (
            <PermittedAccount
              key={account.id}
              account={account}
              selected={selected}
              onChange={onChange}
              disabled={disabled}
            />
          ))}
          {!selected.length ? (
            <Text style={styles.error}>Select at least one permitted account.</Text>
          ) : null}
          {selected.some((id) => !accounts.some((account) => account.id === id)) ? (
            <Text style={styles.error}>
              A selected account is no longer available. Select the permitted accounts again.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
function PermittedAccount({
  account,
  selected,
  onChange,
  disabled,
}: {
  account: ProviderAccount;
  selected: string[];
  disabled?: boolean;
  onChange: (policy: AgentContinuationPolicy | undefined) => void;
}) {
  const toggle = useCallback(
    (enabled: boolean) =>
      onChange({
        accountIds: enabled
          ? [...selected, account.id]
          : selected.filter((id) => id !== account.id),
      }),
    [account.id, onChange, selected],
  );
  return (
    <View style={styles.row}>
      <View style={styles.account}>
        <Text style={styles.label}>{account.label}</Text>
        <Text style={styles.description}>
          {account.identity?.email ?? account.authState}
          {account.enabled ? "" : " · Disabled"}
        </Text>
      </View>
      <Switch
        value={selected.includes(account.id)}
        disabled={disabled}
        accessibilityLabel={`Permit ${account.label} for automatic continuation`}
        onValueChange={toggle}
      />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  account: { flex: 1 },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
