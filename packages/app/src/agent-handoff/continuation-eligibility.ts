import type { Agent } from "@/stores/session-store";
import { HANDOFF_TO_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

export function canContinueAgent(agent: Pick<Agent, "archivedAt" | "labels"> | undefined): boolean {
  return Boolean(agent && !agent.archivedAt && !agent.labels[HANDOFF_TO_AGENT_ID_LABEL]);
}
