import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/provider";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";
import { PluginAgentClientRegistry } from "./plugin-provider.js";

const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.persistence",
  "session.subsession",
  "permission",
] as const;

interface ProviderHarnessOptions {
  capabilities?: ProviderConnection["capabilities"];
  completeTurn?: boolean;
  rootParentSessionId?: string;
  childRestoration?: "parent" | "core";
  holdInput?: ProviderInput["type"];
  sendGate?: Promise<void>;
}

function createProviderHarness(options: ProviderHarnessOptions = {}) {
  let listener: ((event: ProviderEvent) => void) | null = null;
  let closeCount = 0;
  const inputs: ProviderInput[] = [];
  const emit = (event: ProviderEvent) => listener?.(event);
  const capabilities = options.capabilities ?? CAPABILITIES;

  const connection: ProviderConnection = {
    version: 1,
    capabilities,
    async send(input) {
      inputs.push(input);
      if (input.type === options.holdInput) await options.sendGate;
      if (input.type === "catalog") {
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: {
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [{ id: "deep", label: "Deep" }],
            defaultModel: "plugin-model",
            defaultMode: "build",
            defaultThinkingOption: "deep",
          },
        });
        return;
      }
      if (input.type === "session.open") {
        emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          parentSessionId: options.rootParentSessionId,
          capabilities,
          restoration: "core",
          persistence: { version: 1, data: { token: "root" } },
          cwd: input.config.cwd,
        });
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            model: "plugin-model",
            mode: "build",
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [],
            settings: [
              {
                type: "select",
                id: "voice",
                label: "Voice",
                value: "direct",
                options: [{ label: "Direct", value: "direct" }],
              },
            ],
          },
        });
        emit({
          type: "session.opened",
          sessionId: "child-1",
          parentSessionId: input.sessionId,
          capabilities: [],
          restoration: options.childRestoration ?? "parent",
          title: "Plugin child",
          cwd: input.config.cwd,
        });
        emit({
          type: "timeline.item",
          sessionId: "child-1",
          item: { type: "assistant_message", id: "child-message", text: "Child result" },
        });
        emit({
          type: "session.turn",
          sessionId: "child-1",
          turnId: "child-turn",
          state: "completed",
        });
        emit({ type: "session.ready", sessionId: "child-1" });
        emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        return;
      }
      if (input.type === "session.prompt") {
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId: "turn-1" },
        });
        emit({
          type: "session.turn",
          sessionId: input.sessionId,
          turnId: "turn-1",
          state: "started",
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "answer", text: "Hel" },
        });
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: { type: "assistant_message", id: "answer", text: "Hello" },
        });
        emit({
          type: "session.permission",
          sessionId: input.sessionId,
          request: { id: "permission-1", name: "write", kind: "tool" },
        });
        if (options.completeTurn !== false) {
          emit({
            type: "session.turn",
            sessionId: input.sessionId,
            turnId: "turn-1",
            state: "completed",
          });
        }
        return;
      }
      if (input.type === "session.permission") {
        emit({
          type: "session.permission_resolved",
          sessionId: input.sessionId,
          permissionId: input.permissionId,
        });
        return;
      }
      if (input.type === "session.configure") {
        emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: {
            model: input.changes.model ?? "plugin-model",
            mode: "build",
            models: [{ id: "plugin-model", label: "Plugin model" }],
            modes: [{ id: "build", label: "Build" }],
            thinkingOptions: [],
            settings: [],
          },
        });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      if (input.type === "session.close") {
        emit({ type: "session.closed", sessionId: input.sessionId });
      }
      if ("requestId" in input) {
        emit({ type: "request.completed", requestId: input.requestId });
      }
    },
    onEvent(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async close() {
      closeCount += 1;
    },
  };

  const registration: ProviderRegistration = {
    id: "plugin-direct",
    label: "Plugin direct",
    async connect() {
      return connection;
    },
  };

  return { registration, inputs, emit, closeCount: () => closeCount };
}

function eventsOfType(events: AgentStreamEvent[], type: AgentStreamEvent["type"]) {
  return events.filter((event) => event.type === type);
}

