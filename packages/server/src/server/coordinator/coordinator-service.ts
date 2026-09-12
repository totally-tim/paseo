import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import {
  COORDINATOR_PROJECT_ID_LABEL,
  COORDINATOR_PROJECT_ROLE,
  getCoordinatorProjectIdFromLabels,
  getCoordinatorRole,
  isCoordinatorAgent,
  isDelegatedAgent,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type {
  CoordinatorBoardSnapshot,
  CoordinatorDecisionBoardRow,
  CoordinatorProfileSelection,
  CoordinatorProfiles,
  CoordinatorScope,
  CoordinatorTrustLevel,
  CoordinatorUsage,
  CoordinatorUsageExpectation,
  CoordinatorWorkingBoardRow,
  ProjectCoordinatorState,
} from "@getpaseo/protocol/messages";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { LifecycleBus } from "../agent/lifecycle-bus.js";
import type {
  AgentPermissionRequest,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectMutation,
  ProjectRegistry,
  WorkspaceMutation,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import { areEquivalentPaths } from "../../utils/path.js";
import { writeFileAtomic } from "../atomic-file.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";

import {
  ChangeRequestPoll,
  hashChangeRequestSnapshot,
  type ChangeRequestPollChange,
  type ChangeRequestPollOutcome,
} from "./change-request-poll.js";
import {
  CoordinatorStore,
  type PersistedCoordinatorBoard,
  type PersistedProjectCoordinator,
} from "./persistence.js";
import {
  buildProjectCoordinatorFirstContactPrompt,
  buildProjectCoordinatorSystemPrompt,
} from "./prompts.js";
import { composeWakeEnvelope } from "./wake-envelope.js";

const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_SNAPSHOT_LIMIT = 20;
const COORDINATOR_TITLE = "Coordinator";
const STALL_SWEEP_INTERVAL_MS = 60_000;
const STALL_THRESHOLD_MS = 30 * 60 * 1000;

export class CoordinatorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorRequestError";
  }
}

export interface EnableProjectCoordinatorInput {
  projectId: string;
  profile: CoordinatorProfileSelection;
  profiles?: CoordinatorProfiles;
  trustLevel?: CoordinatorTrustLevel;
  scope?: CoordinatorScope;
}

export interface UpdateProjectCoordinatorInput {
  projectId: string;
  profile?: CoordinatorProfileSelection;
  profiles?: CoordinatorProfiles;
  trustLevel?: CoordinatorTrustLevel;
  scope?: CoordinatorScope;
  /** Null clears the expectation. */
  usageExpectation?: CoordinatorUsageExpectation | null;
}

export interface CoordinatorRememberInput {
  callerAgentId: string;
  scope: "team" | "personal" | "personal-project";
  content: string;
  mode?: "append" | "replace";
}

export interface CoordinatorRememberResult {
  filePath: string;
}

interface CoordinatorCoverageEntry {
  projectId: string;
  lifecycle: ManagedAgent["lifecycle"];
  delegated: boolean;
}

export interface CoordinatorServiceDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  projectRegistry: Pick<ProjectRegistry, "get" | "list" | "subscribeToMutations">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list" | "subscribeToMutations">;
  createWorkspaceForDirectory: (
    cwd: string,
    title?: string | null,
    projectId?: string,
  ) => Promise<PersistedWorkspaceRecord>;
  paseoHome: string;
  logger: Logger;
  /**
   * In-process lifecycle events emitted beside pluginLifecycle in
   * AgentManager. The service subscribes for stall tracking and coordinator
   * turn-end wake delivery; without it, stall detection is disabled.
   */
  lifecycleBus?: LifecycleBus;
  /** Forge + repo-root resolution for the change-request poll and CI detection. */
  workspaceGitService?: Pick<WorkspaceGitService, "resolveForge" | "resolveRepoRoot">;
  /**
   * This month's coordinator spawn/token actuals for the wake envelope.
   * Optional until the usage-tracking slice wires a reader.
   */
  readProjectUsage?: (projectId: string) => CoordinatorUsage | undefined;
  changeRequestPollIntervalMs?: number;
  stallSweepIntervalMs?: number;
  stallThresholdMs?: number;
  now?: () => number;
}

/**
 * One coordinator wake: `key` dedupes identical wakes queued while the
 * coordinator is mid-turn, `reason` is the short line on the board's wake row,
 * and `details` is the longer body (diff lines, stall context) in the prompt.
 */
export interface CoordinatorWake {
  key: string;
  reason: string;
  details?: string;
}

function recordActivityMs(record: StoredAgentRecord): number {
  const candidates = [record.lastActivityAt, record.updatedAt, record.createdAt];
  let latest = 0;
  for (const value of candidates) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return latest;
}

function isProjectCoordinatorRecord(record: StoredAgentRecord, projectId: string): boolean {
  return (
    getCoordinatorRole(record.labels) === COORDINATOR_PROJECT_ROLE &&
    getCoordinatorProjectIdFromLabels(record.labels) === projectId
  );
}

function decisionQuestionText(request: AgentPermissionRequest): string {
  const text = request.title ?? request.description ?? request.name;
  return text.trim().length > 0 ? text : "Decision needed";
}

// The spec's free-text correction path: tapping still resolves the request,
// and the client also quotes the row into the composer for a correction.
const COMPOSER_QUOTE_OPTION_LABEL = /correct it|^edit\b/i;

interface DecisionQuestionOption {
  label: string;
}

interface DecisionQuestion {
  text?: string;
  header?: string;
  options: DecisionQuestionOption[];
}

interface DecisionQuestions {
  /** Entries on `input.questions`; more than one cannot be answered by a single tap. */
  count: number;
  first: DecisionQuestion | null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Question-kind requests carry `input.questions[]` instead of actions (Codex
 * `request_user_input` can ask several at once). M1 answers the first question
 * single-select, so only its options become row actions — and only when it is
 * the request's only question.
 */
function decisionQuestions(request: AgentPermissionRequest): DecisionQuestions | null {
  const questions = request.input?.questions;
  if (!Array.isArray(questions)) return null;
  const first = questions.find(isRecordValue);
  if (!first) return { count: questions.length, first: null };
  const options = Array.isArray(first.options)
    ? first.options.flatMap((option): DecisionQuestionOption[] => {
        if (typeof option === "string") {
          return nonEmptyValue(option) ? [{ label: option.trim() }] : [];
        }
        if (!isRecordValue(option)) return [];
        const label = nonEmptyValue(option.label);
        return label ? [{ label }] : [];
      })
    : [];
  const header = nonEmptyValue(first.header);
  const text = nonEmptyValue(first.question);
  return {
    count: questions.length,
    first: { ...(text ? { text } : {}), ...(header ? { header } : {}), options },
  };
}

function decisionRowActions(
  request: AgentPermissionRequest,
  question: DecisionQuestion | null,
): CoordinatorDecisionBoardRow["actions"] {
  if (question && question.options.length > 0) {
    return question.options.map((option, index) => {
      const row: CoordinatorDecisionBoardRow["actions"][number] = {
        id: `q0:opt:${index}`,
        label: option.label,
      };
      if (COMPOSER_QUOTE_OPTION_LABEL.test(option.label)) row.composerQuote = true;
      return row;
    });
  }
  const actions = request.actions ?? [];
  // Tool-kind requests often carry no actions; the ordinary permission card
  // synthesizes Deny/Accept in that case, so the board does the same.
  if (actions.length === 0) {
    return [
      { id: "reject", label: "Deny", behavior: "deny", variant: "danger" },
      { id: "accept", label: "Accept", behavior: "allow", variant: "primary" },
    ];
  }
  return actions.map((action) => {
    const row: CoordinatorDecisionBoardRow["actions"][number] = {
      id: action.id,
      label: action.label,
      behavior: action.behavior,
    };
    if (action.variant) row.variant = action.variant;
    return row;
  });
}

/**
 * The spec's Correct-it path quotes the proposal body. Claude fills
 * description with the joined option labels on question requests, so the
 * question's own text wins for question-kind; description is only a fallback
 * for actioned kinds.
 */
function decisionQuoteText(
  request: AgentPermissionRequest,
  question: DecisionQuestion | null,
): string {
  return (
    question?.text ??
    nonEmptyValue(request.description) ??
    nonEmptyValue(request.title) ??
    request.name
  );
}

function firstLine(text: string, maxLength = 140): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function capitalizeTrust(level: CoordinatorTrustLevel): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/**
 * Owns project-coordinator records, residency, singleton enforcement, and the
 * derived board. Coordinators are ordinary persisted agents marked with role
 * labels; this service never duplicates AgentManager lifecycle logic — it
 * creates, resumes, archives, and observes through the manager's public seams.
 *
 * Milestone 1 is observe-only: sessions launch delegate-only with required
 * Paseo tools, the tool catalog denies mutating calls (see tool-policy.ts),
 * and the board derives Needs you/Working rows from live agent state while the
 * service itself writes Done rows.
 */
export class CoordinatorService {
  private readonly store: CoordinatorStore;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: CoordinatorServiceDeps["projectRegistry"];
  private readonly workspaceRegistry: CoordinatorServiceDeps["workspaceRegistry"];
  private readonly createWorkspaceForDirectory: CoordinatorServiceDeps["createWorkspaceForDirectory"];
  private readonly logger: Logger;
  private readonly lifecycleBus?: LifecycleBus;
  private readonly workspaceGitService?: CoordinatorServiceDeps["workspaceGitService"];
  private readonly readProjectUsage?: CoordinatorServiceDeps["readProjectUsage"];
  private readonly paseoHome: string;
  private readonly now: () => number;
  private readonly stallSweepIntervalMs: number;
  private readonly stallThresholdMs: number;
  private readonly changeRequestPollIntervalMs?: number;

