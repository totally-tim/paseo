import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { CoordinatorProfiles } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { Theme } from "@/styles/theme";
import { useCoordinatorBoardSnapshot } from "@/coordinator/board-store";
import {
  refreshProjectCoordinator,
  useCoordinatorProjectStore,
  useProjectCoordinatorRecord,
} from "@/coordinator/project-store";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);

function ProviderIconView({
  Icon,
  size,
  color,
}: {
  Icon: ProviderIconComponent;
  size: number;
  color: string;
}) {
  return <Icon size={size} color={color} />;
}
const ThemedProviderIcon = withUnistyles(ProviderIconView);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * Milestone 1 coordinator providers. Copilot and Pi are intentionally absent —
 * they have no delegate-only restriction, so a coordinator session on them
 * could not be contained.
 */
export const COORDINATOR_ELIGIBLE_PROVIDERS: readonly AgentProvider[] = [
  "claude",
  "codex",
  "opencode",
];

const FALLBACK_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

function rowPressable({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.row, (hovered || pressed) && styles.rowActive];
}

function providerOptionStyle({
  pressed,
  hovered,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.providerOption, (hovered || pressed) && styles.providerOptionActive];
}

interface CoordinatorProviderRow {
  provider: AgentProvider;
  label: string;
  enabled: boolean;
}

/**
 * A delegate role's launch selections: provider plus an optional model.
 * `null` in state means the user never touched the role; the daemon then
 * launches it with the coordinator's own provider.
 */
interface CoordinatorRoleSelection {
  provider: AgentProvider;
  modelId: string;
}

const COORDINATOR_ROLE_KEYS = ["investigator", "implementer"] as const;
type CoordinatorRoleKey = (typeof COORDINATOR_ROLE_KEYS)[number];

function CoordinatorRoleProfileField({
  label,
  selection,
  fallbackProvider,
  providers,
  isLoading,
  isRefreshing,
  disabled,
  serverId,
  testID,
  onSelect,
  onRetryProvider,
}: {
  label: string;
  selection: CoordinatorRoleSelection | null;
  fallbackProvider: AgentProvider | null;
  providers: ComponentProps<typeof CombinedModelSelector>["providers"];
  isLoading: boolean;
  isRefreshing: boolean;
  disabled: boolean;
  serverId: string;
  testID: string;
  onSelect: (selection: CoordinatorRoleSelection) => void;
  onRetryProvider: (provider: AgentProvider) => void;
}) {
  const handleSelect = useCallback(
    (provider: AgentProvider, modelId: string) => onSelect({ provider, modelId }),
    [onSelect],
  );
  const renderTrigger = useCallback<
    NonNullable<ComponentProps<typeof CombinedModelSelector>["renderTrigger"]>
  >(
    ({ selectedModelLabel, disabled: triggerDisabled, isOpen, hovered, pressed }) => (
      <SelectFieldTrigger
        placeholder={label}
        label={selectedModelLabel}
        disabled={triggerDisabled}
        active={pressed}
        focused={isOpen}
        hovered={hovered}
        testID={testID}
      />
    ),
    [label, testID],
  );
  return (
    <Field label={label}>
      <CombinedModelSelector
        providers={providers}
        selectedProvider={selection?.provider ?? fallbackProvider ?? ""}
        selectedModel={selection?.modelId ?? ""}
        onSelect={handleSelect}
        isLoading={isLoading}
        disabled={disabled}
        serverId={serverId}
        triggerFill
        renderTrigger={renderTrigger}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRefreshing}
      />
    </Field>
  );
}

function CoordinatorProviderOption({
  row,
  serverId,
  selected,
  disabled,
  onSelect,
}: {
  row: CoordinatorProviderRow;
  serverId: string;
  selected: boolean;
  disabled: boolean;
  onSelect: (provider: AgentProvider) => void;
}) {
  const handlePress = useCallback(() => onSelect(row.provider), [onSelect, row.provider]);
  const ProviderIcon = getProviderIcon(row.provider, serverId);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={handlePress}
      style={providerOptionStyle}
      testID={`coordinator-enable-provider-${row.provider}`}
    >
      <ThemedProviderIcon
        Icon={ProviderIcon}
        size={18}
        uniProps={row.enabled ? foregroundColorMapping : mutedColorMapping}
      />
      <Text style={[styles.providerLabel, !row.enabled && styles.providerLabelDisabled]}>
        {row.label}
      </Text>
      {selected ? <ThemedCheck size={16} uniProps={foregroundColorMapping} /> : null}
    </Pressable>
  );
}

