import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import type {
  GlobalCoordinatorState,
  CoordinatorNotificationSettings,
  CoordinatorTrustLevel,
  CoordinatorBoardSnapshot,
  CoordinatorDecisionBoardRow,
} from "@getpaseo/protocol/messages";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { FileDropZone } from "@/components/file-drop/file-drop-zone";
import { KeyboardDock } from "@/components/keyboard-dock";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildCoordinatorBoardDraftKey } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { PendingPermission } from "@/types/shared";
import { useCoordinatorBoardStore } from "./board-store";
import { CoordinatorBoard, type CoordinatorBoardHandlers } from "./board/board";
import { CoordinatorTrustPill } from "./board/board-tracks";
import {
  COORDINATOR_ELIGIBLE_PROVIDERS,
  CoordinatorEnableSheet,
  CoordinatorRoleProfileField,
  type CoordinatorRoleSelection,
} from "./setup-row";
import {
  projectGlobalBoard,
  globalBoardProjectOptions,
  type GlobalBoardProjectOption,
} from "./global-board-model";
import { lastAssistantLine } from "./timeline-text";
import { buildComposerQuoteText } from "./decisions";
import { NotificationSettingsSheet } from "./notification-settings-sheet";

const EMPTY_PERMISSIONS: ReadonlyMap<string, PendingPermission> = new Map();
const EMPTY_STREAM: never[] = [];

export function GlobalCoordinatorScreen({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "coordinator");
  const connected = useHostRuntimeIsConnected(serverId);
  if (!connected || !supported)
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>
          {t(!connected ? "coordinator.global.disconnected" : "coordinator.global.updateHost")}
        </Text>
      </View>
    );
  return <ConnectedGlobalCoordinator key={serverId} serverId={serverId} />;
}

