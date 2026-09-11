import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";

import { usePaseo } from "@getpaseo/plugin/client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import {
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { ReasonChips, SchedulesStrip, ShortcutHelp, SnoozedSection } from "./board-extras";
import { type CardActions, InboxCardView } from "./card";
import { keyToAction, resolveKeyAction } from "./keyboard";
import { type InboxCard, type Lane, type Lanes, laneFlexGrow, type NeedsReason } from "./lanes";
import { PeekModal } from "./peek-modal";
import {
  archiveKey,
  EMPTY_SNAPSHOT,
  getInboxStore,
  type InboxSnapshot,
  type InboxStore,
  READ_ALL_KEY,
  readKey,
  responseKey,
} from "./store";
import type { PaseoApi } from "./types";
import { ActionButton } from "./question-card";
import { FilterControls } from "./filter-controls";
import {
  boardLanes,
  boardReady,
  filterNeedsYouReason,
  groupCardsByProject,
  searchCards,
  searchLanes,
} from "./review";
import { isTextTarget, subscribeKeydown, type WebKeyEvent } from "./web";

const KEY_HINT =
  "j/k move · Enter preview · Shift+O agent · 1-9 answer · y/n allow/deny · m read · x archive · s snooze · ? help";
const LANE_ORDER: readonly Lane[] = ["needsYou", "working", "done"];
const LANE_TITLE: Record<Lane, string> = {
  needsYou: "Needs you",
  working: "Working",
  done: "Done",
};
const REASON_EMPTY: Record<NeedsReason, string> = {
  question: "No questions.",
  permission: "No approval requests.",
  error: "No errors.",
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
      search: {
        minWidth: 0,
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        maxWidth: 420,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        color: theme.colors.foreground,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 13,
      },
      status: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      schedules: { paddingHorizontal: padding, paddingBottom: 4 },
      needsYouActive: { borderColor: theme.colors.accent },
      lanes: { flex: 1, flexDirection: "row", gap: 16, padding },
      lane: {
        flex: 1,
        minWidth: 0,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingTop: 10,
      },
      laneContent: { paddingBottom: 12 },
      laneExtras: { paddingBottom: 8, gap: 8 },
      header: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
      headerTitle: {
        flex: 1,
        color: theme.colors.foregroundMuted,
        fontSize: 14,
        fontWeight: "600",
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
      empty: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        lineHeight: 20,
        paddingVertical: 20,
        paddingHorizontal: 4,
      },
      cards: { gap: 10 },
      groupLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        paddingTop: 4,
      },
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
  grouped,
}: {
  cards: InboxCard[];
  emptyText: string;
  styles: BoardStyles;
  theme: PluginTheme;
  paseo: PaseoApi;
  now: number;
  actions: CardActions;
  focusedId: string | null;
  grouped: boolean;
}) {
  if (cards.length === 0) {
    return <Text style={styles.empty}>{emptyText}</Text>;
  }
  const renderCard = (card: InboxCard) => (
    <InboxCardView
      key={card.agent.id}
      card={card}
      theme={theme}
      paseo={paseo}
      now={now}
      actions={actions}
      focused={card.agent.id === focusedId}
    />
  );
  if (!grouped) {
    return <View style={styles.cards}>{cards.map(renderCard)}</View>;
  }
  const groups = groupCardsByProject(cards);
  return (
    <View style={styles.cards}>
      {groups.map((group) => (
        <View key={group.key || "none"} style={styles.cards}>
          <Text style={styles.groupLabel}>{group.label}</Text>
          {group.cards.map(renderCard)}
        </View>
      ))}
    </View>
  );
}

