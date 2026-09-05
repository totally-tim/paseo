import AsyncStorage from "@react-native-async-storage/async-storage";
import { generateMessageId } from "@/types/stream";

// Retained before contacting the host, so a lost acknowledgement can be retried after app closure.
export async function prepareQueueSubmission(
  serverId: string,
  agentId: string,
  content: string,
): Promise<{ id: string; finish: () => Promise<void> }> {
  const key = `paseo:queue-submission:${serverId}:${agentId}`;
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