  private readonly states = new Map<string, PersistedProjectCoordinator | null>();
  private readonly boards = new Map<string, PersistedCoordinatorBoard>();
  private readonly listeners = new Set<(snapshot: CoordinatorBoardSnapshot) => void>();
  private readonly emittedSnapshotKeys = new Map<string, string>();
  private readonly projectOps = new Map<string, Promise<void>>();
  private readonly boardOps = new Map<string, Promise<void>>();
  private readonly agentCoverage = new Map<string, CoordinatorCoverageEntry>();
  private readonly knownDecisionQuestions = new Map<string, string>();
  private readonly dirtyBoards = new Set<string>();
  private changeRequestPoll: ChangeRequestPoll | null = null;
  private stallSweepTimer: NodeJS.Timeout | null = null;
  /** Wakes waiting on a mid-turn coordinator; flushed combined on turn_ended. */
  private readonly pendingWakes = new Map<string, CoordinatorWake[]>();
  /** Retry timers for queued wakes that outlasted the turn's run record. */
  private readonly wakeFlushTimers = new Map<string, NodeJS.Timeout>();
  /** Agents already woken for an errored turn; cleared on the next sign of life. */
  private readonly erroredAgents = new Set<string>();
  /** Stall keys already woken; cleared when the request resolves/recovers. */
  private readonly stalledWakeKeys = new Set<string>();
  private agentMcpAvailable: boolean | undefined;
  private boardFlushScheduled = false;
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private stopped = false;

  constructor(deps: CoordinatorServiceDeps) {
    this.agentManager = deps.agentManager;
    this.agentStorage = deps.agentStorage;
    this.projectRegistry = deps.projectRegistry;
    this.workspaceRegistry = deps.workspaceRegistry;
    this.createWorkspaceForDirectory = deps.createWorkspaceForDirectory;
    this.lifecycleBus = deps.lifecycleBus;
    this.workspaceGitService = deps.workspaceGitService;
    this.readProjectUsage = deps.readProjectUsage;
    this.paseoHome = deps.paseoHome;
    this.now = deps.now ?? Date.now;
    this.stallSweepIntervalMs = deps.stallSweepIntervalMs ?? STALL_SWEEP_INTERVAL_MS;
    this.stallThresholdMs = deps.stallThresholdMs ?? STALL_THRESHOLD_MS;
    this.changeRequestPollIntervalMs = deps.changeRequestPollIntervalMs;
    this.logger = deps.logger.child({ module: "coordinator" });
    this.store = new CoordinatorStore(deps.paseoHome, deps.logger);
  }

