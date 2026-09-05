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
  const deps = {
    agentManager,
    agentStorage,
    accounts,
    logger,
    getWorkspace: async () => ({ cwd: directory }),
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
