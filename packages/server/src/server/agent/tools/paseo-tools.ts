import {
  AccountSelectionSchema,
  ProviderAccountSchema,
  type AccountSelection,
} from "@getpaseo/protocol/provider-accounts";
import { z } from "zod";
import { ensureValidJson } from "../../json-utils.js";
import type { Logger } from "pino";

import type { AgentMode, AgentProvider, AgentSessionConfig } from "../agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import { AgentProfileSchema } from "@getpaseo/protocol/messages";
import type { DaemonConfigStore } from "../../daemon-config-store.js";
import {
  AgentFeatureSchema,
  AgentPermissionRequestPayloadSchema,
  AgentListItemPayloadSchema,
  AgentPermissionResponseSchema,
  AgentSnapshotPayloadSchema,
  WorkspaceScriptPayloadSchema,
} from "../../messages.js";
import type { AgentListItemPayload } from "../../messages.js";
import {
  buildStoredAgentPayload,
  toAgentListItemPayload,
  toAgentPayload,
} from "../agent-projections.js";
import { curateAgentActivity } from "../activity-curator.js";
import { selectItemsByProjectedLimit } from "../timeline-projection.js";
import type { AgentStorage } from "../agent-storage.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { isStoredAgentProviderAvailable } from "../../persistence-hooks.js";
import {
  archiveByScope,
  killTerminalsForWorkspace,
  requireActiveWorkspaceForArchive,
  type ArchiveDependencies,
} from "../../workspace-archive-service.js";
import { createAgentCommand, type CreateAgentFromMcpInput } from "../create-agent/create.js";
import { handoffAgent } from "../handoff-agent.js";
import { handoffHistory, readHandoffPage } from "../handoff-context.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { FirstAgentContext } from "../../messages.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";
import { expandUserPath, isSameOrDescendantPath, resolvePathFromBase } from "../../path-utils.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeWorkflowFn } from "../../worktree-session.js";
import type { ScheduleService } from "../../schedule/service.js";
import {
  ScheduleRunSchema,
  ScheduleSummarySchema,
  StoredScheduleSchema,
  type ScheduleCadence,
  type UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import {
  AgentModelSchema,
  AgentProviderEnum,
  AgentStatusEnum,
  ProviderModeSchema,
  ProviderSummarySchema,
  parseDurationString,
  resolveRequiredProviderModel,
  sanitizePermissionRequest,
  serializeSnapshotWithMetadata,
  toScheduleSummary,
  waitForAgentWithTimeout,
} from "../mcp-shared.js";
import { sendPromptToAgent, setupFinishNotification } from "../agent-prompt.js";
import { respondToAgentPermission } from "../permission-response.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "../lifecycle-command.js";
import type { ForgeService } from "../../../services/forge-service.js";
import {
  getCoordinatorSubagentKind,
  getParentAgentIdFromLabels,
  isCoordinatorAgent,
} from "@getpaseo/protocol/agent-labels";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type {
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../../workspace-registry.js";
import { resolveWorktreeSourceCwd } from "../../workspace-source.js";
import type { WorkspaceScriptsService } from "../../session/workspace-scripts/workspace-scripts-service.js";
import {
  type ArchiveCommandDependencies,
  type CreatePaseoWorktreeCommandInput,
  createPaseoWorktreeCommand,
} from "../../worktree/commands.js";
import { registerBrowserTools } from "../../browser-tools/tools.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import type {
  PaseoToolCatalog,
  PaseoToolConfig,
  PaseoToolDefinition,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "./types.js";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import { isPaseoToolEnabled } from "../paseo-tool-policy.js";
import { assertCoordinatorToolAllowed } from "../../coordinator/tool-policy.js";
import type {
  CoordinatorRememberInput,
  CoordinatorRememberResult,
  CoordinatorSpawnDecision,
  CoordinatorSpawnGateInput,
} from "../../coordinator/coordinator-service.js";
import type { CoordinatorProfileSelection } from "@getpaseo/protocol/messages";
import {
  COORDINATOR_SUBAGENT_KINDS,
  type CoordinatorSubagentKind,
} from "@getpaseo/protocol/agent-labels";
import { stripAgentToolLabels } from "../daemon-managed-labels.js";

export interface PaseoToolHostDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager?: TerminalManager | null;
  getDaemonTcpPort?: () => number | null;
  scheduleService?: ScheduleService | null;
  providerSnapshotManager: ProviderSnapshotManager;
  daemonConfigStore?: Pick<DaemonConfigStore, "get">;
  github?: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot" | "resolveForge" | "resolveDefaultBranch"
  >;
  findWorkspaceIdForCwd?: ArchiveDependencies["findWorkspaceIdForCwd"];
  listActiveWorkspaces?: ArchiveDependencies["listActiveWorkspaces"];
  archiveWorkspaceRecord?: ArchiveDependencies["archiveWorkspaceRecord"];
  emitWorkspaceUpdatesForWorkspaceIds?: ArchiveDependencies["emitWorkspaceUpdatesForWorkspaceIds"];
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list" | "upsert">;
  projectRegistry?: Pick<ProjectRegistry, "get" | "list">;
  createDirectoryWorkspace?: (
    cwd: string,
    title?: string | null,
    projectId?: string,
  ) => Promise<PersistedWorkspaceRecord>;
  workspaceScripts?: Pick<WorkspaceScriptsService, "list" | "launch" | "stop">;
  markWorkspaceArchiving?: ArchiveDependencies["markWorkspaceArchiving"];
  clearWorkspaceArchiving?: ArchiveDependencies["clearWorkspaceArchiving"];
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<string>;
  browserToolsEnabled?: boolean;
  browserToolsBroker?: BrowserToolsBroker | null;
  paseoToolPolicy?: ProviderPaseoToolsPolicy;
  paseoHome?: string;
  worktreesRoot?: string;
  /**
   * Coordinator service bridge: `remember` plus the spawn gate, role-profile
   * resolution, the change-request reviewer gate, and the ownership checks for
   * agent/workspace-targeting tools. Absent in tests that exercise the catalog
   * without the coordinator slice.
   */
  coordinator?: {
    remember(input: CoordinatorRememberInput): Promise<CoordinatorRememberResult>;
    /**
     * Change-request writes stay with the coordinator: delegated subagents in
     * its tree are denied (they report upward; the coordinator posts under its
     * trust level and reviewer gate). No-op for ungoverned callers.
     */
    assertForgeWriteAllowed(callerAgentId: string): Promise<void>;
    /**
     * Reviewer gate for coordinator-opened change requests. The service
     * resolves the reviewer through live agents and stored records, verifies
     * it is a reviewer-kind subagent of the caller that finished a turn, and
     * throws an actionable error when the review requirement is unmet.
     */
    assertReviewerGate(callerAgentId: string, reviewerAgentId: string): Promise<void>;
    /** Read-only spawn precheck; run before any workspace or worktree is minted. */
    assertSpawnAllowed(input: CoordinatorSpawnGateInput): Promise<CoordinatorSpawnDecision | null>;
    /** Serialized check + create per coordinator; the decision merges into create options. */
    runCoordinatorSpawn<T>(
      input: CoordinatorSpawnGateInput,
      create: (decision: CoordinatorSpawnDecision | null) => Promise<T>,
    ): Promise<T>;
    /** Resolves a subagent kind to the coordinator's configured launch bundle. */
    resolveSubagentProfile(input: {
      callerAgentId: string;
      kind: CoordinatorSubagentKind;
    }): Promise<CoordinatorProfileSelection>;
    /**
     * Fails when a coordinator-tree caller targets an agent outside its
     * boundary. `action: "mutate"` additionally bars delegated callers from
     * touching their own ancestors.
     */
    assertAgentTargetAllowed(
      callerAgentId: string,
      targetAgentId: string,
      options?: { action?: "steer" | "mutate" },
    ): Promise<void>;
    /**
     * Fails when a governed caller would escalate itself — rewriting its own
     * runtime settings or answering its own permission requests.
     */
    assertSelfActionAllowed(callerAgentId: string, action: string): Promise<void>;
    /** Fails when a coordinator-tree caller mutates a workspace outside its boundary. */
    assertWorkspaceTargetAllowed(callerAgentId: string, workspaceId: string): Promise<void>;
    /** Fails when a governed caller binds a resource to a cwd outside its own checkout. */
    assertScopedCwdAllowed(callerAgentId: string, cwd: string): Promise<void>;
    /** Fails when a read-only delegated kind tries to provision a workspace. */
    assertWorkspaceCreateAllowed(callerAgentId: string): Promise<void>;
    /** Fails when a read-only governed caller reaches for a terminal. */
    assertTerminalAccessAllowed(callerAgentId: string): Promise<void>;
    /** Fails when a governed caller creates or mutates daemon schedules. */
    assertScheduleAccessAllowed(callerAgentId: string): Promise<void>;
    /** Fails when a governed caller attaches a workspace to a foreign project. */
    assertProjectScopeAllowed(callerAgentId: string, projectId: string): Promise<void>;
  };
  /**
   * ID of the agent that is using this tool catalog.
   * Used for cwd/mode inheritance when agents spawn child agents.
   */
  callerAgentId?: string;
  /**
   * Optional resolver for session-bound speak handlers.
   * Used by hidden voice agents to narrate through daemon-managed TTS.
   */
  resolveSpeakHandler?: (callerAgentId: string) => VoiceSpeakHandler | null;
  resolveCallerContext?: (callerAgentId: string) => VoiceCallerContext | null;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
  logger: Logger;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveAgentListActivityTime(agent: AgentListItemPayload): number {
  return Math.max(
    parseTimestamp(agent.updatedAt),
    parseTimestamp(agent.lastUserMessageAt),
    parseTimestamp(agent.attentionTimestamp),
    parseTimestamp(agent.archivedAt),
    parseTimestamp(agent.createdAt),
  );
}

interface ProviderSummary {
  id: AgentProvider;
  label: string;
  description: string;
  enabled: boolean;
  modes: AgentMode[];
  status: string;
  error?: string;
}

const WorkspaceAutomationSummarySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  isolation: z.enum(["local", "worktree"]),
  kind: z.enum(["directory", "local_checkout", "worktree"]),
  title: z.string().nullable(),
});

function toWorkspaceAutomationSummary(workspace: PersistedWorkspaceRecord) {
  return {
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    isolation: workspace.kind === "worktree" ? ("worktree" as const) : ("local" as const),
    kind: workspace.kind,
    title: workspace.title,
  };
}

type WorkspaceWorktreeMode = "branch-off" | "checkout-branch" | "checkout-pr";

interface WorkspaceWorktreeOptions {
  mode?: WorkspaceWorktreeMode;
  worktreeSlug?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  prNumber?: number;
  forge?: string;
}

type WorkspaceWorktreeTarget = Pick<
  CreatePaseoWorktreeCommandInput,
  "action" | "branchName" | "refName" | "checkoutSource"
>;

function assertOptionsAbsent(
  options: Array<[name: string, value: unknown]>,
  message: string,
): void {
  if (options.some(([, value]) => value !== undefined)) {
    throw new Error(message);
  }
}

