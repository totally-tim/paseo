import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  COORDINATOR_PROJECT_ID_LABEL,
  COORDINATOR_PROJECT_ROLE,
  PARENT_AGENT_ID_LABEL,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { CoordinatorProfileSelection } from "@getpaseo/protocol/messages";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPermissionRequest,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectMutation,
  WorkspaceMutation,
} from "../workspace-registry.js";

import { CoordinatorRequestError, CoordinatorService } from "./coordinator-service.js";
import { CoordinatorToolDeniedError } from "./tool-policy.js";

const logger = createTestLogger();

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

class StubAgentSession implements AgentSession {
  readonly provider: AgentProvider;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  /** When true, startTurn emits turn_started and leaves the turn open. */
  holdTurn = false;

  constructor(private readonly config: AgentSessionConfig) {
    this.provider = config.provider;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(_prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const turnId = `turn-${randomUUID()}`;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
      if (!this.holdTurn) {
        this.push({ type: "turn_completed", provider: this.provider, turnId });
      }
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch {
        // event isolation matches the real providers
      }
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class StubAgentClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  readonly sessions: StubAgentSession[] = [];

  constructor(readonly provider: string) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new StubAgentSession(config);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(
    handle: { sessionId: string },
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const session = new StubAgentSession({
      provider: this.provider,
      cwd: overrides?.cwd ?? process.cwd(),
      ...overrides,
    });
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async isAvailable() {
    return true;
  }
}

class StubProjectRegistry {
  private readonly records = new Map<string, PersistedProjectRecord>();
  private readonly listeners = new Set<(mutation: ProjectMutation) => void>();

  add(record: PersistedProjectRecord): void {
    this.records.set(record.projectId, record);
  }

  async get(projectId: string): Promise<PersistedProjectRecord | null> {
    return this.records.get(projectId) ?? null;
  }

  async list(): Promise<PersistedProjectRecord[]> {
    return [...this.records.values()];
  }

  subscribeToMutations(listener: (mutation: ProjectMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(mutation: ProjectMutation): void {
    for (const listener of this.listeners) void listener(mutation);
  }
}

class StubWorkspaceRegistry {
  private readonly records = new Map<string, PersistedWorkspaceRecord>();
  private readonly listeners = new Set<(mutation: WorkspaceMutation) => void>();

  add(record: PersistedWorkspaceRecord): void {
    this.records.set(record.workspaceId, record);
  }

  async get(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    return this.records.get(workspaceId) ?? null;
  }

  async list(): Promise<PersistedWorkspaceRecord[]> {
    return [...this.records.values()];
  }

  subscribeToMutations(listener: (mutation: WorkspaceMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(mutation: WorkspaceMutation): void {
    for (const listener of this.listeners) void listener(mutation);
  }
}

function makeProject(projectId: string, rootPath: string): PersistedProjectRecord {
  const now = new Date().toISOString();
  return {
    projectId,
    rootPath,
    kind: "git",
    displayName: path.basename(rootPath),
    customName: null,
    group: null,
    customIconRevision: null,
    projectKey: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function makeWorkspace(
  workspaceId: string,
  projectId: string,
  cwd: string,
): PersistedWorkspaceRecord {
  const now = new Date().toISOString();
  return {
    workspaceId,
    projectId,
    cwd,
    kind: "local_checkout",
    displayName: path.basename(cwd),
    title: null,
    branch: null,
    worktreeRoot: cwd,
    baseBranch: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: cwd,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

interface Harness {
  root: string;
  paseoHome: string;
  projectDir: string;
  project: PersistedProjectRecord;
  workspace: PersistedWorkspaceRecord;
  projectRegistry: StubProjectRegistry;
  workspaceRegistry: StubWorkspaceRegistry;
  agentStorage: AgentStorage;
  client: StubAgentClient;
  agentManager: AgentManager;
  service: CoordinatorService;
}

const PROJECT_ID = "prj_test";
const CODEX_PROFILE: CoordinatorProfileSelection = { provider: "codex" };

function makeHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "coordinator-test-"));
  const paseoHome = path.join(root, "paseo-home");
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir, { recursive: true });

  const project = makeProject(PROJECT_ID, projectDir);
  const workspace = makeWorkspace("wks_root", PROJECT_ID, projectDir);
  const projectRegistry = new StubProjectRegistry();
  const workspaceRegistry = new StubWorkspaceRegistry();
  projectRegistry.add(project);
  workspaceRegistry.add(workspace);

  const agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);
  const client = new StubAgentClient("codex");
  const agentManager = new AgentManager({
    clients: { codex: client },
    registry: agentStorage,
    logger,
  });

  const service = new CoordinatorService({
    agentManager,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    createWorkspaceForDirectory: async (cwd, title, projectId) => {
      const record = makeWorkspace(`wks_${randomUUID().slice(0, 8)}`, projectId ?? PROJECT_ID, cwd);
      record.title = title ?? null;
      workspaceRegistry.add(record);
      return record;
    },
    paseoHome,
    logger,
  });

  return {
    root,
    paseoHome,
    projectDir,
    project,
    workspace,
    projectRegistry,
    workspaceRegistry,
    agentStorage,
    client,
    agentManager,
    service,
  };
}

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
});

afterEach(async () => {
  await harness.service.stop().catch(() => undefined);
  for (const agent of harness.agentManager.listAgents()) {
    await harness.agentManager.closeAgent(agent.id).catch(() => undefined);
  }
  rmSync(harness.root, { recursive: true, force: true });
});

/** Waits for the service's setImmediate board flush to run. */
async function flushBoard(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function enableInput(
  overrides?: Partial<Parameters<CoordinatorService["enableProjectCoordinator"]>[0]>,
) {
  return { projectId: PROJECT_ID, profile: CODEX_PROFILE, ...overrides };
}

describe("enableProjectCoordinator", () => {
  test("creates a labeled delegate-only coordinator agent and persists state", async () => {
    const state = await harness.service.enableProjectCoordinator(enableInput());

    expect(state.projectId).toBe(PROJECT_ID);
    expect(state.enabled).toBe(true);
    expect(state.trustLevel).toBe("observe");
    expect(state.scope).toBe("everything");
    expect(state.agentId).not.toBeNull();

    const agent = harness.agentManager.getAgent(state.agentId!);
    expect(agent).toBeDefined();
    expect(agent!.config.delegateOnly).toBe(true);
    expect(agent!.config.paseoTools).toBe("required");
    expect(agent!.labels[PASEO_ROLE_LABEL]).toBe(COORDINATOR_PROJECT_ROLE);
    expect(agent!.labels[COORDINATOR_PROJECT_ID_LABEL]).toBe(PROJECT_ID);
    expect(agent!.workspaceId).toBe(harness.workspace.workspaceId);
    expect(agent!.cwd).toBe(harness.projectDir);
  });

  test("reuses the live coordinator on a second enable", async () => {
    const first = await harness.service.enableProjectCoordinator(enableInput());
    const second = await harness.service.enableProjectCoordinator(enableInput());

    expect(second.agentId).toBe(first.agentId);
    const coordinators = (await harness.agentStorage.list()).filter(
      (record) => record.labels?.[PASEO_ROLE_LABEL] === COORDINATOR_PROJECT_ROLE,
    );
    expect(coordinators).toHaveLength(1);
  });

  test("rejects an unknown project", async () => {
    await expect(
      harness.service.enableProjectCoordinator(enableInput({ projectId: "prj_missing" })),
    ).rejects.toBeInstanceOf(CoordinatorRequestError);
  });

  test("rejects an archived project", async () => {
    harness.projectRegistry.add({ ...harness.project, archivedAt: new Date().toISOString() });
    await expect(harness.service.enableProjectCoordinator(enableInput())).rejects.toBeInstanceOf(
      CoordinatorRequestError,
    );
  });

  test("rejects trust levels above observe in this milestone", async () => {
    await expect(
      harness.service.enableProjectCoordinator(enableInput({ trustLevel: "propose" })),
    ).rejects.toThrow(/Trust level "propose"/);
  });

  test("creates the root workspace when none exists", async () => {
    const otherDir = path.join(harness.root, "other-project");
    mkdirSync(otherDir, { recursive: true });
    harness.projectRegistry.add(makeProject("prj_other", otherDir));

    const state = await harness.service.enableProjectCoordinator({
      projectId: "prj_other",
      profile: CODEX_PROFILE,
    });

    expect(state.agentId).not.toBeNull();
    const workspaces = await harness.workspaceRegistry.list();
    expect(workspaces.some((w) => w.projectId === "prj_other" && w.cwd === otherDir)).toBe(true);
  });
});

describe("get/disable/update", () => {
  test("get returns null before any configuration", async () => {
    expect(await harness.service.getProjectCoordinator(PROJECT_ID)).toBeNull();
  });

  test("disable keeps state but closes the session; re-enable resumes the same agent", async () => {
    const enabled = await harness.service.enableProjectCoordinator(enableInput());
    const disabled = await harness.service.disableProjectCoordinator(PROJECT_ID);

    expect(disabled?.enabled).toBe(false);
    expect(disabled?.agentId).toBeNull();

    const reenabled = await harness.service.enableProjectCoordinator(enableInput());
    expect(reenabled.agentId).toBe(enabled.agentId);
  });

  test("update changes scope and records usage expectation", async () => {
    await harness.service.enableProjectCoordinator(enableInput());
    const updated = await harness.service.updateProjectCoordinator({
      projectId: PROJECT_ID,
      scope: "project",
      usageExpectation: { monthlySpawns: 10 },
    });

    expect(updated?.scope).toBe("project");
    expect(updated?.usageExpectation?.monthlySpawns).toBe(10);

    const cleared = await harness.service.updateProjectCoordinator({
      projectId: PROJECT_ID,
      usageExpectation: null,
    });
    expect(cleared?.usageExpectation).toBeUndefined();
  });

  test("update rejects a provider switch while the coordinator lives", async () => {
    await harness.service.enableProjectCoordinator(enableInput());
    await expect(
      harness.service.updateProjectCoordinator({
        projectId: PROJECT_ID,
        profile: { provider: "claude" },
      }),
    ).rejects.toThrow(/provider is fixed/);
  });

  test("update returns null for an unconfigured project", async () => {
    expect(
      await harness.service.updateProjectCoordinator({ projectId: PROJECT_ID, scope: "project" }),
    ).toBeNull();
  });
});

describe("singleton enforcement", () => {
  test("enable archives duplicate coordinator records for the project", async () => {
    const first = await harness.service.enableProjectCoordinator(enableInput());

    // Simulate a crash-created duplicate: a second record with coordinator labels.
    const dup = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir },
      undefined,
      {
        workspaceId: harness.workspace.workspaceId,
        labels: {
          [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
          [COORDINATOR_PROJECT_ID_LABEL]: PROJECT_ID,
        },
      },
    );

    const state = await harness.service.enableProjectCoordinator(enableInput());
    expect(state.agentId).toBe(first.agentId);
    expect((await harness.agentStorage.get(dup.id))?.archivedAt).toBeTruthy();
    // The duplicate's live session is closed, not just archived on disk.
    const dupAgent = harness.agentManager.getAgent(dup.id);
    expect(dupAgent == null || dupAgent.lifecycle === "closed").toBe(true);
  });

  test("start() reconciles duplicates on disk and keeps the newest", async () => {
    const keep = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir },
      undefined,
      {
        workspaceId: harness.workspace.workspaceId,
        labels: {
          [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
          [COORDINATOR_PROJECT_ID_LABEL]: PROJECT_ID,
        },
      },
    );
    const dup = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir },
      undefined,
      {
        workspaceId: harness.workspace.workspaceId,
        labels: {
          [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
          [COORDINATOR_PROJECT_ID_LABEL]: PROJECT_ID,
        },
      },
    );
    // Make the first record look older so the newer duplicate wins the keep.
    const keepRecord = await harness.agentStorage.get(keep.id);
    await harness.agentStorage.upsert({
      ...keepRecord!,
      lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await harness.service.start();

    expect((await harness.agentStorage.get(keep.id))?.archivedAt).toBeTruthy();
    expect((await harness.agentStorage.get(dup.id))?.archivedAt ?? null).toBeNull();
    const state = await harness.service.getProjectCoordinator(PROJECT_ID);
    expect(state?.agentId).toBe(dup.id);
  });
});

describe("residency across restart", () => {
  test("start() reloads an enabled coordinator from stored state", async () => {
    const enabled = await harness.service.enableProjectCoordinator(enableInput());
    await harness.service.stop();
    for (const agent of harness.agentManager.listAgents()) {
      await harness.agentManager.closeAgent(agent.id).catch(() => undefined);
    }

    // A "restarted daemon": fresh manager and service over the same storage.
    const client2 = new StubAgentClient("codex");
    const agentManager2 = new AgentManager({
      clients: { codex: client2 },
      registry: harness.agentStorage,
      logger,
    });
    const service2 = new CoordinatorService({
      agentManager: agentManager2,
      agentStorage: harness.agentStorage,
      projectRegistry: harness.projectRegistry,
      workspaceRegistry: harness.workspaceRegistry,
      createWorkspaceForDirectory: async () => harness.workspace,
      paseoHome: harness.paseoHome,
      logger,
    });

    try {
      await service2.start();
      const resident = agentManager2.getAgent(enabled.agentId!);
      expect(resident).toBeDefined();
      expect(resident!.lifecycle).not.toBe("closed");

      const state = await service2.getProjectCoordinator(PROJECT_ID);
      expect(state?.enabled).toBe(true);
      expect(state?.agentId).toBe(enabled.agentId);
    } finally {
      await service2.stop();
      for (const agent of agentManager2.listAgents()) {
        await agentManager2.closeAgent(agent.id).catch(() => undefined);
      }
    }
  });
});

describe("board derivation", () => {
  test("snapshot exposes enable state, wake row, and coordinator agent", async () => {
    const state = await harness.service.enableProjectCoordinator(enableInput());
    const snapshot = await harness.service.getBoardSnapshot(PROJECT_ID);

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.trustLevel).toBe("observe");
    expect(snapshot.projectId).toBe(PROJECT_ID);
    expect(snapshot.projectName).toBe(harness.project.displayName);
    expect(snapshot.coordinatorAgentId).toBe(state.agentId);
    expect(snapshot.wake?.text).toContain("Woke: coordinator enabled");
    // The coordinator itself never appears in Working.
    expect(snapshot.working.some((row) => row.agentId === state.agentId)).toBe(false);
  });

  test("a covered agent's pending permission becomes a Needs you row and resolves to Done", async () => {
    await harness.service.enableProjectCoordinator(enableInput());
    await harness.service.start();

    await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir, title: "Fix the bug" },
      undefined,
      { workspaceId: harness.workspace.workspaceId },
    );
    const session = harness.client.sessions.at(-1)!;
    const request: AgentPermissionRequest = {
      id: "perm-1",
      provider: "codex",
      name: "Bash",
      kind: "tool",
      title: "Run npm test?",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    };
    session.push({ type: "permission_requested", provider: "codex", request });
    await flushBoard();

    let snapshot = await harness.service.getBoardSnapshot(PROJECT_ID);
    expect(snapshot.needsYou).toHaveLength(1);
    expect(snapshot.needsYou[0].question).toBe("Run npm test?");
    expect(snapshot.needsYou[0].actions.map((a) => a.label)).toEqual(["Allow", "Deny"]);

    session.push({
      type: "permission_resolved",
      provider: "codex",
      requestId: "perm-1",
      resolution: { behavior: "allow" },
    });
    await flushBoard();

    snapshot = await harness.service.getBoardSnapshot(PROJECT_ID);
    expect(snapshot.needsYou).toHaveLength(0);
    expect(snapshot.done.some((row) => row.text === "Answered Run npm test?")).toBe(true);
  });

  test("working rows mark your sessions and exclude idle delegated agents", async () => {
    await harness.service.enableProjectCoordinator(enableInput());

    const mine = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir, title: "My session" },
      undefined,
      { workspaceId: harness.workspace.workspaceId },
    );
    const delegated = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir, title: "Delegated job" },
      undefined,
      {
        workspaceId: harness.workspace.workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: mine.id },
      },
    );
    // Both settle to idle once their turns complete.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = await harness.service.getBoardSnapshot(PROJECT_ID);
    const mineRow = snapshot.working.find((row) => row.agentId === mine.id);
    expect(mineRow?.yours).toBe(true);
    // The delegated agent finished its turn (idle) — it is done, not working.
    expect(snapshot.working.some((row) => row.agentId === delegated.id)).toBe(false);
  });

  test("project scope drops your own sessions from coverage", async () => {
    await harness.service.enableProjectCoordinator(enableInput({ scope: "project" }));
    const mine = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir, title: "My session" },
      undefined,
      { workspaceId: harness.workspace.workspaceId },
    );
    const snapshot = await harness.service.getBoardSnapshot(PROJECT_ID);
    expect(snapshot.working.some((row) => row.agentId === mine.id)).toBe(false);
  });

  test("agents outside the project's workspaces are not covered", async () => {
    const otherDir = path.join(harness.root, "elsewhere");
    mkdirSync(otherDir, { recursive: true });
    harness.projectRegistry.add(makeProject("prj_elsewhere", otherDir));
    harness.workspaceRegistry.add(makeWorkspace("wks_elsewhere", "prj_elsewhere", otherDir));

    await harness.service.enableProjectCoordinator(enableInput());
    const outside = await harness.agentManager.createAgent(
      { provider: "codex", cwd: otherDir, title: "Other project session" },
      undefined,
      { workspaceId: "wks_elsewhere" },
    );
    const snapshot = await harness.service.getBoardSnapshot(PROJECT_ID);
    expect(snapshot.working.some((row) => row.agentId === outside.id)).toBe(false);
  });

  test("subscribeBoard receives refreshed snapshots", async () => {
    const snapshots: string[] = [];
    harness.service.subscribeBoard((snapshot) => {
      snapshots.push(snapshot.projectId);
    });
    await harness.service.enableProjectCoordinator(enableInput());
    await flushBoard();
    expect(snapshots).toContain(PROJECT_ID);
  });
});

