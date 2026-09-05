import type { AgentTimelineItem } from "./agent-sdk-types.js";

type LimitNotification = Extract<AgentTimelineItem, { type: "notification" }>;

export function claudeLimitNotification(info: {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
}): LimitNotification | null {
  if (info.status !== "rejected") return null;
  const resetsAt =
    typeof info.resetsAt === "number" && Number.isFinite(new Date(info.resetsAt * 1000).getTime())
      ? new Date(info.resetsAt * 1000).toISOString()
      : undefined;
  return {
    type: "notification",
    level: "warning",
    code: "provider_capacity",
    resetsAt,
    capacityScope:
      info.rateLimitType === "seven_day_opus" || info.rateLimitType === "seven_day_sonnet"
        ? "model"
        : "account",
    message: `Claude reported a capacity limit.${resetsAt ? ` Capacity resets at ${resetsAt}.` : ""} Use Continue with to choose another account or provider with saved context.`,
  };
}

export function codexLimitNotification(errorInfo: unknown): LimitNotification | null {
  if (errorInfo === "usageLimitExceeded")
    return {
      type: "notification",
      level: "warning",
      code: "provider_capacity",
      capacityScope: "account",
      message:
        "Codex reported a capacity limit. Use Continue with to choose another account or provider with saved context.",
    };
  if (errorInfo === "rateLimitExceeded")
    return {
      type: "notification",
      level: "warning",
      message: "Codex temporarily limited request frequency. Wait before retrying this account.",
    };
  return null;
}
