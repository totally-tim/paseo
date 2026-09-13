import { expect, it, vi } from "vitest";
import type { CoordinatorGoal, CoordinatorProposal } from "@getpaseo/protocol/coordinator-goals";
import { openAutomation, proposalEditQuote, proposalNeedsReview, proposalScopeText } from "./model";
const goal: CoordinatorGoal = {
  id: "g",
  projectId: "p",
  proposalId: "q",
  sentence: "Check CI",
  ruleYaml: "interval: 10m",
  kind: "deterministic",
  paused: false,
  createdAt: new Date().toISOString(),
  firedCount: 2,
  emptyStreak: 0,
};
const proposal: CoordinatorProposal = {
  id: "q",
  projectIds: ["p", "p2"],
  sourceAgentId: "a",
  sentence: "Check CI",
  evidence: [],
  payload: { kind: "goal", ruleYaml: "interval: 10m" },
  status: "pending",
  createdAt: new Date().toISOString(),
};
const client = () => ({
  listCoordinatorGoals: vi.fn().mockResolvedValue([goal]),
  listCoordinatorPolicy: vi.fn().mockResolvedValue([]),
  listCoordinatorProposals: vi.fn().mockResolvedValue([proposal]),
  setCoordinatorGoalPaused: vi.fn().mockResolvedValue({ ...goal, paused: true }),
  setCoordinatorPolicyEnabled: vi.fn().mockResolvedValue({}),
  resolveCoordinatorProposal: vi.fn().mockResolvedValue(proposal),
});
it("loads daemon proposals once and approves a fanout with one request", async () => {
  const api = client();
  const model = openAutomation("proposals");
  model.setClient(api);
  await vi.waitFor(() => expect(model.getState().load.status).toBe("loaded"));
  await model.resolveProposal(proposal, "approve");
  expect(api.resolveCoordinatorProposal).toHaveBeenCalledExactlyOnceWith({
    proposalId: "q",
    action: "approve",
  });
  expect(api.listCoordinatorProposals).toHaveBeenCalledWith({});
  expect(proposalEditQuote(proposal)).toContain("Edit proposal q");
});
it("keeps errors retryable without optimistic toggle changes", async () => {
  const api = client();
  api.setCoordinatorGoalPaused.mockRejectedValueOnce(new Error("Disk full"));
  const model = openAutomation("goals", "p");
  model.setClient(api);
  await vi.waitFor(() => expect(model.getState().load.status).toBe("loaded"));
  await model.setGoalPaused(goal, true);
  expect(model.getState().operations.g).toMatchObject({ error: "Disk full", pending: false });
  expect(model.getState().load).toMatchObject({ data: { goals: [{ paused: false }] } });
  await model.setGoalPaused(goal, true);
  expect(model.getState().operations.g.success).toBe("Goal paused");
});
it("rejects mutations offline and ignores stale reads after disconnection", async () => {
  const api = client();
  let finish!: (value: CoordinatorGoal[]) => void;
  api.listCoordinatorGoals.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const model = openAutomation("goals");
  model.setClient(api);
  model.setClient(null);
  finish([goal]);
  await Promise.resolve();
  expect(model.getState().load.status).toBe("connecting");
  await model.setGoalPaused(goal, true);
  expect(api.setCoordinatorGoalPaused).not.toHaveBeenCalled();
});

it("retains approved but unapplied proposals after refresh and retries approval without editing", async () => {
  const interrupted: CoordinatorProposal = {
    ...proposal,
    status: "approved",
    approvedAt: new Date().toISOString(),
    error: "Unable to create schedule",
  };
  const api = client();
  api.listCoordinatorProposals.mockResolvedValue([interrupted]);
  const model = openAutomation("proposals");
  model.setClient(api);
  await vi.waitFor(() => expect(model.getState().load.status).toBe("loaded"));
  expect(proposalNeedsReview(interrupted)).toBe(true);
  await model.reload();
  expect(model.getState().load).toMatchObject({
    data: { proposals: [{ status: "approved", error: "Unable to create schedule" }] },
  });
  await model.resolveProposal(interrupted, "approve");
  expect(api.resolveCoordinatorProposal).toHaveBeenCalledExactlyOnceWith({
    proposalId: "q",
    action: "approve",
  });
  expect(proposalNeedsReview({ ...interrupted, appliedAt: new Date().toISOString() })).toBe(false);
});
it("labels host-wide policy scope regardless of its source project list", () => {
  expect(
    proposalScopeText({
      ...proposal,
      payload: { kind: "policy", pattern: "exact", scope: "daemon" },
    }),
  ).toBe("All coordinator-covered projects on this host");
  expect(
    proposalScopeText(
      { ...proposal, payload: { kind: "policy", pattern: "exact", scope: "projects" } },
      (id) => `Project ${id}`,
    ),
  ).toBe("Project p, Project p2");
});