describe("remember", () => {
  test("a coordinator caller writes .paseo/memory/project.md and a Done row", async () => {
    const state = await harness.service.enableProjectCoordinator(enableInput());
    const result = await harness.service.remember({
      callerAgentId: state.agentId!,
      scope: "team",
      content: "Builds with `npm run build`.",
    });

    expect(result.filePath).toBe(path.join(harness.projectDir, ".paseo", "memory", "project.md"));
    const written = readFileSync(result.filePath, "utf8");
    expect(written).toContain("Builds with `npm run build`.");

    const snapshot = await harness.service.getBoardSnapshot(PROJECT_ID);
    expect(snapshot.done.some((row) => row.text === "Updated project memory")).toBe(true);
  });

  test("a delegated agent writes learned.md in its own checkout", async () => {
    const agent = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir },
      undefined,
      {
        workspaceId: harness.workspace.workspaceId,
        labels: { [PARENT_AGENT_ID_LABEL]: "some-parent" },
      },
    );
    const result = await harness.service.remember({
      callerAgentId: agent.id,
      scope: "team",
      content: "Tests need --runInBand.",
    });
    expect(result.filePath).toBe(path.join(harness.projectDir, ".paseo", "memory", "learned.md"));
    expect(readFileSync(result.filePath, "utf8")).toContain("Tests need --runInBand.");
  });

  test("rejects callers that are neither coordinator nor delegated", async () => {
    const agent = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir },
      undefined,
      { workspaceId: harness.workspace.workspaceId },
    );
    await expect(
      harness.service.remember({
        callerAgentId: agent.id,
        scope: "team",
        content: "nope",
      }),
    ).rejects.toThrow(/coordinators and delegated agents/);
  });

  test("rejects personal scopes in this milestone", async () => {
    const state = await harness.service.enableProjectCoordinator(enableInput());
    await expect(
      harness.service.remember({
        callerAgentId: state.agentId!,
        scope: "personal",
        content: "nope",
      }),
    ).rejects.toThrow(/not supported yet/);
  });

  test("replace mode rewrites the file; append adds dated sections", async () => {
    const state = await harness.service.enableProjectCoordinator(enableInput());
    const input = { callerAgentId: state.agentId!, scope: "team" as const };

    await harness.service.remember({ ...input, content: "first" });
    await harness.service.remember({ ...input, content: "second" });
    const appended = readFileSync(
      path.join(harness.projectDir, ".paseo", "memory", "project.md"),
      "utf8",
    );
    expect(appended).toContain("first");
    expect(appended).toContain("second");

    await harness.service.remember({ ...input, content: "replacement", mode: "replace" });
    const replaced = readFileSync(
      path.join(harness.projectDir, ".paseo", "memory", "project.md"),
      "utf8",
    );
    expect(replaced).not.toContain("first");
    expect(replaced).toContain("replacement");
  });
});

