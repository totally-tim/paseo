import { describe, expect, it } from "vitest";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage, ProviderUsageWindow } from "@getpaseo/protocol/messages";
import { collectAccountUsagePools } from "./pooled-usage";

const NOW = Date.parse("2026-09-05T00:00:00.000Z");

function account(
  id: string,
  provider: ProviderAccount["provider"],
  overrides: Partial<ProviderAccount> = {},
): ProviderAccount {
  return {
    id,
    provider,
    label: id,
    ownership: "managed",
    enabled: true,
    authState: "ready",
    identity: { key: `${provider}:${id}@example.invalid`, email: `${id}@example.invalid` },
    error: null,
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function window(overrides: Partial<ProviderUsageWindow> & { id: string }): ProviderUsageWindow {
  return {
    label: overrides.id,
    usedPct: 0,
    remainingPct: 100,
    resetsAt: null,
    ...overrides,
  };
}

function entry(
  accountId: string,
  windows: ProviderUsageWindow[],
  overrides: { stale?: boolean; status?: ProviderUsage["status"] } = {},
) {
  return {
    accountId,
    stale: overrides.stale ?? false,
    usage: {
      providerId: "codex",
      displayName: accountId,
      status: overrides.status ?? ("available" as const),
      planLabel: null,
      windows,
      error: null,
    },
  };
}

describe("collectAccountUsagePools", () => {
  it("folds a host login and a managed login on the same identity into one column", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [
        account("default:codex", "codex", {
          ownership: "external",
          identity: { key: "codex:me@x", email: "me@x" },
        }),
        account("managed-1", "codex", { identity: { key: "codex:me@x", email: "me@x" } }),
      ],
      usage: [
        entry("default:codex", [window({ id: "primary", usedPct: 80, periodMinutes: 300 })]),
        entry("managed-1", [window({ id: "primary", usedPct: 80, periodMinutes: 300 })]),
      ],
    });
    expect(pools).toHaveLength(1);
    // The managed row carries the column since it is the one Paseo admits work onto.
    expect(pools[0].accounts.map((a) => a.accountId)).toEqual(["managed-1"]);
    expect(pools[0].hiddenAccounts).toBe(1);
    // Two reads of one subscription do not double the pool.
    expect(pools[0].windows[0].remainingPct).toBe(20);
  });

  it("prefers the duplicate that actually reported usage", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [
        account("dead", "codex", { identity: { key: "codex:me@x", email: "me@x" } }),
        account("live", "codex", { identity: { key: "codex:me@x", email: "me@x" } }),
      ],
      usage: [
        entry("dead", [], { status: "error" }),
        entry("live", [window({ id: "primary", usedPct: 50, periodMinutes: 300 })]),
      ],
    });
    expect(pools[0].accounts.map((a) => a.accountId)).toEqual(["live"]);
    expect(pools[0].windows[0].remainingPct).toBe(50);
  });

  it("pools windows by position and period, keeping Codex's mismatched buckets apart", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [account("a", "codex"), account("b", "codex")],
      usage: [
        entry("a", [
          window({
            id: "codex:primary",
            label: "5-hour window · Codex",
            usedPct: 50,
            periodMinutes: 300,
          }),
        ]),
        // Same position name, different real duration: a monthly allowance never averages
        // into a session pool.
        entry("b", [
          window({
            id: "codex:primary",
            label: "720-hour window · Codex",
            usedPct: 10,
            periodMinutes: 43_200,
          }),
        ]),
      ],
    });
    const keys = pools[0].windows.map((row) => row.key);
    expect(keys).toEqual(["window:primary:300", "window:primary:43200"]);
    expect(pools[0].windows[0].segments).toEqual([expect.objectContaining({ usedPct: 50 }), null]);
    expect(pools[0].windows[1].segments).toEqual([null, expect.objectContaining({ usedPct: 10 })]);
  });

  it("reports the mean remaining share and one segment per account", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [account("a", "claude"), account("b", "claude")],
      usage: [
        entry("a", [window({ id: "five_hour", usedPct: 20, periodMinutes: 300 })]),
        entry("b", [window({ id: "five_hour", usedPct: 80, periodMinutes: 300 })]),
      ],
    });
    const row = pools[0].windows[0];
    expect(row.segments).toHaveLength(2);
    expect(row.remainingPct).toBe(50);
  });

  it("computes pace from the elapsed share of the window", () => {
    // Window resets in 2.5h of a 5h period → half elapsed. Used 80% → burning fast.
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [account("a", "claude")],
      usage: [
        entry("a", [
          window({
            id: "five_hour",
            usedPct: 80,
            periodMinutes: 300,
            resetsAt: "2026-09-05T02:30:00.000Z",
          }),
        ]),
      ],
    });
    expect(pools[0].windows[0].paceDeltaPct).toBe(30);
  });

  it("leaves pace null when the period or reset is unknown", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [account("a", "claude")],
      usage: [
        entry("a", [
          window({ id: "five_hour", usedPct: 80, resetsAt: "2026-09-05T02:30:00.000Z" }),
          window({ id: "seven_day", usedPct: 10, periodMinutes: 10_080 }),
        ]),
      ],
    });
    expect(pools[0].windows.map((row) => row.paceDeltaPct)).toEqual([null, null]);
  });

  it("names the soonest refill and the pool share it restores", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [account("a", "codex"), account("b", "codex")],
      usage: [
        entry("a", [
          window({
            id: "primary",
            usedPct: 60,
            periodMinutes: 300,
            resetsAt: "2026-09-05T01:00:00.000Z",
          }),
        ]),
        entry("b", [
          window({
            id: "primary",
            usedPct: 20,
            periodMinutes: 300,
            resetsAt: "2026-09-05T04:00:00.000Z",
          }),
        ]),
      ],
    });
    // A's window rolls first and hands its spent 60% back to a two-account pool.
    expect(pools[0].windows[0].nextRefill).toEqual({
      at: "2026-09-05T01:00:00.000Z",
      restoresPct: 30,
    });
  });

  it("handles missing and unreadable usage without inventing numbers", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [account("a", "codex"), account("b", "codex"), account("c", "codex")],
      usage: [
        entry("a", [window({ id: "primary", usedPct: null, periodMinutes: 300 })]),
        entry("b", [], { status: "error" }),
      ],
    });
    const pool = pools[0];
    expect(pool.accounts.map((a) => a.accountId)).toEqual(["a", "b", "c"]);
    expect(pool.accounts.map((a) => a.stale)).toEqual([false, false, true]);
    const row = pool.windows[0];
    expect(row.segments).toEqual([{ usedPct: null, resetsAt: null }, null, null]);
    expect(row.remainingPct).toBeNull();
    expect(row.paceDeltaPct).toBeNull();
    expect(row.nextRefill).toBeNull();
  });

  it("skips accounts that are disabled, removed, or signed out", () => {
    const pools = collectAccountUsagePools({
      now: NOW,
      accounts: [
        account("a", "codex"),
        account("b", "codex", { enabled: false }),
        account("c", "codex", { removedAt: "2026-09-04T00:00:00.000Z" }),
        account("d", "codex", { authState: "signed-out", identity: null }),
      ],
      usage: [entry("a", [window({ id: "primary", usedPct: 10, periodMinutes: 300 })])],
    });
    expect(pools[0].accounts.map((a) => a.accountId)).toEqual(["a"]);
  });
});
