import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { View, Text } from "react-native";
import { NotebookPen } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { usePaneContext } from "@/panels/pane-context";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { definePanel } from "@/panels/panel-registry";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openMemoryEditor, type MemoryTarget } from "./model";

const MemoryIcon = withUnistyles(NotebookPen);
function useMemoryEditor(serverId: string, target: MemoryTarget) {
  const [model] = useState(() => openMemoryEditor(target));
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  useEffect(() => {
    model.setClient(connected ? client : null);
  }, [client, connected, model]);
  useEffect(() => () => model.close(), [model]);
  return model;
}
function MemoryEditor({ serverId, target }: { serverId: string; target: MemoryTarget }) {
  const model = useMemoryEditor(serverId, target);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  usePublishPanelInstanceAttributes({ modified: state.dirty });
  const reload = useCallback(async () => {
    if (
      model.getState().dirty &&
      !(await confirmDialog({
        title: "Discard memory edits?",
        message: "Reload the latest saved memory and discard your unsaved edits.",
        confirmLabel: "Discard and reload",
        destructive: true,
      }))
    )
      return;
    await model.reload();
  }, [model]);
  const loadingLabel =
    state.load.status === "connecting" ? "Connecting to host…" : "Loading personal memory…";
  if (state.load.status !== "loaded")
    return (
      <View style={styles.empty}>
        <Text style={styles.muted}>
          {state.load.status === "error" ? state.load.error : loadingLabel}
        </Text>
        {state.load.status === "error" ? (
          <Button variant="ghost" onPress={reload}>
            Retry
          </Button>
        ) : null}
      </View>
    );
  return (
    <View style={styles.root} testID="coordinator-memory-pane">
      <View style={styles.toolbar}>
        <Text style={styles.path} selectable testID="coordinator-memory-path">
          {state.load.snapshot.filePath}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={reload}
          disabled={!state.connected || state.saving}
          testID="coordinator-memory-reload"
        >
          Reload
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={model.save}
          loading={state.saving}
          disabled={!state.connected || !state.dirty}
          testID="coordinator-memory-save"
        >
          Save
        </Button>
      </View>
      {!state.connected ? (
        <Text style={styles.muted}>Host disconnected. Your edits are kept here.</Text>
      ) : null}
      {state.error ? (
        <Text style={styles.error} testID="coordinator-memory-error">
          {state.error}
        </Text>
      ) : null}
      <EditingTextInput
        key={state.editorVersion}
        initialValue={state.text}
        onChangeText={model.edit}
        multiline
        editable={!state.saving}
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.editor}
        accessibilityLabel="Personal memory"
        testID="coordinator-memory-editor"
      />
    </View>
  );
}
function CoordinatorMemoryPanel() {
  const { serverId, target } = usePaneContext();
  invariant(
    target.kind === "coordinator_memory",
    "CoordinatorMemoryPanel requires coordinator_memory target",
  );
  const identity = target.scope === "personal" ? "personal" : target.projectId;
  return <MemoryEditor key={`${serverId}:${identity}`} serverId={serverId} target={target} />;
}
export const coordinatorMemoryPanelRegistration = definePanel("coordinator_memory", {
  component: CoordinatorMemoryPanel,
  presentation: {
    label: () => "Personal memory",
    subtitle: () => "Coordinator",
    tooltip: () => "Personal memory",
    icon: MemoryIcon,
  },
});
const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, padding: theme.spacing[4], gap: theme.spacing[3] },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[3] },
  toolbar: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  path: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  editor: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    padding: theme.spacing[2],
  },
}));
