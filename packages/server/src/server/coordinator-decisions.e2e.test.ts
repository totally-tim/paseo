import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PushPayload } from "./push/index.js";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";

let context: DaemonTestContext | null = null;
let root: string | null = null;
let now = 0;
const pushes: PushPayload[] = [];

afterEach(async () => {
  await context?.cleanup();
  context = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  pushes.length = 0;
});

async function start(): Promise<DaemonTestContext> {
  root ??= await mkdtemp(path.join(tmpdir(), "coordinator-decisions-"));
  context = await createDaemonTestContext({
    paseoHomeRoot: root,
    cleanup: false,
    dependencies: { coordinatorNow: () => now },
    pushNotificationSender: {
      send: async (payload) => {
        pushes.push(payload);
      },
    },
  });
  return context;
}

const actions = ["Retry", "Investigate", "Ignore"].map((label) => ({
  id: label.toLowerCase(),
  label,
  response: { behavior: "allow", updatedInput: { answers: { Decision: label } } },
}));

async function raiseDecision(agentId: string, defaultActionId?: string): Promise<string> {
  if (!context) throw new Error("Daemon is not running");
  const mcp = new Client({ name: "coordinator-decision-test", version: "1.0.0" });
  const url = new URL(`http://127.0.0.1:${context.daemon.port}/mcp/agents`);
  url.searchParams.set("callerAgentId", agentId);
  await mcp.connect(new StreamableHTTPClientTransport(url));
  try {
    const result = await mcp.callTool({
      name: "coordinator_decision",
      arguments: {
        question: "CI failed on #41. Retry, investigate, or ignore?",
        actions,
        defaultActionId,
      },
    });
    expect(result.isError).not.toBe(true);
    const requestId = result.structuredContent?.requestId;
    if (typeof requestId !== "string") throw new Error("Missing decision request id");
    return requestId;
  } finally {
    await mcp.close();
  }
}

function decisionPushes(requestId: string): PushPayload[] {
  return pushes.filter((push) => push.data?.requestId === requestId);
}

