import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { openPermissionPolicy } from "./permission-policy-model";
const HEADER = { title: "Always allow this" };
export function PermissionPolicySheet({
  agentId,
  requestId,
  client,
  onClose,
}: {
  agentId: string;
  requestId: string;
  client: DaemonClient | null;
  onClose: () => void;
}) {
  const [model] = useState(() => openPermissionPolicy(agentId, requestId));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    void model.load(client);
  }, [model, client]);
  useEffect(() => () => model.close(), [model]);
  const close = useCallback(() => {
    if (state.status !== "ready" || !state.pending) onClose();
  }, [state, onClose]);
  const projectScope = useCallback(() => model.setScope("project"), [model]);
  const daemonScope = useCallback(() => model.setScope("daemon"), [model]);
  const save = useCallback(() => void model.save(client), [model, client]);
  const retry = useCallback(() => void model.load(client), [model, client]);
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={HEADER}
      testID="coordinator-policy-confirmation"
    >
      <View style={styles.content}>
        {state.status === "ready" ? (
          <>
            <Text style={styles.text}>
              Save this exact provider, tool, and complete input. Saving approves this request once.
            </Text>
            <Text selectable style={styles.rule}>
              {JSON.stringify(JSON.parse(state.preview.pattern), null, 2)}
            </Text>
            <Text style={styles.muted}>
              Every field must match, including working directory, paths, descriptions, and timeouts
              when present. A different worktree or changed input needs a separate approval.
            </Text>
            <Text style={styles.text}>
              Saved rules answer future requests automatically only when the project coordinator is
              at Ship or Autopilot. At Observe or Propose, requests still need your approval.
            </Text>
            <Text style={styles.text}>Scope</Text>
            <View style={styles.actions}>
              {state.preview.projectId ? (
                <Button
                  variant={state.scope === "project" ? "default" : "ghost"}
                  disabled={state.pending || state.saved}
                  onPress={projectScope}
                >
                  This project
                </Button>
              ) : null}
              <Button
                variant={state.scope === "daemon" ? "default" : "ghost"}
                disabled={state.pending || state.saved}
                onPress={daemonScope}
              >
                All projects
              </Button>
            </View>
            {state.scope === "daemon" ? (
              <Text style={styles.muted}>Applies across this host, including future projects.</Text>
            ) : (
              <Text style={styles.muted}>Project: {state.preview.projectId}</Text>
            )}
            {state.error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {state.error}
              </Text>
            ) : null}
            {state.saved ? (
              <>
                <Text style={styles.text}>Rule saved and permission approved.</Text>
                <Button onPress={onClose}>Done</Button>
              </>
            ) : (
              <View style={styles.actions}>
                <Button variant="ghost" disabled={state.pending} onPress={onClose}>
                  Cancel
                </Button>
                <Button disabled={!client} loading={state.pending} onPress={save}>
                  Save rule and allow
                </Button>
              </View>
            )}
          </>
        ) : (
          <>
            <Text style={styles.muted}>
              {state.status === "error" ? state.error : "Loading exact permission rule…"}
            </Text>
            {state.status === "error" ? (
              <Button variant="ghost" onPress={retry}>
                Retry
              </Button>
            ) : null}
          </>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  rule: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));

export function ConnectedPermissionPolicySheet({
  serverId,
  ...props
}: {
  serverId: string;
  agentId: string;
  requestId: string;
  onClose: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return <PermissionPolicySheet {...props} client={connected ? client : null} />;
}