function MarkAllReadRow({
  lane,
  lanes,
  actions,
  theme,
  styles,
}: {
  lane: Lane;
  lanes: Lanes;
  actions: CardActions;
  theme: PluginTheme;
  styles: BoardStyles;
}) {
  const operation = actions.operations.get(READ_ALL_KEY);
  const markAll = useCallback(
    () => actions.onMarkAllRead(lanes.done.map((card) => card.subject.id)),
    [actions, lanes.done],
  );
  if (lane !== "done" || lanes.done.length === 0 || !actions.canRespond) return null;
  return (
    <View style={styles.laneExtras}>
      <ActionButton
        theme={theme}
        label={operation?.status === "pending" ? "Marking read…" : "Mark all read"}
        onPress={markAll}
        disabled={operation?.status === "pending"}
      />
      {operation?.status === "failed" ? (
        <Text style={styles.error}>{operation.error ?? "Could not mark everything read."}</Text>
      ) : null}
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
  snoozedCount,
  filtered,
  next,
  retryLoad,
  retrySnoozed,
  search,
  onSearch,
  clearSearch,
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
  snoozedCount: number;
  filtered: boolean;
  next(): void;
  retryLoad(): void;
  retrySnoozed(): void;
  search: string;
  onSearch(value: string): void;
  clearSearch(): void;
}) {
  return (
    <View style={styles.toolbar}>
      <View style={styles.toolbarRow}>
        <TextInput
          accessibilityLabel="Search Kanban"
          placeholder="Search agents, projects, workspaces…"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={search}
          onChangeText={onSearch}
          style={styles.search}
        />
        {search ? <ActionButton theme={theme} label="Clear search" onPress={clearSearch} /> : null}
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
      </View>
      <View style={styles.toolbarRow}>
        <Text style={styles.status}>
          {lanes.needsYou.length ? `${lanes.needsYou.length} needing you` : "All caught up"} ·{" "}
          {lanes.working.length} working · {lanes.done.length} unread
          {snoozedCount ? ` · ${snoozedCount} snoozed` : ""}
          {filtered ? " in these projects" : ""}
        </Text>
        <ActionButton
          theme={theme}
          label="Review next"
          primary={lanes.needsYou.length > 0}
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
      {snapshot.snoozedLoadError ? (
        <View style={styles.toolbarRow}>
          <Text style={styles.error}>
            Could not load snoozed cards: {snapshot.snoozedLoadError}
          </Text>
          <ActionButton theme={theme} label="Retry" onPress={retrySnoozed} />
        </View>
      ) : null}
      {snapshot.snoozedError ? (
        <View style={styles.toolbarRow}>
          <Text style={styles.error}>Could not save snoozed cards: {snapshot.snoozedError}</Text>
          <ActionButton theme={theme} label="Retry" onPress={retrySnoozed} />
        </View>
      ) : null}
    </View>
  );
}

const INITIAL_COLLAPSED: Record<Lane, boolean> = { needsYou: false, working: true, done: true };

function emptyLanesText(
  filtered: boolean,
  reasonFilter: NeedsReason | null,
  search: string,
): Record<Lane, string> {
  let text: Record<Lane, string> = {
    needsYou: "All caught up. Questions, approvals, and errors will appear here.",
    working: "No agents working right now. Start a conversation to put an agent to work.",
    done: "No unread results. Completed work stays here until you mark it read.",
  };
  if (filtered)
    text = {
      needsYou: "No requests in these projects.",
      working: "No agents working in these projects.",
      done: "No unread results in these projects.",
    };
  if (reasonFilter) text = { ...text, needsYou: REASON_EMPTY[reasonFilter] };
  if (search.trim())
    text = {
      needsYou: "No requests match your search.",
      working: "No working agents match your search.",
      done: "No results match your search.",
    };
  return text;
}

export interface BoardKeyboardInput {
  actions: CardActions;
  isActive: boolean;
  filtersOpen: boolean;
  helpOpen: boolean;
  keyboard: boolean;
  platform: string;
  /** Host capabilities — dismiss keys must not move focus when they will no-op. */
  canRespond: boolean;
  canArchive: boolean;
  ordered: readonly InboxCard[];
  focusedId: string | null;
  openCardId: string | null;
  interactionRevision: { current: number };
  setFocusedId(id: string | null): void;
  setHelpOpen(open: boolean): void;
  open(card: InboxCard): void;
  closePeek(): void;
}

/** The operation key a dismiss/answer effect will land on, or null when the effect doesn't touch one. */
function operationKeyForEffect(
  effect: NonNullable<ReturnType<typeof resolveKeyAction>>,
): string | null {
  switch (effect.kind) {
    case "markRead":
      return readKey(effect.card.subject.id);
    case "archive":
      return archiveKey(effect.card.subject.id);
    case "respond":
      return responseKey(effect.card.subject.id, effect.request.id);
    default:
      return null;
  }
}

/** A card-focused dismiss/answer's outcome handler: restores focus only on a genuine failure. */
type FocusRestorer = (card: InboxCard) => (ok: boolean) => void;

