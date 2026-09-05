import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDOFF_FROM_AGENT_ID_LABEL,
  HANDOFF_TO_AGENT_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { handoffAgent } from "./handoff-agent.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { archiveAgentCommand } from "./lifecycle-command.js";
import { startCreatedAgentInitialPrompt } from "./agent-prompt.js";
import { buildHandoffContext, handoffHistory, readHandoffPage } from "./handoff-context.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "paseo-handoff-"));
  const logger = createTestLogger();
  const agentStorage = new AgentStorage(join(root, "agents"), logger);
  const clients = createTestAgentClients();
  const agentManager = new AgentManager({ clients, registry: agentStorage, logger });
  cleanups.push(async () => {
    for (const record of await agentStorage.list())
      await agentManager.closeAgent(record.id).catch(() => undefined);
    await agentManager.flush();
    await agentStorage.flush();
    await rm(root, { recursive: true, force: true });
  });
  const source = await agentManager.createAgent({ provider: "claude", cwd: root }, undefined, {
    workspaceId: "handoff-workspace",
    initialTitle: "Investigate the failing build",
  });
  const deps = {
    agentManager,
    agentStorage,
    logger,
    getWorkspace: vi.fn(async () => ({ cwd: root, archivedAt: null as string | null })),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async () => ({ modeId: "default", featureValues: {} })),
    },
  };
  return { ...deps, deps, source, clients, root };
}

