import type { PluginTheme } from "@getpaseo/plugin";

import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { activityInFlight, formatSince, type InboxCard, quietText, urgencyLevel } from "./lanes";
import { ActionButton } from "./question-card";
import { PrChip, prChipModel, useCheckoutPrStatus } from "./pr-status";
import { lastAssistantLine, latestActivity } from "./timeline-text";
import type { Agent, PaseoApi, PermissionResponse } from "./types";

import { OperationFeedback, ReplyComposer, RequestControls } from "./controls";
import { archiveKey, readKey, type Operation } from "./store";

export interface CardActions {
  canRespond: boolean;
  canArchive: boolean;
  canCheckout: boolean;
  active: boolean;
  drafts: ReadonlyMap<string, string>;
  draftsReady: boolean;
  draftsError: string | null;
  onRetryDrafts(): void;
  operations: ReadonlyMap<string, Operation>;
  onDraft(agentId: string, text: string): void;
  onRespond(agentId: string, requestId: string, response: PermissionResponse): void;
  onReply(agentId: string): void;
  onMarkRead(agentId: string): void;
  onMarkAllRead(agentIds: readonly string[]): void;
  onArchive(agentId: string): void;
  onSnooze(card: InboxCard): void;
  onUnsnooze(agentId: string): void;
  onOpen(card: InboxCard): void;
  onOpenAgent?: (agentId: string) => void;
}

export function cardTitle(card: InboxCard): string {
  return card.agent.title?.trim() || card.workspace?.name || card.agent.provider;
}

export function useLastAssistantLine(paseo: PaseoApi, agent: Agent, enabled: boolean) {
  return useQuery({
    queryKey: ["inbox", "tail", agent.id, agent.updatedAt],
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const page = await paseo.agents
        .ref(agent.id)
        .timeline.refetch({ direction: "tail", limit: 12, projection: "projected" });
      return lastAssistantLine(page.entries.map((entry) => entry.item));
    },
  });
}

export interface WorkingActivity {
  text: string | null;
  /** Sequence of the newest timeline row; a stall means the agent produced nothing. */
  lastSeq: number | null;
  /** When the newest row landed — the quiet clock anchors here, not at first poll. */
  lastAt: string | null;
  /** The newest row is a tool or compaction still running — silence is expected. */
  inFlight: boolean;
}

/**
 * Working cards poll the timeline tail. The daemon streams agent events only
 * for agents the app has opened, so a plugin cannot subscribe to an agent it
 * has not viewed; a short poll while the card is mounted is the alternative.
 */
export function useWorkingActivity(paseo: PaseoApi, agent: Agent, enabled: boolean) {
  return useQuery({
    queryKey: ["inbox", "activity", agent.id],
    enabled,
    refetchInterval: enabled ? 4000 : false,
    queryFn: async (): Promise<WorkingActivity> => {
      const page = await paseo.agents
        .ref(agent.id)
        .timeline.refetch({ direction: "tail", limit: 8, projection: "projected" });
      const newest = page.entries.at(-1);
      return {
        text: latestActivity(page.entries.map((entry) => entry.item)),
        lastSeq: newest?.seqEnd ?? null,
        lastAt: newest?.timestamp ?? null,
        inFlight: activityInFlight(newest?.item),
      };
    },
  });
}

