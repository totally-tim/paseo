import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useProviderAccounts } from "./use-provider-accounts";

export function AgentAccountLabel({
  serverId,
  accountId,
}: {
  serverId: string;
  accountId: string;
}) {
  const { data } = useProviderAccounts(serverId);
  const account = data?.accounts.find((entry) => entry.id === accountId);
  return (
    <Text style={styles.text} testID="agent-account-label">
      {account?.label ?? accountId}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
