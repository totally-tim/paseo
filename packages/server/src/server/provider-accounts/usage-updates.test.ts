import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "../messages.js";
import {
  claudeRateLimitEventUpdate,
  codexRateLimitsUpdate,
  mergeAccountUsageUpdate,
} from "./usage-updates.js";

const NOW = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T00:05:00.000Z";

function probed(windows: ProviderUsage["windows"]): ProviderUsage {
  return {
    providerId: "codex",
    displayName: "work",
    status: "available",
    planLabel: "pro",
    windows,
    fetchedAt: NOW,
    nextRefreshAt: LATER,
    error: null,
  };
}

function merge(
  previous: ProviderUsage | null,
  raw: unknown,
  provider: "codex" | "claude" = "codex",
) {
  const update =
    provider === "codex" ? codexRateLimitsUpdate(raw) : claudeRateLimitEventUpdate(raw);
  if (!update) return null;
  return mergeAccountUsageUpdate({
    previous,
    update,
    providerId: provider,
    displayName: "work",
    fetchedAt: NOW,
    nextRefreshAt: LATER,
  });
}

describe("codexRateLimitsUpdate", () => {
  it("maps a named bucket's positions to prefixed window updates", () => {
    const update = codexRateLimitsUpdate({
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
    });
    expect(update?.windows).toEqual([
      {
        id: "codex:primary",
        position: "primary",
        unprefixed: false,
        label: "5-hour window · Codex",
        usedPct: 55,
        resetsAt: "2027-01-15T08:00:00.000Z",
        periodMinutes: 300,
      },
      {
        id: "codex:secondary",
        position: "secondary",
        unprefixed: false,
        label: "Weekly · Codex",
        usedPct: 12,
        resetsAt: "2027-01-22T08:00:00.000Z",
        periodMinutes: 10_080,
      },
    ]);
  });

  it("flags updates that name no bucket so the merge can scope them", () => {
    const update = codexRateLimitsUpdate({
      primary: { usedPercent: 80, windowDurationMins: 300 },
    });
    expect(update?.windows).toEqual([
      expect.objectContaining({ id: "primary", position: "primary", unprefixed: true }),
    ]);
  });

  it("adds and clears an account limit row from the reached flags", () => {
    const reached = codexRateLimitsUpdate({ rateLimitReachedType: "spend" });
    expect(reached?.windows).toEqual([
      expect.objectContaining({ id: "account_limit", usedPct: 100, remove: false }),
    ]);
    const cleared = codexRateLimitsUpdate({ spendControlReached: false });
    expect(cleared?.windows).toEqual([
      expect.objectContaining({ id: "account_limit", remove: true }),
    ]);
  });

  it("returns null for payloads with nothing to apply", () => {
    expect(codexRateLimitsUpdate({ primary: null, secondary: null })).toBeNull();
    expect(codexRateLimitsUpdate({ primary: { usedPercent: "high" } })).toBeNull();
    expect(codexRateLimitsUpdate("updated")).toBeNull();
  });
});

describe("claudeRateLimitEventUpdate", () => {
  it("maps named windows to the probe's ids with fixed periods", () => {
    const update = claudeRateLimitEventUpdate({
      rateLimitType: "five_hour",
      utilization: 0.42,
      resetsAt: 1_800_000_000,
    });
    expect(update?.windows).toEqual([
      {
        id: "five_hour",
        label: "Session",
        periodMinutes: 300,
        usedPct: 42,
        resetsAt: "2027-01-15T08:00:00.000Z",
      },
    ]);
  });

  it("marks the overage-included bucket for the merge to rebind", () => {
    const update = claudeRateLimitEventUpdate({
      rateLimitType: "seven_day_overage_included",
      utilization: 0.9,
    });
    expect(update?.windows).toEqual([
      expect.objectContaining({ id: "model_scoped", modelScoped: true, usedPct: 90 }),
    ]);
  });

  it("returns null for unknown types and missing utilization", () => {
    expect(
      claudeRateLimitEventUpdate({ rateLimitType: "per_minute", utilization: 0.5 }),
    ).toBeNull();
    expect(claudeRateLimitEventUpdate({ rateLimitType: "five_hour" })).toBeNull();
    expect(claudeRateLimitEventUpdate({})).toBeNull();
  });
});

