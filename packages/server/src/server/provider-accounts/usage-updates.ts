import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../messages.js";
import { toneFromUsedPct, toIsoStringOrNull } from "../../services/quota-fetcher/usage.js";

/**
 * Live rate-limit events are sparse: a field the update omits keeps the value the last
 * probe established. `resetsAt`/`periodMinutes` therefore distinguish absent (keep the
 * previous reading) from explicit null (the provider says no reset applies now).
 */
export interface UsageUpdateWindow {
  /** Preferred row id. */
  id: string;
  /** Codex bucket position; lets an update land on a probe row with a limit-id prefix. */
  position?: "primary" | "secondary" | "account_limit";
  /** The update carries no limit id, so a lone prefixed family is the only target. */
  unprefixed?: boolean;
  /** Claude's overage-included bucket rebinds to the model-scoped row a probe drew. */
  modelScoped?: boolean;
  /** Remove the resolved row instead of updating it (a cleared account limit). */
  remove?: boolean;
  label: string;
  usedPct: number;
  resetsAt?: string | null;
  periodMinutes?: number | null;
}

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

/** Absent keeps the probe's value; null clears it; a number is epoch seconds. */
function epochSecondsField(value: number | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return toIsoStringOrNull(value * 1000);
}

const CodexUpdateWindowSchema = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
const CodexUpdateSnapshotSchema = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  rateLimitReachedType: z.string().nullish(),
  spendControlReached: z.boolean().nullish(),
  primary: CodexUpdateWindowSchema.nullish(),
  secondary: CodexUpdateWindowSchema.nullish(),
});

function codexPositionWindow(
  position: "primary" | "secondary",
  value: z.infer<typeof CodexUpdateWindowSchema>,
  limitId: string | undefined,
  title: string | undefined,
): UsageUpdateWindow {
  const minutes = value.windowDurationMins ?? undefined;
  let name = position === "primary" ? "Primary window" : "Secondary window";
  if (minutes != null) name = `${minutes / 60}-hour window`;
  if (minutes === 10_080) name = "Weekly";
  return {
    id: `${limitId ? `${limitId}:` : ""}${position}`,
    position,
    unprefixed: !limitId,
    label: title ? `${name} · ${title}` : name,
    usedPct: value.usedPercent,
    resetsAt: epochSecondsField(value.resetsAt),
    periodMinutes:
      value.windowDurationMins === undefined ? undefined : (value.windowDurationMins ?? null),
  };
}

/**
 * `account/rateLimits/updated` carries the same snapshot shape as `account/rateLimits/read`,
 * minus the per-bucket map: one bucket at a time, named by `limitId`.
 */
export function codexRateLimitsUpdate(raw: unknown): { windows: UsageUpdateWindow[] } | null {
  const parsed = CodexUpdateSnapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  const limitId = snapshot.limitId || undefined;
  const title = snapshot.limitName ?? limitId;
  const windows: UsageUpdateWindow[] = [];
  for (const [position, value] of [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary],
  ] as const) {
    // A null window position means the bucket no longer reports it; leaving the previous
    // row in place matches how every other sparse field merges.
    if (value === undefined || value === null) continue;
    windows.push(codexPositionWindow(position, value, limitId, title));
  }
  const limitReached =
    snapshot.spendControlReached === true || Boolean(snapshot.rateLimitReachedType);
  const limitCleared =
    snapshot.spendControlReached === false || snapshot.rateLimitReachedType === null;
  if (limitReached || limitCleared) {
    windows.push({
      id: `${limitId ? `${limitId}:` : ""}account_limit`,
      position: "account_limit",
      unprefixed: !limitId,
      remove: !limitReached,
      label: title ? `Account limit · ${title}` : "Account limit",
      usedPct: 100,
    });
  }
  return windows.length ? { windows } : null;
}

const ClaudeRateLimitInfoSchema = z.object({
  rateLimitType: z.string().nullish(),
  utilization: z.number().finite().nullish(),
  resetsAt: z.number().nullish(),
});

const CLAUDE_EVENT_WINDOWS: Record<string, { label: string; periodMinutes: number }> = {
  five_hour: { label: "Session", periodMinutes: FIVE_HOUR_MINUTES },
  seven_day: { label: "Weekly", periodMinutes: SEVEN_DAY_MINUTES },
  seven_day_oauth_apps: { label: "Weekly · Agent SDK", periodMinutes: SEVEN_DAY_MINUTES },
  seven_day_opus: { label: "Weekly · Opus", periodMinutes: SEVEN_DAY_MINUTES },
  seven_day_sonnet: { label: "Weekly · Sonnet", periodMinutes: SEVEN_DAY_MINUTES },
};

/**
 * `rate_limit_event` names one window at a time; utilization is a 0–1 fraction and the
 * reset is epoch seconds. The overage-included type stands in for whichever model-scoped
 * bucket the probe reported, which only the merge can resolve.
 */
