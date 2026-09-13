import { getCoordinatorRole, getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { CoordinatorTrustLevel } from "@getpaseo/protocol/messages";

import type { AgentLineageDeps } from "../agent/agent-lineage.js";
import { nearestCoordinatorAncestor } from "../agent/agent-lineage.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

import { coordinatorTrustAtLeast, coordinatorTrustLevelFromLabels } from "./tool-policy.js";

/**
 * Writing descendants run in worktrees at Ship and above. The coordinator's
 * launch env carries this so descendants that shell out to `paseo run` mint a
 * worktree by default (see cli applyAgentSpawnIsolation), and the spawn
 * decision re-stamps it on every gated `create_agent` child so the value
 * survives env filtering.
 */
export const SPAWN_ISOLATION_ENV = "PASEO_AGENT_SPAWN_ISOLATION";

/** The launch env a coordinator-governed agent gets at the given trust level. */
export function coordinatorSpawnEnv(
  trustLevel: CoordinatorTrustLevel,
): Record<string, string> | undefined {
  return coordinatorTrustAtLeast(trustLevel, "ship")
    ? { [SPAWN_ISOLATION_ENV]: "worktree" }
    : undefined;
}

/**
 * Rebuilds the spawn-isolation env for a stored record being resumed. Launch
 * env is not persisted, so the value is derived from labels: a coordinator's
 * own trust label, or the governing coordinator's for a delegated descendant.
 * The result tracks the *current* persisted trust — a level dropped below Ship
 * un-isolates the tree's next resume, which is the intended effect.
 */
export async function spawnIsolationEnvForRecord(
  deps: AgentLineageDeps,
  record: Pick<StoredAgentRecord, "id" | "labels">,
): Promise<Record<string, string> | undefined> {
  if (getCoordinatorRole(record.labels) !== null) {
    return coordinatorSpawnEnv(coordinatorTrustLevelFromLabels(record.labels));
  }
  if (!getParentAgentIdFromLabels(record.labels)) return undefined;
  const governing = await nearestCoordinatorAncestor(deps, record.id);
  if (!governing) return undefined;
  return coordinatorSpawnEnv(coordinatorTrustLevelFromLabels(governing.node.labels));
}
