import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CoordinatorBoardSnapshot,
  CoordinatorDoneBoardRow,
  CoordinatorWorkingBoardRow,
} from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { ScrollView } from "@/components/ui/scroll-view";
import type { PendingPermission } from "@/types/shared";
import { formatCompactTimeAgo, formatDuration } from "@/utils/time";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  buildBoardActionResponse,
  resolveDecisionPermission,
  type BoardAction,
} from "@/coordinator/decisions";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import {
  DecisionPeekSheet,
  DecisionRow,
  IDLE_DECISION_STATE,
  StatusDot,
  type DecisionResponseState,
} from "./decision-row";

/** Done is capped server-side; the column renders at most this many rows. */
const DONE_ROW_LIMIT = 5;
const RESPOND_TIMEOUT_MS = 15_000;

export interface CoordinatorBoardHandlers {
  /** Opens the coordinator session's ordinary agent tab. */
  onOpenChat: () => void;
  /** Opens an agent tab for a working/done row's session. */
  onOpenAgent: (agentId: string) => void;
  /** Opens a done row's file link inside the workspace. */
  onOpenFile: (request: WorkspaceFileOpenRequest) => void;
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function rowPressable({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.rowPress, (hovered || pressed) && styles.rowPressActive];
}

function SectionLabel({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionLabel}>{title}</Text>
    </View>
  );
}

