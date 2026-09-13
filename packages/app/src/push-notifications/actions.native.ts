import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { COORDINATOR_NOTIFICATION_CATEGORIES } from "@getpaseo/protocol/notification-actions";
import { createNotificationAnswerHandler, FOREGROUND_ACTION_IDS } from "./internal/action-response";
import { answerNotification } from "./internal/answer-client.native";

const TASK = "paseo-notification-answer";
let initialized = false;
const STORAGE_PREFIX = "@paseo:notification-answer:";
const handleAnswer = createNotificationAnswerHandler({
  hasAnswered: async (key) => (await AsyncStorage.getItem(STORAGE_PREFIX + key)) !== null,
  markAnswered: async (key) => {
    await AsyncStorage.setItem(STORAGE_PREFIX + key, "answered");
  },
  answer: answerNotification,
});
export async function handleNotificationAction(
  response: Notifications.NotificationResponse,
): Promise<boolean> {
  return handleAnswer(response.actionIdentifier, response.notification.request.content.data);
}
async function backgroundResponse(response: Notifications.NotificationResponse) {
  try {
    await handleNotificationAction(response);
  } catch {
    // Keep credentials and provider payloads out of device logs. The original decision remains open.
    console.warn("[PushNotifications] Couldn't send answer; open the decision to retry.");
    const data = response.notification.request.content.data;
    await Notifications.scheduleNotificationAsync({
      identifier: `answer-failed-${response.notification.request.identifier}`,
      content: {
        title: "Answer not sent",
        body: "Open the decision to retry.",
        categoryIdentifier: "paseo.coordinator.open",
        data: { serverId: data.serverId, agentId: data.agentId, workspaceId: data.workspaceId },
      },
      trigger: null,
    }).catch(() => undefined);
  }
}
export function initializeNotificationActions(): void {
  if (initialized) return;
  initialized = true;
  // The iOS response listener must exist before React mounts, including background launches.
  Notifications.addNotificationResponseReceivedListener((response) => {
    void backgroundResponse(response);
  });
  if (!TaskManager.isTaskDefined(TASK)) {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
      if (!error && data && "actionIdentifier" in data) await backgroundResponse(data);
    });
  }
  void Notifications.registerTaskAsync(TASK).catch(() => {
    console.warn("[PushNotifications] Background notification task registration failed.");
  });
  for (const category of COORDINATOR_NOTIFICATION_CATEGORIES) {
    // Android displays at most three actions. Tapping the notification opens the full decision.
    const actions = Platform.OS === "android" ? category.actions.slice(0, 3) : category.actions;
    void Notifications.setNotificationCategoryAsync(
      category.id,
      actions.map((action) => ({
        identifier: action.id,
        buttonTitle: action.label,
        options: { opensAppToForeground: FOREGROUND_ACTION_IDS.has(action.id) },
      })),
    ).catch(() => console.warn("[PushNotifications] Notification category registration failed."));
  }
}
