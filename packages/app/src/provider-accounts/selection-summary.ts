import type { AccountSelection } from "@getpaseo/protocol/provider-accounts";
import type { useProviderAccounts } from "./use-provider-accounts";

type AccountsData = ReturnType<typeof useProviderAccounts>["data"];

/** Automatic selection is model-specific and only resolves at admission. */
export function selectedAccount(
  data: AccountsData,
  provider: string,
  selection?: AccountSelection,
) {
  if (!selection || selection.kind === "automatic") return undefined;
  const id = selection.kind === "fixed" ? selection.accountId : `default:${provider}`;
  return data?.accounts.find(
    (account) => account.id === id && account.provider === provider && !account.removedAt,
  );
}
