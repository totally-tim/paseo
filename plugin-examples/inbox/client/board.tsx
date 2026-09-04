import type { PluginSurfaceProps, PluginTheme, PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { type CardActions, InboxCardView } from "./card";
import { keyToAction, resolveKeyAction } from "./keyboard";
import { type InboxCard, type Lane, type Lanes } from "./lanes";
import { PeekModal } from "./peek-modal";
import { EMPTY_SNAPSHOT, getInboxStore, type InboxSnapshot, type InboxStore } from "./store";
import type { PaseoApi } from "./types";
import { ActionButton } from "./question-card";
import { FilterControls } from "./filter-controls";
import { boardLanes, boardReady } from "./review";
import { isTextTarget, subscribeKeydown, type WebKeyEvent } from "./web";

const KEY_HINT = "j/k move · Enter open · 1-9 answer · y/n allow/deny";
const LANE_ORDER: readonly Lane[] = ["needsYou", "working", "done"];
const LANE_TITLE: Record<Lane, string> = {
  needsYou: "Needs you",
  working: "Working",
  done: "Done",
};
const NO_STORE_UNSUBSCRIBE = () => {};

function useInboxSnapshot(): InboxSnapshot {
  const store = getInboxStore();
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? NO_STORE_UNSUBSCRIBE,
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
  );
}

function useNow(active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function useBoardStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const padding = compact ? 12 : 20;
    return StyleSheet.create({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      loading: { color: theme.colors.foregroundMuted, padding },
      compactContent: { padding, gap: 8 },
      toolbar: { paddingHorizontal: padding, paddingTop: 12, gap: 10 },
      toolbarRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
      status: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      needsYou: {
        flex: 1.4,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingTop: 6,
      },
      lanes: { flex: 1, flexDirection: "row", gap: 16, padding },
      lane: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingTop: 6,
      },
      laneContent: { paddingBottom: 12 },
      header: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
      headerTitle: {
        flex: 1,
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      },
      count: {
        minWidth: 22,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 11,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
      },
      countText: { color: theme.colors.foreground, fontSize: 12 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 8 },
      cards: { gap: 10 },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        paddingHorizontal: padding,
        paddingBottom: 8,
        textAlign: "right",
      },
    });
  }, [compact, theme]);
}

type BoardStyles = ReturnType<typeof useBoardStyles>;

function collapseMarker(collapsed: boolean | null): string {
  if (collapsed === null) return "";
  return collapsed ? "  ▸" : "  ▾";
}

function LaneHeader({
  lane,
  count,
  styles,
  collapsed,
  onToggle,
}: {
  lane: Lane;
  count: number;
  styles: BoardStyles;
  collapsed: boolean | null;
  onToggle?: (lane: Lane) => void;
}) {
  const handlePress = useCallback(() => onToggle?.(lane), [lane, onToggle]);
  const content = (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>
        {LANE_TITLE[lane]}
        {collapseMarker(collapsed)}
      </Text>
      <View style={styles.count}>
        <Text style={styles.countText}>{count}</Text>
      </View>
    </View>
  );
  if (!onToggle) return content;
  return (
    <Pressable accessibilityRole="button" onPress={handlePress}>
      {content}
    </Pressable>
  );
}

function LaneBody({
  cards,
  emptyText,
  styles,
  theme,
  paseo,
  now,
  actions,
  focusedId,
}: {
  cards: InboxCard[];
  emptyText: string;
  styles: BoardStyles;
  theme: PluginTheme;
  paseo: PaseoApi;
  now: number;
  actions: CardActions;
  focusedId: string | null;
}) {
  if (cards.length === 0) {
    return <Text style={styles.empty}>{emptyText}</Text>;
  }
  return (
    <View style={styles.cards}>
      {cards.map((card) => (
        <InboxCardView
          key={card.agent.id}
          card={card}
          theme={theme}
          paseo={paseo}
          now={now}
          actions={actions}
          focused={card.agent.id === focusedId}
        />
      ))}
    </View>
  );
}

function BoardToolbar({
  workspaceId,
  store,
  snapshot,
  theme,
  styles,
  changeFilters,
  setFiltersOpen,
  isActive,
  lanes,
  filtered,
  next,
  retryLoad,
}: {
  workspaceId?: string;
  store: InboxStore | null;
  snapshot: InboxSnapshot;
  theme: PluginTheme;
  styles: BoardStyles;
  changeFilters(): void;
  setFiltersOpen(open: boolean): void;
  isActive: boolean;
  lanes: Lanes;
  filtered: boolean;
  next(): void;
  retryLoad(): void;
}) {
  return (
    <View style={styles.toolbar}>
      {!workspaceId && store ? (
        <FilterControls
          snapshot={snapshot}
          store={store}
          theme={theme}
          onChange={changeFilters}
          onOpenChange={setFiltersOpen}
          active={isActive}
        />
      ) : null}
      <View style={styles.toolbarRow}>
        <Text style={styles.status}>
          {lanes.needsYou.length} needing you{filtered ? " in these projects" : ""}
        </Text>
        <ActionButton
          theme={theme}
          label="Review next"
          onPress={next}
          disabled={!lanes.needsYou.length}
        />
        <ActionButton
          theme={theme}
          label={snapshot.loading ? "Refreshing…" : "Refresh"}
          onPress={retryLoad}
          disabled={snapshot.loading}
        />
      </View>
      {snapshot.loadError ? (
        <View style={styles.toolbarRow}>
          <Text accessibilityRole="alert" style={styles.error}>
            Could not load agents: {snapshot.loadError}
          </Text>
          <ActionButton theme={theme} label="Retry loading" onPress={retryLoad} />
        </View>
      ) : null}
    </View>
  );
}

