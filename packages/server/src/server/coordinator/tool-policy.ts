import {
  COORDINATOR_TRUST_LABEL,
  COORDINATOR_TRUST_LEVELS,
  isCoordinatorAgent,
  type AgentLabelSource,
} from "@getpaseo/protocol/agent-labels";
import type { CoordinatorTrustLevel } from "@getpaseo/protocol/messages";

/**
 * Raised when a coordinator session calls a Paseo tool outside its trust
 * level's allowlist. The message is what the agent reads back, so it says what
 * is allowed rather than only what failed.
 */
export class CoordinatorToolDeniedError extends Error {
  readonly toolName: string;
  readonly trustLevel: CoordinatorTrustLevel;

  constructor(toolName: string, trustLevel: CoordinatorTrustLevel) {
    super(
      `Tool "${toolName}" is not available to a coordinator at ${capitalizeTrustLevel(trustLevel)} trust. ` +
        `${TRUST_LEVEL_ALLOWANCE[trustLevel]} The daemon enforces this, not the prompt.`,
    );
    this.name = "CoordinatorToolDeniedError";
    this.toolName = toolName;
    this.trustLevel = trustLevel;
  }
}

function capitalizeTrustLevel(level: CoordinatorTrustLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

const TRUST_LEVEL_ALLOWANCE: Record<CoordinatorTrustLevel, string> = {
  observe:
    "Observe coordinators read, ask, and remember — no spawning, no file edits, no shell or terminal actions.",
  propose:
    "Propose coordinators additionally spawn read-only subagents (investigator and reviewer kinds) and steer them — no writing subagents, workspaces, change requests, or permission answers.",
  ship: "Ship coordinators additionally spawn writing subagents in worktrees, create workspaces, open and comment on change requests, retry checks, and answer permissions on covered sessions — no schedules, terminals, or merges.",
  autopilot:
    "Autopilot coordinators hold every Ship capability plus merge automation under the project merge policy — no schedules, terminals, or unrelated-agent actions.",
};

/**
 * Paseo tools an Observe-trust coordinator may call. Everything else in the
 * catalog — create_agent, send_agent_prompt, workspace/archive/script,
 * terminal, schedule, permission responses, mode changes, browser tools — is
 * denied at the daemon boundary, independent of the prompt.
 *
 * The list is additive-by-review: a tool joins it only when it cannot mutate
 * agent, workspace, schedule, or repository state.
 */
const OBSERVE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "list_workspaces",
  "list_agents",
  "get_agent_status",
  "get_agent_activity",
  "list_pending_permissions",
  "list_workspace_scripts",
  "list_terminals",
  "list_schedules",
  "inspect_schedule",
  "schedule_logs",
  "list_provider_accounts",
  "list_providers",
  "list_models",
  "list_profiles",
  "inspect_provider",
  "read_agent_handoff",
  "remember",
]);

/**
 * Propose adds delegation plumbing: spawning (kind-gated to read-only roles by
 * the coordinator service's spawn guard) plus steering and canceling the
 * spawned sessions. Nothing here opens a change request or answers a
 * permission.
 */
const PROPOSE_ADDED_TOOLS: ReadonlySet<string> = new Set([
  "create_agent",
  "send_agent_prompt",
  "cancel_agent",
]);

/**
 * Ship adds the writing workflow: workspaces for implementer worktrees,
 * permission answers on covered sessions, and the change-request forge tools.
 * `update_agent` covers renaming and re-driving subagents. Merge automation
 * joins Autopilot with the merge-policy milestone.
 */
const SHIP_ADDED_TOOLS: ReadonlySet<string> = new Set([
  "create_workspace",
  "update_agent",
  "respond_to_permission",
  "create_change_request",
  "comment_on_change_request",
  "retry_change_request_checks",
]);

const ALLOWED_TOOLS_BY_LEVEL: Record<CoordinatorTrustLevel, ReadonlySet<string>> = {
  observe: OBSERVE_ALLOWED_TOOLS,
  propose: new Set([...OBSERVE_ALLOWED_TOOLS, ...PROPOSE_ADDED_TOOLS]),
  ship: new Set([...OBSERVE_ALLOWED_TOOLS, ...PROPOSE_ADDED_TOOLS, ...SHIP_ADDED_TOOLS]),
  autopilot: new Set([...OBSERVE_ALLOWED_TOOLS, ...PROPOSE_ADDED_TOOLS, ...SHIP_ADDED_TOOLS]),
};

const TRUST_LEVEL_ORDER: Record<CoordinatorTrustLevel, number> = {
  observe: 0,
  propose: 1,
  ship: 2,
  autopilot: 3,
};

export function coordinatorTrustAtLeast(
  level: CoordinatorTrustLevel,
  minimum: CoordinatorTrustLevel,
): boolean {
  return TRUST_LEVEL_ORDER[level] >= TRUST_LEVEL_ORDER[minimum];
}

/**
 * The enforcement copy of trust lives on the coordinator's agent labels so
 * tool dispatch stays a local read. Absent or unknown values mean observe —
 * the floor, so a missing label never widens what a coordinator may do.
 */
export function coordinatorTrustLevelFromLabels(
  labels: Record<string, unknown> | null | undefined,
): CoordinatorTrustLevel {
  const raw = labels?.[COORDINATOR_TRUST_LABEL];
  return typeof raw === "string" && (COORDINATOR_TRUST_LEVELS as readonly string[]).includes(raw)
    ? (raw as CoordinatorTrustLevel)
    : "observe";
}

export function isCoordinatorToolAllowed(
  trustLevel: CoordinatorTrustLevel,
  toolName: string,
): boolean {
  return ALLOWED_TOOLS_BY_LEVEL[trustLevel].has(toolName);
}

/**
 * Daemon-side trust enforcement. Call for every Paseo tool invocation; a
 * coordinator caller may only use its level's allowlist. Trust comes from the
 * agent's labels, mirrored from persisted coordinator state, so a stale or
 * absent label fails closed at observe.
 */
export function assertCoordinatorToolAllowed(
  caller: AgentLabelSource | null | undefined,
  toolName: string,
): void {
  if (!caller || !isCoordinatorAgent(caller)) return;
  const trustLevel = coordinatorTrustLevelFromLabels(caller.labels);
  if (!isCoordinatorToolAllowed(trustLevel, toolName)) {
    throw new CoordinatorToolDeniedError(toolName, trustLevel);
  }
}
