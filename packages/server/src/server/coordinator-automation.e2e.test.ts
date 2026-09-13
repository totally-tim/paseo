import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
let context: DaemonTestContext | null = null;
const directories: string[] = [];
afterEach(async () => {
  await context?.cleanup();
  context = null;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function project(ctx: DaemonTestContext, git = false) {
  const cwd = await mkdtemp(path.join(tmpdir(), "coordinator-automation-project-"));
  directories.push(cwd);
  if (git) {
    const run = promisify(execFile);
    await run("git", ["init", "-b", "main"], { cwd });
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
      ],
      { cwd },
    );
  }
  const opened = await ctx.client.openProject(cwd);
  if (!opened.workspace) throw new Error("Missing workspace");
  const enabled = await ctx.client.enableProjectCoordinator({
    projectId: opened.workspace.projectId,
    profile: { provider: "opencode" },
  });
  if (!enabled.coordinator?.agentId) throw new Error("Missing coordinator");
  return { cwd, workspace: opened.workspace, agentId: enabled.coordinator.agentId };
}
async function start(agentClients = createTestAgentClients()) {
  context = await createDaemonTestContext({ agentClients });
  return context;
}
async function propose(
  ctx: DaemonTestContext,
  callerAgentId: string,
  args: Record<string, unknown>,
) {
  const client = new Client({ name: "coordinator-automation-test", version: "1" });
  const url = new URL(`http://127.0.0.1:${ctx.daemon.port}/mcp/agents`);
  url.searchParams.set("callerAgentId", callerAgentId);
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    return await client.callTool({ name: "coordinator_propose", arguments: args });
  } finally {
    await client.close();
  }
}
const ruleYaml =
  "name: dependencies\non: cron\ncron: '0 8 * * 1'\nstep:\n  profile: implementer\n  prompt: Update dependencies\nguard:\n  max_concurrent: 1\n";
