import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { handoffAgent } from "../agent/handoff-agent.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { HANDOFF_FROM_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { ProviderAccountStore } from "../provider-accounts/account-store.js";
import { ProviderAccountService } from "../provider-accounts/account-service.js";
import { AgentContinuationStore } from "./store.js";
import { AgentContinuationService } from "./service.js";
import type { AgentStreamEvent, AgentClient } from "../agent/agent-sdk-types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup(input: { close?: () => Promise<void> } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-continuation-"));
  const logger = createTestLogger();
  let now = Date.parse("2026-09-05T10:00:00Z");
  const used = new Map<string, number>();
  const starts: Array<{ accountId: string; prompt: string }> = [];
  const emitters = new Map<string, (event: AgentStreamEvent) => void>();
  const accounts = new ProviderAccountService(
    new ProviderAccountStore(directory),
    (account) => ({
      inspect: async () => ({ key: account.id }),
      login: async () => ({ key: account.id }),
      logout: async () => {},
      usage: async () => ({
        providerId: account.provider,
        displayName: account.label,
        status: "available",
        planLabel: null,
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            usedPct: used.get(account.id) ?? 100,
            resetsAt: new Date(now + 60_000).toISOString(),
          },
        ],
      }),
    }),
    () => now,
  );
  await accounts.initialize();
  const add = async (label: string) => {
    const account = await accounts.add("codex", label);
    await accounts.inspect(account.id);
    used.set(account.id, 10);
    return account.id;
  };
  const a = await add("A");
  const b = await add("B");
  const agentStorage = new AgentStorage(path.join(directory, "agents"), logger);
  const clients = new Map<string, AgentClient>();
  const agentManager = new AgentManager({
    providerDefinitions: {
      codex: {
        enabled: true,
        validateOptions: (options) => options,
        applyToolPolicy: (config) => config,
      },
    },
    clients: createTestAgentClients(),
    registry: agentStorage,
    logger,
    accounts,
    createAccountClient: (provider, context) => {
      let client = clients.get(context.accountId);
      if (client) return client;
      client = createTestAgentClient(provider, {
        closeSession: context.accountId === a ? input.close : undefined,
        onStartTurn: (prompt) =>
          starts.push({ accountId: context.accountId, prompt: JSON.stringify(prompt) }),
      });
      const create = client.createSession.bind(client);
      vi.spyOn(client, "createSession").mockImplementation(async (...args) => {
        const session = await create(...args);
        const listeners = new Set<(event: AgentStreamEvent) => void>();
        const subscribe = session.subscribe.bind(session);
        vi.spyOn(session, "subscribe").mockImplementation((listener) => {
          listeners.add(listener);
          const stop = subscribe(listener);
          return () => {
            listeners.delete(listener);
            stop();
          };
        });
        emitters.set(context.accountId, (event) => {
          for (const listener of listeners) listener(event);
        });
        return session;
      });
      clients.set(context.accountId, client);
      return client;
    },
  });
  const hooks: { beforeWorkspaceLookup?: () => Promise<void> } = {};
  const deps = {
    agentManager,
    agentStorage,
    accounts,
    logger,
    getWorkspace: async () => {
      await hooks.beforeWorkspaceLookup?.();
      return { cwd: directory };
    },
    providerSnapshotManager: {
      resolveCreateConfig: async (value: {
        requestedMode?: string;
        featureValues?: Record<string, unknown>;
      }) => ({
        modeId: value.requestedMode ?? "default",
        featureValues: value.featureValues ?? {},
      }),
    },
    now: () => now,
    timers: false,
  };
  const services: AgentContinuationService[] = [];
  const startService = async () => {
    const store = new AgentContinuationStore(directory);
    const service = new AgentContinuationService({ ...deps, store });
    agentManager.continuations = service;
    services.push(service);
    await service.initialize();
    return { service, store };
  };
  const { service, store } = await startService();
  cleanup.push(async () => {
    for (const item of services) await item.close();
    for (const agent of agentManager.listAgents())
      await agentManager.closeAgent(agent.id).catch(() => undefined);
    await agentManager.flush();
    await accounts.close();
    await agentStorage.flush();
    await rm(directory, { recursive: true, force: true });
  });
  const source = await agentManager.createAgent(
    {
      provider: "codex",
      cwd: directory,
      accountSelection: { kind: "fixed", accountId: a },
      continuationPolicy: { accountIds: [a, b] },
      modeId: "default",
      systemPrompt: "Investigate only",
      featureValues: { test_feature: true },
      providerOptions: { approval_policy: "on-request" },
      toolPolicy: { preapproved: [] },
    },
    randomUUID(),
    { workspaceId: "workspace" },
  );
  used.set(a, 100);
  return {
    ...deps,
    directory,
    service,
    store,
    source,
    a,
    b,
    used,
    starts,
    clients,
    emitters,
    hooks,
    startService,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("a live confirmed limit continues once with the effective configuration and one ordered host queue", async () => {
  const f = await setup();
  const capacity: AgentStreamEvent = {
    type: "timeline",
    provider: "codex",
    item: {
      type: "notification",
      code: "provider_capacity",
      level: "warning",
      message: "Usage limit reached",
    },
  };
  f.emitters.get(f.a)!({
    ...capacity,
    item: { type: "notification", level: "warning", message: "Approaching usage limit" },
  });
  await f.agentManager.flush();
  await f.service.flush();
  expect(f.starts).toHaveLength(0);
  f.emitters.get(f.a)!(capacity);
  f.emitters.get(f.a)!(capacity);
  await vi.waitFor(() => expect(f.store.forAgent(f.source.id)?.recovery).toBeTruthy());
  const message = {
    id: "queued-one",
    text: "Then inspect the tests",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  };
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await f.service.flush();
  await vi.waitFor(() =>
    expect(f.starts.filter((entry) => entry.prompt.includes(message.text))).toHaveLength(1),
  );
  const snapshot = await f.service.inspect(f.source.id);
  expect(snapshot, JSON.stringify({ snapshot, starts: f.starts })).toMatchObject({
    continuation: { status: "active" },
  });
  expect(snapshot.agentId).not.toBe(f.source.id);
  expect((await f.agentStorage.get(snapshot.agentId))?.config).toMatchObject({
    accountId: f.b,
    modeId: "default",
    systemPrompt: "Investigate only",
    featureValues: { test_feature: true },
    providerOptions: { approval_policy: "on-request" },
    toolPolicy: { preapproved: [] },
    continuationPolicy: { accountIds: [f.a, f.b] },
  });
  expect((await f.agentStorage.list()).length).toBe(2);
  expect(f.starts[0]?.prompt).not.toContain(message.text);
  expect(f.starts[1]?.prompt).toContain("aGVsbG8=");
  expect(f.accounts.hasRuntime(f.a)).toBe(false);
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await f.service.flush();
  expect(f.starts.filter((entry) => entry.prompt.includes(message.text))).toHaveLength(1);
});

test("exhausted accounts wait across restart, retain edits and attachments, and later continue", async () => {
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("waiting");
  expect(f.agentManager.getAgent(f.source.id)).toBeNull();
  const message = {
    id: "later",
    text: "Original queued instruction",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  };
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await f.service.manageQueue(f.source.id, {
    kind: "edit",
    revision: 1,
    message: { ...message, text: "Edited queued instruction" },
  });
  await f.service.close();
  const restart = await f.startService();
  await restart.service.flush();
  expect((await restart.service.inspect(f.source.id)).queuedMessages[0]).toMatchObject({
    text: "Edited queued instruction",
    revision: 2,
  });
  f.used.set(f.b, 10);
  f.advance(61_000);
  restart.service.wake(f.source.id);
  await restart.service.flush();
  await vi.waitFor(() =>
    expect(
      f.starts.filter((entry) => entry.prompt.includes("Edited queued instruction")),
    ).toHaveLength(1),
  );
});

test("Stop fences a recovery even when a fresh usage read is still pending", async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const choose = f.accounts.recoveryChoice.bind(f.accounts);
  vi.spyOn(f.accounts, "recoveryChoice").mockImplementation(async (input) => {
    await gate;
    return choose(input);
  });
  await f.service.reportCapacity(f.source.id, "limit");
  await vi.waitFor(() => expect(f.accounts.recoveryChoice).toHaveBeenCalled());
  await f.agentManager.cancelContinuation(f.source.id);
  release();
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("cancelled");
  expect(f.starts).toHaveLength(0);
  expect((await f.agentStorage.list()).length).toBe(1);
  await f.service.close();
  const restart = await f.startService();
  f.advance(1_000_000);
  restart.service.wake(f.source.id);
  await restart.service.flush();
  expect(f.starts).toHaveLength(0);
});

