import { expect, test } from "vitest";
import { matchesGoalEvent, parseGoalRule } from "./goals.js";

test("goal YAML validates executable triggers and all idle activity", () => {
  const rule = parseGoalRule(
    `name: stale\non: pr.idle\nfilters:\n  days: 3\n  authors: [alice]\nstep:\n  profile: implementer\n  prompt: Rebase the change request\nguard:\n  max_concurrent: 1\n`,
  );
  expect(
    matchesGoalEvent(rule, {
      id: "event",
      projectId: "p",
      trigger: "pr.idle",
      occurredAt: "2026-09-13T12:00:00Z",
      author: "alice",
      lastActivityAt: "2026-09-10T12:00:00Z",
    }),
  ).toBe(true);
  expect(
    matchesGoalEvent(rule, {
      id: "event",
      projectId: "p",
      trigger: "pr.idle",
      occurredAt: "2026-09-13T12:00:00Z",
      author: "alice",
      lastActivityAt: "2026-09-12T12:00:00Z",
    }),
  ).toBe(false);
  expect(() =>
    parseGoalRule("name: bad\non: shell\nstep: { profile: implementer, prompt: run }\n"),
  ).toThrow();
  expect(() =>
    parseGoalRule(
      "name: bad\non: cron\ncron: invalid\nstep: { profile: implementer, prompt: run }\n",
    ),
  ).toThrow();
  expect(() => parseGoalRule("name: x\nname: duplicate\n")).toThrow();
});

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoordinatorGoals } from "./goals.js";

const weekly =
  "name: dependencies\non: cron\ncron: '0 8 * * 1'\nstep:\n  profile: implementer\n  prompt: Update dependencies\nguard:\n  max_concurrent: 1\n";
