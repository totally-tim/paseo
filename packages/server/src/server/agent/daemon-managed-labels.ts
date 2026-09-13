import {
  HANDOFF_FROM_AGENT_ID_LABEL,
  HANDOFF_TO_AGENT_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";

/**
 * Labels only the daemon may write: lineage (parent, handoff), coordinator
 * role/trust/kind stamps, and schedule ownership. A caller that could set
 * `paseo.role` or `paseo.coordinator.trust` through a tool would mint itself
 * a coordinator — so create_agent's labels and update_agent's label patch
 * drop these keys rather than trusting the caller.
 */
const DAEMON_MANAGED_LABEL_KEYS: ReadonlySet<string> = new Set([
  PASEO_ROLE_LABEL,
  PARENT_AGENT_ID_LABEL,
  HANDOFF_FROM_AGENT_ID_LABEL,
  HANDOFF_TO_AGENT_ID_LABEL,
  "paseo.schedule-id",
]);

const DAEMON_MANAGED_LABEL_PREFIXES = ["paseo.coordinator."];

/**
 * Labels an agent may not write even though clients may: `open-agent-tab`
 * markers are per-client UI state the app writes through update_agent — agent
 * tools strip them so a subagent cannot fake a user's open tabs. Client-facing
 * paths keep them caller-settable.
 */
const AGENT_TOOL_HIDDEN_LABEL_PREFIXES = ["paseo.open-agent-tab."];

export function isDaemonManagedLabel(key: string): boolean {
  return (
    DAEMON_MANAGED_LABEL_KEYS.has(key) ||
    DAEMON_MANAGED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** The caller-settable subset of a label map: identity labels removed. */
export function stripDaemonManagedLabels(
  labels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!labels) return labels;
  return Object.fromEntries(Object.entries(labels).filter(([key]) => !isDaemonManagedLabel(key)));
}

/**
 * The stricter subset for agent-tool inputs: daemon-managed keys plus the
 * client-owned markers an agent has no business writing.
 */
export function stripAgentToolLabels(
  labels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!labels) return labels;
  return Object.fromEntries(
    Object.entries(labels).filter(
      ([key]) =>
        !isDaemonManagedLabel(key) &&
        !AGENT_TOOL_HIDDEN_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix)),
    ),
  );
}
