import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatSince, type InboxCard } from "./lanes";
import { ActionButton } from "./question-card";
import { describeToolCall, lastToolCall } from "./detail-text";
import { lastAssistantLine } from "./timeline-text";
import type { Agent, PaseoApi, PermissionResponse } from "./types";

import { OperationFeedback, ReplyComposer, RequestControls } from "./controls";
import { readKey, type Operation } from "./store";

export interface CardActions {
  canRespond: boolean;
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
  onOpen(card: InboxCard): void;
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
    queryFn: async () => {
      const page = await paseo.agents
        .ref(agent.id)
        .timeline.refetch({ direction: "tail", limit: 8, projection: "projected" });
      const item = lastToolCall(page.entries.map((entry) => entry.item));
      return item ? describeToolCall(item) : null;
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
        content: { flex: 1, padding: 12, gap: 10 },
        titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
        title: { flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
        metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
        meta: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 },
        since: { color: theme.colors.foregroundMuted, fontSize: 12 },
        muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
        error: { color: theme.colors.statusDanger, fontSize: 13 },
        body: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        finished: { gap: 8 },
      }),
    [focused, theme],
  );
}

function finishedText(line: string | null | undefined, pending: boolean): string {
  if (line) return line;
  return pending ? "…" : "Finished.";
}

function CardBody({
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
  const tail = useLastAssistantLine(
    paseo,
    card.subject,
    actions.active && card.reason === "finished",
  );
  const activity = useWorkingActivity(
    paseo,
    card.subject,
    actions.active && card.reason === "working",
  );
  const styles = useCardStyles(theme, focused);
  const since = formatSince(card.since, now);
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
  } else if (card.reason === "working") {
    body = (
      <Text numberOfLines={2} style={styles.body}>
        {activity.data ?? (activity.isPending ? "…" : "Thinking")}
        <Text style={styles.muted}> · {since || "a moment"}</Text>
      </Text>
    );
  } else {
    body = (
      <View style={styles.finished}>
        <Text numberOfLines={3} style={styles.body}>
          {finishedText(tail.data, tail.isPending)}
        </Text>
        {tail.isError ? (
          <Text style={styles.error}>Could not load the result. Open the card to retry.</Text>
        ) : null}
        <ReplyComposer agent={card.subject} theme={theme} actions={actions} />
        <ActionButton
          theme={theme}
          label={readOperation?.status === "pending" ? "Marking read…" : "Mark read"}
          onPress={markRead}
          disabled={readOperation?.status === "pending"}
        />
        <OperationFeedback theme={theme} operation={readOperation} />
      </View>
    );
  }

  return body;
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
  return (
    <View style={styles.shell}>
      <View style={styles.content}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${cardTitle(card)}`}
          onPress={open}
          style={styles.titleRow}
        >
          <Text numberOfLines={1} style={styles.title}>
            {cardTitle(card)}
          </Text>
          <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
        {card.subject.id !== card.agent.id ? (
          <Text style={styles.muted}>Subagent: {card.subject.title || card.subject.provider}</Text>
        ) : null}
        <CardBody card={card} theme={theme} paseo={paseo} now={now} actions={actions} />
        {card.workspace ? (
          <Text style={styles.meta}>
            {card.workspace.projectDisplayName} / {card.workspace.name}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <Text numberOfLines={1} style={styles.meta}>
            {metaParts(card)}
          </Text>
          {since ? <Text style={styles.since}>{since}</Text> : null}
        </View>
      </View>
    </View>
  );
}
