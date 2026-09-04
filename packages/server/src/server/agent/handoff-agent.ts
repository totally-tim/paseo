import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { HANDOFF_FROM_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { buildHandoffContext } from "./handoff-context.js";
import { startCreatedAgentInitialPrompt } from "./agent-prompt.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentHandoffState } from "./handoff-state.js";

interface HandoffDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  logger: Logger;
  getWorkspace: (id: string) => Promise<{ cwd: string; archivedAt?: string | null } | null>;
}

export interface HandoffAgentInput {
  sourceAgentId: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  briefing?: string;
}

export function handoffAgent(
  deps: HandoffDependencies,
  {
    sourceAgentId,
    provider,
    model,
    modeId,
    thinkingOptionId,
    featureValues,
    briefing,
  }: HandoffAgentInput,
): Promise<StoredAgentRecord> {
  // Compare the selection, not transport fields such as an RPC request ID.
  const input = {
    sourceAgentId,
    provider,
    model,
    modeId,
    thinkingOptionId,
    featureValues,
    briefing,
  };
  return deps.agentStorage.runHandoff(input.sourceAgentId, input, () =>
    performHandoff(deps, input),
  );
}

async function prepareHandoff(
  deps: HandoffDependencies,
  input: HandoffAgentInput,
  source: StoredAgentRecord & { workspaceId: string },
): Promise<AgentHandoffState> {
  const { agentManager, agentStorage } = deps;
  let state = await agentStorage.getHandoff(source.id);
  const savedSuccessor = state ? await agentStorage.get(state.successorAgentId) : null;
  if (savedSuccessor && savedSuccessor.provider !== input.provider) {
    throw new Error(
      `This agent already has a continuation using ${savedSuccessor.provider}. Open ${savedSuccessor.id} to continue there.`,
    );
  }
  if (!state || (state.phase === "prepared" && !savedSuccessor)) {
    const resolved = await deps.providerSnapshotManager.resolveCreateConfig({
      cwd: source.cwd,
      provider: input.provider,
      requestedMode: input.modeId,
      featureValues: input.featureValues,
      parent: null,
      unattended: false,
    });
    const config: AgentSessionConfig = {
      provider: input.provider,
      cwd: source.cwd,
      model: input.model,
      modeId: resolved.modeId,
      thinkingOptionId: input.thinkingOptionId,
      featureValues: resolved.featureValues,
      systemPrompt: source.config?.systemPrompt ?? undefined,
      mcpServers: source.config?.mcpServers ?? undefined,
    };
    const rows = await agentManager.readHandoffTimeline(source.id);
    if (!rows.length && source.lastUserMessageAt) {
      throw new Error("Open the source conversation to load its saved history before continuing.");
    }
    const context = buildHandoffContext({
      source,
      rows,
      briefing: input.briefing,
      contextPath: agentStorage.getHandoffContextPath(source.id),
    });
    state = {
      sourceAgentId: source.id,
      successorAgentId: state?.successorAgentId ?? randomUUID(),
      workspaceId: source.workspaceId,
      config,
      title: source.title ?? "Continued work",
      ...context,
      briefing: input.briefing,
      phase: "prepared",
    };
    await agentStorage.saveHandoff(state);
  }
  return state;
}

async function performHandoff(
  deps: HandoffDependencies,
  input: HandoffAgentInput,
): Promise<StoredAgentRecord> {
  const { agentManager, agentStorage, logger } = deps;
  const source = await agentStorage.get(input.sourceAgentId);
  if (!source || source.internal) throw new Error("Source agent not found");
  if (source.archivedAt) throw new Error("Restore the source agent before continuing its work");
  if (!source.workspaceId) throw new Error("Source agent has no workspace");
  if (source.owner) throw new Error("This agent is managed by an execution service");
  await assertWorkspaceActive(deps, source.workspaceId);
  let state = await prepareHandoff(deps, input, { ...source, workspaceId: source.workspaceId });
  await agentManager.stopForHandoff(source.id, state.successorAgentId);
  let successor = await agentStorage.get(state.successorAgentId);
  if (!successor) {
    if (state.phase === "started" || state.phase === "dispatching") {
      throw new Error(
        `Continuation ${state.successorAgentId} is missing. Its work will not be started again automatically.`,
      );
    }
    // Capture the final drained stream, including tool outcomes during shutdown.
    const context = buildHandoffContext({
      source,
      rows: await agentManager.readHandoffTimeline(source.id),
      briefing: state.briefing,
      contextPath: agentStorage.getHandoffContextPath(source.id),
    });
    state = { ...state, ...context };
    await agentStorage.saveHandoff(state);
    await agentManager.createAgent(state.config, state.successorAgentId, {
      workspaceId: state.workspaceId,
      initialTitle: state.title,
      labels: { [HANDOFF_FROM_AGENT_ID_LABEL]: source.id },
    });
    state = { ...state, phase: "created" };
    await agentStorage.saveHandoff(state);
  }

  if (state.phase === "prepared" || state.phase === "created") {
    await assertWorkspaceActive(deps, state.workspaceId);
    const currentTarget = await agentStorage.get(state.successorAgentId);
    if (currentTarget?.archivedAt)
      throw new Error("The continuation was archived before it could start");
    // Persist before dispatch. An ambiguous crash never sends the task twice;
    // the existing successor stays available for the user to inspect and prompt.
    state = { ...state, phase: "dispatching" };
    await agentStorage.saveHandoff(state);
    await ensureAgentLoaded(state.successorAgentId, { agentManager, agentStorage, logger });
    await startCreatedAgentInitialPrompt({
      agentManager,
      agentId: state.successorAgentId,
      prompt: state.prompt,
      logger,
      runOptions: { clientMessageId: `handoff:${source.id}` },
    });
    state = { ...state, phase: "started" };
    await agentStorage.saveHandoff(state);
  }
  successor = await agentStorage.get(state.successorAgentId);
  if (!successor) throw new Error("Handoff successor was not persisted");
  if (state.phase === "dispatching") {
    throw new Error(
      `Continuation ${successor.id} already exists, but its prompt delivery is uncertain. Open it and check its history before sending more work.`,
    );
  }
  return successor;
}

async function assertWorkspaceActive(
  deps: HandoffDependencies,
  workspaceId: string,
): Promise<void> {
  const workspace = await deps.getWorkspace(workspaceId);
  if (!workspace || workspace.archivedAt)
    throw new Error("The source workspace is no longer active");
}
