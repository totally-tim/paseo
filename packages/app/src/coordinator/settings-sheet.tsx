import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import {
  COORDINATOR_ELIGIBLE_PROVIDERS,
  CoordinatorRoleProfileField,
  type CoordinatorRoleSelection,
} from "./setup-row";
import { useCoordinatorProjectStore } from "./project-store";
import {
  openCoordinatorSettings,
  type CoordinatorRotationSettings,
  type CoordinatorRotationUpdate,
} from "./settings-model";
const HEADER = { title: "Coordinator settings" };
interface SettingsProps {
  serverId: string;
  projectId?: string;
  visible: boolean;
  onClose: () => void;
}
export function CoordinatorSettingsSheet(props: SettingsProps) {
  if (!props.visible) return null;
  return <OpenSettingsSheet key={`${props.serverId}:${props.projectId ?? "global"}`} {...props} />;
}
function useSettingsSnapshot(serverId: string, projectId?: string) {
  const client = useHostRuntimeClient(serverId);
  const [snapshot, setSnapshot] = useState<CoordinatorRotationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!client) return;
    let disposed = false;
    setError(null);
    const request = projectId
      ? client.getProjectCoordinator(projectId).then((result) => result.coordinator)
      : client.getGlobalCoordinator();
    void request
      .then((value) => {
        if (!disposed) {
          if (value) setSnapshot(value);
          else setError("Coordinator is unavailable.");
        }
        return undefined;
      })
      .catch(() => {
        if (!disposed) setError("Couldn't load coordinator settings. Try again.");
      });
    return () => {
      disposed = true;
    };
  }, [client, projectId, retry]);
  const reload = useCallback(() => setRetry((value) => value + 1), []);
  const save = useCallback(
    async (settings: CoordinatorRotationUpdate) => {
      if (!client) throw new Error("Host disconnected");
      if (projectId) {
        const result = await client.updateProjectCoordinator({ projectId, ...settings });
        useCoordinatorProjectStore.getState().applyProjectResult(serverId, projectId, result);
      } else await client.updateGlobalCoordinator(settings);
    },
    [client, projectId, serverId],
  );
  const disable = useCallback(async () => {
    if (!client || !projectId) throw new Error("Project coordinator is unavailable.");
    const result = await client.disableProjectCoordinator(projectId);
    useCoordinatorProjectStore.getState().applyProjectResult(serverId, projectId, result);
  }, [client, projectId, serverId]);
  return { snapshot, error, reload, save, disable };
}
function OpenSettingsSheet({ serverId, projectId, onClose }: SettingsProps) {
  const { snapshot, error, reload, save, disable } = useSettingsSnapshot(serverId, projectId);
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={HEADER}
      testID="coordinator-settings-sheet"
    >
      {snapshot ? (
        <SettingsForm
          snapshot={snapshot}
          serverId={serverId}
          onClose={onClose}
          onSave={save}
          onDisable={projectId ? disable : undefined}
        />
      ) : (
        <View style={styles.content}>
          <Text style={styles.muted}>{error ?? "Loading coordinator settings…"}</Text>
          {error ? (
            <Button variant="ghost" onPress={reload}>
              Retry
            </Button>
          ) : null}
        </View>
      )}
    </AdaptiveModalSheet>
  );
}
function useSettingsForm(snapshot: CoordinatorRotationSettings) {
  const [model] = useState(() => openCoordinatorSettings(snapshot));
  useEffect(() => () => model.close(), [model]);
  return model;
}
function SettingsForm({
  snapshot,
  serverId,
  onClose,
  onSave,
  onDisable,
}: {
  snapshot: CoordinatorRotationSettings;
  serverId: string;
  onClose: () => void;
  onSave: (settings: CoordinatorRotationUpdate) => Promise<void>;
  onDisable?: () => Promise<void>;
}) {
  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const disable = useCallback(async () => {
    if (!onDisable) return;
    setDisabling(true);
    setDisableError(null);
    try {
      await onDisable();
      onClose();
    } catch (error) {
      setDisableError(error instanceof Error ? error.message : String(error));
    } finally {
      setDisabling(false);
    }
  }, [onDisable, onClose]);
  const model = useSettingsForm(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const profiles = useProvidersSnapshot(serverId, { cwd: null });
  const providers = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(
        profiles.entries?.filter((entry) =>
          COORDINATOR_ELIGIBLE_PROVIDERS.includes(entry.provider),
        ),
      ),
    [profiles.entries],
  );
  const selection = useMemo<CoordinatorRoleSelection | null>(
    () =>
      state.fallbackProfile
        ? { provider: state.fallbackProfile.provider, modelId: state.fallbackProfile.model ?? "" }
        : null,
    [state.fallbackProfile],
  );
  const refresh = profiles.refresh;
  const retryProvider = useCallback(
    (provider: CoordinatorRoleSelection["provider"]) => {
      void refresh([provider]);
    },
    [refresh],
  );
  const clearFallback = useCallback(() => model.setFallback(null), [model]);
  const save = useCallback(async () => {
    if (await model.submit(onSave)) onClose();
  }, [model, onSave, onClose]);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  return (
    <View style={styles.content}>
      {onDisable ? (
        <Button
          variant="destructive"
          size="sm"
          onPress={disable}
          disabled={state.saving || disabling}
          testID="coordinator-disable-project"
        >
          {disabling ? "Disabling…" : "Disable coordinator"}
        </Button>
      ) : null}
      {disableError ? (
        <Text style={styles.error} accessibilityRole="alert" testID="coordinator-disable-error">
          {disableError}
        </Text>
      ) : null}
      <CoordinatorRoleProfileField
        label="Coordinator fallback profile"
        selection={selection}
        fallbackProvider={null}
        providers={providers}
        isLoading={profiles.isLoading}
        isRefreshing={profiles.isRefreshing}
        disabled={state.saving || disabling}
        serverId={serverId}
        testID="coordinator-fallback-profile"
        onSelect={model.setFallback}
        onRetryProvider={retryProvider}
      />
      {state.fallbackProfile ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={clearFallback}
          disabled={state.saving || disabling}
          testID="coordinator-clear-fallback"
        >
          Remove fallback
        </Button>
      ) : null}
      <Field label="Rotate at context usage (%)">
        <FormTextInput
          size={size}
          initialValue={state.threshold}
          onChangeText={model.setThreshold}
          keyboardType="number-pad"
          editable={!state.saving && !disabling}
          testID="coordinator-rotation-threshold"
          accessibilityLabel="Rotation threshold percent"
        />
      </Field>
      {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
      <Button
        variant="default"
        loading={state.saving}
        disabled={disabling}
        onPress={save}
        testID="coordinator-settings-save"
      >
        Save
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
