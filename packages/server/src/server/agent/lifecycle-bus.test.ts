import { describe, expect, test, vi } from "vitest";

import type { PluginHookAgent, PluginLifecycle } from "../plugins/lifecycle/index.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { LifecycleBus } from "./lifecycle-bus.js";

const logger = createTestLogger();

const HOOK_AGENT: PluginHookAgent = {
  id: "agent-1",
  workspaceId: "wks-1",
  parentAgentId: null,
  provider: "codex",
  cwd: "/tmp/project",
  title: "Fix the bug",
};

describe("LifecycleBus", () => {
  test("delivers events to subscribers with the plugin payload shape", () => {
    const bus = new LifecycleBus(logger);
    const seen: Array<{ id: string; turnId: string | null }> = [];
    bus.on("agent.turn_started", (event) => {
      seen.push({ id: event.agent.id, turnId: event.turnId });
    });

    bus.emit("agent.turn_started", { agent: HOOK_AGENT, turnId: "turn-9" });

    expect(seen).toEqual([{ id: "agent-1", turnId: "turn-9" }]);
  });

  test("is signature-compatible with PluginLifecycle's emit", () => {
    const bus = new LifecycleBus(logger);
    const sink: Pick<PluginLifecycle, "emit"> = bus;
    const seen: string[] = [];
    bus.on("agent.created", (event) => {
      seen.push(event.agent.id);
    });

    sink.emit("agent.created", { agent: HOOK_AGENT });

    expect(seen).toEqual(["agent-1"]);
  });

  test("a throwing handler never blocks the other subscribers", () => {
    const bus = new LifecycleBus(logger);
    const seen: string[] = [];
    bus.on("agent.created", () => {
      throw new Error("boom");
    });
    bus.on("agent.created", (event) => {
      seen.push(event.agent.id);
    });

    expect(() => bus.emit("agent.created", { agent: HOOK_AGENT })).not.toThrow();
    expect(seen).toEqual(["agent-1"]);
  });

  test("a rejecting async handler is logged, not thrown, and others still run", async () => {
    const warn = vi.spyOn(logger, "warn");
    const bus = new LifecycleBus(logger);
    const seen: string[] = [];
    bus.on("agent.created", async () => {
      throw new Error("async boom");
    });
    bus.on("agent.created", (event) => {
      seen.push(event.agent.id);
    });

    bus.emit("agent.created", { agent: HOOK_AGENT });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });

    expect(seen).toEqual(["agent-1"]);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new LifecycleBus(logger);
    const seen: string[] = [];
    const off = bus.on("agent.created", (event) => {
      seen.push(event.agent.id);
    });

    bus.emit("agent.created", { agent: HOOK_AGENT });
    off();
    bus.emit("agent.created", { agent: { ...HOOK_AGENT, id: "agent-2" } });

    expect(seen).toEqual(["agent-1"]);
  });
});
