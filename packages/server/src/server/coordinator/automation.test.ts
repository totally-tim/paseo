import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { ScheduleService, type ScheduleServiceOptions } from "../schedule/service.js";
import {
  CoordinatorAutomation,
  GoalExecutionDeferred,
  type GoalExecutionOutcome,
} from "./automation.js";
import type { GoalEvent } from "./goals.js";

const agentId = "10000000-0000-4000-8000-000000000001";
const homes: string[] = [];
const liveSchedules: ScheduleService[] = [];
afterEach(async () => {
  for (const service of liveSchedules.splice(0)) await service.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const unexpected = (): never => {
  throw new Error("Ordinary agent dispatch must not be used for goals");
};
async function harness() {
  const home = await mkdtemp(path.join(tmpdir(), "goal-automation-"));
  homes.push(home);
  let now = Date.parse("2026-09-14T07:00:00Z");
  let enabled = true;
  let canRun = true;
  let deferDispatch = false;
  let fail = false;
  let failDone = false;
  let rotating = false;
  let producedOutcome: boolean | null = true;
  let workerAgentId = agentId;
  const calls: Array<{ runId: string; event?: GoalEvent }> = [];
  const done: GoalExecutionOutcome[] = [];
  const doneRunIds = new Set<string>();
  let automation: CoordinatorAutomation;
  const agentStorage = new AgentStorage(home, createTestLogger());
  await agentStorage.upsert({
    id: agentId,
    provider: "claude",
    cwd: home,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    labels: {},
    lastStatus: "idle",
  });
  const schedules = new ScheduleService({
    paseoHome: home,
    logger: createTestLogger(),
    now: () => new Date(now),
    agentStorage,
    isProtectedAgentTarget: () => rotating,
    agentManager: new Proxy(
      {},
      { get: () => unexpected },
    ) as ScheduleServiceOptions["agentManager"],
    createAgent: unexpected,
    createDirectoryWorkspace: unexpected,
    createPaseoWorktreeWorkspace: unexpected,
    archiveWorkspace: unexpected,
    runGoal: (schedule, runId) => automation.runGoal(schedule, runId),
    runner: unexpected,
  });
  const createAutomation = () =>
    new CoordinatorAutomation({
      paseoHome: home,
      now: () => now,
      schedules: () => schedules,
      getProject: async (id) => (id === "missing" ? null : { enabled, agentId }),
      listProjectIds: async () => ["project"],
      canRunGoal: async () => canRun,
      executeGoal: async (_goal, runId, event) => {
        if (deferDispatch) throw new GoalExecutionDeferred("Resident became busy");
        calls.push({ runId, event });
        if (fail) throw new Error("provider unavailable");
        return { agentId: workerAgentId, output: "Worker reported a result", producedOutcome };
      },
      appendDone: async (_goal, _runId, result) => {
        if (failDone) throw new Error("Done sink temporarily unavailable");
        if (doneRunIds.has(_runId)) {
          done[[...doneRunIds].indexOf(_runId)] = result;
        } else {
          doneRunIds.add(_runId);
          done.push(result);
        }
      },
    });
  liveSchedules.push(schedules);
  schedules.subscribeTick(() => automation.tick());
  automation = createAutomation();
  await automation.initialize();
  return {
    home,
    schedules,
    calls,
    done,
    get automation() {
      return automation;
    },
    setAdmission: (value: boolean) => {
      canRun = value;
    },
    setDeferredDispatch: (value: boolean) => {
      deferDispatch = value;
    },
    setWorker: (value: string) => {
      workerAgentId = value;
    },
    setOutcome: (value: boolean | null) => {
      producedOutcome = value;
    },
    setNow: (value: string) => {
      now = Date.parse(value);
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setRotating: (value: boolean) => {
      rotating = value;
    },
    setFailDone: (value: boolean) => {
      failDone = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
    restartScheduler: async () => {
      await schedules.stop();
      automation = createAutomation();
      await automation.initialize();
      await schedules.start();
      await schedules.stop();
    },
    restart: async () => {
      automation = createAutomation();
      await automation.initialize();
    },
  };
}
async function approve(h: Awaited<ReturnType<typeof harness>>, trigger: string) {
  let cadence = "";
  if (trigger === "cron") cadence = "cron: '0 8 * * *'\ntimezone: UTC\n";
  if (trigger === "heartbeat") cadence = "intervalMinutes: 60\n";
  const proposal = await h.automation.proposals.propose({
    sourceAgentId: agentId,
    projectIds: ["project"],
    sentence: "Keep dependencies current",
    payload: {
      kind: "goal",
      ruleYaml: `name: dependencies\non: ${trigger}\n${cadence}step:\n  profile: implementer\n  prompt: Update dependencies\nguard:\n  max_concurrent: 1\n`,
    },
  });
  await h.automation.proposals.approve(proposal!.id);
  return (await h.automation.goals.list())[0]!;
}

test("approved cron goal keeps its missed window across restart and executes once through scheduler", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  expect(h.calls).toHaveLength(0);
  h.setNow("2026-09-17T10:00:00Z");
  await h.restart();
  expect(await h.schedules.list()).toHaveLength(1);
  await h.schedules.tick();
  await h.schedules.tick();
  await expect.poll(() => h.done.length).toBe(1);
  expect(h.calls).toHaveLength(1);
  expect(h.done).toHaveLength(1);
  expect((await h.automation.goals.get("project", goal.id))?.firedCount).toBe(1);
  // Done is delivered before the scheduler persists its completed run.
  await expect
    .poll(async () => (await h.schedules.inspect(goal.scheduleId!)).nextRunAt)
    .toBe("2026-09-18T08:00:00.000Z");
});

test("repeated concurrent polls and restart deliver one event with its saved context", async () => {
  const h = await harness();
  const goal = await approve(h, "pr.ci_failed");
  expect((await h.schedules.inspect(goal.scheduleId!)).status).toBe("paused");
  const event: GoalEvent = {
    id: "pr-42-ci-sha",
    projectId: "project",
    trigger: "pr.ci_failed",
    occurredAt: "2026-09-14T07:00:00Z",
    context: { number: 42, head: "sha" },
  };
  await Promise.all([h.automation.emitEvent(event), h.automation.emitEvent(event)]);
  await expect.poll(() => h.done.length).toBe(1);
  await expect
    .poll(async () => (await h.schedules.logs(goal.scheduleId!))[0]?.status)
    .toBe("succeeded");
  await h.restart();
  await h.automation.emitEvent(event);
  await h.schedules.tick();
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.event?.context).toEqual(event.context);
  expect(await h.schedules.logs(goal.scheduleId!)).toHaveLength(1);
});

test("disable pauses goals durably and failed execution requires explicit resume without replay", async () => {
  const h = await harness();
  const goal = await approve(h, "pr.opened");
  h.setFail(true);
  const event: GoalEvent = {
    id: "opened-1",
    projectId: "project",
    trigger: "pr.opened",
    occurredAt: "2026-09-14T07:00:00Z",
  };
  await h.automation.emitEvent(event);
  await expect
    .poll(async () => (await h.automation.goals.get("project", goal.id))?.lastError)
    .toBe("provider unavailable");
  await h.restart();
  await h.automation.emitEvent(event);
  expect(h.calls).toHaveLength(1);
  h.setFail(false);
  await h.automation.goals.setPaused("project", goal.id, false);
  await h.automation.emitEvent({ ...event, id: "opened-2" });
  await expect.poll(() => h.done.length).toBe(1);
  expect(h.calls).toHaveLength(2);
  h.setEnabled(false);
  await h.automation.reconcile();
  h.setEnabled(true);
  await h.restart();
  await h.automation.emitEvent({ ...event, id: "opened-3" });
  expect(h.calls).toHaveLength(2);
  expect((await h.automation.goals.get("project", goal.id))?.paused).toBe(true);
});

test("event receipt waits through protected rotation and survives restart", async () => {
  const h = await harness();
  const goal = await approve(h, "pr.merged");
  h.setRotating(true);
  const event: GoalEvent = {
    id: "merge-123",
    projectId: "project",
    trigger: "pr.merged",
    occurredAt: "2026-09-14T07:00:00Z",
    context: { mergeCommit: "abc123" },
  };
  await h.automation.emitEvent(event);
  await h.automation.reconcile();
  expect(h.calls).toHaveLength(0);
  h.setRotating(false);
  await h.restart();
  await h.schedules.tick();
  await expect.poll(() => h.done.length).toBe(1);
  expect(h.calls[0]?.event?.context).toEqual(event.context);
  await expect
    .poll(async () => (await h.schedules.logs(goal.scheduleId!))[0]?.status)
    .toBe("succeeded");
});

test("completion outbox retries Done after restart without executing the worker twice", async () => {
  const h = await harness();
  const goal = await approve(h, "pr.opened");
  h.setFailDone(true);
  await h.automation.emitEvent({
    id: "opened-7",
    projectId: "project",
    trigger: "pr.opened",
    occurredAt: "2026-09-14T07:00:00Z",
  });
  await expect
    .poll(async () => (await h.schedules.logs(goal.scheduleId!))[0]?.status)
    .toBe("failed");
  expect(h.calls).toHaveLength(1);
  expect(h.done).toHaveLength(0);
  h.setFailDone(false);
  await h.restart();
  expect(h.done).toHaveLength(1);
  expect(h.calls).toHaveLength(1);
});

test("an unavailable approved project remains visible without blocking startup or another goal", async () => {
  const h = await harness();
  const proposal = await h.automation.proposals.propose({
    sourceAgentId: agentId,
    projectIds: ["missing"],
    sentence: "Missing owner",
    payload: {
      kind: "goal",
      ruleYaml:
        "name: missing\non: cron\ncron: '0 8 * * *'\nstep: { profile: implementer, prompt: Check }\nguard: { max_concurrent: 1 }\n",
    },
  });
  await expect(h.automation.proposals.approve(proposal!.id)).rejects.toThrow("no coordinator");
  const goal = await approve(h, "cron").catch(
    async () => (await h.automation.goals.list("project"))[0]!,
  );
  await h.restart();
  h.setNow("2026-09-14T09:00:00Z");
  await h.schedules.tick();
  await expect.poll(() => h.done.length).toBe(1);
  expect((await h.automation.goals.get("project", goal.id))?.firedCount).toBe(1);
  expect((await h.automation.proposals.list("missing"))[0]?.error).toContain("no coordinator");
});

const artifact = {
  projectId: "project",
  workerAgentId: agentId,
  summary: "Opened dependency pull request",
  artifactUrl: "https://example.test/pulls/42",
};
test("verified artifact received before completion survives restart and attributes the exact worker", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  h.setOutcome(null);
  await h.automation.recordArtifact(artifact);
  await h.restart();
  await h.schedules.runGoalOnce(goal.scheduleId!);
  expect(h.done).toHaveLength(1);
  expect(h.done[0]).toMatchObject({ producedOutcome: true, artifactUrl: artifact.artifactUrl });
  expect((await h.automation.goals.get("project", goal.id))?.lastOutcome).toBe("produced");
});
test("late verified artifact corrects the existing completion and Done row once", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  h.setOutcome(false);
  await h.schedules.runGoalOnce(goal.scheduleId!);
  expect((await h.automation.goals.get("project", goal.id))?.emptyStreak).toBe(1);
  await h.automation.recordArtifact({ ...artifact, workerAgentId: "unrelated-worker" });
  await h.automation.recordArtifact({ ...artifact, projectId: "other-project" });
  expect(h.done[0]?.producedOutcome).toBe(false);
  await Promise.all([h.automation.recordArtifact(artifact), h.automation.recordArtifact(artifact)]);
  expect(h.done).toHaveLength(1);
  expect(h.done[0]?.producedOutcome).toBe(true);
  expect(h.done[0]?.output.match(/Verified artifact:/g)).toHaveLength(1);
  expect(await h.automation.goals.get("project", goal.id)).toMatchObject({
    emptyStreak: 0,
    lastOutcome: "produced",
  });
  await h.restart();
  expect(h.done).toHaveLength(1);
  expect((await h.automation.goals.get("project", goal.id))?.lastOutcome).toBe("produced");
});
test("artifact cannot attribute one worker ambiguously reused across two goal runs", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  h.setOutcome(null);
  await h.schedules.runGoalOnce(goal.scheduleId!);
  await h.schedules.runGoalOnce(goal.scheduleId!);
  await h.automation.recordArtifact(artifact);
  expect(h.done).toHaveLength(2);
  expect(h.done.every((result) => result.producedOutcome === null)).toBe(true);
});