test("a failed source shutdown pauses recovery without creating a successor", async () => {
  const f = await setup({
    close: async () => {
      throw new Error("shutdown not acknowledged");
    },
  });
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("attention");
  expect((await f.agentStorage.list()).length).toBe(1);
  expect(f.starts).toHaveLength(0);
});

test("an uncertain queued dispatch is never sent automatically after restart", async () => {
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  await f.service.manageQueue(f.source.id, {
    kind: "enqueue",
    message: { id: "uncertain", text: "Create one invoice" },
  });
  await f.store.update(f.source.id, (record) => {
    record.queue[0].status = "dispatching";
  });
  await f.service.close();
  const restarted = await f.startService();
  await restarted.service.flush();
  expect((await restarted.service.inspect(f.source.id)).queuedMessages[0].status).toBe("attention");
  f.used.set(f.b, 10);
  f.advance(1_000_000);
  restarted.service.wake(f.source.id);
  await restarted.service.flush();
  expect(f.starts).toHaveLength(0);
});

test("manual handoff shares successor ownership and archiving a predecessor leaves it active", async () => {
  const f = await setup();
  const input = {
    sourceAgentId: f.source.id,
    provider: "codex",
    accountSelection: { kind: "fixed" as const, accountId: f.b },
  };
  const [first, second] = await Promise.all([handoffAgent(f, input), handoffAgent(f, input)]);
  expect(first.id).toBe(second.id);
  expect((await handoffAgent(f, input)).id).toBe(first.id);
  await f.agentManager.archiveSnapshot(f.source.id, new Date().toISOString());
  expect((await f.service.inspect(first.id)).continuation?.status).not.toBe("cancelled");
});

