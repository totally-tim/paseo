import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentQueuedMessage, AgentQueueOperation } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useAgentContinuation } from "./use-continuation";

function QueueItem({
  item,
  manage,
}: {
  item: AgentQueuedMessage;
  manage: (operation: AgentQueueOperation) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [editRevision, setEditRevision] = useState(item.revision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = useCallback(
    async (operation: AgentQueueOperation) => {
      setPending(true);
      setError(null);
      try {
        await manage(operation);
        setEditing(false);
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : "Could not update the queued message.",
        );
      } finally {
        setPending(false);
      }
    },
    [manage],
  );
  const save = useCallback(
    () =>
      perform({
        kind: "edit",
        revision: editRevision,
        message: { id: item.id, text, images: item.images, attachments: item.attachments },
      }),
    [editRevision, item, perform, text],
  );
  const keepOriginal = useCallback(() => setEditing(false), []);
  const edit = useCallback(() => {
    setText(item.text);
    setEditRevision(item.revision);
    setEditing(true);
  }, [item.revision, item.text]);
  const send = useCallback(
    () => perform({ kind: "send_now", messageId: item.id }),
    [item.id, perform],
  );
  const remove = useCallback(
    () => perform({ kind: "cancel", messageId: item.id }),
    [item.id, perform],
  );
  const statusLabel = { queued: "Queued", dispatching: "Sending", attention: "Needs attention" }[
    item.status
  ];
  const attachmentCount = (item.images?.length ?? 0) + (item.attachments?.length ?? 0);
  return (
    <View style={styles.item} testID={`queued-message-${item.id}`}>
      <Text style={styles.muted}>
        {statusLabel}
        {attachmentCount ? ` · ${attachmentCount} attachments` : ""}
      </Text>
      {editing ? (
        <FormTextInput
          initialValue={text}
          onChangeText={setText}
          multiline
          accessibilityLabel="Edit queued instruction"
        />
      ) : (
        <Text style={styles.text}>{item.text}</Text>
      )}
      {item.error ? <Text style={styles.error}>{item.error}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {editing ? (
          <>
            <Button size="sm" disabled={pending} onPress={save}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onPress={keepOriginal}>
              Keep original
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || item.status !== "queued"}
              onPress={edit}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || item.status !== "queued"}
              onPress={send}
              testID={`queued-message-send-now-${item.id}`}
            >
              Send now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || item.status === "dispatching"}
              onPress={remove}
            >
              Remove
            </Button>
          </>
        )}
      </View>
    </View>
  );
}
export function AgentQueueTrack({ serverId, agentId }: { serverId: string; agentId: string }) {
  const queue = useAgentContinuation(serverId, agentId);
  if (!queue.supported) return null;
  // Render nothing until there is something to show. An empty track still takes a gap from
  // its parent, and it mounts when the first queue read lands, which shifts the composer.
  if (!queue.isError && !queue.data?.queuedMessages.length) return null;
  return (
    <View style={styles.track} testID="agent-queue-track">
      {queue.isError ? (
        <Text style={styles.error}>
          The host queue could not be loaded. Reconnect to check retained messages.
        </Text>
      ) : null}
      {queue.data?.queuedMessages.map((item) => (
        <QueueItem key={item.id} item={item} manage={queue.manage} />
      ))}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  track: { gap: theme.spacing[2] },
  item: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  actions: { flexDirection: "row", gap: theme.spacing[2], flexWrap: "wrap" },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
