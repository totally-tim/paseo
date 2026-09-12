import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { formatPct, formatResetLabel } from "@/provider-usage/format";
import type { Theme } from "@/styles/theme";
import {
  collectAccountUsagePools,
  type AccountUsagePool,
  type PooledUsageWindow,
} from "./pooled-usage";
import { ResetCreditControl } from "./reset-credit";
import { useProviderAccounts } from "./use-provider-accounts";

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" } as const;

function ProviderIcon({ iconKey, size, color }: { iconKey: string; size: number; color: string }) {
  const Icon = getProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}
const ThemedProviderIcon = withUnistyles(ProviderIcon);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function segmentTone(usedPct: number | null) {
  if (usedPct === null) return styles.fillUnknown;
  if (usedPct >= 95) return styles.fillDanger;
  if (usedPct >= 80) return styles.fillWarning;
  return styles.fillOk;
}

function paceLabel(delta: number | null, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (delta === null) return null;
  if (Math.abs(delta) <= 5) return t("providerAccounts.paceOnPace");
  return delta > 0 ? t("providerAccounts.paceFast") : t("providerAccounts.paceSlow");
}

/**
 * One pooled bar per shared quota window: an equal-width column per account, filled by how
 * much of that account's window is spent. Tapping a column shows that account's reading.
 */
export function PooledAccountUsage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const accounts = useProviderAccounts(serverId);
  const [selected, setSelected] = useState<string | null>(null);
  const pools = useMemo(
    () =>
      collectAccountUsagePools({
        accounts: accounts.data?.accounts ?? [],
        usage: accounts.data?.usage ?? [],
      }),
    [accounts.data],
  );
  if (!pools.length) return null;
  return (
    <View style={styles.pools} testID="pooled-account-usage">
      {pools.map((pool) => (
        <PoolCard
          key={pool.provider}
          serverId={serverId}
          pool={pool}
          selected={selected}
          onSelect={setSelected}
          t={t}
        />
      ))}
    </View>
  );
}

function PoolCard({
  serverId,
  pool,
  selected,
  onSelect,
  t,
}: {
  serverId: string;
  pool: AccountUsagePool;
  selected: string | null;
  onSelect: (accountId: string | null) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const selectedEntry = selected
    ? pool.accounts.find((account) => account.accountId === selected)
    : null;
  return (
    <View style={styles.pool}>
      <View style={styles.poolHeader}>
        <ThemedProviderIcon iconKey={pool.provider} size={14} uniProps={mutedIcon} />
        <Text style={styles.poolTitle}>{PROVIDER_NAMES[pool.provider]}</Text>
        <Text style={styles.poolMeta}>
          {t("providerAccounts.pooledAccounts", { count: pool.accounts.length })}
          {pool.hiddenAccounts
            ? ` · ${t("providerAccounts.pooledDuplicates", { count: pool.hiddenAccounts })}`
            : ""}
        </Text>
      </View>
      {pool.windows.map((window) => (
        <PoolWindowRow
          key={window.key}
          window={window}
          accountIds={pool.accounts.map((account) => account.accountId)}
          selected={selected}
          onSelect={onSelect}
          t={t}
        />
      ))}
      {selectedEntry ? (
        <View style={styles.detail}>
          <Text style={styles.detailTitle}>
            {selectedEntry.label}
            {selectedEntry.planLabel ? ` · ${selectedEntry.planLabel}` : ""}
            {selectedEntry.stale ? ` · ${t("providerAccounts.stale")}` : ""}
          </Text>
          <ResetCreditControl serverId={serverId} accountId={selectedEntry.accountId} />
        </View>
      ) : null}
    </View>
  );
}

function PoolWindowRow({
  window,
  accountIds,
  selected,
  onSelect,
  t,
}: {
  window: PooledUsageWindow;
  accountIds: string[];
  selected: string | null;
  onSelect: (accountId: string | null) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const pace = paceLabel(window.paceDeltaPct, t);
  const refill = window.nextRefill;
  const refillIn = refill ? formatResetLabel(refill.at)?.replace("resets ", "") : null;
  return (
    <View style={styles.window} testID={`pooled-window-${window.key}`}>
      <View style={styles.windowHeader}>
        <Text style={styles.windowLabel} numberOfLines={1}>
          {window.label}
        </Text>
        <Text style={styles.windowValue}>
          {window.remainingPct !== null
            ? t("providerAccounts.pooledRemaining", { pct: formatPct(window.remainingPct) })
            : "—"}
        </Text>
      </View>
      <View style={styles.bar}>
        {window.segments.map((segment, index) => {
          const accountId = accountIds[index];
          return (
            <PoolSegment
              key={accountId}
              windowKey={window.key}
              accountId={accountId}
              usedPct={segment?.usedPct ?? null}
              selected={selected === accountId}
              onSelect={onSelect}
            />
          );
        })}
      </View>
      <Text style={styles.windowMeta}>
        {[
          pace,
          refill && refillIn
            ? t("providerAccounts.pooledRefill", {
                pct: formatPct(refill.restoresPct),
                in: refillIn,
              })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </View>
  );
}

function PoolSegment({
  windowKey,
  accountId,
  usedPct,
  selected,
  onSelect,
}: {
  windowKey: string;
  accountId: string;
  usedPct: number | null;
  selected: boolean;
  onSelect: (accountId: string | null) => void;
}) {
  const onPress = useCallback(
    () => onSelect(selected ? null : accountId),
    [selected, accountId, onSelect],
  );
  return (
    <Pressable
      style={[styles.segment, selected && styles.segmentSelected]}
      onPress={onPress}
      accessibilityLabel={accountId}
      testID={`pooled-segment-${windowKey}-${accountId}`}
    >
      <View
        style={[
          styles.segmentFill,
          segmentTone(usedPct),
          { width: `${Math.max(0, Math.min(100, usedPct ?? 0))}%` },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  pools: { gap: theme.spacing[4] },
  pool: { gap: theme.spacing[2] },
  poolHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  poolTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  poolMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  window: { gap: 3 },
  windowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  windowLabel: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  windowValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  bar: { flexDirection: "row", gap: 2, height: 6 },
  segment: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  segmentSelected: { borderWidth: 1, borderColor: theme.colors.foregroundMuted },
  segmentFill: { height: 6, borderRadius: 3 },
  fillOk: { backgroundColor: theme.colors.statusSuccess },
  fillWarning: { backgroundColor: theme.colors.statusWarning },
  fillDanger: { backgroundColor: theme.colors.statusDanger },
  fillUnknown: { backgroundColor: "transparent" },
  windowMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  detail: { gap: theme.spacing[1], paddingTop: theme.spacing[1] },
  detailTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