test("late artifact supersedes a pending three-empty pause suggestion without resuming user-paused goals", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  h.setOutcome(false);
  for (let i = 1; i <= 3; i++) {
    h.setWorker(`10000000-0000-4000-8000-00000000000${i}`);
    await h.schedules.runGoalOnce(goal.scheduleId!);
  }
  expect(
    (await h.automation.proposals.list()).filter((proposal) => proposal.status === "pending"),
  ).toHaveLength(1);
  await h.automation.goals.setPaused("project", goal.id, true);
  await h.automation.recordArtifact({
    ...artifact,
    workerAgentId: "10000000-0000-4000-8000-000000000003",
  });
  expect(
    (await h.automation.proposals.list()).filter((proposal) => proposal.status === "pending"),
  ).toHaveLength(0);
  expect(await h.automation.goals.get("project", goal.id)).toMatchObject({
    emptyStreak: 0,
    paused: true,
  });
});

test("judgment admission and dispatch deferrals never claim a fired run or create a Done row", async () => {
  const h = await harness();
  const goal = await approve(h, "heartbeat");
  h.setAdmission(false);
  await h.schedules.runGoalOnce(goal.scheduleId!);
  expect(h.calls).toHaveLength(0);
  expect((await h.automation.goals.get("project", goal.id))?.firedCount).toBe(0);
  h.setAdmission(true);
  h.setDeferredDispatch(true);
  await h.schedules.runGoalOnce(goal.scheduleId!);
  expect(await h.automation.goals.get("project", goal.id)).toMatchObject({
    firedCount: 0,
    paused: false,
    runs: {},
  });
  expect(h.done).toHaveLength(0);
  h.setDeferredDispatch(false);
  await h.schedules.runGoalOnce(goal.scheduleId!);
  expect((await h.automation.goals.get("project", goal.id))?.firedCount).toBe(1);
  expect(h.done).toHaveLength(1);
});

