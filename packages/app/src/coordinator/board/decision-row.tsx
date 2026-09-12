import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, MessagesSquare, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { CoordinatorDecisionBoardRow } from "@getpaseo/protocol/messages";
import type { Theme } from "@/styles/theme";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { formatDuration } from "@/utils/time";
import type { PendingPermission } from "@/types/shared";
import { isMultiQuestionRow, resolveBoardActions, type BoardAction } from "@/coordinator/decisions";

const ThemedCheckIcon = withUnistyles(Check);
const ThemedXIcon = withUnistyles(X);
const ThemedMessagesSquareIcon = withUnistyles(MessagesSquare);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const primaryColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const dangerColorMapping = (theme: Theme) => ({
  color: theme.colors.destructive,
});

export interface DecisionResponseState {
  /** The action currently in flight, while the daemon answers. */
  pendingActionId: string | null;
  /** The last response failure, kept until the next attempt. */
  error: string | null;
}

export const IDLE_DECISION_STATE: DecisionResponseState = {
  pendingActionId: null,
  error: null,
};

const actionButtonStyle = ({
  pressed,
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) => [
  styles.actionButton,
  hovered ? styles.actionButtonHovered : null,
  pressed ? styles.actionButtonPressed : null,
];

/**
 * A decision answer rendered with the transcript's permission-action
 * primitive: bordered surface button, Check/X icon, muted label that goes to
 * foreground on the primary option.
 */
export function DecisionActionButton({
  action,
  state,
  onPress,
  testID,
}: {
  action: BoardAction;
  state: DecisionResponseState;
  onPress: (action: BoardAction) => void;
  testID?: string;
}) {
  const isPendingAction = state.pendingActionId === action.id;
  const isResponding = state.pendingActionId !== null;
  const handlePress = useCallback(() => onPress(action), [action, onPress]);
  const Icon = action.behavior === "allow" ? ThemedCheckIcon : ThemedXIcon;
  const colorMapping = useMemo(() => {
    if (action.primary) {
      return primaryColorMapping;
    }
    if (action.variant === "danger") {
      return dangerColorMapping;
    }
    return mutedColorMapping;
  }, [action.primary, action.variant]);
  const labelStyle = [
    styles.actionLabel,
    action.primary ? styles.actionLabelPrimary : null,
    action.variant === "danger" ? styles.actionLabelDanger : null,
  ];
  return (
    <Pressable
      accessibilityRole="button"
      disabled={isResponding}
      onPress={handlePress}
      style={actionButtonStyle}
      testID={testID}
    >
      {isPendingAction ? (
        <ThemedLoadingSpinner size="small" uniProps={colorMapping} />
      ) : (
        <View style={styles.actionContent}>
          <Icon size={14} uniProps={colorMapping} />
          <Text style={labelStyle}>{action.label}</Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * The single affordance on a multi-question row — one tap cannot answer a
 * request with several questions, so it routes to the asking session's chat
 * where the full question form renders.
 */
export function AnswerInChatButton({ onPress, testID }: { onPress: () => void; testID?: string }) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={actionButtonStyle}
      testID={testID}
    >
      <View style={styles.actionContent}>
        <ThemedMessagesSquareIcon size={14} uniProps={primaryColorMapping} />
        <Text style={[styles.actionLabel, styles.actionLabelPrimary]}>
          {t("coordinator.board.answerInChat")}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The line under a decision question: who is asking, how long it has waited,
 * and the daemon default with its countdown.
 */
export function describeDecisionMeta(input: {
  row: CoordinatorDecisionBoardRow;
  agentTitle: string | null;
  now: number;
  t: TFunction;
}): string {
  const { row, agentTitle, now, t } = input;
  const parts: string[] = [];
  if (agentTitle) {
    parts.push(agentTitle);
  }
  const waitingMs = row.waitingMs ?? Math.max(0, now - new Date(row.askedAt).getTime());
  parts.push(t("coordinator.board.waiting", { duration: formatDuration(waitingMs) }));
  if (row.defaultAnswerLabel) {
    const dueMs = row.dueAt ? new Date(row.dueAt).getTime() - now : null;
    parts.push(
      dueMs != null && dueMs > 0
        ? t("coordinator.board.defaultIn", {
            answer: row.defaultAnswerLabel,
            duration: formatDuration(dueMs),
          })
        : t("coordinator.board.defaultAnswer", { answer: row.defaultAnswerLabel }),
    );
  }
  return parts.join(" · ");
}

function rowTextPressable({
  pressed,
  hovered,
}: PressableStateCallbackType & {
  hovered?: boolean;
}) {
  return [styles.rowTextPress, (hovered || pressed) && styles.rowTextPressActive];
}

export function DecisionRow({
  row,
  agentTitle,
  permission,
  state,
  now,
  compact,
  onRespond,
  onPeek,
  onOpenAgent,
}: {
  row: CoordinatorDecisionBoardRow;
  agentTitle: string | null;
  permission: PendingPermission | null;
  state: DecisionResponseState;
  now: number;
  compact: boolean;
  onRespond: (rowId: string, action: BoardAction) => void;
  onPeek: (rowId: string) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const handleRespond = useCallback(
    (action: BoardAction) => onRespond(row.id, action),
    [onRespond, row.id],
  );
  const handlePeek = useCallback(() => onPeek(row.id), [onPeek, row.id]);
  const handleAnswerInChat = useCallback(
    () => onOpenAgent(row.agentId),
    [onOpenAgent, row.agentId],
  );
  const actions = useMemo(() => resolveBoardActions(row, permission), [row, permission]);
  const meta = useMemo(
    () => describeDecisionMeta({ row, agentTitle, now, t }),
    [row, agentTitle, now, t],
  );

  return (
    <View style={styles.decisionRow} testID={`coordinator-decision-${row.id}`}>
      <View style={[styles.rowBody, compact && styles.rowBodyCompact]}>
        <View style={styles.rowLead}>
          <StatusDot bucket="needs_input" />
          <Pressable
            accessibilityRole="button"
            onPress={handlePeek}
            style={rowTextPressable}
            testID={`coordinator-decision-text-${row.id}`}
          >
            <Text style={styles.rowTitle}>{row.question}</Text>
            {meta ? (
              <Text numberOfLines={2} style={styles.rowMeta}>
                {meta}
              </Text>
            ) : null}
          </Pressable>
        </View>
        <View style={[styles.actionRow, compact && styles.actionRowCompact]}>
          {isMultiQuestionRow(row) ? (
            <AnswerInChatButton
              onPress={handleAnswerInChat}
              testID={`coordinator-decision-${row.id}-answer-in-chat`}
            />
          ) : (
            actions.map((action, index) => (
              <DecisionActionButton
                key={action.id}
                action={action}
                state={state}
                onPress={handleRespond}
                testID={`coordinator-decision-${row.id}-action-${index}`}
              />
            ))
          )}
        </View>
      </View>
      {state.error ? (
        <Text style={styles.rowError} testID={`coordinator-decision-${row.id}-error`}>
          {state.error}
        </Text>
      ) : null}
    </View>
  );
}

/** Peek sheet for a decision row — question, context, and the same answers. */
export function DecisionPeekSheet({
  row,
  agentTitle,
  permission,
  state,
  now,
  onRespond,
  onClose,
  onOpenAgent,
}: {
  row: CoordinatorDecisionBoardRow | null;
  agentTitle: string | null;
  permission: PendingPermission | null;
  state: DecisionResponseState;
  now: number;
  onRespond: (action: BoardAction) => void;
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const actions = useMemo(
    () => (row ? resolveBoardActions(row, permission) : []),
    [row, permission],
  );
  const header = useMemo(() => ({ title: t("coordinator.board.peekTitle") }), [t]);
  const handleAnswerInChat = useCallback(() => {
    if (!row) {
      return;
    }
    onClose();
    onOpenAgent(row.agentId);
  }, [row, onClose, onOpenAgent]);
  if (!row) {
    return null;
  }
  const request = permission?.request;
  const description = request?.description ?? null;
  const detail = request?.title ?? request?.name ?? null;
  const meta = describeDecisionMeta({ row, agentTitle, now, t });

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      testID="coordinator-decision-peek"
    >
      <View style={styles.peekBody}>
        <Text style={styles.peekQuestion}>{row.question}</Text>
        {detail && detail !== row.question ? <Text style={styles.peekDetail}>{detail}</Text> : null}
        {description ? <Text style={styles.peekDetail}>{description}</Text> : null}
        {meta ? <Text style={styles.peekMeta}>{meta}</Text> : null}
        {state.error ? <Text style={styles.rowError}>{state.error}</Text> : null}
        <View style={styles.peekActions}>
          {isMultiQuestionRow(row) ? (
            <AnswerInChatButton
              onPress={handleAnswerInChat}
              testID="coordinator-decision-peek-answer-in-chat"
            />
          ) : (
            actions.map((action) => (
              <DecisionActionButton
                key={action.id}
                action={action}
                state={state}
                onPress={onRespond}
              />
            ))
          )}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

type BoardDotBucket = "needs_input" | "running" | "done";

export function StatusDot({ bucket }: { bucket: BoardDotBucket }) {
  const style = {
    needs_input: styles.dotNeedsInput,
    running: styles.dotRunning,
    done: styles.dotDone,
  }[bucket];
  return <View style={style} testID={`coordinator-dot-${bucket}`} />;
}

const styles = StyleSheet.create((theme) => {
  const dot = (bucket: BoardDotBucket) => ({
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    marginTop: 7,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: true }) ?? undefined,
  });

  return {
    dotNeedsInput: dot("needs_input"),
    dotRunning: dot("running"),
    dotDone: dot("done"),
    decisionRow: {
      gap: theme.spacing[1],
    },
    rowBody: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing[3],
      minHeight: 44,
      paddingVertical: theme.spacing[2],
    },
    rowBodyCompact: {
      flexDirection: "column",
      gap: theme.spacing[2],
    },
    rowLead: {
      flex: 1,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing[2],
      minWidth: 0,
    },
    rowTextPress: {
      flex: 1,
      minWidth: 0,
      gap: 2,
      borderRadius: theme.borderRadius.md,
    },
    rowTextPressActive: {
      opacity: 0.8,
    },
    rowTitle: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
    },
    rowMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      flexShrink: 0,
    },
    actionRowCompact: {
      alignSelf: "flex-end",
    },
    actionButton: {
      paddingVertical: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      alignItems: "center",
      borderWidth: theme.borderWidth[1],
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.borderAccent,
    },
    actionButtonHovered: {
      backgroundColor: theme.colors.surface2,
    },
    actionButtonPressed: {
      opacity: 0.9,
    },
    actionContent: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    actionLabel: {
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.normal,
      color: theme.colors.foregroundMuted,
    },
    actionLabelPrimary: {
      color: theme.colors.foreground,
    },
    actionLabelDanger: {
      color: theme.colors.destructive,
    },
    rowError: {
      color: theme.colors.destructive,
      fontSize: theme.fontSize.sm,
      paddingLeft: theme.spacing[4],
    },
    peekBody: {
      gap: theme.spacing[3],
      paddingHorizontal: theme.spacing[6],
      paddingVertical: theme.spacing[4],
    },
    peekQuestion: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
    },
    peekDetail: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
    },
    peekMeta: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    peekActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      flexWrap: "wrap",
      gap: theme.spacing[2],
    },
  };
});
