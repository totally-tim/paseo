import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../messages.js";
import {
  toneFromUsedPct,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../../services/quota-fetcher/usage.js";

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

const ClaudeWindowSchema = z.object({
  utilization: z.number().finite().nullable(),
  resets_at: z.string().nullable(),
});
const ClaudeUsageSchema = z.object({
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: ClaudeWindowSchema.nullish(),
      seven_day: ClaudeWindowSchema.nullish(),
      seven_day_oauth_apps: ClaudeWindowSchema.nullish(),
      seven_day_opus: ClaudeWindowSchema.nullish(),
      seven_day_sonnet: ClaudeWindowSchema.nullish(),
      model_scoped: z.array(ClaudeWindowSchema.extend({ display_name: z.string() })).optional(),
    })
    .nullable(),
});
const CodexWindowSchema = z.object({
  usedPercent: z.number().finite().nullable(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
const CodexBucketSchema = z.object({
  primary: CodexWindowSchema.nullish(),
  secondary: CodexWindowSchema.nullish(),
  limitName: z.string().nullish(),
  planType: z.string().nullish(),
  spendControlReached: z.boolean().nullish(),
  rateLimitReachedType: z.string().nullish(),
});
const CodexResetCreditSchema = z.object({
  status: z.string(),
  expiresAt: z.number().nullish(),
});
const CodexUsageSchema = z.object({
  rateLimits: CodexBucketSchema,
  rateLimitsByLimitId: z.record(z.string(), CodexBucketSchema).nullish(),
  rateLimitResetCredits: z
    .object({
      availableCount: z.number().finite(),
      credits: z.array(CodexResetCreditSchema).nullish(),
    })
    .nullish(),
});

export function normalizeClaudeAccountUsage(label: string, raw: unknown): ProviderUsage {
  const result = ClaudeUsageSchema.parse(raw);
  if (!result.rate_limits_available || !result.rate_limits)
    return unavailableUsage({ providerId: "claude", displayName: label });
  const windows: ProviderUsageWindow[] = [];
  for (const [id, name] of [
    ["five_hour", "Session"],
    ["seven_day", "Weekly"],
    ["seven_day_oauth_apps", "Weekly · Agent SDK"],
    ["seven_day_opus", "Weekly · Opus"],
    ["seven_day_sonnet", "Weekly · Sonnet"],
  ] as const) {
    // Claude names the period instead of reporting it. Account ranking needs the number to
    // tell a session window from a weekly one without matching on ids again.
    const periodMinutes = id === "five_hour" ? FIVE_HOUR_MINUTES : SEVEN_DAY_MINUTES;
    const value = result.rate_limits[id];
    // The usage endpoint returns a null entry for every bucket the plan does not have — a
    // subscription without an Opus bucket gets seven_day_opus: null. That is an absent
    // window, not an unread one. Only a present object with null utilization is an unknown
    // reading, and it must keep blocking automatic admission.
    if (value == null) continue;
    windows.push(
      windowFromUsedPct({
        id,
        label: name,
        utilizationPct: value.utilization,
        resetsAt: value.resets_at,
        periodMinutes,
        tone: toneFromUsedPct(value.utilization),
      }),
    );
  }
  for (const [index, value] of (result.rate_limits.model_scoped ?? []).entries()) {
    windows.push(
      windowFromUsedPct({
        id: `model:${index}:${value.display_name}`,
        label: `Weekly · ${value.display_name}`,
        utilizationPct: value.utilization,
        resetsAt: value.resets_at,
        // Every model-scoped bucket observed so far resets on the weekly boundary, and the
        // label Claude gives them says "Weekly" too.
        periodMinutes: SEVEN_DAY_MINUTES,
      }),
    );
  }
  return {
    providerId: "claude",
    displayName: label,
    status: "available",
    planLabel: result.subscription_type,
    windows,
    error: null,
  };
}

export function normalizeCodexAccountUsage(label: string, raw: unknown): ProviderUsage {
  const { rateLimits, rateLimitsByLimitId, rateLimitResetCredits } = CodexUsageSchema.parse(raw);
  // `rateLimits` is the compatibility view of one metered bucket that also appears in the
  // map. Reading both would count that bucket twice and hide the other buckets' limits.
  const buckets = Object.entries(rateLimitsByLimitId ?? {});
  const metered: Array<[string, z.infer<typeof CodexBucketSchema>]> = buckets.length
    ? buckets
    : [["", rateLimits]];
  const windows: ProviderUsageWindow[] = [];
  for (const [limitId, bucket] of metered) {
    const prefix = limitId ? `${limitId}:` : "";
    const title = bucket.limitName ?? limitId;
    for (const [id, value] of [
      ["primary", bucket.primary],
      ["secondary", bucket.secondary],
    ] as const) {
      if (!value) continue;
      const minutes = value.windowDurationMins;
      let name = id === "primary" ? "Primary window" : "Secondary window";
      if (minutes != null) name = `${minutes / 60}-hour window`;
      if (minutes === 10_080) name = "Weekly";
      windows.push(
        windowFromUsedPct({
          id: `${prefix}${id}`,
          label: title ? `${name} · ${title}` : name,
          utilizationPct: value.usedPercent,
          resetsAt: value.resetsAt == null ? null : toIsoStringOrNull(value.resetsAt * 1000),
          periodMinutes: minutes ?? null,
          tone: toneFromUsedPct(value.usedPercent),
        }),
      );
    }
    if (bucket.spendControlReached || bucket.rateLimitReachedType)
      windows.push(
        windowFromUsedPct({
          id: `${prefix}account_limit`,
          label: title ? `Account limit · ${title}` : "Account limit",
          utilizationPct: 100,
        }),
      );
  }
  return {
    providerId: "codex",
    displayName: label,
    status: "available",
    planLabel: rateLimits.planType ?? metered[0]?.[1].planType ?? null,
    windows,
    resetCredits: codexResetCredits(rateLimitResetCredits),
    error: null,
  };
}

// Codex grants these after it rate-limits a turn unfairly; each spend clears the
// account's blocked windows. `nextExpiresAt` is the soonest available credit's expiry.
function codexResetCredits(
  credits: z.infer<typeof CodexUsageSchema>["rateLimitResetCredits"],
): ProviderUsage["resetCredits"] {
  if (!credits || credits.availableCount <= 0) return undefined;
  const expiries = (credits.credits ?? [])
    .filter((credit) => credit.status === "available" && typeof credit.expiresAt === "number")
    .map((credit) => credit.expiresAt as number);
  return {
    availableCount: Math.max(0, credits.availableCount),
    ...(expiries.length ? { nextExpiresAt: toIsoStringOrNull(Math.min(...expiries) * 1000) } : {}),
  };
}
