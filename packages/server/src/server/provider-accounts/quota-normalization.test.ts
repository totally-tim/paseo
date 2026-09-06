import { describe, expect, it } from "vitest";
import { normalizeClaudeAccountUsage, normalizeCodexAccountUsage } from "./quota-normalization.js";

describe("provider-owned quota controls", () => {
  it("preserves Claude zero, unknown, model buckets, and supplied reset timestamps", () => {
    const result = normalizeClaudeAccountUsage("A", {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 0, resets_at: "2026-09-05T01:00:00Z" },
        seven_day: { utilization: null, resets_at: null },
        model_scoped: [
          { display_name: "Fable", utilization: 42, resets_at: "2026-09-11T00:00:00Z" },
        ],
      },
    });
    expect(result.displayName).toBe("A");
    expect(result.windows).toEqual([
      expect.objectContaining({
        id: "five_hour",
        usedPct: 0,
        remainingPct: 100,
        resetsAt: "2026-09-05T01:00:00Z",
      }),
      expect.objectContaining({ id: "seven_day", usedPct: null, remainingPct: null }),
      expect.objectContaining({ id: "model:0:Fable", label: "Weekly · Fable", usedPct: 42 }),
    ]);
  });

  it("does not report zero usage when Claude says rate limits are unavailable", () => {
    expect(
      normalizeClaudeAccountUsage("A", {
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
      }),
    ).toMatchObject({ status: "unavailable", windows: [] });
  });

  it("uses Codex's actual duration and does not invent a second window", () => {
    const result = normalizeCodexAccountUsage("B", {
      rateLimits: {
        primary: { usedPercent: 49, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        planType: "plus",
      },
    });
    expect(result.windows).toEqual([
      expect.objectContaining({
        id: "primary",
        label: "Weekly",
        usedPct: 49,
        resetsAt: "2027-01-15T08:00:00.000Z",
      }),
    ]);
    expect(result.planLabel).toBe("plus");
  });

  it("preserves Codex unknown utilization, invalid reset dates, and account spend limits", () => {
    const result = normalizeCodexAccountUsage("B", {
      rateLimits: { primary: { usedPercent: null, resetsAt: 1e30 }, spendControlReached: true },
    });
    expect(result.windows[0]).toMatchObject({ usedPct: null, remainingPct: null, resetsAt: null });
    expect(result.windows[1]).toMatchObject({ id: "account_limit", usedPct: 100 });
  });

  it("rejects malformed native results for the caller to report as unavailable", () => {
    expect(() =>
      normalizeCodexAccountUsage("B", { rateLimits: { primary: { usedPercent: "0" } } }),
    ).toThrow();
    expect(() =>
      normalizeClaudeAccountUsage("A", {
        rate_limits_available: true,
        subscription_type: null,
        rate_limits: { five_hour: { utilization: "0", resets_at: null } },
      }),
    ).toThrow();
  });

  it("keeps a Claude window the provider could not read as an unknown reading", () => {
    const result = normalizeClaudeAccountUsage("A", {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 10, resets_at: null }, seven_day: null },
    });
    expect(result.windows).toEqual([
      expect.objectContaining({ id: "five_hour", usedPct: 10 }),
      expect.objectContaining({ id: "seven_day", usedPct: null, remainingPct: null }),
    ]);
  });

  it("reads every Codex bucket once when the provider reports them by limit", () => {
    const result = normalizeCodexAccountUsage("A", {
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
        planType: "plus",
      },
      rateLimitsByLimitId: {
        codex: {
          limitName: "Codex",
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
          planType: "plus",
        },
        "codex-mini": {
          limitName: "Codex Mini",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
        },
      },
    });
    expect(result.windows.map((window) => [window.id, window.usedPct])).toEqual([
      ["codex:primary", 12],
      ["codex-mini:primary", 100],
    ]);
    expect(result.planLabel).toBe("plus");
  });

  it("reports a per-bucket account limit without dropping the other buckets", () => {
    const result = normalizeCodexAccountUsage("A", {
      rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null } },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null } },
        other: { spendControlReached: true },
      },
    });
    expect(result.windows.map((window) => window.id)).toEqual([
      "codex:primary",
      "other:account_limit",
    ]);
  });
});
