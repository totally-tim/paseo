import type { PluginTheme } from "@getpaseo/plugin";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { CheckoutPrStatusResult, PaseoApi } from "./types";

export type PrChipTone = "success" | "warning" | "danger" | "accent" | "muted";

export interface PrChipModel {
  label: string;
  tone: PrChipTone;
}

type PrStatus = NonNullable<CheckoutPrStatusResult["status"]>;

function prNumber(url: string): number | null {
  const match = url.match(/\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

function stateLabel(status: PrStatus): string {
  if (status.isMerged || status.state === "merged") return "merged";
  if (status.state === "open") return status.isDraft ? "draft" : "open";
  return "closed";
}

function checksLabel(status: PrStatus): string | null {
  switch (status.checksStatus?.toLowerCase()) {
    case "success":
      return "✓";
    case "failure":
      return "✗";
    case "pending":
      return "…";
    default:
      return null;
  }
}

function reviewLabel(status: PrStatus): string | null {
  switch (status.reviewDecision) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes";
    default:
      return null;
  }
}

/** The chip a card shows for its workspace's change request, or null to render nothing. */
export function prChipModel(
  payload: CheckoutPrStatusResult | null | undefined,
): PrChipModel | null {
  const status = payload?.status;
  if (!status?.url) return null;
  const number = status.number ?? prNumber(status.url);

  const checks = checksLabel(status);
  // A forge URL without a parseable number still earns a state-only chip.
  const parts = [number === null ? stateLabel(status) : `#${number} ${stateLabel(status)}`];
  if (checks) parts.push(`checks ${checks}`);
  const review = reviewLabel(status);
  if (review) parts.push(review);

  const checksState = status.checksStatus?.toLowerCase();
  let tone: PrChipTone;
  if (checksState === "failure") tone = "danger";
  else if (checksState === "pending") tone = "warning";
  else if (status.isMerged || status.state === "merged") tone = "success";
  else if (status.state === "open") tone = "accent";
  else tone = "muted";
  return { label: parts.join(" · "), tone };
}

export function useCheckoutPrStatus(paseo: PaseoApi, cwd: string | null, enabled: boolean) {
  const checkout = paseo.checkout;
  const supported = typeof checkout?.prStatus === "function";
  return useQuery({
    queryKey: ["inbox", "pr", cwd],
    enabled: enabled && supported && Boolean(cwd),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!checkout || !cwd) throw new Error("PR status unavailable");
      return checkout.prStatus(cwd);
    },
  });
}

function toneColor(tone: PrChipTone, theme: PluginTheme): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "accent":
      return theme.colors.accent;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}

export function PrChip({ model, theme }: { model: PrChipModel; theme: PluginTheme }) {
  const color = toneColor(model.tone, theme);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        chip: {
          alignSelf: "flex-start",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderWidth: 1,
          borderColor: color,
          borderRadius: 7,
          paddingHorizontal: 7,
          paddingVertical: 2,
        },
        text: { color, fontSize: 11, fontWeight: "600" },
      }),
    [color],
  );
  return (
    <View style={styles.chip}>
      <Text style={styles.text}>{model.label}</Text>
    </View>
  );
}
