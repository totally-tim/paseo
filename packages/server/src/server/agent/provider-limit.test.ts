import { describe, expect, it } from "vitest";
import { claudeLimitNotification, codexLimitNotification } from "./provider-limit.js";

describe("provider-native limits", () => {
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
