import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { CoordinatorProposal } from "@getpaseo/protocol/coordinator-goals";
import type { ScheduleExecutionResult, StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { ScheduleService } from "../schedule/service.js";
import { AutomationStore } from "./automation-store.js";
import {
  CoordinatorGoals,
  matchesGoalEvent,
  parseGoalRule,
  type GoalEvent,
  type GoalRecord,
} from "./goals.js";
import { CoordinatorPolicy } from "./policy.js";
import { CoordinatorProposals } from "./proposals.js";

/** Admission changed before dispatch; preserve the next heartbeat without recording a failure. */
export class GoalExecutionDeferred extends Error {}

export interface GoalExecutionOutcome {
  agentId: string;
  output: string;
  producedOutcome: boolean | null;
  artifactUrl?: string;
}
export interface CoordinatorAutomationDeps {
  paseoHome: string;
  now: () => number;
  schedules: () => ScheduleService;
  getProject: (projectId: string) => Promise<{ enabled: boolean; agentId: string | null } | null>;
  listProjectIds: () => Promise<string[]>;
  pauseGoal?: (projectId: string, goalId: string) => Promise<void>;
  canRunGoal?: (goal: GoalRecord) => Promise<boolean>;
  executeGoal: (
    goal: GoalRecord,
    runId: string,
    event?: GoalEvent,
  ) => Promise<GoalExecutionOutcome>;
  appendDone: (goal: GoalRecord, runId: string, result: GoalExecutionOutcome) => Promise<void>;
}
const EventSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  trigger: z.enum([
    "cron",
    "pr.opened",
    "pr.ci_failed",
    "pr.idle",
    "pr.merged",
    "agent.stalled",
    "heartbeat",
  ]),
  occurredAt: z.string(),
  author: z.string().optional(),
  lastActivityAt: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export const GoalArtifactSchema = z
  .object({
    projectId: z.string().min(1),
    workerAgentId: z.string().min(1),
    summary: z.string().min(1).max(4000),
    artifactUrl: z.url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol)),
  })
  .strict();
export type GoalArtifact = z.infer<typeof GoalArtifactSchema>;
const ArtifactsSchema = z.object({ items: z.array(GoalArtifactSchema.extend({ id: z.string() })) });
const ReceiptsSchema = z.object({
  events: z.array(
    z.object({
      goalId: z.string(),
      event: EventSchema,
      delivered: z.boolean(),
      deferredRunId: z.string().optional(),
    }),
  ),
});

