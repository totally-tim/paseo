import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PARENT_AGENT_ID_LABEL,
  HANDOFF_FROM_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";
import {
  createTestAgentClients,
  type TestAgentClientOptions,
} from "./test-utils/fake-agent-client.js";
import {
  withAgentNotificationDelivery,
  stripCoordinatorMemoryContext,
} from "./agent/agent-prompt.js";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";

let context: DaemonTestContext | null = null;
const directories: string[] = [];
const prompts: string[] = [];
afterEach(async () => {
  await context?.cleanup();
  context = null;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  prompts.length = 0;
});
function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
async function rejectDirectDelivery(): Promise<never> {
  throw new Error("A rotating source must use the durable queue");
}
function forwardedPrompts() {
  return prompts.filter(
    (prompt) => stripCoordinatorMemoryContext(prompt) === "Child completed during rotation",
  );
}

async function setup(options: TestAgentClientOptions = {}) {
  context = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      ...options,
      onStartTurn: (prompt) => prompts.push(promptText(prompt)),
    }),
  });
  const directory = await mkdtemp(path.join(tmpdir(), "coordinator-rotation-project-"));
  directories.push(directory);
  const opened = await context.client.openProject(directory);
  if (!opened.workspace) throw new Error("Missing workspace");
  const project = await context.client.enableProjectCoordinator({
    projectId: opened.workspace.projectId,
    profile: { provider: "opencode" },
  });
  const global = await context.client.enableGlobalCoordinator({
    profile: { provider: "opencode" },
  });
  if (!project.coordinator?.agentId || !global.agentId)
    throw new Error("Missing coordinator identity");
  return {
    ctx: context,
    directory,
    workspace: opened.workspace,
    sourceId: project.coordinator.agentId,
    globalId: global.agentId,
  };
}