const INITIAL_COLLAPSED: Record<Lane, boolean> = { needsYou: false, working: true, done: true };

export function InboxBoard({
  theme,
  layout,
  navigation,
  workspaceId,
  keyboard = false,
  isActive: activity,
}: Pick<PluginSurfaceProps, "theme" | "layout" | "navigation" | "isActive"> & {
  workspaceId?: string;
  /** Bind board shortcuts. Only the global surface does, so a panel never doubles them. */
  keyboard?: boolean;
}) {
  const isActive = activity === true;
  const paseo = usePaseo();
  const snapshot = useInboxSnapshot();
  const now = useNow(isActive);
  const styles = useBoardStyles(theme, layout.compact);
  const [peekAgentId, setPeekAgentId] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<Lane, boolean>>(INITIAL_COLLAPSED);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const store = getInboxStore();
  const interactionRevision = useRef(0);
  const lanes = useMemo(() => boardLanes(snapshot, workspaceId), [snapshot, workspaceId]);
  const ordered = useMemo(() => LANE_ORDER.flatMap((lane) => lanes[lane]), [lanes]);
  const openCard = ordered.find((card) => card.agent.id === openCardId) ?? null;
  const open = useCallback((card: InboxCard) => {
    interactionRevision.current += 1;
    setOpenCardId(card.agent.id);
    setPeekAgentId(card.subject.id);
    setFocusedId(card.agent.id);
  }, []);
  const selectMember = useCallback((agentId: string) => {
    interactionRevision.current += 1;
    setPeekAgentId(agentId);
  }, []);
  const closePeek = useCallback(() => {
    interactionRevision.current += 1;
    setOpenCardId(null);
  }, []);
  const changeFilters = useCallback(() => {
    interactionRevision.current += 1;
    setOpenCardId(null);
    setFocusedId(null);
  }, []);

  useEffect(() => {
    interactionRevision.current += 1;
  }, [isActive]);
  const pendingOpenAgentId = snapshot.pendingOpenAgentId;
  useEffect(() => {
    if (!isActive || workspaceId || !pendingOpenAgentId || !store) return;
    const card = ordered.find((item) => item.agent.id === pendingOpenAgentId);
    if (!card) return;
    open(card);
    store.clearPendingOpen();
  }, [isActive, workspaceId, pendingOpenAgentId, store, ordered, open]);

  const candidates = useCallback(() => {
    const current = store?.getSnapshot();
    if (!current) return [];
    return boardLanes(current, workspaceId).needsYou;
  }, [store, workspaceId]);
  const next = useCallback(() => {
    const queue = candidates();
    const index = queue.findIndex((card) => card.agent.id === openCardId);
    const card = queue[(index + 1) % queue.length];
    if (card) open(card);
  }, [candidates, open, openCardId]);

  const probe = paseo.agents.ref("__inbox_probe__");
  const canRespond =
    typeof probe.respondToPermission === "function" && typeof probe.clearAttention === "function";
  const actions: CardActions = useMemo(
    () => ({
      canRespond,
      active: isActive,
      drafts: snapshot.drafts,
      draftsReady: snapshot.draftsReady,
      draftsError: snapshot.draftsError,
      onRetryDrafts: () => store?.retryDrafts(),
      operations: snapshot.operations,
      onDraft: (agentId, text) => store?.setDraft(agentId, text),
      onRespond: (agentId, requestId, response) => {
        if (!store || !isActive || !canRespond) return;
        const revision = interactionRevision.current;
        void store.respond(agentId, requestId, response).then((sent) => {
          // A slow response must not pull the user away from a card they opened meanwhile.
          if (!sent || revision !== interactionRevision.current) return undefined;
          const card = candidates()[0];
          setFocusedId(card?.agent.id ?? null);
          if (openCardId) {
            setOpenCardId(card?.agent.id ?? null);
            setPeekAgentId(card?.subject.id ?? null);
          }
          return undefined;
        });
      },
      onReply: (agentId) => {
        if (isActive) void store?.sendReply(agentId);
      },
      onMarkRead: (agentId) => {
        if (isActive) void store?.markRead(agentId);
      },
      onOpen: open,
    }),
    [
      canRespond,
      isActive,
      snapshot.drafts,
      snapshot.draftsReady,
      snapshot.draftsError,
      snapshot.operations,
      store,
      candidates,
      openCardId,
      open,
    ],
  );

  const toggleLane = useCallback(
    (lane: Lane) => setCollapsed((value) => ({ ...value, [lane]: !value[lane] })),
    [],
  );

  const showsKeyHint = isActive && keyboard && layout.platform === "web" && !layout.compact;
  useEffect(() => {
    if (!isActive || filtersOpen || !keyboard || layout.platform !== "web") return;
    const handle = (event: WebKeyEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || isTextTarget(event.target))
        return;
      // The peek can select a child independently. Never answer a background card.
      if (openCardId) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePeek();
        }
        return;
      }
      const action = keyToAction(event);
      if (!action) return;
      const effect = resolveKeyAction(action, { ordered, focusedId, openCardId });
      if (!effect) return;
      event.preventDefault();
      interactionRevision.current += 1;
      if (effect.kind === "focus") setFocusedId(effect.agentId);
      else if (effect.kind === "open") {
        setFocusedId(effect.agentId);
        const card = ordered.find((item) => item.agent.id === effect.agentId);
        if (card) open(card);
      } else if (effect.kind === "close") setOpenCardId(null);
      else if (effect.card.request) {
        actions.onRespond(effect.card.subject.id, effect.card.request.id, effect.response);
      }
    };
    return subscribeKeydown(handle);
  }, [
    actions,
    isActive,
    filtersOpen,
    focusedId,
    keyboard,
    layout.platform,
    openCardId,
    ordered,
    closePeek,
    open,
  ]);

  const retryLoad = useCallback(() => {
    void store?.retryLoad();
  }, [store]);
  const filtered =
    !workspaceId && (snapshot.filters.projectId !== null || snapshot.filters.projectGroup !== null);
  const emptyText = filtered
    ? "No matching agents in this lane. Clear filters to see all projects."
    : "No agents in this lane. Idle agents without unread results are hidden.";
  if (activity === undefined)
    return <Text style={styles.loading}>Update this Paseo app to use Kanban.</Text>;
  let content: React.ReactNode;
  if (!boardReady(snapshot, workspaceId)) {
    content = snapshot.loading ? (
      <Text style={styles.loading}>Loading agents and saved filters…</Text>
    ) : null;
  } else if (layout.compact) {
    content = (
      <ScrollView contentContainerStyle={styles.compactContent}>
        {LANE_ORDER.map((lane) => (
          <View key={lane}>
            <LaneHeader
              lane={lane}
              count={lanes[lane].length}
              styles={styles}
              collapsed={collapsed[lane]}
              onToggle={toggleLane}
            />
            {collapsed[lane] ? null : (
              <LaneBody
                cards={lanes[lane]}
                emptyText={emptyText}
                styles={styles}
                theme={theme}
                paseo={paseo}
                now={now}
                actions={actions}
                focusedId={focusedId}
              />
            )}
          </View>
        ))}
      </ScrollView>
    );
  } else {
    content = (
      <View style={styles.lanes}>
        {LANE_ORDER.map((lane) => (
          <View key={lane} style={lane === "needsYou" ? styles.needsYou : styles.lane}>
            <LaneHeader lane={lane} count={lanes[lane].length} styles={styles} collapsed={null} />
            <ScrollView contentContainerStyle={styles.laneContent}>
              <LaneBody
                cards={lanes[lane]}
                emptyText={emptyText}
                styles={styles}
                theme={theme}
                paseo={paseo}
                now={now}
                actions={actions}
                focusedId={focusedId}
              />
            </ScrollView>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <BoardToolbar
        workspaceId={workspaceId}
        store={store}
        snapshot={snapshot}
        theme={theme}
        styles={styles}
        changeFilters={changeFilters}
        setFiltersOpen={setFiltersOpen}
        isActive={isActive}
        lanes={lanes}
        filtered={filtered}
        next={next}
        retryLoad={retryLoad}
      />
      {content}
      {showsKeyHint ? <Text style={styles.hint}>{KEY_HINT}</Text> : null}
      {openCard ? (
        <PeekModal
          key={openCard.agent.id}
          selectedId={peekAgentId}
          onSelect={selectMember}
          card={openCard}
          theme={theme}
          paseo={paseo}
          navigation={navigation}
          actions={actions}
          onClose={closePeek}
          onNext={next}
          remaining={lanes.needsYou.length}
        />
      ) : null}
    </View>
  );
}

export function InboxSurface(props: PluginSurfaceProps) {
  return (
    <InboxBoard
      theme={props.theme}
      layout={props.layout}
      navigation={props.navigation}
      isActive={props.isActive}
      keyboard
    />
  );
}

export function InboxWorkspacePanel(props: PluginWorkspacePanelProps) {
  return (
    <InboxBoard
      theme={props.theme}
      layout={props.layout}
      navigation={props.navigation}
      workspaceId={props.workspaceId}
      isActive={props.isActive}
    />
  );
}
