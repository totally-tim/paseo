import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { projectTimelineRows } from "../agent/timeline-projection.js";

export function isOrdinaryAgent(record: StoredAgentRecord): boolean {
  return (
    !record.internal &&
    !record.owner &&
    !record.archivedAt &&
    Boolean(record.workspaceId) &&
    !record.labels[PARENT_AGENT_ID_LABEL] &&
    !record.labels["paseo.schedule-id"] &&
    (record.provider === "claude" || record.provider === "codex")
  );
}

export async function continuationSafetyError(
  manager: AgentManager,
  agentId: string,
  checkTools = true,
): Promise<string | null> {
  const live = manager.getAgent(agentId);
  if (live?.pendingPermissions.size) return "Resolve the pending permission before continuing.";
  if (
    manager
      .listAgents()
      .some(
        (agent) =>
          agent.labels[PARENT_AGENT_ID_LABEL] === agentId &&
          (agent.lifecycle === "running" || agent.pendingPermissions.size > 0),
      )
  )
    return "This task has active subagents. Inspect their work before continuing.";
  if (live && manager.listProviderSubagents(agentId).some((agent) => agent.status === "running"))
    return "This task has active provider subagents. Inspect their work before continuing.";
  if (!checkTools) return null;
  const rows = await manager.readHandoffTimeline(agentId);
  const unresolved = projectTimelineRows({ rows, mode: "projected" }).some(
    ({ item }) => item.type === "tool_call" && item.status === "running",
  );
  return unresolved
    ? "An interrupted tool has no confirmed outcome. Inspect its result before continuing."
    : null;
}