describe("coordinator automation through the daemon", () => {
  test("one global approval installs two goals and disable preserves paused rules", async () => {
    const ctx = await start();
    const first = await project(ctx);
    const second = await project(ctx);
    const global = await ctx.client.enableGlobalCoordinator({ profile: { provider: "opencode" } });
    if (!global.agentId) throw new Error("Missing global coordinator");
    const result = await propose(ctx, global.agentId, {
      sentence: "Keep dependencies current weekly",
      projectIds: [first.workspace.projectId, second.workspace.projectId],
      payload: { kind: "goal", ruleYaml },
    });
    expect(result.isError).not.toBe(true);
    const pending = await ctx.client.listCoordinatorProposals();
    expect(pending).toHaveLength(1);
    expect(await ctx.client.listCoordinatorGoals()).toEqual([]);
    await ctx.client.resolveCoordinatorProposal({ proposalId: pending[0]!.id, action: "approve" });
    const goals = await ctx.client.listCoordinatorGoals();
    expect(goals).toHaveLength(2);
    expect(goals.map((goal) => goal.projectId).sort()).toEqual(
      [first.workspace.projectId, second.workspace.projectId].sort(),
    );
    for (const goal of goals)
      expect(
        await readFile(
          path.join(ctx.daemon.paseoHome, "coordinator", "goals", goal.projectId, `${goal.id}.yml`),
          "utf8",
        ),
      ).toBe(ruleYaml);
    await ctx.client.disableProjectCoordinator(first.workspace.projectId);
    expect(
      (await ctx.client.listCoordinatorGoals({ projectId: first.workspace.projectId }))[0]?.paused,
    ).toBe(true);
    expect(
      (await ctx.client.listCoordinatorGoals({ projectId: second.workspace.projectId }))[0]?.paused,
    ).toBe(false);
  }, 60000);
  test("Always reviews exact input, answers original permission, and policy answers only matching covered requests", async () => {
    const ctx = await start();
    const setup = await project(ctx);
    const manager = ctx.daemon.daemon.agentManager;
    const worker = async () => {
      const agent = await manager.createAgent(
        { provider: "opencode", cwd: setup.cwd, modeId: "default" },
        undefined,
        { workspaceId: setup.workspace.id, labels: { [PARENT_AGENT_ID_LABEL]: setup.agentId } },
      );
      await ctx.client.sendMessage(
        agent.id,
        'Create a file named "policy.txt" with the content "allowed"',
      );
      await expect.poll(() => manager.getPendingPermissions(agent.id).length).toBe(1);
      return { agentId: agent.id, requestId: manager.getPendingPermissions(agent.id)[0]!.id };
    };
    const first = await worker();
    const preview = await ctx.client.getCoordinatorPermissionPolicyPreview(first);
    await expect(
      ctx.client.alwaysAllowCoordinatorPermission({
        ...first,
        scope: "project",
        expectedPattern: "changed",
      }),
    ).rejects.toThrow("changed");
    expect(await ctx.client.listCoordinatorPolicy()).toEqual([]);
    const saved = await ctx.client.alwaysAllowCoordinatorPermission({
      ...first,
      scope: "project",
      expectedPattern: preview.pattern,
    });
    expect(saved.firedCount).toBe(1);
    await ctx.client.updateProjectCoordinator({
      projectId: setup.workspace.projectId,
      scope: "everything",
    });
    const own = await manager.createAgent(
      { provider: "opencode", cwd: setup.cwd, modeId: "default" },
      undefined,
      { workspaceId: setup.workspace.id },
    );
    await ctx.client.sendMessage(
      own.id,
      'Create a file named "policy.txt" with the content "allowed"',
    );
    await expect.poll(() => manager.getPendingPermissions(own.id).length).toBe(1);
    const ownRequest = manager.getPendingPermissions(own.id)[0]!;
    await ctx.daemon.daemon.coordinatorService.sweepStalledSessions();
    expect(manager.getPendingPermissions(own.id).map((request) => request.id)).toEqual([
      ownRequest.id,
    ]);
    expect(
      (
        await ctx.client.getCoordinatorPermissionPolicyPreview({
          agentId: own.id,
          requestId: ownRequest.id,
        })
      ).pattern,
    ).toBe(preview.pattern);
    await ctx.client.respondToPermissionAndWait(own.id, ownRequest.id, { behavior: "deny" });

    await expect.poll(() => readFile(path.join(setup.cwd, "policy.txt"), "utf8")).toBe("allowed");
    const second = await worker();
    await ctx.daemon.daemon.coordinatorService.sweepStalledSessions();
    expect(manager.getPendingPermissions(second.agentId).map((request) => request.id)).toEqual([
      second.requestId,
    ]);
    await ctx.client.updateProjectCoordinator({
      projectId: setup.workspace.projectId,
      trustLevel: "ship",
    });
    let releaseResponse!: () => void;
    let reachedResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const responseReached = new Promise<void>((resolve) => {
      reachedResponse = resolve;
    });
    const respond = manager.respondToPermission.bind(manager);
    manager.respondToPermission = async (...args) => {
      if (args[0] === second.agentId) {
        reachedResponse();
        await responseGate;
      }
      return respond(...args);
    };
    const sweep = ctx.daemon.daemon.coordinatorService.sweepStalledSessions();
    await responseReached;
    let disabled = false;
    const disable = ctx.daemon.daemon.coordinatorService
      .setCoordinatorPolicyEnabled(saved.id, false)
      .then(() => {
        disabled = true;
        return;
      });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disabled).toBe(false);
    } finally {
      releaseResponse();
    }
    await sweep;
    await disable;
    manager.respondToPermission = respond;
    await expect.poll(() => manager.getPendingPermissions(second.agentId).length).toBe(0);
    expect((await ctx.client.listCoordinatorPolicy())[0]?.firedCount).toBe(2);
    const third = await worker();
    await ctx.daemon.daemon.coordinatorService.sweepStalledSessions();
    expect(manager.getPendingPermissions(third.agentId).map((request) => request.id)).toEqual([
      third.requestId,
    ]);
    const board = await ctx.daemon.daemon.coordinatorService.getBoardSnapshot(
      setup.workspace.projectId,
    );
    expect(board.done.filter((row) => row.id.startsWith("policy:")).length).toBe(2);
  }, 60000);
  test("an approved goal fires through the daemon scheduler callback and governed worker workflow", async () => {
    const ctx = await start();
    const setup = await project(ctx);
    await ctx.client.updateProjectCoordinator({
      projectId: setup.workspace.projectId,
      trustLevel: "propose",
      profiles: { investigator: { provider: "opencode" } },
    });
    await propose(ctx, setup.agentId, {
      sentence: "Inspect dependency manifests",
      payload: {
        kind: "goal",
        ruleYaml: ruleYaml
          .replace("profile: implementer", "profile: investigator")
          .replace("Update dependencies", "Report dependency manifest status"),
      },
    });
    const proposal = (await ctx.client.listCoordinatorProposals())[0]!;
    await ctx.client.resolveCoordinatorProposal({ proposalId: proposal.id, action: "approve" });
    const goal = (await ctx.client.listCoordinatorGoals())[0]!;
    if (!goal.scheduleId) throw new Error("Missing goal schedule");
    const inspected = await ctx.client.scheduleInspect({ id: goal.scheduleId });
    if (!inspected.schedule) throw new Error("Missing approved goal schedule");
    const manager = ctx.daemon.daemon.agentManager;
    const run = ctx.daemon.daemon.coordinatorService.runGoalSchedule(
      inspected.schedule,
      "worker-proof",
    );
    void run.catch(() => undefined);
    // The fake OpenCode provider turns the report's "reason" key into a shell
    // request. The goal remains active until its ordinary permission is answered.
    const worker = () =>
      manager.listAgents().find((agent) => agent.labels[PARENT_AGENT_ID_LABEL] === setup.agentId);
    await expect.poll(() => worker()?.pendingPermissions.size).toBe(1);
    const pendingWorker = worker()!;
    const request = [...pendingWorker.pendingPermissions.values()][0]!;
    expect(request.input).toEqual({ command: "echo reasoning" });
    await ctx.client.respondToPermissionAndWait(pendingWorker.id, request.id, {
      behavior: "allow",
    });
    await run;
    const updated = (await ctx.client.listCoordinatorGoals())[0]!;
    expect(updated.firedCount).toBe(1);
    expect(updated.emptyStreak).toBe(0);
    expect(updated.lastOutcome).toBe("unknown");
    expect(updated.lastError).toBeUndefined();
    const board = await ctx.daemon.daemon.coordinatorService.getBoardSnapshot(
      setup.workspace.projectId,
    );
    expect(board.done.filter((row) => row.id.startsWith(`goal:${goal.id}:run:`))).toHaveLength(1);
  }, 60000);
  test("an approved judgment heartbeat runs on the resident coordinator without spawning", async () => {
    const prompts: string[] = [];
    const ctx = await start(
      createTestAgentClients({
        onStartTurn: (prompt) => {
          if (typeof prompt === "string") prompts.push(prompt);
        },
      }),
    );
    const setup = await project(ctx);
    const manager = ctx.daemon.daemon.agentManager;
    await expect.poll(() => manager.hasInFlightRun(setup.agentId)).toBe(false);
    const beforeIds = (await ctx.daemon.daemon.agentStorage.list()).map((agent) => agent.id).sort();
    await propose(ctx, setup.agentId, {
      sentence: "Check whether dependency work needs attention",
      payload: {
        kind: "goal",
        ruleYaml:
          "name: judgment\non: heartbeat\nintervalMinutes: 60\nstep:\n  profile: unused-resident-profile\n  prompt: Check dependencies\nguard:\n  max_concurrent: 1\n",
      },
    });
    const proposal = (await ctx.client.listCoordinatorProposals())[0]!;
    await ctx.client.resolveCoordinatorProposal({ proposalId: proposal.id, action: "approve" });
    const goal = (await ctx.client.listCoordinatorGoals())[0]!;
    expect(goal.kind).toBe("judgment");
    const inspected = await ctx.client.scheduleInspect({ id: goal.scheduleId! });
    if (!inspected.schedule) throw new Error("Missing approved goal schedule");
    const run = ctx.daemon.daemon.coordinatorService.runGoalSchedule(
      inspected.schedule,
      "judgment-proof",
    );
    // The fake provider maps the report's "reason" field to a shell request.
    // Deny that incidental request on the delegate-only resident coordinator.
    await expect.poll(() => manager.getAgent(setup.agentId)?.pendingPermissions.size ?? 0).toBe(1);
    const request = [...manager.getAgent(setup.agentId)!.pendingPermissions.values()][0]!;
    expect(request.input).toEqual({ command: "echo reasoning" });
    await ctx.client.respondToPermissionAndWait(setup.agentId, request.id, { behavior: "deny" });
    await run;
    expect((await ctx.client.listCoordinatorGoals())[0]).toMatchObject({
      firedCount: 1,
      lastOutcome: "unknown",
      emptyStreak: 0,
    });
    expect((await ctx.daemon.daemon.agentStorage.list()).map((agent) => agent.id).sort()).toEqual(
      beforeIds,
    );
    expect(
      prompts.filter((prompt) => prompt.includes("Check this approved judgment goal")),
    ).toHaveLength(1);
    const board = await ctx.daemon.daemon.coordinatorService.getBoardSnapshot(
      setup.workspace.projectId,
    );
    expect(board.done.find((row) => row.id.startsWith(`goal:${goal.id}:run:`))?.link?.agentId).toBe(
      setup.agentId,
    );
  }, 60000);
  test.each(["toggle", "proposal"] as const)(
    "pausing a claimed goal through %s prevents its worker's first turn",
    async (pauseVia) => {
      let release!: () => void;
      let entered!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let blockCreate = false;
      const startedPrompts: string[] = [];
      const clients = createTestAgentClients({
        onStartTurn: (prompt) => {
          if (typeof prompt === "string") startedPrompts.push(prompt);
        },
      });
      const provider = clients.opencode!;
      const createSession = provider.createSession.bind(provider);
      provider.createSession = async (...args) => {
        if (blockCreate) {
          blockCreate = false;
          entered();
          await barrier;
        }
        return createSession(...args);
      };
      const ctx = await start(clients);
      const isolated = pauseVia === "toggle";
      const setup = await project(ctx, isolated);
      await ctx.client.updateProjectCoordinator({
        projectId: setup.workspace.projectId,
        trustLevel: isolated ? "ship" : "propose",
        profiles: { investigator: { provider: "opencode" }, implementer: { provider: "opencode" } },
      });
      await propose(ctx, setup.agentId, {
        sentence: "Inspect after approval",
        payload: {
          kind: "goal",
          ruleYaml: isolated
            ? ruleYaml
            : ruleYaml.replace("profile: implementer", "profile: investigator"),
        },
      });
      const proposal = (await ctx.client.listCoordinatorProposals())[0]!;
      await ctx.client.resolveCoordinatorProposal({ proposalId: proposal.id, action: "approve" });
      const goal = (await ctx.client.listCoordinatorGoals())[0]!;
      if (!goal.scheduleId) throw new Error("Missing schedule");
      blockCreate = true;
      const inspected = await ctx.client.scheduleInspect({ id: goal.scheduleId });
      if (!inspected.schedule) throw new Error("Missing approved goal schedule");
      // The Goals-owned schedule cannot be run through the ordinary Schedules RPC.
      const run = ctx.daemon.daemon.coordinatorService.runGoalSchedule(
        inspected.schedule,
        "pause-race",
      );
      void run.catch(() => undefined);
      try {
        await reached;
        if (pauseVia === "toggle") {
          await ctx.client.setCoordinatorGoalPaused({
            projectId: goal.projectId,
            goalId: goal.id,
            paused: true,
          });
        } else {
          await propose(ctx, setup.agentId, {
            sentence: "Pause this inspection",
            payload: { kind: "pause_goal", goalId: goal.id },
          });
          const pauseProposal = (await ctx.client.listCoordinatorProposals()).find(
            (entry) => entry.payload.kind === "pause_goal",
          )!;
          await ctx.client.resolveCoordinatorProposal({
            proposalId: pauseProposal.id,
            action: "approve",
          });
        }
      } finally {
        release();
      }
      await run;
      const final = (await ctx.client.listCoordinatorGoals())[0]!;
      expect(final.paused).toBe(true);
      expect(final.lastError).toBeUndefined();
      expect(final.firedCount).toBe(0);
      const workers = (await ctx.daemon.daemon.agentStorage.list()).filter(
        (agent) => agent.labels[PARENT_AGENT_ID_LABEL] === setup.agentId,
      );
      expect(workers).toHaveLength(1);
      expect(workers[0]!.archivedAt).toBeTruthy();
      expect(ctx.daemon.daemon.agentManager.getAgent(workers[0]!.id)).toBeNull();
      expect(workers[0]!.lastUserMessageAt).toBeNull();
      const workspaces = JSON.parse(
        await readFile(path.join(ctx.daemon.paseoHome, "projects", "workspaces.json"), "utf8"),
      );
      expect(
        workspaces.find(
          (entry: { workspaceId: string }) => entry.workspaceId === setup.workspace.id,
        )?.archivedAt,
      ).toBeNull();
      if (isolated) {
        expect(workers[0]!.workspaceId).not.toBe(setup.workspace.id);
        expect(
          workspaces.find(
            (entry: { workspaceId: string }) => entry.workspaceId === workers[0]!.workspaceId,
          )?.archivedAt,
        ).toBeTruthy();
      }
      expect(startedPrompts.filter((prompt) => prompt.includes("Run the approved goal:"))).toEqual(
        [],
      );
    },
    60000,
  );
  test("a project coordinator cannot replace another project's pending proposal", async () => {
    const ctx = await start();
    const first = await project(ctx);
    const second = await project(ctx);
    await propose(ctx, second.agentId, {
      sentence: "Other project goal",
      payload: { kind: "goal", ruleYaml },
    });
    const original = (await ctx.client.listCoordinatorProposals())[0]!;
    const result = await propose(ctx, first.agentId, {
      sentence: "Hijack",
      replacesProposalId: original.id,
      payload: { kind: "goal", ruleYaml },
    });
    expect(result.isError).toBe(true);
    expect(
      (await ctx.client.listCoordinatorProposals()).map((entry) => ({
        id: entry.id,
        status: entry.status,
      })),
    ).toEqual([{ id: original.id, status: "pending" }]);
  }, 60000);
});
