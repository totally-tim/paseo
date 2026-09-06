import type { AgentContinuationPolicy } from "@getpaseo/protocol/agent-continuation";
import type { AccountSelection } from "@getpaseo/protocol/provider-accounts";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

export function buildWorkspaceDraftAgentConfig(input: {
  accountSelection?: AccountSelection;
  continuationPolicy?: AgentContinuationPolicy;
  provider: AgentSessionConfig["provider"];
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}): AgentSessionConfig {
  return {
    provider: input.provider,
    ...(input.accountSelection ? { accountSelection: input.accountSelection } : {}),
    ...(input.continuationPolicy ? { continuationPolicy: input.continuationPolicy } : {}),
    cwd: input.cwd,
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}
