import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COORDINATOR_PROJECT_ID_LABEL,
  COORDINATOR_PROJECT_ROLE,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { CoordinatorBoardSnapshot } from "@getpaseo/protocol/messages";

import {
  createDaemonTestContext,
  createTestPaseoDaemon,
  DaemonClient,
  type DaemonTestContext,
  type TestPaseoDaemon,
} from "./test-utils/index.js";

const tempDirs: string[] = [];
let ctx: DaemonTestContext;

function makeProjectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coordinator-e2e-project-"));
  tempDirs.push(dir);
  return dir;
}

async function openProject(cwd: string): Promise<{ projectId: string; workspaceId: string }> {
  const response = await ctx.client.openProject(cwd);
  if (response.error || !response.workspace) {
    throw new Error(response.error ?? "openProject returned no workspace");
  }
  return {
    projectId: response.workspace.projectId,
    workspaceId: response.workspace.id,
  };
}

async function enableCoordinator(projectId: string) {
  const result = await ctx.client.enableProjectCoordinator({
    projectId,
    profile: { provider: "codex" },
  });
  return result.coordinator;
}

function hasWorkingRow(snapshot: CoordinatorBoardSnapshot): boolean {
  return snapshot.working.length > 0;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

beforeEach(async () => {
  ctx = await createDaemonTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("project coordinator over the wire", () => {
  test("server_info advertises the coordinator feature", () => {
    expect(ctx.client.getLastServerInfoMessage()?.features?.coordinator).toBe(true);
  });

  test("enable creates a labeled delegate-only coordinator and get returns it", async () => {
    const projectDir = makeProjectDir();
    const { projectId } = await openProject(projectDir);

    const state = await enableCoordinator(projectId);
    expect(state.projectId).toBe(projectId);
    expect(state.enabled).toBe(true);
    expect(state.trustLevel).toBe("observe");
    expect(state.scope).toBe("everything");
    expect(state.agentId).not.toBeNull();

    const fetched = await ctx.client.getProjectCoordinator(projectId);
    expect(fetched.coordinator?.agentId).toBe(state.agentId);

    const directory = await ctx.client.fetchAgents({});
    const coordinator = directory.entries.find((entry) => entry.agent.id === state.agentId);
    expect(coordinator).toBeDefined();
    expect(coordinator!.agent.labels[PASEO_ROLE_LABEL]).toBe(COORDINATOR_PROJECT_ROLE);
    expect(coordinator!.agent.labels[COORDINATOR_PROJECT_ID_LABEL]).toBe(projectId);
  });

  test("enabling twice keeps the same coordinator session", async () => {
    const projectDir = makeProjectDir();
    const { projectId } = await openProject(projectDir);

    const first = await enableCoordinator(projectId);
    const second = await enableCoordinator(projectId);
    expect(second.agentId).toBe(first.agentId);
  });

  test("board subscribe returns a snapshot and streams changes", async () => {
    const projectDir = makeProjectDir();
    const { projectId, workspaceId } = await openProject(projectDir);
    await enableCoordinator(projectId);

    const changes: CoordinatorBoardSnapshot[] = [];
    const subscription = ctx.client.observeCoordinatorBoard({ projectId });
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "coordinator.board.changed") {
          changes.push(message.payload.snapshot);
        }
      },
    });
    const snapshot = await subscription.ready;

    expect(snapshot.error).toBeNull();
    expect(snapshot.projectId).toBe(projectId);
    expect(snapshot.subscriptionId).toBeTruthy();
    const board = snapshot.snapshots.find((entry) => entry.projectId === projectId);
    expect(board).toBeDefined();
    expect(board!.enabled).toBe(true);
    expect(board!.coordinatorAgentId).not.toBeNull();
    expect(board!.wake?.text).toContain("Woke");

    // A new session in the project workspace lands on the board as Working.
    await ctx.client.createAgent({
      provider: "codex",
      cwd: projectDir,
      workspaceId,
      title: "Board test session",
    });
    await waitFor(() => changes.some(hasWorkingRow), "coordinator.board.changed");
    const latest = changes.at(-1)!;
    expect(latest.working.some((row) => row.yours === true)).toBe(true);

    await subscription.release();
  });

  test("the coordinator is resident after a daemon restart on the same home", async () => {
    const projectDir = makeProjectDir();
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "coordinator-e2e-home-"));
    tempDirs.push(paseoHomeRoot);

    // Rebuild the context on an explicit home so a second daemon can reopen it.
    await ctx.cleanup();
    let daemon: TestPaseoDaemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      cleanup: false,
    });
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    ctx = {
      daemon,
      client,
      cleanup: async () => {
        await client.close();
        await daemon.close();
      },
    };

    const { projectId } = await openProject(projectDir);
    const enabled = await enableCoordinator(projectId);
    expect(enabled.agentId).not.toBeNull();

    // Restart: close the daemon, keep the home, boot a fresh one on it.
    await client.close();
    await daemon.close();

    daemon = await createTestPaseoDaemon({ paseoHomeRoot, cleanup: false });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    ctx = {
      daemon,
      client,
      cleanup: async () => {
        await client.close();
        await daemon.close();
      },
    };

    const state = await client.getProjectCoordinator(projectId);
    expect(state.coordinator?.enabled).toBe(true);
    expect(state.coordinator?.agentId).toBe(enabled.agentId);

    // The coordinator record is live in the restarted daemon, not just on disk.
    const directory = await client.fetchAgents({});
    const coordinator = directory.entries.find((entry) => entry.agent.id === enabled.agentId);
    expect(coordinator).toBeDefined();
    expect(coordinator!.agent.status).not.toBe("closed");
  }, 60_000);

  test("a duplicate coordinator record is reconciled back to the singleton", async () => {
    const projectDir = makeProjectDir();
    const { projectId, workspaceId } = await openProject(projectDir);
    const enabled = await enableCoordinator(projectId);

    // Forge a crash-created duplicate record with the coordinator labels.
    const dup = await ctx.daemon.daemon.agentManager.createAgent(
      { provider: "codex", cwd: projectDir },
      undefined,
      {
        workspaceId,
        labels: {
          [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
          [COORDINATOR_PROJECT_ID_LABEL]: projectId,
        },
      },
    );

    const state = await enableCoordinator(projectId);
    expect(state.agentId).toBe(enabled.agentId);

    const record = await ctx.daemon.daemon.agentStorage.get(dup.id);
    expect(record?.archivedAt).toBeTruthy();
  });
});