test("concurrent requests create one independent successor and preserve source history", async () => {
  const { deps, source, clients, agentManager, agentStorage } = await setup();
  await startCreatedAgentInitialPrompt({
    agentManager,
    agentId: source.id,
    prompt: "Investigate the failing build. Do not edit files.",
    logger: deps.logger,
    runOptions: { clientMessageId: "source-request" },
  });
  const targetCreate = vi.spyOn(clients.codex!, "createSession");
  const requests = Array.from({ length: 3 }, () =>
    handoffAgent(deps, {
      sourceAgentId: source.id,
      provider: "codex",
      briefing: "The lockfile is valid. Check the compiler next.",
    }),
  );
  const results = await Promise.all(requests);
  const target = results[0]!;
  expect(new Set(results.map((record) => record.id)).size).toBe(1);
  expect(targetCreate).toHaveBeenCalledTimes(1);
  expect(target.workspaceId).toBe(source.workspaceId);
  expect(target.cwd).toBe(source.cwd);
  expect(target.provider).toBe("codex");
  expect(target.labels[HANDOFF_FROM_AGENT_ID_LABEL]).toBe(source.id);
  expect(target.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
  expect((await agentStorage.get(source.id))?.labels[HANDOFF_TO_AGENT_ID_LABEL]).toBe(target.id);
  expect(agentManager.getAgent(source.id)).toBeNull();
  const state = await agentStorage.getHandoff(source.id);
  expect(state?.prompt).toContain("Do not edit files");
  expect(state?.prompt).toContain("Check the compiler next");
  expect(handoffHistory(state?.rows ?? [])).toContain("Investigate the failing build");
  expect((await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" })).id).toBe(
    target.id,
  );
  await expect(
    handoffAgent(deps, { sourceAgentId: source.id, provider: "claude" }),
  ).rejects.toThrow("already has a continuation");
  expect(targetCreate).toHaveBeenCalledTimes(1);
  await archiveAgentCommand(deps, source.id);
  expect((await agentStorage.get(target.id))?.archivedAt).toBeFalsy();
});

test("a failed shutdown never starts the successor and can be retried", async () => {
  const { deps, source, clients } = await setup();
  if (!source.session) throw new Error("missing source session");
  const close = vi
    .spyOn(source.session, "close")
    .mockRejectedValueOnce(new Error("tool still running"));
  const create = vi.spyOn(clients.codex!, "createSession");
  await expect(handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" })).rejects.toThrow(
    "tool still running",
  );
  expect(create).not.toHaveBeenCalled();
  expect(() => deps.agentManager.assertAgentCanAcceptPrompt(source.id)).toThrow("continued in");
  const target = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  expect(target.provider).toBe("codex");
  expect(close).toHaveBeenCalledTimes(2);
});

test("a failed provider start can be retried with a different configured provider", async () => {
  const { deps, source, clients } = await setup();
  vi.spyOn(clients.codex!, "createSession").mockRejectedValue(new Error("account unavailable"));
  await expect(handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" })).rejects.toThrow(
    "account unavailable",
  );
  const state = await deps.agentStorage.getHandoff(source.id);
  const target = await handoffAgent(deps, { sourceAgentId: source.id, provider: "opencode" });
  expect(target.id).toBe(state?.successorAgentId);
  expect(target.provider).toBe("opencode");
});

test("after a restart, the source cannot wake its old provider", async () => {
  const { deps, source, clients } = await setup();
  await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  const restarted = new AgentManager({ clients, registry: deps.agentStorage, logger: deps.logger });
  const resume = vi.spyOn(clients.claude!, "resumeSession");
  const create = vi.spyOn(clients.claude!, "createSession");
  await expect(ensureAgentLoaded(source.id, { ...deps, agentManager: restarted })).rejects.toThrow(
    "continued in",
  );
  expect(resume).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

test("archiving the workspace during handoff prevents prompt dispatch", async () => {
  const { deps, source } = await setup();
  deps.getWorkspace.mockResolvedValueOnce({ cwd: source.cwd, archivedAt: null });
  deps.getWorkspace.mockResolvedValue({ cwd: source.cwd, archivedAt: new Date().toISOString() });
  const stream = vi.spyOn(deps.agentManager, "streamAgent");
  await expect(handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" })).rejects.toThrow(
    "no longer active",
  );
  expect(stream).not.toHaveBeenCalled();
});

test("ambiguous prompt dispatch is never repeated", async () => {
  const { deps, source } = await setup();
  const target = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  const state = await deps.agentStorage.getHandoff(source.id);
  if (!state) throw new Error("missing state");
  await deps.agentStorage.saveHandoff({ ...state, phase: "dispatching" });
  const stream = vi.spyOn(deps.agentManager, "streamAgent");
  await expect(handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" })).rejects.toThrow(
    target.id,
  );
  expect(stream).not.toHaveBeenCalled();
});

test("different simultaneous selections are rejected instead of silently changing providers", async () => {
  const { deps, source } = await setup();
  const first = handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  await expect(
    handoffAgent(deps, { sourceAgentId: source.id, provider: "opencode" }),
  ).rejects.toThrow("different settings");
  expect((await first).provider).toBe("codex");
});

test("a created continuation resumes its saved prompt after a retry, unless the source is archived", async () => {
  const { deps, source } = await setup();
  deps.getWorkspace.mockResolvedValueOnce({ cwd: source.cwd, archivedAt: null });
  deps.getWorkspace.mockResolvedValue({ cwd: source.cwd, archivedAt: new Date().toISOString() });
  await expect(
    handoffAgent(deps, {
      sourceAgentId: source.id,
      provider: "codex",
      briefing: "Keep this saved briefing.",
    }),
  ).rejects.toThrow("no longer active");
  const state = await deps.agentStorage.getHandoff(source.id);
  expect(state?.phase).toBe("created");
  await archiveAgentCommand(deps, source.id);
  deps.getWorkspace.mockResolvedValue({ cwd: source.cwd, archivedAt: null });
  await expect(handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" })).rejects.toThrow(
    "Restore the source agent",
  );
  await deps.agentManager.unarchiveSnapshot(source.id);
  const target = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  expect(target.id).toBe(state?.successorAgentId);
  expect((await deps.agentStorage.getHandoff(source.id))?.phase).toBe("started");
  expect(JSON.stringify(await deps.agentManager.getTimelineRows(target.id))).toContain(
    "Keep this saved briefing",
  );
});

test("deleting the source removes the saved handoff and exported context", async () => {
  const { deps, source } = await setup();
  await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  const contextPath = deps.agentStorage.getHandoffContextPath(source.id);
  await deps.agentStorage.remove(source.id);
  expect(await deps.agentStorage.getHandoff(source.id)).toBeNull();
  await expect(readFile(contextPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(contextPath.replace(".context.json", ".json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("clients cannot forge continuation links", async () => {
  const { deps, source } = await setup();
  for (const label of [HANDOFF_FROM_AGENT_ID_LABEL, HANDOFF_TO_AGENT_ID_LABEL]) {
    await expect(
      deps.agentManager.setLabels(source.id, { [label]: "another-agent" }),
    ).rejects.toThrow("managed by Paseo");
  }
});

test("briefings stay bounded while paged history preserves all recorded context", async () => {
  const { source, agentStorage } = await setup();
  const record = await agentStorage.get(source.id);
  if (!record) throw new Error("missing record");
  const rows: AgentTimelineRow[] = Array.from({ length: 40 }, (_, index) => ({
    seq: index + 1,
    timestamp: new Date().toISOString(),
    item: { type: "user_message", text: `request ${index} ${"detail ".repeat(1000)}` },
  }));
  const context = buildHandoffContext({ source: record, rows });
  const history = handoffHistory(context.rows);
  expect(context.prompt.length).toBeLessThan(21000);
  let text = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page = readHandoffPage(history, offset, 777);
    text += page.text;
    offset = page.nextOffset;
  }
  expect(text).toBe(history);
  expect(text.split("\n")).toHaveLength(40);
  expect(text).toContain("request 0");
  expect(text).toContain("request 39");
});

test("successive briefings link earlier decisions without embedding generated prompts", async () => {
  const { source, agentStorage } = await setup();
  const record = await agentStorage.get(source.id);
  if (!record) throw new Error("missing record");
  record.labels[HANDOFF_FROM_AGENT_ID_LABEL] = "earlier-agent";
  const rows: AgentTimelineRow[] = [
    {
      seq: 1,
      timestamp: new Date().toISOString(),
      item: {
        type: "user_message",
        clientMessageId: "handoff:earlier",
        text: "Generated handoff instruction",
      },
    },
    {
      seq: 2,
      timestamp: new Date().toISOString(),
      item: {
        type: "user_message",
        clientMessageId: "continuation:reset",
        text: "Generated resume instruction",
      },
    },
    {
      seq: 3,
      timestamp: new Date().toISOString(),
      item: { type: "user_message", text: "Keep the original acceptance criteria." },
    },
  ];
  const context = buildHandoffContext({ source: record, rows });
  expect(context.prompt).toContain(
    "Read that agent's saved handoff for the original task and earlier decisions",
  );
  expect(context.prompt).toContain("earlier-agent");
  expect(context.prompt).toContain("Keep the original acceptance criteria.");
  expect(context.prompt).not.toContain("Generated handoff instruction");
  expect(context.prompt).not.toContain("Generated resume instruction");
  expect(context.rows).toEqual(rows);
});

test("the handoff skill tools use the same transition and expose context without runtime config", async () => {
  const { deps, source } = await setup();
  const providers = createProviderSnapshotManagerStub();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: source.workspaceId!,
    projectId: "test-project",
    cwd: source.cwd,
    kind: "directory",
    displayName: "Handoff",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const catalog = createPaseoToolCatalog({
    ...deps,
    providerSnapshotManager: providers.manager,
    callerAgentId: source.id,
    workspaceRegistry: {
      get: async () => workspace,
      list: async () => [workspace],
      upsert: async () => {},
    },
  });
  const handoff = catalog.getTool("handoff_agent");
  const read = catalog.getTool("read_agent_handoff");
  if (!handoff || !read) throw new Error("Handoff tools missing");
  const result = await handoff.handler(
    { agentId: source.id, provider: "opencode", briefing: "Keep the tests focused." },
    {},
  );
  const target = JSON.parse(result.content[0]?.text ?? "{}");
  expect(target.workspaceId).toBe(source.workspaceId);
  expect(
    (await deps.agentStorage.get(target.agentId))?.labels[PARENT_AGENT_ID_LABEL],
  ).toBeUndefined();
  const context = await read.handler(
    { agentId: source.id, part: "prompt", offset: 0, limit: 24000 },
    {},
  );
  expect(context.content[0]?.text).toContain("Keep the tests focused");
  const file = JSON.parse(
    await readFile(deps.agentStorage.getHandoffContextPath(source.id), "utf8"),
  );
  expect(file.prompt).toContain("Keep the tests focused");
  expect(file).not.toHaveProperty("config");
  expect(file).not.toHaveProperty("persistence");
});

test("deleting a successor releases its predecessor so the task can continue again", async () => {
  const { deps, source, agentManager, agentStorage } = await setup();
  const target = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  expect((await agentStorage.get(source.id))?.labels[HANDOFF_TO_AGENT_ID_LABEL]).toBe(target.id);
  await expect(ensureAgentLoaded(source.id, deps)).rejects.toThrow("continued in");
  await agentManager.releaseHandoffLink(target.id);
  await agentStorage.remove(target.id);
  expect((await agentStorage.get(source.id))?.labels[HANDOFF_TO_AGENT_ID_LABEL]).toBeUndefined();
  expect(await agentStorage.getHandoff(source.id)).toBeNull();
  // The task can start a fresh continuation rather than pointing at an agent that is gone.
  const replacement = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  expect(replacement.id).not.toBe(target.id);
});

test("a cancel before dispatch never claims the prompt is in flight", async () => {
  const { deps, source, agentStorage } = await setup();
  let sinceCreated = 0;
  let created = false;
  const execution = {
    operationId: "op-1",
    assertCurrent: async () => {
      if (!created) return;
      // Lose ownership on the last check before dispatch, once the successor already exists.
      sinceCreated += 1;
      if (sinceCreated >= 2) throw new Error("Continuation no longer owns this task");
    },
    onCreated: async () => {
      created = true;
    },
  };
  await expect(
    handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" }, execution),
  ).rejects.toThrow("no longer owns this task");
  const state = await agentStorage.getHandoff(source.id);
  expect(state?.phase).toBe("created");
  // A later retry resumes it instead of reporting an uncertain delivery.
  const target = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  expect(target.id).toBe(state?.successorAgentId);
  expect((await agentStorage.getHandoff(source.id))?.phase).toBe("started");
});

test("archiving still completes when the agent's provider has no registered client", async () => {
  const { source, agentManager, agentStorage } = await setup();
  await agentManager.closeAgent(source.id);
  agentManager.updateProviderRegistry({ providerDefinitions: {}, clients: {} });
  const record = await agentManager.archiveSnapshot(source.id, new Date().toISOString());
  expect(record.archivedAt).toBeTruthy();
  expect((await agentStorage.get(source.id))?.archivedAt).toBeTruthy();
});

test("a stale delete does not release a link the source already gave to another successor", async () => {
  const { deps, source, agentManager, agentStorage } = await setup();
  const first = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  await agentManager.releaseHandoffLink(first.id);
  await agentStorage.remove(first.id);
  const second = await handoffAgent(deps, { sourceAgentId: source.id, provider: "codex" });
  expect(second.id).not.toBe(first.id);
  // A delete of the first successor that lands now must not clear the second one's link.
  await agentManager.releaseHandoffLink(first.id);
  expect((await agentStorage.get(source.id))?.labels[HANDOFF_TO_AGENT_ID_LABEL]).toBe(second.id);
  expect((await agentStorage.getHandoff(source.id))?.successorAgentId).toBe(second.id);
});
