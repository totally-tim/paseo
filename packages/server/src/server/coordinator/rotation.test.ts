import { expect, test } from "vitest";
import { CoordinatorRotationTrigger } from "./rotation.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

test("context rotation reaches 60 percent once and can explicitly retry", () => {
  const trigger = new CoordinatorRotationTrigger();
  const event = (used: number): AgentStreamEvent => ({
    type: "usage_updated",
    provider: "codex",
    usage: { contextWindowUsedTokens: used, contextWindowMaxTokens: 1000 },
  });
  expect(trigger.observe("a", event(599), {})).toBeNull();
  expect(trigger.observe("a", event(600), {})).toBe("context");
  expect(trigger.observe("a", event(999), {})).toBeNull();
  trigger.clear("a");
  expect(trigger.observe("a", event(700), { thresholdPercent: 80 })).toBeNull();
  expect(trigger.observe("a", event(800), { thresholdPercent: 80 })).toBe("context");
});

test("capacity rotation requires the matching foreground failed turn", () => {
  const trigger = new CoordinatorRotationTrigger();
  const notification: AgentStreamEvent = {
    type: "timeline",
    provider: "codex",
    turnId: "turn",
    item: { type: "notification", code: "provider_capacity", message: "Quota exhausted" },
  };
  expect(trigger.observe("a", notification, { foregroundTurnId: "turn" })).toBeNull();
  expect(
    trigger.observe("a", { type: "turn_completed", provider: "codex", turnId: "turn" }, {}),
  ).toBeNull();
  trigger.observe("a", notification, { foregroundTurnId: "turn" });
  expect(
    trigger.observe(
      "a",
      { type: "turn_failed", provider: "codex", turnId: "other", error: "failure" },
      {},
    ),
  ).toBeNull();
  expect(
    trigger.observe(
      "a",
      { type: "turn_failed", provider: "codex", turnId: "turn", error: "failure" },
      {},
    ),
  ).toBe("capacity");
});