export function claudeRateLimitEventUpdate(raw: unknown): { windows: UsageUpdateWindow[] } | null {
  const parsed = ClaudeRateLimitInfoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const info = parsed.data;
  if (!info.rateLimitType || typeof info.utilization !== "number") return null;
  const resetsAt = epochSecondsField(info.resetsAt);
  const named = CLAUDE_EVENT_WINDOWS[info.rateLimitType];
  if (named) {
    return {
      windows: [
        {
          id: info.rateLimitType,
          label: named.label,
          periodMinutes: named.periodMinutes,
          usedPct: info.utilization * 100,
          resetsAt,
        },
      ],
    };
  }
  if (info.rateLimitType === "seven_day_overage_included") {
    return {
      windows: [
        {
          id: "model_scoped",
          modelScoped: true,
          label: "Weekly",
          periodMinutes: SEVEN_DAY_MINUTES,
          usedPct: info.utilization * 100,
          resetsAt,
        },
      ],
    };
  }
  return null;
}

/**
 * Find the row an update belongs to. Probes prefix Codex rows with their metered limit id
 * (`codex:primary`) while an update may name no bucket at all; an unprefixed update binds
 * to the only bucket family present. With several families and no limit id there is no safe
 * target, so the update is dropped rather than drawn on the wrong account row.
 */
function resolveUpdateWindowId(
  update: UsageUpdateWindow,
  existing: ProviderUsageWindow[],
): string | null {
  if (update.modelScoped) {
    const scoped = existing.filter((window) => window.id.startsWith("model:"));
    return scoped.length === 1 ? scoped[0].id : null;
  }
  if (!update.position) return update.id;
  const families = new Set<string>();
  for (const window of existing) {
    const match = /^(?:(.*):)?(primary|secondary|account_limit)$/.exec(window.id);
    if (match) families.add(match[1] ?? "");
  }
  if (update.unprefixed) {
    if (families.size > 1) return null;
    const [family] = families;
    return family ? `${family}:${update.position}` : update.id;
  }
  if (existing.some((window) => window.id === update.id)) return update.id;
  if (families.size === 1 && families.has("")) return update.position;
  return update.id;
}

function sameWindow(a: ProviderUsageWindow, b: ProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.usedPct === b.usedPct &&
    a.resetsAt === b.resetsAt &&
    a.periodMinutes === b.periodMinutes
  );
}

/**
 * Fold a live update into the cached snapshot. Windows upsert by resolved id; a window the
 * update omits keeps its reading, and a window that arrives without `resetsAt` or
 * `periodMinutes` keeps what the probe resolved. Returns null when nothing changed so the
 * caller can skip cache writes for the frequent identical Codex ticks.
 */
export function mergeAccountUsageUpdate(input: {
  previous: ProviderUsage | null;
  update: { windows: UsageUpdateWindow[] };
  providerId: string;
  displayName: string;
  fetchedAt: string;
  nextRefreshAt: string;
}): ProviderUsage | null {
  const { previous, update } = input;
  if (update.windows.length === 0) return null;
  const existing = previous?.windows ?? [];
  const merged = new Map(existing.map((window) => [window.id, window] as const));
  let changed = previous === null;
  for (const window of update.windows) {
    const id = resolveUpdateWindowId(window, existing);
    if (!id) continue;
    const current = merged.get(id);
    if (window.remove) {
      if (current) {
        merged.delete(id);
        changed = true;
      }
      continue;
    }
    const usedPct = Math.max(0, Math.min(100, window.usedPct));
    const next: ProviderUsageWindow = current
      ? {
          ...current,
          usedPct,
          remainingPct: Math.max(0, 100 - usedPct),
          resetsAt: window.resetsAt === undefined ? current.resetsAt : window.resetsAt,
          periodMinutes:
            window.periodMinutes === undefined ? current.periodMinutes : window.periodMinutes,
          tone: toneFromUsedPct(usedPct),
          // A fresh reading invalidates depletion estimates derived from the old one.
          runsOutAt: undefined,
          shortfallPct: undefined,
        }
      : {
          id,
          label: window.label,
          usedPct,
          remainingPct: Math.max(0, 100 - usedPct),
          resetsAt: window.resetsAt ?? null,
          ...(window.periodMinutes != null ? { periodMinutes: window.periodMinutes } : {}),
          tone: toneFromUsedPct(usedPct),
        };
    if (!current || !sameWindow(current, next)) {
      merged.set(id, next);
      changed = true;
    }
  }
  if (!changed) return null;
  return {
    ...(previous ?? {
      providerId: input.providerId,
      displayName: input.displayName,
      status: "available" as const,
      planLabel: null,
      windows: [],
      error: null,
    }),
    displayName: input.displayName,
    windows: [...merged.values()],
    fetchedAt: input.fetchedAt,
    nextRefreshAt: input.nextRefreshAt,
  };
}