test("approved global goals fan out once, retain YAML, and count empty runs until a pause proposal", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-goals-"));
  const scheduleIds = new Set<string>();
  const proposals: number[] = [];
  const deps = {
    paseoHome: home,
    now: () => Date.parse("2026-09-14T08:00:00Z"),
    ensureSchedule: async (goal: { id: string }) => {
      scheduleIds.add(goal.id);
      return goal.id;
    },
    setSchedulePaused: async () => {},
    requestPauseProposal: async (goal: { emptyStreak: number }) => {
      proposals.push(goal.emptyStreak);
    },
  };
  try {
    const goals = new CoordinatorGoals(deps);
    await goals.initialize();
    const [first] = await goals.installApproved({
      proposalId: "approved",
      projectIds: ["a", "b"],
      sentence: "Keep dependencies current",
      ruleYaml: weekly,
    });
    await goals.installApproved({
      proposalId: "approved",
      projectIds: ["a", "b"],
      sentence: "Keep dependencies current",
      ruleYaml: weekly,
    });
    expect(scheduleIds.size).toBe(2);
    expect(
      await readFile(path.join(home, "coordinator", "goals", "a", `${first.id}.yml`), "utf8"),
    ).toBe(weekly);
    expect(await goals.claimRun("a", first.id, "one")).not.toBeNull();
    expect(await goals.claimRun("a", first.id, "blocked")).toBeNull();
    await goals.completeRun("a", first.id, "one", {
      producedOutcome: false,
      summary: "No changes",
    });
    await goals.completeRun("a", first.id, "one", {
      producedOutcome: false,
      summary: "No changes",
    });
    for (const id of ["two", "three"]) {
      await goals.claimRun("a", first.id, id);
      await goals.completeRun("a", first.id, id, { producedOutcome: false, summary: "No changes" });
    }
    expect(proposals).toEqual([3]);
    const restored = new CoordinatorGoals(deps);
    await restored.initialize();
    expect((await restored.get("a", first.id))?.firedCount).toBe(3);
    expect((await restored.get("a", first.id))?.paused).toBe(false);
    await restored.setPaused("a", first.id, true);
    expect(await restored.claimRun("a", first.id, "paused")).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("event receipts reject replay and unfinished runs require attention after restart", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-goal-event-"));
  const deps = {
    paseoHome: home,
    now: () => Date.parse("2026-09-14T08:00:00Z"),
    ensureSchedule: async () => "schedule",
    setSchedulePaused: async () => {},
    requestPauseProposal: async () => {},
  };
  try {
    const goals = new CoordinatorGoals(deps);
    await goals.initialize();
    const [goal] = await goals.installApproved({
      proposalId: "approved",
      projectIds: ["a"],
      sentence: "Fix CI",
      ruleYaml: weekly.replace("on: cron\ncron: '0 8 * * 1'", "on: pr.ci_failed"),
    });
    const event = {
      id: "ci-run-1",
      projectId: "a",
      trigger: "pr.ci_failed" as const,
      occurredAt: "2026-09-14T08:00:00Z",
    };
    expect(await goals.claimRun("a", goal.id, "run-1", event)).not.toBeNull();
    await goals.completeRun("a", goal.id, "run-1", {
      producedOutcome: true,
      summary: "Opened #51",
    });
    expect(await goals.claimRun("a", goal.id, "run-2", event)).toBeNull();
    await goals.claimRun("a", goal.id, "run-3", { ...event, id: "ci-run-2" });
    const restored = new CoordinatorGoals(deps);
    await restored.initialize();
    expect((await restored.get("a", goal.id))?.runs["run-3"].status).toBe("attention");
    expect(await restored.claimRun("a", goal.id, "run-4", { ...event, id: "ci-run-3" })).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("unknown goal results interrupt consecutive empty evidence and survive restart", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-unknown-"));
  let proposals = 0;
  const deps = {
    paseoHome: home,
    now: () => 0,
    ensureSchedule: async () => "schedule",
    setSchedulePaused: async () => {},
    requestPauseProposal: async () => {
      proposals++;
    },
  };
  try {
    const goals = new CoordinatorGoals(deps);
    await goals.initialize();
    const [goal] = await goals.installApproved({
      proposalId: "approved",
      projectIds: ["project"],
      sentence: "Observe",
      ruleYaml: weekly,
    });
    for (const [index, producedOutcome] of [false, false, null].entries()) {
      await goals.claimRun("project", goal.id, String(index));
      await goals.completeRun("project", goal.id, String(index), {
        producedOutcome,
        summary: "Run result",
      });
    }
    const restored = new CoordinatorGoals(deps);
    await restored.initialize();
    expect(await restored.get("project", goal.id)).toMatchObject({
      emptyStreak: 0,
      lastOutcome: "unknown",
    });
    expect(proposals).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("late verified evidence preserves completion order when correcting an older run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-late-artifact-"));
  const goals = new CoordinatorGoals({
    paseoHome: home,
    now: () => 0,
    ensureSchedule: async () => "schedule",
    setSchedulePaused: async () => {},
    requestPauseProposal: async () => {},
  });
  try {
    const [goal] = await goals.installApproved({
      proposalId: "approved",
      projectIds: ["project"],
      sentence: "Observe",
      ruleYaml: weekly,
    });
    for (const runId of ["first", "second"]) {
      await goals.claimRun("project", goal.id, runId);
      await goals.completeRun("project", goal.id, runId, {
        producedOutcome: false,
        summary: "No reported artifact",
      });
    }
    await goals.completeRun("project", goal.id, "first", {
      producedOutcome: true,
      summary: "Verified remote artifact",
    });
    expect(await goals.get("project", goal.id)).toMatchObject({
      emptyStreak: 1,
      lastOutcome: "empty",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed goal execution interrupts the consecutive empty streak", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "goal-failed-outcome-"));
  const goals = new CoordinatorGoals({
    paseoHome: home,
    now: () => 0,
    ensureSchedule: async () => "schedule",
    setSchedulePaused: async () => {},
    requestPauseProposal: async () => {},
  });
  try {
    const [goal] = await goals.installApproved({
      proposalId: "approved",
      projectIds: ["project"],
      sentence: "Observe",
      ruleYaml: weekly,
    });
    for (const runId of ["first", "second"]) {
      await goals.claimRun("project", goal.id, runId);
      await goals.completeRun("project", goal.id, runId, {
        producedOutcome: false,
        summary: "No result",
      });
    }
    await goals.claimRun("project", goal.id, "failed");
    await goals.markRunAttention("project", goal.id, "failed", "Provider unavailable");
    expect(await goals.get("project", goal.id)).toMatchObject({
      emptyStreak: 0,
      lastOutcome: "unknown",
    });
    await goals.setPaused("project", goal.id, false);
    await goals.claimRun("project", goal.id, "after-failure");
    await goals.completeRun("project", goal.id, "after-failure", {
      producedOutcome: false,
      summary: "No result",
    });
    expect((await goals.get("project", goal.id))?.emptyStreak).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
