import { expect, it } from "vitest";
import { HANDOFF_TO_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { canContinueAgent } from "./continuation-eligibility";

it("only permits an unarchived agent without a successor", () => {
  expect(canContinueAgent(undefined)).toBe(false);
  expect(canContinueAgent({ archivedAt: null, labels: {} })).toBe(true);
  expect(canContinueAgent({ archivedAt: new Date(), labels: {} })).toBe(false);
  expect(
    canContinueAgent({ archivedAt: null, labels: { [HANDOFF_TO_AGENT_ID_LABEL]: "successor" } }),
  ).toBe(false);
});