describe("coordinator decisions through the daemon", () => {
  test("quiet-hour delivery and its two-hour default survive restart", async () => {
    now = new Date(2026, 8, 13, 23).getTime();
    const first = await start();
    const global = await first.client.enableGlobalCoordinator({
      profile: { provider: "opencode" },
    });
    if (!global.agentId || !global.projectId) throw new Error("Missing coordinator");
    await first.client.updateGlobalCoordinator({ notificationSettings: { digestEnabled: false } });
    const requestId = await raiseDecision(global.agentId, "retry");
    await first.daemon.daemon.coordinatorService.tickDecisions();
    expect(decisionPushes(requestId)).toEqual([]);
    await first.cleanup();
    context = null;

    now = new Date(2026, 8, 14, 7).getTime();
    const restarted = await start();
    await restarted.daemon.daemon.coordinatorService.tickDecisions();
    await expect.poll(() => decisionPushes(requestId).length).toBe(1);
    const request = restarted.daemon.daemon.agentManager
      .getPendingPermissions(global.agentId)
      .find((entry) => entry.id === requestId);
    expect(request?.timeoutAt).toBe(new Date(2026, 8, 14, 9).toISOString());
    expect(decisionPushes(requestId)[0].data?.actions).toEqual(
      actions.map((action) => ({
        id: action.id,
        label: action.label,
        response: { ...action.response, selectedActionId: action.id },
      })),
    );

    now = new Date(2026, 8, 14, 9).getTime();
    await restarted.daemon.daemon.coordinatorService.tickDecisions();
    await expect
      .poll(() =>
        restarted.daemon.daemon.agentManager
          .getPendingPermissions(global.agentId)
          .map(permissionId),
      )
      .not.toContain(requestId);
    const board = await restarted.daemon.daemon.coordinatorService.getBoardSnapshot(
      global.projectId,
    );
    expect(JSON.stringify(board.done)).toContain("default after 2h");
    await restarted.daemon.daemon.coordinatorService.tickDecisions();
    expect(decisionPushes(requestId)).toHaveLength(1);
  }, 60_000);

  test("the daily digest sends once at 08:00 and stays deduplicated across restart", async () => {
    now = new Date(2026, 8, 13, 7, 59).getTime();
    const first = await start();
    await first.client.enableGlobalCoordinator({ profile: { provider: "opencode" } });
    const digests = () => pushes.filter((push) => push.title === "Coordinator daily digest");
    await first.daemon.daemon.coordinatorService.tickDecisions();
    expect(digests()).toHaveLength(0);
    now = new Date(2026, 8, 13, 8).getTime();
    await first.daemon.daemon.coordinatorService.tickDecisions();
    expect(digests()).toHaveLength(1);
    expect(digests()[0].body).toBe("0 items need you (0 proposals); 0 sessions working.");
    await first.cleanup();
    context = null;
    const restarted = await start();
    await restarted.daemon.daemon.coordinatorService.tickDecisions();
    expect(digests()).toHaveLength(1);
    now = new Date(2026, 8, 14, 8).getTime();
    await restarted.daemon.daemon.coordinatorService.tickDecisions();
    expect(digests()).toHaveLength(2);
  }, 60_000);

  test("Leave it acknowledges without resolving the original stalled permission", async () => {
    now = new Date(2026, 8, 13, 12).getTime();
    const ctx = await start();
    const cwd = path.join(root!, "project");
    await mkdir(cwd);
    const opened = await ctx.client.openProject(cwd);
    if (!opened.workspace) throw new Error("Missing test workspace");
    await ctx.client.enableProjectCoordinator({
      projectId: opened.workspace.projectId,
      profile: { provider: "opencode" },
    });
    const agent = await ctx.daemon.daemon.agentManager.createAgent(
      { provider: "opencode", cwd, modeId: "default" },
      undefined,
      { workspaceId: opened.workspace.id },
    );
    await ctx.client.sendMessage(
      agent.id,
      'Create a file named "permission.txt" with the content "allowed"',
    );
    const manager = ctx.daemon.daemon.agentManager;
    await expect.poll(() => manager.getPendingPermissions(agent.id).length).toBe(1);
    const requestId = manager.getPendingPermissions(agent.id)[0]!.id;
    await expect.poll(() => decisionPushes(requestId).length).toBe(1);
    manager.getAgent(agent.id)!.permissionRequestedAt.set(requestId, new Date(now).toISOString());
    now += 40 * 60_000;
    await ctx.client.deferCoordinatorPermission(agent.id, requestId);
    await ctx.daemon.daemon.coordinatorService.tickDecisions();
    expect(decisionPushes(requestId)).toHaveLength(1);
    expect(manager.getPendingPermissions(agent.id).map(permissionId)).toContain(requestId);
    await expect(readFile(path.join(cwd, "permission.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const resolved = await ctx.client.respondToPermissionAndWait(agent.id, requestId, {
      behavior: "allow",
    });
    expect(resolved.requestId).toBe(requestId);
    await expect
      .poll(() => manager.getPendingPermissions(agent.id).map(permissionId))
      .not.toContain(requestId);
    await expect.poll(() => readFile(path.join(cwd, "permission.txt"), "utf8")).toBe("allowed");
  }, 60_000);

  test("a user answer uses the original request and is never defaulted afterward", async () => {
    now = new Date(2026, 8, 13, 12).getTime();
    const ctx = await start();
    const global = await ctx.client.enableGlobalCoordinator({ profile: { provider: "opencode" } });
    if (!global.agentId || !global.projectId) throw new Error("Missing coordinator");
    await ctx.client.updateGlobalCoordinator({ notificationSettings: { digestEnabled: false } });
    const requestId = await raiseDecision(global.agentId, "retry");
    await ctx.daemon.daemon.coordinatorService.tickDecisions();
    const resolved = await ctx.client.respondToPermissionAndWait(global.agentId, requestId, {
      behavior: "allow",
      selectedActionId: "investigate",
      updatedInput: { answers: { Decision: "Investigate" } },
    });
    expect(resolved.requestId).toBe(requestId);
    now += 3 * 60 * 60 * 1000;
    await ctx.daemon.daemon.coordinatorService.tickDecisions();
    const board = await ctx.daemon.daemon.coordinatorService.getBoardSnapshot(global.projectId);
    expect(JSON.stringify(board.done)).not.toContain("default after");
    expect(
      ctx.daemon.daemon.agentManager.getPendingPermissions(global.agentId).map(permissionId),
    ).not.toContain(requestId);
  }, 60_000);
});

function permissionId(request: { id: string }): string {
  return request.id;
}
