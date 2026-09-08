import type { ProviderUsageWindow } from "../messages.js";

/**
 * Ordering for automatic account selection. Eligibility decides who is a candidate; this only
 * orders the survivors, and it is deliberately self-contained so it can be removed without
 * touching eligibility or the remembered-account rule.
 *
 * Quota windows are use-it-or-lose-it, so an agent that can hand itself over when an account
 * runs dry should drain the account whose windows roll soonest, spending percentage that would
 * otherwise expire. An agent with no handover has to finish on the account it started on, so it
 * takes the one with the most remaining percentage instead. Automatic continuation is off by
 * default, which makes "most remaining" the common case rather than the exception.
 */
export type AccountRankMode = "soonest-expiry" | "most-remaining";

/** Above this, a window short enough to exhaust in one sitting will wall within minutes. */
const NEAR_EXHAUSTED_PCT = 90;
/** A window this short is a session window rather than a weekly allowance. */
const SHORT_PERIOD_MINUTES = 6 * 60;

export interface AccountScore {
  /**
   * A reading we cannot rank on. Unknown never outranks a known candidate and never displaces
   * the remembered account, so we sort it last rather than guessing a value for it.
   */
  readonly unknown: boolean;
  /** A short window is nearly gone, so starting here buys minutes before the agent stalls. */
  readonly aboutToWall: boolean;
  /**
   * When every window has rolled or has yet to start, nothing is pending expiry. Infinity
   * rather than null, because that account is the last one whose quota risks going unspent.
   */
  readonly expiresAt: number;
  /** The scarcest window's remaining percentage, which is what caps a run that cannot move. */
  readonly remainingPct: number;
  /** The window that set `expiresAt`, for the reason string. Null when nothing is pending. */
  readonly expiryWindow: ProviderUsageWindow | null;
  /** The window that set `remainingPct`. Null when no window was scorable. */
  readonly scarcestWindow: ProviderUsageWindow | null;
}

const UNKNOWN: AccountScore = {
  unknown: true,
  aboutToWall: false,
  expiresAt: Number.POSITIVE_INFINITY,
  remainingPct: 0,
  expiryWindow: null,
  scarcestWindow: null,
};

/**
 * Reads `usedPct` rather than `remainingPct` on purpose. Both are populated in production, but
 * every test backend builds windows without `remainingPct`, so a helper reading it would pass
 * live and silently see `undefined` under test.
 */
export function scoreAccount(input: { windows: ProviderUsageWindow[]; now: number }): AccountScore {
  if (input.windows.length === 0) return UNKNOWN;
  let expiresAt = Number.NEGATIVE_INFINITY;
  let expiryWindow: ProviderUsageWindow | null = null;
  let remainingPct = Number.POSITIVE_INFINITY;
  let scarcestWindow: ProviderUsageWindow | null = null;
  let aboutToWall = false;
  let contributing = 0;
  for (const window of input.windows) {
    if (typeof window.usedPct !== "number") return UNKNOWN;
    const resetsAt = Date.parse(window.resetsAt ?? "");
    const hasReset = Number.isFinite(resetsAt);
    // A rolling window the provider has not started reports no reset. Consumption without one
    // is a reading we cannot place in time, which is different from a window at rest.
    if (!hasReset && window.usedPct !== 0) return UNKNOWN;
    // A reset in the past means the window rolled after this cached reading was taken, so its
    // used percentage is stale-high. Skip it entirely rather than judging the account on it.
    if (hasReset && resetsAt <= input.now) continue;
    contributing += 1;
    const period = window.periodMinutes;
    if (
      typeof period === "number" &&
      period <= SHORT_PERIOD_MINUTES &&
      window.usedPct > NEAR_EXHAUSTED_PCT
    )
      aboutToWall = true;
    if (100 - window.usedPct < remainingPct) {
      remainingPct = 100 - window.usedPct;
      scarcestWindow = window;
    }
    if (hasReset && resetsAt > expiresAt) {
      expiresAt = resetsAt;
      expiryWindow = window;
    }
  }
  // Every window had already rolled, so the reading says nothing about what is left now. Another
  // agent may be spending the fresh allowance. Missing evidence is not full capacity.
  if (contributing === 0) return UNKNOWN;
  return {
    unknown: false,
    aboutToWall,
    expiresAt: expiresAt === Number.NEGATIVE_INFINITY ? Number.POSITIVE_INFINITY : expiresAt,
    remainingPct,
    expiryWindow,
    scarcestWindow,
  };
}

/**
 * Why this account came first, for the `accountSelectionReason` persisted on the agent and
 * shown in the UI. Names a window that actually contributed to the score, so the explanation
 * cannot cite a stale window the scorer discarded. Null when nothing was ranked.
 */
export function describeRank(input: {
  windows: ProviderUsageWindow[];
  mode: AccountRankMode;
  now: number;
}): string | null {
  const score = scoreAccount({ windows: input.windows, now: input.now });
  if (score.unknown) return null;
  if (input.mode === "soonest-expiry" && !score.aboutToWall && score.expiryWindow?.resetsAt) {
    const window = score.expiryWindow;
    return `Automatic selection: quota expires soonest here, ${window.label} resets ${window.resetsAt}`;
  }
  if (!score.scarcestWindow) return null;
  const window = score.scarcestWindow;
  return `Automatic selection: most remaining capacity, ${window.label} at ${window.usedPct}% used`;
}

/**
 * Orders candidates best-first. Chain it ahead of the remembered-account key so an established
 * choice breaks a tie without overriding a genuinely better account.
 */
export function compareByCapacity<T>(input: {
  windowsOf: (candidate: T) => ProviderUsageWindow[];
  mode: AccountRankMode;
  now: number;
}): (a: T, b: T) => number {
  const cache = new Map<T, AccountScore>();
  function score(candidate: T): AccountScore {
    let value = cache.get(candidate);
    if (!value) {
      value = scoreAccount({ windows: input.windowsOf(candidate), now: input.now });
      cache.set(candidate, value);
    }
    return value;
  }
  return (a, b) => {
    const left = score(a);
    const right = score(b);
    if (left.unknown !== right.unknown) return left.unknown ? 1 : -1;
    if (left.unknown) return 0;
    // Whatever the mode, an account minutes from stalling loses to one that is not.
    if (left.aboutToWall !== right.aboutToWall) return left.aboutToWall ? 1 : -1;
    if (input.mode === "soonest-expiry" && !left.aboutToWall && left.expiresAt !== right.expiresAt)
      return left.expiresAt - right.expiresAt;
    return right.remainingPct - left.remainingPct;
  };
}
