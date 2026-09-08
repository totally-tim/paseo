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

export function applicableAccountUsage(
  usage: ProviderUsage | undefined,
  model?: string | null,
): ProviderUsage | null {
  if (!usage) return null;
  const windows = getAccountUsageWindows(usage, model ?? undefined);
  return usage.status === "available" && !windows.length ? null : { ...usage, windows };
}
