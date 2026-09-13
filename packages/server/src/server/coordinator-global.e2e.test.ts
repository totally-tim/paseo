import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  COORDINATOR_GLOBAL_ROLE,
  PARENT_AGENT_ID_LABEL,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";

let context: DaemonTestContext | null = null;
const directories: string[] = [];
const requestId = (request: { id: string }) => request.id;
const hasPrompt = (prompts: string[], text: string) =>
  prompts.some((prompt) => prompt.includes(text));
const hasSummary = (prompts: string[], id: string) =>
  prompts.some((prompt) => prompt.includes("<agent-response>") && prompt.includes(id));

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await context?.cleanup();
  context = null;
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function openProject(ctx: DaemonTestContext) {
  const directory = await temporaryDirectory("coordinator-global-project-");
  const result = await ctx.client.openProject(directory);
  if (result.error || !result.workspace) {
    throw new Error(result.error ?? "Missing workspace");
  }
  return result.workspace;
}

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("global coordinator over the wire", () => {
  test("enable reparents project coordinators and keeps its backing records hidden", async () => {
    context = await createDaemonTestContext();
    const workspace = await openProject(context);
    const project = await context.client.enableProjectCoordinator({
      projectId: workspace.projectId,
      profile: { provider: "codex" },
    });
    const enabled = await context.client.enableGlobalCoordinator({
      profile: { provider: "codex" },
    });
    const global = enabled;
    if (
      !global?.agentId ||
      !global.workspaceId ||
      !global.projectId ||
      !project.coordinator?.agentId
    ) {
      throw new Error("Missing coordinator identity");
    }
    expect(global.enabled).toBe(true);
    const agent = context.daemon.daemon.agentManager.getAgent(global.agentId);
    expect(agent?.labels[PASEO_ROLE_LABEL]).toBe(COORDINATOR_GLOBAL_ROLE);
    expect(agent?.config.delegateOnly).toBe(true);
    expect(agent?.config.paseoTools).toBe("required");
    expect(agent?.cwd.startsWith(context.daemon.paseoHome)).toBe(true);
    const child = context.daemon.daemon.agentManager.getAgent(project.coordinator.agentId);
    expect(child?.labels[PARENT_AGENT_ID_LABEL]).toBe(global.agentId);

    const directory = await context.client.fetchWorkspaces({});
    const visibleWorkspaces = directory.entries.filter((entry) => !entry.hidden);
    const visibleProjects = directory.emptyProjects.filter((entry) => !entry.hidden);
    expect(visibleWorkspaces.some((entry) => entry.id === global.workspaceId)).toBe(false);
    expect(visibleProjects.some((entry) => entry.projectId === global.projectId)).toBe(false);
    expect(visibleWorkspaces.some((entry) => entry.id === workspace.id)).toBe(true);

    const repeated = await context.client.enableGlobalCoordinator({
      profile: { provider: "codex" },
    });
    expect(repeated?.agentId).toBe(global.agentId);
    const nextWorkspace = await openProject(context);
    const nextProject = await context.client.enableProjectCoordinator({
      projectId: nextWorkspace.projectId,
      profile: { provider: "codex" },
    });
    const nextId = nextProject.coordinator?.agentId;
    if (!nextId) throw new Error("Missing new project coordinator");
    expect(context.daemon.daemon.agentManager.getAgent(nextId)?.labels[PARENT_AGENT_ID_LABEL]).toBe(
      global.agentId,
    );
  }, 60_000);

  test("global identity and default trust survive daemon restart", async () => {
    const root = await temporaryDirectory("coordinator-global-restart-");
    context = await createDaemonTestContext({
      paseoHomeRoot: root,
      cleanup: false,
      logger: pino({ level: "error" }),
    });
    const enabled = await context.client.enableGlobalCoordinator({
      profile: { provider: "codex" },
    });
    const updated = await context.client.updateGlobalCoordinator({ trustLevel: "propose" });
    expect(updated?.trustLevel).toBe("propose");
    await context.cleanup();
    context = null;
    context = await createDaemonTestContext({
      paseoHomeRoot: root,
      cleanup: false,
      logger: pino({ level: "error" }),
    });
    const restored = await context.client.getGlobalCoordinator();
    expect(restored).toMatchObject({
      enabled: true,
      agentId: enabled?.agentId,
      workspaceId: enabled?.workspaceId,
      trustLevel: "propose",
    });
    const id = restored?.agentId;
    if (!id) throw new Error("Missing restored coordinator");
    expect(context.daemon.daemon.agentManager.getAgent(id)?.lifecycle).not.toBe("closed");
    const disabled = await context.client.disableGlobalCoordinator();
    expect(disabled?.enabled).toBe(false);
  }, 60_000);

  test.each(["codex", "opencode"] as const)(
    "%s project setup requests survive turns and restart, and Ignore stays dismissed",
    async (provider) => {
      const root = await temporaryDirectory("coordinator-global-setup-");
      context = await createDaemonTestContext({
        paseoHomeRoot: root,
        cleanup: false,
        logger: pino({ level: "error" }),
      });
      await openProject(context);
      await openProject(context);
      const global = await context.client.enableGlobalCoordinator({ profile: { provider } });
      if (!global.agentId) throw new Error("Missing global coordinator");
      const globalId = global.agentId;
      const pending = () =>
        context!.daemon.daemon.agentManager
          .getPendingPermissions(globalId)
          .filter((request) => request.id.startsWith("coordinator-setup:"));
      await expect.poll(() => pending().length).toBe(2);
      const [ignored, retained] = pending();
      await context.client.respondToPermissionAndWait(globalId, ignored.id, {
        behavior: "allow",
        updatedInput: { answers: { Coordinator: "Ignore" } },
      });
      await context.client.sendMessage(globalId, "Summarize known project activity.");
      await expect.poll(() => pending().map(requestId)).toEqual([retained.id]);
      await context.cleanup();
      context = null;
      context = await createDaemonTestContext({
        paseoHomeRoot: root,
        cleanup: false,
        logger: pino({ level: "error" }),
      });
      expect((await context.client.getGlobalCoordinator()).agentId).toBe(globalId);
      await expect.poll(() => pending().map(requestId), { timeout: 10_000 }).toEqual([retained.id]);
      await context.daemon.daemon.agentManager.reloadAgentSession(globalId);
      await expect.poll(() => pending().map(requestId)).toEqual([retained.id]);
      const setup = retained.input?.coordinatorProjectSetup as { projectId: string };
      await context.client.enableProjectCoordinator({
        projectId: setup.projectId,
        profile: { provider },
      });
      await expect.poll(() => pending().length).toBe(0);
      const added = await openProject(context);
      await expect.poll(() => pending().length).toBe(1);
      await context.client.removeProject(added.projectId);
      await expect.poll(() => pending().length).toBe(0);
      await context.client.disableGlobalCoordinator();
      expect(context.daemon.daemon.agentManager.getAgent(globalId)).toBeNull();
    },
    60_000,
  );

  test("a daemon decision completing during reload clears the replacement session", async () => {
    context = await createDaemonTestContext();
    const global = await context.client.enableGlobalCoordinator({
      profile: { provider: "opencode" },
    });
    if (!global.agentId) throw new Error("Missing global coordinator");
    const manager = context.daemon.daemon.agentManager;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    manager.registerDaemonQuestion({
      agentId: global.agentId,
      request: { id: "reload-question", provider: "opencode", kind: "question", name: "Decision" },
      respond: async () => {
        entered();
        await gate;
      },
    });
    const response = manager.respondToPermission(global.agentId, "reload-question", {
      behavior: "deny",
    });
    await started;
    try {
      await manager.reloadAgentSession(global.agentId);
    } finally {
      release();
    }
    await response;
    expect(manager.getPendingPermissions(global.agentId).map(requestId)).not.toContain(
      "reload-question",
    );
  }, 60_000);

  test("global delegation returns a project summary and cannot create workers", async () => {
    const prompts: string[] = [];
    context = await createDaemonTestContext({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt) => prompts.push(promptText(prompt)),
      }),
    });
    const workspace = await openProject(context);
    const project = await context.client.enableProjectCoordinator({
      projectId: workspace.projectId,
      profile: { provider: "codex" },
    });
    const enabled = await context.client.enableGlobalCoordinator({
      profile: { provider: "codex" },
    });
    const globalId = enabled?.agentId;
    const projectId = project.coordinator?.agentId;
    if (!globalId || !projectId) throw new Error("Missing coordinator identity");
    const mcp = new Client({ name: "coordinator-global-test", version: "1.0.0" });
    const url = new URL(`http://127.0.0.1:${context.daemon.port}/mcp/agents`);
    url.searchParams.set("callerAgentId", globalId);
    await mcp.connect(new StreamableHTTPClientTransport(url));
    try {
      const sent = await mcp.callTool({
        name: "send_agent_prompt",
        arguments: {
          agentId: projectId,
          prompt: "Summarize the project for global-delegation-proof",
          background: true,
        },
      });
      expect(sent.isError).not.toBe(true);
      await expect.poll(() => hasPrompt(prompts, "global-delegation-proof")).toBe(true);
      await expect.poll(() => hasSummary(prompts, projectId)).toBe(true);
      const spawned = await mcp.callTool({
        name: "create_agent",
        arguments: { title: "Forbidden worker", provider: "codex", initialPrompt: "Do work" },
      });
      expect(spawned.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  }, 60_000);
});