describe("PluginAgentClientRegistry", () => {
  test.each(["catalog", "session.open", "session.prompt"] as const)(
    "rejects %s promptly when the provider closes during send",
    async (holdInput) => {
      const gate = Promise.withResolvers<void>();
      const harness = createProviderHarness({ holdInput, sendGate: gate.promise });
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([harness.registration]);
      const client = registry.clients()[harness.registration.id]!;
      const config = { provider: "plugin-direct", cwd: "/workspace" };
      const session = holdInput === "session.prompt" ? await client.createSession(config) : null;
      let request: Promise<unknown>;
      if (holdInput === "catalog") request = client.fetchCatalog!({ scope: "global" });
      else if (session) request = session.run("hello", { clientMessageId: "blocked-send" });
      else request = client.createSession(config);
      const outcome = request.then(
        () => "unexpected success",
        (error: Error) => error.message,
      );
      const isHeldInput = (input: ProviderInput) => input.type === holdInput;
      try {
        await expect.poll(() => harness.inputs.some(isHeldInput)).toBe(true);
        registry.replace([]);
        await expect(outcome).resolves.toMatch(/Provider.*closed/);
      } finally {
        gate.resolve();
        await outcome;
        await registry.shutdown();
      }
    },
  );

  test("opens an independently restored session whose provider parent is not open", async () => {
    const harness = createProviderHarness({ rootParentSessionId: "unopened-provider-parent" });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({ provider: "plugin-direct", cwd: "/workspace" });
    try {
      expect(session.describePersistence()).not.toBeNull();
      await expect(
        session.run("hello", { clientMessageId: "restored-message" }),
      ).resolves.toBeDefined();
    } finally {
      await session.close();
      await registry.shutdown();
    }
  });

  test("gates persistence operations on negotiated provider capabilities", async () => {
    const harness = createProviderHarness({ capabilities: ["session.persistence"] });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;

    await expect(client.isAvailable()).resolves.toBe(true);
    expect(client.capabilities).toMatchObject({
      supportsSessionPersistence: true,
      supportsSessionListing: false,
    });
    await expect(client.listImportableSessions?.()).resolves.toEqual([]);

    const persistence = {
      provider: harness.registration.id,
      sessionId: 'plugin:{"version":1,"data":{"token":"root"}}',
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "root" } } },
    };
    await expect(client.archiveNativeSession?.(persistence)).resolves.toBeUndefined();
    await expect(client.unarchiveNativeSession?.(persistence)).resolves.toBeUndefined();
    expect(harness.inputs).toEqual([]);
    await registry.shutdown();
  });

  test("terminalizes an active turn exactly once when its plugin provider is removed", async () => {
    const harness = createProviderHarness({ completeTurn: false });
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const session = await client.createSession({
      provider: harness.registration.id,
      cwd: "/workspace",
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const run = session.run("hello", { clientMessageId: "active-message" });
    void run.catch(() => undefined);
    await expect.poll(() => eventsOfType(events, "turn_started")).toHaveLength(1);

    registry.replace([]);

    await expect
      .poll(() => eventsOfType(events, "turn_failed"))
      .toEqual([
        expect.objectContaining({
          type: "turn_failed",
          provider: harness.registration.id,
          turnId: "turn-1",
          error: "Provider connection closed",
        }),
      ]);
    await expect(run).rejects.toThrow("Provider connection closed");
    await expect.poll(harness.closeCount).toBe(1);

    registry.replace([]);
    expect(eventsOfType(events, "turn_failed")).toHaveLength(1);
  });

  test.each([
    { closeOrder: "before", childRestoration: "parent" as const },
    { closeOrder: "after", childRestoration: "parent" as const },
    { closeOrder: "before", childRestoration: "core" as const },
    { closeOrder: "after", childRestoration: "core" as const },
  ])(
    "restores a $childRestoration child when closing the parent $closeOrder replacement opens",
    async ({ closeOrder, childRestoration }) => {
      const harness = createProviderHarness({ childRestoration });
      const registry = new PluginAgentClientRegistry(createTestLogger());
      registry.replace([harness.registration]);
      const client = registry.clients()[harness.registration.id]!;
      let session = await client.createSession({ provider: "plugin-direct", cwd: "/workspace" });
      const persistence = session.describePersistence()!;

      try {
        for (let reopen = 0; reopen < 3; reopen += 1) {
          const history: AgentStreamEvent[] = [];
          for await (const event of session.streamHistory()) history.push(event);
          expect(history).toContainEqual(
            expect.objectContaining({
              type: "provider_subagent",
              event: expect.objectContaining({
                type: "timeline",
                id: "child-1",
                item: expect.objectContaining({ text: "Child result" }),
              }),
            }),
          );
          expect(history).toContainEqual(
            expect.objectContaining({
              type: "provider_subagent",
              event: expect.objectContaining({
                type: "upsert",
                id: "child-1",
                status: "completed",
              }),
            }),
          );
          const previous = session;
          if (closeOrder === "before") await previous.close();
          session = await client.resumeSession(persistence, { cwd: "/workspace" });
          if (closeOrder === "after") await previous.close();
          expect(harness.inputs).not.toContainEqual(
            expect.objectContaining({ type: "session.close", sessionId: "child-1" }),
          );
          const events: AgentStreamEvent[] = [];
          const unsubscribe = session.subscribe((event) => events.push(event));
          harness.emit({
            type: "timeline.item",
            sessionId: "child-1",
            item: { type: "assistant_message", id: `restored-${reopen}`, text: "Still routed" },
          });
          unsubscribe();
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "provider_subagent",
              event: expect.objectContaining({
                type: "timeline",
                id: "child-1",
                item: expect.objectContaining({ text: "Still routed" }),
              }),
            }),
          );
        }
      } finally {
        await session.close();
        registry.replace([]);
      }
    },
  );

  test("keeps the original child reachable when a replacement is discarded", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id]!;
    const original = await client.createSession({ provider: "plugin-direct", cwd: "/workspace" });
    const events: AgentStreamEvent[] = [];
    const unsubscribe = original.subscribe((event) => events.push(event));
    try {
      const replacement = await client.resumeSession(original.describePersistence()!, {
        cwd: "/workspace",
      });
      await replacement.close();
      harness.emit({
        type: "timeline.item",
        sessionId: "child-1",
        item: { type: "assistant_message", id: "surviving-child", text: "Original child remains" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "provider_subagent",
          event: expect.objectContaining({
            type: "timeline",
            id: "child-1",
            item: expect.objectContaining({ text: "Original child remains" }),
          }),
        }),
      );
    } finally {
      unsubscribe();
      await original.close();
      registry.replace([]);
    }
  });

  test("adapts callback providers into the existing AgentClient and AgentSession path", async () => {
    const harness = createProviderHarness();
    const registry = new PluginAgentClientRegistry(createTestLogger());
    registry.replace([harness.registration]);
    const client = registry.clients()[harness.registration.id];
    expect(client).toBeDefined();

    await expect(client!.fetchCatalog({ scope: "global", force: false })).resolves.toMatchObject({
      models: [
        {
          provider: "plugin-direct",
          id: "plugin-model",
          isDefault: true,
          thinkingOptions: [{ id: "deep", label: "Deep" }],
          defaultThinkingOptionId: "deep",
        },
      ],
      modes: [{ id: "build" }],
      defaultModeId: "build",
    });

    const session = await client!.createSession({ provider: "plugin-direct", cwd: "/workspace" });
    expect(session.features).toEqual([
      expect.objectContaining({
        type: "select",
        id: "voice",
        options: [{ id: "direct", label: "Direct", value: "direct" }],
      }),
    ]);
    expect(session.describePersistence()).toMatchObject({
      provider: "plugin-direct",
      metadata: { pluginProviderPersistence: { version: 1, data: { token: "root" } } },
    });

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) history.push(event);
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "timeline", id: "child-1" }),
      }),
    );
    expect(history).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "upsert", id: "child-1", status: "completed" }),
      }),
    );

    const events: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    await expect(
      session.startTurn("hello", { clientMessageId: "client-message" }),
    ).resolves.toEqual({ turnId: "turn-1" });
    expect(
      events
        .filter((event) => event.type === "timeline")
        .map((event) => (event.type === "timeline" ? event.item : null)),
    ).toEqual([
      { type: "assistant_message", text: "Hel", messageId: "answer" },
      { type: "assistant_message", text: "lo", messageId: "answer" },
    ]);
    expect(session.getPendingPermissions()).toEqual([
      expect.objectContaining({ id: "permission-1", provider: "plugin-direct" }),
    ]);

    await session.respondToPermission("permission-1", { behavior: "allow" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        requestId: "permission-1",
        resolution: { behavior: "allow" },
      }),
    );
    await session.setModel?.("plugin-model");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "plugin-model",
      modeId: "build",
    });

    unsubscribe();
    await session.close();
    registry.replace([]);
    await expect.poll(harness.closeCount).toBe(1);
    expect(harness.inputs.map((input) => input.type)).toContain("session.close");
  });
});
