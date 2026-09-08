import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

interface CapacityCandidate {
  eventId: string;
  turnId: string;
}

/** A warning is evidence for a failed turn, never permission to interrupt a successful one. */
export class CapacityRecoveryTrigger {
  private readonly candidates = new Map<string, CapacityCandidate>();

  observe(
    agentId: string,
    event: AgentStreamEvent,
    eventId: string,
    foregroundTurnId?: string,
  ): CapacityCandidate | null {
    if (foregroundTurnId && this.candidates.get(agentId)?.turnId !== foregroundTurnId)
      this.clear(agentId);
    if (
      event.type === "timeline" &&
      event.item.type === "notification" &&
      event.item.code === "provider_capacity"
    ) {
      if (event.turnId && event.turnId === foregroundTurnId)
        this.candidates.set(agentId, { eventId, turnId: event.turnId });
      return null;
    }
    const candidate = this.candidates.get(agentId);
    if (event.type === "turn_started") {
      if (candidate?.turnId !== event.turnId) this.clear(agentId);
      return null;
    }
    if (
      event.type !== "turn_failed" &&
      event.type !== "turn_completed" &&
      event.type !== "turn_canceled"
    )
      return null;
    if (!candidate || candidate.turnId !== event.turnId) return null;
    this.clear(agentId);
    return event.type === "turn_failed" ? candidate : null;
  }

  pending(agentId: string): boolean {
    return this.candidates.has(agentId);
  }

  clear(agentId: string): void {
    this.candidates.delete(agentId);
  }
}
