import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage, ProviderUsageWindow } from "@getpaseo/protocol/messages";

export interface AccountUsageEntry {
  accountId: string;
  usage: ProviderUsage;
  stale: boolean;
}

export interface PooledUsageAccount {
  accountId: string;
  label: string;
  planLabel: string | null;
  /** The account's last read is older than the probe TTL. */
  stale: boolean;
}

export interface PooledWindowSegment {
  usedPct: number | null;
  resetsAt: string | null;
}

export interface PooledUsageWindow {
  key: string;
  label: string;
  /** Mean remaining share across reporting accounts; null when no account reported it. */
  remainingPct: number | null;
  /** One column per pool account; null where the account never reported this window. */
  segments: Array<PooledWindowSegment | null>;
  /**
   * Mean (used − elapsed) percentage across segments with a known period and a future reset.
   * Positive means the pool is spending faster than the window length allows.
   */
  paceDeltaPct: number | null;
  /** Soonest upcoming reset in this window and the share of the pool it restores. */
  nextRefill: { at: string; restoresPct: number } | null;
}

export interface AccountUsagePool {
  provider: ProviderAccount["provider"];
  /** Column order for every window's `segments`. */
  accounts: PooledUsageAccount[];
  windows: PooledUsageWindow[];
  /** Accounts folded into a sibling that shares their verified subscription identity. */
  hiddenAccounts: number;
}

/**
 * Compatible windows share a pool key: the metered bucket, position, and real length.
 * Codex reports `primary`/`secondary` as positions — the same position can be a five-hour
 * session on one plan and a monthly allowance on another, so duration must be part of the
 * key or a month of quota would average into a session pool. `model:` rows keep the model
 * name and drop the positional index the daemon assigns.
 */
function windowPoolKey(window: ProviderUsageWindow): string {
  const parts = window.id.split(":");
  const kind = window.id.startsWith("model:") ? "model" : "window";
  const identity = kind === "model" ? parts.slice(2).join(":") : window.id;
  return `${kind}:${identity}:${window.periodMinutes ?? "unknown"}`;
}

function windowSortMinutes(window: ProviderUsageWindow): number {
  return window.periodMinutes ?? Number.MAX_SAFE_INTEGER;
}

/**
 * One subscription can be listed twice — the host CLI login and a managed account signed in
 * to it. Its quota is one bucket, so the pool counts it once; the managed row carries the
 * detail since it is the one Paseo admits work onto.
 */