function metaParts(card: InboxCard): string {
  const parts: string[] = [card.agent.provider];
  if (card.agent.model) parts.push(card.agent.model);
  const diff = card.workspace?.diffStat;
  if (diff && (diff.additions > 0 || diff.deletions > 0)) {
    parts.push(`+${diff.additions} −${diff.deletions}`);
  }
  if (card.subagentCount > 0) {
    parts.push(`${card.subagentCount} subagent${card.subagentCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

const REASON_LABEL: Record<InboxCard["reason"], string> = {
  question: "Question",
  permission: "Approval",
  error: "Error",
  working: "Working",
  finished: "Finished",
};

function urgencyColor(card: InboxCard, now: number, theme: PluginTheme): string {
  const level = urgencyLevel(card, now);
  if (level === "danger") return theme.colors.statusDanger;
  if (level === "warn") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

/** A colored left edge makes the needs-you reason scannable at a glance. */
function stripeColor(card: InboxCard, theme: PluginTheme): string | null {
  if (card.lane !== "needsYou") return null;
  if (card.reason === "error") return theme.colors.statusDanger;
  if (card.reason === "permission") return theme.colors.statusWarning;
  return theme.colors.accent;
}

function useCardStyles(theme: PluginTheme, focused: boolean) {
  return useMemo(
    () =>
      StyleSheet.create({
        shell: {
          flexDirection: "row",
          backgroundColor: theme.colors.surface1,
          borderColor: focused ? theme.colors.accent : theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          overflow: "hidden",
        },
        content: { flex: 1, minWidth: 0, padding: 14, gap: 12 },
        compactContent: { flex: 1, minWidth: 0, padding: 12, gap: 6 },
        actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
        context: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
        label: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
        titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
        title: {
          flex: 1,
          color: theme.colors.foreground,
          fontSize: 14,
          lineHeight: 20,
          fontWeight: "600",
        },
        metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
        meta: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 },
        since: { flex: 0, fontSize: 12 },
        muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
        error: { color: theme.colors.statusDanger, fontSize: 13 },
        body: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        finished: { gap: 8 },
      }),
    [focused, theme],
  );
}

function timeLabel(card: InboxCard): string {
  if (card.reason === "working") return "running";
  if (card.reason === "finished") return "ago";
  return "waiting";
}

function finishedText(line: string | null | undefined, pending: boolean): string {
  if (line) return line;
  return pending ? "…" : "Finished.";
}

function CardBody({
  card,
  theme,
  paseo,
  actions,
  focused = false,
}: {
  card: InboxCard;
  theme: PluginTheme;
  paseo: PaseoApi;
  actions: CardActions;
  focused?: boolean;
}) {
  const tail = useLastAssistantLine(
    paseo,
    card.subject,
    actions.active && card.reason === "finished",
  );
  const styles = useCardStyles(theme, focused);
  const readOperation = actions.operations.get(readKey(card.subject.id));

  const markRead = useCallback(
    () => actions.onMarkRead(card.subject.id),
    [actions, card.subject.id],
  );

  let body: React.ReactNode = null;
  if (card.request && (card.reason === "question" || card.reason === "permission")) {
    body = (
      <RequestControls
        agentId={card.subject.id}
        request={card.request}
        theme={theme}
        actions={actions}
      />
    );
  } else if (card.reason === "error") {
    body = (
      <Text numberOfLines={3} style={styles.error}>
        {card.subject.lastError ?? "The agent stopped with an error."}
      </Text>
    );
  } else {
    body = (
      <View style={styles.finished}>
        <Text style={styles.label}>Latest result</Text>
        <Text numberOfLines={3} style={styles.body}>
          {finishedText(tail.data, tail.isPending)}
        </Text>
        {tail.isError ? (
          <Text style={styles.error}>Could not load the result. Open the card to retry.</Text>
        ) : null}
        <ReplyComposer agent={card.subject} theme={theme} actions={actions} />
        <View style={styles.actions}>
          <ActionButton
            theme={theme}
            label={readOperation?.status === "pending" ? "Marking read…" : "Mark read"}
            onPress={markRead}
            disabled={readOperation?.status === "pending"}
          />
        </View>
        <OperationFeedback theme={theme} operation={readOperation} />
      </View>
    );
  }

  return body;
}

function CardActionRow({
  card,
  theme,
  actions,
  styles,
  open,
  openAgent,
  snooze,
  archive,
  archivePending,
}: {
  card: InboxCard;
  theme: PluginTheme;
  actions: CardActions;
  styles: ReturnType<typeof useCardStyles>;
  open(): void;
  openAgent(): void;
  snooze(): void;
  archive(): void;
  archivePending: boolean;
}) {
  return (
    <View style={styles.actions}>
      <ActionButton theme={theme} label="Preview" onPress={open} />
      {actions.onOpenAgent ? (
        <ActionButton theme={theme} label="Open agent" onPress={openAgent} />
      ) : null}
      {card.lane === "needsYou" ? (
        <ActionButton theme={theme} label="Snooze" onPress={snooze} />
      ) : null}
      {card.lane === "done" && actions.canArchive ? (
        <ActionButton
          theme={theme}
          label={archivePending ? "Archiving…" : "Archive"}
          onPress={archive}
          disabled={archivePending}
        />
      ) : null}
    </View>
  );
}

/** Working cards carry no controls; they render compact with a live activity line. */
function WorkingBody({
  card,
  theme,
  paseo,
  actions,
  now,
}: {
  card: InboxCard;
  theme: PluginTheme;
  paseo: PaseoApi;
  actions: CardActions;
  now: number;
}) {
  const activity = useWorkingActivity(paseo, card.subject, actions.active);
  const styles = useCardStyles(theme, false);
  const quiet = quietText(activity.data?.lastAt ?? null, activity.data?.inFlight ?? false, now);
  const text = activity.data?.text ?? (activity.isPending ? "Loading activity…" : "Working…");
  return (
    <View>
      <Text numberOfLines={1} style={styles.muted}>
        {text}
        {quiet ? ` · ${quiet}` : ""}
      </Text>
      {activity.isError ? (
        <Text style={styles.error}>Activity unavailable. Open agent for the live view.</Text>
      ) : null}
    </View>
  );
}

export function InboxCardView({
  card,
  theme,
  paseo,
  now,
  actions,
  focused = false,
}: {
  card: InboxCard;
  theme: PluginTheme;
  paseo: PaseoApi;
  now: number;
  actions: CardActions;
  focused?: boolean;
}) {
  const styles = useCardStyles(theme, focused);
  const since = formatSince(card.since, now);
  const open = useCallback(() => actions.onOpen(card), [actions, card]);
  const openAgent = useCallback(
    () => actions.onOpenAgent?.(card.subject.id),
    [actions, card.subject.id],
  );
  const snooze = useCallback(() => actions.onSnooze(card), [actions, card]);
  const archive = useCallback(() => actions.onArchive(card.subject.id), [actions, card.subject.id]);
  const cwd = card.workspace?.workspaceDirectory ?? null;
  const pr = useCheckoutPrStatus(paseo, cwd, actions.active && actions.canCheckout);
  const chip = prChipModel(pr.data);
  const archiveOperation = actions.operations.get(archiveKey(card.subject.id));
  const stripe = stripeColor(card, theme);
  const compact = card.reason === "working";
  const shellStyle = useMemo(
    () => [styles.shell, stripe ? { borderLeftWidth: 3, borderLeftColor: stripe } : null],
    [styles.shell, stripe],
  );
  const sinceStyle = useMemo(
    () => [styles.since, { color: urgencyColor(card, now, theme) }],
    [styles.since, card, now, theme],
  );
  return (
    <View style={shellStyle}>
      <View style={compact ? styles.compactContent : styles.content}>
        {card.workspace ? (
          <Text numberOfLines={2} style={styles.context}>
            {card.workspace.projectDisplayName} / {card.workspace.name}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Preview ${cardTitle(card)}`}
          onPress={open}
          style={styles.titleRow}
        >
          <Text numberOfLines={compact ? 1 : 2} style={styles.title}>
            {cardTitle(card)}
          </Text>
          <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
        {chip ? <PrChip model={chip} theme={theme} /> : null}
        {card.subject.id !== card.agent.id ? (
          <Text style={styles.muted}>Subagent: {card.subject.title || card.subject.provider}</Text>
        ) : null}
        {compact ? (
          <WorkingBody card={card} theme={theme} paseo={paseo} actions={actions} now={now} />
        ) : (
          <CardBody card={card} theme={theme} paseo={paseo} actions={actions} />
        )}
        <View style={styles.metaRow}>
          <Text numberOfLines={1} style={styles.meta}>
            {REASON_LABEL[card.reason]} · {metaParts(card)}
          </Text>
          {since ? (
            <Text style={sinceStyle}>
              {since} {timeLabel(card)}
            </Text>
          ) : null}
        </View>
        {compact ? null : (
          <CardActionRow
            card={card}
            theme={theme}
            actions={actions}
            styles={styles}
            open={open}
            openAgent={openAgent}
            snooze={snooze}
            archive={archive}
            archivePending={archiveOperation?.status === "pending"}
          />
        )}
        <OperationFeedback theme={theme} operation={archiveOperation} />
      </View>
    </View>
  );
}