test("a saved created successor is resumed once after restart", async () => {
  const f = await setup();
  const execution = {
    unattended: true,
    preserveConfiguration: true,
    onCreated: async () => {
      throw new Error("simulated restart before linking");
    },
  };
  const input = {
    sourceAgentId: f.source.id,
    provider: "codex",
    continuationPolicy: { accountIds: [f.a, f.b] },
    accountSelection: { kind: "fixed" as const, accountId: f.b },
  };
  await expect(handoffAgent(f, input, execution)).rejects.toThrow("simulated restart");
  const journal = await f.agentStorage.getHandoff(f.source.id);
  expect(journal?.phase).toBe("created");
  await f.service.inspect(f.source.id);
  await f.store.update(f.source.id, (record) => {
    record.recovery = {
      rootAgentId: record.rootAgentId,
      agentId: record.agentId,
      sourceAgentId: record.agentId,
      operationId: randomUUID(),
      eventId: "limit",
      attempts: [f.a, f.b],
      status: "continuing",
      updatedAt: new Date(f.now()).toISOString(),
      reason: "Capacity limit",
    };
  });
  await f.service.close();
  const restart = await f.startService();
  await restart.service.flush();
  expect((await restart.service.inspect(f.source.id)).agentId).toBe(journal?.successorAgentId);
  expect(f.starts).toHaveLength(1);
  expect((await f.agentStorage.list()).length).toBe(2);
});

test("queued uploads belong to the host queue after their original upload is removed", async () => {
  const { writeFile, unlink, readFile } = await import("node:fs/promises");
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  const upload = path.join(f.directory, "uploaded.txt");
  await writeFile(upload, "retained");
  const message = {
    id: "file",
    text: "Read the attachment",
    attachments: [
      {
        type: "uploaded_file" as const,
        id: "upload",
        path: upload,
        fileName: "uploaded.txt",
        mimeType: "text/plain",
        size: 8,
      },
    ],
  };
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await unlink(upload);
  await f.service.close();
  const restart = await f.startService();
  // Lost acknowledgements remain idempotent even when the upload no longer exists.
  const retried = await restart.service.manageQueue(f.source.id, { kind: "enqueue", message });
  const retained = retried.queuedMessages[0].attachments?.[0];
  expect(retained?.type).toBe("uploaded_file");
  if (retained?.type !== "uploaded_file") throw new Error("Expected file");
  expect(await readFile(retained.path, "utf8")).toBe("retained");
  expect(retried.queuedMessages).toHaveLength(1);
});

