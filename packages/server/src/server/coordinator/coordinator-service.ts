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
  CoordinatorUsageExpectation,
  CoordinatorWorkingBoardRow,
  ProjectCoordinatorState,
} from "@getpaseo/protocol/messages";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
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

import {
  CoordinatorStore,
  type PersistedCoordinatorBoard,
  type PersistedProjectCoordinator,
} from "./persistence.js";
import {
  buildProjectCoordinatorFirstContactPrompt,
  buildProjectCoordinatorSystemPrompt,
} from "./prompts.js";

const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_SNAPSHOT_LIMIT = 20;
const COORDINATOR_TITLE = "Coordinator";

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

  private readonly states = new Map<string, PersistedProjectCoordinator | null>();
  private readonly boards = new Map<string, PersistedCoordinatorBoard>();
  private readonly listeners = new Set<(snapshot: CoordinatorBoardSnapshot) => void>();
  private readonly emittedSnapshotKeys = new Map<string, string>();
  private readonly projectOps = new Map<string, Promise<void>>();
  private readonly agentCoverage = new Map<string, CoordinatorCoverageEntry>();
  private readonly knownDecisionQuestions = new Map<string, string>();
  private readonly dirtyBoards = new Set<string>();
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
      let agentId = keeper?.id ?? null;
      if (keeper && keeper.provider !== input.profile.provider) {
        await this.agentManager
          .archiveSnapshot(keeper.id, now)
          .catch((error) =>
            this.logger.warn(
              { err: error, agentId: keeper.id },
              "Failed to archive coordinator before provider switch",
            ),
          );
        await this.appendDoneRow(
          input.projectId,
          `Retired the ${keeper.provider} coordinator to switch providers`,
          { agentId: keeper.id },
        );
        agentId = null;
      }

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

      if (!agentId) {
        const workspace = await this.resolveRootWorkspace(project);
        const config: AgentSessionConfig = {
          provider: input.profile.provider,
          cwd: workspace.cwd,
          systemPrompt: buildProjectCoordinatorSystemPrompt(
            project.customName ?? project.displayName,
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
        const agent = await this.agentManager.createAgent(config, undefined, {
          workspaceId: workspace.workspaceId,
          unattended: true,
          initialTitle: COORDINATOR_TITLE,
          labels: {
            [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
            [COORDINATOR_PROJECT_ID_LABEL]: input.projectId,
          },
        });
        state.agentId = agent.id;
        await this.appendWakeRow(
          input.projectId,
          `Woke: coordinator enabled · ${capitalizeTrust("observe")}`,
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
        `Memory scope "${input.scope}" is not supported yet; only team memory writes to .paseo/memory/`,
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
    const covered = this.agentManager
      .listAgents()
      .filter(
        (agent) =>
          agent.workspaceId !== undefined &&
          workspaceIds.has(agent.workspaceId) &&
          !isCoordinatorAgent(agent) &&
          agent.lifecycle !== "closed",
      )
      .filter((agent) => scope === "everything" || isDelegatedAgent(agent));

    const needsYou = this.buildNeedsYouRows(projectId, covered);
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
        this.knownDecisionQuestions.set(
          this.decisionKey(agent.id, request.id),
          decisionQuestionText(request),
        );
        needsYou.push({
          kind: "decision",
          id: `decision:${agent.id}:${request.id}`,
          projectId,
          agentId: agent.id,
          requestId: request.id,
          question: decisionQuestionText(request),
          askedAt,
          actions: (request.actions ?? []).map((action) => ({
            id: action.id,
            label: action.label,
          })),
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
    if (event.type === "permission_requested") {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent || isCoordinatorAgent(agent)) return;
      const projectId = await this.projectIdForAgent(agent);
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
        `done:answered:${event.requestId}`,
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
    this.queueBoardRefresh(projectId);
  }

  private async appendWakeRow(projectId: string, text: string): Promise<void> {
    const board = await this.getBoard(projectId);
    await this.saveBoard(projectId, {
      ...board,
      wake: {
        kind: "wake",
        id: `wake:${randomUUID()}`,
        projectId,
        text,
        level: "observe",
        at: new Date().toISOString(),
      },
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

  private assertObserveTrust(trustLevel: CoordinatorTrustLevel | undefined): void {
    if (trustLevel !== undefined && trustLevel !== "observe") {
      throw new CoordinatorRequestError(
        `Trust level "${trustLevel}" is not supported yet; coordinators run at observe in this milestone`,
      );
    }
  }

  private async withProjectLock<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.projectOps.get(projectId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.projectOps.set(projectId, tracked);
    void tracked.finally(() => {
      if (this.projectOps.get(projectId) === tracked) this.projectOps.delete(projectId);
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
