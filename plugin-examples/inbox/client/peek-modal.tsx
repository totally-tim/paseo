import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { type CardActions, cardTitle } from "./card";
import { OperationFeedback, ReplyComposer, RequestControls } from "./controls";
import type { InboxCard } from "./lanes";
import { ActionButton } from "./question-card";
import { readKey } from "./store";
import { itemToPeekRow, type PeekRow } from "./timeline-text";
import type { Agent, PaseoApi } from "./types";

const ROLE_LABEL: Record<PeekRow["role"], string> = {
  you: "You",
  agent: "Agent",
  tool: "Tool",
  thinking: "Thinking",
  system: "System",
};

function memberStatus(agent: Agent): string {
  if (agent.pendingPermissions.length) return "Needs you";
  if (agent.status === "error" || agent.attentionReason === "error") return "Error";
  if (agent.status === "running" || agent.status === "initializing") return "Working";
  if (agent.attentionReason === "finished") return "Done";
  return "Idle";
}

function usePeekStyles(theme: PluginTheme) {
  return useMemo(
    () =>
      StyleSheet.create({
        container: { gap: 12 },
        row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
        subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
        text: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        error: { color: theme.colors.statusDanger, fontSize: 13 },
        section: { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12, gap: 8 },
        members: { gap: 6 },
        speech: { gap: 4 },
        member: {
          padding: 10,
          borderWidth: 1,
          borderRadius: 8,
          borderColor: theme.colors.border,
          gap: 4,
        },
        selected: {
          padding: 10,
          borderWidth: 1,
          borderRadius: 8,
          borderColor: theme.colors.accent,
          gap: 4,
          backgroundColor: theme.colors.surface2,
        },
      }),
    [theme],
  );
}

function MemberButton({
  member,
  rootId,
  selected,
  theme,
  onSelect,
}: {
  member: Agent;
  rootId: string;
  selected: boolean;
  theme: PluginTheme;
  onSelect(id: string): void;
}) {
  const styles = usePeekStyles(theme);
  const state = useMemo(() => ({ selected }), [selected]);
  const select = useCallback(() => onSelect(member.id), [member.id, onSelect]);
  const role = member.id === rootId ? "Parent" : "Subagent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={state}
      accessibilityLabel={`View ${role.toLowerCase()} ${member.title || member.provider}`}
      style={selected ? styles.selected : styles.member}
      onPress={select}
    >
      <Text style={styles.text}>{member.title || member.provider}</Text>
      <Text style={styles.subtitle}>
        {role} · {memberStatus(member)}
      </Text>
    </Pressable>
  );
}

function Conversation({
  agent,
  theme,
  paseo,
  active,
}: {
  agent: Agent;
  theme: PluginTheme;
  paseo: PaseoApi;
  active: boolean;
}) {
  const [expanded, setExpanded] = useState(!agent.pendingPermissions.length);
  const styles = usePeekStyles(theme);
  const rows = useQuery({
    queryKey: ["inbox", "peek", agent.id, agent.updatedAt],
    enabled: active,
    refetchInterval: active && agent.status === "running" ? 4000 : false,
    queryFn: async () => {
      const page = await paseo.agents
        .ref(agent.id)
        .timeline.refetch({ direction: "tail", limit: 40, projection: "projected" });
      return page.entries
        .flatMap((entry) => {
          const row = itemToPeekRow(entry.item);
          return row ? [{ ...row, key: `${entry.seqStart}-${entry.seqEnd}` }] : [];
        })
        .slice(-20);
    },
  });
  const latestResult = rows.data?.findLast((row) => row.role === "agent");
  const refetch = rows.refetch;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View style={styles.section}>
      {rows.isPending ? <Text style={styles.subtitle}>Loading conversation…</Text> : null}
      {rows.isError ? (
        <View style={styles.row}>
          <Text style={styles.error}>Could not load this conversation.</Text>
          <ActionButton theme={theme} label="Retry conversation" onPress={retry} />
        </View>
      ) : null}
      {!expanded && latestResult ? (
        <View style={styles.speech}>
          <Text style={styles.subtitle}>Latest result</Text>
          <Text style={styles.text}>{latestResult.text}</Text>
        </View>
      ) : null}
      <ActionButton
        theme={theme}
        label={expanded ? "Hide conversation" : "Show conversation"}
        onPress={toggle}
      />
      {expanded
        ? rows.data?.map((row) => (
            <View key={row.key} style={styles.speech}>
              <Text style={styles.subtitle}>{ROLE_LABEL[row.role]}</Text>
              <Text style={styles.text}>{row.text}</Text>
            </View>
          ))
        : null}
    </View>
  );
}

