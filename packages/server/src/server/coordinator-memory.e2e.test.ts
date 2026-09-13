import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
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

function findPrompt(text: string) {
  return prompts.find((prompt) => prompt.includes(text));
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

async function startProject() {
  context = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => prompts.push(promptText(prompt)),
    }),
  });
  const directory = await mkdtemp(path.join(tmpdir(), "coordinator-memory-project-"));
  directories.push(directory);
  const opened = await context.client.openProject(directory);
  if (!opened.workspace) throw new Error("Missing test workspace");
  const enabled = await context.client.enableProjectCoordinator({
    projectId: opened.workspace.projectId,
    profile: { provider: "opencode" },
  });
  const agentId = enabled.coordinator?.agentId;
  if (!agentId) throw new Error("Missing project coordinator");
  return { ctx: context, projectId: opened.workspace.projectId, agentId, directory };
}

async function remember(agentId: string, args: Record<string, unknown>) {
  if (!context) throw new Error("Missing daemon");
  const mcp = new Client({ name: "coordinator-memory-test", version: "1.0.0" });
  const url = new URL(`http://127.0.0.1:${context.daemon.port}/mcp/agents`);
  url.searchParams.set("callerAgentId", agentId);
  await mcp.connect(new StreamableHTTPClientTransport(url));
  try {
    return await mcp.callTool({ name: "remember", arguments: args });
  } finally {
    await mcp.close();
  }
}

describe("coordinator memory through the daemon", () => {
  test("global user turns read newly edited personal memory and preserve plain chat text", async () => {
    const { ctx } = await startProject();
    const global = await ctx.client.enableGlobalCoordinator({ profile: { provider: "opencode" } });
    if (!global.agentId) throw new Error("Missing global coordinator");
    const manager = ctx.daemon.daemon.agentManager;
    await expect.poll(() => manager.hasInFlightRun(global.agentId!)).toBe(false);
    const target = { scope: "personal" as const };
    const original = await ctx.client.getCoordinatorMemory(target);
    const saved = await ctx.client.updateCoordinatorMemory({
      ...target,
      content: "Prefers concise replies.",
      expectedRevision: original.revision,
    });
    await ctx.client.sendMessage(global.agentId, "Summarize active projects one");
    await expect
      .poll(() => findPrompt("Summarize active projects one"))
      .toContain("Prefers concise replies.");
    await expect.poll(() => manager.hasInFlightRun(global.agentId!)).toBe(false);
    await ctx.client.updateCoordinatorMemory({
      ...target,
      content: "",
      expectedRevision: saved.revision,
    });
    await ctx.client.sendMessage(global.agentId, "Summarize active projects two");
    await expect
      .poll(() => findPrompt("Summarize active projects two"))
      .toContain("Personal memory (daemon):\n(empty)");
    expect(findPrompt("Summarize active projects two")).not.toContain("Prefers concise replies.");
  }, 60000);

  test("a personal memory deletion appears in the next wake and stale edits cannot overwrite a newer memory", async () => {
    const { ctx, projectId, agentId } = await startProject();
    const target = { scope: "personal-project" as const, projectId };
    const empty = await ctx.client.getCoordinatorMemory(target);
    expect(empty.content).toBe("");
    const saved = await ctx.client.updateCoordinatorMemory({
      ...target,
      content: "Prefers squash merges.",
      expectedRevision: empty.revision,
    });
    await ctx.daemon.daemon.coordinatorService.wakeProjectCoordinator(projectId, {
      key: "memory-before",
      reason: "memory-before",
    });
    await expect.poll(() => findPrompt("memory-before")).toContain("Prefers squash merges.");

    const tool = await remember(agentId, {
      scope: "personal-project",
      content: "Prefers short summaries.",
    });
    expect(tool.isError).not.toBe(true);
    await expect(
      ctx.client.updateCoordinatorMemory({
        ...target,
        content: "stale draft",
        expectedRevision: saved.revision,
      }),
    ).rejects.toThrow();
    const latest = await ctx.client.getCoordinatorMemory(target);
    expect(latest.content).toContain("Prefers short summaries.");
    const cleared = await ctx.client.updateCoordinatorMemory({
      ...target,
      content: "",
      expectedRevision: latest.revision,
    });
    expect(cleared.content).toBe("");
    await ctx.daemon.daemon.coordinatorService.wakeProjectCoordinator(projectId, {
      key: "memory-after",
      reason: "memory-after",
    });
    await expect.poll(() => findPrompt("memory-after")).toContain("memory-after");
    const after = findPrompt("memory-after")!;
    expect(after).not.toContain("Prefers squash merges.");
    expect(after).not.toContain("Prefers short summaries.");
  }, 60_000);

  test("remember defaults to personal and rejects personal preferences in team memory", async () => {
    const { ctx, agentId, projectId } = await startProject();
    const saved = await remember(agentId, { content: "I prefer concise summaries." });
    expect(saved.isError).not.toBe(true);
    const personal = await ctx.client.getCoordinatorMemory({ scope: "personal" });
    expect(personal.content).toContain("I prefer concise summaries.");
    expect(
      (await ctx.client.getCoordinatorMemory({ scope: "personal-project", projectId })).content,
    ).toBe("");
    const rejected = await remember(agentId, {
      scope: "team",
      content: "I prefer concise summaries.",
    });
    expect(rejected.isError).toBe(true);
  }, 60_000);
});
