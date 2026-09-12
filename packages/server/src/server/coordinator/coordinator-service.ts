import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import {
  COORDINATOR_PROJECT_ID_LABEL,
  COORDINATOR_PROJECT_ROLE,
  COORDINATOR_SUBAGENT_KIND_LABEL,
  COORDINATOR_TRUST_LABEL,
  getCoordinatorProjectIdFromLabels,
  getCoordinatorRole,
  getCoordinatorSubagentKind,
  getParentAgentIdFromLabels,
  isCoordinatorAgent,
  isDelegatedAgent,
  PARENT_AGENT_ID_LABEL,
  PASEO_ROLE_LABEL,
  type CoordinatorSubagentKind,
} from "@getpaseo/protocol/agent-labels";
import type {
  CoordinatorBoardSnapshot,
  CoordinatorDecisionBoardRow,
  CoordinatorGuard,
  CoordinatorProfileSelection,
  CoordinatorProfiles,
  CoordinatorScope,
  CoordinatorTrustLevel,
  CoordinatorUsage,
  CoordinatorUsageExpectation,
  CoordinatorWorkingBoardRow,
  ProjectCoordinatorState,
} from "@getpaseo/protocol/messages";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import {
  collectAgentLineage,
  isAgentDescendantOf,
  nearestCoordinatorAncestor,
  type AgentLineageDeps,
} from "../agent/agent-lineage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentUsage,
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
import { isSameOrDescendantPath } from "../path-utils.js";
import { writeFileAtomic } from "../atomic-file.js";

import {
  CoordinatorStore,
  type PersistedCoordinatorBoard,
  type PersistedCoordinatorUsage,
  type PersistedProjectCoordinator,
} from "./persistence.js";
import {
  buildProjectCoordinatorFirstContactPrompt,
  buildProjectCoordinatorSystemPrompt,
} from "./prompts.js";
import { coordinatorSpawnEnv } from "./spawn-isolation.js";
import { coordinatorTrustAtLeast, coordinatorTrustLevelFromLabels } from "./tool-policy.js";

export { SPAWN_ISOLATION_ENV } from "./spawn-isolation.js";

const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_SNAPSHOT_LIMIT = 20;
const COORDINATOR_TITLE = "Coordinator";

/** Daemon defaults for the runaway guard; `guard` overrides per project. */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8;
export const DEFAULT_MAX_SPAWN_DEPTH = 2;

export interface CoordinatorSpawnDecision {
  /** Daemon-controlled labels the spawn must carry. */
  labels: Record<string, string>;
  /** Launch env the spawn must inherit. */
  env?: Record<string, string>;
  /**
   * "worktree" means the spawned agent must run in its own Paseo worktree —
   * Ship-and-above implementers write, and two of them in the coordinator's
   * checkout would collide. Create paths default a branch-off worktree when
   * the caller did not request one explicitly.
   */
  isolation?: "worktree";
  /**
   * Read-only subagent kinds (investigator, reviewer) must launch with the
   * provider-native delegate-only restrictions — no file edits, no shell —
   * so a Propose spawn cannot write no matter what mode the caller asked
   * for. Providers without a native mechanism reject the create.
   */
  delegateOnly?: boolean;
}

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
  /** Partial guard override; absent keys keep daemon defaults. */
  guard?: CoordinatorGuard;
}

export interface CoordinatorSpawnGateInput {
  parentAgentId: string;
  subagentKind?: CoordinatorSubagentKind;
  /** Legacy detached creation drops the parent label — it cannot evade the guard. */
  detached?: boolean;
}

interface CoordinatorUsageBucket {
  month: string;
  tokens: number;
  lastSeen: Map<string, number>;
  reported: Set<string>;
}

/**
 * How a provider's usage_updated readings relate to spend:
 * - "cumulative": the reading is a running total (codex thread totals, pi/omp
 *   session stats). Each event charges its diff against the last reading; a
 *   drop means the counter restarted (resume, new thread), so the new reading
 *   itself is the fresh spend.
 * - "perStep": the reading is that step's spend (opencode rewrites its
 *   per-step totals on every event). Each event counts whole, and the
 *   bucket's lastSeen tracks the running counted sum so a terminal turn total
 *   can only charge the uncounted remainder.
 * Providers absent from the table — claude, acp derivatives, custom ACP
 * providers — report spend only on terminal events; their mid-turn
 * usage_updated carries a context gauge with no token totals, which
 * usageTokenTotal filters out before the tracker sees it.
 */
type UsageReadingStyle = "cumulative" | "perStep";

const USAGE_READING_STYLE: Record<string, UsageReadingStyle> = {
  opencode: "perStep",
};

/**
 * Token meter bookkeeping per agent. The project bucket's `lastSeen` is the
 * baseline the next reading diffs against — persisted so a daemon restart
 * keeps the right baseline. `sawMidTurnUsage` is sticky on purpose: once an
 * agent reports token-bearing usage mid-turn, its terminal events carry
 * cumulative or stale totals that must be diffed, never counted whole —
 * codex re-attaches its last mid-turn reading to turn_completed, and a turn
 * that produced no fresh readings must not recharge the same spend.
 */
