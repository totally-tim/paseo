import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TFunction } from "i18next";
import type { ProviderAccountResetCreditOutcome } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface ResetCreditRedemptionResult {
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

/** Keeps the operation result visible after refreshing the last credit away. */
export function ResetCreditAction({
  accountId,
  accountLabel,
  count,
  expiresAt,
  connected,
  confirm,
  redeem,
}: {
  accountId: string;
  accountLabel: string;
  count: number;
  expiresAt?: string | null;
  connected: boolean;
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  redeem: () => Promise<ResetCreditRedemptionResult>;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const onPress = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      const confirmed = await confirm({
        title: t("providerAccounts.useResetCredit"),
        message: t("providerAccounts.useResetCreditConfirm", { account: accountLabel }),
        confirmLabel: t("providerAccounts.useResetCredit"),
      });
      if (!confirmed) return;
      setNotice(null);
      setNotice(redemptionNotice(await redeem(), t));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("providerAccounts.resetCreditFailed"));
    } finally {
      setPending(false);
    }
  }, [accountLabel, confirm, pending, redeem, t]);
  if (count <= 0 && !pending && !notice) return null;
  return (
    <View style={styles.row} testID={`reset-credit-${accountId}`}>
      {count > 0 ? (
        <Text style={styles.text}>
          {t("providerAccounts.resetCredits", { count })}
          {expiresAt
            ? ` · ${t("providerAccounts.resetCreditExpires", { at: new Date(expiresAt).toLocaleString() })}`
            : ""}
        </Text>
      ) : null}
      {count > 0 || pending ? (
        <Button
          variant="outline"
          size="sm"
          onPress={onPress}
          loading={pending}
          disabled={pending || !connected}
          testID={`use-reset-credit-${accountId}`}
        >
          {t("providerAccounts.useResetCredit")}
        </Button>
      ) : null}
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
