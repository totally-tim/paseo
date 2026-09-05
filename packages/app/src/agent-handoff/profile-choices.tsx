import { useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  AgentProfileGlyph,
  type AgentProfilePicker,
  type AgentProfilePickerRow,
} from "@/agent-profiles";
import { Field } from "@/components/ui/form-field";

function ProfileChoice({
  row,
  onApply,
  disabled,
}: {
  row: AgentProfilePickerRow;
  onApply: (id: string) => void;
  disabled: boolean;
}) {
  const apply = useCallback(() => onApply(row.id), [onApply, row.id]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (pressed || hovered) && styles.active,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={apply}
      style={rowStyle}
      testID={`agent-handoff-profile-${row.id}`}
    >
      <AgentProfileGlyph icon={row.icon} color={row.color} />
      <View style={styles.content}>
        <Text style={styles.name}>{row.name}</Text>
        <Text style={styles.summary}>{row.summary}</Text>
        {row.accountSummary ? <Text style={styles.summary}>{row.accountSummary}</Text> : null}
      </View>
    </Pressable>
  );
}

export function HandoffProfileChoices({
  profiles,
  disabled,
}: {
  profiles: AgentProfilePicker;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  if (profiles.rows.length === 0) return null;
  return (
    <Field label={t("settings.host.agentProfiles.sectionTitle")}>
      <View style={styles.choices}>
        {profiles.rows.map((row) => (
          <ProfileChoice
            key={row.id}
            row={row}
            onApply={profiles.applyProfile}
            disabled={disabled}
          />
        ))}
      </View>
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  choices: { gap: theme.spacing[1] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    minHeight: 56,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  active: { backgroundColor: theme.colors.surface3 },
  disabled: { opacity: theme.opacity[50] },
  content: { flex: 1, gap: theme.spacing[1] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  summary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
