import { z } from "zod";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import { COORDINATOR_NOTIFICATION_CATEGORIES } from "@getpaseo/protocol/notification-actions";

const ActionDataSchema = z.object({
  serverId: z.string().min(1),
  agentId: z.string().min(1),
  requestId: z.string().min(1),
  categoryIdentifier: z.string(),
  actions: z.array(
    z.object({ id: z.string(), label: z.string(), response: AgentPermissionResponseSchema }),
  ),
});
export const FOREGROUND_ACTION_IDS: ReadonlySet<string> = new Set([
  "open",
  "open_app",
  "always_allow",
]);
export function resolveNotificationAnswer(actionIdentifier: string, data: unknown) {
  if (FOREGROUND_ACTION_IDS.has(actionIdentifier)) return null;
  const parsed = ActionDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const category = COORDINATOR_NOTIFICATION_CATEGORIES.find(
    (item) => item.id === payload.categoryIdentifier,
  );
  const canonical = category?.actions.find((item) => item.id === actionIdentifier);
  if (!canonical) return null;
  const actions = payload.actions.filter(
    (item) => item.id === canonical.id && item.label === canonical.label,
  );
  if (actions.length !== 1) return null;
  return {
    operation: actionIdentifier === "leave_it" ? ("defer" as const) : ("answer" as const),
    serverId: payload.serverId,
    agentId: payload.agentId,
    requestId: payload.requestId,
    response: actions[0]!.response,
  };
}
export type NotificationAnswer = NonNullable<ReturnType<typeof resolveNotificationAnswer>>;

/** Only acknowledged answers enter durable storage. Failed/offline sends remain retryable. */
export function createNotificationAnswerHandler(ports: {
  hasAnswered: (key: string) => Promise<boolean>;
  markAnswered: (key: string) => Promise<void>;
  answer: (answer: NotificationAnswer) => Promise<void>;
}) {
  const pending = new Map<string, Promise<void>>();
  return async (actionIdentifier: string, data: unknown): Promise<boolean> => {
    const answer = resolveNotificationAnswer(actionIdentifier, data);
    if (!answer) return false;
    const key = JSON.stringify([
      answer.serverId,
      answer.agentId,
      answer.requestId,
      answer.operation,
    ]);
    const existing = pending.get(key);
    if (existing) {
      await existing;
      return true;
    }
    const operation = (async () => {
      if (await ports.hasAnswered(key)) return;
      await ports.answer(answer);
      await ports.markAnswered(key);
    })();
    pending.set(key, operation);
    try {
      await operation;
    } finally {
      pending.delete(key);
    }
    return true;
  };
}