test("manual takeover during a capacity read does not deadlock or create two successors", async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const choose = f.accounts.recoveryChoice.bind(f.accounts);
  vi.spyOn(f.accounts, "recoveryChoice").mockImplementationOnce(async (input) => {
    await gate;
    return choose(input);
  });
  await f.service.reportCapacity(f.source.id, "limit");
  await vi.waitFor(() => expect(f.accounts.recoveryChoice).toHaveBeenCalled());
  const manual = handoffAgent(f, {
    sourceAgentId: f.source.id,
    provider: "codex",
    accountSelection: { kind: "fixed", accountId: f.b },
  });
  await vi.waitFor(() => expect(f.store.forAgent(f.source.id)?.recovery?.status).toBe("cancelled"));
  release();
  const successor = await manual;
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).agentId).toBe(successor.id);
  expect(await f.agentStorage.list()).toHaveLength(2);
  expect(f.starts).toHaveLength(1);
});

test("the original session resumes after renewed capacity without creating a successor", async () => {
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("waiting");
  f.used.set(f.a, 10);
  f.advance(61_000);
  f.service.wake(f.source.id);
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).agentId).toBe(f.source.id);
  expect(await f.agentStorage.list()).toHaveLength(1);
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0].accountId).toBe(f.a);
});

test("Stop during successor creation retains one stopped successor without dispatching", async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = f.agentManager.createAgent.bind(f.agentManager);
  vi.spyOn(f.agentManager, "createAgent").mockImplementationOnce(async (...args) => {
    await gate;
    return create(...args);
  });
  await f.service.reportCapacity(f.source.id, "limit");
  await vi.waitFor(() => expect(f.agentManager.createAgent).toHaveBeenCalled());
  await f.service.cancelExisting(f.source.id);
  release();
  await f.service.flush();
  const snapshot = await f.service.inspect(f.source.id);
  expect(snapshot.continuation?.status).toBe("cancelled");
  expect(snapshot.agentId).not.toBe(f.source.id);
  expect(f.starts).toHaveLength(0);
  expect(await f.agentStorage.list()).toHaveLength(2);
});

test("a pending permission pauses recovery without interrupting the source", async () => {
  const f = await setup();
  const live = f.agentManager.getAgent(f.source.id)!;
  live.pendingPermissions.set("approval", {
    id: "approval",
    provider: "codex",
    name: "shell",
    kind: "tool",
  });
  const stop = vi.spyOn(f.agentManager, "suspendForContinuation");
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation).toMatchObject({
    status: "attention",
    reason: "Resolve the pending permission before continuing.",
  });
  expect(stop).not.toHaveBeenCalled();
  expect(live.pendingPermissions.has("approval")).toBe(true);
});

test("an unresolved tool outcome pauses recovery after shutdown", async () => {
  const f = await setup();
  vi.spyOn(f.agentManager, "readHandoffTimeline").mockResolvedValue([
    {
      id: "tool",
      seq: 1,
      timestamp: new Date(f.now()).toISOString(),
      item: {
        type: "tool_call",
        callId: "write",
        name: "shell",
        status: "running",
        detail: "Writing a file",
      },
    },
  ] as never);
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("attention");
  expect(f.starts).toHaveLength(0);
});

test("Stop fences only the interrupted turn; a later turn's confirmed limit recovers again", async () => {
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit-1", "turn-1");
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("waiting");
  await f.agentManager.cancelContinuation(f.source.id);
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("cancelled");
  f.used.set(f.b, 10);
  // A rejection with no turn identity cannot prove it came from new work.
  await f.service.reportCapacity(f.source.id, "limit-1-late");
  await f.service.flush();
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("cancelled");
  expect(f.starts).toHaveLength(0);
  // The user prompted again and that turn hit the limit: the policy still applies.
  await f.service.reportCapacity(f.source.id, "limit-2", "turn-2");
  await f.service.flush();
  const snapshot = await f.service.inspect(f.source.id);
  expect(snapshot.continuation).toMatchObject({ status: "active", accountId: f.b });
  expect(snapshot.agentId).not.toBe(f.source.id);
  expect(f.starts).toHaveLength(1);
});

