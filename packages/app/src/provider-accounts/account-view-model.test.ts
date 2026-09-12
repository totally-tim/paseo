import { expect, test } from "vitest";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import {
  activeCapacityLimit,
  applicableAccountUsage,
  continuationAccountChoices,
} from "./account-view-model";

test("saved accounts become unavailable only after catalog resolution", () => {
  expect(continuationAccountChoices(undefined, "claude", ["saved"])).toEqual({
    accounts: [],
    unavailable: [],
  });
  expect(continuationAccountChoices([], "claude", ["saved"])).toEqual({
    accounts: [],
    unavailable: ["saved"],
  });
});
test("quota for a different model cannot produce an empty available card", () => {
  expect(
    applicableAccountUsage(
      {
        providerId: "codex",
        displayName: "Codex",
        planLabel: null,
        status: "available",
        windows: [
          {
            id: "gpt-5.3-codex-spark:secondary",
            label: "Weekly · GPT-5.3-Codex-Spark",
            usedPct: 10,
          },
        ],
      },
      "gpt-6-astra",
    ),
  ).toBeNull();
});

const account: ProviderAccount = {
  id: "a",
  provider: "claude",
  label: "gmail claude",
  ownership: "managed",
  enabled: true,
  authState: "ready",
  identity: { key: "claude:tim@example.com:org", email: "tim@example.com" },
  error: null,
  revision: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const now = Date.parse("2026-09-09T12:00:00.000Z");

test("a capacity limit stands until its reported reset", () => {
  const limit = { observedAt: "2026-09-09T03:00:00.000Z", resetsAt: "2026-09-13T04:00:00.000Z" };
  expect(activeCapacityLimit({ ...account, capacityLimit: limit }, "opus", now)).toEqual(limit);
  expect(
    activeCapacityLimit(
      { ...account, capacityLimit: { ...limit, resetsAt: "2026-09-09T11:00:00.000Z" } },
      "opus",
      now,
    ),
  ).toBeNull();
});

test("an undated capacity limit expires with the daemon's cooldown", () => {
  const observedAt = "2026-09-09T11:50:00.000Z";
  expect(activeCapacityLimit({ ...account, capacityLimit: { observedAt } }, "opus", now)).toEqual({
    observedAt,
  });
  expect(
    activeCapacityLimit(
      { ...account, capacityLimit: { observedAt: "2026-09-09T11:40:00.000Z" } },
      "opus",
      now,
    ),
  ).toBeNull();
});

test("a capacity limit on another model leaves this start alone", () => {
  const capacityLimit = { observedAt: "2026-09-09T11:55:00.000Z", model: "sonnet" };
  expect(activeCapacityLimit({ ...account, capacityLimit }, "opus", now)).toBeNull();
  expect(activeCapacityLimit({ ...account, capacityLimit }, "sonnet", now)).toEqual(capacityLimit);
});

test("a capacity limit bound to another identity does not apply", () => {
  const capacityLimit = {
    observedAt: "2026-09-09T11:55:00.000Z",
    resetsAt: "2026-09-13T04:00:00.000Z",
    identityKey: "claude:other@example.com",
  };
  expect(activeCapacityLimit({ ...account, capacityLimit }, "opus", now)).toBeNull();
  const own = { ...capacityLimit, identityKey: "claude:tim@example.com:org" };
  expect(activeCapacityLimit({ ...account, capacityLimit: own }, "opus", now)).toEqual(own);
});

test("a capacity limit recorded before the identity binding applies only to managed accounts", () => {
  const capacityLimit = {
    observedAt: "2026-09-09T11:55:00.000Z",
    resetsAt: "2026-09-13T04:00:00.000Z",
  };
  expect(
    activeCapacityLimit({ ...account, ownership: "external", capacityLimit }, "opus", now),
  ).toBeNull();
  expect(activeCapacityLimit({ ...account, capacityLimit }, "opus", now)).toEqual(capacityLimit);
});