describe("coordinator rotation through the daemon", () => {
  test("context rotation retries cleanup only after another turn", async () => {
    let cleanupAttempts = 0;
    const { ctx, directory, sourceId, workspace } = await setup({
      scriptedTurn: async (prompt) => {
        const text = promptText(prompt);
        if (text.includes("Prepare to rotate this coordinator")) {
          cleanupAttempts++;
          return cleanupAttempts === 1
            ? [{ type: "turn_failed", provider: "opencode", error: "Cleanup interrupted" }]
            : [{ type: "turn_completed", provider: "opencode" }];
        }
        if (text.includes("Reach the context threshold"))
          return [
            {
              type: "turn_completed",
              provider: "opencode",
              usage: { contextWindowUsedTokens: 700, contextWindowMaxTokens: 1000 },
            },
          ];
        return null;
      },
    });
    const manager = ctx.daemon.daemon.agentManager;
    const service = ctx.daemon.daemon.coordinatorService;
    await expect.poll(() => manager.hasInFlightRun(sourceId)).toBe(false);
    await mkdir(path.join(directory, ".paseo", "memory"), { recursive: true });
    await writeFile(path.join(directory, ".paseo", "memory", "learned.md"), "A retained code fact");
    await ctx.client.sendMessage(sourceId, "Reach the context threshold");
    await expect.poll(() => cleanupAttempts, { timeout: 15000 }).toBe(1);
    await expect.poll(() => manager.hasInFlightRun(sourceId)).toBe(false);
    await service.tickDecisions();
    expect(cleanupAttempts).toBe(1);
    expect((await ctx.client.getProjectCoordinator(workspace.projectId)).coordinator?.agentId).toBe(
      sourceId,
    );
    await ctx.client.sendMessage(sourceId, "Reach the context threshold again");
    await expect.poll(() => cleanupAttempts, { timeout: 15000 }).toBe(2);
    await expect
      .poll(
        async () =>
          (await ctx.client.getProjectCoordinator(workspace.projectId)).coordinator?.agentId,
        { timeout: 15000 },
      )
      .not.toBe(sourceId);
  }, 60000);

  test("capacity recovery waits for a configured fallback and then rotates once", async () => {
    const { ctx, sourceId, workspace } = await setup({
      scriptedTurn: async (prompt) =>
        promptText(prompt).includes("Reach provider capacity")
          ? [
              {
                type: "timeline",
                provider: "opencode",
                item: {
                  type: "notification",
                  code: "provider_capacity",
                  level: "warning",
                  message: "Quota exhausted",
                },
              },
              { type: "turn_failed", provider: "opencode", error: "Capacity rejected" },
            ]
          : null,
    });
    const service = ctx.daemon.daemon.coordinatorService;
    await expect.poll(() => ctx.daemon.daemon.agentManager.hasInFlightRun(sourceId)).toBe(false);
    await ctx.client.sendMessage(sourceId, "Reach provider capacity");
    await expect
      .poll(
        async () => JSON.stringify((await service.getBoardSnapshot(workspace.projectId)).done),
        { timeout: 15000 },
      )
      .toContain("Set a coordinator fallback profile");
    expect((await ctx.client.getProjectCoordinator(workspace.projectId)).coordinator?.agentId).toBe(
      sourceId,
    );
    await ctx.client.updateProjectCoordinator({
      projectId: workspace.projectId,
      fallbackProfile: { provider: "codex" },
    });
    await service.tickDecisions();
    await expect
      .poll(
        async () =>
          (await ctx.client.getProjectCoordinator(workspace.projectId)).coordinator?.agentId,
        { timeout: 15000 },
      )
      .not.toBe(sourceId);
    const result = await ctx.client.getProjectCoordinator(workspace.projectId);
    expect(result.coordinator?.profile?.provider).toBe("codex");
  }, 60000);

  test("simultaneous global and project rotation keeps the successor parent", async () => {
    const { ctx, sourceId, globalId } = await setup();
    const manager = ctx.daemon.daemon.agentManager;
    await expect
      .poll(() => manager.hasInFlightRun(sourceId) || manager.hasInFlightRun(globalId))
      .toBe(false);
    const [global, project] = await Promise.all([
      ctx.daemon.daemon.coordinatorService.rotateCoordinator(globalId),
      ctx.daemon.daemon.coordinatorService.rotateCoordinator(sourceId),
    ]);
    expect(manager.getAgent(project.id)?.labels[PARENT_AGENT_ID_LABEL]).toBe(global.id);
  }, 60000);

  test("rotation preserves a child, heartbeat, pending decision and notification arriving during shutdown", async () => {
    const { ctx, directory, workspace, sourceId, globalId } = await setup();
    const manager = ctx.daemon.daemon.agentManager;
    const service = ctx.daemon.daemon.coordinatorService;
    await expect.poll(() => manager.hasInFlightRun(sourceId)).toBe(false);
    const child = await manager.createAgent({ provider: "opencode", cwd: directory }, undefined, {
      workspaceId: workspace.id,
      labels: { [PARENT_AGENT_ID_LABEL]: sourceId },
    });
    const schedule = await ctx.client.scheduleCreate({
      name: "Coordinator heartbeat",
      prompt: "Report status",
      cadence: { type: "cron", expression: "0 8 * * *", timezone: "UTC" },
      target: { type: "agent", agentId: sourceId },
      runOnCreate: false,
    });
    if (!schedule.schedule) throw new Error(schedule.error ?? "Missing schedule");
    const decision = await service.raiseDecision({
      callerAgentId: sourceId,
      question: "Retry?",
      actions: [{ id: "retry", label: "Retry", response: { behavior: "allow" } }],
    });
    let delivered: Promise<unknown> | null = null;
    const unsubscribe = manager.subscribe(
      (event) => {
        if (
          event.type !== "agent_state" ||
          event.agent.id !== sourceId ||
          event.agent.lifecycle !== "closed" ||
          delivered
        )
          return;
        delivered = withAgentNotificationDelivery(manager, sourceId, rejectDirectDelivery, {
          id: "rotation-child-result",
          prompt: "Child completed during rotation",
        });
      },
      { replayState: false },
    );
    let successor;
    try {
      successor = await service.rotateCoordinator(sourceId);
    } finally {
      unsubscribe();
    }
    await delivered;
    expect(successor.labels[HANDOFF_FROM_AGENT_ID_LABEL]).toBe(sourceId);
    expect(successor.labels[PARENT_AGENT_ID_LABEL]).toBe(globalId);
    expect(successor.config?.delegateOnly).toBe(true);
    expect(successor.config?.paseoTools).toBe("required");
    expect(manager.getAgent(child.id)?.labels[PARENT_AGENT_ID_LABEL]).toBe(successor.id);
    expect((await ctx.client.getProjectCoordinator(workspace.projectId)).coordinator?.agentId).toBe(
      successor.id,
    );
    const schedules = await ctx.client.scheduleList();
    expect(schedules.schedules.find((entry) => entry.id === schedule.schedule!.id)?.target).toEqual(
      { type: "agent", agentId: successor.id },
    );
    await expect.poll(() => forwardedPrompts().length).toBe(1);
    const answer = await ctx.client.respondToPermissionAndWait(sourceId, decision.requestId, {
      behavior: "allow",
      selectedActionId: "retry",
    });
    expect(answer.agentId).toBe(sourceId);
    expect(answer.requestId).toBe(decision.requestId);
    expect(
      manager
        .getPendingPermissions(successor.id)
        .some((request) => request.id === decision.requestId),
    ).toBe(false);
    expect((await ctx.daemon.daemon.agentStorage.get(sourceId))?.archivedAt).not.toBeNull();
  }, 60_000);

  test("global capacity rotation uses its configured fallback and reparents project coordinators", async () => {
    const { ctx, sourceId, globalId } = await setup();
    await ctx.client.updateGlobalCoordinator({ fallbackProfile: { provider: "codex" } });
    const successor = await ctx.daemon.daemon.coordinatorService.rotateCoordinator(
      globalId,
      "capacity",
    );
    expect(successor.provider).toBe("codex");
    expect((await ctx.client.getGlobalCoordinator()).agentId).toBe(successor.id);
    expect(ctx.daemon.daemon.agentManager.getAgent(sourceId)?.labels[PARENT_AGENT_ID_LABEL]).toBe(
      successor.id,
    );
  }, 60_000);
});