/** The switch on `effect.kind`, split out of `applyKeyEffect` to keep its own complexity down. */
function dispatchKeyEffect(
  effect: NonNullable<ReturnType<typeof resolveKeyAction>>,
  input: BoardKeyboardInput,
  restoreFocusOnFailure: FocusRestorer,
): void {
  switch (effect.kind) {
    case "focus":
      input.setFocusedId(effect.agentId);
      break;
    case "open": {
      input.setFocusedId(effect.agentId);
      const card = input.ordered.find((item) => item.agent.id === effect.agentId);
      if (card) input.open(card);
      break;
    }
    case "openAgent":
      input.actions.onOpenAgent?.(effect.agentId);
      break;
    case "close":
      input.closePeek();
      break;
    case "help":
      input.setHelpOpen(true);
      break;
    case "markRead":
      input.setFocusedId(effect.nextFocusAgentId);
      void input.actions
        .onMarkRead(effect.card.subject.id)
        .then(restoreFocusOnFailure(effect.card));
      break;
    case "archive":
      input.setFocusedId(effect.nextFocusAgentId);
      void input.actions.onArchive(effect.card.subject.id).then(restoreFocusOnFailure(effect.card));
      break;
    case "snooze":
      input.setFocusedId(effect.nextFocusAgentId);
      input.actions.onSnooze(effect.card);
      break;
    case "respond":
      input.setFocusedId(effect.nextFocusAgentId);
      void input.actions
        .onRespond(
          effect.card.subject.id,
          effect.request.id,
          effect.response,
          effect.nextFocusAgentId,
        )
        .then(restoreFocusOnFailure(effect.card));
      break;
  }
}

/** Dispatches a resolved effect; keep the keydown listener free of branch logic. */
export function applyKeyEffect(
  effect: NonNullable<ReturnType<typeof resolveKeyAction>>,
  input: BoardKeyboardInput,
): void {
  if (
    (effect.kind === "archive" && !input.canArchive) ||
    ((effect.kind === "markRead" || effect.kind === "respond") && !input.canRespond)
  ) {
    return;
  }
  // An operation already in flight for this key resolves `false` on its own
  // completion (see `run` in store.ts) even though nothing actually failed —
  // that would snap focus back onto a card mid-dismissal. Leave it alone.
  const operationKey = operationKeyForEffect(effect);
  if (operationKey && input.actions.operations.get(operationKey)?.status === "pending") {
    return;
  }
  input.interactionRevision.current += 1;
  // Captured after the bump above: a later interaction (opening a different
  // card, say) advances this and tells the restore below to stand down.
  const revisionAtDispatch = input.interactionRevision.current;
  // A failed dismiss/answer must not leave focus on the neighbor it jumped to
  // pre-emptively — land back on the card that is still actually there.
  const restoreFocusOnFailure: FocusRestorer = (card) => (ok) => {
    if (!ok && input.interactionRevision.current === revisionAtDispatch) {
      input.setFocusedId(card.agent.id);
    }
  };
  dispatchKeyEffect(effect, input, restoreFocusOnFailure);
}

function useBoardKeyboard(input: BoardKeyboardInput): void {
  const { isActive, filtersOpen, keyboard, platform } = input;
  // The listener reads the live input each keypress so the subscription can
  // persist across focus/peek changes instead of re-subscribing every render.
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!isActive || filtersOpen || !keyboard || platform !== "web") return;
    const handle = (event: WebKeyEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || isTextTarget(event.target))
        return;
      const live = latest.current;
      if (live.helpOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          live.setHelpOpen(false);
        }
        return;
      }
      // The peek can select a child independently. Never answer a background card.
      if (live.openCardId) {
        if (event.key === "Escape") {
          event.preventDefault();
          live.closePeek();
        }
        return;
      }
      const action = keyToAction(event);
      if (!action) return;
      const effect = resolveKeyAction(action, {
        ordered: live.ordered,
        focusedId: live.focusedId,
        openCardId: live.openCardId,
      });
      if (!effect) return;
      event.preventDefault();
      applyKeyEffect(effect, live);
    };
    return subscribeKeydown(handle);
  }, [isActive, filtersOpen, keyboard, platform]);
}

