import type { AgentContinuationPolicy } from "@getpaseo/protocol/agent-continuation";
import type { AccountSelection } from "@getpaseo/protocol/provider-accounts";
import { isDeepStrictEqual } from "node:util";
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

export interface HandoffDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  logger: Logger;
  getWorkspace: (id: string) => Promise<{ cwd: string; archivedAt?: string | null } | null>;
}

export interface HandoffExecution {
  operationId?: string;
  unattended?: boolean;
  preserveConfiguration?: boolean;
  assertCurrent?: () => Promise<void>;
  onCreated?: (successor: StoredAgentRecord) => Promise<void>;
}

export interface HandoffAgentInput {
  continuationPolicy?: AgentContinuationPolicy;
  accountSelection?: AccountSelection;
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
    continuationPolicy,
    accountSelection,
    provider,
    model,
    modeId,
    thinkingOptionId,
    featureValues,
    briefing,
  }: HandoffAgentInput,
  execution?: HandoffExecution,
): Promise<StoredAgentRecord> {
  // Compare the selection, not transport fields such as an RPC request ID.
  const input = {
    sourceAgentId,
    continuationPolicy,
    accountSelection,
    provider,
    model,
    modeId,
    thinkingOptionId,
    featureValues,
    briefing,
  };
  // Acquire task ownership before the handoff lock in both manual and automatic paths.
  const run = (context?: HandoffExecution) =>
    deps.agentStorage.runHandoff(sourceAgentId, input, () => performHandoff(deps, input, context));
  return !execution && deps.agentManager.continuations
    ? deps.agentManager.continuations.manualHandoff(sourceAgentId, run)
    : run(execution);
}

function assertHandoffSelection(
  successor: StoredAgentRecord,
  state: AgentHandoffState | null,
  input: HandoffAgentInput,
): void {
  const requested = input.accountSelection;
  const matchesAccount =
    requested === undefined ||
    isDeepStrictEqual(state?.config.accountSelection, requested) ||
    (requested.kind === "fixed" && requested.accountId === successor.config?.accountId);
  if (successor.provider !== input.provider || !matchesAccount) {
    throw new Error(
      `This agent already has a continuation (${successor.id}). Open it to continue with its pinned account.`,
    );
  }
}

async function resolveHandoffConfig(
  deps: HandoffDependencies,
  input: HandoffAgentInput,
  source: StoredAgentRecord,
  execution?: HandoffExecution,
): Promise<AgentSessionConfig> {
  const selected = execution?.preserveConfiguration ? effectiveHandoffInput(source, input) : input;
  const resolved = await deps.providerSnapshotManager.resolveCreateConfig({
    cwd: source.cwd,
    provider: selected.provider,
    accountSelection: selected.accountSelection,
    model: selected.model,
    requestedMode: selected.modeId,
    featureValues: selected.featureValues,
    parent: null,
    // Automatic account admission does not grant a broader provider permission mode.
    unattended: false,
  });
  return {
    provider: selected.provider,
    accountSelection: selected.accountSelection,
    continuationPolicy: selected.continuationPolicy,
    cwd: source.cwd,
    model: selected.model,
    modeId: resolved.modeId,
    thinkingOptionId: selected.thinkingOptionId,
    featureValues: resolved.featureValues,
    ...(execution?.preserveConfiguration ? preservedOptions(source) : {}),
    systemPrompt: source.config?.systemPrompt ?? undefined,
    mcpServers: source.config?.mcpServers ?? undefined,
  };
}

function preservedOptions(
  source: StoredAgentRecord,
): Pick<AgentSessionConfig, "toolPolicy" | "providerOptions"> {
  return {
    toolPolicy: source.config?.toolPolicy ?? undefined,
    providerOptions: source.config?.providerOptions ?? undefined,
  };
}

function effectiveHandoffInput(
  source: StoredAgentRecord,
  input: HandoffAgentInput,
): HandoffAgentInput {
  return {
    ...input,
    model: source.runtimeInfo?.model ?? source.config?.model ?? input.model,
    modeId: source.lastModeId ?? source.config?.modeId ?? input.modeId,
    thinkingOptionId:
      source.runtimeInfo?.thinkingOptionId ??
      source.config?.thinkingOptionId ??
      input.thinkingOptionId,
    featureValues: source.config?.featureValues ?? input.featureValues,
  };
}

