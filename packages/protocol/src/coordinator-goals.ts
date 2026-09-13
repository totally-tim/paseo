import { z } from "zod";

export const CoordinatorGoalTriggerSchema = z.enum([
  "cron",
  "pr.opened",
  "pr.ci_failed",
  "pr.idle",
  "pr.merged",
  "agent.stalled",
  "heartbeat",
]);
export const CoordinatorAutomationIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
export const CoordinatorGoalRuleSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    on: CoordinatorGoalTriggerSchema,
    cron: z.string().optional(),
    timezone: z.string().optional(),
    intervalMinutes: z.number().int().min(1).max(10080).optional(),
    filters: z
      .object({
        days: z.number().positive().max(365).optional(),
        authors: z.union([z.literal("any"), z.array(z.string().min(1)).min(1)]).optional(),
      })
      .strict()
      .optional(),
    step: z
      .object({ profile: z.string().min(1).max(120), prompt: z.string().min(1).max(16000) })
      .strict(),
    guard: z.object({ max_concurrent: z.number().int().min(1).max(100) }).strict(),
  })
  .strict();
export type CoordinatorGoalRule = z.infer<typeof CoordinatorGoalRuleSchema>;
export const CoordinatorGoalSchema = z.object({
  id: CoordinatorAutomationIdSchema,
  projectId: CoordinatorAutomationIdSchema,
  proposalId: z.string(),
  sentence: z.string(),
  ruleYaml: z.string(),
  kind: z.enum(["deterministic", "judgment"]),
  paused: z.boolean(),
  scheduleId: z.string().optional(),
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  lastError: z.string().optional(),
  firedCount: z.number().int().nonnegative(),
  lastOutcome: z.enum(["produced", "empty", "unknown"]).optional(),
  emptyStreak: z.number().int().nonnegative(),
});
export type CoordinatorGoal = z.infer<typeof CoordinatorGoalSchema>;
export const CoordinatorProposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal"), ruleYaml: z.string().min(1).max(32000) }).strict(),
  z.object({ kind: z.literal("pause_goal"), goalId: CoordinatorAutomationIdSchema }).strict(),
  z
    .object({
      kind: z.literal("policy"),
      pattern: z.string().min(1).max(32000),
      scope: z.enum(["daemon", "projects"]),
    })
    .strict(),
]);
export const CoordinatorProposalSchema = z.object({
  id: z.string(),
  projectIds: z.array(CoordinatorAutomationIdSchema),
  sourceAgentId: z.string(),
  sentence: z.string().min(1).max(4000),
  evidence: z.array(z.object({ title: z.string(), url: z.string().optional() })).max(50),
  payload: CoordinatorProposalPayloadSchema,
  status: z.enum(["pending", "approved", "ignored", "superseded"]),
  createdAt: z.string(),
  approvedAt: z.string().optional(),
  appliedAt: z.string().optional(),
  ignoredUntil: z.string().optional(),
  error: z.string().optional(),
});
export type CoordinatorProposal = z.infer<typeof CoordinatorProposalSchema>;
export type CoordinatorProposalPayload = z.infer<typeof CoordinatorProposalPayloadSchema>;
export const CoordinatorPolicyRuleSchema = z.object({
  id: z.string(),
  pattern: z.string().min(1).max(32000),
  scope: CoordinatorAutomationIdSchema,
  enabled: z.boolean(),
  firedCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type CoordinatorPolicyRule = z.infer<typeof CoordinatorPolicyRuleSchema>;
