export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const HANDOFF_FROM_AGENT_ID_LABEL = "paseo.handoff-from-agent-id";
export const HANDOFF_TO_AGENT_ID_LABEL = "paseo.handoff-to-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export const PASEO_ROLE_LABEL = "paseo.role";
export const COORDINATOR_GLOBAL_ROLE = "coordinator.global";
export const COORDINATOR_PROJECT_ROLE = "coordinator.project";
export type CoordinatorAgentRole = typeof COORDINATOR_GLOBAL_ROLE | typeof COORDINATOR_PROJECT_ROLE;
/** The project a `coordinator.project` agent belongs to. Absent on the global role. */
export const COORDINATOR_PROJECT_ID_LABEL = "paseo.coordinator.project-id";
/**
 * Enforcement copy of a coordinator's trust level, kept in sync with the
 * coordinator service's persisted state so tool dispatch stays a local label
 * read. Absent means observe.
 */
export const COORDINATOR_TRUST_LABEL = "paseo.coordinator.trust";
export const COORDINATOR_TRUST_LEVELS = ["observe", "propose", "ship", "autopilot"] as const;
/**
 * Kind of worker a coordinator spawned. Values key the coordinator's
 * configured `profiles` map; goals name the same keys.
 */
export const COORDINATOR_SUBAGENT_KIND_LABEL = "paseo.coordinator.subagent-kind";
export const COORDINATOR_SUBAGENT_KINDS = ["investigator", "implementer", "reviewer"] as const;
export type CoordinatorSubagentKind = (typeof COORDINATOR_SUBAGENT_KINDS)[number];

export function getCoordinatorSubagentKind(
  labels: Record<string, unknown> | null | undefined,
): CoordinatorSubagentKind | null {
  const kind = labels?.[COORDINATOR_SUBAGENT_KIND_LABEL];
  return COORDINATOR_SUBAGENT_KINDS.includes(kind as CoordinatorSubagentKind)
    ? (kind as CoordinatorSubagentKind)
    : null;
}

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function getCoordinatorRole(
  labels: Record<string, unknown> | null | undefined,
): CoordinatorAgentRole | null {
  const role = labels?.[PASEO_ROLE_LABEL];
  return role === COORDINATOR_GLOBAL_ROLE || role === COORDINATOR_PROJECT_ROLE ? role : null;
}

export function isCoordinatorAgent(agent: AgentLabelSource): boolean {
  return getCoordinatorRole(agent.labels) !== null;
}

export function getCoordinatorProjectIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const projectId = labels?.[COORDINATOR_PROJECT_ID_LABEL];
  return typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}
