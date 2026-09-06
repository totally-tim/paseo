import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useProviderAccounts } from "@/provider-accounts/use-provider-accounts";
import { useAgentContinuation } from "./use-continuation";

const labels = {
  continuing: "Continuing",
  waiting: "Waiting for capacity",
  attention: "Needs attention",
  cancelled: "Automatic continuation cancelled",
  active: "Continued task",
};
export function AgentRecoveryStatus({ serverId, agentId }: { serverId: string; agentId: string }) {
  const recovery = useAgentContinuation(serverId, agentId);
  const accounts = useProviderAccounts(serverId);
  const [error, setError] = useState<string | null>(null);
  const { cancel: cancelRecovery } = recovery;
  const cancel = useCallback(async () => {
    try {
      await cancelRecovery();
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not cancel recovery.");
    }
  }, [cancelRecovery]);
  const status = recovery.data?.continuation;
  if (!status) return null;
  const waiting = status.status === "waiting";
  const accountLabel = (id?: string) =>
    accounts.data?.accounts.find((account) => account.id === id)?.label ?? "Account";
  return (
    <View style={styles.container} testID="agent-continuation-status">
      <Text style={styles.text}>{labels[status.status]}</Text>
      <Text style={styles.text}>{status.reason}</Text>
      {status.previousAccountId && status.accountId ? (
        <Text style={styles.text}>
          {accountLabel(status.previousAccountId)} → {accountLabel(status.accountId)}
        </Text>
      ) : null}
      {waiting && status.resetsAt ? (
        <Text style={styles.text}>
          Next reported reset: {new Date(status.resetsAt).toLocaleString()}
        </Text>
      ) : null}
      {waiting && status.nextCheckAt ? (
        <Text style={styles.text}>
          Next capacity check: {new Date(status.nextCheckAt).toLocaleString()}
        </Text>
      ) : null}
      {["waiting", "continuing", "attention"].includes(status.status) ? (
        <Button
          size="sm"
          variant="ghost"
          onPress={cancel}
          disabled={!recovery.connected}
          testID="agent-continuation-cancel"
        >
          {waiting ? "Cancel wait" : "Cancel automatic continuation"}
        </Button>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { paddingHorizontal: theme.spacing[4], gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