test("review regression: real scheduler startup fires one missed cron window", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  h.setNow("2026-09-17T10:00:00Z");
  await h.restartScheduler();
  await h.schedules.tick();
  await expect.poll(() => h.done.length).toBe(1);
  await expect
    .poll(async () => (await h.schedules.inspect(goal.scheduleId!)).nextRunAt)
    .toBe("2026-09-18T08:00:00.000Z");
  await h.schedules.tick();
  expect(h.calls).toHaveLength(1);
});

test("review regression: unchanged reconciliation preserves rule and goal file inodes", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  const files = [
    path.join(h.home, "coordinator/goals.json"),
    path.join(h.home, "coordinator/goals/project", `${goal.id}.yml`),
  ];
  const before = await Promise.all(files.map((file) => stat(file)));
  for (let i = 0; i < 10; i++) {
    await h.automation.tick();
    await h.automation.reconcile(false);
  }
  const after = await Promise.all(files.map((file) => stat(file)));
  expect(after.map((entry) => entry.ino)).toEqual(before.map((entry) => entry.ino));
  expect(after.map((entry) => entry.mtimeMs)).toEqual(before.map((entry) => entry.mtimeMs));
});

test("review regression: generic schedule controls explicitly reject goal ownership", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  const id = goal.scheduleId!;
  await expect(h.schedules.pause(id)).rejects.toThrow("Goals");
  await expect(h.schedules.resume(id)).rejects.toThrow("Goals");
  await expect(h.schedules.delete(id)).rejects.toThrow("Goals");
  await expect(h.schedules.update({ id, prompt: "replace approved instruction" })).rejects.toThrow(
    "Goals",
  );
  await expect(h.schedules.runOnce(id)).rejects.toThrow("Goals");
  await h.automation.goals.setPaused("project", goal.id, true);
  expect((await h.schedules.inspect(id)).status).toBe("paused");
  await h.automation.goals.setPaused("project", goal.id, false);
  expect((await h.schedules.inspect(id)).status).toBe("active");
});