export function CoordinatorEnableSheet({
  visible,
  projectId,
  serverId,
  cwd,
  onClose,
}: {
  visible: boolean;
  projectId: string;
  serverId: string;
  cwd: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const snapshot = useProvidersSnapshot(serverId, { cwd });
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider | null>(null);
  const [roleSelections, setRoleSelections] = useState<
    Record<CoordinatorRoleKey, CoordinatorRoleSelection | null>
  >({ investigator: null, implementer: null });
  const [isEnabling, setIsEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const record = useProjectCoordinatorRecord(serverId, projectId);
  // The goal engine is a later milestone; until then the affordance queues a
  // composer draft for the coordinator session that enable creates.
  const [ciSeedQueued, setCiSeedQueued] = useState(false);

  useEffect(() => {
    if (visible) {
      setCiSeedQueued(false);
      void refreshProjectCoordinator(serverId, projectId);
    }
  }, [visible, serverId, projectId]);

  const providerRows = useMemo<CoordinatorProviderRow[]>(
    () =>
      COORDINATOR_ELIGIBLE_PROVIDERS.map((provider) => {
        const entry = snapshot.entries?.find((candidate) => candidate.provider === provider);
        return {
          provider,
          label: entry?.label ?? FALLBACK_PROVIDER_LABELS[provider] ?? provider,
          // No snapshot answer yet means the row stays enabled; the daemon
          // rejects an unavailable provider with an error either way.
          enabled: entry ? entry.enabled && entry.status === "ready" : true,
        };
      }),
    [snapshot.entries],
  );

  const effectiveSelection = useMemo(() => {
    if (selectedProvider && providerRows.some((row) => row.provider === selectedProvider)) {
      return selectedProvider;
    }
    return providerRows.find((row) => row.enabled)?.provider ?? null;
  }, [providerRows, selectedProvider]);

  // Delegates launch as ordinary sessions, so their pickers offer every
  // enabled provider, not just the coordinator-eligible ones.
  const delegateSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );

  const handleEnable = useCallback(async () => {
    if (!client || !effectiveSelection) {
      return;
    }
    const profiles: CoordinatorProfiles = {};
    for (const role of COORDINATOR_ROLE_KEYS) {
      const selection = roleSelections[role];
      if (selection) {
        profiles[role] = {
          provider: selection.provider,
          ...(selection.modelId ? { model: selection.modelId } : {}),
        };
      }
    }
    setError(null);
    setIsEnabling(true);
    try {
      const result = await client.enableProjectCoordinator({
        projectId,
        profile: { provider: effectiveSelection },
        ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
      });
      useCoordinatorProjectStore.getState().applyProjectResult(serverId, projectId, result);
      // The board composer only exists once the session does — the draft key it
      // reads is the session's own, so the queued ask lands there directly.
      const coordinatorAgentId = result.coordinator?.agentId;
      if (ciSeedQueued && coordinatorAgentId) {
        useDraftStore.getState().saveDraftInput({
          draftKey: buildDraftStoreKey({ serverId, agentId: coordinatorAgentId }),
          draft: { text: t("coordinator.setup.ciComposerSeed"), attachments: [] },
        });
      }
      onClose();
    } catch (enableError) {
      setError(enableError instanceof Error ? enableError.message : String(enableError));
    } finally {
      setIsEnabling(false);
    }
  }, [ciSeedQueued, client, effectiveSelection, onClose, projectId, roleSelections, serverId, t]);

  const selectInvestigator = useCallback((selection: CoordinatorRoleSelection) => {
    setRoleSelections((current) => ({ ...current, investigator: selection }));
  }, []);
  const selectImplementer = useCallback((selection: CoordinatorRoleSelection) => {
    setRoleSelections((current) => ({ ...current, implementer: selection }));
  }, []);

  const refreshSnapshot = snapshot.refresh;
  const retryProvider = useCallback(
    (provider: AgentProvider) => {
      void refreshSnapshot([provider]);
    },
    [refreshSnapshot],
  );

  const handleEnablePress = useCallback(() => {
    void handleEnable();
  }, [handleEnable]);

  const queueCiSeed = useCallback(() => setCiSeedQueued(true), []);

  const header = useMemo(() => ({ title: t("coordinator.setup.title") }), [t]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="coordinator-enable-sheet"
    >
      <View style={styles.sheetBody}>
        <Text style={styles.sheetHint}>{t("coordinator.setup.providerHint")}</Text>
        <View style={styles.providerList}>
          {providerRows.map((row) => (
            <CoordinatorProviderOption
              key={row.provider}
              row={row}
              serverId={serverId}
              selected={row.provider === effectiveSelection}
              disabled={!row.enabled || isEnabling}
              onSelect={setSelectedProvider}
            />
          ))}
        </View>
        <Text style={styles.sheetHint}>{t("coordinator.setup.profilesHint")}</Text>
        <CoordinatorRoleProfileField
          label={t("coordinator.setup.investigatorProfile")}
          selection={roleSelections.investigator}
          fallbackProvider={effectiveSelection}
          providers={delegateSelectorProviders}
          isLoading={snapshot.isLoading}
          isRefreshing={snapshot.isRefreshing}
          disabled={isEnabling}
          serverId={serverId}
          testID="coordinator-enable-investigator"
          onSelect={selectInvestigator}
          onRetryProvider={retryProvider}
        />
        <CoordinatorRoleProfileField
          label={t("coordinator.setup.implementerProfile")}
          selection={roleSelections.implementer}
          fallbackProvider={effectiveSelection}
          providers={delegateSelectorProviders}
          isLoading={snapshot.isLoading}
          isRefreshing={snapshot.isRefreshing}
          disabled={isEnabling}
          serverId={serverId}
          testID="coordinator-enable-implementer"
          onSelect={selectImplementer}
          onRetryProvider={retryProvider}
        />
        {record?.ciConfigured === false ? (
          <View style={styles.ciNote} testID="coordinator-setup-no-ci">
            <Text style={styles.sheetHint}>{t("coordinator.setup.noCi")}</Text>
            {ciSeedQueued ? (
              <View style={styles.ciQueuedRow} testID="coordinator-setup-ci-queued">
                <ThemedCheck size={14} uniProps={mutedColorMapping} />
                <Text style={styles.sheetHint}>{t("coordinator.setup.ciQueued")}</Text>
              </View>
            ) : (
              <View>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isEnabling}
                  onPress={queueCiSeed}
                  testID="coordinator-setup-add-ci"
                >
                  {t("coordinator.setup.addCi")}
                </Button>
              </View>
            )}
          </View>
        ) : null}
        {error ? (
          <Text style={styles.errorText} testID="coordinator-enable-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.sheetActions}>
          <Button
            accessibilityRole="button"
            disabled={!effectiveSelection || !client}
            loading={isEnabling}
            onPress={handleEnablePress}
            testID="coordinator-enable-submit"
          >
            {t("coordinator.setup.enable")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

/**
 * The "Set up a coordinator" chevron row on the no-coordinator draft home.
 * Renders nothing when the host cannot serve coordinators, the workspace has
 * no project, or a coordinator is already enabled for it.
 */
export function CoordinatorSetupRow({
  serverId,
  projectId,
  cwd,
}: {
  serverId: string;
  projectId: string | null;
  cwd: string | null;
}) {
  const { t } = useTranslation();
  const coordinatorSupported = useHostFeature(serverId, "coordinator");
  const board = useCoordinatorBoardSnapshot(serverId, projectId);
  const [sheetVisible, setSheetVisible] = useState(false);
  const openSheet = useCallback(() => setSheetVisible(true), []);
  const closeSheet = useCallback(() => setSheetVisible(false), []);

  if (!coordinatorSupported || !projectId || board?.enabled) {
    return null;
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={openSheet}
        style={rowPressable}
        testID="coordinator-setup-row"
      >
        <Text style={styles.rowLabel}>{t("coordinator.setup.rowLabel")}</Text>
        <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
      </Pressable>
      <CoordinatorEnableSheet
        visible={sheetVisible}
        projectId={projectId}
        serverId={serverId}
        cwd={cwd}
        onClose={closeSheet}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  sheetBody: {
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
  },
  sheetHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  providerList: {
    gap: theme.spacing[1],
  },
  providerOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  providerOptionActive: {
    backgroundColor: theme.colors.surface2,
  },
  providerLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  providerLabelDisabled: {
    color: theme.colors.foregroundExtraMuted,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  sheetActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  ciNote: {
    gap: theme.spacing[2],
  },
  ciQueuedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