/** Approved configuration and event receipts bridge to the existing scheduler. */
export class CoordinatorAutomation {
  readonly goals: CoordinatorGoals;
  readonly proposals: CoordinatorProposals;
  readonly policy: CoordinatorPolicy;
  private readonly receipts: AutomationStore<z.infer<typeof ReceiptsSchema>>;
  private readonly artifacts: AutomationStore<z.infer<typeof ArtifactsSchema>>;
  private completionTail: Promise<unknown> = Promise.resolve();
  private readonly completions: AutomationStore<{
    items: Array<{
      projectId: string;
      goalId: string;
      runId: string;
      result: GoalExecutionOutcome;
      delivered: boolean;
      deliveredArtifacts?: string[];
    }>;
  }>;
  private readonly eventRuns = new Set<string>();
  private nextRecoveryAt = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: CoordinatorAutomationDeps) {
    this.receipts = new AutomationStore(
      path.join(deps.paseoHome, "coordinator", "goal-events.json"),
      ReceiptsSchema,
      () => ({ events: [] }),
    );
    this.artifacts = new AutomationStore(
      path.join(deps.paseoHome, "coordinator", "goal-artifacts.json"),
      ArtifactsSchema,
      () => ({ items: [] }),
    );
    this.completions = new AutomationStore(
      path.join(deps.paseoHome, "coordinator", "goal-completions.json"),
      z.object({
        items: z.array(
          z.object({
            projectId: z.string(),
            goalId: z.string(),
            runId: z.string(),
            result: z.object({
              agentId: z.string(),
              output: z.string(),
              producedOutcome: z.boolean().nullable(),
              artifactUrl: z.string().optional(),
            }),
            delivered: z.boolean(),
            deliveredArtifacts: z.array(z.string()).optional(),
          }),
        ),
      }),
      () => ({ items: [] }),
    );
    this.policy = new CoordinatorPolicy(deps);
    this.proposals = new CoordinatorProposals({
      ...deps,
      apply: (proposal) => this.apply(proposal),
    });
    this.goals = new CoordinatorGoals({
      ...deps,
      ensureSchedule: (goal) => this.ensureSchedule(goal),
      setSchedulePaused: async (id, paused) => {
        const schedule = await deps.schedules().inspect(id);
        const owner =
          schedule.target.type === "agent" && schedule.target.goal
            ? await deps.getProject(schedule.target.goal.projectId)
            : null;
        const shouldPause = paused || !owner?.enabled;
        if (shouldPause && schedule.status === "active")
          await deps.schedules().setGoalSchedulePaused(id, true);
        if (!shouldPause && schedule.status === "paused")
          await deps.schedules().setGoalSchedulePaused(id, false);
      },
      requestPauseProposal: async (goal) => {
        const owner = await deps.getProject(goal.projectId);
        if (!owner?.agentId) throw new Error("Goal project has no coordinator");
        await this.proposals.propose({
          sourceAgentId: owner.agentId,
          projectIds: [goal.projectId],
          sentence: `Pause ${goal.sentence}: three consecutive runs produced no outcome.`,
          payload: { kind: "pause_goal", goalId: goal.id },
          evidence: Object.entries(goal.runs)
            .filter(([, run]) => run.status === "completed" && run.producedOutcome === false)
            .sort(([, left], [, right]) => (left.completedOrder ?? 0) - (right.completedOrder ?? 0))
            .slice(-3)
            .map(([runId, run]) => ({
              title: `Run ${runId}: ${(run.summary ?? "").slice(0, 1000)}`,
            })),
        });
      },
    });
  }
  async initialize(): Promise<void> {
    await this.recoverDeferredEvents();
    await this.goals.initialize();
    await this.policy.initialize();
    await this.proposals.initialize();
    await this.reconcile(false);
  }
  private async apply(proposal: CoordinatorProposal): Promise<void> {
    const payload = proposal.payload;
    if (payload.kind === "goal") {
      await this.goals.installApproved({
        proposalId: proposal.id,
        projectIds: proposal.projectIds,
        sentence: proposal.sentence,
        ruleYaml: payload.ruleYaml,
      });
    } else if (payload.kind === "pause_goal") {
      for (const projectId of proposal.projectIds)
        if (this.deps.pauseGoal) await this.deps.pauseGoal(projectId, payload.goalId);
        else await this.goals.setPaused(projectId, payload.goalId, true);
    } else {
      for (const scope of payload.scope === "daemon" ? ["daemon"] : proposal.projectIds)
        await this.policy.addApproved({ scope, pattern: payload.pattern });
    }
  }
  private async ensureSchedule(goal: GoalRecord): Promise<string> {
    const schedules = this.deps.schedules();
    const existing = (await schedules.list()).find(
      (schedule) =>
        schedule.target.type === "agent" &&
        schedule.target.goal?.goalId === goal.id &&
        schedule.target.goal.projectId === goal.projectId &&
        schedule.status !== "completed",
    );
    if (existing) return existing.id;
    const owner = await this.deps.getProject(goal.projectId);
    if (!owner?.agentId) throw new Error("Goal project has no coordinator");
    const rule = parseGoalRule(goal.ruleYaml);
    const created = await schedules.create({
      name: `Goal: ${rule.name}`,
      prompt: rule.step.prompt,
      target: {
        type: "agent",
        agentId: owner.agentId,
        goal: { projectId: goal.projectId, goalId: goal.id },
      },
      cadence:
        rule.on === "cron"
          ? { type: "cron", expression: rule.cron!, timezone: rule.timezone }
          : { type: "every", everyMs: (rule.intervalMinutes ?? 60) * 60000 },
      runOnCreate: false,
    });
    return created.id;
  }
  async pauseProject(projectId: string): Promise<void> {
    for (const goal of await this.goals.list(projectId))
      if (!goal.paused) await this.goals.setPaused(projectId, goal.id, true).catch(() => undefined);
  }
  reconcile(dispatchEvents = true): Promise<void> {
    const job = this.tail.then(async () => {
      this.nextRecoveryAt = this.deps.now() + 30000;
      await this.proposals.reconcile().catch(() => undefined);
      const projectIds = new Set([
        ...(await this.deps.listProjectIds()),
        ...(await this.goals.list()).map((goal) => goal.projectId),
      ]);
      for (const id of projectIds)
        if (!(await this.deps.getProject(id))?.enabled)
          await this.pauseProject(id).catch(() => undefined);
      await this.goals.reconcile().catch(() => undefined);
      await this.drainCompletions();
      if (dispatchEvents) await this.drainEvents();
      return;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
  /** Hot path: receipts drain every tick; configuration repair retries are bounded. */
  tick(): Promise<void> {
    const job = this.tail.then(async () => {
      await this.recoverDeferredEvents();
      if (this.deps.now() >= this.nextRecoveryAt) {
        this.nextRecoveryAt = this.deps.now() + 30000;
        await this.proposals.reconcile().catch(() => undefined);
        const incomplete = (await this.goals.list()).filter(
          (goal) => !goal.scheduleId || goal.pauseProposalPending,
        );
        if (incomplete.length)
          await this.goals.reconcile(incomplete.map((goal) => goal.id)).catch(() => undefined);
      }
      await this.drainCompletions();
      await this.drainEvents();
      return;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
  async emitEvent(event: GoalEvent): Promise<void> {
    EventSchema.parse(event);
    const matching = (await this.goals.list(event.projectId)).filter(
      (goal) => !goal.paused && matchesGoalEvent(parseGoalRule(goal.ruleYaml), event),
    );
    const existing = (await this.receipts.read()).events;
    const fresh = matching.filter(
      (goal) =>
        !existing.some(
          (entry) =>
            entry.goalId === goal.id &&
            entry.event.id === event.id &&
            entry.event.projectId === event.projectId,
        ),
    );
    if (fresh.length)
      await this.receipts.change((state) => {
        for (const goal of fresh)
          if (
            !state.events.some(
              (entry) =>
                entry.goalId === goal.id &&
                entry.event.id === event.id &&
                entry.event.projectId === event.projectId,
            )
          )
            state.events.push({ goalId: goal.id, event: structuredClone(event), delivered: false });
      });
    await this.tick();
  }
  private async recoverDeferredEvents(): Promise<void> {
    for (const receipt of (await this.receipts.read()).events) {
      if (!receipt.deferredRunId) continue;
      await this.goals.deferRun(receipt.event.projectId, receipt.goalId, receipt.deferredRunId);
      await this.receipts.change((state) => {
        const current = state.events.find(
          (entry) =>
            entry.goalId === receipt.goalId &&
            entry.event.projectId === receipt.event.projectId &&
            entry.event.id === receipt.event.id,
        )!;
        delete current.deferredRunId;
        current.delivered = false;
      });
    }
  }
  private async drainEvents(): Promise<void> {
    for (const receipt of (await this.receipts.read()).events) {
      if (receipt.delivered || !(await this.deps.getProject(receipt.event.projectId))?.enabled)
        continue;
      const goal = await this.goals.get(receipt.event.projectId, receipt.goalId);
      if (!goal || goal.paused || !goal.scheduleId) continue;
      if (this.eventRuns.has(goal.scheduleId)) continue;
      this.eventRuns.add(goal.scheduleId);
      // The scheduler tick must remain free while a goal worker is running.
      // Rotation or another active run leaves the durable receipt pending.
      void this.deps
        .schedules()
        .runGoalOnce(goal.scheduleId)
        .catch(() => undefined)
        .finally(() => {
          this.eventRuns.delete(goal.scheduleId!);
        });
    }
  }
  async runGoal(schedule: StoredSchedule, runId: string): Promise<ScheduleExecutionResult> {
    const target = schedule.target;
    if (target.type !== "agent" || !target.goal) throw new Error("Schedule has no goal target");
    const { projectId, goalId } = target.goal;
    const configured = await this.goals.get(projectId, goalId);
    if (!configured || configured.scheduleId !== schedule.id)
      throw new Error("Schedule is not the approved goal schedule");
    if (!(await this.deps.getProject(projectId))?.enabled)
      return { agentId: null, output: "Goal project is disabled" };
    if (this.deps.canRunGoal && !(await this.deps.canRunGoal(configured)))
      return { agentId: null, output: "Goal deferred until its coordinator is available" };
    const receipt = (await this.receipts.read()).events.find(
      (entry) => !entry.delivered && entry.goalId === goalId && entry.event.projectId === projectId,
    );
    const goal = await this.goals.claimRun(projectId, goalId, runId, receipt?.event);
    if (!goal) {
      const existing = await this.goals.get(projectId, goalId);
      if (
        receipt &&
        existing &&
        Object.values(existing.runs).some((run) => run.eventId === receipt.event.id)
      )
        await this.markDelivered(goalId, receipt.event);
      return {
        agentId: null,
        output: "Goal paused, already claimed, or concurrency limit reached",
      };
    }
    if (receipt) await this.markDelivered(goalId, receipt.event);
    let result: GoalExecutionOutcome;
    try {
      result = await this.deps.executeGoal(goal, runId, receipt?.event);
    } catch (error) {
      if (error instanceof GoalExecutionDeferred) {
        await this.deferExecution(projectId, goalId, runId, receipt?.event);
        return { agentId: null, output: error.message };
      }
      await this.goals.markRunAttention(
        projectId,
        goalId,
        runId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    await this.completions.change((state) => {
      state.items.push({ projectId, goalId, runId, result, delivered: false });
    });
    return this.deliverCompletion({ projectId, goalId, runId, result });
  }
  private async deferExecution(
    projectId: string,
    goalId: string,
    runId: string,
    event?: GoalEvent,
  ): Promise<void> {
    if (event)
      await this.receipts.change((state) => {
        const current = state.events.find(
          (entry) =>
            entry.goalId === goalId &&
            entry.event.projectId === projectId &&
            entry.event.id === event.id,
        )!;
        current.deferredRunId = runId;
        current.delivered = false;
      });
    await this.goals.deferRun(projectId, goalId, runId);
    if (event) await this.recoverDeferredEvents();
  }
  /** Only the trusted forge hook supplies verified, exactly attributed worker artifacts. */
  async recordArtifact(input: GoalArtifact): Promise<void> {
    const artifact = GoalArtifactSchema.parse(input);
    const id = createHash("sha256")
      .update(JSON.stringify([artifact.projectId, artifact.workerAgentId, artifact.artifactUrl]))
      .digest("hex");
    await this.artifacts.change((state) => {
      if (!state.items.some((item) => item.id === id)) state.items.push({ ...artifact, id });
    });
    await this.drainCompletions();
  }
  private async drainCompletions(): Promise<void> {
    for (const item of (await this.completions.read()).items)
      await this.deliverCompletion(item).catch(() => undefined);
  }
  private deliverCompletion(item: {
    projectId: string;
    goalId: string;
    runId: string;
    result: GoalExecutionOutcome;
  }): Promise<GoalExecutionOutcome> {
    const job = this.completionTail.then(() => this.runDeliverCompletion(item));
    this.completionTail = job.catch(() => undefined);
    return job;
  }
  private async runDeliverCompletion(item: {
    projectId: string;
    goalId: string;
    runId: string;
    result: GoalExecutionOutcome;
  }): Promise<GoalExecutionOutcome> {
    const completions = (await this.completions.read()).items;
    const current = completions.find(
      (entry) =>
        entry.projectId === item.projectId &&
        entry.goalId === item.goalId &&
        entry.runId === item.runId,
    );
    if (!current) throw new Error("Goal completion receipt not found");
    const matches = completions.filter(
      (entry) => entry.projectId === item.projectId && entry.result.agentId === item.result.agentId,
    );
    // One worker cannot establish attribution to two separate runs.
    const artifacts =
      matches.length === 1
        ? (await this.artifacts.read()).items.filter(
            (entry) =>
              entry.projectId === item.projectId && entry.workerAgentId === item.result.agentId,
          )
        : [];
    const artifactIds = artifacts.map((entry) => entry.id);
    const result: GoalExecutionOutcome = artifacts.length
      ? {
          ...current.result,
          producedOutcome: true,
          output: `${current.result.output}\n${artifacts.map((entry) => `Verified artifact: ${entry.summary} (${entry.artifactUrl})`).join("\n")}`,
          artifactUrl: artifacts[0]!.artifactUrl,
        }
      : current.result;
    if (
      current.delivered &&
      JSON.stringify(current.deliveredArtifacts ?? []) === JSON.stringify(artifactIds)
    )
      return result;
    const goal = await this.goals.get(item.projectId, item.goalId);
    if (!goal) throw new Error("Completed goal no longer exists");
    await this.goals.completeRun(item.projectId, item.goalId, item.runId, {
      producedOutcome: result.producedOutcome,
      summary: result.output,
    });
    const updated = await this.goals.get(item.projectId, item.goalId);
    if (updated && updated.emptyStreak < 3)
      await this.proposals.supersedePauseSuggestions(item.projectId, item.goalId);
    // Upsert by runId: late verified artifacts amend the existing Done row.
    await this.deps.appendDone(goal, item.runId, result);
    await this.completions.change((state) => {
      const receipt = state.items.find(
        (entry) =>
          entry.projectId === item.projectId &&
          entry.goalId === item.goalId &&
          entry.runId === item.runId,
      )!;
      receipt.delivered = true;
      receipt.deliveredArtifacts = artifactIds;
    });
    return result;
  }
  private async markDelivered(goalId: string, event: GoalEvent): Promise<void> {
    await this.receipts.change((state) => {
      const receipt = state.events.find(
        (entry) =>
          entry.goalId === goalId &&
          entry.event.id === event.id &&
          entry.event.projectId === event.projectId,
      );
      if (receipt) receipt.delivered = true;
    });
  }
}