  /**
   * Reconciles on-disk coordinator state against agent records, enforces the
   * one-active-session-per-project rule, and loads enabled coordinators through
   * ensureAgentLoaded so they are resident before clients connect.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.reconcileOnLoad();
    } catch (error) {
      this.logger.error({ err: error }, "Coordinator reconciliation failed during startup");
    }
    this.unsubscribers.push(
      this.agentManager.subscribe(
        (event) => {
          void this.onAgentEvent(event);
        },
        { replayState: false },
      ),
    );
    const unsubWorkspace = this.workspaceRegistry.subscribeToMutations?.((mutation) => {
      void this.onWorkspaceMutation(mutation);
    });
    if (unsubWorkspace) this.unsubscribers.push(unsubWorkspace);
    const unsubProject = this.projectRegistry.subscribeToMutations?.((mutation) => {
      void this.onProjectMutation(mutation);
    });
    if (unsubProject) this.unsubscribers.push(unsubProject);
    this.subscribeLifecycleBus();
    this.startStallSweep();
    try {
      await this.startChangeRequestPolling();
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to start change-request polling");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.changeRequestPoll?.stop();
    if (this.stallSweepTimer) {
      clearInterval(this.stallSweepTimer);
      this.stallSweepTimer = null;
    }
    for (const timer of this.wakeFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.wakeFlushTimers.clear();
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to unsubscribe coordinator listener");
      }
    }
  }

  // -------------------------------------------------------------------------
  // coordinator.project.*
  // -------------------------------------------------------------------------

  async getProjectCoordinator(projectId: string): Promise<ProjectCoordinatorState | null> {
    const state = await this.getState(projectId);
    if (!state) return null;
    return this.toProjectCoordinatorState(state);
  }

  async enableProjectCoordinator(
    input: EnableProjectCoordinatorInput,
  ): Promise<ProjectCoordinatorState> {
    this.assertObserveTrust(input.trustLevel);
    return this.withProjectLock(input.projectId, async () => {
      const project = await this.projectRegistry.get(input.projectId);
      if (!project) throw new CoordinatorRequestError(`Unknown project: ${input.projectId}`);
      if (project.archivedAt) {
        throw new CoordinatorRequestError(`Project is archived: ${input.projectId}`);
      }
      const scope = input.scope ?? "everything";
      const now = new Date().toISOString();
      const records = await this.agentStorage.list();
      let state = (await this.getState(input.projectId)) ?? this.newState(input.projectId, now);
      const keeper = await this.resolveKeeper(
        input.projectId,
        state,
        records,
        "Retired a duplicate coordinator session",
      );
      const agentId = keeper?.id ?? null;
      const replacingProvider = keeper !== null && keeper.provider !== input.profile.provider;

      state = {
        ...state,
        agentId,
        enabled: true,
        trustLevel: "observe",
        scope,
        profile: input.profile,
        profiles: input.profiles ?? state.profiles,
        updatedAt: now,
      };

      if (!agentId || replacingProvider) {
        const workspace = await this.resolveRootWorkspace(project);
        const config = this.coordinatorSessionConfig(project, input, workspace);
        this.assertAgentMcpEndpoint(config.paseoTools);
        // The replacement exists before the old coordinator retires: a failed
        // creation leaves the previous session untouched.
        const agent = await this.agentManager.createAgent(config, undefined, {
          workspaceId: workspace.workspaceId,
          unattended: true,
          initialTitle: COORDINATOR_TITLE,
          labels: {
            [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
            [COORDINATOR_PROJECT_ID_LABEL]: input.projectId,
          },
        });
        if (replacingProvider && keeper) {
          await this.retireProviderSwitch(input.projectId, keeper, now);
        }
        state.agentId = agent.id;
        await this.appendWakeRow(
          input.projectId,
          `Woke: coordinator enabled · Level: ${capitalizeTrust("observe")}`,
          "observe",
        );
        // CreateAgentOptions.initialPrompt only feeds title derivation — the
        // first-contact prompt must be dispatched as a real turn.
        try {
          await sendPromptToAgent({
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            agentId: agent.id,
            prompt: buildProjectCoordinatorFirstContactPrompt({
              projectId: input.projectId,
              projectName: project.customName ?? project.displayName,
              rootPath: project.rootPath,
              scope,
              trustLevel: "observe",
            }),
            logger: this.logger,
          });
        } catch (error) {
          // The coordinator exists and stays resident; a failed first contact
          // surfaces as an empty reply area until the next steer, not as a
          // half-enabled project.
          this.logger.warn({ err: error, agentId: agent.id }, "coordinator first contact failed");
        }
      } else {
        // Re-enable resumes the persisted session — it keeps its required-tools
        // launch flag, so the same MCP endpoint gate applies as on creation.
        const record = await this.agentStorage.get(agentId);
        this.assertAgentMcpEndpoint(record?.config?.paseoTools);
        await ensureUnarchivedAgentLoaded(agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        });
      }

      await this.setState(input.projectId, state);
      this.changeRequestPoll?.trackProject(input.projectId);
      this.queueBoardRefresh(input.projectId);
      return this.toProjectCoordinatorState(state);
    });
  }

  async disableProjectCoordinator(projectId: string): Promise<ProjectCoordinatorState | null> {
    return this.withProjectLock(projectId, async () => {
      const state = await this.getState(projectId);
      if (!state) return null;
      const next: PersistedProjectCoordinator = {
        ...state,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      await this.setState(projectId, next);
      this.changeRequestPoll?.untrackProject(projectId);
      this.pendingWakes.delete(projectId);
      const flushTimer = this.wakeFlushTimers.get(projectId);
      if (flushTimer) {
        clearTimeout(flushTimer);
        this.wakeFlushTimers.delete(projectId);
      }
      if (next.agentId) {
        // Pause the session but keep transcript and memory on disk; re-enable
        // resumes the same agent record through ensureAgentLoaded.
        await this.agentManager.closeAgent(next.agentId).catch((error) => {
          this.logger.warn(
            { err: error, agentId: next.agentId },
            "Failed to close coordinator session on disable",
          );
        });
      }
      this.queueBoardRefresh(projectId);
      return this.toProjectCoordinatorState(next);
    });
  }

  async updateProjectCoordinator(
    input: UpdateProjectCoordinatorInput,
  ): Promise<ProjectCoordinatorState | null> {
    this.assertObserveTrust(input.trustLevel);
    return this.withProjectLock(input.projectId, async () => {
      const state = await this.getState(input.projectId);
      if (!state) return null;
      const now = new Date().toISOString();
      const next: PersistedProjectCoordinator = { ...state, updatedAt: now };

      if (input.profile !== undefined) {
        if (state.agentId) {
          const record = await this.agentStorage.get(state.agentId);
          if (record && record.provider !== input.profile.provider) {
            throw new CoordinatorRequestError(
              "The coordinator's provider is fixed for its session lifetime; disable and re-enable to switch providers",
            );
          }
        }
        if (state.enabled && state.agentId) {
          await this.applyProfileToLiveCoordinator(state.agentId, input.profile);
        }
        next.profile = input.profile;
      }
      if (input.profiles !== undefined) next.profiles = input.profiles;
      if (input.trustLevel !== undefined) next.trustLevel = "observe";
      if (input.scope !== undefined) next.scope = input.scope;
      if (Object.prototype.hasOwnProperty.call(input, "usageExpectation")) {
        next.usageExpectation = input.usageExpectation ?? undefined;
      }

      await this.setState(input.projectId, next);
      this.queueBoardRefresh(input.projectId);
      return this.toProjectCoordinatorState(next);
    });
  }

  /**
   * Whether the project's repository carries a recognized CI config. The
   * coordinator.project.* responses ship this so the setup sheet can say the
   * CI watch has nothing to poll (story 34); the PR poll itself runs either
   * way.
   */
  async resolveCiConfigured(projectId: string): Promise<boolean | undefined> {
    const project = await this.projectRegistry.get(projectId).catch(() => null);
    if (!project) return undefined;
    const rootPath = this.workspaceGitService
      ? await this.workspaceGitService
          .resolveRepoRoot(project.rootPath)
          .catch(() => project.rootPath)
      : project.rootPath;
    try {
      const workflows = await fs.readdir(path.join(rootPath, ".github", "workflows"));
      if (workflows.some((name) => !name.startsWith("."))) return true;
    } catch {
      // No .github/workflows directory.
    }
    for (const candidate of [".gitlab-ci.yml", "Jenkinsfile"]) {
      try {
        if ((await fs.stat(path.join(rootPath, candidate))).isFile()) return true;
      } catch {
        // Absent.
      }
    }
    try {
      if ((await fs.stat(path.join(rootPath, ".circleci", "config.yml"))).isFile()) return true;
    } catch {
      // Absent.
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // remember (MCP tool bridge)
  // -------------------------------------------------------------------------

  /**
   * Team memory write for the `remember` Paseo tool. The file lands in the
   * caller's own checkout under `.paseo/memory/` — `project.md` for
   * coordinators, `learned.md` for everyone else — and a Done row records it.
   * Personal layers arrive in a later milestone.
   */
  async remember(input: CoordinatorRememberInput): Promise<CoordinatorRememberResult> {
    if (input.scope !== "team") {
      throw new CoordinatorRequestError(
        `Memory scope "${input.scope}" is not supported yet; only 'team' is supported`,
      );
    }
    const caller = this.agentManager.getAgent(input.callerAgentId);
    if (!caller) {
      throw new CoordinatorRequestError(`Unknown caller agent: ${input.callerAgentId}`);
    }
    const coordinatorCaller = isCoordinatorAgent(caller);
    if (!coordinatorCaller && !isDelegatedAgent(caller)) {
      throw new CoordinatorRequestError(
        "remember is available to coordinators and delegated agents",
      );
    }
    const fileName = coordinatorCaller ? "project.md" : "learned.md";
    const filePath = path.join(caller.cwd, ".paseo", "memory", fileName);
    const content = input.content.replace(/\s+$/, "");
    if (content.length === 0) {
      throw new CoordinatorRequestError("remember content must not be empty");
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (input.mode === "replace") {
      await writeFileAtomic(filePath, `${content}\n`);
    } else {
      const existing = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      let separator = "\n\n";
      if (existing.length === 0 || existing.endsWith("\n\n")) {
        separator = "";
      }
      const heading = `## ${new Date().toISOString().slice(0, 10)}`;
      await writeFileAtomic(filePath, `${existing}${separator}${heading}\n\n${content}\n`);
    }

    const projectId = caller.workspaceId
      ? ((await this.workspaceRegistry.get(caller.workspaceId))?.projectId ?? null)
      : null;
    if (projectId) {
      await this.appendDoneRow(
        projectId,
        coordinatorCaller ? "Updated project memory" : "Noted in learned memory",
        { filePath, agentId: caller.id },
      );
    }
    return { filePath };
  }

  // -------------------------------------------------------------------------
  // Board
  // -------------------------------------------------------------------------

  subscribeBoard(listener: (snapshot: CoordinatorBoardSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listBoardSnapshots(projectId?: string): Promise<CoordinatorBoardSnapshot[]> {
    if (projectId !== undefined) {
      return [await this.buildBoardSnapshot(projectId)];
    }
    const projectIds = new Set<string>(await this.store.listProjectIds());
    for (const key of this.states.keys()) projectIds.add(key);
    const snapshots: CoordinatorBoardSnapshot[] = [];
    for (const id of projectIds) {
      snapshots.push(await this.buildBoardSnapshot(id));
    }
    return snapshots;
  }

  /** Test seam: build a snapshot without emitting. */
  async getBoardSnapshot(projectId: string): Promise<CoordinatorBoardSnapshot> {
    return this.buildBoardSnapshot(projectId);
  }

  /**
   * The daemon's `mcp.enabled` toggle can cut the agent MCP endpoint under a
   * resident coordinator — its required tools then 404 while the board still
   * reads enabled. Each availability edge writes a wake row on every enabled
   * project's board so the outage surfaces where the coordinator is watched.
   */
  async handleAgentMcpAvailability(
    available: boolean,
    flag: "mcp.enabled" | "mcp.injectIntoAgents" = "mcp.enabled",
  ): Promise<void> {
    const previous = this.agentMcpAvailable;
    if (previous === available) return;
    this.agentMcpAvailable = available;
    // Booting with the endpoint already on is the default, not a transition.
    let text: string | null = null;
    if (!available) {
      text = `Paseo tools are off (daemon ${flag}) — the coordinator's tools are unreachable until it is set`;
    } else if (previous === false) {
      text = "Paseo tools are back — the coordinator's tools are reachable again";
    }
    if (text === null) return;
    let storedProjectIds: string[] = [];
    try {
      storedProjectIds = await this.store.listProjectIds();
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to list coordinator projects for MCP availability");
    }
    const projectIds = new Set<string>(storedProjectIds);
    for (const projectId of this.states.keys()) projectIds.add(projectId);
    for (const projectId of projectIds) {
      try {
        const state = await this.getState(projectId);
        if (!state?.enabled) continue;
        await this.appendWakeRow(projectId, text, state.trustLevel);
      } catch (error) {
        this.logger.warn({ err: error, projectId }, "Failed to record MCP availability on board");
      }
    }
  }

  private async buildBoardSnapshot(projectId: string): Promise<CoordinatorBoardSnapshot> {
    const [state, board, project, workspaces] = await Promise.all([
      this.getState(projectId),
      this.getBoard(projectId),
      this.projectRegistry.get(projectId),
      this.workspaceRegistry.list(),
    ]);
    const scope = state?.scope ?? "everything";
    const trustLevel = state?.trustLevel ?? "observe";
    const enabled = state?.enabled ?? false;
    const liveCoordinator =
      enabled && state?.agentId ? this.agentManager.getAgent(state.agentId) : null;
    const coordinatorAgentId =
      liveCoordinator && liveCoordinator.lifecycle !== "closed" ? liveCoordinator.id : null;

    const workspaceIds = new Set(
      workspaces
        .filter((workspace) => workspace.projectId === projectId && !workspace.archivedAt)
        .map((workspace) => workspace.workspaceId),
    );
    const agents = this.agentManager.listAgents();
    const covered = agents
      .filter(
        (agent) =>
          agent.workspaceId !== undefined &&
          workspaceIds.has(agent.workspaceId) &&
          !isCoordinatorAgent(agent) &&
          agent.lifecycle !== "closed",
      )
      .filter((agent) => scope === "everything" || isDelegatedAgent(agent));

    // The coordinator's own pending permissions are board decisions — the
    // first-contact "here's what I think this project is" question is a
    // question-kind request on the coordinator itself. Needs you covers them
    // at any scope; Working keeps excluding the coordinator.
    const needsYouAgents = [
      ...covered,
      ...agents.filter(
        (agent) =>
          isCoordinatorAgent(agent) &&
          getCoordinatorProjectIdFromLabels(agent.labels) === projectId &&
          agent.lifecycle !== "closed",
      ),
    ];

    const needsYou = this.buildNeedsYouRows(projectId, needsYouAgents);
    const working = await this.buildWorkingRows(projectId, covered);
    const done = this.pruneDoneRows(board.done).slice(0, DONE_SNAPSHOT_LIMIT);
    return {
      projectId,
      ...(project ? { projectName: project.customName ?? project.displayName } : {}),
      needsYou,
      working,
      done,
      wake: board.wake,
      coordinatorAgentId,
      trustLevel,
      scope,
      enabled,
    };
  }

  private buildNeedsYouRows(
    projectId: string,
    covered: ManagedAgent[],
  ): CoordinatorDecisionBoardRow[] {
    const now = Date.now();
    const needsYou: CoordinatorDecisionBoardRow[] = [];
    for (const agent of covered) {
      for (const request of agent.pendingPermissions.values()) {
        const askedAt =
          request.requestedAt ??
          agent.permissionRequestedAt.get(request.id) ??
          new Date(now).toISOString();
        const questions = request.kind === "question" ? decisionQuestions(request) : null;
        const question = questions?.first ?? null;
        // Codex/OpenCode title their question requests literally "Question";
        // the actual text lives in input.questions[0].question.
        const questionText = question?.text ?? decisionQuestionText(request);
        this.knownDecisionQuestions.set(this.decisionKey(agent.id, request.id), questionText);
        // A tap answers question[0] only, so a request asking several questions
        // gets no actions — the client routes the row to the session's chat.
        const actions =
          questions && questions.count > 1 ? [] : decisionRowActions(request, question);
        needsYou.push({
          kind: "decision",
          id: `decision:${agent.id}:${request.id}`,
          projectId,
          agentId: agent.id,
          requestId: request.id,
          question: questionText,
          askedAt,
          ...(request.kind === "question" ? { requestKind: "question" } : {}),
          ...(question?.header ? { questionHeader: question.header } : {}),
          ...(questions && questions.count > 0 ? { questionCount: questions.count } : {}),
          ...(actions.some((action) => action.composerQuote === true)
            ? { quoteText: decisionQuoteText(request, question) }
            : {}),
          actions,
          waitingMs: Math.max(0, now - Date.parse(askedAt)),
        });
      }
    }
    needsYou.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
    return needsYou;
  }

  private async buildWorkingRows(
    projectId: string,
    covered: ManagedAgent[],
  ): Promise<CoordinatorWorkingBoardRow[]> {
    const working: CoordinatorWorkingBoardRow[] = [];
    for (const agent of covered) {
      if (agent.lifecycle === "closed" || agent.lifecycle === "error") continue;
      const yours = !isDelegatedAgent(agent);
      // A delegated agent at idle has finished its turn — it belongs in Done,
      // not Working. Your own sessions stay while their tab is open.
      if (agent.lifecycle === "idle" && !yours) continue;
      working.push({
        kind: "working",
        id: `working:${agent.id}`,
        projectId,
        agentId: agent.id,
        goal: await this.goalForAgent(agent),
        startedAt: agent.createdAt.toISOString(),
        provider: agent.provider,
        yours,
      });
    }
    working.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return working;
  }

  private queueBoardRefresh(projectId: string): void {
    if (this.stopped) return;
    this.dirtyBoards.add(projectId);
    if (this.boardFlushScheduled) return;
    this.boardFlushScheduled = true;
    setImmediate(() => {
      this.boardFlushScheduled = false;
      const pending = [...this.dirtyBoards];
      this.dirtyBoards.clear();
      for (const id of pending) {
        void this.refreshBoard(id).catch((error) =>
          this.logger.warn({ err: error, projectId: id }, "Coordinator board refresh failed"),
        );
      }
    });
  }

  private async refreshBoard(projectId: string): Promise<void> {
    const snapshot = await this.buildBoardSnapshot(projectId);
    const key = this.snapshotDiffKey(snapshot);
    if (this.emittedSnapshotKeys.get(projectId) === key) return;
    this.emittedSnapshotKeys.set(projectId, key);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.warn({ err: error, projectId }, "Coordinator board listener failed");
      }
    }
  }

  /** waitingMs drifts every rebuild; it is display-only and never a change. */
  private snapshotDiffKey(snapshot: CoordinatorBoardSnapshot): string {
    return JSON.stringify({
      ...snapshot,
      needsYou: snapshot.needsYou.map(({ waitingMs: _waitingMs, ...row }) => row),
    });
  }

  // -------------------------------------------------------------------------
  // Agent event observation
  // -------------------------------------------------------------------------

  private async onAgentEvent(event: AgentManagerEvent): Promise<void> {
    if (this.stopped) return;
    try {
      if (event.type === "agent_state") {
        await this.onAgentState(event.agent);
      } else if (event.type === "agent_stream") {
        await this.onAgentStream(event.agentId, event.event);
      }
    } catch (error) {
      this.logger.warn({ err: error, eventType: event.type }, "Coordinator event handling failed");
    }
  }

  private async onAgentState(agent: ManagedAgent): Promise<void> {
    const projectId = await this.projectIdForAgent(agent);
    const previous = this.agentCoverage.get(agent.id);
    const delegated = isDelegatedAgent(agent);
    const coordinator = isCoordinatorAgent(agent);
    const effectiveProjectId =
      projectId ?? previous?.projectId ?? getCoordinatorProjectIdFromLabels(agent.labels) ?? null;

    if (effectiveProjectId) {
      this.agentCoverage.set(agent.id, {
        projectId: effectiveProjectId,
        lifecycle: agent.lifecycle,
        delegated,
      });
      if (
        previous &&
        previous.projectId === effectiveProjectId &&
        previous.lifecycle === "running" &&
        delegated &&
        !coordinator
      ) {
        if (agent.lifecycle === "idle") {
          await this.appendDoneRow(
            effectiveProjectId,
            `Finished ${await this.goalForAgent(agent)}`,
            {
              agentId: agent.id,
            },
          );
        } else if (agent.lifecycle === "error") {
          await this.appendDoneRow(
            effectiveProjectId,
            `Errored ${await this.goalForAgent(agent)}`,
            { agentId: agent.id },
          );
        }
      }
      await this.maybeWakeForErroredAgent(agent, effectiveProjectId, previous, delegated);
      if (agent.lifecycle === "closed") {
        this.agentCoverage.delete(agent.id);
      }
      this.queueBoardRefresh(effectiveProjectId);
    }
    if (coordinator) {
      const coordinatorProjectId = getCoordinatorProjectIdFromLabels(agent.labels);
      if (coordinatorProjectId) this.queueBoardRefresh(coordinatorProjectId);
    }
  }

  /**
   * "Idle after an error" stall: a lifecycle error that arrives without a
   * turn_failed stream event (a failed resume, a provider-side crash) wakes
   * the coordinator too. The claim is shared with the lifecycle-bus path so
   * the pair wakes once.
   */
  private async maybeWakeForErroredAgent(
    agent: ManagedAgent,
    projectId: string,
    previous: CoordinatorCoverageEntry | undefined,
    delegated: boolean,
  ): Promise<void> {
    if (agent.lifecycle !== "error" || previous?.lifecycle === "error") return;
    if (isCoordinatorAgent(agent)) return;
    const state = await this.getState(projectId);
    if (!state?.enabled || (state.scope !== "everything" && !delegated)) return;
    if (this.erroredAgents.has(agent.id)) return;
    this.erroredAgents.add(agent.id);
    await this.wakeProjectCoordinator(projectId, {
      key: `error:${agent.id}`,
      reason: `Session errored: ${firstLine(agent.config.title ?? agent.id)}`,
      details: `Agent ${agent.id} (${agent.config.title ?? "untitled"}) in ${agent.cwd} is idle after an error: ${agent.lastError ?? "unknown error"}`,
    });
  }

  private async onAgentStream(agentId: string, event: AgentStreamEvent): Promise<void> {
    if (event.type === "permission_requested") {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent) return;
      // A coordinator's own request (its decision question) refreshes its
      // project board like any covered agent's; the label is authoritative
      // over workspace lookup.
      const projectId =
        getCoordinatorProjectIdFromLabels(agent.labels) ?? (await this.projectIdForAgent(agent));
      if (!projectId) return;
      this.knownDecisionQuestions.set(
        this.decisionKey(agentId, event.request.id),
        decisionQuestionText(event.request),
      );
      this.queueBoardRefresh(projectId);
      return;
    }
    if (event.type === "permission_resolved") {
      const coverage = this.agentCoverage.get(agentId);
      if (!coverage) return;
      const question = this.knownDecisionQuestions.get(this.decisionKey(agentId, event.requestId));
      this.knownDecisionQuestions.delete(this.decisionKey(agentId, event.requestId));
      await this.appendDoneRow(
        coverage.projectId,
        `Answered ${question ?? "a pending decision"}`,
        { agentId },
        `done:answered:${agentId}:${event.requestId}`,
      );
      this.queueBoardRefresh(coverage.projectId);
      return;
    }
    if (event.type === "turn_canceled") {
      const coverage = this.agentCoverage.get(agentId);
      if (!coverage?.delegated) return;
      const agent = this.agentManager.getAgent(agentId);
      const goal = agent ? await this.goalForAgent(agent) : agentId;
      await this.appendDoneRow(coverage.projectId, `Stopped ${goal}`, { agentId });
      this.queueBoardRefresh(coverage.projectId);
    }
  }

  private decisionKey(agentId: string, requestId: string): string {
    return `${agentId}:${requestId}`;
  }

  private async onWorkspaceMutation(mutation: WorkspaceMutation): Promise<void> {
    if (this.stopped) return;
    const projectId = mutation.workspace?.projectId;
    if (projectId) this.queueBoardRefresh(projectId);
    if (mutation.kind === "archive" || mutation.kind === "remove") {
      for (const [agentId, coverage] of this.agentCoverage) {
        const agent = this.agentManager.getAgent(agentId);
        if (agent?.workspaceId === mutation.workspaceId) {
          this.agentCoverage.delete(agentId);
          if (projectId) this.queueBoardRefresh(coverage.projectId);
        }
      }
    }
  }

  private async onProjectMutation(mutation: ProjectMutation): Promise<void> {
    if (this.stopped) return;
    // A project addition arrives here as kind "upsert" — that is where the
    // global coordinator's project-added wake belongs once the global
    // coordinator exists (spec wake sources). Today only the per-project
    // board refreshes; no wake is emitted for upserts.
    this.queueBoardRefresh(mutation.projectId);
    if (mutation.kind !== "archive" && mutation.kind !== "remove") return;
    this.changeRequestPoll?.untrackProject(mutation.projectId);
    this.pendingWakes.delete(mutation.projectId);
    const flushTimer = this.wakeFlushTimers.get(mutation.projectId);
    if (flushTimer) {
      clearTimeout(flushTimer);
      this.wakeFlushTimers.delete(mutation.projectId);
    }
    const state = await this.getState(mutation.projectId);
    if (state?.agentId) {
      await this.agentManager
        .archiveSnapshot(state.agentId, new Date().toISOString())
        .catch((error) =>
          this.logger.warn(
            { err: error, agentId: state.agentId, projectId: mutation.projectId },
            "Failed to archive coordinator for archived project",
          ),
        );
      if (this.agentManager.getAgent(state.agentId)?.lifecycle !== "closed") {
        await this.agentManager
          .closeAgent(state.agentId)
          .catch((error) =>
            this.logger.warn(
              { err: error, agentId: state.agentId, projectId: mutation.projectId },
              "Failed to close coordinator for archived project",
            ),
          );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wakes: envelope delivery, mid-turn queueing, and the stall sweep
  // -------------------------------------------------------------------------

  /**
   * Every wake source funnels here. One wake at a time per project behind the
   * project lock; a wake arriving while the coordinator is mid-turn queues and
   * flushes combined on `agent.turn_ended`, so a wake never interrupts or
   * races the coordinator's running turn.
   */
  async wakeProjectCoordinator(projectId: string, wake: CoordinatorWake): Promise<void> {
    await this.withProjectLock(projectId, async () => {
      if (this.stopped) return;
      const state = await this.getState(projectId);
      if (!state?.enabled || !state.agentId) return;
      const project = await this.projectRegistry.get(projectId).catch(() => null);
      if (!project || project.archivedAt) return;
      if (this.agentManager.hasInFlightRun(state.agentId)) {
        const queued = this.pendingWakes.get(projectId) ?? [];
        if (!queued.some((entry) => entry.key === wake.key)) {
          this.pendingWakes.set(projectId, [...queued, wake]);
        }
        return;
      }
      await this.deliverWake(projectId, state, project, wake);
    });
  }

  /**
   * Runs one change-request poll cycle for a project immediately, serialized
   * with its timer loop. Exists for tests and any later "refresh now" surface.
   */
  async runChangeRequestPollOnce(projectId: string): Promise<ChangeRequestPollOutcome | undefined> {
    return this.changeRequestPoll?.runOnce(projectId);
  }

  /**
   * The wake row lands before dispatch so the board shows the wake even when
   * prompt delivery fails (a wedged provider still leaves the row and the log).
   */
  private async deliverWake(
    projectId: string,
    state: PersistedProjectCoordinator,
    project: PersistedProjectRecord,
    wake: CoordinatorWake,
  ): Promise<void> {
    const agentId = state.agentId;
    if (!agentId) return;
    const changeRequests = this.changeRequestPoll
      ? await this.changeRequestPoll.lastSnapshot(projectId).catch(() => null)
      : null;
    // Envelope failure must not eat the wake — the poll hash is already
    // persisted, so a lost delivery here never re-fires. Fall back to the
    // identity lines and let the coordinator re-derive context itself.
    const envelope = await composeWakeEnvelope({
      projectId,
      projectName: project.customName ?? project.displayName,
      rootPath: project.rootPath,
      paseoHome: this.paseoHome,
      trustLevel: state.trustLevel,
      scope: state.scope,
      ...(state.usageExpectation ? { usageExpectation: state.usageExpectation } : {}),
      usage: this.readUsageSafely(projectId),
      changeRequests,
    }).catch((error: unknown) => {
      this.logger.warn(
        { err: error, projectId },
        "Wake envelope composition failed; delivering identity only",
      );
      return `<wake-context>\nProject: ${projectId}\nTrust: ${state.trustLevel} · Scope: ${state.scope}\n</wake-context>`;
    });
    await this.appendWakeRow(
      projectId,
      `Woke: ${wake.reason} · Level: ${capitalizeTrust(state.trustLevel)}`,
      state.trustLevel,
    );
    const prompt = formatSystemNotificationPrompt(
      [`Wake: ${wake.reason}`, ...(wake.details ? [wake.details] : []), envelope].join("\n\n"),
    );
    try {
      await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt,
        // Delivery steers an in-flight turn rather than replacing it; with the
        // queue above this fires only when the run record lags turn_ended.
        activeTurnBehavior: "steer",
        replaceRunning: false,
        logger: this.logger,
      });
    } catch (error) {
      this.logger.warn({ err: error, projectId, agentId }, "Failed to deliver coordinator wake");
    }
  }

  /**
   * Releases queued wakes as one combined prompt once the coordinator's turn
   * ends. `hasInFlightRun` can still report busy a hair after `turn_ended`
   * lands (the run record outlives the event), so a still-busy flush retries
   * once shortly rather than stranding the queue.
   */
  private async flushPendingWakes(projectId: string): Promise<void> {
    const queued = this.pendingWakes.get(projectId);
    if (!queued || queued.length === 0) return;
    const state = await this.getState(projectId);
    if (state?.agentId && this.agentManager.hasInFlightRun(state.agentId)) {
      if (!this.stopped && !this.wakeFlushTimers.has(projectId)) {
        this.wakeFlushTimers.set(
          projectId,
          setTimeout(() => {
            this.wakeFlushTimers.delete(projectId);
            void this.flushPendingWakes(projectId);
          }, 250),
        );
      }
      return;
    }
    this.pendingWakes.delete(projectId);
    const combined: CoordinatorWake =
      queued.length === 1
        ? queued[0]
        : {
            key: queued.map((entry) => entry.key).join("+"),
            reason: `${queued.length} updates while mid-turn`,
            details: queued
              .map((entry) => `- ${entry.reason}${entry.details ? `\n${entry.details}` : ""}`)
              .join("\n\n"),
          };
    await this.wakeProjectCoordinator(projectId, combined);
  }

  private subscribeLifecycleBus(): void {
    const bus = this.lifecycleBus;
    if (!bus) return;
    this.unsubscribers.push(
      bus.on("agent.turn_ended", (event) => {
        void this.onLifecycleTurnEnded(event);
      }),
      bus.on("agent.turn_started", (event) => {
        this.erroredAgents.delete(event.agent.id);
      }),
      bus.on("agent.archived", (event) => {
        this.onLifecycleAgentArchived(event.agent.id);
      }),
    );
  }

  /**
   * Two jobs on one event: a covered session whose turn failed is the spec's
   * "idle after an error" stall, and a coordinator ending a turn releases the
   * wakes queued while it ran.
   */
  private async onLifecycleTurnEnded(
    event: PluginLifecycleEvents["agent.turn_ended"],
  ): Promise<void> {
    if (this.stopped) return;
    try {
      if (event.outcome.kind !== "failed") {
        this.erroredAgents.delete(event.agent.id);
      }
      const managed = this.agentManager.getAgent(event.agent.id);
      if (managed && isCoordinatorAgent(managed)) {
        const projectId = getCoordinatorProjectIdFromLabels(managed.labels);
        if (projectId) await this.flushPendingWakes(projectId);
        return;
      }
      if (event.outcome.kind !== "failed") {
        return;
      }
      const projectId = await this.projectIdForHookAgent(event.agent);
      if (!projectId) return;
      const state = await this.getState(projectId);
      if (!state?.enabled) return;
      // Scope mirrors board coverage: `project` sees delegated sessions only.
      if (state.scope !== "everything" && event.agent.parentAgentId === null) return;
      // Check-and-claim stays synchronous so the agent_state error path can't
      // slip a second wake between this check and the set.
      if (this.erroredAgents.has(event.agent.id)) return;
      this.erroredAgents.add(event.agent.id);
      await this.wakeProjectCoordinator(projectId, {
        key: `error:${event.agent.id}`,
        reason: `Session errored: ${firstLine(event.agent.title ?? event.agent.id)}`,
        details: `Agent ${event.agent.id} (${event.agent.title ?? "untitled"}) ended a turn with an error: ${event.outcome.error.message}`,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: event.agent.id },
        "Coordinator turn_ended handling failed",
      );
    }
  }

  private onLifecycleAgentArchived(agentId: string): void {
    this.erroredAgents.delete(agentId);
    const prefix = `stall:${agentId}:`;
    for (const key of this.stalledWakeKeys) {
      if (key.startsWith(prefix)) this.stalledWakeKeys.delete(key);
    }
  }

  private async projectIdForHookAgent(agent: PluginHookAgent): Promise<string | null> {
    if (!agent.workspaceId) return null;
    const workspace = await this.workspaceRegistry.get(agent.workspaceId).catch(() => null);
    return workspace && !workspace.archivedAt ? workspace.projectId : null;
  }

  /** Usage actuals are enrichment, never worth losing a wake over. */
  private readUsageSafely(projectId: string): CoordinatorUsage | null {
    try {
      return this.readProjectUsage?.(projectId) ?? null;
    } catch (error) {
      this.logger.warn({ err: error, projectId }, "Project usage read failed");
      return null;
    }
  }

  private startStallSweep(): void {
    if (this.stallSweepTimer) return;
    this.stallSweepTimer = setInterval(() => {
      void this.sweepStalledSessions().catch((error) =>
        this.logger.warn({ err: error }, "Coordinator stall sweep failed"),
      );
    }, this.stallSweepIntervalMs);
    this.stallSweepTimer.unref?.();
  }

  /**
   * One pass of the spec's 30-minute stall rule: a covered session holding a
   * permission request older than the threshold wakes its coordinator once.
   * The sweep reads live permission state rather than tracking event history,
   * so a request resolved between sweeps never wakes. Stall keys are
   * in-memory, so a still-pending request wakes once more after a daemon
   * restart — correct, since the stall is still real.
   */
  async sweepStalledSessions(): Promise<void> {
    if (this.stopped) return;
    const nowMs = this.now();
    const liveStallKeys = new Set<string>();
    for (const agent of this.agentManager.listAgents()) {
      if (agent.lifecycle === "closed" || agent.pendingPermissions.size === 0) continue;
      // A coordinator's own pending request is a question to the user; waking
      // the coordinator about it could never answer it.
      if (isCoordinatorAgent(agent)) continue;
      const projectId = await this.projectIdForAgent(agent).catch(() => null);
      if (!projectId) continue;
      const state = await this.getState(projectId);
      if (!state?.enabled) continue;
      if (state.scope !== "everything" && !isDelegatedAgent(agent)) continue;
      for (const request of agent.pendingPermissions.values()) {
        const askedAt = request.requestedAt ?? agent.permissionRequestedAt.get(request.id);
        const askedMs = askedAt ? Date.parse(askedAt) : Number.NaN;
        if (!Number.isFinite(askedMs) || nowMs - askedMs < this.stallThresholdMs) continue;
        const key = `stall:${agent.id}:${request.id}`;
        liveStallKeys.add(key);
        if (this.stalledWakeKeys.has(key)) continue;
        this.stalledWakeKeys.add(key);
        const waitedMin = Math.max(1, Math.round((nowMs - askedMs) / 60_000));
        const goal = await this.goalForAgent(agent).catch(() => agent.id);
        await this.wakeProjectCoordinator(projectId, {
          key,
          reason: `Stalled session: ${goal} has waited on a permission for ${waitedMin}m`,
          details: `Agent ${agent.id} in ${agent.cwd} is waiting on "${decisionQuestionText(request)}" (request ${request.id}).`,
        });
      }
    }
    // Resolved or out-of-coverage requests drop their stall key, so a request
    // that stalls again later wakes again instead of staying silenced.
    for (const key of this.stalledWakeKeys) {
      if (!liveStallKeys.has(key)) this.stalledWakeKeys.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Change-request poll
  // -------------------------------------------------------------------------

  private async startChangeRequestPolling(): Promise<void> {
    const git = this.workspaceGitService;
    if (!git) return;
    const poll = new ChangeRequestPoll({
      resolveProjectRoot: async (projectId) => {
        const project = await this.projectRegistry.get(projectId).catch(() => null);
        if (!project || project.archivedAt) return null;
        // Poll the repository root, not the coordinator's checkout: every
        // workspace in the project shares one change-request list.
        return git.resolveRepoRoot(project.rootPath).catch(() => project.rootPath);
      },
      workspaceGitService: git,
      paseoHome: this.paseoHome,
      logger: this.logger,
      onChange: (projectId, change) => this.onChangeRequestDiff(projectId, change),
      ...(this.changeRequestPollIntervalMs !== undefined
        ? { intervalMs: this.changeRequestPollIntervalMs }
        : {}),
      now: this.now,
    });
    this.changeRequestPoll = poll;
    const projectIds = new Set<string>(await this.store.listProjectIds());
    for (const projectId of this.states.keys()) projectIds.add(projectId);
    for (const projectId of projectIds) {
      const state = await this.getState(projectId);
      if (state?.enabled) poll.trackProject(projectId);
    }
  }

  private async onChangeRequestDiff(
    projectId: string,
    change: ChangeRequestPollChange,
  ): Promise<void> {
    const lines = change.diffSummary.split("\n").filter((line) => line.trim().length > 0);
    const head = firstLine(change.diffSummary);
    const extra = lines.length - 1;
    await this.wakeProjectCoordinator(projectId, {
      key: `cr:${hashChangeRequestSnapshot(change.snapshot)}`,
      reason: extra > 0 ? `${head} (+${extra} more)` : head,
      details: change.diffSummary,
    });
  }

  // -------------------------------------------------------------------------
  // Startup reconciliation and singleton enforcement
  // -------------------------------------------------------------------------

  private async reconcileOnLoad(): Promise<void> {
    const records = await this.agentStorage.list();
    const projectIds = new Set<string>(await this.store.listProjectIds());
    for (const record of records) {
      if (record.archivedAt) continue;
      if (getCoordinatorRole(record.labels) !== COORDINATOR_PROJECT_ROLE) continue;
      const projectId = getCoordinatorProjectIdFromLabels(record.labels);
      if (projectId) projectIds.add(projectId);
    }
    for (const projectId of [...projectIds].sort()) {
      try {
        await this.reconcileProjectOnLoad(projectId, records);
      } catch (error) {
        this.logger.error(
          { err: error, projectId },
          "Failed to reconcile project coordinator on load",
        );
      }
    }
  }

  private async reconcileProjectOnLoad(
    projectId: string,
    records: StoredAgentRecord[],
  ): Promise<void> {
    const project = await this.projectRegistry.get(projectId);
    const projectActive = project !== null && !project.archivedAt;
    let state = await this.getState(projectId);
    const keeper = projectActive
      ? await this.resolveKeeper(
          projectId,
          state,
          records,
          "Retired a duplicate coordinator session",
        )
      : await this.archiveAllCoordinatorRecords(
          projectId,
          records,
          "Retired the coordinator for an archived project",
        );
    if (!state) {
      if (!keeper) return;
      // Crash between agent creation and state save: adopt the record so the
      // coordinator stays resident instead of becoming a stray labeled agent.
      const now = new Date().toISOString();
      state = {
        version: 1,
        projectId,
        agentId: keeper.id,
        enabled: projectActive,
        trustLevel: "observe",
        scope: "everything",
        createdAt: now,
        updatedAt: now,
      };
    } else if ((state.agentId ?? null) !== (keeper?.id ?? null)) {
      state = { ...state, agentId: keeper?.id ?? null, updatedAt: new Date().toISOString() };
    }
    await this.setState(projectId, state);
    if (state.enabled && state.agentId && projectActive) {
      await this.loadResidentCoordinator(projectId, state.agentId);
    }
  }

  /**
   * Startup loads race provider-account inspection (`busy` rejects a pinned
   * reserve mid-inspection), so residency retries a few times before warning.
   * A coordinator that still fails stays stored and reloads on the next wake
   * or enable rather than being dropped.
   */
  private async loadResidentCoordinator(projectId: string, agentId: string): Promise<void> {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.stopped) return;
      try {
        await ensureUnarchivedAgentLoaded(agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        });
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          this.logger.warn(
            { err: error, projectId, agentId },
            "Failed to load resident project coordinator",
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  /**
   * Picks the coordinator record to keep — the persisted state's agent when it
   * is still live, else the candidate with the latest activity — and archives
   * every other unarchived project-coordinator record.
   */
  private async resolveKeeper(
    projectId: string,
    state: PersistedProjectCoordinator | null,
    records: StoredAgentRecord[],
    retireReason: string,
  ): Promise<StoredAgentRecord | null> {
    const candidates = new Map<string, StoredAgentRecord>();
    for (const record of records) {
      if (!record.archivedAt && isProjectCoordinatorRecord(record, projectId)) {
        candidates.set(record.id, record);
      }
    }
    if (state?.agentId) {
      const stateRecord = records.find(
        (record) => record.id === state.agentId && !record.archivedAt,
      );
      if (stateRecord) candidates.set(stateRecord.id, stateRecord);
    }
    const keeper =
      (state?.agentId ? candidates.get(state.agentId) : undefined) ??
      [...candidates.values()].sort((a, b) => recordActivityMs(a) - recordActivityMs(b)).at(-1) ??
      null;
    for (const candidate of candidates.values()) {
      if (keeper && candidate.id === keeper.id) continue;
      const now = new Date().toISOString();
      await this.agentManager
        .archiveSnapshot(candidate.id, now)
        .catch((error) =>
          this.logger.warn(
            { err: error, agentId: candidate.id },
            "Failed to archive duplicate coordinator",
          ),
        );
      // archiveSnapshot only marks the record — a live duplicate session keeps
      // running without this close, which would break the one-session rule.
      if (this.agentManager.getAgent(candidate.id)?.lifecycle !== "closed") {
        await this.agentManager
          .closeAgent(candidate.id)
          .catch((error) =>
            this.logger.warn(
              { err: error, agentId: candidate.id },
              "Failed to close duplicate coordinator session",
            ),
          );
      }
      await this.appendDoneRow(projectId, retireReason, { agentId: candidate.id });
    }
    return keeper;
  }

  private coordinatorSessionConfig(
    project: PersistedProjectRecord,
    input: EnableProjectCoordinatorInput,
    workspace: PersistedWorkspaceRecord,
  ): AgentSessionConfig {
    return {
      provider: input.profile.provider,
      cwd: workspace.cwd,
      systemPrompt: buildProjectCoordinatorSystemPrompt(project.customName ?? project.displayName),
      delegateOnly: true,
      paseoTools: "required",
      title: COORDINATOR_TITLE,
      ...(input.profile.model ? { model: input.profile.model } : {}),
      ...(input.profile.modeId ? { modeId: input.profile.modeId } : {}),
      ...(input.profile.thinkingOptionId
        ? { thinkingOptionId: input.profile.thinkingOptionId }
        : {}),
      ...(input.profile.featureValues ? { featureValues: input.profile.featureValues } : {}),
      ...(input.profile.accountSelection
        ? { accountSelection: input.profile.accountSelection }
        : {}),
    };
  }

  private async retireProviderSwitch(
    projectId: string,
    keeper: StoredAgentRecord,
    now: string,
  ): Promise<void> {
    await this.agentManager
      .archiveSnapshot(keeper.id, now)
      .catch((error) =>
        this.logger.warn(
          { err: error, agentId: keeper.id },
          "Failed to archive coordinator after provider switch",
        ),
      );
    // archiveSnapshot only marks the record — a live coordinator session keeps
    // running without this close, which would break the one-session rule.
    if (this.agentManager.getAgent(keeper.id)?.lifecycle !== "closed") {
      await this.agentManager
        .closeAgent(keeper.id)
        .catch((error) =>
          this.logger.warn(
            { err: error, agentId: keeper.id },
            "Failed to close coordinator session after provider switch",
          ),
        );
    }
    await this.appendDoneRow(
      projectId,
      `Retired the ${keeper.provider} coordinator to switch providers`,
      { agentId: keeper.id },
    );
  }

  private async archiveAllCoordinatorRecords(
    projectId: string,
    records: StoredAgentRecord[],
    reason: string,
  ): Promise<StoredAgentRecord | null> {
    for (const record of records) {
      if (record.archivedAt || !isProjectCoordinatorRecord(record, projectId)) continue;
      const now = new Date().toISOString();
      await this.agentManager
        .archiveSnapshot(record.id, now)
        .catch((error) =>
          this.logger.warn({ err: error, agentId: record.id }, "Failed to archive coordinator"),
        );
      if (this.agentManager.getAgent(record.id)?.lifecycle !== "closed") {
        await this.agentManager
          .closeAgent(record.id)
          .catch((error) =>
            this.logger.warn(
              { err: error, agentId: record.id },
              "Failed to close coordinator session for archived project",
            ),
          );
      }
      await this.appendDoneRow(projectId, reason, { agentId: record.id });
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // State + board persistence
  // -------------------------------------------------------------------------

  private async getState(projectId: string): Promise<PersistedProjectCoordinator | null> {
    if (this.states.has(projectId)) return this.states.get(projectId) ?? null;
    const state = await this.store.loadState(projectId);
    this.states.set(projectId, state);
    return state;
  }

  private async setState(projectId: string, state: PersistedProjectCoordinator): Promise<void> {
    this.states.set(projectId, state);
    await this.store.saveState(projectId, state);
  }

  private async getBoard(projectId: string): Promise<PersistedCoordinatorBoard> {
    const cached = this.boards.get(projectId);
    if (cached) return cached;
    const board = await this.store.loadBoard(projectId);
    const pruned = { ...board, done: this.pruneDoneRows(board.done) };
    this.boards.set(projectId, pruned);
    return pruned;
  }

  private async saveBoard(projectId: string, board: PersistedCoordinatorBoard): Promise<void> {
    this.boards.set(projectId, board);
    await this.store.saveBoard(projectId, board);
  }

  private pruneDoneRows(rows: PersistedCoordinatorBoard["done"]): typeof rows {
    const cutoff = Date.now() - DONE_RETENTION_MS;
    return rows.filter((row) => {
      const at = Date.parse(row.at);
      return !Number.isFinite(at) || at >= cutoff;
    });
  }

  private async appendDoneRow(
    projectId: string,
    text: string,
    link?: { url?: string; agentId?: string; filePath?: string },
    deterministicId?: string,
  ): Promise<void> {
    // Serialized per project: concurrent appends each read-modify-write the
    // persisted done list, so without the lock the last write wins.
    await this.withBoardLock(projectId, async () => {
      const board = await this.getBoard(projectId);
      const id = deterministicId ?? `done:${randomUUID()}`;
      if (board.done.some((row) => row.id === id)) return;
      const row = {
        kind: "done" as const,
        id,
        projectId,
        text,
        at: new Date().toISOString(),
        ...(link ? { link } : {}),
      };
      const done = [row, ...this.pruneDoneRows(board.done)];
      await this.saveBoard(projectId, { ...board, done });
    });
    this.queueBoardRefresh(projectId);
  }

  private async appendWakeRow(
    projectId: string,
    text: string,
    level: CoordinatorTrustLevel = "observe",
  ): Promise<void> {
    await this.withBoardLock(projectId, async () => {
      const board = await this.getBoard(projectId);
      await this.saveBoard(projectId, {
        ...board,
        wake: {
          kind: "wake",
          id: `wake:${randomUUID()}`,
          projectId,
          text,
          level,
          at: new Date().toISOString(),
        },
      });
    });
    this.queueBoardRefresh(projectId);
  }

  private newState(projectId: string, now: string): PersistedProjectCoordinator {
    return {
      version: 1,
      projectId,
      agentId: null,
      enabled: false,
      trustLevel: "observe",
      scope: "everything",
      createdAt: now,
      updatedAt: now,
    };
  }

  private toProjectCoordinatorState(state: PersistedProjectCoordinator): ProjectCoordinatorState {
    const liveAgent = state.agentId ? this.agentManager.getAgent(state.agentId) : null;
    const agentId =
      state.enabled && liveAgent && liveAgent.lifecycle !== "closed" ? liveAgent.id : null;
    return {
      projectId: state.projectId,
      agentId,
      enabled: state.enabled,
      trustLevel: state.trustLevel,
      scope: state.scope,
      ...(state.profile ? { profile: state.profile } : {}),
      ...(state.profiles ? { profiles: state.profiles } : {}),
      ...(state.usageExpectation ? { usageExpectation: state.usageExpectation } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * `paseoTools: "required"` launches still need the daemon's agent MCP
   * endpoint to serve the tool catalog. Enabling without it would leave a
   * coordinator running with zero Paseo tools, so fail before creating it.
   */
  private assertAgentMcpEndpoint(paseoTools: AgentSessionConfig["paseoTools"]): void {
    if (paseoTools !== "required") return;
    if (this.agentManager.getAgentMcpBaseUrl() !== null) return;
    throw new CoordinatorRequestError(
      "The coordinator requires Paseo tools, but the daemon's agent MCP endpoint is disabled. Set mcp.enabled in the daemon config to run a coordinator.",
    );
  }

  private assertObserveTrust(trustLevel: CoordinatorTrustLevel | undefined): void {
    if (trustLevel !== undefined && trustLevel !== "observe") {
      throw new CoordinatorRequestError(
        `Trust level "${trustLevel}" is not supported yet; coordinators run at observe in this milestone`,
      );
    }
  }

  private async withProjectLock<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    return this.serialize(this.projectOps, projectId, run);
  }

  private async withBoardLock<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    return this.serialize(this.boardOps, projectId, run);
  }

  private serialize<T>(
    ops: Map<string, Promise<void>>,
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = ops.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    ops.set(key, tracked);
    void tracked.finally(() => {
      if (ops.get(key) === tracked) ops.delete(key);
    });
    return next;
  }

  private async projectIdForAgent(agent: ManagedAgent): Promise<string | null> {
    if (!agent.workspaceId) return null;
    const workspace = await this.workspaceRegistry.get(agent.workspaceId);
    return workspace && !workspace.archivedAt ? workspace.projectId : null;
  }

  private async resolveRootWorkspace(
    project: PersistedProjectRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const workspaces = await this.workspaceRegistry.list();
    const existing = workspaces.find(
      (workspace) =>
        workspace.projectId === project.projectId &&
        !workspace.archivedAt &&
        areEquivalentPaths(workspace.cwd, project.rootPath),
    );
    if (existing) return existing;
    return this.createWorkspaceForDirectory(project.rootPath, null, project.projectId);
  }

  private async goalForAgent(agent: ManagedAgent): Promise<string> {
    try {
      const timeline = this.agentManager.getTimeline(agent.id);
      const firstUser = timeline.find((item) => item.type === "user_message");
      if (firstUser && firstUser.type === "user_message") {
        const line = firstLine(firstUser.text);
        if (line.length > 0) return line;
      }
    } catch {
      // Timeline unavailable; fall through to the stored title.
    }
    const record = await this.agentStorage.get(agent.id).catch(() => null);
    if (record?.title && record.title.trim().length > 0) return firstLine(record.title);
    return firstLine(path.basename(agent.cwd)) || agent.id;
  }

  private async applyProfileToLiveCoordinator(
    agentId: string,
    profile: CoordinatorProfileSelection,
  ): Promise<void> {
    const agent = await ensureUnarchivedAgentLoaded(agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });
    if (profile.model !== undefined) {
      await this.agentManager.setAgentModel(agent.id, profile.model ?? null);
    }
    if (profile.modeId !== undefined) {
      await this.agentManager.setAgentMode(agent.id, profile.modeId);
    }
    if (profile.thinkingOptionId !== undefined) {
      await this.agentManager.setAgentThinkingOption(agent.id, profile.thinkingOptionId);
    }
    for (const [featureId, value] of Object.entries(profile.featureValues ?? {})) {
      await this.agentManager.setAgentFeature(agent.id, featureId, value);
    }
  }
}
