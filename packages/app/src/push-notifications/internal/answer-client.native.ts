import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { StoredHostRegistrySchema, normalizeStoredHostProfile } from "@/types/host-connection";
import { readValidatedJson } from "@/storage/validated-storage";
import { buildClientConfig, connectAndProbe } from "@/utils/test-daemon-connection";
import type { NotificationAnswer } from "./action-response";

const activeClients = new Map<string, DaemonClient>();
export function registerNotificationClient(serverId: string, client: DaemonClient) {
  activeClients.set(serverId, client);
  return () => {
    if (activeClients.get(serverId) === client) activeClients.delete(serverId);
  };
}
async function sendAnswer(client: DaemonClient, answer: NotificationAnswer) {
  if (answer.operation === "defer") {
    await client.deferCoordinatorPermission(answer.agentId, answer.requestId);
    return;
  }
  await client.respondToPermissionAndWait(answer.agentId, answer.requestId, answer.response, 10000);
}
export async function answerNotification(answer: NotificationAnswer): Promise<void> {
  const active = activeClients.get(answer.serverId);
  if (active?.isConnected) {
    await sendAnswer(active, answer);
    return;
  }
  // Use the paired host's credentials and pinned relay key, never an endpoint from push data.
  const stored = await readValidatedJson(
    AsyncStorage,
    "@paseo:daemon-registry",
    StoredHostRegistrySchema,
  );
  const profile = stored
    ?.map(normalizeStoredHostProfile)
    .find((item) => item?.serverId === answer.serverId);
  if (!profile) throw new Error("Notification host is no longer paired");
  const connections = profile.connections
    .filter((item) => item.type === "directTcp" || item.type === "relay")
    .sort(
      (a, b) =>
        Number(b.id === profile.preferredConnectionId) -
        Number(a.id === profile.preferredConnectionId),
    );
  const deadline = Date.now() + 15000;
  for (const connection of connections) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let client: DaemonClient;
    try {
      const connected = await connectAndProbe(
        await buildClientConfig(connection, answer.serverId),
        Math.min(5000, remaining),
      );
      client = connected.client;
      if (connected.serverId !== answer.serverId) {
        await client.close();
        continue;
      }
    } catch {
      continue;
    }
    try {
      await sendAnswer(client, answer);
      return;
    } finally {
      await client.close();
    }
  }
  throw new Error("Notification host is unreachable");
}