function deduplicateAccounts(
  accounts: ProviderAccount[],
  usage: Map<string, AccountUsageEntry>,
): { accounts: ProviderAccount[]; hidden: number } {
  const byIdentity = new Map<string, ProviderAccount>();
  let hidden = 0;
  for (const account of accounts) {
    const key = account.identity?.key ?? `account:${account.id}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, account);
      continue;
    }
    hidden += 1;
    const preferNext =
      (existing.ownership !== "managed" && account.ownership === "managed") ||
      (existing.ownership === account.ownership &&
        usage.get(existing.id)?.usage.status !== "available" &&
        usage.get(account.id)?.usage.status === "available");
    if (preferNext) byIdentity.set(key, account);
  }
  return { accounts: [...byIdentity.values()], hidden };
}

function segmentFor(
  usage: ProviderUsage | undefined,
  window: ProviderUsageWindow,
): PooledWindowSegment {
  const known =
    usage?.status === "available" && typeof window.usedPct === "number" ? window.usedPct : null;
  return { usedPct: known, resetsAt: window.resetsAt ?? null };
}

/** Elapsed share of a window in percent; null when the period or reset is unknown. */
function elapsedPct(
  periodMinutes: number | null,
  resetsAt: string | null,
  now: number,
): number | null {
  if (periodMinutes == null || !resetsAt) return null;
  const reset = Date.parse(resetsAt);
  if (!Number.isFinite(reset)) return null;
  return (1 - (reset - now) / (periodMinutes * 60_000)) * 100;
}

/** Soonest upcoming reset across an account's windows; null when none is known. */
function nextResetAt(usage: AccountUsageEntry | undefined, now: number): number | null {
  if (usage?.usage.status !== "available") return null;
  const upcoming = usage.usage.windows
    .map((window) => Date.parse(window.resetsAt ?? ""))
    .filter((at) => Number.isFinite(at) && at > now);
  return upcoming.length ? Math.min(...upcoming) : null;
}

export function collectAccountUsagePools(input: {
  accounts: ProviderAccount[];
  usage: AccountUsageEntry[];
  now?: number;
}): AccountUsagePool[] {
  const now = input.now ?? Date.now();
  const usage = new Map(input.usage.map((entry) => [entry.accountId, entry] as const));
  const eligible = input.accounts.filter(
    (account) => !account.removedAt && account.enabled && account.authState === "ready",
  );
  const pools: AccountUsagePool[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const { accounts, hidden } = deduplicateAccounts(
      eligible.filter((account) => account.provider === provider),
      usage,
    );
    if (!accounts.length) continue;
    // Soonest upcoming reset orders the columns so the account that frees first leads.
    const ordered = [...accounts].sort(
      (a, b) =>
        (nextResetAt(usage.get(a.id), now) ?? Number.MAX_SAFE_INTEGER) -
          (nextResetAt(usage.get(b.id), now) ?? Number.MAX_SAFE_INTEGER) ||
        a.label.localeCompare(b.label),
    );
    const columnOrder = new Map(ordered.map((account, index) => [account.id, index] as const));
    const rows = new Map<
      string,
      {
        sortMinutes: number;
        periodMinutes: number | null;
        label: string;
        segments: Array<PooledWindowSegment | null>;
      }
    >();
    for (const account of ordered) {
      const entry = usage.get(account.id);
      const windows = entry?.usage.status === "available" ? entry.usage.windows : [];
      for (const window of windows) {
        const key = windowPoolKey(window);
        let row = rows.get(key);
        if (!row) {
          row = {
            sortMinutes: windowSortMinutes(window),
            periodMinutes: window.periodMinutes ?? null,
            label: window.label,
            segments: Array.from({ length: accounts.length }, () => null),
          };
          rows.set(key, row);
        }
        row.segments[columnOrder.get(account.id)!] = segmentFor(entry?.usage, window);
      }
    }
    const windows: PooledUsageWindow[] = [...rows.entries()]
      .sort(([, a], [, b]) => a.sortMinutes - b.sortMinutes || a.label.localeCompare(b.label))
      .map(([key, row]) => {
        const reported = row.segments.filter(
          (segment): segment is PooledWindowSegment => segment !== null,
        );
        const known = reported.filter((segment) => segment.usedPct !== null);
        const paceDeltas = reported
          .map((segment) => {
            const elapsed = elapsedPct(row.periodMinutes, segment.resetsAt, now);
            return segment.usedPct !== null && elapsed !== null ? segment.usedPct - elapsed : null;
          })
          .filter((delta): delta is number => delta !== null);
        const refills = reported
          .filter((segment) => segment.resetsAt && Date.parse(segment.resetsAt) > now)
          .map((segment) => ({
            at: segment.resetsAt!,
            // Every account contributes an equal share of the pool, whatever its plan.
            restoresPct: (segment.usedPct ?? 0) / Math.max(1, accounts.length),
          }))
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        return {
          key,
          label: row.label,
          remainingPct: known.length
            ? known.reduce((sum, segment) => sum + (100 - segment.usedPct!), 0) / known.length
            : null,
          segments: row.segments,
          paceDeltaPct: paceDeltas.length
            ? paceDeltas.reduce((sum, delta) => sum + delta, 0) / paceDeltas.length
            : null,
          nextRefill: refills[0] ?? null,
        };
      });
    pools.push({
      provider,
      hiddenAccounts: hidden,
      accounts: ordered.map((account) => ({
        accountId: account.id,
        label: account.label,
        planLabel: usage.get(account.id)?.usage.planLabel ?? null,
        stale: usage.get(account.id)?.stale ?? true,
      })),
      windows,
    });
  }
  return pools;
}
