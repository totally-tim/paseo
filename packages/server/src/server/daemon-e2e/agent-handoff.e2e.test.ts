import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HANDOFF_FROM_AGENT_ID_LABEL,
  HANDOFF_TO_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("the client continues across providers and reads the stopped conversation after daemon restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "handoff-daemon-"));
  const clients = createTestAgentClients();
  const options = {
    paseoHomeRoot: root,
    staticDir: join(root, "static"),
    cleanup: false,
    agentClients: clients,
  };
  let ctx = await createDaemonTestContext(options);
  try {
    const source = await ctx.client.createAgent({
      provider: "claude",
      cwd: root,
      initialPrompt: "Investigate only. Preserve the current files.",
      clientMessageId: "original-handoff-task",
    });
    await ctx.client.waitForFinish(source.id, 10000);
    const targets = await Promise.all([
      ctx.client.handoffAgent({
        sourceAgentId: source.id,
        provider: "codex",
        briefing: "Check the compiler next.",
      }),
      ctx.client.handoffAgent({
        sourceAgentId: source.id,
        provider: "codex",
        briefing: "Check the compiler next.",
      }),
    ]);
    const target = targets[0]!;
    expect(target.id).toBe(targets[1]?.id);
    expect(target.provider).toBe("codex");
    expect(target.workspaceId).toBe(source.workspaceId);
    expect(target.labels[HANDOFF_FROM_AGENT_ID_LABEL]).toBe(source.id);
    await ctx.client.waitForFinish(target.id, 10000);
    const successorHistory = await ctx.client.fetchAgentTimeline(target.id);
    expect(JSON.stringify(successorHistory.entries)).toContain("Investigate only");
    const history = await ctx.client.fetchAgentTimeline(source.id);
    expect(history.agent?.labels[HANDOFF_TO_AGENT_ID_LABEL]).toBe(target.id);
    expect(JSON.stringify(history.entries)).toContain("Preserve the current files");
    expect(ctx.daemon.daemon.agentManager.getAgent(source.id)).toBeNull();

    await ctx.cleanup();
    const resume = vi.spyOn(clients.claude!, "resumeSession");
    ctx = await createDaemonTestContext(options);
    const restored = await ctx.client.fetchAgentTimeline(source.id);
    expect(JSON.stringify(restored.entries)).toContain("Preserve the current files");
    expect(restored.entries.length).toBe(history.entries.length);
    expect(resume).not.toHaveBeenCalled();
    await expect(ctx.client.sendMessage(source.id, "Run again")).rejects.toThrow("continued in");
    expect(resume).not.toHaveBeenCalled();
  } finally {
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
