import { useCallback } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useProviderAccounts } from "./use-provider-accounts";
import { ResetCreditAction } from "./reset-credit-action";

export function ResetCreditControl({
  serverId,
  accountId,
}: {
  serverId: string;
  accountId: string;
}) {
  const accounts = useProviderAccounts(serverId);
  const { manage } = accounts;
  // COMPAT(providerAccountResetCredits): added after v1.2.0; remove after 2027-03-08.
  const canRedeem = useHostFeature(serverId, "providerAccountResetCredits");
  const redeem = useCallback(async () => {
    const result = await manage({ kind: "consume-reset-credit", accountId });
    if (!result.resetCredit) throw new Error("Could not use the reset credit.");
    return result.resetCredit;
  }, [accountId, manage]);
  const account = accounts.data?.accounts.find((entry) => entry.id === accountId);
  const usage = accounts.data?.usage.find((entry) => entry.accountId === accountId)?.usage;
  if (!canRedeem || !account || account.provider !== "codex") return null;
  return (
    <ResetCreditAction
      key={`${serverId}:${accountId}`}
      accountId={accountId}
      accountLabel={account.label}
      count={usage?.resetCredits?.availableCount ?? 0}
      expiresAt={usage?.resetCredits?.nextExpiresAt}
      connected={accounts.connected}
      confirm={confirmDialog}
      redeem={redeem}
    />
  );
}
