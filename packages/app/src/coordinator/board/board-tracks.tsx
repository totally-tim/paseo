import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  CoordinatorScope,
  CoordinatorTrustLevel,
  CoordinatorUsage,
  CoordinatorUsageExpectation,
} from "@getpaseo/protocol/messages";
import { ComposerTrackPill } from "@/composer/tracks";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  refreshProjectCoordinator,
  useCoordinatorProjectStore,
  useProjectCoordinatorRecord,
} from "@/coordinator/project-store";
import { useCoordinatorBoardSnapshot } from "@/coordinator/board-store";

const TRUST_LEVELS: readonly CoordinatorTrustLevel[] = ["observe", "propose", "ship", "autopilot"];

/**
 * The pill mark escalates with the agency the notch grants: grey reads, green
 * proposes, amber ships code, red merges unattended. `running` is deliberately
 * absent — its mark is the spinning ring, and a level is a state, not work.
 */
const TRUST_BUCKET: Record<CoordinatorTrustLevel, SidebarStateBucket> = {
  observe: "done",
  propose: "attention",
  ship: "needs_input",
  autopilot: "failed",
};

function formatUsageCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions < 10 ? Math.round(millions * 10) / 10 : Math.round(millions)}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands < 10 ? Math.round(thousands * 10) / 10 : Math.round(thousands)}k`;
  }
  return Math.round(value).toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One line of this month's actuals against the soft expectation, plus a thin
 * bar in the context meter's idiom. Crossing either counter flips the line to
 * the warning token; nothing pauses — the board row is the consequence.
 */
function CoordinatorUsageMeter({
  usage,
  expectation,
}: {
  usage: CoordinatorUsage;
  expectation: CoordinatorUsageExpectation;
}) {
  const { t } = useTranslation();
  const spawnRatio =
    expectation.monthlySpawns != null && expectation.monthlySpawns > 0
      ? usage.monthlySpawns / expectation.monthlySpawns
      : null;
  const tokenRatio =
    expectation.monthlyTokens != null && expectation.monthlyTokens > 0
      ? usage.monthlyTokens / expectation.monthlyTokens
      : null;
  if (spawnRatio === null && tokenRatio === null) {
    return null;
  }
  const over = (spawnRatio ?? 0) > 1 || (tokenRatio ?? 0) > 1;
  const fill = Math.min(1, Math.max(spawnRatio ?? 0, tokenRatio ?? 0));

  const spawnsText =
    expectation.monthlySpawns != null
      ? t("coordinator.trust.usage.spawnsExpected", {
          used: usage.monthlySpawns,
          expected: expectation.monthlySpawns,
        })
      : t("coordinator.trust.usage.spawns", { count: usage.monthlySpawns });
  const tokensText =
    expectation.monthlyTokens != null
      ? t("coordinator.trust.usage.tokensExpected", {
          used: formatUsageCount(usage.monthlyTokens),
          expected: formatUsageCount(expectation.monthlyTokens),
        })
      : t("coordinator.trust.usage.tokens", {
          used: formatUsageCount(usage.monthlyTokens),
        });

  return (
    <View style={styles.usage} testID="coordinator-usage-meter">
      <Text style={over ? styles.usageTextOver : styles.usageText} testID="coordinator-usage-text">
        {`${spawnsText} · ${tokensText}`}
      </Text>
      <View style={styles.usageTrack}>
        <View
          style={[
            styles.usageFill,
            over && styles.usageFillOver,
            { width: `${Math.round(fill * 100)}%` },
          ]}
          testID="coordinator-usage-fill"
        />
      </View>
    </View>
  );
}

export interface CoordinatorTrustPillProps {
  /** The board snapshot's level — the echoed truth, not the pending selection. */
  trustLevel: CoordinatorTrustLevel;
  usage: CoordinatorUsage | null;
  usageExpectation: CoordinatorUsageExpectation | null;
  onSelectTrust: (level: CoordinatorTrustLevel) => Promise<void> | void;
}

/**
 * The trust notch as a composer track pill. Every level applies on selection
 * except Autopilot: choosing it only arms the notch and reveals the secondary
 * confirm button, so handing a coordinator merge rights takes two taps and
 * never a modal. Stepping back down applies instantly.
 */
export function CoordinatorTrustPill({
  trustLevel,
  usage,
  usageExpectation,
  onSelectTrust,
}: CoordinatorTrustPillProps): ReactElement {
  const { t } = useTranslation();
  const [autopilotArmed, setAutopilotArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (trustLevel === "autopilot") {
      setAutopilotArmed(false);
    }
  }, [trustLevel]);

  const applyLevel = useCallback(
    (level: CoordinatorTrustLevel) => {
      setError(null);
      Promise.resolve(onSelectTrust(level)).catch((updateError) =>
        setError(errorMessage(updateError)),
      );
    },
    [onSelectTrust],
  );

  const handleTrustChange = useCallback(
    (level: CoordinatorTrustLevel) => {
      if (level === "autopilot" && trustLevel !== "autopilot") {
        setAutopilotArmed(true);
        return;
      }
      setAutopilotArmed(false);
      applyLevel(level);
    },
    [applyLevel, trustLevel],
  );

  const confirmAutopilot = useCallback(() => {
    setAutopilotArmed(false);
    applyLevel("autopilot");
  }, [applyLevel]);

  const displayedLevel = autopilotArmed ? "autopilot" : trustLevel;
  const options = TRUST_LEVELS.map((level) => ({
    value: level,
    label: t(`coordinator.trust.levels.${level}`),
    testID: `coordinator-trust-option-${level}`,
  }));

  return (
    <ComposerTrackPill
      testID="coordinator-trust-pill"
      segments={[
        {
          bucket: TRUST_BUCKET[trustLevel],
          text: t(`coordinator.trust.levels.${trustLevel}`),
        },
      ]}
      panelTitle={t("coordinator.trust.title")}
      accessibilityLabel={t("coordinator.trust.accessibility", {
        level: t(`coordinator.trust.levels.${trustLevel}`),
      })}
    >
      <View style={styles.panel}>
        <SegmentedControl
          options={options}
          value={displayedLevel}
          onValueChange={handleTrustChange}
          size="sm"
          testID="coordinator-trust-control"
        />
        <Text style={styles.hint} testID="coordinator-trust-hint">
          {t(`coordinator.trust.hints.${displayedLevel}`)}
        </Text>
        {autopilotArmed ? (
          <View style={styles.confirmRow}>
            <Button
              size="sm"
              variant="secondary"
              onPress={confirmAutopilot}
              testID="coordinator-trust-confirm-autopilot"
            >
              {t("coordinator.trust.allowAutopilot")}
            </Button>
          </View>
        ) : null}
        {usageExpectation && usage ? (
          <CoordinatorUsageMeter usage={usage} expectation={usageExpectation} />
        ) : null}
        {error ? (
          <Text style={styles.errorText} testID="coordinator-trust-error">
            {error}
          </Text>
        ) : null}
      </View>
    </ComposerTrackPill>
  );
}

export interface CoordinatorScopePillProps {
  scope: CoordinatorScope;
  onSelectScope: (scope: CoordinatorScope) => Promise<void> | void;
}

/**
 * The scope notch: "Everything" keeps the user's own sessions inside Working
 * and proposals; "Project only" takes them out. Both apply on selection.
 */
export function CoordinatorScopePill({
  scope,
  onSelectScope,
}: CoordinatorScopePillProps): ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  const handleScopeChange = useCallback(
    (next: CoordinatorScope) => {
      setError(null);
      Promise.resolve(onSelectScope(next)).catch((updateError) =>
        setError(errorMessage(updateError)),
      );
    },
    [onSelectScope],
  );

  const options = (["everything", "project"] as const).map((value) => ({
    value,
    label: t(
      value === "everything" ? "coordinator.scope.everything" : "coordinator.scope.projectOnly",
    ),
    testID: `coordinator-scope-option-${value}`,
  }));

  return (
    <ComposerTrackPill
      testID="coordinator-scope-pill"
      segments={[
        {
          bucket: null,
          text: t(
            scope === "everything"
              ? "coordinator.scope.everything"
              : "coordinator.scope.projectOnly",
          ),
        },
      ]}
      panelTitle={t("coordinator.scope.title")}
      accessibilityLabel={t("coordinator.scope.accessibility", {
        scope: t(
          scope === "everything" ? "coordinator.scope.everything" : "coordinator.scope.projectOnly",
        ),
      })}
    >
      <View style={styles.panel}>
        <SegmentedControl
          options={options}
          value={scope}
          onValueChange={handleScopeChange}
          size="sm"
          testID="coordinator-scope-control"
        />
        <Text style={styles.hint} testID="coordinator-scope-hint">
          {t(
            scope === "everything"
              ? "coordinator.scope.everythingHint"
              : "coordinator.scope.projectOnlyHint",
          )}
        </Text>
        {error ? (
          <Text style={styles.errorText} testID="coordinator-scope-error">
            {error}
          </Text>
        ) : null}
      </View>
    </ComposerTrackPill>
  );
}

/**
 * The pills docked above the board composer. The board snapshot owns trust,
 * scope, and this month's actuals; the `coordinator.project` record — fetched
 * once per project and refreshed by every mutation's response — supplies the
 * usage expectation the snapshot does not carry.
 */
export function CoordinatorBoardTracks({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}): ReactElement | null {
  const client = useHostRuntimeClient(serverId);
  const board = useCoordinatorBoardSnapshot(serverId, projectId);
  const record = useProjectCoordinatorRecord(serverId, projectId);

  useEffect(() => {
    if (board?.enabled && !record) {
      void refreshProjectCoordinator(serverId, projectId);
    }
  }, [board?.enabled, record, serverId, projectId]);

  const applyTrust = useCallback(
    async (trustLevel: CoordinatorTrustLevel) => {
      if (!client) {
        return;
      }
      const result = await client.updateProjectCoordinator({ projectId, trustLevel });
      useCoordinatorProjectStore.getState().applyProjectResult(serverId, projectId, result);
    },
    [client, projectId, serverId],
  );

  const applyScope = useCallback(
    async (scope: CoordinatorScope) => {
      if (!client) {
        return;
      }
      const result = await client.updateProjectCoordinator({ projectId, scope });
      useCoordinatorProjectStore.getState().applyProjectResult(serverId, projectId, result);
    },
    [client, projectId, serverId],
  );

  if (!board?.enabled) {
    return null;
  }

  return (
    <View style={styles.trackRow} testID="coordinator-board-tracks">
      <CoordinatorTrustPill
        trustLevel={board.trustLevel}
        usage={board.usage ?? null}
        usageExpectation={record?.coordinator?.usageExpectation ?? null}
        onSelectTrust={applyTrust}
      />
      <CoordinatorScopePill scope={board.scope} onSelectScope={applyScope} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trackRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  panel: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  confirmRow: {
    flexDirection: "row",
  },
  usage: {
    gap: theme.spacing[1.5],
  },
  usageText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  usageTextOver: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  usageTrack: {
    height: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  usageFill: {
    height: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  usageFillOver: {
    backgroundColor: theme.colors.statusWarning,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
