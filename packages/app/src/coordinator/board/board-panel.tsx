import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Kanban } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { KeyboardDock } from "@/components/keyboard-dock";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { useWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { COMPACT_FORM_FACTOR_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { useSettings } from "@/hooks/use-settings";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { buildCoordinatorBoardDraftKey } from "@/stores/draft-keys";
import type { PendingPermission } from "@/types/shared";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { useCoordinatorBoardSnapshot } from "@/coordinator/board-store";
import { buildComposerQuoteText } from "@/coordinator/decisions";
import { lastAssistantLine } from "@/coordinator/timeline-text";
import { CoordinatorBoard, type CoordinatorBoardHandlers } from "./board";
import { CoordinatorBoardTracks } from "./board-tracks";

const ThemedKanban = withUnistyles(Kanban);
const EMPTY_STREAM_ITEMS: never[] = [];
const EMPTY_PERMISSIONS: ReadonlyMap<string, PendingPermission> = new Map();

function useCoordinatorBoardPanelDescriptor(
  target: { kind: "coordinator_board"; projectId: string },
  context: { serverId: string; workspaceId: string; tabId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const board = useCoordinatorBoardSnapshot(context.serverId, target.projectId);
  const label = board?.projectName ?? t("coordinator.board.title");
  return {
    label,
    subtitle: t("coordinator.board.title"),
    tooltip: label,
    titleState: board ? "ready" : "loading",
    icon: ThemedKanban,
    statusBucket: board && board.needsYou.length > 0 ? "needs_input" : null,
  };
}

function CoordinatorBoardPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, openTab, openFileInWorkspace } = usePaneContext();
  const { isPaneFocused } = usePaneFocus();
  invariant(
    target.kind === "coordinator_board",
    "CoordinatorBoardPanel requires coordinator_board target",
  );
  const projectId = target.projectId;

  const client = useHostRuntimeClient(serverId);
  const board = useCoordinatorBoardSnapshot(serverId, projectId);
  const coordinatorAgentId = board?.coordinatorAgentId ?? null;
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_FORM_FACTOR_WIDTH,
    { initialIsBelow: isCompact },
  );
  const openInSidePane = useSettings((settings) => settings.openInSidePane);

  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory ?? "";

  const coordinatorAgent = useSessionStore((state) =>
    coordinatorAgentId ? (state.sessions[serverId]?.agents.get(coordinatorAgentId) ?? null) : null,
  );
  const cwd = coordinatorAgent?.cwd || workspaceDirectory;

  const streamItems = useSessionStore((state) =>
    coordinatorAgentId
      ? state.sessions[serverId]?.agentStreamTail?.get(coordinatorAgentId)
      : undefined,
  );
  const reply = useMemo(() => lastAssistantLine(streamItems ?? EMPTY_STREAM_ITEMS), [streamItems]);

  const agents = useSessionStore((state) => state.sessions[serverId]?.agents ?? null);
  const agentTitleForId = useCallback(
    (agentId: string) => agents?.get(agentId)?.title ?? null,
    [agents],
  );

  const pendingPermissions = useSessionStore(
    (state) => state.sessions[serverId]?.pendingPermissions ?? null,
  );

  // The draft rides on the coordinator session key so text typed on the board
  // shows up in the chat tab and vice versa. While no session is running the
  // draft is parked under a project-scoped key.
  const draftKey = buildCoordinatorBoardDraftKey({ serverId, projectId, coordinatorAgentId });
  const draftInput = useAgentInputDraft({ draftKey });
  // Bumping the composer focus key re-runs its web autofocus, so a Correct-it
  // answer lands the cursor on the quoted question.
  const [composerFocusNonce, setComposerFocusNonce] = useState(0);

  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd,
    workspaceId,
  });
  const attachmentScopeKeys = useMemo(
    () => [workspaceAttachmentScopeKey],
    [workspaceAttachmentScopeKey],
  );

  const openChat = useCallback(() => {
    if (coordinatorAgentId) {
      openTab({ kind: "agent", agentId: coordinatorAgentId });
    }
  }, [coordinatorAgentId, openTab]);

  const openAgent = useCallback(
    (agentId: string) => {
      openTab({ kind: "agent", agentId });
    },
    [openTab],
  );

  const quoteQuestionInComposer = useCallback(
    (question: string) => {
      const quote = buildComposerQuoteText(question);
      const existing = draftInput.text.trim();
      draftInput.replaceText(existing ? `${existing}\n\n${quote}` : quote);
      setComposerFocusNonce((nonce) => nonce + 1);
    },
    [draftInput],
  );

  const handlers = useMemo<CoordinatorBoardHandlers>(
    () => ({
      onOpenChat: openChat,
      onOpenAgent: openAgent,
      onOpenFile: openFileInWorkspace,
      onComposerQuote: quoteQuestionInComposer,
    }),
    [openAgent, openChat, openFileInWorkspace, quoteQuestionInComposer],
  );

  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      openWorkspaceChanges({
        isCompact,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        checkout: { serverId, cwd, isGit: true },
        preferences: openInSidePane,
      });
    },
    [cwd, isCompact, openInSidePane, serverId, workspaceId],
  );

  const inputAreaStyle = useMemo(
    () => [styles.composerDock, { paddingBottom: insets.bottom }],
    [insets.bottom],
  );

  if (!board || !board.enabled) {
    return (
      <View style={styles.fallback} testID="coordinator-board-unavailable">
        <Text style={styles.fallbackText}>{t("coordinator.board.unavailable")}</Text>
      </View>
    );
  }

  return (
    <KeyboardDock style={styles.root}>
      <FileDropZone style={styles.root}>
        <CoordinatorBoard
          board={board}
          client={client}
          pendingPermissions={pendingPermissions ?? EMPTY_PERMISSIONS}
          agentTitleForId={agentTitleForId}
          compact={isCompact}
          handlers={handlers}
          reply={reply}
        >
          <View style={inputAreaStyle} onLayout={onInputAreaLayout}>
            <CoordinatorBoardTracks serverId={serverId} projectId={projectId} />
            {coordinatorAgentId ? (
              <Composer
                agentId={coordinatorAgentId}
                serverId={serverId}
                workspaceId={workspaceId}
                externalKeyboardShift
                blurOnSubmit={isNative}
                isPaneFocused={isPaneFocused}
                value={draftInput.text}
                onChangeText={draftInput.editText}
                textReplacement={draftInput.textReplacement}
                attachments={draftInput.attachments}
                attachmentScopeKeys={attachmentScopeKeys}
                onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
                onChangeAttachments={draftInput.setAttachments}
                cwd={cwd}
                clearDraft={draftInput.clear}
                autoFocus
                autoFocusKey={`${draftInput.attachmentFocusRequestId}:${composerFocusNonce}`}
                placeholder={t("coordinator.board.composerPlaceholder")}
                isCompactLayout={isCompactComposerLayout}
                submitButtonTestID="coordinator-board-send"
              />
            ) : (
              <Text style={styles.fallbackText}>{t("coordinator.board.sessionStarting")}</Text>
            )}
          </View>
        </CoordinatorBoard>
      </FileDropZone>
    </KeyboardDock>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  composerDock: {
    paddingHorizontal: theme.spacing[4],
  },
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  fallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

export const coordinatorBoardPanelRegistration = definePanel("coordinator_board", {
  component: CoordinatorBoardPanel,
  useDescriptor: useCoordinatorBoardPanelDescriptor,
});
