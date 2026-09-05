import type { AccountSelection } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "@/provider-usage/types";
import { formatPct } from "@/provider-usage/format";
import type { useProviderAccounts } from "./use-provider-accounts";

type AccountsData = ReturnType<typeof useProviderAccounts>["data"];

export function accountUsageSummary(usage: ProviderUsage | undefined): string | null {
  if (!usage || usage.status !== "available") return null;
  const windows = usage.windows.filter((window) => typeof window.usedPct === "number");
  if (!windows.length) return null;
  return windows
    .map((window) => {
      const label =
        window.id === "five_hour" || window.label === "5-hour window" ? "5h" : window.label;
      return `${label} ${formatPct(window.usedPct!)} used`;
    })
    .join(" · ");
}

export function selectedAccount(
  data: AccountsData,
  provider: string,
  selection?: AccountSelection,
) {
  const next = data?.next.find((entry) => entry.provider === provider)?.accountId;
  let id = next;
  if (selection?.kind === "fixed") id = selection.accountId;
  if (selection?.kind === "default") id = `default:${provider}`;
  if (
    selection?.kind === "automatic" &&
    selection.accountIds &&
    (!id || !selection.accountIds.includes(id))
  )
    return undefined;
  return data?.accounts.find((account) => account.id === id && !account.removedAt);
}