function AgentDetail({
  agent,
  theme,
  paseo,
  navigation,
  actions,
  onClose,
}: {
  agent: Agent;
  theme: PluginTheme;
  paseo: PaseoApi;
  navigation: PluginSurfaceProps["navigation"];
  actions: CardActions;
  onClose(): void;
}) {
  const styles = usePeekStyles(theme);
  const request = agent.pendingPermissions[0];
  const readOperation = actions.operations.get(readKey(agent.id));
  const markRead = useCallback(() => actions.onMarkRead(agent.id), [actions, agent.id]);
  const openAgent = useCallback(() => {
    navigation?.openAgent({ agentId: agent.id });
    onClose();
  }, [navigation, agent.id, onClose]);
  const canMarkRead =
    actions.canRespond &&
    agent.requiresAttention &&
    agent.attentionReason === "finished" &&
    !request;
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{agent.title || agent.provider}</Text>
      <Text style={styles.subtitle}>
        {agent.provider}
        {agent.model ? ` · ${agent.model}` : ""} · {memberStatus(agent)}
      </Text>
      {request ? (
        <RequestControls agentId={agent.id} request={request} actions={actions} theme={theme} />
      ) : null}
      {agent.lastError ? <Text style={styles.error}>{agent.lastError}</Text> : null}
      <ReplyComposer agent={agent} actions={actions} theme={theme} />
      <View style={styles.row}>
        {navigation ? <ActionButton theme={theme} label="Open agent" onPress={openAgent} /> : null}
        {canMarkRead ? (
          <ActionButton
            theme={theme}
            label={readOperation?.status === "pending" ? "Marking read…" : "Mark read"}
            disabled={readOperation?.status === "pending"}
            onPress={markRead}
          />
        ) : null}
      </View>
      <OperationFeedback operation={readOperation} theme={theme} />
      <Conversation
        key={agent.id}
        agent={agent}
        theme={theme}
        paseo={paseo}
        active={actions.active}
      />
    </View>
  );
}

export function PeekModal({
  card,
  selectedId,
  onSelect,
  theme,
  paseo,
  navigation,
  actions,
  onClose,
  onNext,
  remaining,
}: {
  card: InboxCard;
  selectedId: string | null;
  onSelect(agentId: string): void;
  theme: PluginTheme;
  paseo: PaseoApi;
  navigation: PluginSurfaceProps["navigation"];
  actions: CardActions;
  onClose(): void;
  onNext(): void;
  remaining: number;
}) {
  const agent = card.members.find((member) => member.id === selectedId) ?? card.subject;
  const styles = usePeekStyles(theme);
  const changeOpen = useCallback(
    (value: boolean) => {
      if (!value) onClose();
    },
    [onClose],
  );
  return (
    <Modal title={cardTitle(card)} open={actions.active} onOpenChange={changeOpen}>
      <Modal.Content>
        {/* Modal.Content owns scrolling on every platform. Avoid a nested, fixed-height transcript. */}
        <View style={styles.container}>
          <View style={styles.row}>
            <Text style={styles.subtitle}>{remaining} needing you</Text>
            <ActionButton
              theme={theme}
              label="Next needing you"
              onPress={onNext}
              disabled={remaining === 0}
            />
          </View>
          {card.members.length > 1 ? (
            <View style={styles.members}>
              <Text style={styles.subtitle}>Conversation</Text>
              {card.members.map((member) => (
                <MemberButton
                  key={member.id}
                  member={member}
                  rootId={card.agent.id}
                  selected={member.id === agent.id}
                  theme={theme}
                  onSelect={onSelect}
                />
              ))}
            </View>
          ) : null}
          {card.workspace ? (
            <Text style={styles.subtitle}>
              {card.workspace.projectDisplayName} / {card.workspace.name}
            </Text>
          ) : null}
          <AgentDetail
            agent={agent}
            theme={theme}
            paseo={paseo}
            navigation={navigation}
            actions={actions}
            onClose={onClose}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
