import { expect, test } from "vitest";
import { CapacityRecoveryTrigger } from "./capacity-trigger.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

const capacity = (turnId?: string): AgentStreamEvent => ({
  type: "timeline",
  provider: "codex",
  turnId,
  item: {
    type: "notification",
    code: "provider_capacity",
    level: "warning",
    message: "Quota rejected",
  },
});

test("only a matching failed foreground turn consumes a capacity candidate, once", () => {
  const gate = new CapacityRecoveryTrigger();
  expect(gate.observe("agent", capacity("turn"), "limit", "turn")).toBeNull();
  expect(gate.pending("agent")).toBe(true);
  const failure: AgentStreamEvent = {
    type: "turn_failed",
    provider: "codex",
    turnId: "turn",
    error: "Quota",
  };
  expect(gate.observe("agent", failure, "end")).toEqual({ eventId: "limit", turnId: "turn" });
  expect(gate.observe("agent", failure, "duplicate")).toBeNull();
});

test.each(["turn_completed", "turn_canceled"] as const)("%s discards capacity evidence", (type) => {
  const gate = new CapacityRecoveryTrigger();
  gate.observe("agent", capacity("turn"), "limit", "turn");
  expect(
    gate.observe(
      "agent",
      { type, provider: "codex", turnId: "turn", reason: "Normal stop" },
      "end",
    ),
  ).toBeNull();
  expect(gate.pending("agent")).toBe(false);
  expect(
    gate.observe(
      "agent",
      { type: "turn_failed", provider: "codex", turnId: "turn", error: "Late" },
      "late",
    ),
  ).toBeNull();
});

test("idle, unidentified and other-turn notifications cannot authorize recovery", () => {
  const gate = new CapacityRecoveryTrigger();
  gate.observe("agent", capacity("old"), "idle");
  gate.observe("agent", capacity(), "unidentified", "new");
  gate.observe("agent", capacity("old"), "old-turn", "new");
  expect(gate.pending("agent")).toBe(false);
  expect(
    gate.observe(
      "agent",
      { type: "turn_failed", provider: "codex", turnId: "new", error: "Network error" },
      "failure",
    ),
  ).toBeNull();
});

test("Stop clears a candidate and a new foreground turn cannot inherit old evidence", () => {
  const gate = new CapacityRecoveryTrigger();
  gate.observe("agent", capacity("old"), "limit", "old");
  gate.clear("agent");
  expect(gate.pending("agent")).toBe(false);
  gate.observe("agent", capacity("old"), "limit", "old");
  expect(
    gate.observe(
      "agent",
      { type: "turn_failed", provider: "codex", turnId: "new", error: "Unrelated" },
      "failure",
      "new",
    ),
  ).toBeNull();
  expect(gate.pending("agent")).toBe(false);
});
