import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  CoordinatorGoal,
  CoordinatorPolicyRule,
  CoordinatorProposal,
} from "@getpaseo/protocol/coordinator-goals";

type Client = Pick<
  DaemonClient,
  | "listCoordinatorGoals"
  | "setCoordinatorGoalPaused"
  | "listCoordinatorProposals"
  | "resolveCoordinatorProposal"
  | "listCoordinatorPolicy"
  | "setCoordinatorPolicyEnabled"
>;
export type AutomationView = "goals" | "policy" | "proposals";
interface Data {
  goals: CoordinatorGoal[];
  policy: CoordinatorPolicyRule[];
  proposals: CoordinatorProposal[];
}
type Load =
  | { status: "connecting" | "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; data: Data };
export interface AutomationState {
  load: Load;
  refreshing: boolean;
  connected: boolean;
  operations: Record<string, { pending: boolean; error: string | null; success: string | null }>;
}
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Couldn't update coordinator. Try again.";

export function openAutomation(view: AutomationView, projectId?: string) {
  let state: AutomationState = {
    load: { status: "connecting" },
    refreshing: false,
    connected: false,
    operations: {},
  };
  let client: Client | null = null;
  let active = true;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: AutomationState) => {
    if (!active) return;
    state = next;
    for (const listener of listeners) listener();
  };
  async function reload() {
    if (!client || state.refreshing || !active) return;
    const current = client;
    const version = ++generation;
    publish({
      ...state,
      refreshing: true,
      load: state.load.status === "loaded" ? state.load : { status: "loading" },
    });
    try {
      const target = projectId ? { projectId } : {};
      const data: Data = { goals: [], policy: [], proposals: [] };
      if (view === "goals") data.goals = await current.listCoordinatorGoals(target);
      if (view === "policy") data.policy = await current.listCoordinatorPolicy(target);
      if (view === "proposals") data.proposals = await current.listCoordinatorProposals(target);
      if (version === generation)
        publish({ ...state, refreshing: false, load: { status: "loaded", data } });
    } catch (cause) {
      if (version === generation)
        publish({ ...state, refreshing: false, load: { status: "error", error: message(cause) } });
    }
  }
  async function mutate(key: string, run: (current: Client) => Promise<unknown>, success: string) {
    if (state.operations[key]?.pending || !active) return;
    if (!client) {
      publish({
        ...state,
        operations: {
          ...state.operations,
          [key]: {
            pending: false,
            error: "Host disconnected. Reconnect and retry.",
            success: null,
          },
        },
      });
      return;
    }
    publish({
      ...state,
      operations: { ...state.operations, [key]: { pending: true, error: null, success: null } },
    });
    try {
      await run(client);
      publish({
        ...state,
        operations: { ...state.operations, [key]: { pending: false, error: null, success } },
      });
      ++generation;
      publish({ ...state, refreshing: false });
      await reload();
    } catch (cause) {
      publish({
        ...state,
        operations: {
          ...state.operations,
          [key]: { pending: false, error: message(cause), success: null },
        },
      });
    }
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      active = false;
      ++generation;
      listeners.clear();
    },
    setClient(next: Client | null) {
      if (client === next) return;
      client = next;
      ++generation;
      publish({
        ...state,
        connected: next !== null,
        refreshing: false,
        ...(!next && state.load.status !== "loaded"
          ? { load: { status: "connecting" as const } }
          : {}),
      });
      if (next) void reload();
    },
    reload,
    setGoalPaused(goal: CoordinatorGoal, paused: boolean) {
      return mutate(
        goal.id,
        (current) =>
          current.setCoordinatorGoalPaused({ projectId: goal.projectId, goalId: goal.id, paused }),
        paused ? "Goal paused" : "Goal resumed",
      );
    },
    setPolicyEnabled(rule: CoordinatorPolicyRule, enabled: boolean) {
      return mutate(
        rule.id,
        (current) => current.setCoordinatorPolicyEnabled({ ruleId: rule.id, enabled }),
        enabled ? "Rule enabled" : "Rule disabled",
      );
    },
    resolveProposal(proposal: CoordinatorProposal, action: "approve" | "ignore") {
      return mutate(
        proposal.id,
        (current) => current.resolveCoordinatorProposal({ proposalId: proposal.id, action }),
        action === "approve" ? "Proposal approved" : "Proposal ignored",
      );
    },
  };
}
export function proposalEditQuote(proposal: CoordinatorProposal): string {
  const rule = proposalRuleText(proposal);
  return `Edit proposal ${proposal.id}: ${proposal.sentence}\nProjects: ${proposal.projectIds.join(", ")}\n${rule}\nPlease replace this proposal with a new version for my approval.`;
}

export function proposalRuleText(proposal: CoordinatorProposal): string {
  if (proposal.payload.kind === "goal") return proposal.payload.ruleYaml;
  if (proposal.payload.kind === "policy") return proposal.payload.pattern;
  return `Pause goal ${proposal.payload.goalId}`;
}
export function automationLoadMessage(load: AutomationState["load"]): string {
  if (load.status === "error") return load.error;
  if (load.status === "connecting") return "Connecting to host…";
  return "Loading…";
}

export function proposalNeedsReview(proposal: CoordinatorProposal): boolean {
  return proposal.status === "pending" || (proposal.status === "approved" && !proposal.appliedAt);
}
export function proposalScopeText(
  proposal: CoordinatorProposal,
  projectNameForId?: (id: string) => string | undefined,
): string {
  if (proposal.payload.kind === "policy" && proposal.payload.scope === "daemon")
    return "All coordinator-covered projects on this host";
  return proposal.projectIds.map((id) => projectNameForId?.(id) ?? id).join(", ");
}