function resolveWorkspaceWorktreeTarget(input: WorkspaceWorktreeOptions): WorkspaceWorktreeTarget {
  switch (input.mode ?? "branch-off") {
    case "branch-off":
      assertOptionsAbsent(
        [
          ["branch", input.branch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branch, prNumber, and forge require a checkout mode",
      );
      return {
        action: "branch-off",
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.baseBranch ? { refName: input.baseBranch } : {}),
      };
    case "checkout-branch":
      if (!input.branch) {
        throw new Error("branch is required for checkout-branch mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["prNumber", input.prNumber],
          ["forge", input.forge],
        ],
        "branchName, baseBranch, prNumber, and forge are not valid for checkout-branch mode",
      );
      return { action: "checkout", refName: input.branch };
    case "checkout-pr":
      if (input.prNumber === undefined) {
        throw new Error("prNumber is required for checkout-pr mode");
      }
      assertOptionsAbsent(
        [
          ["branchName", input.branchName],
          ["baseBranch", input.baseBranch],
          ["branch", input.branch],
        ],
        "branchName, baseBranch, and branch are not valid for checkout-pr mode",
      );
      return {
        action: "checkout",
        checkoutSource: {
          kind: "change_request",
          ...(input.forge ? { forge: input.forge } : {}),
          number: input.prNumber,
        },
      };
  }
}

function toProviderSummary(entry: {
  provider: AgentProvider;
  label?: string;
  description?: string;
  enabled: boolean;
  modes?: AgentMode[];
  status: string;
  error?: string;
}): ProviderSummary {
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    enabled: entry.enabled,
    modes: entry.modes ?? [],
    status: entry.status === "ready" ? "available" : entry.status,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function compareAgentListItems(a: AgentListItemPayload, b: AgentListItemPayload): number {
  const attentionDelta =
    Number(b.requiresAttention ?? false) - Number(a.requiresAttention ?? false);
  if (attentionDelta !== 0) {
    return attentionDelta;
  }

  const statusOrder = {
    running: 0,
    initializing: 1,
    idle: 2,
    error: 3,
    closed: 4,
  } as Record<string, number>;
  const statusDelta = (statusOrder[a.status] ?? 999) - (statusOrder[b.status] ?? 999);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  return resolveAgentListActivityTime(b) - resolveAgentListActivityTime(a);
}

function resolveScheduleProviderAndModel(params: {
  provider?: string;
  defaultProvider: AgentProvider;
}): { provider: AgentProvider; model?: string } {
  const providerInput = params.provider?.trim() || params.defaultProvider;
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return { provider: providerInput };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }

  return {
    provider: provider,
    model,
  };
}

function resolveScheduleUpdateProviderAndModel(params: {
  provider?: string;
  model?: string | null;
}): { provider?: string; model?: string | null } {
  const providerInput = params.provider?.trim();
  const modelInput = typeof params.model === "string" ? params.model.trim() : params.model;

  if (params.model !== undefined && modelInput === "") {
    throw new Error("model cannot be empty");
  }

  if (!providerInput) {
    return params.model !== undefined ? { model: modelInput } : {};
  }

  const slashIndex = providerInput.indexOf("/");
  if (slashIndex === -1) {
    return {
      provider: providerInput,
      ...(params.model !== undefined ? { model: modelInput } : {}),
    };
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const modelFromProvider = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !modelFromProvider) {
    throw new Error("provider must be <provider> or <provider>/<model>");
  }
  if (params.model === null) {
    throw new Error("provider specifies a model but model is null");
  }
  if (typeof modelInput === "string" && modelInput !== modelFromProvider) {
    throw new Error("Conflicting model values provided");
  }

  return {
    provider,
    model: modelInput ?? modelFromProvider,
  };
}

interface ScheduleUpdateToolInput {
  id: string;
  accountSelection?: AccountSelection | null;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string | null;
  prompt?: string;
  maxRuns?: number | null;
  provider?: string;
  model?: string | null;
  mode?: string | null;
  cwd?: string;
  expiresIn?: string;
  clearExpires?: boolean;
}

function normalizeScheduleCadenceArg(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function normalizeScheduleTimeZoneArg(value: string | undefined): string | undefined {
  return normalizeScheduleCadenceArg(value);
}

function resolveScheduleUpdateCadence(input: ScheduleUpdateToolInput): ScheduleCadence | undefined {
  const every = normalizeScheduleCadenceArg(input.every);
  const cron = normalizeScheduleCadenceArg(input.cron);
  const timeZone = normalizeScheduleTimeZoneArg(input.timezone);

  if (every !== undefined && cron !== undefined) {
    throw new Error("Specify at most one of every or cron");
  }
  if (timeZone !== undefined && cron === undefined) {
    throw new Error("timezone can only be used with cron");
  }
  if (every !== undefined) {
    // COMPAT(scheduleEveryInput): accept the old hidden field and canonicalize it before write.
    // Added in v0.2.0; remove after 2027-01-17.
    const everyMs = parseDurationString(every);
    const expression = everyMsToFiveFieldCron(everyMs);
    if (expression) {
      return { type: "cron", expression };
    }
    throw new Error(`${every} cannot be represented faithfully by five-field cron`);
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron,
      ...(timeZone !== undefined ? { timezone: timeZone } : {}),
    };
  }
  return undefined;
}

function resolveScheduleUpdateExpiresAt(input: ScheduleUpdateToolInput): string | null | undefined {
  if (input.expiresIn !== undefined && input.clearExpires) {
    throw new Error("Specify at most one of expiresIn or clearExpires");
  }
  if (input.expiresIn !== undefined) {
    return new Date(Date.now() + parseDurationString(input.expiresIn)).toISOString();
  }
  if (input.clearExpires) {
    return null;
  }
  return undefined;
}

function buildScheduleUpdateInput(input: ScheduleUpdateToolInput): UpdateScheduleInput {
  const cadence = resolveScheduleUpdateCadence(input);
  const expiresAt = resolveScheduleUpdateExpiresAt(input);
  const providerModelPatch = resolveScheduleUpdateProviderAndModel({
    provider: input.provider,
    model: input.model,
  });
  const newAgentConfig = {
    ...(input.accountSelection !== undefined ? { accountSelection: input.accountSelection } : {}),
    ...(providerModelPatch.provider !== undefined ? { provider: providerModelPatch.provider } : {}),
    ...(providerModelPatch.model !== undefined ? { model: providerModelPatch.model } : {}),
    ...(input.mode !== undefined ? { modeId: input.mode } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };

  return {
    id: input.id,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(Object.keys(newAgentConfig).length > 0 ? { newAgentConfig } : {}),
  };
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

/**
 * Local reviewer-gate enforcement for `create_change_request`. Every
 * coordinator-opened change request names a reviewer subagent that is a child
 * of the calling coordinator, is labeled with the reviewer kind, and already
 * finished one turn — `idle` after a submitted prompt, so "created but never
 * prompted" and mid-review agents both fail. Runs before any forge call so a
 * denied request never creates a pull request.
 */
function requireChangeRequestReviewerId(reviewerAgentId: string | undefined): string {
  const trimmed = reviewerAgentId?.trim();
  if (!trimmed) {
    throw new Error(
      "create_change_request requires reviewerAgentId for coordinator callers — " +
        "spawn a reviewer subagent, let it finish its review turn, then pass its agent id",
    );
  }
  return trimmed;
}

function assertChangeRequestReviewer(params: {
  callerAgentId: string;
  reviewerAgentId: string;
  agentManager: AgentManager;
}): string {
  const reviewerAgentId = params.reviewerAgentId;
  const reviewer = params.agentManager.getAgent(reviewerAgentId);
  if (!reviewer) {
    throw new Error(`Reviewer agent ${reviewerAgentId} not found`);
  }
  if (getParentAgentIdFromLabels(reviewer.labels) !== params.callerAgentId) {
    throw new Error(
      `Reviewer agent ${reviewerAgentId} is not a subagent of this coordinator — ` +
        "spawn the reviewer yourself with create_agent",
    );
  }
  if (getCoordinatorSubagentKind(reviewer.labels) !== "reviewer") {
    throw new Error(
      `Agent ${reviewerAgentId} is not a reviewer-kind subagent — ` +
        "spawn it with the reviewer kind so its review counts for this change request",
    );
  }
  if (reviewer.lifecycle === "closed") {
    throw new Error(
      `Reviewer agent ${reviewerAgentId} is closed — spawn a fresh reviewer for this change`,
    );
  }
  if (reviewer.lifecycle === "error") {
    throw new Error(
      `Reviewer agent ${reviewerAgentId} finished with an error — ` +
        "rerun the review before opening the change request",
    );
  }
  if (reviewer.lifecycle !== "idle" || reviewer.lastUserMessageAt === null) {
    throw new Error(
      `Reviewer agent ${reviewerAgentId} has not finished a review turn — ` +
        "wait for its review to complete before opening the change request",
    );
  }
  return reviewerAgentId;
}

const TerminalSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});

function resolveTerminalKeyToken(key: string, literal: boolean): string {
  if (literal) {
    return key;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}

export function createPaseoToolCatalog(options: PaseoToolHostDependencies): PaseoToolCatalog {
  const {
    agentManager,
    agentStorage,
    terminalManager,
    workspaceScripts,
    scheduleService,
    providerSnapshotManager,
    daemonConfigStore,
    callerAgentId,
    resolveSpeakHandler,
    resolveCallerContext,
    logger,
  } = options;
  const childLogger = logger.child({ module: "agent", component: "paseo-tool-catalog" });
  const callerContext = callerAgentId ? (resolveCallerContext?.(callerAgentId) ?? null) : null;

  const parseToolInput = async (tool: PaseoToolDefinition, input: unknown): Promise<unknown> => {
    const inputSchema = tool.inputSchema;
    if (!inputSchema) {
      return input;
    }
    const schema =
      typeof inputSchema === "object" &&
      inputSchema !== null &&
      typeof (inputSchema as { safeParseAsync?: unknown }).safeParseAsync === "function"
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape).passthrough();
    return schema.parseAsync(input);
  };

  const tools = new Map<string, PaseoToolDefinition>();
  const registerTool = (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool handlers are schema-validated at registration boundaries.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => {
    if (!isPaseoToolEnabled(options.paseoToolPolicy, name)) {
      return;
    }
    tools.set(name, {
      name,
      title: config.title,
      description: config.description ?? name,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      handler: handler as PaseoToolDefinition["handler"],
    });
  };
  const toCatalog = (): PaseoToolCatalog => ({
    tools,
    getTool(name: string): PaseoToolDefinition | undefined {
      return tools.get(name);
    },
    async executeTool(
      name: string,
      input: unknown,
      context: PaseoToolExecutionContext = {},
    ): Promise<PaseoToolResult> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Paseo tool not found: ${name}`);
      }
      // Coordinators run delegate-only at observe trust; the daemon, not the
      // prompt, enforces that observe callers cannot spawn, mutate, or answer.
      if (callerAgentId) {
        assertCoordinatorToolAllowed(agentManager.getAgent(callerAgentId), name);
      }
      return tool.handler(await parseToolInput(tool, input), context);
    },
  });

  const buildCronScheduleCadence = (input: {
    cron: string | undefined;
    timezone?: string;
  }): ScheduleCadence => {
    const expression = input.cron?.trim() ?? "";
    if (!expression) {
      throw new Error("cron is required");
    }
    const timezone = normalizeScheduleTimeZoneArg(input.timezone);
    return {
      type: "cron",
      expression,
      ...(timezone !== undefined ? { timezone } : {}),
    };
  };

  const buildScheduleExpiry = (expiresIn: string | undefined): string | undefined => {
    return expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDurationString(expiresIn)).toISOString();
  };

  const resolveCallerAgent = () => {
    if (!callerAgentId) {
      return null;
    }
    const parentAgent = agentManager.getAgent(callerAgentId);
    if (!parentAgent) {
      throw new Error(`Parent agent ${callerAgentId} not found`);
    }
    return parentAgent;
  };

  const requireCoordinatorBridge = () => {
    if (!options.coordinator) {
      throw new Error("Coordinator service is not configured");
    }
    return options.coordinator;
  };

  /**
   * Read-only spawn precheck before `create_agent` resolves workspaces (which
   * can mint records). The authoritative check runs inside createAgentCommand
   * under the coordinator's spawn lock. Callers outside a coordinator tree get
   * null back — the gate does not constrain ordinary spawns.
   */
  const coordinatorSpawnPrecheck = async (args: unknown): Promise<void> => {
    if (!callerAgentId || !options.coordinator) return;
    const raw = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const rawKind = typeof raw.subagentKind === "string" ? raw.subagentKind : undefined;
    const subagentKind =
      rawKind && (COORDINATOR_SUBAGENT_KINDS as readonly string[]).includes(rawKind)
        ? (rawKind as CoordinatorSubagentKind)
        : undefined;
    const relationship =
      raw.relationship && typeof raw.relationship === "object"
        ? (raw.relationship as Record<string, unknown>)
        : undefined;
    await options.coordinator.assertSpawnAllowed({
      parentAgentId: callerAgentId,
      ...(subagentKind ? { subagentKind } : {}),
      ...(relationship?.kind === "detached" ? { detached: true } : {}),
    });
  };

  /**
   * Coordinators and their delegated agents may only steer sessions inside the
   * coordinator's boundary (descendants everywhere; in-scope project sessions
   * at Ship). Callers outside a coordinator tree are unaffected.
   */
  const assertAgentTargetAllowed = async (
    targetAgentId: string,
    targetOptions?: { action?: "steer" | "mutate" },
  ): Promise<void> => {
    if (!callerAgentId || !options.coordinator) return;
    await options.coordinator.assertAgentTargetAllowed(callerAgentId, targetAgentId, targetOptions);
  };

  /**
   * Mutating a workspace reaches every agent inside it, so it needs the same
   * coordinator boundary as agent-targeting tools. Ungoverned callers are
   * unaffected.
   */
  const assertWorkspaceTargetAllowed = async (workspaceId: string): Promise<void> => {
    if (!callerAgentId || !options.coordinator) return;
    await options.coordinator.assertWorkspaceTargetAllowed(callerAgentId, workspaceId);
  };

  /**
   * A governed caller may not rewrite its own runtime settings or answer its
   * own permission requests — that authority sits above it in the tree.
   */
  const assertSelfActionAllowed = async (targetAgentId: string, action: string): Promise<void> => {
    if (!callerAgentId || callerAgentId !== targetAgentId || !options.coordinator) return;
    await options.coordinator.assertSelfActionAllowed(callerAgentId, action);
  };

  /**
   * A governed caller's cwd-bound resources (terminals) must live under its
   * own checkout; ungoverned callers keep legacy behavior.
   */
  const assertScopedCwdAllowed = async (cwd: string): Promise<void> => {
    if (!callerAgentId || !options.coordinator) return;
    await options.coordinator.assertScopedCwdAllowed(callerAgentId, cwd);
  };

  /**
   * Minting a workspace is a write the read-only subagent kinds may not do —
   * the coordinator tool allowlist only constrains the coordinator itself, so
   * a delegated investigator/reviewer needs this check even inside its own
   * checkout.
   */
  const assertWorkspaceCreateAllowed = async (): Promise<void> => {
    if (!callerAgentId || !options.coordinator) return;
    await options.coordinator.assertWorkspaceCreateAllowed(callerAgentId);
  };

  /**
   * A terminal is a shell: read-only governed agents (the coordinator, its
   * investigator/reviewer delegates) may not touch one — it would bypass the
   * provider-native write restrictions their role enforces.
   */
  const assertTerminalAccessAllowed = async (): Promise<void> => {
    if (!callerAgentId || !options.coordinator) return;
    await options.coordinator.assertTerminalAccessAllowed(callerAgentId);
  };

  /**
   * Schedules mint agents outside the delegation tree — governed callers are
   * denied outright, ungoverned callers keep legacy behavior.
   */
  const assertScheduleAccessAllowed = async (): Promise<void> => {
    if (!callerAgentId || !options.coordinator) return;
    await options.coordinator.assertScheduleAccessAllowed(callerAgentId);
  };

  /**
   * A governed caller's workspaces belong to the project that governs it —
   * never a foreign projectId.
   */
  const assertProjectScopeAllowed = async (projectId: string | undefined): Promise<void> => {
    if (!callerAgentId || !projectId || !options.coordinator) return;
    await options.coordinator.assertProjectScopeAllowed(callerAgentId, projectId);
  };

  const resolveInheritedProviderConfig = (
    selectedProvider: string,
  ): Pick<AgentSessionConfig, "providerOptions" | "paseoTools"> | undefined => {
    const callerAgent = resolveCallerAgent();
    if (!callerAgent) {
      return undefined;
    }
    const inherited: Pick<AgentSessionConfig, "providerOptions" | "paseoTools"> = {};
    if (callerAgent.provider === selectedProvider && callerAgent.config?.providerOptions) {
      inherited.providerOptions = callerAgent.config.providerOptions;
    }
    // `paseoTools: "required"` is daemon-controlled and propagates to every
    // spawned subagent regardless of provider, so a coordinator's children keep
    // the Paseo tools even when daemon-wide injection is off. `delegateOnly`
    // deliberately does not propagate — delegates do the implementation work.
    if (callerAgent.config?.paseoTools === "required") {
      inherited.paseoTools = "required";
    }
    return Object.keys(inherited).length > 0 ? inherited : undefined;
  };

  const resolveScopedCwd = (requestedCwd?: string, opts?: { required?: boolean }): string => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return resolveChildAgentCwd({
        parentCwd: callerAgent.cwd,
        requestedCwd,
        lockedCwd: callerContext?.lockedCwd,
        allowCustomCwd: callerContext?.allowCustomCwd ?? true,
      });
    }

    const trimmedCwd = requestedCwd?.trim();
    if (!trimmedCwd) {
      if (opts?.required) {
        throw new Error("cwd is required");
      }
      throw new Error("cwd is required outside an agent-scoped session");
    }

    return expandUserPath(trimmedCwd);
  };

  /**
   * Change-request tools address a repository, not a workspace record: cwd wins
   * over workspaceId, and a bare caller resolves to its own workspace cwd. A
   * worktree path is fine — forge resolution reads the repo remote, not the
   * checkout root.
   */
  const resolveForgeActionCwd = async (input: {
    cwd?: string;
    workspaceId?: string;
  }): Promise<string> => {
    const workspaceId = input.workspaceId?.trim();
    if (workspaceId) {
      if (input.cwd?.trim()) {
        throw new Error("Pass either cwd or workspaceId, not both");
      }
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is not configured");
      }
      const workspace = await options.workspaceRegistry.get(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      if (workspace.archivedAt) {
        throw new Error(`Workspace ${workspaceId} is archived`);
      }
      return workspace.cwd;
    }
    return resolveScopedCwd(input.cwd);
  };

  const requireForgeResolution = async (
    cwd: string,
  ): Promise<{ forge: string; service: ForgeService }> => {
    if (!options.workspaceGitService) {
      throw new Error("Workspace git service is not configured");
    }
    const resolution = await options.workspaceGitService.resolveForge(cwd);
    if (!resolution) {
      throw new Error(
        `No forge remote resolved for ${cwd} — the checkout needs a git remote ` +
          "pointing at a supported forge (GitHub, GitLab, Gitea-family)",
      );
    }
    return resolution;
  };

  const requireDefaultBranch = async (cwd: string): Promise<string> => {
    if (!options.workspaceGitService) {
      throw new Error("Workspace git service is not configured");
    }
    return options.workspaceGitService.resolveDefaultBranch(cwd);
  };

  async function resolveTerminalWorkspaceId(resolvedCwd: string): Promise<string> {
    // An agent-spawned terminal belongs to the caller agent's workspace. Only if
    // the caller has no workspace do we mint one for the cwd.
    const callerAgent = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
    if (callerAgent?.workspaceId) {
      return callerAgent.workspaceId;
    }

    if (!options.ensureWorkspaceForCreate) {
      throw new Error(
        callerAgentId
          ? `Caller agent ${callerAgentId} has no workspace and workspace minting is not configured`
          : "workspaceId is required outside an agent-scoped session",
      );
    }

    return options.ensureWorkspaceForCreate(resolvedCwd);
  }

  function resolveWorkspaceIdForRename(requestedWorkspaceId?: string): string {
    const explicitWorkspaceId = requestedWorkspaceId?.trim();
    if (explicitWorkspaceId) {
      return explicitWorkspaceId;
    }

    if (callerAgentId) {
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      return callerAgent.workspaceId;
    }
    throw new Error("workspaceId is required outside an agent-scoped session");
  }

  const buildCallerAgentScheduleConfigExtras = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    resolvedProvider: string,
  ): Record<string, unknown> => {
    return {
      ...(callerAgent.config.thinkingOptionId
        ? { thinkingOptionId: callerAgent.config.thinkingOptionId }
        : {}),
      ...(callerAgent.provider === resolvedProvider && callerAgent.config.providerOptions
        ? { providerOptions: callerAgent.config.providerOptions }
        : {}),
      ...(callerAgent.config.featureValues
        ? { featureValues: callerAgent.config.featureValues }
        : {}),
      ...(callerAgent.config.systemPrompt ? { systemPrompt: callerAgent.config.systemPrompt } : {}),
      ...(callerAgent.config.mcpServers ? { mcpServers: callerAgent.config.mcpServers } : {}),
    };
  };

  const buildCallerAgentScheduleConfig = (
    callerAgent: NonNullable<ReturnType<typeof resolveCallerAgent>>,
    params?: { provider?: string; cwd?: string },
  ) => {
    const hasProviderOverride = params?.provider !== undefined;
    const resolvedProviderModel = hasProviderOverride
      ? resolveScheduleProviderAndModel({
          provider: params?.provider,
          defaultProvider: callerAgent.provider,
        })
      : null;
    const resolvedProvider = resolvedProviderModel?.provider ?? callerAgent.provider;
    let resolvedModel: string | undefined;
    if (resolvedProviderModel?.model) {
      resolvedModel = resolvedProviderModel.model;
    } else if (!hasProviderOverride && callerAgent.config.model) {
      resolvedModel = callerAgent.config.model;
    }
    return {
      provider: resolvedProvider,
      cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : callerAgent.cwd,
      ...(callerAgent.currentModeId && callerAgent.provider === resolvedProvider
        ? {
            modeId: callerAgent.currentModeId,
          }
        : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...buildCallerAgentScheduleConfigExtras(callerAgent, resolvedProvider),
    };
  };

  const resolveNewAgentScheduleTarget = (params?: {
    provider?: string;
    accountSelection?: AccountSelection;
    cwd?: string;
    isolation?: "local" | "worktree";
  }) => {
    const callerAgent = resolveCallerAgent();
    if (callerAgent) {
      return {
        type: "new-agent" as const,
        config: {
          ...buildCallerAgentScheduleConfig(callerAgent, params),
          ...(params?.accountSelection ? { accountSelection: params.accountSelection } : {}),
          ...(params?.isolation ? { isolation: params.isolation } : {}),
        },
      };
    }

    if (!params?.provider?.trim()) {
      throw new Error("provider is required when target is new-agent");
    }

    const resolvedProviderModel = resolveScheduleProviderAndModel({
      provider: params?.provider,
      defaultProvider: params.provider,
    });
    return {
      type: "new-agent" as const,
      config: {
        provider: resolvedProviderModel.provider,
        ...(params?.accountSelection ? { accountSelection: params.accountSelection } : {}),
        cwd: params?.cwd?.trim() ? expandUserPath(params.cwd) : process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(params?.isolation ? { isolation: params.isolation } : {}),
      },
    };
  };

  async function requireScheduleTarget(id: string, type: "agent" | "new-agent") {
    if (!scheduleService) {
      throw new Error("Schedule service is not configured");
    }
    const schedule = await scheduleService.inspect(id);
    if (schedule.target.type !== type) {
      throw new Error(
        type === "agent" ? `Heartbeat not found: ${id}` : `Schedule not found: ${id}`,
      );
    }
    return schedule;
  }

  async function requireCallerHeartbeat(id: string) {
    if (!callerAgentId) {
      throw new Error("Heartbeat operations require an agent-scoped session");
    }
    const schedule = await requireScheduleTarget(id, "agent");
    if (schedule.target.type !== "agent" || schedule.target.agentId !== callerAgentId) {
      throw new Error(`Heartbeat ${id} does not belong to caller ${callerAgentId}`);
    }
    return schedule;
  }
  const ProviderModelInputSchema = AgentProviderEnum.trim()
    .refine((value) => value.includes("/"), {
      message: "provider must be provider/model, for example codex/gpt-5.4",
    })
    .refine(
      (value) => {
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider/model, for example codex/gpt-5.4" },
    );
  const ProviderOrProviderModelInputSchema = AgentProviderEnum.trim()
    .min(1, "provider is required")
    .refine(
      (value) => {
        if (!value.includes("/")) {
          return true;
        }
        try {
          resolveRequiredProviderModel(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "provider must be provider or provider/model, for example codex/gpt-5.4" },
    );
  const CreateAgentSettingsInputSchema = z
    .object({
      accountSelection: AccountSelectionSchema.optional(),
      modeId: z.string().optional().describe("Session mode to configure before the first run."),
      thinkingOptionId: z.string().optional().describe("Thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  type CreateAgentSettingsInput = z.infer<typeof CreateAgentSettingsInputSchema>;
  const UpdateAgentSettingsInputSchema = z
    .object({
      modeId: z.string().optional().describe("Session mode ID."),
      model: z.string().nullable().optional().describe("Model ID. Pass null to clear."),
      thinkingOptionId: z
        .string()
        .nullable()
        .optional()
        .describe("Thinking option ID. Pass null to clear."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Provider-specific feature values, for example { fast_mode: true } for Codex."),
    })
    .strict();
  const InspectProviderSettingsInputSchema = z
    .object({
      accountSelection: AccountSelectionSchema.optional(),
      modeId: z.string().optional().describe("Draft session mode ID."),
      model: z.string().optional().describe("Draft model ID."),
      thinkingOptionId: z.string().optional().describe("Draft thinking option ID."),
      features: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Draft provider feature values."),
    })
    .strict();
  const AgentRelationshipInputSchema = z.discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("subagent") })
      .strict()
      .describe("Create a child agent under this agent's subagent track."),
    z
      .object({ kind: z.literal("detached") })
      .strict()
      .describe("Create a root agent that does not appear in this agent's subagent track."),
  ]);
  const AgentCreateWorktreeTargetInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("branch-off"),
        worktreeSlug: z
          .string()
          .min(1)
          .optional()
          .describe("Optional worktree slug/path label. Omit to let Paseo generate one."),
        branchName: z
          .string()
          .min(1)
          .optional()
          .describe("Optional git branch name. Defaults to the worktree slug."),
        baseBranch: z
          .string()
          .min(1)
          .optional()
          .describe("Optional base branch. Defaults to the repository default branch."),
      })
      .strict()
      .describe("Create a new branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-branch"),
        branch: z.string().min(1).describe("Existing branch to check out."),
      })
      .strict()
      .describe("Check out an existing branch in a new Paseo worktree."),
    z
      .object({
        kind: z.literal("checkout-pr"),
        githubPrNumber: z.number().int().positive().describe("GitHub pull request number."),
      })
      .strict()
      .describe("Check out a GitHub pull request in a new Paseo worktree."),
  ]);
  const AgentWorkspaceInputSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("current"),
        cwd: z.string().optional().describe("Optional runtime cwd. Defaults to the caller's cwd."),
      })
      .strict()
      .describe("Use the caller's current workspace."),
    z
      .object({
        kind: z.literal("existing"),
        workspaceId: z.string().min(1).describe("Existing workspace id to attach the agent to."),
        cwd: z
          .string()
          .optional()
          .describe("Optional runtime cwd. Defaults to the existing workspace cwd."),
      })
      .strict()
      .describe("Attach the agent to an existing workspace."),
    z
      .object({
        kind: z.literal("create"),
        source: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("directory"),
              path: z
                .string()
                .optional()
                .describe("Optional directory path. Defaults to the caller's cwd."),
            })
            .strict(),
          z
            .object({
              kind: z.literal("worktree"),
              cwd: z
                .string()
                .optional()
                .describe("Optional source repository. Defaults to the caller's cwd."),
              target: AgentCreateWorktreeTargetInputSchema,
            })
            .strict(),
        ]),
      })
      .strict()
      .describe("Create a new workspace for the agent."),
  ]);
  const commonCreateAgentFields = {
    title: z
      .string()
      .trim()
      .min(1, "Title is required")
      .max(60, "Title must be 60 characters or fewer")
      .describe("Short descriptive title (<= 60 chars) summarizing the agent's focus."),
    provider: ProviderModelInputSchema.describe(
      "Required provider/model pair, for example codex/gpt-5.4.",
    ),
    labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
    subagentKind: z
      .enum(COORDINATOR_SUBAGENT_KINDS)
      .optional()
      .describe(
        "Coordinator role for this spawn: investigator researches read-only, reviewer checks work and change requests, implementer writes code. Only valid for callers inside a coordinator's delegation tree; the coordinator's profiles configure the launch bundle.",
      ),
    settings: CreateAgentSettingsInputSchema.optional().describe(
      "Initial runtime settings for the new agent.",
    ),
    initialPrompt: z
      .string()
      .trim()
      .min(1, "initialPrompt is required")
      .describe("Required first task to run immediately after creation."),
  };
  const legacyCreateAgentPlacementFields = {
    relationship: AgentRelationshipInputSchema.describe(
      "Whether the created agent is a subagent under you or a detached root agent.",
    ),
    workspace: AgentWorkspaceInputSchema.describe(
      "Workspace ownership/location for the created agent.",
    ),
  };
  const canonicalCreateAgentFields = {
    ...commonCreateAgentFields,
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Existing workspace id. Agent-scoped calls default to the caller workspace; top-level calls create a new local workspace when omitted.",
      ),
  };
  const agentToAgentInputSchema = {
    ...canonicalCreateAgentFields,
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the created agent finishes, errors, or needs permission. Set false only for truly fire-and-forget agents.",
      ),
  };
  const canonicalTopLevelInputSchema = {
    ...canonicalCreateAgentFields,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the created agent finishes, errors, or needs permission.",
      ),
  };
  const legacyAgentToAgentInputSchema = {
    ...commonCreateAgentFields,
    ...legacyCreateAgentPlacementFields,
    notifyOnFinish: agentToAgentInputSchema.notifyOnFinish,
  };
  const legacyTopLevelCreateAgentInputSchema = {
    ...commonCreateAgentFields,
    relationship: legacyCreateAgentPlacementFields.relationship.optional(),
    workspace: legacyCreateAgentPlacementFields.workspace.optional(),
    background: canonicalTopLevelInputSchema.background,
    notifyOnFinish: canonicalTopLevelInputSchema.notifyOnFinish,
    cwd: z
      .string()
      .optional()
      .describe("Legacy top-level working directory. Prefer workspace.source.path."),
    mode: z.string().optional().describe("Legacy session mode ID. Prefer settings.modeId."),
    thinking: z
      .string()
      .optional()
      .describe("Legacy thinking option ID. Prefer settings.thinkingOptionId."),
    features: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Legacy feature values. Prefer settings.features."),
    worktreeName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy worktree slug. Prefer workspace.source.target.worktreeSlug."),
    branchName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch name. Prefer workspace.source.target.branchName."),
    baseBranch: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy base branch. Prefer workspace.source.target.baseBranch."),
    refName: z
      .string()
      .min(1)
      .optional()
      .describe("Legacy branch/ref to check out. Prefer workspace.source.target.branch."),
    githubPrNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Legacy GitHub PR number. Prefer workspace.source.target.githubPrNumber."),
  };
  const createAgentInputSchema = z
    .object(callerAgentId ? agentToAgentInputSchema : canonicalTopLevelInputSchema)
    .passthrough();
  const agentToAgentCreateAgentArgsSchema = z.object(agentToAgentInputSchema).strict();
  const legacyAgentToAgentCreateAgentArgsSchema = z.object(legacyAgentToAgentInputSchema).strict();
  const canonicalTopLevelCreateAgentArgsSchema = z.object(canonicalTopLevelInputSchema).strict();
  const legacyTopLevelCreateAgentArgsSchema = z
    .object(legacyTopLevelCreateAgentInputSchema)
    .strict();
  const commonSendAgentPromptInputSchema = {
    agentId: z.string(),
    prompt: z.string(),
    sessionMode: z.string().optional().describe("Optional mode to set before running the prompt."),
  };
  const agentToAgentSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Run agent in background. Agent-scoped default is true so you can continue until the finish notification arrives. Set false only when you need a blocking response.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Get notified when the prompted agent finishes, errors, or needs permission. Set false only for truly fire-and-forget prompts.",
      ),
  };
  const topLevelSendAgentPromptInputSchema = {
    ...commonSendAgentPromptInputSchema,
    background: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Run agent in background. If false (default), waits for completion or permission request. If true, returns immediately.",
      ),
    notifyOnFinish: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Agent-scoped only: get notified when the prompted agent finishes, errors, or needs permission.",
      ),
  };
  const sendAgentPromptInputSchema = callerAgentId
    ? agentToAgentSendAgentPromptInputSchema
    : topLevelSendAgentPromptInputSchema;
  const inspectProviderInputSchema = {
    provider: ProviderOrProviderModelInputSchema.describe(
      "Provider ID, optionally with a model ID (for example codex or codex/gpt-5.4).",
    ),
    cwd: z
      .string()
      .optional()
      .describe("Working directory used to resolve provider feature availability."),
    settings: InspectProviderSettingsInputSchema.optional().describe(
      "Draft provider settings used to compute available features.",
    ),
  };
  type AgentToAgentCreateAgentArgs = z.infer<typeof agentToAgentCreateAgentArgsSchema>;
  type LegacyAgentToAgentCreateAgentArgs = z.infer<typeof legacyAgentToAgentCreateAgentArgsSchema>;
  type TopLevelCreateAgentArgs = z.infer<typeof canonicalTopLevelCreateAgentArgsSchema>;
  type LegacyTopLevelCreateAgentArgs = z.infer<typeof legacyTopLevelCreateAgentArgsSchema>;

  if (options.voiceOnly || options.enableVoiceTools || callerContext?.enableVoiceTools) {
    registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak text to the user via daemon-managed voice output. Blocks until playback completes.",
        inputSchema: {
          text: z
            .string()
            .trim()
            .min(1, "text is required")
            .max(4000, "text must be 4000 characters or fewer"),
        },
        outputSchema: {
          ok: z.boolean(),
        },
      },
      async (args, context) => {
        if (!callerAgentId) {
          throw new Error("speak is only available to agent-scoped tool sessions");
        }
        const handler = resolveSpeakHandler?.(callerAgentId) ?? null;
        if (!handler) {
          throw new Error(`No speak handler registered for your session '${callerAgentId}'`);
        }
        await handler({
          text: args.text,
          callerAgentId,
          signal: context?.signal,
        });
        return {
          content: [],
          structuredContent: ensureValidJson({ ok: true }),
        };
      },
    );
  }

  if (options.voiceOnly) {
    return toCatalog();
  }

  if (options.browserToolsEnabled && options.browserToolsBroker) {
    registerBrowserTools({
      registerTool,
      broker: options.browserToolsBroker,
      callerAgentId,
      resolveCallerAgent,
    });
  }

  registerTool(
    "create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a workspace using an existing local checkout or a new Paseo-managed worktree.",
      inputSchema: {
        isolation: z.enum(["local", "worktree"]),
        path: z
          .string()
          .optional()
          .describe("Local directory or source checkout. Defaults to your current workspace."),
        projectId: z.string().optional().describe("Existing project id to own the workspace."),
        title: z.string().trim().min(1).optional(),
        mode: z
          .enum(["branch-off", "checkout-branch", "checkout-pr"])
          .optional()
          .describe("Worktree creation mode. Defaults to branch-off."),
        worktreeSlug: z.string().trim().min(1).optional(),
        branchName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("New branch name for branch-off mode."),
        baseBranch: z.string().trim().min(1).optional().describe("Base ref for branch-off mode."),
        branch: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Existing branch for checkout-branch mode."),
        prNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pull request or change request number for checkout-pr mode."),
        forge: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Forge for checkout-pr mode. Defaults to the source checkout."),
      },
      outputSchema: WorkspaceAutomationSummarySchema.shape,
    },
    async ({
      isolation,
      path,
      projectId,
      title,
      mode,
      worktreeSlug,
      branchName,
      baseBranch,
      branch,
      prNumber,
      forge,
    }) => {
      // Read-only delegated kinds may not provision at all; the trust-level
      // allowlist only covers the coordinator itself.
      await assertWorkspaceCreateAllowed();
      // A governed caller mints workspaces only under its own checkout and
      // only inside its own project — a foreign cwd or projectId would plant
      // agents the boundary checks would never let it touch directly.
      await assertProjectScopeAllowed(projectId);
      let workspace: PersistedWorkspaceRecord;
      if (isolation === "local") {
        const cwd = resolveScopedCwd(path, { required: true });
        await assertScopedCwdAllowed(cwd);
        assertOptionsAbsent(
          [
            ["mode", mode],
            ["worktreeSlug", worktreeSlug],
            ["branchName", branchName],
            ["baseBranch", baseBranch],
            ["branch", branch],
            ["prNumber", prNumber],
            ["forge", forge],
          ],
          "Worktree options require isolation worktree",
        );
        if (!options.createDirectoryWorkspace) {
          throw new Error("Workspace provisioning is not configured");
        }
        workspace = await options.createDirectoryWorkspace(cwd, title, projectId);
      } else {
        let cwd =
          path !== undefined || !projectId ? resolveScopedCwd(path, { required: true }) : null;
        if (cwd) {
          await assertScopedCwdAllowed(cwd);
        }
        if (!cwd) {
          if (!options.projectRegistry) {
            throw new Error("Project registry is not configured");
          }
          cwd = await resolveWorktreeSourceCwd({ projectId }, options.projectRegistry);
        }
        const worktreeTarget = resolveWorkspaceWorktreeTarget({
          mode,
          worktreeSlug,
          branchName,
          baseBranch,
          branch,
          prNumber,
          forge,
        });
        const result = await createPaseoWorktreeCommand(
          {
            paseoHome: options.paseoHome,
            worktreesRoot: options.worktreesRoot,
            createPaseoWorktreeWorkflow: options.createPaseoWorktree,
          },
          {
            cwd,
            ...(projectId ? { projectId } : {}),
            ...(worktreeSlug ? { worktreeSlug } : {}),
            ...worktreeTarget,
            ...(title ? { title } : {}),
          },
        );
        if (!result.ok) {
          throw result.cause;
        }
        workspace = result.createdWorktree.workspace;
      }

      return {
        content: [],
        structuredContent: ensureValidJson(toWorkspaceAutomationSummary(workspace)),
      };
    },
  );

  registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "List active workspaces.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(WorkspaceAutomationSummarySchema) },
    },
    async () => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is not configured");
      }
      const workspaces = (await options.workspaceRegistry.list())
        .filter((workspace) => !workspace.archivedAt)
        .map(toWorkspaceAutomationSummary);
      return {
        content: [],
        structuredContent: ensureValidJson({ workspaces }),
      };
    },
  );

  registerTool(
    "archive_workspace",
    {
      title: "Archive workspace",
      description: "Archive a workspace and everything it owns.",
      inputSchema: { workspaceId: z.string().min(1) },
      outputSchema: {
        workspaceId: z.string(),
        archivedAgentIds: z.array(z.string()),
        removedDirectory: z.boolean(),
      },
    },
    async ({ workspaceId }) => {
      if (!options.listActiveWorkspaces) {
        throw new Error("Active workspace lister is required to archive workspaces");
      }
      // Archiving a workspace takes down every agent inside it — a delegated
      // caller could otherwise bypass the agent boundary by archiving a
      // foreign agent's workspace.
      await assertWorkspaceTargetAllowed(workspaceId);
      const workspace = await requireActiveWorkspaceForArchive(
        { listActiveWorkspaces: options.listActiveWorkspaces },
        workspaceId,
      );
      const result = await archiveByScope(
        archiveWorktreeDependencies(options, {
          agentManager,
          agentStorage,
          terminalManager: terminalManager ?? null,
          logger: childLogger,
        }),
        {
          requestId: "mcp:archive_workspace",
          scope: { kind: "workspace", workspaceId: workspace.workspaceId },
        },
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          workspaceId,
          archivedAgentIds: result.archivedAgentIds,
          removedDirectory: result.removedDirectory,
        }),
      };
    },
  );

  registerTool(
    "create_agent",
    {
      title: "Create agent",
      description:
        "Create an agent. Agent-scoped creation defaults to your workspace and creates your subagent. Top-level creation without workspaceId creates a new local workspace. Requires provider/model (for example codex/gpt-5.4) and an initial prompt. Do not guess; call list_providers and list_models first if uncertain.",
      inputSchema: createAgentInputSchema,
      outputSchema: {
        agentId: z.string(),
        type: AgentProviderEnum,
        status: AgentStatusEnum,
        cwd: z.string(),
        workspaceId: z.string().optional(),
        currentModeId: z.string().nullable(),
        availableModes: z.array(ProviderModeSchema),
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
      },
    },
    async (args: unknown) => {
      // The spawn gate's read-only precheck runs before arg resolution —
      // workspace resolution can mint workspace records, and a denied spawn
      // must leave nothing behind. createAgentCommand re-checks under the
      // coordinator's spawn lock.
      await coordinatorSpawnPrecheck(args);
      const resolvedArgs = await resolveCreateAgentToolArgs(args);
      const { parsedArgs, worktree } = resolvedArgs;
      let requestedBackground: boolean;
      let notifyOnFinish: boolean;
      if (resolvedArgs.kind === "agent-scoped") {
        requestedBackground = true;
        notifyOnFinish = parsedArgs.notifyOnFinish;
      } else {
        requestedBackground = resolvedArgs.parsedArgs.background;
        notifyOnFinish = resolvedArgs.parsedArgs.notifyOnFinish ?? false;
      }

      // A subagent kind carries the coordinator's configured launch bundle:
      // the role profile wins over ad-hoc settings the caller passed.
      const { provider: providerArg, settings } = await applySubagentProfile({
        subagentKind: parsedArgs.subagentKind,
        provider: parsedArgs.provider,
        settings: parsedArgs.settings,
      });

      // A coordinator profile may carry a bare provider with no model — the
      // provider's default model resolves downstream in resolveCreateConfig.
      const selectedProvider = providerArg.includes("/")
        ? resolveRequiredProviderModel(providerArg).provider
        : providerArg.trim();
      const inheritedConfig = resolveInheritedProviderConfig(selectedProvider);
      const {
        snapshot,
        background: createdInBackground,
        initialPromptStarted,
      } = await createAgentCommand(
        {
          agentManager,
          agentStorage,
          logger: childLogger,
          paseoHome: options.paseoHome,
          worktreesRoot: options.worktreesRoot,
          terminalManager,
          providerSnapshotManager,
          createPaseoWorktree: options.createPaseoWorktree,
          ...(options.ensureWorkspaceForCreate
            ? { ensureWorkspaceForCreate: options.ensureWorkspaceForCreate }
            : {}),
          ...(options.coordinator ? { coordinator: options.coordinator } : {}),
        },
        {
          kind: "mcp",
          provider: providerArg,
          title: parsedArgs.title,
          initialPrompt: parsedArgs.initialPrompt,
          config: { ...inheritedConfig, accountSelection: settings?.accountSelection },
          cwd: resolvedArgs.cwd,
          workspaceId: resolvedArgs.workspaceId,
          ...(resolvedArgs.mintWorkspaceForCwd
            ? { mintWorkspaceForCwd: resolvedArgs.mintWorkspaceForCwd }
            : {}),
          thinking: settings?.thinkingOptionId,
          features: settings?.features,
          labels: parsedArgs.labels,
          mode: settings?.modeId,
          ...(parsedArgs.subagentKind ? { subagentKind: parsedArgs.subagentKind } : {}),
          background: requestedBackground,
          notifyOnFinish,
          detached: resolvedArgs.detached,
          callerAgentId,
          callerContext,
          worktree,
        },
      );

      return respondToCreatedAgent({
        snapshot,
        createdInBackground,
        initialPromptStarted,
        notifyOnFinish,
      });
    },
  );

  type ResolvedCreateAgentToolArgs =
    | {
        kind: "agent-scoped";
        parsedArgs: AgentToAgentCreateAgentArgs | LegacyAgentToAgentCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
        mintWorkspaceForCwd?: boolean;
      }
    | {
        kind: "top-level";
        parsedArgs: TopLevelCreateAgentArgs | LegacyTopLevelCreateAgentArgs;
        detached: boolean;
        cwd: string | undefined;
        workspaceId: string | undefined;
        worktree: CreateAgentFromMcpInput["worktree"];
        mintWorkspaceForCwd?: boolean;
      };

  async function resolveCreateAgentToolArgs(args: unknown): Promise<ResolvedCreateAgentToolArgs> {
    if (callerAgentId) {
      if (hasLegacyCreateAgentPlacement(args)) {
        // COMPAT(nestedCreateAgentPlacement): accept the old relationship/workspace shape without
        // advertising it to models. Added in v0.2.0; remove after 2027-01-17.
        const parsed = legacyAgentToAgentCreateAgentArgsSchema.parse(args);
        const { cwd, workspaceId, worktree, mintWorkspaceForCwd } =
          await resolveCreateAgentWorkspace(parsed.workspace);
        return {
          kind: "agent-scoped",
          parsedArgs: parsed,
          detached: parsed.relationship.kind === "detached",
          cwd,
          workspaceId,
          worktree,
          ...(mintWorkspaceForCwd ? { mintWorkspaceForCwd } : {}),
        };
      }
      const parsed = agentToAgentCreateAgentArgsSchema.parse(args);
      const { cwd, workspaceId } = await resolveCanonicalCreateAgentWorkspace(parsed.workspaceId, {
        prompt: parsed.initialPrompt,
      });
      return {
        kind: "agent-scoped",
        parsedArgs: parsed,
        detached: false,
        cwd,
        workspaceId,
        worktree: undefined,
      };
    }
    if (hasLegacyCreateAgentPlacement(args)) {
      // COMPAT(nestedCreateAgentPlacement): see the agent-scoped branch above.
      const parsedArgs = normalizeTopLevelCreateAgentArgs(
        legacyTopLevelCreateAgentArgsSchema.parse(args),
      );
      if (parsedArgs.relationship?.kind === "subagent") {
        throw new Error("relationship subagent requires an agent-scoped tool session");
      }
      if (!parsedArgs.workspace) {
        throw new Error("Legacy create_agent placement could not be resolved");
      }
      const { cwd, workspaceId, worktree, mintWorkspaceForCwd } = await resolveCreateAgentWorkspace(
        parsedArgs.workspace,
      );
      return {
        kind: "top-level",
        parsedArgs,
        detached: true,
        cwd,
        workspaceId,
        worktree,
        ...(mintWorkspaceForCwd ? { mintWorkspaceForCwd } : {}),
      };
    }
    const parsedArgs = canonicalTopLevelCreateAgentArgsSchema.parse(args);
    const { cwd, workspaceId } = await resolveCanonicalCreateAgentWorkspace(
      parsedArgs.workspaceId,
      { prompt: parsedArgs.initialPrompt },
    );
    return {
      kind: "top-level",
      parsedArgs,
      detached: false,
      cwd,
      workspaceId,
      worktree: undefined,
    };
  }

  function hasLegacyCreateAgentPlacement(args: unknown): boolean {
    if (!args || typeof args !== "object") {
      return false;
    }
    const input = args as Record<string, unknown>;
    return [
      "relationship",
      "workspace",
      "cwd",
      "worktreeName",
      "branchName",
      "baseBranch",
      "refName",
      "githubPrNumber",
    ].some((key) => input[key] !== undefined);
  }

  async function resolveCanonicalCreateAgentWorkspace(
    workspaceId?: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string;
  }> {
    if (workspaceId) {
      const resolved = await resolveCreateAgentWorkspace({ kind: "existing", workspaceId });
      return { cwd: resolved.cwd, workspaceId };
    }
    if (!callerAgentId) {
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      const cwd = process.cwd();
      return {
        cwd,
        workspaceId: await options.ensureWorkspaceForCreate(cwd, firstAgentContext),
      };
    }
    const caller = resolveCallerAgent();
    if (!caller?.workspaceId) {
      throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
    }
    return { cwd: undefined, workspaceId: caller.workspaceId };
  }

  /**
   * A subagent kind carries the coordinator's configured launch bundle: the
   * resolved role profile's provider/model/mode/features/account selection
   * wins over whatever ad-hoc settings the caller passed.
   */
  async function applySubagentProfile(params: {
    subagentKind: CoordinatorSubagentKind | undefined;
    provider: string;
    settings: CreateAgentSettingsInput | undefined;
  }): Promise<{ provider: string; settings: CreateAgentSettingsInput | undefined }> {
    if (!params.subagentKind) {
      return { provider: params.provider, settings: params.settings };
    }
    const profile = await requireCoordinatorBridge().resolveSubagentProfile({
      callerAgentId: callerAgentId!,
      kind: params.subagentKind,
    });
    // Read-only kinds launch delegate-only; a caller-supplied session mode
    // (say bypassPermissions) must not ride along. Only the profile's own
    // mode applies.
    const readOnlyKind =
      params.subagentKind === "investigator" || params.subagentKind === "reviewer";
    const callerSettings = { ...params.settings };
    if (readOnlyKind) {
      delete callerSettings.modeId;
    }
    return {
      provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
      settings: {
        ...callerSettings,
        ...(profile.modeId !== undefined ? { modeId: profile.modeId } : {}),
        ...(profile.thinkingOptionId !== undefined
          ? { thinkingOptionId: profile.thinkingOptionId }
          : {}),
        ...(profile.featureValues
          ? { features: { ...params.settings?.features, ...profile.featureValues } }
          : {}),
        ...(profile.accountSelection ? { accountSelection: profile.accountSelection } : {}),
      },
    };
  }

  /**
   * create_agent's result: wait for a synchronous (foreground) create to
   * finish and report its outcome, or return the live snapshot immediately
   * for background creation.
   */
  async function respondToCreatedAgent(params: {
    snapshot: ManagedAgent;
    createdInBackground: boolean;
    initialPromptStarted: boolean;
    notifyOnFinish: boolean;
  }): Promise<PaseoToolResult> {
    const { snapshot } = params;
    if (!params.createdInBackground && params.initialPromptStarted) {
      try {
        const result = await waitForAgentWithTimeout(agentManager, snapshot.id, {
          waitForActive: true,
        });
        const liveSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
        return {
          content: [],
          structuredContent: ensureValidJson({
            agentId: snapshot.id,
            type: snapshot.provider,
            status: result.status,
            cwd: liveSnapshot.cwd,
            ...(liveSnapshot.workspaceId ? { workspaceId: liveSnapshot.workspaceId } : {}),
            currentModeId: liveSnapshot.currentModeId,
            availableModes: liveSnapshot.availableModes,
            lastMessage: result.lastMessage,
            permission: sanitizePermissionRequest(result.permission),
          }),
        };
      } catch (error) {
        childLogger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
        throw error;
      }
    }

    // Return immediately for async creation.
    const currentSnapshot = agentManager.getAgent(snapshot.id) ?? snapshot;
    const guidance =
      callerAgentId && params.notifyOnFinish && params.initialPromptStarted
        ? "You will get notified when the created agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives."
        : undefined;
    return {
      content: [],
      structuredContent: ensureValidJson({
        agentId: currentSnapshot.id,
        type: snapshot.provider,
        status: currentSnapshot.lifecycle,
        cwd: currentSnapshot.cwd,
        ...(currentSnapshot.workspaceId ? { workspaceId: currentSnapshot.workspaceId } : {}),
        currentModeId: currentSnapshot.currentModeId,
        availableModes: currentSnapshot.availableModes,
        lastMessage: null,
        permission: null,
        ...(guidance ? { guidance } : {}),
      }),
    };
  }

  function normalizeTopLevelCreateAgentArgs(
    args: LegacyTopLevelCreateAgentArgs,
  ): LegacyTopLevelCreateAgentArgs {
    const {
      cwd,
      mode,
      thinking,
      features,
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
      ...canonicalCandidate
    } = args;
    const settings = {
      ...canonicalCandidate.settings,
      ...(mode ? { modeId: mode } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(features ? { features } : {}),
    };

    if (canonicalCandidate.relationship && canonicalCandidate.workspace) {
      return legacyTopLevelCreateAgentArgsSchema.parse({
        ...canonicalCandidate,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      });
    }

    if (canonicalCandidate.relationship || canonicalCandidate.workspace) {
      throw new Error("relationship and workspace must be provided together");
    }

    if (!cwd?.trim()) {
      throw new Error("cwd is required for legacy top-level create_agent calls");
    }

    const legacyWorktreeTarget = resolveLegacyCreateAgentWorktreeTarget({
      worktreeName,
      branchName,
      baseBranch,
      refName,
      githubPrNumber,
    });
    const workspace = legacyWorktreeTarget
      ? {
          kind: "create" as const,
          source: {
            kind: "worktree" as const,
            cwd,
            target: legacyWorktreeTarget,
          },
        }
      : {
          kind: "create" as const,
          source: {
            kind: "directory" as const,
            path: cwd,
          },
        };

    return legacyTopLevelCreateAgentArgsSchema.parse({
      ...canonicalCandidate,
      relationship: { kind: "detached" },
      workspace,
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    });
  }

  function resolveLegacyCreateAgentWorktreeTarget(input: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    githubPrNumber?: number;
  }): z.infer<typeof AgentCreateWorktreeTargetInputSchema> | null {
    if (input.githubPrNumber !== undefined) {
      return {
        kind: "checkout-pr",
        githubPrNumber: input.githubPrNumber,
      };
    }

    if (input.refName) {
      return {
        kind: "checkout-branch",
        branch: input.refName,
      };
    }

    if (input.worktreeName || input.branchName || input.baseBranch) {
      return {
        kind: "branch-off",
        worktreeSlug: input.worktreeName,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
      };
    }

    return null;
  }

  async function resolveCreateAgentWorkspace(
    workspace:
      | LegacyAgentToAgentCreateAgentArgs["workspace"]
      | NonNullable<LegacyTopLevelCreateAgentArgs["workspace"]>,
  ): Promise<{
    cwd: string | undefined;
    workspaceId: string | undefined;
    worktree: CreateAgentFromMcpInput["worktree"];
    mintWorkspaceForCwd?: boolean;
  }> {
    if (workspace.kind === "current") {
      if (!callerAgentId) {
        throw new Error("workspace current requires an agent-scoped tool session");
      }
      const callerAgent = resolveCallerAgent();
      if (!callerAgent?.workspaceId) {
        throw new Error(`Caller agent ${callerAgentId} has no current workspace`);
      }
      const cwd = workspace.cwd ? resolveScopedCwd(workspace.cwd, { required: true }) : undefined;
      if (cwd) {
        await assertScopedCwdAllowed(cwd);
      }
      return {
        cwd,
        workspaceId: callerAgent.workspaceId,
        worktree: undefined,
      };
    }

    if (workspace.kind === "existing") {
      if (!options.listActiveWorkspaces) {
        throw new Error("Workspace lookup is not configured");
      }
      // Spawning into a workspace is acting on it — governed callers may only
      // mint children inside their boundary.
      await assertWorkspaceTargetAllowed(workspace.workspaceId);
      const existingWorkspace = (await options.listActiveWorkspaces()).find(
        (candidate) => candidate.workspaceId === workspace.workspaceId,
      );
      if (!existingWorkspace) {
        throw new Error(`Workspace ${workspace.workspaceId} not found`);
      }
      const cwd = workspace.cwd
        ? resolveScopedCwd(workspace.cwd, { required: true })
        : existingWorkspace.cwd;
      if (!isSameOrDescendantPath(existingWorkspace.cwd, cwd)) {
        throw new Error(
          `cwd ${cwd} is outside workspace ${workspace.workspaceId} (${existingWorkspace.cwd})`,
        );
      }
      const lockedCwd = callerContext?.lockedCwd?.trim();
      if (lockedCwd && !isSameOrDescendantPath(expandUserPath(lockedCwd), cwd)) {
        throw new Error(`Workspace ${workspace.workspaceId} is outside the allowed cwd`);
      }
      return {
        cwd,
        workspaceId: workspace.workspaceId,
        worktree: undefined,
      };
    }

    if (workspace.source.kind === "directory") {
      const cwd = resolveScopedCwd(workspace.source.path, { required: true });
      // A governed caller may only mint workspaces under its own checkout.
      await assertScopedCwdAllowed(cwd);
      if (!options.ensureWorkspaceForCreate) {
        throw new Error("Workspace creation is not configured");
      }
      // The workspace record mints inside createAgentCommand's spawn gate —
      // a coordinator-governed spawn denied under the lock leaves no record.
      return {
        cwd,
        workspaceId: undefined,
        worktree: undefined,
        mintWorkspaceForCwd: true,
      };
    }

    const cwd = resolveScopedCwd(workspace.source.cwd, { required: true });
    // The worktree branches off this repo — a foreign base would plant the
    // spawn outside the governed checkout.
    await assertScopedCwdAllowed(cwd);
    return {
      cwd,
      workspaceId: undefined,
      worktree: resolveCreateAgentWorktree(workspace.source.target),
    };
  }

  function resolveCreateAgentWorktree(
    target: z.infer<typeof AgentCreateWorktreeTargetInputSchema>,
  ): NonNullable<CreateAgentFromMcpInput["worktree"]> {
    switch (target.kind) {
      case "branch-off":
        return {
          action: "branch-off",
          worktreeName: target.worktreeSlug,
          branchName: target.branchName,
          baseBranch: target.baseBranch,
        };
      case "checkout-branch":
        return {
          action: "checkout",
          refName: target.branch,
        };
      case "checkout-pr":
        return {
          action: "checkout",
          githubPrNumber: target.githubPrNumber,
        };
      default:
        throw new Error("unreachable");
    }
  }

  registerTool(
    "send_agent_prompt",
    {
      title: "Send agent prompt",
      description:
        "Send a task to a running agent. Agent-scoped callers run in background by default; top-level callers wait by default.",
      inputSchema: sendAgentPromptInputSchema,
      outputSchema: {
        success: z.boolean(),
        status: AgentStatusEnum,
        lastMessage: z.string().nullable().optional(),
        permission: AgentPermissionRequestPayloadSchema.nullable().optional(),
        guidance: z.string().optional(),
      },
    },
    async ({
      agentId,
      prompt,
      sessionMode,
      background = Boolean(callerAgentId),
      notifyOnFinish = Boolean(callerAgentId),
    }) => {
      const shouldNotifyOnFinish = Boolean(callerAgentId && notifyOnFinish && background);

      await assertAgentTargetAllowed(agentId);
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId,
        prompt,
        sessionMode,
        logger: childLogger,
      });

      if (shouldNotifyOnFinish && callerAgentId) {
        setupFinishNotification({
          agentManager,
          agentStorage,
          childAgentId: agentId,
          callerAgentId,
          logger: childLogger,
        });
      }

      // If not running in background, wait for completion
      if (!background) {
        const result = await waitForAgentWithTimeout(agentManager, agentId, {
          waitForActive: true,
        });

        const responseData = {
          success: true,
          status: result.status,
          lastMessage: result.lastMessage,
          permission: sanitizePermissionRequest(result.permission),
        };
        const validJson = ensureValidJson(responseData);

        const response = {
          content: [],
          structuredContent: validJson,
        };
        return response;
      }

      // Return immediately if background=true
      // Re-fetch snapshot since the state may have changed
      const currentSnapshot = agentManager.getAgent(agentId);

      const responseData = {
        success: true,
        status: currentSnapshot?.lifecycle ?? "idle",
        lastMessage: null,
        permission: null,
        ...(shouldNotifyOnFinish
          ? {
              guidance:
                "You will get notified when the prompted agent finishes, errors, or needs permission. Do not poll for status; continue with other work until the notification arrives.",
            }
          : {}),
      };
      const validJson = ensureValidJson(responseData);

      const response = {
        content: [],
        structuredContent: validJson,
      };
      return response;
    },
  );

  registerTool(
    "get_agent_status",
    {
      title: "Get agent status",
      description:
        "Return the latest snapshot for an agent, including lifecycle state, capabilities, and pending permissions.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        status: AgentStatusEnum,
        snapshot: AgentSnapshotPayloadSchema,
      },
    },
    async ({ agentId }) => {
      const snapshot = agentManager.getAgent(agentId);
      if (snapshot) {
        const structuredSnapshot = await serializeSnapshotWithMetadata(
          agentStorage,
          snapshot,
          childLogger,
        );
        return {
          content: [],
          structuredContent: ensureValidJson({
            status: snapshot.lifecycle,
            snapshot: structuredSnapshot,
          }),
        };
      }

      const record = await agentStorage.get(agentId);
      if (!record || record.internal) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const structuredSnapshot = buildStoredAgentPayload(
        record,
        new Set(providerSnapshotManager.listRegisteredProviderIds()),
      );
      return {
        content: [],
        structuredContent: ensureValidJson({
          status: structuredSnapshot.status,
          snapshot: structuredSnapshot,
        }),
      };
    },
  );

  registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List recent agents as compact metadata.",
      inputSchema: {
        includeArchived: z.boolean().optional().default(false),
        cwd: z.string().optional(),
        sinceHours: z
          .number()
          .int()
          .positive()
          .max(24 * 30)
          .optional()
          .default(48),
        statuses: z.array(AgentStatusEnum).optional(),
        limit: z.number().int().positive().max(200).optional().default(50),
      },
      outputSchema: {
        agents: z.array(AgentListItemPayloadSchema),
      },
    },
    async ({ includeArchived = false, cwd, sinceHours = 48, statuses, limit = 50 }) => {
      const callerCwd = callerAgentId ? resolveCallerAgent()?.cwd : undefined;
      const requestedCwd = cwd?.trim() ? expandUserPath(cwd) : callerCwd;
      const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;
      const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
      const liveSnapshots = agentManager.listAgents();
      const liveAgents = await Promise.all(
        liveSnapshots.map((snapshot) =>
          serializeSnapshotWithMetadata(agentStorage, snapshot, childLogger),
        ),
      );
      const liveIds = new Set(liveSnapshots.map((snapshot) => snapshot.id));
      const storedRecords = await agentStorage.list();
      const registeredProviderIds = new Set(providerSnapshotManager.listRegisteredProviderIds());
      const storedAgents = storedRecords
        .filter((record) => !record.internal && !liveIds.has(record.id))
        .filter((record) => includeArchived || !record.archivedAt)
        .filter(
          (record) =>
            includeArchived || isStoredAgentProviderAvailable(record, registeredProviderIds),
        )
        .map((record) => buildStoredAgentPayload(record, registeredProviderIds));
      const agents = [...liveAgents, ...storedAgents]
        .map(toAgentListItemPayload)
        .filter((agent) => !requestedCwd || isSameOrDescendantPath(requestedCwd, agent.cwd))
        .filter((agent) => !statusFilter || statusFilter.has(agent.status))
        .filter((agent) => !agent.archivedAt || resolveAgentListActivityTime(agent) >= sinceMs)
        .sort(compareAgentListItems)
        .slice(0, limit);

      return {
        content: [],
        structuredContent: ensureValidJson({ agents }),
      };
    },
  );

  registerTool(
    "cancel_agent",
    {
      title: "Cancel agent run",
      description: "Abort the agent's current run but keep the agent alive for future tasks.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await assertAgentTargetAllowed(agentId);
      const { cancelled } = await cancelAgentRunCommand(
        { agentManager, logger: childLogger },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: cancelled }),
      };
    },
  );

  registerTool(
    "archive_agent",
    {
      title: "Archive agent",
      description:
        "Archive an agent (soft-delete). The agent is interrupted if running and removed from the active list.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await assertAgentTargetAllowed(agentId, { action: "mutate" });
      await archiveAgentCommand(
        {
          agentManager,
          agentStorage,
          logger: childLogger,
        },
        agentId,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "kill_agent",
    {
      title: "Kill agent",
      description: "Terminate an agent session permanently.",
      inputSchema: {
        agentId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId }) => {
      await assertAgentTargetAllowed(agentId, { action: "mutate" });
      await closeAgentCommand({ agentManager }, agentId);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent name, labels, and/or runtime settings.",
      inputSchema: {
        agentId: z.string(),
        name: z.string().optional(),
        labels: z.record(z.string(), z.string()).optional().describe("Labels to set on the agent"),
        settings: UpdateAgentSettingsInputSchema.optional().describe(
          "Runtime settings to apply to the agent.",
        ),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, name, labels, settings }) => {
      await assertAgentTargetAllowed(agentId, { action: "mutate" });
      // A governed agent could otherwise promote its own read-only profile
      // into a writing mode and escape the role the coordinator spawned it as.
      if (settings !== undefined) {
        await assertSelfActionAllowed(agentId, "change runtime settings");
      }
      if (settings?.modeId !== undefined) {
        await agentManager.setAgentMode(agentId, settings.modeId);
      }
      if (settings?.model !== undefined) {
        await agentManager.setAgentModel(agentId, settings.model);
      }
      if (settings?.thinkingOptionId !== undefined) {
        await agentManager.setAgentThinkingOption(agentId, settings.thinkingOptionId);
      }
      if (settings?.features) {
        for (const [featureId, value] of Object.entries(settings.features)) {
          await agentManager.setAgentFeature(agentId, featureId, value);
        }
      }

      // Lineage and coordinator stamps are daemon-owned (updateAgentCommand
      // strips them again); agent tools also may not write client tab markers.
      await updateAgentCommand(
        { agentManager },
        { agentId, name, labels: stripAgentToolLabels(labels) },
      );

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "rename_workspace",
    {
      title: "Rename workspace",
      description:
        "Rename a workspace by setting its user-visible title. Omit workspaceId to rename your current workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Workspace id to rename. Omit to rename your current workspace."),
        title: z
          .string()
          .trim()
          .min(1, "title is required")
          .describe("New user-visible workspace title."),
      },
      outputSchema: {
        success: z.boolean(),
        workspaceId: z.string(),
        title: z.string(),
      },
    },
    async ({ workspaceId: requestedWorkspaceId, title }) => {
      if (!options.workspaceRegistry) {
        throw new Error("Workspace registry is required to rename workspaces");
      }
      if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
        throw new Error("Workspace update emitter is required to rename workspaces");
      }

      const workspaceId = resolveWorkspaceIdForRename(requestedWorkspaceId);
      await assertWorkspaceTargetAllowed(workspaceId);
      const existing = await options.workspaceRegistry.get(workspaceId);
      if (!existing) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }
      if (existing.archivedAt) {
        throw new Error(`Workspace ${workspaceId} is archived`);
      }

      await options.workspaceRegistry.upsert({
        ...existing,
        title,
        updatedAt: new Date().toISOString(),
      });
      await options.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);

      return {
        content: [],
        structuredContent: ensureValidJson({
          success: true,
          workspaceId,
          title,
        }),
      };
    },
  );

  registerTool(
    "list_workspace_scripts",
    {
      title: "List workspace scripts",
      description:
        "List configured workspace scripts and their lifecycle, service port, proxy URL, health, and terminal ID.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID whose configured scripts to list."),
      },
      outputSchema: {
        scripts: z.array(WorkspaceScriptPayloadSchema),
      },
    },
    async ({ workspaceId }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      return {
        content: [],
        structuredContent: ensureValidJson({ scripts: await workspaceScripts.list(workspaceId) }),
      };
    },
  );

  registerTool(
    "start_workspace_script",
    {
      title: "Start workspace script",
      description:
        "Start one configured workspace script through Paseo's managed workspace-script launcher.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the configured script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to start."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      await assertWorkspaceTargetAllowed(workspaceId);
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.launch({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "stop_workspace_script",
    {
      title: "Stop workspace script",
      description: "Stop a running workspace script through its supervised terminal lifecycle.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID containing the running script."),
        scriptName: z.string().min(1).describe("Configured paseo.json script name to stop."),
      },
      outputSchema: {
        script: WorkspaceScriptPayloadSchema,
      },
    },
    async ({ workspaceId, scriptName }) => {
      if (!workspaceScripts) {
        throw new Error("Workspace script management is not configured");
      }
      await assertWorkspaceTargetAllowed(workspaceId);
      return {
        content: [],
        structuredContent: ensureValidJson({
          script: await workspaceScripts.stop({ workspaceId, scriptName }),
        }),
      };
    },
  );

  registerTool(
    "list_terminals",
    {
      title: "List terminals",
      description: "List terminals for a working directory or across all working directories.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        all: z.boolean().optional().describe("List terminals across all working directories."),
      },
      outputSchema: {
        terminals: z.array(TerminalSummarySchema),
      },
    },
    async ({ cwd, all }) => {
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminals = all
        ? (
            await Promise.all(
              terminalManager.listDirectories().map(async (directory) =>
                (await terminalManager.getTerminals(directory)).map((terminal) => ({
                  id: terminal.id,
                  name: terminal.name,
                  cwd: terminal.cwd,
                })),
              ),
            )
          ).flat()
        : (await terminalManager.getTerminals(resolveScopedCwd(cwd, { required: true }))).map(
            (terminal) => ({
              id: terminal.id,
              name: terminal.name,
              cwd: terminal.cwd,
            }),
          );

      return {
        content: [],
        structuredContent: ensureValidJson({ terminals }),
      };
    },
  );

  registerTool(
    "create_terminal",
    {
      title: "Create terminal",
      description: "Create a terminal session for a working directory.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Optional working directory. Defaults to your current working directory."),
        name: z.string().optional().describe("Optional terminal name."),
      },
      outputSchema: TerminalSummarySchema.shape,
    },
    async ({ cwd, name }) => {
      await assertTerminalAccessAllowed();
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      // A governed caller's terminals stay under its own checkout — otherwise
      // a delegated agent could run commands inside a foreign workspace.
      await assertScopedCwdAllowed(resolvedCwd);
      const workspaceId = await resolveTerminalWorkspaceId(resolvedCwd);

      const terminal = await terminalManager.createTerminal({
        cwd: resolvedCwd,
        workspaceId,
        ...(name?.trim() ? { name: name.trim() } : {}),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          id: terminal.id,
          name: terminal.name,
          cwd: terminal.cwd,
        }),
      };
    },
  );

  registerTool(
    "kill_terminal",
    {
      title: "Kill terminal",
      description: "Kill an existing terminal session.",
      inputSchema: {
        terminalId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId }) => {
      await assertTerminalAccessAllowed();
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }
      await assertWorkspaceTargetAllowed(terminal.workspaceId);

      terminal.kill();

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "capture_terminal",
    {
      title: "Capture terminal",
      description: "Capture plain-text terminal output lines from a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
        scrollback: z.boolean().optional(),
        stripAnsi: z.boolean().optional().default(true),
      },
      outputSchema: {
        terminalId: z.string(),
        lines: z.array(z.string()),
        totalLines: z.number().int().nonnegative(),
      },
    },
    async ({ terminalId, start, end, scrollback, stripAnsi = true }) => {
      await assertTerminalAccessAllowed();
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }
      // Output capture reads foreign command output — same workspace boundary
      // as the mutating terminal ops.
      await assertWorkspaceTargetAllowed(terminal.workspaceId);

      const capture = await terminalManager.captureTerminal(terminalId, {
        start: scrollback ? 0 : start,
        end,
        stripAnsi,
      });

      return {
        content: [],
        structuredContent: ensureValidJson({
          terminalId,
          lines: capture.lines,
          totalLines: capture.totalLines,
        }),
      };
    },
  );

  registerTool(
    "send_terminal_keys",
    {
      title: "Send terminal keys",
      description: "Send literal text or special key tokens to a terminal session.",
      inputSchema: {
        terminalId: z.string(),
        keys: z.string(),
        literal: z.boolean().optional(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ terminalId, keys, literal = false }) => {
      await assertTerminalAccessAllowed();
      if (!terminalManager) {
        throw new Error("Terminal manager is not configured");
      }

      const terminal = terminalManager.getTerminal(terminalId);
      if (!terminal) {
        throw new Error(`Terminal ${terminalId} not found`);
      }
      await assertWorkspaceTargetAllowed(terminal.workspaceId);

      terminal.send({
        type: "input",
        data: resolveTerminalKeyToken(keys, literal),
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "create_schedule",
    {
      title: "Create schedule",
      description: "Create a recurring schedule that starts a new agent on a cron cadence.",
      inputSchema: {
        accountSelection: AccountSelectionSchema.optional(),
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        provider: (callerAgentId ? AgentProviderEnum.optional() : AgentProviderEnum).describe(
          "Provider, or provider/model (for example: codex or codex/gpt-5.4). Defaults to the caller's provider in an agent-scoped session.",
        ),
        cwd: z.string().optional(),
        isolation: z.enum(["local", "worktree"]).optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({
      prompt,
      cron,
      timezone,
      name,
      provider,
      accountSelection,
      cwd,
      isolation,
      maxRuns,
      expiresIn,
    }) => {
      // A schedule spawns agents with no parent — a governed caller would
      // mint descendants the spawn guard never sees. The deny lands before the
      // service check so governed callers never learn whether it exists.
      await assertScheduleAccessAllowed();
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: resolveNewAgentScheduleTarget({ provider, accountSelection, cwd, isolation }),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "create_heartbeat",
    {
      title: "Create heartbeat",
      description: "Create a recurring heartbeat that sends you a prompt on a cron cadence.",
      inputSchema: {
        prompt: z.string().trim().min(1, "prompt is required"),
        cron: z.string().trim().min(1, "cron is required"),
        timezone: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("IANA time zone for the cron cadence. For example: America/New_York."),
        name: z.string().optional(),
        maxRuns: z.number().int().positive().optional(),
        expiresIn: z.string().optional(),
      },
      outputSchema: ScheduleSummarySchema.shape,
    },
    async ({ prompt, cron, timezone, name, maxRuns, expiresIn }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      if (!callerAgentId) {
        throw new Error("create_heartbeat requires an agent-scoped session");
      }
      resolveCallerAgent();

      const expiresAt = buildScheduleExpiry(expiresIn);
      const schedule = await scheduleService.createOrReplace({
        prompt: prompt.trim(),
        cadence: buildCronScheduleCadence({
          cron,
          ...(timezone !== undefined ? { timezone } : {}),
        }),
        target: { type: "agent", agentId: callerAgentId },
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      return {
        content: [],
        structuredContent: ensureValidJson(toScheduleSummary(schedule)),
      };
    },
  );

  registerTool(
    "delete_heartbeat",
    {
      title: "Delete heartbeat",
      description: "Delete one of your heartbeats.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: { success: z.boolean() },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireCallerHeartbeat(id);
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "list_schedules",
    {
      title: "List schedules",
      description: "List all schedules managed by the daemon.",
      inputSchema: {},
      outputSchema: {
        schedules: z.array(ScheduleSummarySchema),
      },
    },
    async () => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedules = (await scheduleService.list())
        .filter((schedule) => schedule.target.type === "new-agent")
        .map((schedule) => toScheduleSummary(schedule));
      return {
        content: [],
        structuredContent: ensureValidJson({ schedules }),
      };
    },
  );

  registerTool(
    "inspect_schedule",
    {
      title: "Inspect schedule",
      description: "Inspect a schedule and its run history.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      const schedule = await requireScheduleTarget(id, "new-agent");
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "pause_schedule",
    {
      title: "Pause schedule",
      description: "Pause an active schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      await assertScheduleAccessAllowed();
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.pause(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "resume_schedule",
    {
      title: "Resume schedule",
      description: "Resume a paused schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      await assertScheduleAccessAllowed();
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.resume(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "delete_schedule",
    {
      title: "Delete schedule",
      description: "Delete a schedule permanently.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ id }) => {
      await assertScheduleAccessAllowed();
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      await scheduleService.delete(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  registerTool(
    "update_schedule",
    {
      title: "Update schedule",
      description:
        "Update an existing schedule. Only provided fields are changed; omitted fields remain unchanged.",
      inputSchema: z
        .object({
          id: z.string(),
          cron: z.string().optional().describe("New cron expression."),
          timezone: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "IANA time zone for cron cadence; requires cron. For example: America/New_York.",
            ),
          name: z.string().nullable().optional().describe("New name (null to clear)."),
          prompt: z.string().trim().min(1).optional().describe("New prompt text."),
          maxRuns: z
            .number()
            .int()
            .positive()
            .nullable()
            .optional()
            .describe("New max runs limit (null to clear)."),
          accountSelection: AccountSelectionSchema.nullable().optional(),
          provider: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("New provider for new-agent target."),
          model: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New model for new-agent target (null to clear)."),
          mode: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .optional()
            .describe("New mode for new-agent target (null to clear)."),
          cwd: z.string().trim().min(1).optional().describe("New cwd for new-agent target."),
          expiresIn: z
            .string()
            .optional()
            .describe("New relative expiry duration (for example: 1h, 2d)."),
          clearExpires: z.boolean().optional().describe("Clear any schedule expiry."),
        })
        .passthrough(),
      outputSchema: StoredScheduleSchema.shape,
    },
    async (input) => {
      await assertScheduleAccessAllowed();
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(input.id, "new-agent");
      const schedule = await scheduleService.update(buildScheduleUpdateInput(input));

      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  registerTool(
    "schedule_logs",
    {
      title: "Schedule logs",
      description: "Get the run history (logs) for a schedule.",
      inputSchema: {
        id: z.string(),
      },
      outputSchema: {
        runs: z.array(ScheduleRunSchema),
      },
    },
    async ({ id }) => {
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }

      await requireScheduleTarget(id, "new-agent");
      const runs = await scheduleService.logs(id);
      return {
        content: [],
        structuredContent: ensureValidJson({ runs }),
      };
    },
  );

  registerTool(
    "run_schedule_once",
    {
      title: "Run schedule once",
      description: "Run a schedule immediately without changing its cron cadence.",
      inputSchema: { id: z.string().min(1) },
      outputSchema: StoredScheduleSchema.shape,
    },
    async ({ id }) => {
      await assertScheduleAccessAllowed();
      if (!scheduleService) {
        throw new Error("Schedule service is not configured");
      }
      await requireScheduleTarget(id, "new-agent");
      const schedule = await scheduleService.runOnce(id);
      return {
        content: [],
        structuredContent: ensureValidJson(schedule),
      };
    },
  );

  async function readProviderCatalog(
    provider: string,
    cwd?: string,
    accountSelection?: AccountSelection,
    model?: string,
  ) {
    if (agentManager.accounts && (provider === "claude" || provider === "codex")) {
      const result = await agentManager.getAccountCatalog({
        provider,
        cwd,
        selection: accountSelection,
        model,
      });
      if (!result.entry) throw new Error(result.error ?? result.reason);
      return result.entry;
    }
    const entry = await providerSnapshotManager.getProvider({ provider, cwd, wait: true });
    if (!entry.enabled) throw new Error(`Provider '${provider}' is disabled`);
    if (entry.status !== "ready")
      throw new Error(entry.error ?? `Provider '${provider}' is unavailable`);
    return entry;
  }

  registerTool(
    "list_provider_accounts",
    {
      title: "List provider accounts",
      description:
        "List account IDs, labels, login state, and eligibility settings. Login and credential changes belong in Settings.",
      inputSchema: {},
      outputSchema: { accounts: z.array(ProviderAccountSchema) },
    },
    async () => ({
      content: [],
      structuredContent: ensureValidJson({ accounts: agentManager.accounts?.list() ?? [] }),
    }),
  );

  registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List configured agent providers, availability, and their modes.",
      inputSchema: {},
      outputSchema: {
        providers: z.array(ProviderSummarySchema),
      },
    },
    async () => {
      const providers = (await providerSnapshotManager.listProviders({ wait: true })).map(
        toProviderSummary,
      );
      return {
        content: [],
        structuredContent: ensureValidJson({ providers }),
      };
    },
  );

  registerTool(
    "list_models",
    {
      title: "List models",
      description: "List models for an agent provider.",
      inputSchema: {
        provider: AgentProviderEnum,
        accountSelection: AccountSelectionSchema.optional(),
        cwd: z.string().optional(),
      },
      outputSchema: {
        provider: z.string(),
        models: z.array(AgentModelSchema),
      },
    },
    async ({ provider, accountSelection, cwd }) => {
      const models = (await readProviderCatalog(provider, cwd, accountSelection)).models ?? [];
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider,
          models,
        }),
      };
    },
  );

  registerTool(
    "list_profiles",
    {
      title: "List agent profiles",
      description:
        "List agent profiles: named provider/model/mode bundles a human configured for specific " +
        "kinds of work. Read each profile's `notes` to pick the one that fits the task you're " +
        "delegating, then copy its `provider`, `model`, `modeId`, `thinkingOptionId`, and " +
        "`featureValues`, and `accountSelection` into create_agent (there is no `profile` parameter). Returns an empty " +
        "list if none are configured.",
      inputSchema: {},
      outputSchema: {
        profiles: z.array(AgentProfileSchema),
      },
    },
    async () => {
      const profiles = daemonConfigStore?.get().agentProfiles ?? [];
      return {
        content: [],
        structuredContent: ensureValidJson({ profiles }),
      };
    },
  );

  registerTool(
    "inspect_provider",
    {
      title: "Inspect provider",
      description:
        "Inspect compact provider capabilities for orchestration, including modes and draft feature settings. Use list_models for the full model list.",
      inputSchema: inspectProviderInputSchema,
      outputSchema: {
        provider: AgentProviderEnum,
        label: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        enabled: z.boolean(),
        status: z.string(),
        modes: z.array(ProviderModeSchema).nullish(),
        selectedModel: z.string().nullable(),
        features: z.array(AgentFeatureSchema),
      },
    },
    async ({ provider, cwd, settings }) => {
      const resolvedProviderModel = resolveScheduleProviderAndModel({
        provider,
        defaultProvider: provider,
      });
      const providerId = resolvedProviderModel.provider;
      const resolvedCwd = resolveScopedCwd(cwd, { required: true });
      const entry = await readProviderCatalog(
        providerId,
        resolvedCwd,
        settings?.accountSelection,
        settings?.model ?? resolvedProviderModel.model,
      );
      const summary = toProviderSummary(entry);
      if (!entry.enabled) {
        throw new Error(`Provider '${providerId}' is disabled`);
      }
      if (entry.status !== "ready") {
        throw new Error(entry.error ?? `Provider '${providerId}' is unavailable`);
      }
      const selectedModel = settings?.model ?? resolvedProviderModel.model;
      const features = await agentManager.listDraftFeatures({
        provider: providerId,
        accountSelection: settings?.accountSelection,
        cwd: resolvedCwd,
        ...(settings?.modeId ? { modeId: settings.modeId } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(settings?.thinkingOptionId ? { thinkingOptionId: settings.thinkingOptionId } : {}),
        ...(settings?.features ? { featureValues: settings.features } : {}),
      });
      return {
        content: [],
        structuredContent: ensureValidJson({
          provider: providerId,
          label: summary.label,
          description: summary.description,
          enabled: summary.enabled,
          status: summary.status,
          modes: summary.modes,
          selectedModel: selectedModel ?? null,
          features,
        }),
      };
    },
  );

  registerTool(
    "get_agent_activity",
    {
      title: "Get agent activity",
      description: "Return recent agent timeline entries as a curated summary.",
      inputSchema: {
        agentId: z.string(),
        limit: z
          .number()
          .optional()
          .describe("Optional limit for number of activities to include (most recent first)."),
      },
      outputSchema: {
        agentId: z.string(),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      },
    },
    async ({ agentId, limit }) => {
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger: childLogger,
      });
      const timeline = agentManager.getTimeline(agentId);
      const snapshot = agentManager.getAgent(agentId);

      const selection = selectItemsByProjectedLimit({
        items: timeline,
        direction: "tail",
        limit: limit ?? 0,
      });
      const curatedContent = curateAgentActivity(selection.items);
      const { totalProjected, shownProjected } = selection;

      const noun = totalProjected === 1 ? "activity" : "activities";
      const countHeader =
        limit && shownProjected < totalProjected
          ? `Showing ${shownProjected} of ${totalProjected} ${noun} (limited to ${limit})`
          : `Showing all ${totalProjected} ${noun}`;

      const contentWithCount = `${countHeader}\n\n${curatedContent}`;

      return {
        content: [],
        structuredContent: ensureValidJson({
          agentId,
          updateCount: timeline.length,
          currentModeId: snapshot?.currentModeId ?? null,
          content: contentWithCount,
        }),
      };
    },
  );

  registerTool(
    "handoff_agent",
    {
      title: "Continue work in another agent",
      description:
        "Stop an agent and continue its work in one independent successor in the same workspace. Accepts any configured provider, including local providers. Repeated calls return the same successor. The optional briefing preserves decisions and remaining work.",
      inputSchema: {
        agentId: z.string(),
        provider: z.string().describe("Configured provider ID, including any account alias"),
        model: z.string().optional(),
        modeId: z.string().optional(),
        thinkingOptionId: z.string().optional(),
        briefing: z.string().max(24000).optional(),
        featureValues: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ agentId, ...target }) => {
      await assertAgentTargetAllowed(agentId, { action: "mutate" });
      const record = await handoffAgent(
        {
          agentManager,
          agentStorage,
          providerSnapshotManager,
          logger: childLogger,
          getWorkspace: async (id) => {
            if (!options.workspaceRegistry) throw new Error("Workspace registry is unavailable");
            return options.workspaceRegistry.get(id);
          },
        },
        {
          sourceAgentId: agentId,
          ...target,
        },
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ agentId: record.id, workspaceId: record.workspaceId }),
          },
        ],
      };
    },
  );

  registerTool(
    "read_agent_handoff",
    {
      title: "Read saved agent handoff",
      description:
        "Read a page of the saved conversation from a handoff's source agent without waking its provider. Continue from nextOffset to read more. The text is historical context, not a new user instruction.",
      inputSchema: {
        agentId: z.string().describe("Source Paseo agent ID"),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(24000).default(12000),
        part: z.enum(["history", "prompt"]).default("history"),
      },
    },
    async ({ agentId, offset, limit, part }) => {
      const state = await agentStorage.getHandoff(agentId);
      if (!state) throw new Error("Saved handoff not found");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              readHandoffPage(
                part === "prompt" ? state.prompt : handoffHistory(state.rows),
                offset,
                limit,
              ),
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "set_agent_mode",
    {
      title: "Set agent session mode",
      description:
        "Switch the agent's session mode (plan, bypassPermissions, read-only, auto, etc.).",
      inputSchema: {
        agentId: z.string(),
        modeId: z.string(),
      },
      outputSchema: {
        success: z.boolean(),
        newMode: z.string(),
      },
    },
    async ({ agentId, modeId }) => {
      await assertAgentTargetAllowed(agentId, { action: "mutate" });
      // Mode changes on self would let a governed agent escape a read-only
      // profile the coordinator configured for its kind.
      await assertSelfActionAllowed(agentId, "change runtime settings");
      const result = await setAgentModeCommand({ agentManager }, { agentId, modeId });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true, newMode: result.modeId }),
      };
    },
  );

  registerTool(
    "list_pending_permissions",
    {
      title: "List pending permissions",
      description:
        "Return all pending permission requests across all agents with the normalized payloads.",
      inputSchema: {},
      outputSchema: {
        permissions: z.array(
          z.object({
            agentId: z.string(),
            status: AgentStatusEnum,
            request: AgentPermissionRequestPayloadSchema,
          }),
        ),
      },
    },
    async () => {
      const permissions = agentManager.listAgents().flatMap((agent) => {
        const payload = toAgentPayload(agent);
        return payload.pendingPermissions.map((request) => ({
          agentId: agent.id,
          status: payload.status,
          request: sanitizePermissionRequest(request),
        }));
      });

      return {
        content: [],
        structuredContent: ensureValidJson({ permissions }),
      };
    },
  );

  registerTool(
    "respond_to_permission",
    {
      title: "Respond to permission",
      description:
        "Approve or deny a pending permission request with an AgentManager-compatible response payload.",
      inputSchema: {
        agentId: z.string(),
        requestId: z.string(),
        response: AgentPermissionResponseSchema,
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ agentId, requestId, response }) => {
      await assertAgentTargetAllowed(agentId, { action: "mutate" });
      // Permission authority sits with the coordinator or the user — a
      // governed session may not approve its own prompts.
      await assertSelfActionAllowed(agentId, "answer permission requests");
      await respondToAgentPermission({
        agentManager,
        agentId,
        requestId,
        response,
        logger: childLogger,
      });
      return {
        content: [],
        structuredContent: ensureValidJson({ success: true }),
      };
    },
  );

  const changeRequestTargetShape = {
    cwd: z
      .string()
      .optional()
      .describe(
        "Repository checkout that resolves the forge. Defaults to your current workspace; " +
          "any worktree of the repo resolves to the same forge. Coordinators should omit " +
          "this — their own checkout resolves the forge, and `head` carries the subagent's branch.",
      ),
    workspaceId: z
      .string()
      .optional()
      .describe(
        "Workspace owning the checkout; alternative to cwd. Governed callers may only " +
          "address workspaces under their own checkout.",
      ),
  };

  registerTool(
    "create_change_request",
    {
      title: "Create change request",
      description:
        "Open a change request on the repository's forge (a pull request on GitHub and " +
        "Gitea-family hosts, a merge request on GitLab) for an existing head branch. " +
        "Coordinator callers must pass reviewerAgentId naming their reviewer subagent — " +
        "the daemon only opens the request after that reviewer has finished a review turn.",
      inputSchema: {
        ...changeRequestTargetShape,
        title: z.string().trim().min(1),
        body: z.string().optional(),
        head: z
          .string()
          .trim()
          .min(1)
          .describe("Branch containing the change — typically the implementer's worktree branch."),
        base: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Base branch. Defaults to the repository's default branch."),
        reviewerAgentId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Reviewer subagent that finished reviewing this change. Required for coordinator callers.",
          ),
      },
      outputSchema: {
        url: z.string(),
        number: z.number(),
      },
    },
    async ({ cwd, workspaceId, title, body, head, base, reviewerAgentId }) => {
      const callerAgent = callerAgentId ? agentManager.getAgent(callerAgentId) : null;
      const repoCwd = await resolveForgeActionCwd({ cwd, workspaceId });
      // Forge writes are coordinator authority inside a governed tree — a
      // delegated caller is denied before any forge call, and the resolved
      // cwd must sit under the caller's own checkout.
      if (callerAgentId) await options.coordinator?.assertForgeWriteAllowed(callerAgentId);
      await assertScopedCwdAllowed(repoCwd);
      if (callerAgent && isCoordinatorAgent(callerAgent)) {
        const verifiedReviewerId = requireChangeRequestReviewerId(reviewerAgentId);
        if (options.coordinator) {
          // The service gate resolves stored records too, so a reviewer that
          // finished and unloaded across a daemon restart still counts.
          await options.coordinator.assertReviewerGate(callerAgent.id, verifiedReviewerId);
        } else {
          assertChangeRequestReviewer({
            callerAgentId: callerAgent.id,
            reviewerAgentId: verifiedReviewerId,
            agentManager,
          });
        }
      }
      const { service } = await requireForgeResolution(repoCwd);
      const result = await service.createPullRequest({
        cwd: repoCwd,
        title,
        body,
        head,
        base: base ?? (await requireDefaultBranch(repoCwd)),
      });
      return {
        content: [],
        structuredContent: ensureValidJson(result),
      };
    },
  );

  registerTool(
    "comment_on_change_request",
    {
      title: "Comment on change request",
      description:
        "Post a comment on a change request (pull request / merge request) on the " +
        "repository's forge. Returns the created comment's URL.",
      inputSchema: {
        ...changeRequestTargetShape,
        prNumber: z.number().int().positive().describe("Change request number on the forge."),
        body: z.string().trim().min(1).describe("Markdown comment body."),
      },
      outputSchema: {
        url: z.string(),
      },
    },
    async ({ cwd, workspaceId, prNumber, body }) => {
      const repoCwd = await resolveForgeActionCwd({ cwd, workspaceId });
      if (callerAgentId) await options.coordinator?.assertForgeWriteAllowed(callerAgentId);
      await assertScopedCwdAllowed(repoCwd);
      const { service } = await requireForgeResolution(repoCwd);
      const result = await service.createPullRequestComment({ cwd: repoCwd, prNumber, body });
      return {
        content: [],
        structuredContent: ensureValidJson(result),
      };
    },
  );

  registerTool(
    "retry_change_request_checks",
    {
      title: "Retry change request checks",
      description:
        "Re-run the failed checks on a change request's head commit. Returns the checks the " +
        "forge actually re-ran, or throws when the forge has no retry API.",
      inputSchema: {
        ...changeRequestTargetShape,
        prNumber: z.number().int().positive().describe("Change request number on the forge."),
      },
      outputSchema: {
        retried: z.array(z.object({ id: z.number(), name: z.string() })),
      },
    },
    async ({ cwd, workspaceId, prNumber }) => {
      const repoCwd = await resolveForgeActionCwd({ cwd, workspaceId });
      if (callerAgentId) await options.coordinator?.assertForgeWriteAllowed(callerAgentId);
      await assertScopedCwdAllowed(repoCwd);
      const { service } = await requireForgeResolution(repoCwd);
      const result = await service.retryPullRequestChecks({ cwd: repoCwd, prNumber });
      return {
        content: [],
        structuredContent: ensureValidJson(result),
      };
    },
  );

  registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Write a markdown memory entry. scope 'team' appends to .paseo/memory/project.md " +
        "for a coordinator and .paseo/memory/learned.md for a delegated agent, in your own " +
        "checkout. Personal memory layers arrive in a later milestone; only 'team' works today.",
      inputSchema: {
        scope: z
          .enum(["team", "personal", "personal-project"])
          .default("personal")
          .describe("Memory layer; only 'team' is supported in this milestone."),
        content: z
          .string()
          .trim()
          .min(1)
          .describe("Markdown body to record — facts and decisions, not transcripts."),
        mode: z
          .enum(["append", "replace"])
          .optional()
          .describe("append adds a dated section; replace rewrites the file."),
      },
      outputSchema: {
        filePath: z.string(),
      },
    },
    async ({ scope, content, mode }) => {
      if (!callerAgentId) {
        throw new Error("remember requires an agent caller");
      }
      const result = await requireCoordinatorBridge().remember({
        callerAgentId,
        scope,
        content,
        mode,
      });
      return {
        content: [],
        structuredContent: ensureValidJson(result),
      };
    },
  );

  return toCatalog();
}

interface ArchiveWorktreeCommandContext {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager | null;
  logger: Logger;
}

function archiveWorktreeDependencies(
  options: PaseoToolHostDependencies,
  context: ArchiveWorktreeCommandContext,
): ArchiveCommandDependencies {
  if (!options.github) {
    throw new Error("GitHub service is required to archive worktrees");
  }
  if (!options.workspaceGitService) {
    throw new Error("WorkspaceGitService is required to archive worktrees");
  }
  if (!options.archiveWorkspaceRecord) {
    throw new Error("Workspace registry archiver is required to archive worktrees");
  }
  if (!options.findWorkspaceIdForCwd) {
    throw new Error("Workspace resolver is required to archive worktrees");
  }
  if (!options.listActiveWorkspaces) {
    throw new Error("Active workspace lister is required to archive worktrees");
  }
  if (!options.emitWorkspaceUpdatesForWorkspaceIds) {
    throw new Error("Workspace update emitter is required to archive worktrees");
  }
  if (!options.markWorkspaceArchiving) {
    throw new Error("Workspace archiving marker is required to archive worktrees");
  }
  if (!options.clearWorkspaceArchiving) {
    throw new Error("Workspace archiving clearer is required to archive worktrees");
  }
  return {
    paseoHome: options.paseoHome,
    paseoWorktreesBaseRoot: options.worktreesRoot,
    github: options.github,
    workspaceGitService: options.workspaceGitService,
    agentManager: context.agentManager,
    agentStorage: context.agentStorage,
    findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
    listActiveWorkspaces: options.listActiveWorkspaces,
    archiveWorkspaceRecord: options.archiveWorkspaceRecord,
    emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
    markWorkspaceArchiving: options.markWorkspaceArchiving,
    clearWorkspaceArchiving: options.clearWorkspaceArchiving,
    killTerminalsForWorkspace: (workspaceId: string) =>
      killTerminalsForWorkspace(
        {
          terminalManager: context.terminalManager,
          sessionLogger: context.logger,
        },
        workspaceId,
      ),
    sessionLogger: context.logger,
  };
}
