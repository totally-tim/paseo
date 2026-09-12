import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TFunction } from "i18next";
import type { ProviderAccountResetCreditOutcome } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useProviderAccounts } from "./use-provider-accounts";

interface ResetCreditRedemptionResult {
  outcome: ProviderAccountResetCreditOutcome;
  confirmed: boolean;
}

function redemptionNotice(redemption: ResetCreditRedemptionResult, t: TFunction): string {
  switch (redemption.outcome) {
    case "reset":
      return redemption.confirmed
        ? t("providerAccounts.resetCreditApplied")
        : t("providerAccounts.resetCreditUnconfirmed");
    case "nothingToReset":
      return t("providerAccounts.resetCreditNothing");
    case "alreadyRedeemed":
      return t("providerAccounts.resetCreditUsed");
    case "noCredit":
      return t("providerAccounts.resetCreditNone");
  }
}

/**
 * Codex banks a reset credit when it rate-limits a turn unfairly; spending one clears the
 * account's blocked windows. Renders nothing on older hosts, for non-Codex accounts, or when
 * the last usage read reported no credits.
 */
export function ResetCreditControl({
  serverId,
  accountId,
}: {
  serverId: string;
  accountId: string;
}) {
  const { t } = useTranslation();
  const accounts = useProviderAccounts(serverId);
  // COMPAT(providerAccountResetCredits): added after v1.2.0; remove after 2027-03-08.
  const canRedeem = useHostFeature(serverId, "providerAccountResetCredits");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const redeem = useCallback(async () => {
    const account = accounts.data?.accounts.find((entry) => entry.id === accountId);
    if (pending || !account) return;
    const confirmed = await confirmDialog({
      title: t("providerAccounts.useResetCredit"),
      message: t("providerAccounts.useResetCreditConfirm", { account: account.label }),
      confirmLabel: t("providerAccounts.useResetCredit"),
    });
    if (!confirmed) return;
    setPending(true);
    setNotice(null);
    try {
      const result = await accounts.manage({
        kind: "consume-reset-credit",
        accountId,
      });
      const redemption = result.resetCredit;
      if (!redemption) {
        setNotice(t("providerAccounts.resetCreditFailed"));
        return;
      }
      setNotice(redemptionNotice(redemption, t));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("providerAccounts.resetCreditFailed"));
    } finally {
      setPending(false);
    }
  }, [accountId, accounts, pending, t]);

  const account = accounts.data?.accounts.find((entry) => entry.id === accountId);
  const usage = accounts.data?.usage.find((entry) => entry.accountId === accountId)?.usage;
  const count = usage?.resetCredits?.availableCount ?? 0;
  if (!canRedeem || !account || account.provider !== "codex" || count <= 0) return null;
  const expiresAt = usage?.resetCredits?.nextExpiresAt;
  return (
    <View style={styles.row} testID={`reset-credit-${accountId}`}>
      <Text style={styles.text}>
        {t("providerAccounts.resetCredits", { count })}
        {expiresAt
          ? ` · ${t("providerAccounts.resetCreditExpires", { at: new Date(expiresAt).toLocaleString() })}`
          : ""}
      </Text>
      <Button
        variant="outline"
        size="sm"
        onPress={redeem}
        disabled={pending || !accounts.connected}
        testID={`use-reset-credit-${accountId}`}
      >
        {t("providerAccounts.useResetCredit")}
      </Button>
      {notice ? <Text style={styles.text}>{notice}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