describe("observe gate at the catalog boundary", () => {
  function catalogFor(callerAgentId: string) {
    return createPaseoToolCatalog({
      agentManager: harness.agentManager,
      agentStorage: harness.agentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      callerAgentId,
      logger,
    });
  }

  test("a coordinator caller is denied spawn tools through executeTool", async () => {
    const state = await harness.service.enableProjectCoordinator(enableInput());
    const catalog = catalogFor(state.agentId!);

    await expect(catalog.executeTool("create_agent", { provider: "codex" })).rejects.toBeInstanceOf(
      CoordinatorToolDeniedError,
    );

    // An allowed read reaches the handler and returns a real result.
    const listed = await catalog.executeTool("list_agents", {});
    expect(listed.isError).not.toBe(true);
  });

  test("a non-coordinator caller passes the gate", async () => {
    const agent = await harness.agentManager.createAgent(
      { provider: "codex", cwd: harness.projectDir },
      undefined,
      { workspaceId: harness.workspace.workspaceId },
    );
    const catalog = catalogFor(agent.id);

    // Input parsing happens after the gate, so a parse failure still proves
    // the call was not denied by the observe policy.
    const outcome = await catalog.executeTool("create_agent", {}).catch((error) => error);
    expect(outcome).not.toBeInstanceOf(CoordinatorToolDeniedError);
  });
});
