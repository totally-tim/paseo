import { isCoordinatorAgent, type AgentLabelSource } from "@getpaseo/protocol/agent-labels";

/**
 * Raised when a coordinator session calls a Paseo tool outside its trust
 * level's allowlist. The message is what the agent reads back, so it says what
 * is allowed rather than only what failed.
 */
export class CoordinatorToolDeniedError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is not available to a coordinator at Observe trust. ` +
        "Observe coordinators read, ask, and remember; the daemon enforces no spawning, " +
        "no file edits, and no shell or terminal actions.",
    );
    this.name = "CoordinatorToolDeniedError";
    this.toolName = toolName;
  }
}

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
  "capture_terminal",
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

export function isCoordinatorObserveToolAllowed(toolName: string): boolean {
  return OBSERVE_ALLOWED_TOOLS.has(toolName);
}

/**
 * Daemon-side observe enforcement. Call for every Paseo tool invocation; a
 * coordinator caller at observe trust may only use the allowlist above.
 * Higher trust levels land with later milestones and widen this check.
 */
export function assertCoordinatorToolAllowed(
  caller: AgentLabelSource | null | undefined,
  toolName: string,
): void {
  if (!caller || !isCoordinatorAgent(caller)) return;
  // Milestone 1 runs coordinators at observe only; the role label is the trust
  // gate until persisted trust is threaded into tool dispatch.
  if (!OBSERVE_ALLOWED_TOOLS.has(toolName)) {
    throw new CoordinatorToolDeniedError(toolName);
  }
}
