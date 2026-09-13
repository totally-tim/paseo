import { revokeSubscription, startSubscription } from "./internal/subscriptions";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";

import { registerNotificationClient } from "./internal/answer-client.native";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  const unregister = registerNotificationClient(input.serverId, input.client);
  const stop = startSubscription(input);
  return () => {
    unregister();
    stop();
  };
}

export function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  return revokeSubscription(input).catch((error) => {
    console.warn("[PushNotifications] Failed to remove local push subscription", error);
  });
}