test("Stop fences the turn it interrupted but not the next turn's own rejection", async () => {
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit-1", "turn-1");
  await f.service.flush();
  await f.agentManager.cancelContinuation(f.source.id);
  // The live turn identity is captured at cancel time; pin it here to make the fence explicit.
  await f.store.update(f.source.id, (record) => {
    record.recovery!.cancelledTurnId = "turn-1";
  });
  f.used.set(f.b, 10);
  await f.service.reportCapacity(f.source.id, "limit-1-late", "turn-1");
  expect(f.store.forAgent(f.source.id)?.recovery?.status).toBe("cancelled");
  await f.service.reportCapacity(f.source.id, "limit-2", "turn-2");
  expect(f.store.forAgent(f.source.id)?.recovery).toMatchObject({
    status: "continuing",
    eventId: "limit-2",
  });
  await f.service.flush();
});

test("a replayed enqueue acknowledgement does not resume a stopped queue", async () => {
  const f = await setup();
  const message = { id: "first", text: "Queued before Stop" };
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await f.service.flush();
  await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  const later = { id: "second", text: "Queued after the turn" };
  await f.agentManager.cancelContinuation(f.source.id);
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message: later });
  await f.service.flush();
  await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  await f.agentManager.cancelContinuation(f.source.id);
  expect(f.store.forAgent(f.source.id)?.queuePaused).toBe(true);
  // A lost acknowledgement retried after Stop replays the receipt and inserts nothing.
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await f.service.flush();
  expect(f.store.forAgent(f.source.id)?.queuePaused).toBe(true);
  expect(f.starts).toHaveLength(2);
});

