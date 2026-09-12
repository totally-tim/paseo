import { isCoordinatorAgent } from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId" | "labels"> | null | undefined,
): CloseAgentTabPolicy {
  // Coordinator sessions are daemon-owned and delegate-only; closing their tab
  // must never archive them, the way delegated children are never archived.
  if (agent && isCoordinatorAgent(agent)) {
    return { kind: "layout-only" };
  }
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
