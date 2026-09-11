import type { PluginTheme } from "@getpaseo/plugin";

import { Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { cardTitle, type CardActions } from "./card";
import {
  type CardReason,
  formatSince,
  formatUntil,
  type InboxCard,
  type NeedsReason,
} from "./lanes";
import { ActionButton } from "./question-card";
import { firstLine } from "./timeline-text";
import type { PaseoApi } from "./types";

const REASON_CHIP: Record<NeedsReason, string> = {
  question: "Questions",
  permission: "Approvals",
  error: "Errors",
};

function useExtraStyles(theme: PluginTheme) {
  return useMemo(
    () =>
      StyleSheet.create({
        row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
        muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
        snoozedSection: { gap: 6 },
        snoozedPressable: { flex: 1, minWidth: 0 },
        helpContent: { gap: 10 },
        snoozedRow: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 6,
          paddingHorizontal: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          opacity: 0.65,
        },
        snoozedTitle: {
          flex: 1,
          minWidth: 0,
          color: theme.colors.foregroundMuted,
          fontSize: 13,
        },
        groupLabel: {
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "600",
          paddingTop: 4,
        },
        helpRow: { flexDirection: "row", gap: 12, alignItems: "baseline" },
        helpKey: {
          color: theme.colors.foreground,
          fontSize: 12,
          fontWeight: "600",
          minWidth: 56,
        },
        helpText: { color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 },
      }),
    [theme],
  );
}

export function ReasonChips({
  cards,
  selected,
  theme,
  onSelect,
}: {
  /** Visible + snoozed needs-you cards, before the reason filter applies. */
  cards: readonly InboxCard[];
  selected: NeedsReason | null;
  theme: PluginTheme;
  onSelect(reason: NeedsReason | null): void;
}) {
  const styles = useExtraStyles(theme);
  const reasons = useMemo(() => {
    const present = new Set<CardReason>();
    for (const card of cards) present.add(card.reason);
    return (Object.keys(REASON_CHIP) as NeedsReason[]).filter((reason) => present.has(reason));
  }, [cards]);
  const all = useCallback(() => onSelect(null), [onSelect]);
  if (reasons.length === 0 && selected === null) return null;
  return (
    <View style={styles.row}>
      <ActionButton theme={theme} label="All" primary={selected === null} onPress={all} />
      {reasons.map((reason) => (
        <ReasonChip
          key={reason}
          reason={reason}
          count={cards.filter((card) => card.reason === reason).length}
          selected={selected === reason}
          theme={theme}
          onSelect={onSelect}
        />
      ))}
    </View>
  );
}

function ReasonChip({
  reason,
  count,
  selected,
  theme,
  onSelect,
}: {
  reason: NeedsReason;
  count: number;
  selected: boolean;
  theme: PluginTheme;
  onSelect(reason: NeedsReason): void;
}) {
  const press = useCallback(() => onSelect(reason), [reason, onSelect]);
  return (
    <ActionButton
      theme={theme}
      label={`${REASON_CHIP[reason]} ${count}`}
      primary={selected}
      onPress={press}
    />
  );
}

/** Cards the user dismissed; visible again when their wait state changes. */
export function SnoozedSection({
  cards,
  theme,
  now,
  actions,
}: {
  cards: readonly InboxCard[];
  theme: PluginTheme;
  now: number;
  actions: CardActions;
}) {
  const styles = useExtraStyles(theme);
  if (cards.length === 0) return null;
  return (
    <View style={styles.snoozedSection}>
      {cards.map((card) => (
        <SnoozedRow key={card.agent.id} card={card} theme={theme} now={now} actions={actions} />
      ))}
    </View>
  );
}

function SnoozedRow({
  card,
  theme,
  now,
  actions,
}: {
  card: InboxCard;
  theme: PluginTheme;
  now: number;
  actions: CardActions;
}) {
  const styles = useExtraStyles(theme);
  const unsnooze = useCallback(() => actions.onUnsnooze(card.agent.id), [actions, card.agent.id]);
  const open = useCallback(() => actions.onOpen(card), [actions, card]);
  const since = formatSince(card.since, now);
  return (
    <View style={styles.snoozedRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Preview snoozed ${cardTitle(card)}`}
        onPress={open}
        style={styles.snoozedPressable}
      >
        <Text numberOfLines={1} style={styles.snoozedTitle}>
          {cardTitle(card)}
          {since ? ` · ${since} waiting` : ""}
        </Text>
      </Pressable>
      <ActionButton theme={theme} label="Unsnooze" onPress={unsnooze} />
    </View>
  );
}

/** Upcoming scheduled runs on this host — the board's "what's coming" line. */
export function SchedulesStrip({
  paseo,
  theme,
  active,
  now,
}: {
  paseo: PaseoApi;
  theme: PluginTheme;
  active: boolean;
  now: number;
}) {
  const schedules = paseo.schedules;
  const supported = typeof schedules?.list === "function";
  const styles = useExtraStyles(theme);
  const query = useQuery({
    queryKey: ["inbox", "schedules"],
    enabled: active && supported,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!schedules) throw new Error("Schedules unavailable");
      return schedules.list();
    },
  });
  if (!supported) return null;
  if (query.isError) {
    return <Text style={styles.muted}>Schedules unavailable.</Text>;
  }
  if (!query.data) return null;
  const upcoming = query.data.schedules
    .filter((schedule) => schedule.status === "active" && schedule.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
  if (upcoming.length === 0) return null;
  const next = upcoming[0];
  const name = next.name?.trim() || firstLine(next.prompt, 60) || "Untitled";
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>
        Scheduled · {name} {formatUntil(next.nextRunAt, now)}
        {upcoming.length > 1 ? ` · ${upcoming.length} active` : ""}
      </Text>
    </View>
  );
}

const SHORTCUTS: readonly [string, string][] = [
  ["j / k", "Move focus between cards"],
  ["Enter / o", "Preview the focused card"],
  ["O", "Open the focused card's agent"],
  ["1–9", "Answer a single-choice question"],
  ["y / n", "Allow or deny a permission"],
  ["m", "Mark the focused done card read"],
  ["x", "Archive the focused done card's agent"],
  ["s", "Snooze the focused needs-you card"],
  ["Esc", "Close the preview, then clear focus"],
  ["?", "Show this list"],
];

export function ShortcutHelp({
  open,
  theme,
  onClose,
}: {
  open: boolean;
  theme: PluginTheme;
  onClose(): void;
}) {
  const styles = useExtraStyles(theme);
  const changeOpen = useCallback(
    (value: boolean) => {
      if (!value) onClose();
    },
    [onClose],
  );
  return (
    <Modal title="Kanban shortcuts" open={open} onOpenChange={changeOpen}>
      <Modal.Content>
        <View style={styles.helpContent}>
          {SHORTCUTS.map(([key, description]) => (
            <View key={key} style={styles.helpRow}>
              <Text style={styles.helpKey}>{key}</Text>
              <Text style={styles.helpText}>{description}</Text>
            </View>
          ))}
        </View>
      </Modal.Content>
    </Modal>
  );
}