interface LaneListExtrasProps {
  lane: Lane;
  lanes: Lanes;
  styles: BoardStyles;
  theme: PluginTheme;
  actions: CardActions;
  now: number;
  snoozed: InboxCard[];
  showSnoozed: boolean;
  onToggleSnoozed(): void;
  /** Compact sections show snoozed rows directly instead of behind a toggle. */
  compact: boolean;
}

/** The bulk action for Done plus the needs-you lane's snoozed section. */
function LaneListExtras({
  lane,
  lanes,
  styles,
  theme,
  actions,
  now,
  snoozed,
  showSnoozed,
  onToggleSnoozed,
  compact,
}: LaneListExtrasProps) {
  return (
    <>
      <MarkAllReadRow lane={lane} lanes={lanes} actions={actions} theme={theme} styles={styles} />
      {lane === "needsYou" && snoozed.length > 0 ? (
        <View style={styles.laneExtras}>
          {compact ? null : (
            <ActionButton
              theme={theme}
              label={showSnoozed ? "Hide snoozed" : `Show ${snoozed.length} snoozed`}
              onPress={onToggleSnoozed}
            />
          )}
          {compact || showSnoozed ? (
            <SnoozedSection cards={snoozed} theme={theme} now={now} actions={actions} />
          ) : null}
        </View>
      ) : null}
    </>
  );
}

interface LaneViewProps {
  styles: BoardStyles;
  theme: PluginTheme;
  paseo: PaseoApi;
  now: number;
  actions: CardActions;
  focusedId: string | null;
  grouped: boolean;
  lanes: Lanes;
  /** Visible + snoozed waiting cards, post-search and pre-reason-filter — feeds chips. */
  searchedNeedsYou: InboxCard[];
  reasonFilter: NeedsReason | null;
  onSelectReason(reason: NeedsReason | null): void;
  snoozed: InboxCard[];
  showSnoozed: boolean;
  onToggleSnoozed(): void;
  emptyText: Record<Lane, string>;
  laneStyles: Record<Lane, StyleProp<ViewStyle>>;
  collapsed: Record<Lane, boolean>;
  onToggleLane(lane: Lane): void;
}