test("review regression: deterministic dispatch deferral restores its event without error or duplicate firing", async () => {
  const h = await harness();
  const goal = await approve(h, "pr.opened");
  h.setDeferredDispatch(true);
  const event: GoalEvent = {
    id: "deferred-open",
    projectId: "project",
    trigger: "pr.opened",
    occurredAt: new Date().toISOString(),
  };
  await h.automation.emitEvent(event);
  await expect
    .poll(async () => (await h.schedules.logs(goal.scheduleId!))[0]?.status)
    .toBe("succeeded");
  expect((await h.automation.goals.get("project", goal.id))?.lastError).toBeUndefined();
  expect((await h.automation.goals.get("project", goal.id))?.firedCount).toBe(0);
  h.setDeferredDispatch(false);
  await h.restart();
  await h.automation.tick();
  await expect.poll(() => h.done.length).toBe(1);
  await expect
    .poll(async () => (await h.schedules.logs(goal.scheduleId!)).at(-1)?.status)
    .toBe("succeeded");
  await h.automation.emitEvent(event);
  expect(h.calls).toHaveLength(1);
});

test("review regression: an automatic pause proposal cites its three completed empty runs", async () => {
  const h = await harness();
  const goal = await approve(h, "cron");
  h.setOutcome(false);
  for (let i = 0; i < 3; i++) await h.schedules.runGoalOnce(goal.scheduleId!);
  const proposal = (await h.automation.proposals.list()).find(
    (entry) => entry.payload.kind === "pause_goal",
  )!;
  const current = (await h.automation.goals.get("project", goal.id))!;
  expect(proposal.evidence).toHaveLength(3);
  for (const [runId, run] of Object.entries(current.runs))
    expect(
      proposal.evidence.some(
        (entry) => entry.title.includes(runId) && entry.title.includes(run.summary!),
      ),
    ).toBe(true);
});
