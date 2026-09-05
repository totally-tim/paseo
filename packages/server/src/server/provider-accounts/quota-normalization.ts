import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../messages.js";
import {
  toneFromUsedPct,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../../services/quota-fetcher/usage.js";

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
const CodexUsageSchema = z.object({
  rateLimits: z.object({
    primary: CodexWindowSchema.nullish(),
    secondary: CodexWindowSchema.nullish(),
    planType: z.string().nullish(),
    spendControlReached: z.boolean().nullish(),
    rateLimitReachedType: z.string().nullish(),
  }),
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
    const value = result.rate_limits[id];
    if (value)
      windows.push(
        windowFromUsedPct({
          id,
          label: name,
          utilizationPct: value.utilization,
          resetsAt: value.resets_at,
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
  const { rateLimits } = CodexUsageSchema.parse(raw);
  const windows: ProviderUsageWindow[] = [];
  for (const [id, value] of [
    ["primary", rateLimits.primary],
    ["secondary", rateLimits.secondary],
  ] as const) {
    if (!value) continue;
    const minutes = value.windowDurationMins;
    let name = id === "primary" ? "Primary window" : "Secondary window";
    if (minutes != null) name = `${minutes / 60}-hour window`;
    if (minutes === 10_080) name = "Weekly";
    windows.push(
      windowFromUsedPct({
        id,
        label: name,
        utilizationPct: value.usedPercent,
        resetsAt: value.resetsAt == null ? null : toIsoStringOrNull(value.resetsAt * 1000),
        tone: toneFromUsedPct(value.usedPercent),
      }),
    );
  }
  if (rateLimits.spendControlReached || rateLimits.rateLimitReachedType)
    windows.push(
      windowFromUsedPct({ id: "account_limit", label: "Account limit", utilizationPct: 100 }),
    );
  return {
    providerId: "codex",
    displayName: label,
    status: "available",
    planLabel: rateLimits.planType ?? null,
    windows,
    error: null,
  };
}
