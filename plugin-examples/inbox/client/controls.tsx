import type { PluginTheme } from "@getpaseo/plugin";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useCallback, useMemo } from "react";
import type { CardActions } from "./card";
import { PermissionControls } from "./permission-card";
import { ActionButton, QuestionControls } from "./question-card";
import { replyKey, responseKey, type Operation } from "./store";
import type { Agent, PermissionRequest, PermissionResponse } from "./types";

const STACK = { gap: 8 };

export function OperationFeedback({
  operation,
  theme,
}: {
  operation?: Operation;
  theme: PluginTheme;
}) {
  const style = useMemo(
    () => ({
      color: operation?.error ? theme.colors.statusDanger : theme.colors.foregroundMuted,
      fontSize: 12,
    }),
    [operation?.error, theme],
  );
  if (!operation || operation.status === "succeeded") return null;
  return (
    <Text accessibilityRole="alert" style={style}>
      {operation.error ?? "Sending…"}
    </Text>
  );
}

export function RequestControls({
  agentId,
  request,
  actions,
  theme,
}: {
  agentId: string;
  request: PermissionRequest;
  actions: CardActions;
  theme: PluginTheme;
}) {
  const key = responseKey(agentId, request.id);
  const operation = actions.operations.get(key);
  const disabled = operation?.status === "pending" || operation?.status === "succeeded";
  const respond = useCallback(
    (response: PermissionResponse) => actions.onRespond(agentId, request.id, response),
    [actions, agentId, request.id],
  );
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  if (!actions.canRespond) return <Text style={muted}>Update the app to answer from here.</Text>;
  const Controls = request.kind === "question" ? QuestionControls : PermissionControls;
  return (
    <View style={STACK}>
      <Controls key={key} request={request} theme={theme} disabled={disabled} onRespond={respond} />
      <OperationFeedback operation={operation} theme={theme} />
    </View>
  );
}

export function ReplyComposer({
  agent,
  actions,
  theme,
}: {
  agent: Agent;
  actions: CardActions;
  theme: PluginTheme;
}) {
  const reply = actions.drafts.get(agent.id) ?? "";
  const operation = actions.operations.get(replyKey(agent.id));
  const pending = operation?.status === "pending";
  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { gap: 6 },
        row: { flexDirection: "row", gap: 8, alignItems: "center" },
        input: {
          flex: 1,
          minWidth: 0,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          color: theme.colors.foreground,
          fontSize: 13,
        },
      }),
    [theme],
  );
  const send = useCallback(() => actions.onReply(agent.id), [actions, agent.id]);
  const change = useCallback(
    (text: string) => actions.onDraft(agent.id, text),
    [actions, agent.id],
  );
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <TextInput
          value={reply}
          onChangeText={change}
          onSubmitEditing={send}
          editable={!pending && actions.draftsReady}
          accessibilityLabel={`Reply to ${agent.title || agent.provider}`}
          placeholder="Reply…"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
        />
        <ActionButton
          theme={theme}
          label={pending ? "Sending…" : "Send"}
          primary
          onPress={send}
          disabled={!reply.trim() || pending || !actions.draftsReady}
        />
      </View>
      <OperationFeedback operation={operation} theme={theme} />
      {actions.draftsError ? (
        <View style={STACK}>
          <Text style={styles.input}>Could not save or restore drafts: {actions.draftsError}</Text>
          <ActionButton theme={theme} label="Retry drafts" onPress={actions.onRetryDrafts} />
        </View>
      ) : null}
    </View>
  );
}
