import { Children, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CoordinatorBoardSnapshot,
  CoordinatorDecisionBoardRow,
  CoordinatorDoneBoardRow,
  CoordinatorWorkingBoardRow,
} from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ScrollView } from "@/components/ui/scroll-view";
import type { PendingPermission } from "@/types/shared";
import { formatCompactTimeAgo, formatDuration } from "@/utils/time";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  performBoardDecisionAction,
  shouldOpenProjectSetup,
  resolveComposerQuoteSource,
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
  onSetupProject?: (row: CoordinatorDecisionBoardRow, action: BoardAction) => void;
  /** Opens an agent tab for a working/done row's session. */
  onOpenAgent: (agentId: string) => void;
  /** Opens a done row's file link inside the workspace. */
  onOpenFile: (request: WorkspaceFileOpenRequest, projectId?: string) => void;
  /**
   * A resolved composerQuote action: the board composer takes the question as a
   * quote and focuses for the free-text correction.
   */
  onComposerQuote: (question: string) => void;
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
  compact,
}: {
  row: CoordinatorWorkingBoardRow;
  compact: boolean;
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
        {meta && !compact ? (
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
  onOpenFile: (request: WorkspaceFileOpenRequest, projectId?: string) => void;
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
      onOpenFile({ location: { path: link.filePath }, disposition: "preferred" }, row.projectId);
    }
  }, [link, onOpenAgent, onOpenFile, row.projectId]);

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

function CompactBoardScroll({
  children,
  hasDecisions,
  doneCount,
  onToggleDone,
}: {
  children: ReactNode;
  hasDecisions: boolean;
  doneCount: number;
  onToggleDone: () => void;
}) {
  const content = Children.toArray(children);
  const needsYou = hasDecisions ? content[0] : null;
  const working = content[hasDecisions ? 1 : 0];
  const done = content[hasDecisions ? 2 : 1];
  const { t } = useTranslation();
  const stickyHeaders = useMemo(() => (needsYou ? [0, 2, 4] : [0, 2]), [needsYou]);
  const sections = [];
  if (needsYou)
    sections.push(
      <View key="needs-header" style={styles.stickyHeader}>
        <SectionLabel title={t("coordinator.board.needsYou")} />
      </View>,
      <View key="needs">{needsYou}</View>,
    );
  sections.push(
    <View key="working-header" style={styles.stickyHeader}>
      <SectionLabel title={t("coordinator.board.working")} />
    </View>,
    <View key="working">{working}</View>,
    <Pressable
      key="done-header"
      style={styles.stickyHeader}
      accessibilityRole="button"
      onPress={onToggleDone}
      testID="coordinator-done-toggle"
    >
      <SectionLabel title={t("coordinator.board.doneCount", { count: doneCount })} />
    </Pressable>,
    <View key="done">{done}</View>,
  );
  return (
    <ScrollView
      style={styles.boardScroll}
      contentContainerStyle={styles.boardScrollContent}
      stickyHeaderIndices={stickyHeaders}
    >
      {sections}
    </ScrollView>
  );
}

function CoordinatorChatAction({
  compact,
  onOpenChat,
}: {
  compact: boolean;
  onOpenChat: () => void;
}) {
  const { t } = useTranslation();
  if (compact)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityLabel={t("coordinator.global.actions")}
          testID="coordinator-header-menu"
        >
          <Text style={styles.sectionLabel}>•••</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onOpenChat}>
            {t("coordinator.board.openChat")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <Button size="sm" variant="ghost" onPress={onOpenChat} testID="coordinator-chat-button">
      {t("coordinator.board.chat")}
    </Button>
  );
}

function ProjectWorking({
  board,
  grouped,
  compact,
  now,
  onOpenAgent,
}: {
  board: CoordinatorBoardSnapshot;
  grouped: boolean;
  compact: boolean;
  now: number;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.section} testID={`coordinator-working-project-${board.projectId}`}>
      {grouped ? <SectionLabel title={board.projectName ?? board.projectId} /> : null}
      {board.wake ? (
        <Text numberOfLines={2} style={styles.wakeLine} testID="coordinator-wake">
          {board.wake.text}
        </Text>
      ) : null}
      {!board.working.length && !board.wake ? (
        <Text style={styles.emptyLine}>{t("coordinator.board.nothingWorking")}</Text>
      ) : null}
      {board.working.map((row) => (
        <WorkingRow key={row.id} row={row} compact={compact} now={now} onOpenAgent={onOpenAgent} />
      ))}
    </View>
  );
}

