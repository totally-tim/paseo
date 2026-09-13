import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import { validateScheduleCadence } from "../schedule/cron.js";
import { writeFileAtomic } from "../atomic-file.js";
import { AutomationStore } from "./automation-store.js";

export { CoordinatorGoalTriggerSchema as GoalTriggerSchema } from "@getpaseo/protocol/coordinator-goals";
import {
  CoordinatorGoalTriggerSchema,
  CoordinatorAutomationIdSchema as SafeId,
  CoordinatorGoalRuleSchema as RuleSchema,
  CoordinatorGoalSchema,
} from "@getpaseo/protocol/coordinator-goals";
export type GoalRule = z.infer<typeof RuleSchema>;
export function parseGoalRule(yaml: string): GoalRule {
  if (Buffer.byteLength(yaml, "utf8") > 32000) throw new Error("Goal rule exceeds 32 KB");
  const document = parseDocument(yaml, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length)
    throw new Error(
      [...document.errors, ...document.warnings].map((error) => error.message).join("; "),
    );
  const rule = RuleSchema.parse(document.toJS({ maxAliasCount: 0 }));
  if (rule.on === "cron") {
    if (!rule.cron) throw new Error("Cron goals require a cron expression");
    validateScheduleCadence({ type: "cron", expression: rule.cron, timezone: rule.timezone });
  } else if (rule.cron || rule.timezone)
    throw new Error("Only cron goals accept cron and timezone");
  if (rule.on === "pr.idle" && rule.filters?.days === undefined)
    throw new Error("Idle goals require filters.days");
  if (rule.on !== "pr.idle" && rule.filters?.days !== undefined)
    throw new Error("Only idle goals accept filters.days");
  if (rule.on === "heartbeat" && !rule.intervalMinutes)
    throw new Error("Heartbeat goals require intervalMinutes");
  if (rule.on !== "heartbeat" && rule.intervalMinutes !== undefined)
    throw new Error("Only heartbeat goals accept intervalMinutes");
  return rule;
}
export interface GoalEvent {
  id: string;
  projectId: string;
  trigger: z.infer<typeof CoordinatorGoalTriggerSchema>;
  occurredAt: string;
  author?: string;
  /** Latest of commits, comments, and reviews; omitted facts cannot satisfy an idle rule. */
  lastActivityAt?: string;
  context?: Record<string, unknown>;
}
export function matchesGoalEvent(rule: GoalRule, event: GoalEvent): boolean {
  if (rule.on !== event.trigger) return false;
  const authors = rule.filters?.authors;
  if (Array.isArray(authors) && (!event.author || !authors.includes(event.author))) return false;
  if (rule.on !== "pr.idle") return true;
  const latest = Date.parse(event.lastActivityAt ?? "");
  const now = Date.parse(event.occurredAt);
  return (
    Number.isFinite(latest) &&
    Number.isFinite(now) &&
    now - latest >= rule.filters!.days! * 86400000
  );
}
const GoalSchema = CoordinatorGoalSchema.extend({
  pauseProposalPending: z.boolean().optional(),
  runs: z.record(
    z.string(),
    z.object({
      status: z.enum(["running", "completed", "attention"]),
      startedAt: z.string(),
      completedOrder: z.number().int().nonnegative().optional(),
      eventId: z.string().optional(),
      summary: z.string().optional(),
      producedOutcome: z.boolean().nullable().optional(),
    }),
  ),
});
export type GoalRecord = z.infer<typeof GoalSchema>;
const StateSchema = z.object({ goals: z.array(GoalSchema) });
export interface CoordinatorGoalsDeps {
  paseoHome: string;
  now: () => number;
  /** Must idempotently find/create by projectId+goalId, including crash after schedule creation. */
  ensureSchedule: (goal: GoalRecord) => Promise<string>;
  setSchedulePaused: (scheduleId: string, paused: boolean) => Promise<void>;
  requestPauseProposal: (goal: GoalRecord) => Promise<void>;
}
export class CoordinatorGoals {
  private reconcileTail: Promise<unknown> = Promise.resolve();
  private readonly store: AutomationStore<z.infer<typeof StateSchema>>;
  constructor(private readonly deps: CoordinatorGoalsDeps) {
    this.store = new AutomationStore(
      path.join(deps.paseoHome, "coordinator", "goals.json"),
      StateSchema,
      () => ({ goals: [] }),
    );
  }
  async initialize(): Promise<void> {
    await this.store.change((state) => {
      for (const goal of state.goals)
        for (const run of Object.values(goal.runs))
          if (run.status === "running") {
            run.status = "attention";
            goal.paused = true;
            goal.lastError =
              "Goal execution was interrupted; review the previous run before resuming.";
          }
    });
  }
  async list(projectId?: string): Promise<GoalRecord[]> {
    return (await this.store.read()).goals.filter(
      (goal) => !projectId || goal.projectId === projectId,
    );
  }
  async get(projectId: string, goalId: string): Promise<GoalRecord | null> {
    return (await this.list(projectId)).find((goal) => goal.id === goalId) ?? null;
  }
  async installApproved(input: {
    proposalId: string;
    projectIds: string[];
    sentence: string;
    ruleYaml: string;
  }): Promise<GoalRecord[]> {
    const rule = parseGoalRule(input.ruleYaml);
    if (!input.projectIds.length) throw new Error("Choose at least one project");
    const ids = [...new Set(input.projectIds.map((id) => SafeId.parse(id)))];
    await this.store.change((state) => {
      for (const projectId of ids) {
        const id = createHash("sha256")
          .update(JSON.stringify([input.proposalId, projectId]))
          .digest("hex")
          .slice(0, 24);
        const existing = state.goals.find((goal) => goal.id === id);
        if (existing) {
          if (existing.ruleYaml !== input.ruleYaml || existing.sentence !== input.sentence)
            throw new Error("An approved goal cannot change without fresh approval");
          continue;
        }
        state.goals.push({
          id,
          projectId,
          proposalId: input.proposalId,
          sentence: input.sentence,
          ruleYaml: input.ruleYaml,
          kind: rule.on === "heartbeat" ? "judgment" : "deterministic",
          paused: false,
          createdAt: new Date(this.deps.now()).toISOString(),
          firedCount: 0,
          emptyStreak: 0,
          runs: {},
        });
      }
    });
    const installed = (await this.list()).filter((goal) => goal.proposalId === input.proposalId);
    await this.reconcile(installed.map((goal) => goal.id));
    return (await this.list()).filter((goal) => goal.proposalId === input.proposalId);
  }
  reconcile(goalIds?: string[]): Promise<void> {
    const job = this.reconcileTail.then(() => this.runReconcile(goalIds));
    this.reconcileTail = job.catch(() => undefined);
    return job;
  }
  private async runReconcile(goalIds?: string[]): Promise<void> {
    let firstError: unknown;
    for (const goal of await this.list()) {
      if (goalIds && !goalIds.includes(goal.id)) continue;
      try {
        parseGoalRule(goal.ruleYaml);
        const rulePath = path.join(
          this.deps.paseoHome,
          "coordinator",
          "goals",
          goal.projectId,
          `${goal.id}.yml`,
        );
        const savedRule = await readFile(rulePath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (savedRule !== goal.ruleYaml) await writeFileAtomic(rulePath, goal.ruleYaml);
        const scheduleId = await this.deps.ensureSchedule(goal);
        if (goal.scheduleId !== scheduleId)
          await this.store.change((state) => {
            state.goals.find((entry) => entry.id === goal.id)!.scheduleId = scheduleId;
          });
        const current = (await this.get(goal.projectId, goal.id))!;
        await this.deps.setSchedulePaused(
          scheduleId,
          current.paused || !["cron", "heartbeat"].includes(parseGoalRule(current.ruleYaml).on),
        );
        if (current.pauseProposalPending) {
          await this.deps.requestPauseProposal(current);
          await this.store.change((state) => {
            state.goals.find((entry) => entry.id === goal.id)!.pauseProposalPending = false;
          });
        }
      } catch (error) {
        if (!(await this.get(goal.projectId, goal.id))?.lastError)
          await this.store.change((state) => {
            const current = state.goals.find((entry) => entry.id === goal.id)!;
            current.lastError ??= error instanceof Error ? error.message : String(error);
          });
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }
  async setPaused(projectId: string, goalId: string, paused: boolean): Promise<void> {
    await this.store.change((state) => {
      const goal = state.goals.find(
        (entry) => entry.id === goalId && entry.projectId === projectId,
      );
      if (!goal) throw new Error("Goal not found");
      goal.paused = paused;
      if (!paused) {
        delete goal.lastError;
        for (const run of Object.values(goal.runs))
          if (run.status === "attention") run.status = "completed";
      }
    });
    await this.reconcile([goalId]);
  }
  async claimRun(
    projectId: string,
    goalId: string,
    runId: string,
    event?: GoalEvent,
  ): Promise<GoalRecord | null> {
    if (!runId) throw new Error("A stable run ID is required");
    return this.store.change((state) => {
      const goal = state.goals.find(
        (entry) => entry.id === goalId && entry.projectId === projectId,
      );
      if (!goal || goal.paused || Object.hasOwn(goal.runs, runId)) return null;
      if (event && Object.values(goal.runs).some((run) => run.eventId === event.id)) return null;
      const rule = parseGoalRule(goal.ruleYaml);
      if (event && (event.projectId !== projectId || !matchesGoalEvent(rule, event))) return null;
      if (!event && !["cron", "heartbeat"].includes(rule.on)) return null;
      if (
        Object.values(goal.runs).filter((run) => run.status !== "completed").length >=
        rule.guard.max_concurrent
      )
        return null;
      goal.lastRunAt = new Date(this.deps.now()).toISOString();
      goal.firedCount += 1;
      goal.runs = {
        ...goal.runs,
        [runId]: { status: "running", startedAt: goal.lastRunAt, eventId: event?.id },
      };
      return structuredClone(goal);
    });
  }
  /** No provider turn started, so this heartbeat did not fire. */
  async deferRun(projectId: string, goalId: string, runId: string): Promise<void> {
    await this.store.change((state) => {
      const goal = state.goals.find(
        (entry) => entry.id === goalId && entry.projectId === projectId,
      );
      const run = goal && Object.hasOwn(goal.runs, runId) ? goal.runs[runId] : undefined;
      if (!goal || !run || run.status !== "running") return;
      delete goal.runs[runId];
      goal.firedCount = Math.max(0, goal.firedCount - 1);
      goal.lastRunAt = Object.values(goal.runs)
        .map((entry) => entry.startedAt)
        .sort()
        .at(-1);
    });
  }
  async markRunAttention(
    projectId: string,
    goalId: string,
    runId: string,
    error: string,
  ): Promise<void> {
    await this.store.change((state) => {
      const goal = state.goals.find(
        (entry) => entry.id === goalId && entry.projectId === projectId,
      );
      const run = goal?.runs[runId];
      if (!goal || !run) throw new Error("Goal run not found");
      run.status = "attention";
      run.producedOutcome = null;
      run.completedOrder =
        Math.max(0, ...Object.values(goal.runs).map((entry) => entry.completedOrder ?? 0)) + 1;
      run.summary = error;
      goal.lastOutcome = "unknown";
      goal.emptyStreak = 0;
      goal.pauseProposalPending = false;
      goal.lastError = error;
      goal.paused = true;
    });
  }
  async completeRun(
    projectId: string,
    goalId: string,
    runId: string,
    outcome: { producedOutcome: boolean | null; summary: string },
  ): Promise<void> {
    await this.store.change((state) => {
      const goal = state.goals.find(
        (entry) => entry.id === goalId && entry.projectId === projectId,
      );
      const run = goal && Object.hasOwn(goal.runs, runId) ? goal.runs[runId] : undefined;
      if (!goal || !run) throw new Error("Goal run not found");
      if (run.status === "completed") {
        if (outcome.producedOutcome !== true) return;
        Object.assign(run, outcome);
        recomputeGoalOutcomes(goal);
        return;
      }
      run.completedOrder =
        Math.max(0, ...Object.values(goal.runs).map((entry) => entry.completedOrder ?? 0)) + 1;
      Object.assign(run, outcome, { status: "completed" });
      goal.lastOutcome = "unknown";
      if (outcome.producedOutcome === true) goal.lastOutcome = "produced";
      if (outcome.producedOutcome === false) goal.lastOutcome = "empty";
      // An unknown run breaks the evidence of consecutive empty runs.
      goal.emptyStreak = outcome.producedOutcome === false ? goal.emptyStreak + 1 : 0;
      if (goal.emptyStreak === 3) goal.pauseProposalPending = true;
    });
    await this.reconcile([goalId]);
  }
}

/** Recompute in completion order, so late evidence does not become the newest run. */
function recomputeGoalOutcomes(goal: GoalRecord): void {
  const completed = Object.values(goal.runs)
    .filter((run) => run.status !== "running" && run.producedOutcome !== undefined)
    .sort((a, b) => (a.completedOrder ?? 0) - (b.completedOrder ?? 0));
  goal.emptyStreak = 0;
  for (const run of completed) {
    goal.lastOutcome = "unknown";
    if (run.producedOutcome === true) goal.lastOutcome = "produced";
    if (run.producedOutcome === false) goal.lastOutcome = "empty";
    goal.emptyStreak = run.producedOutcome === false ? goal.emptyStreak + 1 : 0;
  }
  if (goal.emptyStreak < 3) goal.pauseProposalPending = false;
}
