import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import type { Theme } from "@/styles/theme";
import { useCoordinatorBoardSnapshot } from "@/coordinator/board-store";

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
  const [isEnabling, setIsEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleEnable = useCallback(async () => {
    if (!client || !effectiveSelection) {
      return;
    }
    setError(null);
    setIsEnabling(true);
    try {
      await client.enableProjectCoordinator({
        projectId,
        profile: { provider: effectiveSelection },
      });
      onClose();
    } catch (enableError) {
      setError(enableError instanceof Error ? enableError.message : String(enableError));
    } finally {
      setIsEnabling(false);
    }
  }, [client, effectiveSelection, onClose, projectId]);

  const handleEnablePress = useCallback(() => {
    void handleEnable();
  }, [handleEnable]);

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
}));