function ProjectDone({
  board,
  grouped,
  now,
  handlers,
}: {
  board: CoordinatorBoardSnapshot;
  grouped: boolean;
  now: number;
  handlers: CoordinatorBoardHandlers;
}) {
  const { t } = useTranslation();
  const openChat = useCallback(() => {
    if (board.coordinatorAgentId) handlers.onOpenAgent(board.coordinatorAgentId);
  }, [board.coordinatorAgentId, handlers]);
  return (
    <View style={styles.section} testID={`coordinator-done-project-${board.projectId}`}>
      {grouped ? (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionLabel}>{board.projectName ?? board.projectId}</Text>
          {board.coordinatorAgentId ? (
            <Pressable accessibilityRole="button" onPress={openChat}>
              <Text style={styles.sectionLabelLink}>{t("coordinator.board.doneWindow")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {!board.done.length ? (
        <Text style={styles.emptyLine}>{t("coordinator.board.nothingDone")}</Text>
      ) : null}
      {board.done.slice(0, DONE_ROW_LIMIT).map((row) => (
        <DoneRow
          key={row.id}
          row={row}
          now={now}
          onOpenAgent={handlers.onOpenAgent}
          onOpenFile={handlers.onOpenFile}
        />
      ))}
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
  groups,
  headerContent,
  projectNameForId,
}: {
  board: CoordinatorBoardSnapshot;
  groups?: readonly CoordinatorBoardSnapshot[];
  headerContent?: ReactNode;
  projectNameForId?: (projectId: string) => string | undefined;
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
  const hasDecisions = decisionRows.length > 0;

  const respondToDecision = useCallback(
    async (rowId: string, action: BoardAction) => {
      const row = decisionRows.find((entry) => entry.id === rowId);
      if (!row) {
        return;
      }
      if (shouldOpenProjectSetup(row, action) && handlers.onSetupProject) {
        handlers.onSetupProject(row, action);
        return;
      }
      if (!client && action.operation !== "policy") {
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
        const result = await performBoardDecisionAction({
          row,
          action,
          client,
          onOpenAgent: handlers.onOpenAgent,
          timeout: RESPOND_TIMEOUT_MS,
        });
        if (result !== "answered") {
          setDecisionStates((current) => ({ ...current, [rowId]: IDLE_DECISION_STATE }));
          return;
        }
        if (action.composerQuote) {
          handlers.onComposerQuote(resolveComposerQuoteSource(row));
        }
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
    [client, decisionRows, handlers, t],
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
      {!compact ? <SectionLabel title={t("coordinator.board.needsYou")} /> : null}
      {decisionRows.map((row) => (
        <DecisionRow
          key={row.id}
          row={row}
          projectName={
            projectNameForId?.(row.setupProjectId ?? row.projectId) ??
            groups?.find((group) => group.projectId === row.projectId)?.projectName ??
            undefined
          }
          agentTitle={agentTitleForId(row.agentId)}
          permission={resolveDecisionPermission(pendingPermissions, row)}
          state={decisionStates[row.id] ?? IDLE_DECISION_STATE}
          now={now}
          compact={compact}
          onRespond={respondToDecision}
          onPeek={setPeekRowId}
          onOpenAgent={handlers.onOpenAgent}
        />
      ))}
    </View>
  ) : null;

  const workingSection = (
    <View style={styles.section} testID="coordinator-section-working">
      {!compact ? <SectionLabel title={t("coordinator.board.working")} /> : null}
      {(groups ?? [board]).map((group) => (
        <ProjectWorking
          key={group.projectId}
          board={group}
          grouped={Boolean(groups)}
          compact={compact}
          now={now}
          onOpenAgent={handlers.onOpenAgent}
        />
      ))}
    </View>
  );
  const doneBody = (groups ?? [board]).map((group) => (
    <ProjectDone
      key={group.projectId}
      board={group}
      grouped={Boolean(groups)}
      now={now}
      handlers={handlers}
    />
  ));

  const doneSection = (
    <View style={styles.section} testID="coordinator-section-done">
      {!compact ? (
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
      ) : null}
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
          <CoordinatorChatAction compact={compact} onOpenChat={handlers.onOpenChat} />
        ) : null}
      </View>

      {headerContent}
      {compact ? (
        <CompactBoardScroll
          hasDecisions={hasDecisions}
          doneCount={board.done.length}
          onToggleDone={toggleDoneExpanded}
        >
          {needsYouSection}
          {workingSection}
          {doneSection}
        </CompactBoardScroll>
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
        onOpenAgent={handlers.onOpenAgent}
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
  stickyHeader: { backgroundColor: theme.colors.surface0 },
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