async function prepareHandoff(
  deps: HandoffDependencies,
  input: HandoffAgentInput,
  source: StoredAgentRecord & { workspaceId: string },
  execution?: HandoffExecution,
): Promise<AgentHandoffState> {
  const { agentManager, agentStorage } = deps;
  let state = await agentStorage.getHandoff(source.id);
  const savedSuccessor = state ? await agentStorage.get(state.successorAgentId) : null;
  if (savedSuccessor) assertHandoffSelection(savedSuccessor, state, input);
  if (!state || (state.phase === "prepared" && !savedSuccessor)) {
    const config = await resolveHandoffConfig(deps, input, source, execution);
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
  execution: HandoffExecution = {},
): Promise<StoredAgentRecord> {
  const { agentManager, agentStorage, logger } = deps;
  const assertCurrent = execution.assertCurrent ?? (() => Promise.resolve());
  const source = await agentStorage.get(input.sourceAgentId);
  if (!source || source.internal) throw new Error("Source agent not found");
  await assertSourceRestored(source, execution, agentStorage);
  if (!source.workspaceId) throw new Error("Source agent has no workspace");
  if (source.owner) throw new Error("This agent is managed by an execution service");
  await assertCurrent();
  await assertWorkspaceActive(deps, source.workspaceId);
  let state = await prepareHandoff(
    deps,
    input,
    { ...source, workspaceId: source.workspaceId },
    execution,
  );
  await assertCurrent();
  await stopHandoffSource(deps, source, state.successorAgentId);
  await assertCurrent();
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
    await assertCurrent();
    const created = await agentManager.createAgent(state.config, state.successorAgentId, {
      workspaceId: state.workspaceId,
      unattended: execution.unattended,
      initialTitle: state.title,
      labels: { [HANDOFF_FROM_AGENT_ID_LABEL]: source.id },
    });
    state = {
      ...state,
      config: { ...state.config, accountId: created.config.accountId },
      phase: "created",
    };
    await agentStorage.saveHandoff(state);
  }

  const linked = await agentStorage.get(state.successorAgentId);
  if (linked) await execution.onCreated?.(linked);
  await assertCurrent();

  if (state.phase === "prepared" || state.phase === "created") {
    await assertWorkspaceActive(deps, state.workspaceId);
    const currentTarget = await agentStorage.get(state.successorAgentId);
    if (currentTarget?.archivedAt)
      throw new Error("The continuation was archived before it could start");
    await ensureAgentLoaded(state.successorAgentId, { agentManager, agentStorage, logger });
    // Check ownership before claiming delivery. A cancel that lands here would otherwise
    // leave a durable "dispatching" state for a prompt that was never sent, and every later
    // path would tell the user to inspect an empty conversation.
    await assertCurrent();
    // Persist before dispatch. An ambiguous crash never sends the task twice;
    // the existing successor stays available for the user to inspect and prompt.
    const created = state;
    state = { ...state, phase: "dispatching" };
    await agentStorage.saveHandoff(state);
    // Cancellation can also land while that write is in flight. A confirmed loss of ownership
    // here means nothing was sent, so the journal goes back rather than claiming uncertainty.
    try {
      await assertCurrent();
    } catch (error) {
      await agentStorage.saveHandoff(created);
      throw error;
    }
    await startCreatedAgentInitialPrompt({
      agentManager,
      agentId: state.successorAgentId,
      prompt: state.prompt,
      logger,
      runOptions: {
        clientMessageId: `handoff:${source.id}`,
        continuationOperationId: execution.operationId,
      },
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

async function assertSourceRestored(
  source: StoredAgentRecord,
  execution: HandoffExecution,
  storage: AgentStorage,
): Promise<void> {
  if (source.archivedAt && !(execution.operationId && (await storage.getHandoff(source.id))))
    throw new Error("Restore the source agent before continuing its work");
}

async function stopHandoffSource(
  deps: HandoffDependencies,
  source: StoredAgentRecord,
  successorId: string,
): Promise<void> {
  if (!source.archivedAt) await deps.agentManager.stopForHandoff(source.id, successorId);
  else if (!(await deps.agentStorage.get(successorId)))
    throw new Error("The archived source has no continuation to resume");
}

async function assertWorkspaceActive(
  deps: HandoffDependencies,
  workspaceId: string,
): Promise<void> {
  const workspace = await deps.getWorkspace(workspaceId);
  if (!workspace || workspace.archivedAt)
    throw new Error("The source workspace is no longer active");
}