test("concurrent Send now requests deliver the instruction once", async () => {
  const f = await setup();
  await f.agentManager.cancelContinuation(f.source.id);
  const message = { id: "now", text: "Send this immediately" };
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await f.service.flush();
  await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  await f.agentManager.cancelContinuation(f.source.id);
  const queued = { id: "second", text: "Queued while stopped" };
  await f.store.update(f.source.id, (record) => {
    record.queue.push({
      ...queued,
      status: "queued",
      revision: 1,
      createdAt: "2026-09-05T00:00:00Z",
    });
    record.receipts[queued.id] = { digest: "x", outcome: "queued" };
    record.queuePaused = true;
  });
  const cancel = vi.spyOn(f.agentManager, "cancelAgentRun");
  const results = await Promise.allSettled([
    f.service.manageQueue(f.source.id, { kind: "send_now", messageId: queued.id }),
    f.service.manageQueue(f.source.id, { kind: "send_now", messageId: queued.id }),
  ]);
  expect(results.map((entry) => entry.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(f.starts.filter((entry) => entry.prompt.includes(queued.text))).toHaveLength(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

test("automatic delivery never interrupts a turn that started during dispatch", async () => {
  const f = await setup();
  await f.agentManager.cancelContinuation(f.source.id);
  f.hooks.beforeWorkspaceLookup = async () => {
    f.hooks.beforeWorkspaceLookup = undefined;
    await sendPromptToAgent({
      ...f,
      agentId: f.source.id,
      prompt: "sleep",
      unarchive: false,
      clearPendingPermissions: false,
    });
    await vi.waitFor(() =>
      expect(f.agentManager.getAgent(f.source.id)?.activeForegroundTurnId).toBeTruthy(),
    );
  };
  const message = { id: "later", text: "Queued behind the human prompt" };
  await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  await f.service.flush();
  const record = f.store.forAgent(f.source.id)!;
  expect(record.queue[0]).toMatchObject({ id: "later", status: "queued" });
  expect(record.queuePaused).toBe(false);
  expect(f.starts.map((entry) => entry.prompt)).toEqual([expect.stringContaining("sleep")]);
  expect(f.agentManager.getAgent(f.source.id)?.activeForegroundTurnId).toBeTruthy();
});

test("a Stop that lands while Continue with waits for the lock wins", async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const choose = f.accounts.recoveryChoice.bind(f.accounts);
  vi.spyOn(f.accounts, "recoveryChoice").mockImplementationOnce(async (input) => {
    await gate;
    return choose(input);
  });
  await f.service.reportCapacity(f.source.id, "limit");
  await vi.waitFor(() => expect(f.accounts.recoveryChoice).toHaveBeenCalled());
  const manual = handoffAgent(f, {
    sourceAgentId: f.source.id,
    provider: "codex",
    accountSelection: { kind: "fixed", accountId: f.b },
  });
  await vi.waitFor(() => expect(f.store.forAgent(f.source.id)?.recovery?.status).toBe("cancelled"));
  await f.agentManager.cancelContinuation(f.source.id);
  release();
  await expect(manual).rejects.toThrow("cancelled before it started");
  await f.service.flush();
  expect(await f.agentStorage.list()).toHaveLength(1);
  expect(f.starts).toHaveLength(0);
});

test("Retry delivers a created successor that Stop left without its briefing", async () => {
  const f = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = f.agentManager.createAgent.bind(f.agentManager);
  vi.spyOn(f.agentManager, "createAgent").mockImplementationOnce(async (...args) => {
    await gate;
    return create(...args);
  });
  await f.service.reportCapacity(f.source.id, "limit");
  await vi.waitFor(() => expect(f.agentManager.createAgent).toHaveBeenCalled());
  await f.service.cancelExisting(f.source.id);
  release();
  await f.service.flush();
  const stopped = await f.service.inspect(f.source.id);
  expect(stopped.continuation?.status).toBe("cancelled");
  expect(f.starts).toHaveLength(0);
  const successor = await handoffAgent(f, {
    sourceAgentId: f.source.id,
    provider: "codex",
    accountSelection: { kind: "fixed", accountId: f.b },
  });
  expect(successor.id).toBe(stopped.agentId);
  expect(f.starts).toHaveLength(1);
  expect((await f.service.inspect(f.source.id)).continuation?.status).toBe("active");
  expect(await f.agentStorage.list()).toHaveLength(2);
});

test("inspecting a successor before it is linked joins its predecessor's task", async () => {
  const f = await setup();
  await f.service.inspect(f.source.id);
  const successor = await f.agentManager.createAgent(
    { provider: "codex", cwd: f.directory, accountSelection: { kind: "fixed", accountId: f.b } },
    randomUUID(),
    { workspaceId: "workspace", labels: { [HANDOFF_FROM_AGENT_ID_LABEL]: f.source.id } },
  );
  const snapshot = await f.service.inspect(successor.id);
  expect(snapshot.rootAgentId).toBe(f.source.id);
  expect(f.store.list().map((record) => record.rootAgentId)).toEqual([f.source.id]);
});

test("each predecessor reports when it stopped owning the task", async () => {
  const f = await setup();
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  const successor = (await f.service.inspect(f.source.id)).agentId;
  expect(successor).not.toBe(f.source.id);
  expect((await f.service.inspect(f.source.id)).retiredAt).toBe(new Date(f.now()).toISOString());
  expect((await f.service.inspect(successor)).retiredAt).toBeNull();
});

test("cancelling a queued upload releases its retained copy, and deleting the task forgets it", async () => {
  const { writeFile, stat, readdir } = await import("node:fs/promises");
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  const upload = path.join(f.directory, "uploaded.txt");
  await writeFile(upload, "retained");
  const message = {
    id: "file",
    text: "Read the attachment",
    attachments: [
      {
        type: "uploaded_file" as const,
        id: "upload",
        path: upload,
        fileName: "uploaded.txt",
        mimeType: "text/plain",
        size: 8,
      },
    ],
  };
  const queued = await f.service.manageQueue(f.source.id, { kind: "enqueue", message });
  const retained = queued.queuedMessages[0].attachments?.[0];
  if (retained?.type !== "uploaded_file") throw new Error("Expected file");
  expect((await stat(retained.path)).size).toBe(8);
  await f.service.manageQueue(f.source.id, { kind: "cancel", messageId: "file" });
  await expect(stat(retained.path)).rejects.toThrow();
  await f.service.forget(f.source.id);
  expect(f.store.forAgent(f.source.id)).toBeUndefined();
  expect(await readdir(path.join(f.directory, "agent-continuations"))).toEqual([]);
});

test("recovery skips a destination that cannot run the model and keeps searching", async () => {
  const f = await setup();
  const c = await f.accounts.add("codex", "C");
  await f.accounts.inspect(c.id);
  f.used.set(c.id, 20);
  // B has the most remaining quota but does not offer the running model; C does.
  f.used.set(f.b, 5);
  await f.agentStorage.upsert({
    ...(await f.agentStorage.get(f.source.id))!,
    config: {
      ...(await f.agentStorage.get(f.source.id))!.config,
      model: "test-model",
      continuationPolicy: { accountIds: [f.a, f.b, c.id] },
    },
  });
  const stored = (await f.agentStorage.get(f.source.id))!;
  const running = stored.runtimeInfo?.model ?? stored.config?.model;
  vi.spyOn(f.agentManager, "getAccountCatalog").mockImplementation(async (input) => ({
    entry:
      input.selection?.kind === "fixed" && input.selection.accountId === f.b
        ? { models: [{ provider: "codex", id: "other-model", label: "Other" }] }
        : { models: [{ provider: "codex", id: running!, label: "Running" }] },
  }));
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  const snapshot = await f.service.inspect(f.source.id);
  expect(snapshot.continuation).toMatchObject({ status: "active", accountId: c.id });
  expect(snapshot.agentId).not.toBe(f.source.id);
});

test("a rejection with no reported reset waits with a growing backoff instead of re-prompting", async () => {
  const f = await setup();
  // Both accounts report a limit the provider gave no reset time for.
  await f.accounts.reportCapacity(f.a);
  await f.accounts.reportCapacity(f.b);
  await f.service.reportCapacity(f.source.id, "limit-1");
  await f.service.flush();
  const first = f.store.forAgent(f.source.id)!.recovery!;
  expect(first.status).toBe("waiting");
  expect(f.starts).toHaveLength(0);
  // The wait wakes, finds the same rejection, and must back off rather than retry immediately.
  f.advance(61_000);
  f.service.wake(f.source.id);
  await f.service.flush();
  const second = f.store.forAgent(f.source.id)!.recovery!;
  expect(second.status).toBe("waiting");
  expect(second.backoffMs!).toBeGreaterThan(first.backoffMs!);
  expect(f.starts).toHaveLength(0);
});

test("a fenced capacity event still stops the queue for the turn that failed", async () => {
  const f = await setup();
  await f.agentManager.cancelContinuation(f.source.id);
  await f.store.update(f.source.id, (record) => {
    record.recovery!.cancelledTurnId = "turn-1";
    record.queuePaused = false;
  });
  await f.service.manageQueue(f.source.id, {
    kind: "enqueue",
    message: { id: "after", text: "Runs after the failed turn" },
  });
  await f.service.flush();
  await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  await f.store.update(f.source.id, (record) => {
    record.queue.push({
      id: "next",
      text: "Must not be sent into the exhausted account",
      status: "queued",
      revision: 1,
      createdAt: "2026-09-05T00:00:00Z",
    });
    record.receipts.next = { digest: "x", outcome: "queued" };
  });
  // The live turn is the one an earlier Stop fenced, so no episode opens; its failure must
  // still stop the queue rather than being swallowed by the suppressed terminal event.
  // Settle the dispatched turn first, so the notification's turn identity is deterministic.
  await vi.waitFor(() =>
    expect(f.agentManager.getAgent(f.source.id)?.activeForegroundTurnId ?? null).toBeNull(),
  );
  await f.store.update(f.source.id, (record) => {
    record.recovery!.cancelledTurnId = "turn-1";
  });
  f.emitters.get(f.a)!({
    type: "timeline",
    provider: "codex",
    turnId: "turn-1",
    item: {
      type: "notification",
      code: "provider_capacity",
      level: "warning",
      message: "Usage limit reached",
    },
  });
  await f.agentManager.flush();
  await f.service.flush();
  await vi.waitFor(() => expect(f.store.forAgent(f.source.id)?.queuePaused).toBe(true));
  expect(f.store.forAgent(f.source.id)?.queuePaused).toBe(true);
  expect(f.starts.filter((entry) => entry.prompt.includes("exhausted account"))).toHaveLength(0);
});

test("editing a queued upload releases the copy it replaced and keeps the one it sends", async () => {
  const { writeFile, stat, readdir } = await import("node:fs/promises");
  const f = await setup();
  f.used.set(f.b, 100);
  await f.service.reportCapacity(f.source.id, "limit");
  await f.service.flush();
  const first = path.join(f.directory, "first.txt");
  const second = path.join(f.directory, "second.txt");
  await writeFile(first, "original");
  await writeFile(second, "replaced");
  const attachment = (id: string, file: string) => ({
    type: "uploaded_file" as const,
    id,
    path: file,
    fileName: path.basename(file),
    mimeType: "text/plain",
    size: 8,
  });
  const queued = await f.service.manageQueue(f.source.id, {
    kind: "enqueue",
    message: { id: "file", text: "Read it", attachments: [attachment("one", first)] },
  });
  const before = queued.queuedMessages[0].attachments![0];
  if (before.type !== "uploaded_file") throw new Error("Expected file");
  await f.service.manageQueue(f.source.id, {
    kind: "edit",
    revision: 1,
    message: { id: "file", text: "Read this one", attachments: [attachment("two", second)] },
  });
  await expect(stat(before.path)).rejects.toThrow();
  const remaining = await readdir(path.join(f.directory, "agent-continuations", f.source.id));
  expect(remaining).toHaveLength(1);
  // The delivered copy survives dispatch: the prompt carries that path and the provider reads
  // the file while the turn runs. It is released when the task itself is forgotten.
  f.used.set(f.b, 10);
  f.advance(61_000);
  f.service.wake(f.source.id);
  await f.service.flush();
  await vi.waitFor(() =>
    expect(f.starts.filter((entry) => entry.prompt.includes("Read this one"))).toHaveLength(1),
  );
  expect(await readdir(path.join(f.directory, "agent-continuations", f.source.id))).toEqual(
    remaining,
  );
  await f.service.forget((await f.service.inspect(f.source.id)).agentId);
  expect(await readdir(path.join(f.directory, "agent-continuations"))).toEqual([]);
});

test("a delayed rejection from a stopped turn does not pause the next turn's queue", async () => {
  const f = await setup();
  await f.agentManager.cancelContinuation(f.source.id);
  await f.store.update(f.source.id, (record) => {
    record.recovery!.cancelledTurnId = "turn-1";
    record.queuePaused = false;
  });
  await f.service.manageQueue(f.source.id, {
    kind: "enqueue",
    message: { id: "next-turn", text: "Authorized after the stop" },
  });
  await f.service.flush();
  // The live agent is on a later turn; turn-1's notification arrives late.
  const live = f.agentManager.getAgent(f.source.id);
  expect(live?.activeForegroundTurnId ?? null).not.toBe("turn-1");
  f.emitters.get(f.a)!({
    type: "timeline",
    provider: "codex",
    turnId: "turn-1",
    item: {
      type: "notification",
      code: "provider_capacity",
      level: "warning",
      message: "Usage limit reached",
      turnId: "turn-1",
    },
  });
  await f.agentManager.flush();
  await f.service.flush();
  expect(f.store.forAgent(f.source.id)?.queuePaused).toBe(false);
});

test("a completed continuation starts the next episode without the old backoff", async () => {
  const f = await setup();
  await f.service.reportCapacity(f.source.id, "limit-1");
  await f.service.flush();
  await vi.waitFor(() => expect(f.store.forAgent(f.source.id)?.recovery?.status).toBe("active"));
  // An earlier wait had already grown the backoff to its cap.
  await f.store.update(f.source.id, (record) => {
    record.recovery!.backoffMs = 300_000;
  });
  f.emitters.get(f.b)!({ type: "turn_completed", provider: "codex" });
  await f.agentManager.flush();
  await f.service.flush();
  await vi.waitFor(() =>
    expect(f.store.forAgent(f.source.id)?.recovery?.backoffMs).toBeUndefined(),
  );
});