describe("mergeAccountUsageUpdate", () => {
  it("keeps probe fields an update omits and clears derived estimates", () => {
    const previous = probed([
      {
        id: "codex:primary",
        label: "5-hour window · Codex",
        usedPct: 40,
        remainingPct: 60,
        resetsAt: "2026-09-05T05:00:00.000Z",
        periodMinutes: 300,
        runsOutAt: "2026-09-05T02:00:00.000Z",
        shortfallPct: 30,
      },
      {
        id: "codex:secondary",
        label: "Weekly · Codex",
        usedPct: 10,
        remainingPct: 90,
        resetsAt: "2026-09-10T00:00:00.000Z",
        periodMinutes: 10_080,
      },
    ]);
    const next = merge(previous, { limitId: "codex", primary: { usedPercent: 75 } });
    expect(next?.windows).toEqual([
      {
        id: "codex:primary",
        label: "5-hour window · Codex",
        usedPct: 75,
        remainingPct: 25,
        resetsAt: "2026-09-05T05:00:00.000Z",
        periodMinutes: 300,
        tone: "warning",
        runsOutAt: undefined,
        shortfallPct: undefined,
      },
      previous.windows[1],
    ]);
    expect(next?.fetchedAt).toBe(NOW);
  });

  it("treats an explicit null reset differently from an omitted one", () => {
    const previous = probed([
      { id: "primary", label: "Primary window", usedPct: 40, resetsAt: "2026-09-05T05:00:00.000Z" },
    ]);
    const cleared = merge(previous, { primary: { usedPercent: 40, resetsAt: null } });
    expect(cleared?.windows[0].resetsAt).toBeNull();
    const kept = merge(previous, { primary: { usedPercent: 40 } });
    expect(kept).toBeNull();
  });

  it("binds an unprefixed update to the only bucket family a probe reported", () => {
    const previous = probed([
      { id: "codex:primary", label: "5-hour window · Codex", usedPct: 40 },
      { id: "codex:secondary", label: "Weekly · Codex", usedPct: 10 },
    ]);
    const next = merge(previous, { primary: { usedPercent: 90 } });
    expect(next?.windows.map((window) => [window.id, window.usedPct])).toEqual([
      ["codex:primary", 90],
      ["codex:secondary", 10],
    ]);
  });

  it("drops an unprefixed update when several bucket families could own it", () => {
    const previous = probed([
      { id: "codex:primary", label: "5-hour window · Codex", usedPct: 40 },
      { id: "codex-mini:primary", label: "5-hour window · Codex Mini", usedPct: 5 },
    ]);
    expect(merge(previous, { primary: { usedPercent: 90 } })).toBeNull();
  });

  it("binds a prefixed update to the unprefixed rows an old probe drew", () => {
    const previous = probed([
      { id: "primary", label: "5-hour window", usedPct: 40 },
      { id: "secondary", label: "Weekly", usedPct: 10 },
    ]);
    const next = merge(previous, {
      limitId: "codex",
      primary: { usedPercent: 88, windowDurationMins: 300 },
    });
    expect(next?.windows.map((window) => [window.id, window.usedPct])).toEqual([
      ["primary", 88],
      ["secondary", 10],
    ]);
  });

  it("rebinds a Claude overage reading to the model-scoped row the probe drew", () => {
    const previous = probed([
      { id: "seven_day", label: "Weekly", usedPct: 20 },
      { id: "model:0:Fable", label: "Weekly · Fable", usedPct: 50 },
    ]);
    const next = merge(
      previous,
      { rateLimitType: "seven_day_overage_included", utilization: 0.95 },
      "claude",
    );
    expect(next?.windows.map((window) => [window.id, window.usedPct])).toEqual([
      ["seven_day", 20],
      ["model:0:Fable", 95],
    ]);
  });

  it("removes an account limit row when the provider clears it", () => {
    const previous = probed([
      { id: "primary", label: "5-hour window", usedPct: 100 },
      { id: "account_limit", label: "Account limit", usedPct: 100 },
    ]);
    const next = merge(previous, { spendControlReached: false });
    expect(next?.windows.map((window) => window.id)).toEqual(["primary"]);
  });

  it("seeds a snapshot from events alone and clamps out-of-range readings", () => {
    const next = merge(null, { primary: { usedPercent: 140, windowDurationMins: 300 } });
    expect(next).toMatchObject({
      providerId: "codex",
      status: "available",
      windows: [{ id: "primary", usedPct: 100, remainingPct: 0, tone: "danger" }],
    });
  });

  it("returns null when the update changes nothing", () => {
    const previous = probed([
      {
        id: "primary",
        label: "5-hour window",
        usedPct: 50,
        remainingPct: 50,
        resetsAt: null,
        periodMinutes: 300,
        tone: "ok",
      },
    ]);
    expect(
      merge(previous, { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null } }),
    ).toBeNull();
  });
});
