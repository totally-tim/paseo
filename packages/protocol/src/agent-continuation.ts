import { z } from "zod";

/** Presence opts new agents in. The list is a snapshot, never a host-wide pool. */
export const AgentContinuationPolicySchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1).max(34),
});
export type AgentContinuationPolicy = z.infer<typeof AgentContinuationPolicySchema>;

export const AgentContinuationStatusSchema = z.object({
  rootAgentId: z.string(),
  agentId: z.string(),
  status: z.enum(["continuing", "waiting", "attention", "cancelled", "active"]),
  reason: z.string(),
  updatedAt: z.string(),
  nextCheckAt: z.string().optional(),
  resetsAt: z.string().optional(),
  transitionedAt: z.string().optional(),
  firstTransitionedAt: z.string().optional(),
  previousAgentId: z.string().optional(),
  previousAccountId: z.string().optional(),
  accountId: z.string().optional(),
});
export type AgentContinuationStatus = z.infer<typeof AgentContinuationStatusSchema>;
