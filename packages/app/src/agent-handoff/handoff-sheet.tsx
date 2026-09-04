import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, SelectFieldTrigger } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useAgentProfilePicker } from "@/agent-profiles";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { openHandoffForm } from "./form-model";
import { HandoffProfileChoices } from "./profile-choices";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";

const EMPTY_ENTRIES: ProviderSnapshotEntry[] = [];

function useHandoffCatalog(
  form: Pick<ReturnType<typeof openHandoffForm>, "replaceCatalog">,
  entries: ProviderSnapshotEntry[] | undefined,
  connected: boolean,
) {
  useEffect(
    () => form.replaceCatalog(entries ?? EMPTY_ENTRIES, connected),
    [entries, connected, form],
  );
}

export function AgentHandoffSheet({
  serverId,
  agentId,
  cwd,
  onClose,
}: {
  serverId: string;
  agentId: string;
  cwd: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  const catalog = useProvidersSnapshot(serverId, { cwd });
  const controlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [form] = useState(() =>
    openHandoffForm(async (selection, briefing) => {
      const session = useSessionStore.getState().sessions[serverId];
      if (!session?.client) throw new Error(t("common.errors.daemonClientDisconnected"));
      return session.client.handoffAgent({
        sourceAgentId: agentId,
        provider: selection.provider,
        model: selection.modelId || undefined,
        modeId: selection.modeId || undefined,
        thinkingOptionId: selection.thinkingOptionId || undefined,
        featureValues: selection.featureValues,
        briefing: briefing.trim() || undefined,
      });
    }),
  );
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  useHandoffCatalog(form, catalog.entries, connected && Boolean(client));
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(state.entries),
    [state.entries],
  );
  const availableProviders = useMemo(() => providers.map((provider) => provider.id), [providers]);
  const profileTarget = useMemo(
    () => ({ kind: "draft" as const, controls: { applyProfile: form.applyProfile } }),
    [form],
  );
  const profiles = useAgentProfilePicker({ serverId, availableProviders, target: profileTarget });
  const [customExpanded, setCustomExpanded] = useState(false);
  const hasProfiles = Boolean(profiles?.rows.length);
  const showCustom = customExpanded || !hasProfiles;
  const customAccessibilityState = useMemo(() => ({ expanded: showCustom }), [showCustom]);
  const toggleCustom = useCallback(() => setCustomExpanded((current) => !current), []);
  const selectionSummary = useMemo(() => {
    const selection = state.selection;
    if (!selection.provider) return "";
    const provider = state.entries.find((entry) => entry.provider === selection.provider);
    const model = provider?.models?.find((entry) => entry.id === selection.modelId);
    const mode = state.modes.find((entry) => entry.id === selection.modeId);
    return [
      provider?.label ?? selection.provider,
      model?.label ?? selection.modelId,
      mode?.label ?? selection.modeId,
      selection.thinkingOptionId
        ? formatThinkingOptionLabel({ id: selection.thinkingOptionId })
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }, [state.selection, state.entries, state.modes]);
  const modeOptions = useMemo(
    () => [
      { id: "", value: "", label: t("agentHandoff.defaultMode") },
      ...state.modes.map((mode) => ({
        id: mode.id,
        value: mode.id,
        label: mode.label,
        description: mode.description,
      })),
    ],
    [state.modes, t],
  );
  const submit = useCallback(async () => {
    const agent = await form.submit();
    if (!agent?.workspaceId) return;
    onClose();
    navigateToWorkspace({
      serverId,
      workspaceId: agent.workspaceId,
      target: { kind: "agent", agentId: agent.id },
    });
  }, [form, onClose, serverId]);
  const close = useCallback(() => {
    if (!state.pending) onClose();
  }, [onClose, state.pending]);
  const header = useMemo(
    () => ({
      title: t("agentHandoff.action"),
      subtitle: <Text style={styles.text}>{t("agentHandoff.description")}</Text>,
    }),
    [t],
  );
  const footer = useMemo(
    () => (
      <Button onPress={submit} disabled={!state.canSubmit} testID="agent-handoff-submit">
        {state.pending ? t("common.states.starting") : t("agentHandoff.continue")}
      </Button>
    ),
    [submit, state.canSubmit, state.pending, t],
  );
  const renderTrigger = useCallback<
    NonNullable<ComponentProps<typeof CombinedModelSelector>["renderTrigger"]>
  >(
    ({ selectedModelLabel, disabled, isOpen, hovered, pressed }) => (
      <SelectFieldTrigger
        placeholder={t("agentHandoff.model")}
        label={state.selection.provider ? selectedModelLabel : undefined}
        disabled={disabled}
        active={pressed}
        focused={isOpen}
        hovered={hovered}
        size={controlSize}
        testID="agent-handoff-model"
      />
    ),
    [controlSize, state.selection.provider, t],
  );
  const refresh = catalog.refresh;
  const retryProvider = useCallback(
    (provider: string) => {
      void refresh([provider]);
    },
    [refresh],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      header={header}
      testID="agent-handoff-sheet"
      desktopMaxWidth={520}
      footer={footer}
      sizeContentToCurrentSnapPoint
    >
      <View style={styles.form}>
        {profiles ? (
          <HandoffProfileChoices profiles={profiles} disabled={state.pending || !connected} />
        ) : null}
        {hasProfiles ? (
          <View style={styles.customSection}>
            {selectionSummary && !showCustom ? (
              <Text style={styles.text} testID="agent-handoff-selection">
                {selectionSummary}
              </Text>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              leftIcon={customExpanded ? ChevronUp : ChevronDown}
              onPress={toggleCustom}
              disabled={state.pending}
              accessibilityState={customAccessibilityState}
              testID="agent-handoff-custom"
            >
              {t("agentHandoff.custom")}
            </Button>
          </View>
        ) : null}
        {showCustom ? (
          <>
            <Field label={t("agentHandoff.model")}>
              <CombinedModelSelector
                providers={providers}
                selectedProvider={state.selection.provider}
                selectedModel={state.selection.modelId}
                onSelect={form.selectModel}
                isLoading={catalog.isLoading}
                disabled={state.pending || !connected}
                serverId={serverId}
                triggerFill
                renderTrigger={renderTrigger}
                onRetryProvider={retryProvider}
                isRetryingProvider={catalog.isRefreshing}
              />
            </Field>
            <SelectField
              label={t("agentHandoff.mode")}
              value={state.selection.modeId}
              selectedDisplay={
                modeOptions.find((option) => option.id === state.selection.modeId) ?? null
              }
              options={modeOptions}
              onChange={form.selectMode}
              placeholder={t("agentHandoff.defaultMode")}
              emptyText={t("common.empty.noResults")}
              disabled={state.pending || !state.selection.provider}
              size={controlSize}
              triggerTestID="agent-handoff-mode"
            />
            {state.selection.thinkingOptionId ? (
              <Text style={styles.text}>
                {t("agentHandoff.thinking", { value: state.selection.thinkingOptionId })}
              </Text>
            ) : null}
          </>
        ) : null}
        <Field label={t("agentHandoff.briefing")}>
          <FormTextInput
            multiline
            maxLength={24000}
            initialValue={state.briefing}
            onChangeText={form.setBriefing}
            editable={!state.pending}
            size={controlSize}
            testID="agent-handoff-briefing"
          />
        </Field>
        {!connected ? (
          <Text style={styles.error}>{t("common.errors.daemonClientDisconnected")}</Text>
        ) : null}
        {state.error || catalog.error ? (
          <Text style={styles.error} testID="agent-handoff-error">
            {state.error ?? catalog.error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[4] },
  customSection: { alignItems: "flex-start", gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