function WorkingRow({
  row,
  now,
  onOpenAgent,
}: {
  row: CoordinatorWorkingBoardRow;
  now: number;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpenAgent(row.agentId), [onOpenAgent, row.agentId]);
  const elapsed = formatDuration(Math.max(0, now - new Date(row.startedAt).getTime()));
  const meta = [elapsed, row.provider].filter(Boolean).join(" · ");
  const title = row.yours ? t("coordinator.board.yoursGoal", { goal: row.goal }) : row.goal;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      style={rowPressable}
      testID={`coordinator-working-${row.id}`}
    >
      <StatusDot bucket="running" />
      <View style={styles.rowTextColumn}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {title}
        </Text>
        {meta ? (
          <Text numberOfLines={1} style={styles.rowMeta}>
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function doneLinkLabel(
  link: CoordinatorDoneBoardRow["link"],
  t: (key: string) => string,
): string | null {
  if (!link) return null;
  if (link.url) {
    try {
      const url = new URL(link.url);
      return url.pathname.split("/").findLast(Boolean) ?? url.hostname;
    } catch {
      return link.url;
    }
  }
  if (link.agentId) return t("coordinator.board.linkSession");
  if (link.filePath) {
    return link.filePath.split("/").findLast(Boolean) ?? link.filePath;
  }
  return null;
}

function DoneRow({
  row,
  now,
  onOpenAgent,
  onOpenFile,
}: {
  row: CoordinatorDoneBoardRow;
  now: number;
  onOpenAgent: (agentId: string) => void;
  onOpenFile: (request: WorkspaceFileOpenRequest) => void;
}) {
  const { t } = useTranslation();
  const at = formatCompactTimeAgo(new Date(row.at), new Date(now));
  const link = row.link;
  const linkLabel = useMemo(() => doneLinkLabel(link, t), [link, t]);

  const handleLinkPress = useCallback(() => {
    if (!link) return;
    if (link.url) {
      void openExternalUrl(link.url).catch(() => {});
      return;
    }
    if (link.agentId) {
      onOpenAgent(link.agentId);
      return;
    }
    if (link.filePath) {
      onOpenFile({ location: { path: link.filePath }, disposition: "preferred" });
    }
  }, [link, onOpenAgent, onOpenFile]);

  return (
    <View style={styles.rowPress} testID={`coordinator-done-${row.id}`}>
      <StatusDot bucket="done" />
      <View style={styles.rowTextColumn}>
        <Text numberOfLines={2} style={styles.rowTitle}>
          {row.text}
        </Text>
        <View style={styles.rowMetaLine}>
          <Text numberOfLines={1} style={styles.rowMeta}>
            {at}
          </Text>
          {linkLabel ? (
            <>
              <Text style={styles.rowMeta}>{" · "}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={handleLinkPress}
                testID={`coordinator-done-${row.id}-link`}
              >
                <Text style={styles.rowLink}>{linkLabel}</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * The project board: Needs-you strip, Working and Done sections, the wake
 * line, the reply area and the composer. Everything is a row; the board never
 * spawns work — milestone 1 is observe-only.
 */
export const CoordinatorBoard = memo(function CoordinatorBoard({
  board,
  client,
  pendingPermissions,
  agentTitleForId,
  compact,
  handlers,
  reply,
  children,
}: {
  board: CoordinatorBoardSnapshot;
  client: DaemonClient | null;
  pendingPermissions: ReadonlyMap<string, PendingPermission>;
  agentTitleForId: (agentId: string) => string | null;
  compact: boolean;
  handlers: CoordinatorBoardHandlers;
  /** The coordinator's latest reply, rendered above the composer. */
  reply: string | null;
  /** The docked composer element. */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [peekRowId, setPeekRowId] = useState<string | null>(null);
  const [decisionStates, setDecisionStates] = useState<Record<string, DecisionResponseState>>({});

  const decisionRows = board.needsYou;
  const doneRows = useMemo(() => board.done.slice(0, DONE_ROW_LIMIT), [board.done]);
  const hasDecisions = decisionRows.length > 0;

  const respondToDecision = useCallback(
    async (rowId: string, action: BoardAction) => {
      const row = decisionRows.find((entry) => entry.id === rowId);
      if (!row) {
        return;
      }
      if (!client) {
        setDecisionStates((current) => ({
          ...current,
          [rowId]: { pendingActionId: null, error: t("workspace.terminal.hostDisconnected") },
        }));
        return;
      }
      setDecisionStates((current) => ({
        ...current,
        [rowId]: { pendingActionId: action.id, error: null },
      }));
      try {
        await client.respondToPermissionAndWait(
          row.agentId,
          row.requestId,
          buildBoardActionResponse(action),
          RESPOND_TIMEOUT_MS,
        );
        // The daemon's board change removes the row; the pending flag stays so
        // the buttons can't be pressed twice in the gap.
      } catch (error) {
        setDecisionStates((current) => ({
          ...current,
          [rowId]: {
            pendingActionId: null,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [client, decisionRows, t],
  );

  const peekRow = useMemo(
    () => decisionRows.find((row) => row.id === peekRowId) ?? null,
    [decisionRows, peekRowId],
  );
  const closePeek = useCallback(() => setPeekRowId(null), []);
  const toggleDoneExpanded = useCallback(() => setDoneExpanded((value) => !value), []);
  const respondToPeekAction = useCallback(
    (action: BoardAction) => {
      if (peekRow) {
        void respondToDecision(peekRow.id, action);
      }
    },
    [peekRow, respondToDecision],
  );

  const needsYouSection = hasDecisions ? (
    <View style={styles.section} testID="coordinator-section-needs-you">
      <SectionLabel title={t("coordinator.board.needsYou")} />
      {decisionRows.map((row) => (
        <DecisionRow
          key={row.id}
          row={row}
          agentTitle={agentTitleForId(row.agentId)}
          permission={resolveDecisionPermission(pendingPermissions, row)}
          state={decisionStates[row.id] ?? IDLE_DECISION_STATE}
          now={now}
          compact={compact}
          onRespond={respondToDecision}
          onPeek={setPeekRowId}
        />
      ))}
    </View>
  ) : null;

  const workingSection = (
    <View style={styles.section} testID="coordinator-section-working">
      <SectionLabel title={t("coordinator.board.working")} />
      {board.wake ? (
        <Text numberOfLines={2} style={styles.wakeLine} testID="coordinator-wake">
          {board.wake.text}
        </Text>
      ) : null}
      {board.working.length === 0 && !board.wake ? (
        <Text style={styles.emptyLine}>{t("coordinator.board.nothingWorking")}</Text>
      ) : (
        board.working.map((row) => (
          <WorkingRow key={row.id} row={row} now={now} onOpenAgent={handlers.onOpenAgent} />
        ))
      )}
    </View>
  );

  const doneBody =
    doneRows.length === 0 ? (
      <Text style={styles.emptyLine}>{t("coordinator.board.nothingDone")}</Text>
    ) : (
      doneRows.map((row) => (
        <DoneRow
          key={row.id}
          row={row}
          now={now}
          onOpenAgent={handlers.onOpenAgent}
          onOpenFile={handlers.onOpenFile}
        />
      ))
    );

  const doneSection = (
    <View style={styles.section} testID="coordinator-section-done">
      {compact ? (
        <Pressable
          accessibilityRole="button"
          onPress={toggleDoneExpanded}
          testID="coordinator-done-toggle"
        >
          <SectionLabel title={t("coordinator.board.doneCount", { count: board.done.length })} />
        </Pressable>
      ) : (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>{t("coordinator.board.done")}</Text>
          {board.coordinatorAgentId ? (
            <Pressable
              accessibilityRole="button"
              onPress={handlers.onOpenChat}
              testID="coordinator-done-chat-link"
            >
              <Text style={styles.sectionLabelLink}>{t("coordinator.board.doneWindow")}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {compact && !doneExpanded ? null : doneBody}
    </View>
  );

  return (
    <View style={styles.root} testID="coordinator-board">
      <View style={styles.headerRow}>
        <Text numberOfLines={1} style={styles.headerTitle}>
          {board.projectName ?? t("coordinator.board.title")}
        </Text>
        {board.coordinatorAgentId ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={handlers.onOpenChat}
            testID="coordinator-chat-button"
          >
            {t("coordinator.board.chat")}
          </Button>
        ) : null}
      </View>

      {compact ? (
        <ScrollView style={styles.boardScroll} contentContainerStyle={styles.boardScrollContent}>
          {needsYouSection}
          {workingSection}
          {doneSection}
        </ScrollView>
      ) : (
        <View style={styles.boardColumnsWrap}>
          {needsYouSection}
          <View style={styles.boardColumns}>
            <ScrollView
              style={styles.boardColumn}
              contentContainerStyle={styles.boardColumnContent}
            >
              {workingSection}
            </ScrollView>
            <ScrollView
              style={styles.boardColumn}
              contentContainerStyle={styles.boardColumnContent}
            >
              {doneSection}
            </ScrollView>
          </View>
        </View>
      )}

      {reply ? (
        <View style={styles.replyArea} testID="coordinator-reply">
          <Text numberOfLines={2} style={styles.replyText}>
            {reply}
          </Text>
        </View>
      ) : null}
      {children}

      <DecisionPeekSheet
        row={peekRow}
        agentTitle={peekRow ? agentTitleForId(peekRow.agentId) : null}
        permission={peekRow ? resolveDecisionPermission(pendingPermissions, peekRow) : null}
        state={peekRow ? (decisionStates[peekRow.id] ?? IDLE_DECISION_STATE) : IDLE_DECISION_STATE}
        now={now}
        onRespond={respondToPeekAction}
        onClose={closePeek}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  boardScroll: {
    flex: 1,
  },
  boardScrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[4],
  },
  boardColumnsWrap: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[4],
  },
  boardColumns: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[6],
  },
  boardColumn: {
    flex: 1,
    minWidth: 0,
  },
  boardColumnContent: {
    paddingBottom: theme.spacing[4],
  },
  section: {
    gap: theme.spacing[1],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: theme.spacing[1],
  },
  sectionLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  sectionLabelLink: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  wakeLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[1],
  },
  emptyLine: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[1],
  },
  rowPress: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    minHeight: 36,
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rowPressActive: {
    opacity: 0.8,
  },
  rowTextColumn: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowMetaLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
  },
  rowLink: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textDecorationLine: "underline",
  },
  replyArea: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  replyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