interface AgentUsageTracker {
  sawMidTurnUsage: boolean;
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

function resolveCoordinatorGuard(guard: CoordinatorGuard | undefined): {
  maxConcurrentSubagents: number;
  maxSpawnDepth: number;
} {
  return {
    maxConcurrentSubagents: guard?.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    maxSpawnDepth: guard?.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH,
  };
}

/**
 * Hard trust/kind rules for a spawn, checked before the runaway guard so a
 * forbidden spawn fails the same way regardless of fleet pressure.
 */
function assertSpawnTrustAndKind(
  trust: CoordinatorTrustLevel,
  input: CoordinatorSpawnGateInput,
): void {
  if (input.detached) {
    throw new CoordinatorRequestError(
      "Detached creation drops the lineage the coordinator's guard and ownership depend on — " +
        "spawn subagents, not detached agents, inside a coordinator project",
    );
  }
  if (trust === "observe") {
    throw new CoordinatorRequestError(
      "This coordinator runs at Observe trust — it cannot spawn agents. " +
        "Raise the trust level to Propose or above in the coordinator settings",
    );
  }
  if (trust === "propose") {
    if (!input.subagentKind) {
      throw new CoordinatorRequestError(
        "At Propose trust a coordinator may only spawn read-only subagents — " +
          'pass subagentKind "investigator" or "reviewer" to create_agent',
      );
    }
    if (input.subagentKind === "implementer") {
      throw new CoordinatorRequestError(
        'subagentKind "implementer" is a writing role — it unlocks at Ship trust',
      );
    }
  }
}

/**
 * The daemon-owned stamps a gated spawn carries: lineage labels the caller can
 * never set, the tree's launch env, worktree isolation for writing roles at
 * Ship and above, and delegate-only enforcement for read-only kinds.
 */
function spawnStamps(
  input: CoordinatorSpawnGateInput,
  projectId: string | null,
  trust: CoordinatorTrustLevel,
): CoordinatorSpawnDecision {
  const labels: Record<string, string> = {
    // Daemon-stamped lineage — caller labels can never set this, so the
    // ownership walk and the descendant cap always see the real parent.
    [PARENT_AGENT_ID_LABEL]: input.parentAgentId,
  };
  if (input.subagentKind) labels[COORDINATOR_SUBAGENT_KIND_LABEL] = input.subagentKind;
  if (projectId) labels[COORDINATOR_PROJECT_ID_LABEL] = projectId;
  const env = coordinatorSpawnEnv(trust);
  // Investigator and reviewer are the read-only roles at every trust level —
  // provider-native delegate-only enforcement, not the prompt, keeps a
  // Propose spawn from writing.
  const readOnly = input.subagentKind === "investigator" || input.subagentKind === "reviewer";
  // Writing descendants launch isolated: at Ship and above every spawn that
  // is not a read-only kind — including a kindless spawn — gets its own
  // worktree instead of editing the coordinator's checkout, where concurrent
  // workers would collide.
  const isolation =
    coordinatorTrustAtLeast(trust, "ship") && !readOnly ? ("worktree" as const) : undefined;
  return {
    labels,
    ...(env ? { env } : {}),
    ...(isolation ? { isolation } : {}),
    ...(readOnly ? { delegateOnly: true } : {}),
  };
}

/** UTC calendar month key — `YYYY-MM` — for the soft usage meter. */
function currentMonthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Billable total for the meter: input plus output. Cached tokens are left out —
 * providers disagree on whether they are disjoint (claude) or a subset of
 * input (codex), so counting them would double-charge some providers. Returns
 * undefined for gauge-only readings (context-window updates carry no totals).
 */
function usageTokenTotal(usage: AgentUsage): number | undefined {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/**
 * New spend implied by a cumulative reading. A counter that dropped means the
 * provider restarted its session counter — count the fresh reading whole so
 * the uncounted spend lands, and a stale completion can never recharge the
 * same spend.
 */
function cumulativeUsageDelta(total: number, last: number): number {
  if (total > last) return total - last;
  if (total < last) return total;
  return 0;
}

/**
 * Owns project-coordinator records, residency, singleton enforcement, and the
 * derived board. Coordinators are ordinary persisted agents marked with role
 * labels; this service never duplicates AgentManager lifecycle logic — it
 * creates, resumes, archives, and observes through the manager's public seams.
 *
 * Trust gates what a coordinator may do (tool-policy.ts), the spawn gate
 * enforces role kinds and the runaway guard before any workspace is minted,
 * and the board derives Needs you/Working rows from live agent state while
 * the service itself writes Wake and Done rows.
 */
export class CoordinatorService {
  private readonly store: CoordinatorStore;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: CoordinatorServiceDeps["projectRegistry"];
  private readonly workspaceRegistry: CoordinatorServiceDeps["workspaceRegistry"];
  private readonly createWorkspaceForDirectory: CoordinatorServiceDeps["createWorkspaceForDirectory"];
  private readonly logger: Logger;

  private readonly states = new Map<string, PersistedProjectCoordinator | null>();
  private readonly boards = new Map<string, PersistedCoordinatorBoard>();
  private readonly listeners = new Set<(snapshot: CoordinatorBoardSnapshot) => void>();
  private readonly emittedSnapshotKeys = new Map<string, string>();
  private readonly projectOps = new Map<string, Promise<void>>();
  private readonly boardOps = new Map<string, Promise<void>>();
  /** Serializes guard-check-plus-create per coordinator so concurrent spawns can't race the cap. */
  private readonly spawnOps = new Map<string, Promise<void>>();
  private readonly agentCoverage = new Map<string, CoordinatorCoverageEntry>();
  private readonly knownDecisionQuestions = new Map<string, string>();
  private readonly dirtyBoards = new Set<string>();
  private readonly usageRuntime = new Map<string, CoordinatorUsageBucket>();
  /** In-flight bucket loads — concurrent first events share one read. */
  private readonly usageBucketLoads = new Map<string, Promise<CoordinatorUsageBucket>>();
  private readonly pendingUsagePersist = new Set<string>();
  /** Per-agent token meter state; keyed by agent id, lives for the daemon run. */
  private readonly usageTrackers = new Map<string, AgentUsageTracker>();
  private readonly usageProjectByAgent = new Map<string, string | null>();
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
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to unsubscribe coordinator listener");
      }
    }
    for (const projectId of this.pendingUsagePersist) {
      // flushUsage deletes the entry it persists — deleting the current item
      // during Set iteration is safe and keeps the snapshot semantics.
      await this.flushUsage(projectId).catch((error) =>
        this.logger.warn({ err: error, projectId }, "Failed to persist coordinator usage"),
      );
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
    return this.withProjectLock(input.projectId, async () => {
      const project = await this.projectRegistry.get(input.projectId);
      if (!project) throw new CoordinatorRequestError(`Unknown project: ${input.projectId}`);
      if (project.archivedAt) {
        throw new CoordinatorRequestError(`Project is archived: ${input.projectId}`);
      }
      const scope = input.scope ?? "everything";
      const trustLevel = input.trustLevel ?? "observe";
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
        trustLevel,
        scope,
        profile: input.profile,
        profiles: input.profiles ?? state.profiles,
        updatedAt: now,
      };

      if (!agentId || replacingProvider) {
        const workspace = await this.resolveRootWorkspace(project);
        const config = this.coordinatorSessionConfig(
          project,
          { profile: input.profile, trustLevel },
          workspace,
        );
        this.assertAgentMcpEndpoint(config.paseoTools);
        // The replacement exists before the old coordinator retires: a failed
        // creation leaves the previous session untouched.
        const agent = await this.agentManager.createAgent(config, undefined, {
          workspaceId: workspace.workspaceId,
          unattended: true,
          initialTitle: COORDINATOR_TITLE,
          env: coordinatorSpawnEnv(trustLevel),
          labels: {
            [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
            [COORDINATOR_PROJECT_ID_LABEL]: input.projectId,
            [COORDINATOR_TRUST_LABEL]: trustLevel,
          },
        });
        if (replacingProvider && keeper) {
          await this.retireProviderSwitch(input.projectId, keeper, now);
        }
        state.agentId = agent.id;
        await this.appendWakeRow(
          input.projectId,
          `Woke: coordinator enabled · ${capitalizeTrust(trustLevel)}`,
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
              trustLevel,
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
        // The trust label is mirrored before the load so the tool gate and the
        // launch env both see the new level.
        await this.syncTrustLabel(agentId, trustLevel);
        const record = await this.agentStorage.get(agentId);
        this.assertAgentMcpEndpoint(record?.config?.paseoTools);
        await ensureUnarchivedAgentLoaded(agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        });
      }

      await this.setState(input.projectId, state);
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
      if (input.trustLevel !== undefined) next.trustLevel = input.trustLevel;
      if (input.scope !== undefined) next.scope = input.scope;
      if (input.guard !== undefined) next.guard = input.guard;
      if (Object.prototype.hasOwnProperty.call(input, "usageExpectation")) {
        next.usageExpectation = input.usageExpectation ?? undefined;
      }

      await this.setState(input.projectId, next);
      // Stepping down applies instantly: the tool gate reads the label on every
      // call, and the spawn guard reads the persisted state, so mirroring the
      // label here is what makes a lowered level take effect mid-session.
      if (input.trustLevel !== undefined && input.trustLevel !== state.trustLevel) {
        await this.syncTrustLabel(next.agentId, input.trustLevel);
        // The system prompt carries the level's rules ("you may NOT spawn") —
        // leave it stale and a raised coordinator keeps refusing the workflow
        // the label now permits.
        await this.syncTrustPrompt(next, input.trustLevel);
        await this.appendWakeRow(
          input.projectId,
          `Trust: now at ${capitalizeTrust(input.trustLevel)}`,
        );
      }
      this.queueBoardRefresh(input.projectId);
      return this.toProjectCoordinatorState(next);
    });
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
  // Spawn gate (create_agent bridge)
  // -------------------------------------------------------------------------

  /**
   * Read-only precheck for the MCP `create_agent` path, run before any
   * workspace or worktree is minted so a denied spawn leaves nothing behind.
   * `createAgentCommand` re-checks under the spawn lock via
   * `runCoordinatorSpawn`; callers without a coordinator ancestor get null and
   * spawn ungated.
   */
  async assertSpawnAllowed(
    input: CoordinatorSpawnGateInput,
  ): Promise<CoordinatorSpawnDecision | null> {
    const governing = await this.governingCoordinator(input.parentAgentId);
    if (!governing) return null;
    return this.spawnDecision(governing, input);
  }

  /**
   * The authoritative spawn gate: serializes check + create per coordinator so
   * two concurrent spawns cannot both see "7 of 8" and pass. The callback runs
   * inside the lock — resolve worktree/workspace resources there too, so a
   * denied spawn leaves nothing behind. The decision's labels and env are
   * daemon-controlled; merge them over caller-supplied values.
   */
  async runCoordinatorSpawn<T>(
    input: CoordinatorSpawnGateInput,
    create: (decision: CoordinatorSpawnDecision | null) => Promise<T>,
  ): Promise<T> {
    const governing = await this.governingCoordinator(input.parentAgentId);
    if (!governing) return create(null);
    const created = await this.serialize(this.spawnOps, governing.node.agentId, async () => {
      const decision = await this.spawnDecision(governing, input);
      return create(decision);
    });
    await this.reportSpawnExpectation(governing.node);
    return created;
  }

  /**
   * Resolves a subagent kind to the coordinator's configured launch bundle.
   * `profiles.fallback` covers kinds the project did not configure explicitly.
   */
  async resolveSubagentProfile(input: {
    callerAgentId: string;
    kind: CoordinatorSubagentKind;
  }): Promise<CoordinatorProfileSelection> {
    const governing = await this.governingCoordinator(input.callerAgentId);
    if (!governing) {
      throw new CoordinatorRequestError(
        "subagentKind applies only to spawns under a coordinator — omit it for ordinary agents",
      );
    }
    const projectId = getCoordinatorProjectIdFromLabels(governing.node.labels);
    const state = projectId ? await this.getState(projectId) : null;
    const profiles = state?.profiles ?? {};
    const profile = profiles[input.kind] ?? profiles["fallback"];
    if (!profile) {
      throw new CoordinatorRequestError(
        `The coordinator has no "${input.kind}" profile configured — ` +
          `set profiles.${input.kind} (or profiles.fallback) in the coordinator settings`,
      );
    }
    return profile;
  }

  /**
   * Ownership check for agent-targeting tools (`send_agent_prompt`,
   * `cancel_agent`, `respond_to_permission`, `update_agent`, `archive_agent`,
   * `kill_agent`). Callers outside any coordinator tree keep legacy behavior.
   * A coordinator caller steers its own descendants at any level; at Ship and
   * above it may also act on sessions inside its project's scope — the spec's
   * "act on your sessions within policy". A delegated caller under a
   * coordinator may act anywhere inside that coordinator's tree — its own
   * descendants, siblings, and the coordinator it reports to — but mutating
   * ops (`action: "mutate"`) may never target an ancestor: archiving or
   * reconfiguring a parent would let a child sever the lineage that governs
   * it.
   */
  async assertAgentTargetAllowed(
    callerAgentId: string,
    targetAgentId: string,
    options?: { action?: "steer" | "mutate" },
  ): Promise<void> {
    if (callerAgentId === targetAgentId) return;
    const deps = this.lineageDeps();
    const callerLineage = await collectAgentLineage(deps, callerAgentId);
    const caller = callerLineage[0];
    // An unknown caller fails later on its own terms (send/cancel lookups).
    if (!caller) return;
    const governingIndex = callerLineage.findIndex(
      (node) => getCoordinatorRole(node.labels) !== null,
    );
    if (governingIndex === -1) return;
    const governing = callerLineage[governingIndex];

    if (governingIndex !== 0) {
      // Mutating an ancestor severs the caller's own lineage: the archive
      // cascade would detach the child and drop it outside the boundary
      // entirely. Steering upward (prompts, cancels) stays allowed — a
      // delegated agent may report to the coordinator it rolls up to.
      if (
        options?.action === "mutate" &&
        callerLineage.slice(1).some((node) => node.agentId === targetAgentId)
      ) {
        throw new CoordinatorRequestError(
          "Delegated agents may not mutate their own ancestors — " +
            "delegation only flows downward",
        );
      }
      const targetLineage = await collectAgentLineage(deps, targetAgentId);
      if (!targetLineage.some((node) => node.agentId === governing.agentId)) {
        throw new CoordinatorRequestError(
          "Delegated agents may only act on sessions inside their coordinator's tree — " +
            "the target is outside that boundary",
        );
      }
      return;
    }

    if (await isAgentDescendantOf(deps, callerAgentId, targetAgentId)) return;

    const projectId = getCoordinatorProjectIdFromLabels(caller.labels);
    const state = projectId ? await this.getState(projectId) : null;
    const trust = state?.trustLevel ?? coordinatorTrustLevelFromLabels(caller.labels);
    if (
      projectId &&
      coordinatorTrustAtLeast(trust, "ship") &&
      (await this.isProjectScopeTarget({ projectId, state, targetAgentId }))
    ) {
      return;
    }
    throw new CoordinatorRequestError(
      coordinatorTrustAtLeast(trust, "ship")
        ? "Coordinators may only act on their own subagents or sessions inside this project's scope — the target is outside that boundary"
        : "Coordinators may only act on their own subagents; sessions outside the delegation tree need Ship trust and in-scope coverage",
    );
  }

  /**
   * Self-escalation check: a governed caller — the coordinator or anything in
   * its delegation tree — may not rewrite its own runtime settings or answer
   * its own permission requests. Settings changes could flip a read-only
   * profile's mode into a writing one, and permission authority sits with the
   * coordinator or the user, never with the session asking. Callers outside a
   * coordinator tree keep legacy self-mutation.
   */
  async assertSelfActionAllowed(callerAgentId: string, action: string): Promise<void> {
    const governing = await this.governingCoordinator(callerAgentId);
    if (!governing) return;
    throw new CoordinatorRequestError(
      `Agents inside a coordinator's delegation tree may not ${action} on themselves — ` +
        "that authority belongs to the coordinator above them or the user",
    );
  }

  /**
   * Ownership check for workspace-mutating tools (`archive_workspace`,
   * `rename_workspace`, script start/stop, terminal sends). A delegated
   * caller may only mutate its own workspace — archiving a foreign workspace
   * would take down agents the boundary check would never let it touch
   * directly. A coordinator caller may only mutate workspaces inside its own
   * project. Callers outside a coordinator tree are unaffected.
   */
  async assertWorkspaceTargetAllowed(callerAgentId: string, workspaceId: string): Promise<void> {
    const callerLineage = await collectAgentLineage(this.lineageDeps(), callerAgentId);
    const caller = callerLineage[0];
    if (!caller) return;
    const governingIndex = callerLineage.findIndex(
      (node) => getCoordinatorRole(node.labels) !== null,
    );
    if (governingIndex === -1) return;
    const governing = callerLineage[governingIndex];

    if (governingIndex === 0) {
      const projectId = getCoordinatorProjectIdFromLabels(governing.labels);
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (projectId && workspace && !workspace.archivedAt && workspace.projectId === projectId) {
        return;
      }
      throw new CoordinatorRequestError(
        "Coordinators may only act on workspaces inside their own project — " +
          "the target workspace is outside that boundary",
      );
    }

    const callerWorkspaceId =
      this.agentManager.getAgent(callerAgentId)?.workspaceId ??
      (await this.agentStorage.get(callerAgentId))?.workspaceId;
    if (callerWorkspaceId === undefined || callerWorkspaceId !== workspaceId) {
      throw new CoordinatorRequestError(
        "Delegated agents may only act on their own workspace — " +
          "the target workspace is outside the coordinator's boundary",
      );
    }
    // "Own workspace" is not enough when an ancestor shares it: read-only
    // kinds run in the coordinator's checkout, so archiving that workspace
    // would take the coordinator down with it.
    const ancestorIds = new Set(callerLineage.slice(1).map((node) => node.agentId));
    for (const ancestorId of ancestorIds) {
      const ancestorWorkspaceId =
        this.agentManager.getAgent(ancestorId)?.workspaceId ??
        (await this.agentStorage.get(ancestorId))?.workspaceId;
      if (ancestorWorkspaceId === workspaceId) {
        throw new CoordinatorRequestError(
          "Delegated agents may not mutate a workspace an ancestor occupies — " +
            "archiving it would take the coordinator down",
        );
      }
    }
  }

  /**
   * Cwd scoping for governed callers: a terminal or other cwd-bound resource
   * must live under the caller's own working directory, or the agent could
   * run commands inside a foreign checkout the agent boundary would never
   * let it touch directly. Callers outside a coordinator tree are unaffected.
   */
  async assertScopedCwdAllowed(callerAgentId: string, cwd: string): Promise<void> {
    const governing = await this.governingCoordinator(callerAgentId);
    if (!governing) return;
    const callerCwd =
      this.agentManager.getAgent(callerAgentId)?.cwd ??
      (await this.agentStorage.get(callerAgentId))?.cwd;
    if (callerCwd && isSameOrDescendantPath(callerCwd, cwd)) return;
    throw new CoordinatorRequestError(
      "Agents inside a coordinator's delegation tree may only bind cwd-scoped " +
        "resources under their own working directory",
    );
  }

  /**
   * Terminals are a shell. Read-only governed agents — the coordinator itself
   * and the investigator/reviewer kinds it spawns delegate-only — may not
   * create, feed, capture, or kill one: a terminal would hand a read-only
   * role full write access the provider-native restrictions exist to deny.
   * Writing roles and ungoverned callers are unaffected.
   */
  async assertTerminalAccessAllowed(callerAgentId: string): Promise<void> {
    const governing = await this.governingCoordinator(callerAgentId);
    if (!governing) return;
    const agent =
      this.agentManager.getAgent(callerAgentId) ?? (await this.agentStorage.get(callerAgentId));
    const kind = getCoordinatorSubagentKind(agent?.labels ?? null);
    const readOnly =
      agent?.config?.delegateOnly === true || kind === "investigator" || kind === "reviewer";
    if (readOnly) {
      throw new CoordinatorRequestError(
        "Read-only sessions inside a coordinator's delegation tree may not use " +
          "terminals — a shell would bypass the role's write restrictions",
      );
    }
  }

  /**
   * Provisioning a workspace is a write. Read-only delegated kinds —
   * investigator and reviewer subagents — may not mint workspaces even inside
   * their own checkout, and the worktree variant reaches daemon-side setup
   * scripts outside the provider sandbox. The coordinator itself is exempt:
   * its trust-level allowlist already governs create_workspace, and Ship
   * coordinators legitimately mint workspaces for their tree. Ungoverned
   * callers are unaffected.
   */
  async assertWorkspaceCreateAllowed(callerAgentId: string): Promise<void> {
    const governing = await this.governingCoordinator(callerAgentId);
    if (!governing || governing.depth === 0) return;
    const agent =
      this.agentManager.getAgent(callerAgentId) ?? (await this.agentStorage.get(callerAgentId));
    const kind = getCoordinatorSubagentKind(agent?.labels ?? null);
    if (kind === "investigator" || kind === "reviewer") {
      throw new CoordinatorRequestError(
        "Read-only subagents may not create workspaces — " +
          "provisioning is a write the investigator/reviewer role denies",
      );
    }
  }

  /**
   * Schedule authority never delegates: coordinators hold no schedule tools at
   * any trust level, and a governed child creating one would mint agents
   * outside the delegation tree — past the spawn guard entirely. Governed
   * callers are denied; callers outside a coordinator tree are unaffected.
   */
  async assertScheduleAccessAllowed(callerAgentId: string): Promise<void> {
    const governing = await this.governingCoordinator(callerAgentId);
    if (!governing) return;
    throw new CoordinatorRequestError(
      "Agents inside a coordinator's delegation tree may not create or modify " +
        "schedules — schedule authority stays with the user",
    );
  }

  /**
   * A governed caller minting a workspace may attach it only to the project
   * that governs it — a foreign projectId would plant the coordinator's
   * coverage (and board rows) inside another project's boundary.
   */
  async assertProjectScopeAllowed(callerAgentId: string, projectId: string): Promise<void> {
    const governing = await this.governingCoordinator(callerAgentId);
    if (!governing) return;
    const governingProjectId = getCoordinatorProjectIdFromLabels(governing.node.labels);
    if (governingProjectId && projectId === governingProjectId) return;
    throw new CoordinatorRequestError(
      "Agents inside a coordinator's delegation tree may only create workspaces " +
        "inside their own project",
    );
  }

  /**
   * Ship-and-above scope: a live target whose workspace sits in the
   * coordinator's project. "everything" scope covers every session in the
   * project; "project" scope covers only delegated (spawned) sessions.
   */
  private async isProjectScopeTarget(params: {
    projectId: string;
    state: PersistedProjectCoordinator | null;
    targetAgentId: string;
  }): Promise<boolean> {
    const target =
      this.agentManager.getAgent(params.targetAgentId) ??
      (await this.agentStorage.get(params.targetAgentId));
    const workspace = target?.workspaceId
      ? await this.workspaceRegistry.get(target.workspaceId)
      : null;
    if (!target || !workspace || workspace.projectId !== params.projectId || workspace.archivedAt) {
      return false;
    }
    const scope = params.state?.scope ?? "everything";
    if (scope === "everything") return true;
    return getParentAgentIdFromLabels(target.labels) !== null;
  }

  private lineageDeps(): AgentLineageDeps {
    return { agentManager: this.agentManager, agentStorage: this.agentStorage };
  }

  private async governingCoordinator(agentId: string) {
    return nearestCoordinatorAncestor(this.lineageDeps(), agentId);
  }

  /**
   * The trust/kind/guard decision for one spawn. `governing.depth` is the
   * spawner's hop distance from the nearest coordinator, so the would-be child
   * sits at `depth + 1` and the fan-out cap counts every live descendant.
   */
  private async spawnDecision(
    governing: { node: { agentId: string; labels: Record<string, string> }; depth: number },
    input: CoordinatorSpawnGateInput,
  ): Promise<CoordinatorSpawnDecision> {
    const projectId = getCoordinatorProjectIdFromLabels(governing.node.labels);
    const state = projectId ? await this.getState(projectId) : null;
    const trust = state?.trustLevel ?? coordinatorTrustLevelFromLabels(governing.node.labels);
    assertSpawnTrustAndKind(trust, input);
    await this.assertSpawnWithinGuard(
      governing.node.agentId,
      governing.depth,
      resolveCoordinatorGuard(state?.guard),
      projectId,
    );
    return spawnStamps(input, projectId, trust);
  }

  /**
   * Enforces the runaway guard: the would-be child's depth from the nearest
   * coordinator, then the count of in-flight descendants under it. Each trip
   * leaves a Wake row so the board shows why spawning stopped.
   */
  private async assertSpawnWithinGuard(
    coordinatorAgentId: string,
    parentDepth: number,
    guard: { maxConcurrentSubagents: number; maxSpawnDepth: number },
    projectId: string | null,
  ): Promise<void> {
    const childDepth = parentDepth + 1;
    if (childDepth > guard.maxSpawnDepth) {
      if (projectId) {
        await this.appendWakeRow(
          projectId,
          `Guard tripped: spawn refused at depth ${childDepth} (limit ${guard.maxSpawnDepth})`,
          `wake:guard:depth:${coordinatorAgentId}`,
        );
      }
      throw new CoordinatorRequestError(
        `Runaway guard: this spawn would sit at depth ${childDepth}, past the limit of ` +
          `${guard.maxSpawnDepth} — agents at the depth limit cannot spawn`,
      );
    }

    const live = await this.countInFlightDescendants(coordinatorAgentId);
    if (live >= guard.maxConcurrentSubagents) {
      if (projectId) {
        await this.appendWakeRow(
          projectId,
          `Guard tripped: spawn refused — ${live} subagents at the cap of ${guard.maxConcurrentSubagents}`,
          `wake:guard:concurrency:${coordinatorAgentId}`,
        );
      }
      throw new CoordinatorRequestError(
        `Runaway guard: ${live} subagents already run under this coordinator, at the cap of ` +
          `${guard.maxConcurrentSubagents} — in-flight subagents finish; wait for one before spawning more`,
      );
    }
  }

  /**
   * Only descendants with an active turn count toward the concurrency cap —
   * the cap bounds simultaneous work, not fleet size. An idle descendant
   * holds no running turn and can be re-prompted later; counting it anyway
   * would deadlock the coordinator once finished subagents fill the cap,
   * since coordinators have no tool to close them.
   */
  private async countInFlightDescendants(coordinatorAgentId: string): Promise<number> {
    const records = new Map((await this.agentStorage.list()).map((record) => [record.id, record]));
    const labelsOf = (agentId: string) =>
      this.agentManager.getAgent(agentId)?.labels ?? records.get(agentId)?.labels ?? null;
    let count = 0;
    for (const agent of this.agentManager.listAgents()) {
      if (agent.id === coordinatorAgentId) continue;
      // An in-flight run counts even while lifecycle still reads "idle" — the
      // gated create dispatches the initial turn under the lock, so the run is
      // registered before the lifecycle event lands.
      const inFlight =
        agent.lifecycle === "initializing" ||
        agent.lifecycle === "running" ||
        this.agentManager.hasInFlightRun(agent.id);
      if (!inFlight) continue;
      let current = getParentAgentIdFromLabels(agent.labels);
      let hops = 0;
      while (current && hops < 64) {
        if (current === coordinatorAgentId) {
          count += 1;
          break;
        }
        const parentLabels = labelsOf(current);
        current = parentLabels ? getParentAgentIdFromLabels(parentLabels) : null;
        hops += 1;
      }
    }
    return count;
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
        await this.appendWakeRow(projectId, text);
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
    const usage = state ? await this.currentUsage(state) : undefined;
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
      ...(usage ? { usage } : {}),
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
    // Token events arrive far more often than board changes; usage persists
    // piggybacked on the refresh tick instead of on every usage_updated.
    await this.flushUsage(projectId);
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

  private async onAgentStream(agentId: string, event: AgentStreamEvent): Promise<void> {
    if (
      event.type === "turn_started" ||
      event.type === "usage_updated" ||
      event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed"
    ) {
      await this.onUsageEvent(agentId, event);
    }
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

  // -------------------------------------------------------------------------
  // Usage meter
  // -------------------------------------------------------------------------

  /**
   * Feeds the monthly token meter from provider usage events. Readings carry
   * different semantics per provider (see USAGE_READING_STYLE): cumulative
   * counters diff against the persisted baseline, per-step readings count
   * whole, and terminal events count whole only for providers that report
   * spend exclusively at completion.
   */
  private async onUsageEvent(agentId: string, event: AgentStreamEvent): Promise<void> {
    const terminal =
      event.type === "turn_completed" ||
      event.type === "turn_canceled" ||
      event.type === "turn_failed";
    const usage = "usage" in event ? event.usage : undefined;
    const total = usage ? usageTokenTotal(usage) : undefined;
    if (total === undefined) return;
    const projectId = await this.usageProjectFor(agentId);
    if (!projectId) return;
    const bucket = await this.usageBucket(projectId);
    const style = USAGE_READING_STYLE[event.provider] ?? "cumulative";
    const tracker = this.usageTrackers.get(agentId) ?? { sawMidTurnUsage: false };
    this.usageTrackers.set(agentId, tracker);
    const last = bucket.lastSeen.get(agentId) ?? 0;
    let delta = 0;

    if (event.type === "usage_updated") {
      tracker.sawMidTurnUsage = true;
      if (style === "perStep") {
        delta = total;
        bucket.lastSeen.set(agentId, last + total);
      } else {
        delta = cumulativeUsageDelta(total, last);
        bucket.lastSeen.set(agentId, total);
      }
    } else if (terminal) {
      if (style === "perStep") {
        // A terminal total on a per-step provider charges only the spend no
        // step reading covered — lastSeen is the counted sum, not a reading.
        delta = Math.max(0, total - last);
      } else if (tracker.sawMidTurnUsage) {
        // The terminal total is cumulative for providers that report
        // mid-turn — possibly the exact reading already counted.
        delta = cumulativeUsageDelta(total, last);
        bucket.lastSeen.set(agentId, total);
      } else {
        // The provider reports spend only at completion (claude, acp) — the
        // reading is the whole turn's spend.
        delta = total;
        bucket.lastSeen.set(agentId, total);
      }
    }
    if (delta <= 0) return;
    const previousTokens = bucket.tokens;
    bucket.tokens += delta;
    this.pendingUsagePersist.add(projectId);
    await this.reportTokenExpectation(projectId, previousTokens, bucket.tokens);
    this.queueBoardRefresh(projectId);
  }

  /**
   * Which project's meter an agent's spend lands in: the coordinator's own
   * project for coordinator agents, else the governing coordinator's project
   * for anything inside its delegation tree. Agents outside any tree are not
   * metered. Resolved once — labels never move an agent between trees.
   */
  private async usageProjectFor(agentId: string): Promise<string | null> {
    const cached = this.usageProjectByAgent.get(agentId);
    if (cached !== undefined) return cached;
    let projectId: string | null = null;
    const labels =
      this.agentManager.getAgent(agentId)?.labels ??
      (await this.agentStorage.get(agentId))?.labels ??
      null;
    if (labels) {
      if (getCoordinatorRole(labels) !== null) {
        projectId = getCoordinatorProjectIdFromLabels(labels);
      } else {
        const governing = await this.governingCoordinator(agentId);
        projectId = governing ? getCoordinatorProjectIdFromLabels(governing.node.labels) : null;
      }
    }
    this.usageProjectByAgent.set(agentId, projectId);
    return projectId;
  }

  /**
   * The project's usage bucket for the current UTC month. Loads the persisted
   * counters once; on a month roll the token total resets but `lastSeen`
   * baselines carry over — a session counter does not reset with the calendar.
   */
  private async usageBucket(projectId: string): Promise<CoordinatorUsageBucket> {
    const month = currentMonthKey();
    const cached = this.usageRuntime.get(projectId);
    if (cached) {
      if (cached.month !== month) {
        cached.month = month;
        cached.tokens = 0;
        cached.reported.clear();
        this.pendingUsagePersist.add(projectId);
      }
      return cached;
    }
    // Two events can race the initial getState read; without a shared load
    // promise each would install its own bucket and one writer's readings and
    // baselines would silently drop.
    const inflight = this.usageBucketLoads.get(projectId);
    if (inflight) return inflight;
    const load = (async (): Promise<CoordinatorUsageBucket> => {
      const persisted = (await this.getState(projectId))?.usage;
      const bucket: CoordinatorUsageBucket = {
        month,
        tokens: persisted && persisted.month === month ? persisted.tokens : 0,
        lastSeen: new Map(
          Object.entries(persisted?.lastSeenTokensByAgent ?? {}).map(([id, value]) => [id, value]),
        ),
        reported: new Set(
          persisted && persisted.month === month ? persisted.reportedExpectations : [],
        ),
      };
      this.usageRuntime.set(projectId, bucket);
      return bucket;
    })();
    this.usageBucketLoads.set(projectId, load);
    try {
      return await load;
    } finally {
      if (this.usageBucketLoads.get(projectId) === load) {
        this.usageBucketLoads.delete(projectId);
      }
    }
  }

  /** Board-facing actuals: derived spawn count plus the metered token total. */
  private async currentUsage(state: PersistedProjectCoordinator): Promise<CoordinatorUsage> {
    const bucket = await this.usageBucket(state.projectId);
    return {
      monthlySpawns: state.agentId ? await this.countMonthlySpawns(state.agentId) : 0,
      monthlyTokens: Math.floor(bucket.tokens),
    };
  }

  /**
   * Descendants of the coordinator created inside the current UTC month.
   * Derived from stamped agent records, so the count self-heals across
   * restarts and never double-counts a resumed session.
   */
  private async countMonthlySpawns(coordinatorAgentId: string): Promise<number> {
    // The month key is UTC; without the Z suffix Date.parse would read this
    // as local time and shift the boundary by the host timezone offset.
    const monthStart = `${currentMonthKey()}-01T00:00:00Z`;
    const records = await this.agentStorage.list();
    const deps = this.lineageDeps();
    let count = 0;
    for (const record of records) {
      if (record.id === coordinatorAgentId) continue;
      const createdMs = Date.parse(record.createdAt);
      if (!Number.isFinite(createdMs) || createdMs < Date.parse(monthStart)) continue;
      if (await isAgentDescendantOf(deps, coordinatorAgentId, record.id)) count += 1;
    }
    return count;
  }

  private async reportTokenExpectation(
    projectId: string,
    previousTokens: number,
    newTokens: number,
  ): Promise<void> {
    const expected = (await this.getState(projectId))?.usageExpectation?.monthlyTokens;
    if (!expected || newTokens < expected || previousTokens >= expected) return;
    const bucket = await this.usageBucket(projectId);
    if (bucket.reported.has("tokens")) return;
    bucket.reported.add("tokens");
    this.pendingUsagePersist.add(projectId);
    await this.appendWakeRow(
      projectId,
      `Usage: ${Math.floor(newTokens).toLocaleString("en-US")} tokens this month crossed the ${expected.toLocaleString("en-US")} expectation`,
      `wake:usage:tokens:${currentMonthKey()}`,
    );
  }

  /** Runs after a gated spawn lands so the spawn meter's crossing writes its row. */
  private async reportSpawnExpectation(governingNode: {
    agentId: string;
    labels: Record<string, string>;
  }): Promise<void> {
    const projectId = getCoordinatorProjectIdFromLabels(governingNode.labels);
    if (!projectId) return;
    const expected = (await this.getState(projectId))?.usageExpectation?.monthlySpawns;
    if (!expected) return;
    const spawns = await this.countMonthlySpawns(governingNode.agentId);
    if (spawns < expected) return;
    const bucket = await this.usageBucket(projectId);
    if (bucket.reported.has("spawns")) return;
    bucket.reported.add("spawns");
    this.pendingUsagePersist.add(projectId);
    await this.appendWakeRow(
      projectId,
      `Usage: ${spawns} subagents this month crossed the ${expected} spawn expectation`,
      `wake:usage:spawns:${currentMonthKey()}`,
    );
  }

  private async flushUsage(projectId: string): Promise<void> {
    if (!this.pendingUsagePersist.delete(projectId)) return;
    // The read-modify-write must hold the project lock: a settings update
    // landing between getState and setState would otherwise lose its writes
    // to the stale snapshot this flush carries.
    await this.withProjectLock(projectId, async () => {
      const bucket = this.usageRuntime.get(projectId);
      const state = await this.getState(projectId);
      if (!bucket || !state) return;
      const usage: PersistedCoordinatorUsage = {
        month: bucket.month,
        tokens: Math.floor(bucket.tokens),
        lastSeenTokensByAgent: Object.fromEntries(bucket.lastSeen),
        reportedExpectations: [...bucket.reported] as Array<"spawns" | "tokens">,
      };
      await this.setState(projectId, { ...state, usage });
    });
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
    this.queueBoardRefresh(mutation.projectId);
    if (mutation.kind !== "archive" && mutation.kind !== "remove") return;
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
    if (state.agentId) {
      // Records written before the trust label existed (or drifted) get healed
      // so the tool gate and resume-time env derivation see the real level.
      await this.syncTrustLabel(state.agentId, state.trustLevel);
    }
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
    input: { profile: CoordinatorProfileSelection; trustLevel: CoordinatorTrustLevel },
    workspace: PersistedWorkspaceRecord,
  ): AgentSessionConfig {
    return {
      provider: input.profile.provider,
      cwd: workspace.cwd,
      systemPrompt: buildProjectCoordinatorSystemPrompt(
        project.customName ?? project.displayName,
        input.trustLevel,
      ),
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

  /**
   * `deterministicId` dedupes repeated wakes for the same condition: a guard
   * that keeps tripping must not churn the row's timestamp. Ordinary wakes
   * always refresh the row.
   */
  private async appendWakeRow(
    projectId: string,
    text: string,
    deterministicId?: string,
  ): Promise<void> {
    await this.withBoardLock(projectId, async () => {
      const board = await this.getBoard(projectId);
      const id = deterministicId ?? `wake:${randomUUID()}`;
      if (deterministicId && board.wake?.id === id) return;
      const level = (await this.getState(projectId))?.trustLevel ?? "observe";
      await this.saveBoard(projectId, {
        ...board,
        wake: {
          kind: "wake",
          id,
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
      ...(state.guard ? { guard: state.guard } : {}),
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

  /**
   * Mirrors the persisted trust level onto the coordinator's agent record.
   * `AgentManager.setLabels` only reaches live agents, so a stored record is
   * patched through storage directly — the label must be right before the next
   * resume derives launch env from it.
   */
  private async syncTrustLabel(
    agentId: string | null,
    trustLevel: CoordinatorTrustLevel,
  ): Promise<void> {
    if (!agentId) return;
    const live = this.agentManager.getAgent(agentId);
    if (live) {
      if (live.labels[COORDINATOR_TRUST_LABEL] !== trustLevel) {
        await this.agentManager.setLabels(agentId, { [COORDINATOR_TRUST_LABEL]: trustLevel });
      }
      return;
    }
    const record = await this.agentStorage.get(agentId);
    if (record && record.labels[COORDINATOR_TRUST_LABEL] !== trustLevel) {
      await this.agentStorage.upsert({
        ...record,
        labels: { ...record.labels, [COORDINATOR_TRUST_LABEL]: trustLevel },
      });
    }
  }

  /**
   * Rebuilds the coordinator's system prompt for the new trust level — the
   * prompt encodes the level's rules, so a label-only update would leave a
   * raised coordinator refusing to spawn. Writes the live config and the
   * stored record (which a resume launches from); a coordinator with no
   * record is left alone.
   */
  private async syncTrustPrompt(
    state: PersistedProjectCoordinator,
    trustLevel: CoordinatorTrustLevel,
  ): Promise<void> {
    if (!state.agentId) return;
    const project = await this.projectRegistry.get(state.projectId);
    if (!project) return;
    const systemPrompt = buildProjectCoordinatorSystemPrompt(
      project.customName ?? project.displayName,
      trustLevel,
    );
    try {
      await this.agentManager.setAgentSystemPrompt(state.agentId, systemPrompt);
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: state.agentId },
        "Failed to refresh coordinator prompt after trust change",
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