function CompactLanes(props: LaneViewProps) {
  return (
    <ScrollView testID="inbox-lanes" contentContainerStyle={props.styles.compactContent}>
      {LANE_ORDER.map((lane) => (
        <View key={lane} testID={`inbox-lane-${lane}`}>
          <LaneHeader
            lane={lane}
            count={props.lanes[lane].length}
            styles={props.styles}
            collapsed={props.collapsed[lane]}
            onToggle={props.onToggleLane}
          />
          {props.collapsed[lane] ? null : (
            <View style={props.styles.cards}>
              {lane === "needsYou" ? (
                <ReasonChips
                  cards={props.searchedNeedsYou}
                  selected={props.reasonFilter}
                  theme={props.theme}
                  onSelect={props.onSelectReason}
                />
              ) : null}
              <LaneListExtras
                lane={lane}
                lanes={props.lanes}
                styles={props.styles}
                theme={props.theme}
                actions={props.actions}
                now={props.now}
                snoozed={props.snoozed}
                showSnoozed={props.showSnoozed}
                onToggleSnoozed={props.onToggleSnoozed}
                compact
              />
              <LaneBody
                cards={props.lanes[lane]}
                emptyText={props.emptyText[lane]}
                styles={props.styles}
                theme={props.theme}
                paseo={props.paseo}
                now={props.now}
                actions={props.actions}
                focusedId={props.focusedId}
                grouped={props.grouped}
              />
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

function DesktopLanes(props: LaneViewProps) {
  return (
    <View testID="inbox-lanes" style={props.styles.lanes}>
      {LANE_ORDER.map((lane) => (
        <View key={lane} testID={`inbox-lane-${lane}`} style={props.laneStyles[lane]}>
          <LaneHeader
            lane={lane}
            count={props.lanes[lane].length}
            styles={props.styles}
            collapsed={null}
          />
          {lane === "needsYou" &&
          (props.searchedNeedsYou.length > 0 || props.reasonFilter !== null) ? (
            <View style={props.styles.laneExtras}>
              <ReasonChips
                cards={props.searchedNeedsYou}
                selected={props.reasonFilter}
                theme={props.theme}
                onSelect={props.onSelectReason}
              />
            </View>
          ) : null}
          <ScrollView contentContainerStyle={props.styles.laneContent}>
            <LaneListExtras
              lane={lane}
              lanes={props.lanes}
              styles={props.styles}
              theme={props.theme}
              actions={props.actions}
              now={props.now}
              snoozed={props.snoozed}
              showSnoozed={props.showSnoozed}
              onToggleSnoozed={props.onToggleSnoozed}
              compact={false}
            />
            <LaneBody
              cards={props.lanes[lane]}
              emptyText={props.emptyText[lane]}
              styles={props.styles}
              theme={props.theme}
              paseo={props.paseo}
              now={props.now}
              actions={props.actions}
              focusedId={props.focusedId}
              grouped={props.grouped}
            />
          </ScrollView>
        </View>
      ))}
    </View>
  );
}

interface CardActionsInput {
  store: InboxStore | null;
  navigation: PluginSurfaceProps["navigation"];
  isActive: boolean;
  canRespond: boolean;
  canArchive: boolean;
  canCheckout: boolean;
  snapshot: InboxSnapshot;
  candidates(): InboxCard[];
  openCardId: string | null;
  open(card: InboxCard): void;
  interactionRevision: { current: number };
  setFocusedId(id: string | null): void;
  setOpenCardId(id: string | null): void;
  setPeekAgentId(id: string | null): void;
}

/** Builds the shared action surface for cards, peeks, and lane extras. */
function useCardActions(input: CardActionsInput): CardActions {
  const {
    store,
    navigation,
    isActive,
    canRespond,
    canArchive,
    canCheckout,
    snapshot,
    candidates,
    openCardId,
    open,
    interactionRevision,
    setFocusedId,
    setOpenCardId,
    setPeekAgentId,
  } = input;
  return useMemo(
    () => ({
      canRespond,
      canArchive,
      canCheckout,
      active: isActive,
      drafts: snapshot.drafts,
      draftsReady: snapshot.draftsReady,
      draftsError: snapshot.draftsError,
      onRetryDrafts: () => store?.retryDrafts(),
      operations: snapshot.operations,
      onDraft: (agentId, text) => store?.setDraft(agentId, text),
      onRespond: (agentId, requestId, response, nextFocusAgentId) => {
        if (!store || !isActive || !canRespond) return Promise.resolve(false);
        const revision = interactionRevision.current;
        return store.respond(agentId, requestId, response).then((sent) => {
          // A slow response must not pull the user away from a card they opened meanwhile.
          if (!sent || revision !== interactionRevision.current) return sent;
          // The keyboard path already knows its intended next focus and must
          // land there instead of jumping to the queue head; it does not touch the peek.
          if (nextFocusAgentId !== undefined) {
            setFocusedId(nextFocusAgentId);
            return sent;
          }
          const card = candidates()[0];
          setFocusedId(card?.agent.id ?? null);
          if (openCardId) {
            setOpenCardId(card?.agent.id ?? null);
            setPeekAgentId(card?.subject.id ?? null);
          }
          return sent;
        });
      },
      onReply: (agentId) => {
        if (isActive) void store?.sendReply(agentId);
      },
      onMarkRead: (agentId) => {
        if (!isActive || !store) return Promise.resolve(false);
        return store.markRead(agentId);
      },
      onMarkAllRead: (agentIds) => {
        if (isActive && canRespond) void store?.markAllRead(agentIds);
      },
      onArchive: (agentId) => {
        if (!isActive || !canArchive || !store) return Promise.resolve(false);
        return store.archive(agentId);
      },
      onSnooze: (card) => {
        if (isActive) store?.snooze(card);
      },
      onUnsnooze: (agentId) => {
        if (isActive) store?.unsnooze(agentId);
      },
      onOpen: open,
      onOpenAgent: navigation
        ? (agentId) => {
            interactionRevision.current += 1;
            navigation.openAgent({ agentId });
            setOpenCardId(null);
          }
        : undefined,
    }),
    [
      canRespond,
      canArchive,
      canCheckout,
      isActive,
      navigation,
      snapshot.drafts,
      snapshot.draftsReady,
      snapshot.draftsError,
      snapshot.operations,
      store,
      candidates,
      openCardId,
      open,
      interactionRevision,
      setFocusedId,
      setOpenCardId,
      setPeekAgentId,
    ],
  );
}

interface BoardDerived {
  unfilteredLanes: ReturnType<typeof boardLanes>;
  searchedLanes: Lanes;
  lanes: Lanes;
  /** Snoozed cards after search but before the reason filter — for chip counts. */
  searchedSnoozed: InboxCard[];
  snoozed: InboxCard[];
  ordered: InboxCard[];
  grouped: boolean;
  filtered: boolean;
  emptyText: Record<Lane, string>;
}

/** The view pipeline: project/workspace scope -> search -> snooze split -> reason filter. */
function useBoardDerived(
  snapshot: InboxSnapshot,
  workspaceId: string | undefined,
  search: string,
  reasonFilter: NeedsReason | null,
): BoardDerived {
  const unfilteredLanes = useMemo(() => boardLanes(snapshot, workspaceId), [snapshot, workspaceId]);
  const searchedLanes = useMemo(
    () => searchLanes(unfilteredLanes, search),
    [unfilteredLanes, search],
  );
  const lanes = useMemo(
    () => filterNeedsYouReason(searchedLanes, reasonFilter),
    [searchedLanes, reasonFilter],
  );
  const searchedSnoozed = useMemo(
    () => searchCards(unfilteredLanes.snoozed, search),
    [unfilteredLanes.snoozed, search],
  );
  const snoozed = useMemo(
    () =>
      reasonFilter
        ? searchedSnoozed.filter((card) => card.reason === reasonFilter)
        : searchedSnoozed,
    [searchedSnoozed, reasonFilter],
  );
  const ordered = useMemo(() => LANE_ORDER.flatMap((lane) => lanes[lane]), [lanes]);
  const grouped = !workspaceId && snapshot.filters.groupByProject;
  const filtered = Boolean(
    !workspaceId && (snapshot.filters.projectId !== null || snapshot.filters.projectGroup !== null),
  );
  return {
    unfilteredLanes,
    searchedLanes,
    lanes,
    searchedSnoozed,
    snoozed,
    ordered,
    grouped,
    filtered,
    emptyText: emptyLanesText(filtered, reasonFilter, search),
  };
}

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

  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [reasonFilter, setReasonFilter] = useState<NeedsReason | null>(null);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const store = getInboxStore();
  const interactionRevision = useRef(0);
  const {
    unfilteredLanes,
    searchedLanes,
    lanes,
    searchedSnoozed,
    snoozed,
    ordered,
    grouped,
    filtered,
    emptyText,
  } = useBoardDerived(snapshot, workspaceId, search, reasonFilter);
  // Snoozed cards are off `ordered` but their rows still offer a preview.
  const openCard =
    ordered.find((card) => card.agent.id === openCardId) ??
    snoozed.find((card) => card.agent.id === openCardId) ??
    null;
  const openPosition = openCard
    ? lanes.needsYou.findIndex((card) => card.agent.id === openCard.agent.id) + 1 || null
    : null;
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
  const changeReason = useCallback(
    (reason: NeedsReason | null) => {
      changeFilters();
      setReasonFilter((current) => (current === reason ? null : reason));
    },
    [changeFilters],
  );

  const changeSearch = useCallback(
    (value: string) => {
      changeFilters();
      setSearch(value);
    },
    [changeFilters],
  );
  const clearSearch = useCallback(() => changeSearch(""), [changeSearch]);
  useEffect(() => {
    interactionRevision.current += 1;
    // The peek's `open` prop tracks `actions.active`, not `openCardId`, so leaving it
    // set here would reopen the peek on the same card the moment the surface reactivates.
    if (!isActive) {
      setOpenCardId(null);
      setPeekAgentId(null);
      setHelpOpen(false);
      setFiltersOpen(false);
    }
  }, [isActive]);
  const pendingOpenAgentId = snapshot.pendingOpenAgentId;
  useEffect(() => {
    if (!isActive || workspaceId || !pendingOpenAgentId || !store) return;
    const card = LANE_ORDER.flatMap((lane) => unfilteredLanes[lane])
      .concat(unfilteredLanes.snoozed)
      .find((item) => item.agent.id === pendingOpenAgentId);
    if (!card) return;
    setSearch("");
    setReasonFilter(null);
    open(card);
    store.clearPendingOpen();
  }, [isActive, workspaceId, pendingOpenAgentId, store, unfilteredLanes, open]);

  const candidates = useCallback(() => {
    const current = store?.getSnapshot();
    if (!current) return [];
    return filterNeedsYouReason(searchLanes(boardLanes(current, workspaceId), search), reasonFilter)
      .needsYou;
  }, [store, workspaceId, search, reasonFilter]);
  const next = useCallback(() => {
    const queue = candidates();
    const index = queue.findIndex((card) => card.agent.id === openCardId);
    const card = queue[(index + 1) % queue.length];
    if (card) open(card);
  }, [candidates, open, openCardId]);

  const probe = paseo.agents.ref("__inbox_probe__");
  const canRespond =
    typeof probe.respondToPermission === "function" && typeof probe.clearAttention === "function";
  const canArchive = typeof probe.archive === "function";
  const canCheckout =
    typeof paseo.checkout?.prStatus === "function" && typeof paseo.checkout?.diff === "function";
  const actions = useCardActions({
    store,
    navigation,
    isActive,
    canRespond,
    canArchive,
    canCheckout,
    snapshot,
    candidates,
    openCardId,
    open,
    interactionRevision,
    setFocusedId,
    setOpenCardId,
    setPeekAgentId,
  });

  const toggleLane = useCallback(
    (lane: Lane) => setCollapsed((value) => ({ ...value, [lane]: !value[lane] })),
    [],
  );
  const toggleSnoozed = useCallback(() => setShowSnoozed((value) => !value), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  const showsKeyHint = isActive && keyboard && layout.platform === "web" && !layout.compact;
  useBoardKeyboard({
    actions,
    isActive,
    filtersOpen,
    helpOpen,
    keyboard,
    platform: layout.platform,
    canRespond,
    canArchive,
    ordered,
    focusedId,
    openCardId,
    interactionRevision,
    setFocusedId,
    setHelpOpen,
    open,
    closePeek,
  });

  // Widths and the needs-you accent track the searched (pre-reason-filter) lanes:
  // a reason chip that matches nothing must not shrink the lane or drop the signal.
  const laneStyles = useMemo(
    () =>
      Object.fromEntries(
        LANE_ORDER.map((lane) => [
          lane,
          [
            styles.lane,
            { flexGrow: laneFlexGrow(searchedLanes[lane].length) },
            lane === "needsYou" && searchedLanes.needsYou.length > 0 ? styles.needsYouActive : null,
          ],
        ]),
      ) as Record<Lane, StyleProp<ViewStyle>>,
    [searchedLanes, styles],
  );

  const searchedWaiting = useMemo(
    () => [...searchedLanes.needsYou, ...searchedSnoozed],
    [searchedLanes, searchedSnoozed],
  );
  const retryLoad = useCallback(() => {
    void store?.retryLoad();
  }, [store]);
  const retrySnoozed = useCallback(() => store?.retrySnoozed(), [store]);
  if (activity === undefined)
    return <Text style={styles.loading}>Update this Paseo app to use Kanban.</Text>;
  const laneViewProps: LaneViewProps = {
    styles,
    theme,
    paseo,
    now,
    actions,
    focusedId,
    grouped,
    lanes,
    searchedNeedsYou: searchedWaiting,
    reasonFilter,
    onSelectReason: changeReason,
    snoozed,
    showSnoozed,
    onToggleSnoozed: toggleSnoozed,
    emptyText,
    laneStyles,
    collapsed,
    onToggleLane: toggleLane,
  };
  let content: React.ReactNode;
  if (!boardReady(snapshot, workspaceId)) {
    content = snapshot.loading ? (
      <Text style={styles.loading}>Loading agents and saved filters…</Text>
    ) : null;
  } else if (layout.compact) {
    content = <CompactLanes {...laneViewProps} />;
  } else {
    content = <DesktopLanes {...laneViewProps} />;
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
        snoozedCount={snoozed.length}
        filtered={filtered}
        next={next}
        retryLoad={retryLoad}
        retrySnoozed={retrySnoozed}
        search={search}
        onSearch={changeSearch}
        clearSearch={clearSearch}
      />
      {!workspaceId ? (
        <View style={styles.schedules}>
          <SchedulesStrip paseo={paseo} theme={theme} active={isActive} now={now} />
        </View>
      ) : null}
      {content}
      {showsKeyHint ? <Text style={styles.hint}>{KEY_HINT}</Text> : null}
      <ShortcutHelp open={helpOpen} theme={theme} onClose={closeHelp} />
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
          position={openPosition}
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
