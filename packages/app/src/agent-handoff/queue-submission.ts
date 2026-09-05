import AsyncStorage from "@react-native-async-storage/async-storage";
import { generateMessageId } from "@/types/stream";

// Retained before contacting the host, so a lost acknowledgement can be retried after app closure.
function submissionKey(serverId: string, agentId: string): string {
  return `paseo:queue-submission:${serverId}:${agentId}`;
}

/**
 * Move an unresolved attempt to the agent that now owns the task. The retry has to reuse its
 * message ID, or the host receives the same instruction twice under two identities.
 */
export async function moveQueueSubmission(
  serverId: string,
  sourceId: string,
  agentId: string,
): Promise<void> {
  const from = submissionKey(serverId, sourceId);
  const previous = await AsyncStorage.getItem(from);
  if (!previous) return;
  const to = submissionKey(serverId, agentId);
  if (!(await AsyncStorage.getItem(to))) await AsyncStorage.setItem(to, previous);
  await AsyncStorage.removeItem(from);
}

export async function prepareQueueSubmission(
  serverId: string,
  agentId: string,
  content: string,
): Promise<{ id: string; finish: () => Promise<void> }> {
  const key = submissionKey(serverId, agentId);
  const previous = await AsyncStorage.getItem(key);
  let saved: { id: string; content: string } | null = null;
  try {
    saved = previous ? JSON.parse(previous) : null;
  } catch {
    /* A corrupt local attempt is not an acknowledged message. */
  }
  const id =
    saved?.content === content && typeof saved.id === "string" ? saved.id : generateMessageId();
  await AsyncStorage.setItem(key, JSON.stringify({ id, content }));
  return { id, finish: () => AsyncStorage.removeItem(key) };
}
