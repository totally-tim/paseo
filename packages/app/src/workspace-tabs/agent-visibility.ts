import type { Agent } from "@/stores/session-store";
import { HANDOFF_TO_AGENT_ID_LABEL, isCoordinatorAgent } from "@getpaseo/protocol/agent-labels";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  knownAgentIds: Set<string>;
  /**
   * Coordinator sessions anywhere on the host. They are not workspace entities
   * — the project coordinator lives at the project root workspace but belongs
   * to the board surface — so they never count toward activity, never auto-open
   * an agent tab, and their explicitly opened chat tabs are never pruned.
   */
  coordinatorAgentIds: Set<string>;
}

function agentBelongsToWorkspace(agent: Agent, workspaceId: string): boolean {
  return normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
}

interface AgentVisibilityBuckets {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  knownAgentIds: Set<string>;
}

function collectSessionAgentVisibility(
  agent: Agent,
  context: {
    workspaceId: string;
    agentsById: Map<string, Agent>;
    coordinatorAgentIds: Set<string>;
    buckets: AgentVisibilityBuckets;
  },
): void {
  if (context.coordinatorAgentIds.has(agent.id)) {
    return;
  }
  if (!agentBelongsToWorkspace(agent, context.workspaceId)) {
    return;
  }
  context.buckets.knownAgentIds.add(agent.id);
  if (agent.archivedAt) {
    return;
  }
  context.buckets.activeAgentIds.add(agent.id);
  const parentAgent = agent.parentAgentId ? context.agentsById.get(agent.parentAgentId) : undefined;
  if (isWorkspaceRootAgent(agent, parentAgent) && !agent.labels[HANDOFF_TO_AGENT_ID_LABEL]) {
    context.buckets.autoOpenAgentIds.add(agent.id);
  }
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  const buckets: AgentVisibilityBuckets = {
    activeAgentIds: new Set<string>(),
    autoOpenAgentIds: new Set<string>(),
    knownAgentIds: new Set<string>(),
  };
  const coordinatorAgentIds = new Set<string>();
  if ((!sessionAgents && !agentDetails) || !workspaceId) {
    return { ...buckets, coordinatorAgentIds };
  }

  const agentsById = new Map<string, Agent>([
    ...(agentDetails?.entries() ?? []),
    ...(sessionAgents?.entries() ?? []),
  ]);
  for (const agent of agentsById.values()) {
    if (isCoordinatorAgent(agent)) {
      coordinatorAgentIds.add(agent.id);
    }
  }
  for (const agent of sessionAgents?.values() ?? []) {
    collectSessionAgentVisibility(agent, {
      workspaceId,
      agentsById,
      coordinatorAgentIds,
      buckets,
    });
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (coordinatorAgentIds.has(agent.id)) {
      continue;
    }
    if (agentBelongsToWorkspace(agent, workspaceId)) {
      buckets.knownAgentIds.add(agent.id);
    }
  }

  return { ...buckets, coordinatorAgentIds };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingTerminalCreate: boolean;
  hasActivePendingDraftCreate: boolean;
  coordinator?: {
    /** This workspace's project has an enabled coordinator. */
    projectId: string | null;
    /** False until the host's board subscription delivers its first payload. */
    boardsHydrated: boolean;
  };
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    knownAgentIds: input.agentVisibility.knownAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingTerminalCreate: input.hasActivePendingTerminalCreate,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
    ...(input.coordinator
      ? {
          coordinator: {
            projectId: input.coordinator.projectId,
            boardsHydrated: input.coordinator.boardsHydrated,
            agentIds: input.agentVisibility.coordinatorAgentIds,
          },
        }
      : {}),
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    setsEqual(a.knownAgentIds, b.knownAgentIds) &&
    setsEqual(a.coordinatorAgentIds, b.coordinatorAgentIds)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}
