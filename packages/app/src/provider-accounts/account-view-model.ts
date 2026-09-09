import { getAccountUsageWindows, type ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "@getpaseo/protocol/messages";

export function continuationAccountChoices(
  catalog: readonly ProviderAccount[] | undefined,
  provider: string,
  selected: readonly string[],
) {
  const accounts =
    catalog?.filter((account) => account.provider === provider && !account.removedAt) ?? [];
  return {
    accounts,
    unavailable: catalog
      ? selected.filter((id) => !accounts.some((account) => account.id === id))
      : [],
  };
}

/**
 * The daemon holds a remembered capacity rejection until the provider's reported reset, or for a
 * bounded cooldown when it named none (`UNDATED_CAPACITY_COOLDOWN_MS` in the account service).
 * A picker that kept showing the note past that point would send people away from an account the
 * daemon is willing to start again.
 */
const UNDATED_CAPACITY_COOLDOWN_MS = 15 * 60_000;

export function activeCapacityLimit(
  account: ProviderAccount,
  model?: string | null,
  now: number = Date.now(),
): NonNullable<ProviderAccount["capacityLimit"]> | null {
  const limit = account.capacityLimit;
  if (!limit) return null;
  if (limit.model && limit.model !== model?.trim()) return null;
  const clearsAt = limit.resetsAt
    ? Date.parse(limit.resetsAt)
    : Date.parse(limit.observedAt) + UNDATED_CAPACITY_COOLDOWN_MS;
  return Number.isFinite(clearsAt) && clearsAt > now ? limit : null;
}

export function applicableAccountUsage(
  usage: ProviderUsage | undefined,
  model?: string | null,
): ProviderUsage | null {
  if (!usage) return null;
  const windows = getAccountUsageWindows(usage, model ?? undefined);
  return usage.status === "available" && !windows.length ? null : { ...usage, windows };
}
