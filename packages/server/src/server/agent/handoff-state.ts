import { z } from "zod";
import { AgentTimelineItemPayloadSchema, CreateAgentRequestMessageSchema } from "../messages.js";

export const AgentHandoffStateSchema = z.object({
  sourceAgentId: z.string(),
  successorAgentId: z.string(),
  workspaceId: z.string(),
  config: CreateAgentRequestMessageSchema.shape.config.extend({
    accountId: z.string().optional(),
    accountSelectionReason: z.string().optional(),
  }),
  briefing: z.string().optional(),
  title: z.string(),
  prompt: z.string(),
  rows: z.array(
    z.object({
      seq: z.number().int().positive(),
      timestamp: z.string(),
      item: AgentTimelineItemPayloadSchema,
      turnId: z.string().optional(),
      providerMessageId: z.string().optional(),
    }),
  ),
  phase: z.enum(["prepared", "created", "dispatching", "started"]),
});

export type AgentHandoffState = z.infer<typeof AgentHandoffStateSchema>;