function ConnectedGlobalCoordinator({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [coordinator, setCoordinator] = useState<GlobalCoordinatorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const openNotifications = useCallback(() => setNotificationsOpen(true), []);
  const closeNotifications = useCallback(() => setNotificationsOpen(false), []);
  const saveNotifications = useCallback(
    async (notificationSettings: CoordinatorNotificationSettings) => {
      if (!client) throw new Error("Host disconnected");
      setCoordinator(await client.updateGlobalCoordinator({ notificationSettings }));
    },
    [client],
  );
  const boards = useCoordinatorBoardStore((state) => state.hosts[serverId]?.boards);
  const ownBoard = useMemo(
    () => [...(boards?.values() ?? [])].find((board) => board.tier === "global"),
    [boards],
  );
  useEffect(() => {
    if (!client) return;
    let disposed = false;
    setError(null);
    void client
      .getGlobalCoordinator()
      .then((value) => {
        if (!disposed) setCoordinator(value);
        return value;
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(String(failure));
      });
    return () => {
      disposed = true;
    };
  }, [client, ownBoard?.enabled, ownBoard?.coordinatorAgentId, ownBoard?.trustLevel, retry]);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  const openSheet = useCallback(() => setSheetOpen(true), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const applyTrust = useCallback(
    async (trustLevel: CoordinatorTrustLevel) => {
      if (!client) throw new Error(t("coordinator.global.disconnected"));
      setCoordinator(await client.updateGlobalCoordinator({ trustLevel }));
    },
    [client, t],
  );
  let content;
  if (
    coordinator?.enabled &&
    coordinator.workspaceId &&
    ownBoard?.enabled &&
    ownBoard.coordinatorAgentId
  ) {
    content = (
      <GlobalBoardContent
        serverId={serverId}
        coordinator={coordinator}
        ownBoard={ownBoard}
        workspaceId={coordinator.workspaceId}
        agentId={ownBoard.coordinatorAgentId}
        onSelectTrust={applyTrust}
        onOpenNotifications={openNotifications}
      />
    );
  } else if (error) {
    content = (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <Button variant="ghost" onPress={refresh}>
          {t("coordinator.global.retry")}
        </Button>
      </View>
    );
  } else if (coordinator && !coordinator.enabled) {
    content = (
      <View style={styles.center}>
        <Text style={styles.title}>{t("coordinator.board.title")}</Text>
        <Button variant="secondary" onPress={openSheet} testID="coordinator-global-setup">
          {t("coordinator.global.setup")}
        </Button>
      </View>
    );
  } else {
    content = (
      <View style={styles.center}>
        <Text style={styles.muted}>{t("coordinator.global.loading")}</Text>
      </View>
    );
  }
  return (
    <KeyboardDock style={styles.root}>
      {content}
      {coordinator?.notificationSettings ? (
        <NotificationSettingsSheet
          visible={notificationsOpen}
          snapshot={coordinator.notificationSettings}
          onClose={closeNotifications}
          onSave={saveNotifications}
        />
      ) : null}
      <GlobalEnableSheet
        serverId={serverId}
        visible={sheetOpen}
        onClose={closeSheet}
        onEnabled={setCoordinator}
      />
    </KeyboardDock>
  );
}

function GlobalEnableSheet({
  serverId,
  visible,
  onClose,
  onEnabled,
}: {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  onEnabled: (state: GlobalCoordinatorState) => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const profiles = useProvidersSnapshot(serverId, { cwd: null });
  const [selection, setSelection] = useState<CoordinatorRoleSelection | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligibleProviders = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(
        profiles.entries?.filter((entry) =>
          COORDINATOR_ELIGIBLE_PROVIDERS.includes(entry.provider),
        ),
      ),
    [profiles.entries],
  );
  const refreshProfiles = profiles.refresh;
  const retryProvider = useCallback(
    (provider: CoordinatorRoleSelection["provider"]) => {
      void refreshProfiles([provider]);
    },
    [refreshProfiles],
  );
  const enable = useCallback(async () => {
    if (!client || !selection) return;
    setEnabling(true);
    setError(null);
    try {
      onEnabled(
        await client.enableGlobalCoordinator({
          profile: {
            provider: selection.provider,
            ...(selection.modelId ? { model: selection.modelId } : {}),
          },
        }),
      );
      onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setEnabling(false);
    }
  }, [client, selection, onEnabled, onClose]);
  const header = useMemo(() => ({ title: t("coordinator.global.enableTitle") }), [t]);
  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="coordinator-global-enable-sheet"
    >
      <View style={styles.sheet}>
        <CoordinatorRoleProfileField
          label={t("coordinator.global.profile")}
          selection={selection}
          fallbackProvider={null}
          providers={eligibleProviders}
          isLoading={profiles.isLoading}
          isRefreshing={profiles.isRefreshing}
          disabled={enabling}
          serverId={serverId}
          testID="coordinator-global-profile"
          onSelect={setSelection}
          onRetryProvider={retryProvider}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button
          onPress={enable}
          disabled={!selection || !client}
          loading={enabling}
          testID="coordinator-global-enable"
        >
          {t("coordinator.global.enable")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function ProjectFilterItem({
  projectId,
  label,
  onSelect,
}: {
  projectId: string | null;
  label: string;
  onSelect: (projectId: string | null) => void;
}) {
  const select = useCallback(() => onSelect(projectId), [projectId, onSelect]);
  return <DropdownMenuItem onSelect={select}>{label}</DropdownMenuItem>;
}

function GlobalProjectFilter({
  projects,
  projectId,
  onSelect,
}: {
  projects: readonly GlobalBoardProjectOption[];
  projectId: string | null;
  onSelect: (projectId: string | null) => void;
}) {
  const { t } = useTranslation();
  const label =
    projects.find((board) => board.projectId === projectId)?.projectName ??
    t("coordinator.global.allProjects");
  return (
    <View style={styles.filter}>
      <DropdownMenu>
        <DropdownMenuTrigger testID="coordinator-project-filter">
          <Text style={styles.muted}>{label}</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <ProjectFilterItem
            projectId={null}
            label={t("coordinator.global.allProjects")}
            onSelect={onSelect}
          />
          {projects.map((board) => (
            <ProjectFilterItem
              key={board.projectId}
              projectId={board.projectId}
              label={board.projectName ?? board.projectId}
              onSelect={onSelect}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function GlobalTrust({
  coordinator,
  boards,
  onSelectTrust,
}: {
  coordinator: GlobalCoordinatorState;
  boards: readonly CoordinatorBoardSnapshot[];
  onSelectTrust: (level: CoordinatorTrustLevel) => Promise<void>;
}) {
  const { t } = useTranslation();
  const overrides = boards.filter((board) => board.trustLevel !== coordinator.trustLevel);
  return (
    <View style={styles.tracks}>
      <CoordinatorTrustPill
        global
        trustLevel={coordinator.trustLevel}
        usage={null}
        usageExpectation={null}
        onSelectTrust={onSelectTrust}
      >
        <Text style={styles.muted}>{t("coordinator.global.defaultTrust")}</Text>
        {overrides.length ? (
          <Text style={styles.muted}>{t("coordinator.global.overrides")}</Text>
        ) : null}
        {overrides.map((board) => (
          <Text key={board.projectId} style={styles.muted}>
            {board.projectName ?? board.projectId} ·{" "}
            {t(`coordinator.trust.levels.${board.trustLevel}`)}
          </Text>
        ))}
      </CoordinatorTrustPill>
    </View>
  );
}

function useGlobalProjectFilter(serverId: string) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const hostProjects = useSessionStore((state) => state.sessions[serverId]?.projects);
  const projects = useMemo(
    () => globalBoardProjectOptions(hostProjects?.values() ?? []),
    [hostProjects],
  );
  const selectedProjectId = projects.some((project) => project.projectId === projectId)
    ? projectId
    : null;
  const projectNameForId = useCallback(
    (targetProjectId: string) =>
      projects.find((project) => project.projectId === targetProjectId)?.projectName,
    [projects],
  );
  return { projects, selectedProjectId, setProjectId, projectNameForId };
}

function GlobalBoardContent({
  serverId,
  coordinator,
  ownBoard,
  workspaceId,
  agentId,
  onSelectTrust,
  onOpenNotifications,
}: {
  serverId: string;
  coordinator: GlobalCoordinatorState;
  ownBoard: CoordinatorBoardSnapshot;
  workspaceId: string;
  agentId: string;
  onSelectTrust: (level: CoordinatorTrustLevel) => Promise<void>;
  onOpenNotifications: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const session = useSessionStore((state) => state.sessions[serverId]);
  const { projects, selectedProjectId, setProjectId, projectNameForId } =
    useGlobalProjectFilter(serverId);
  const boards = useCoordinatorBoardStore((state) => state.hosts[serverId]?.boards);
  const projectBoards = useMemo(
    () => [...(boards?.values() ?? [])].filter((board) => board.enabled && board.tier !== "global"),
    [boards],
  );
  const projection = useMemo(
    () =>
      projectGlobalBoard(
        boards?.values() ?? [],
        { ...ownBoard, projectName: t("coordinator.board.title") },
        selectedProjectId,
      ),
    [boards, ownBoard, selectedProjectId, t],
  );
  const timelineSourceId = useId();
  const routeFocused = useIsFocused();
  const panelActive = useRetainedPanelActive();
  const viewedTimelineSync = session?.viewedTimelineSync;
  useEffect(() => {
    if (!viewedTimelineSync) return;
    viewedTimelineSync.replaceVisibleAgentIds(
      timelineSourceId,
      routeFocused && panelActive ? [agentId] : [],
    );
    return () => viewedTimelineSync.replaceVisibleAgentIds(timelineSourceId, []);
  }, [viewedTimelineSync, timelineSourceId, routeFocused, panelActive, agentId]);
  const agent = session?.agents.get(agentId);
  const cwd = agent?.cwd ?? session?.workspaces.get(workspaceId)?.workspaceDirectory ?? "";
  const compact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const draft = useAgentInputDraft({
    draftKey: buildCoordinatorBoardDraftKey({
      serverId,
      projectId: ownBoard.projectId,
      coordinatorAgentId: agentId,
    }),
  });
  const scopeKey = useWorkspaceAttachmentScopeKey({ serverId, cwd, workspaceId });
  const attachmentScopeKeys = useMemo(() => [scopeKey], [scopeKey]);
  const stream = session?.agentStreamTail?.get(agentId);
  const reply = useMemo(() => lastAssistantLine(stream ?? EMPTY_STREAM), [stream]);
  const [focusNonce, setFocusNonce] = useState(0);
  const openAgent = useCallback(
    (targetId: string) => {
      navigateToAgent({ serverId, agentId: targetId });
    },
    [serverId],
  );
  const openChat = useCallback(() => {
    navigateToAgent({ serverId, agentId, workspaceId });
  }, [serverId, agentId, workspaceId]);
  const quote = useCallback(
    (question: string) => {
      draft.replaceText(
        [draft.text.trim(), buildComposerQuoteText(question)].filter(Boolean).join("\n\n"),
      );
      setFocusNonce((nonce) => nonce + 1);
    },
    [draft],
  );
  const openFile = useCallback<CoordinatorBoardHandlers["onOpenFile"]>(
    (request, targetProjectId) => {
      const workspace = [...(session?.workspaces.values() ?? [])].find(
        (entry) =>
          entry.projectId === targetProjectId && entry.workspaceDirectory === entry.projectRootPath,
      );
      if (workspace)
        navigateToWorkspace({
          serverId,
          workspaceId: workspace.id,
          target: { kind: "file", ...request.location },
        });
    },
    [session?.workspaces, serverId],
  );
  const [setup, setSetup] = useState<CoordinatorDecisionBoardRow | null>(null);
  const setupProject = useCallback((row: CoordinatorDecisionBoardRow) => setSetup(row), []);
  const closeSetup = useCallback(() => setSetup(null), []);
  const handlers = useMemo<CoordinatorBoardHandlers>(
    () => ({
      onOpenChat: openChat,
      onOpenAgent: openAgent,
      onOpenFile: openFile,
      onComposerQuote: quote,
      onSetupProject: setupProject,
    }),
    [openChat, openAgent, openFile, quote, setupProject],
  );
  const agentTitle = useCallback(
    (targetId: string) => session?.agents.get(targetId)?.title ?? null,
    [session?.agents],
  );
  const filter = useMemo(
    () => (
      <View style={styles.notificationToolbar}>
        <GlobalProjectFilter
          projects={projects}
          projectId={selectedProjectId}
          onSelect={setProjectId}
        />
        {coordinator.notificationSettings ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={onOpenNotifications}
            testID="coordinator-notifications"
          >
            Notifications
          </Button>
        ) : null}
      </View>
    ),
    [
      projects,
      selectedProjectId,
      setProjectId,
      coordinator.notificationSettings,
      onOpenNotifications,
    ],
  );
  return (
    <FileDropZone style={styles.root}>
      <CoordinatorBoard
        board={projection.board}
        groups={projection.groups}
        projectNameForId={projectNameForId}
        client={client}
        pendingPermissions={session?.pendingPermissions ?? EMPTY_PERMISSIONS}
        agentTitleForId={agentTitle}
        compact={compact}
        handlers={handlers}
        reply={reply}
        headerContent={filter}
      >
        <View style={[styles.dock, { paddingBottom: insets.bottom }]}>
          <GlobalTrust
            coordinator={coordinator}
            boards={projectBoards}
            onSelectTrust={onSelectTrust}
          />
          <Composer
            serverId={serverId}
            workspaceId={workspaceId}
            agentId={agentId}
            cwd={cwd}
            externalKeyboardShift
            blurOnSubmit={isNative}
            isPaneFocused
            value={draft.text}
            onChangeText={draft.editText}
            textReplacement={draft.textReplacement}
            attachments={draft.attachments}
            attachmentScopeKeys={attachmentScopeKeys}
            onChangeAttachments={draft.setAttachments}
            clearDraft={draft.clear}
            autoFocus
            autoFocusKey={`${draft.attachmentFocusRequestId}:${focusNonce}`}
            placeholder={t("coordinator.board.composerPlaceholder")}
            isCompactLayout={compact}
            submitButtonTestID="coordinator-global-send"
          />
        </View>
      </CoordinatorBoard>
      {setup?.setupProjectId ? (
        <CoordinatorEnableSheet
          key={setup.setupProjectId}
          visible
          projectId={setup.setupProjectId}
          serverId={serverId}
          cwd={session?.projects.get(setup.setupProjectId)?.projectRootPath ?? null}
          initialProfile={coordinator.profile}
          onClose={closeSetup}
        />
      ) : null}
    </FileDropZone>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.destructive },
  notificationToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingRight: theme.spacing[4],
  },
  filter: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    alignItems: "flex-start",
  },
  dock: { paddingHorizontal: theme.spacing[4] },
  tracks: { flexDirection: "row", paddingBottom: theme.spacing[2] },
  sheet: { padding: theme.spacing[6], gap: theme.spacing[4] },
}));
