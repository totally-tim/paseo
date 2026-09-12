import { getCoordinatorRole, getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

/**
 * Label reads for lineage walks: live agents answer from the manager, stored
 * ones from the registry cache, so ancestry checks work for coordinators and
 * subagents that are not currently loaded.
 */
export interface AgentLineageDeps {
  agentManager: Pick<AgentManager, "getAgent">;
  agentStorage: Pick<AgentStorage, "get">;
}

export interface AgentLineageNode {
  agentId: string;
  labels: Record<string, string>;
}

// A corrupted or hand-edited label cycle must not hang the walk; real trees
// stay well under this depth.
const MAX_LINEAGE_DEPTH = 64;

async function labelsFor(
  deps: AgentLineageDeps,
  agentId: string,
): Promise<Record<string, string> | null> {
  const live = deps.agentManager.getAgent(agentId);
  if (live) return live.labels;
  return (await deps.agentStorage.get(agentId))?.labels ?? null;
}

/**
 * The agent's own record first, then each ancestor nearest-first, ending at
 * the root. Stops early when an ancestor is missing from both the manager and
 * storage — the rest of that chain is unknowable from this daemon.
 */
export async function collectAgentLineage(
  deps: AgentLineageDeps,
  agentId: string,
): Promise<AgentLineageNode[]> {
  const nodes: AgentLineageNode[] = [];
  const seen = new Set<string>();
  let current: string | null = agentId;
  while (current && !seen.has(current) && nodes.length <= MAX_LINEAGE_DEPTH) {
    seen.add(current);
    const labels = await labelsFor(deps, current);
    if (!labels) break;
    nodes.push({ agentId: current, labels });
    current = getParentAgentIdFromLabels(labels);
  }
  return nodes;
}

/** True when `ancestorId` appears strictly above `agentId` in its parent chain. */
export async function isAgentDescendantOf(
  deps: AgentLineageDeps,
  ancestorId: string,
  agentId: string,
): Promise<boolean> {
  const lineage = await collectAgentLineage(deps, agentId);
  return lineage.slice(1).some((node) => node.agentId === ancestorId);
}

/**
 * The first coordinator in `agentId`'s lineage, self included: a coordinator
 * spawning directly returns itself, a subagent returns the coordinator it
 * rolls up to. Depth is hops from the coordinator — the coordinator's own
 * child is depth 1 — and a coordinator nested under another (project under
 * global) bounds only its own subtree.
 */
export async function nearestCoordinatorAncestor(
  deps: AgentLineageDeps,
  agentId: string,
): Promise<{ node: AgentLineageNode; depth: number } | null> {
  const lineage = await collectAgentLineage(deps, agentId);
  const index = lineage.findIndex((node) => getCoordinatorRole(node.labels) !== null);
  if (index === -1) return null;
  return { node: lineage[index], depth: index };
}
