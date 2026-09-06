import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { AgentContinuationService } from "./service.js";

type Request = Extract<
  SessionInboundMessage,
  {
    type:
      | "agent.continuation.inspect.request"
      | "agent.continuation.cancel.request"
      | "agent.queue.manage.request";
  }
>;

export async function handleContinuationRequest(
  service: AgentContinuationService | undefined,
  request: Request,
  emit: (message: SessionOutboundMessage) => void,
): Promise<void> {
  let snapshot = null;
  let error: string | null = null;
  try {
    if (!service) throw new Error("Update the host to use automatic continuation and its queue.");
    if (request.type === "agent.continuation.cancel.request")
      await service.cancelExisting(request.agentId);
    snapshot =
      request.type === "agent.queue.manage.request"
        ? await service.manageQueue(request.agentId, request.operation)
        : await service.inspect(request.agentId);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not update this task's continuation.";
  }
  const responses = {
    "agent.queue.manage.request": "agent.queue.manage.response",
    "agent.continuation.cancel.request": "agent.continuation.cancel.response",
    "agent.continuation.inspect.request": "agent.continuation.inspect.response",
  } as const;
  const type = responses[request.type];
  emit({ type, payload: { requestId: request.requestId, snapshot, error } });
}
