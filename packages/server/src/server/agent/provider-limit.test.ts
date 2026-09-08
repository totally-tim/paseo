import { describe, expect, it } from "vitest";
import { claudeLimitNotification, codexLimitNotification } from "./provider-limit.js";

describe("provider-native limits", () => {
  it("reports a subagent limit without authorizing recovery of its parent", () => {
    expect(codexLimitNotification("usageLimitExceeded", "subagent")).toEqual({
      type: "notification",
      level: "warning",
      message:
        "A Codex subagent reached its usage limit. Inspect its result before deciding how to continue.",
    });
  });
  it("uses Claude rejection and its reset time without treating a warning as exhaustion", () => {
    expect(claudeLimitNotification({ status: "allowed_warning" })).toBeNull();
    expect(claudeLimitNotification({ status: "allowed" })).toBeNull();
    expect(
      claudeLimitNotification({ status: "rejected", rateLimitType: "five_hour" })?.capacityScope,
    ).toBe("account");
    expect(
      claudeLimitNotification({ status: "rejected", rateLimitType: "seven_day_opus" })
        ?.capacityScope,
    ).toBe("model");
    expect(claudeLimitNotification({ status: "rejected", resetsAt: 1_800_000_000 })).toMatchObject({
      code: "provider_capacity",
      resetsAt: "2027-01-15T08:00:00.000Z",
    });
  });
  it("distinguishes Codex subscription capacity from frequency, auth, network, and session budgets", () => {
    expect(codexLimitNotification("usageLimitExceeded")?.code).toBe("provider_capacity");
    expect(codexLimitNotification("rateLimitExceeded")?.code).toBeUndefined();
    for (const info of [
      "unauthorized",
      "serverOverloaded",
      "sessionBudgetExceeded",
      "contextWindowExceeded",
      { httpConnectionFailed: { httpStatusCode: 429 } },
      "some text about a limit",
    ])
      expect(codexLimitNotification(info)).toBeNull();
  });
});

// Captured verbatim from a real Claude session that ran out of capacity on 2026-09-07
// (session 088de160, `quotaLimits` on the 429 assistant message). The hand-written frames
// elsewhere in this file assert intent; this one asserts the shape the provider really sends.
describe("captured provider frames", () => {
  // Declared as a const so the unread SDK fields survive the excess-property check.
  const recordedFiveHourRejection = {
    status: "rejected",
    resetsAt: 1_788_804_600,
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
  };

  it("classifies the recorded five-hour rejection as account capacity with its own reset", () => {
    expect(claudeLimitNotification(recordedFiveHourRejection)).toMatchObject({
      code: "provider_capacity",
      capacityScope: "account",
      resetsAt: "2026-09-07T18:10:00.000Z",
    });
  });
});

describe("Claude usage credits", () => {
  it("reports exhausted credits even while the rate-limit window itself is fine", () => {
    const credits = claudeLimitNotification({ status: "allowed", errorCode: "credits_required" });
    expect(credits).toMatchObject({ code: "provider_capacity", capacityScope: "account" });
    expect(credits?.resetsAt).toBeUndefined();
    expect(credits?.message).toContain("usage credits");
  });

  it("prefers the credits diagnosis over a rejected window, which waits rather than buys", () => {
    const credits = claudeLimitNotification({
      status: "rejected",
      resetsAt: 1_800_000_000,
      errorCode: "credits_required",
    });
    expect(credits?.resetsAt).toBeUndefined();
    expect(credits?.message).toContain("usage credits");
  });
});

describe("Claude overage", () => {
  it("does not treat a permitted overage as an account capacity limit", () => {
    expect(
      claudeLimitNotification({
        status: "rejected",
        overageStatus: "allowed",
        isUsingOverage: true,
      }),
    ).toBeNull();
    expect(
      claudeLimitNotification({
        status: "rejected",
        overageStatus: "allowed_warning",
        isUsingOverage: true,
      }),
    ).toBeNull();
  });

  it("reports a capacity limit once the overage itself is rejected", () => {
    expect(
      claudeLimitNotification({
        status: "rejected",
        overageStatus: "rejected",
        isUsingOverage: true,
      }),
    ).toMatchObject({ code: "provider_capacity", capacityScope: "account" });
    expect(claudeLimitNotification({ status: "rejected" })).toMatchObject({
      code: "provider_capacity",
    });
  });
});
