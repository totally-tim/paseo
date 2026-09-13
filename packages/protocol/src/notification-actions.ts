import type { AgentPermissionAction, AgentPermissionResponse } from "./agent-types.js";

/** Native categories must be registered before a push can display these labels. */
export const COORDINATOR_NOTIFICATION_CATEGORIES = [
  {
    id: "paseo.coordinator.retry",
    actions: [
      { id: "retry", label: "Retry" },
      { id: "investigate", label: "Investigate" },
      { id: "ignore", label: "Ignore" },
    ],
  },
  {
    id: "paseo.coordinator.review",
    actions: [
      { id: "open", label: "Open" },
      { id: "merge", label: "Merge" },
      { id: "request_changes", label: "Request changes" },
    ],
  },
  {
    id: "paseo.coordinator.permission",
    actions: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
      { id: "leave_it", label: "Leave it" },
      { id: "always_allow", label: "Always allow this" },
    ],
  },
  { id: "paseo.coordinator.open", actions: [{ id: "open_app", label: "Open app" }] },
] as const;

export interface NotificationAnswerAction {
  id: string;
  label: string;
  response: AgentPermissionResponse;
}

export function buildNotificationActions(actions?: readonly AgentPermissionAction[]): {
  categoryIdentifier: string;
  actions?: NotificationAnswerAction[];
} {
  const category = COORDINATOR_NOTIFICATION_CATEGORIES.find(
    (candidate) =>
      candidate.id !== "paseo.coordinator.open" &&
      candidate.actions.length === actions?.length &&
      candidate.actions.every(
        (item) => actions.filter((action) => action.label === item.label).length === 1,
      ),
  );
  if (!category || !actions) return { categoryIdentifier: "paseo.coordinator.open" };
  return {
    categoryIdentifier: category.id,
    actions: category.actions.map((item) => {
      const action = actions.find((candidate) => candidate.label === item.label)!;
      return {
        id: item.id,
        label: item.label,
        response: action.response ?? {
          behavior: action.behavior,
          selectedActionId: action.id,
        },
      };
    }),
  };
}
