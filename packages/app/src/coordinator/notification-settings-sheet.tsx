import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CoordinatorNotificationSettings } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  openNotificationSettingsForm,
  NOTIFICATION_NUMBER_FIELDS,
} from "./notification-settings-model";

const HEADER = { title: "Notifications" };
const LABELS = {
  decisionTimeoutMinutes: "Decision timeout (minutes)",
  digestHour: "Digest hour",
  quietStartHour: "Quiet hours start",
  quietEndHour: "Quiet hours end",
};
function useSettingsModel(snapshot: CoordinatorNotificationSettings) {
  const [model] = useState(() => openNotificationSettingsForm(snapshot));
  useEffect(() => () => model.close(), [model]);
  return model;
}
export function NotificationSettingsSheet(props: {
  visible: boolean;
  snapshot: CoordinatorNotificationSettings;
  onClose: () => void;
  onSave: (settings: CoordinatorNotificationSettings) => Promise<void>;
}) {
  if (!props.visible) return null;
  return <OpenNotificationSettings {...props} />;
}
function OpenNotificationSettings({
  snapshot,
  onClose,
  onSave,
}: Parameters<typeof NotificationSettingsSheet>[0]) {
  const model = useSettingsModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const save = useCallback(async () => {
    if (await model.submit(onSave)) onClose();
  }, [model, onSave, onClose]);
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={HEADER}
      testID="coordinator-notification-settings"
    >
      <View style={styles.content}>
        <Field label="Daily digest">
          <Switch
            value={state.values.digestEnabled}
            onValueChange={model.setDigestEnabled}
            disabled={state.saving}
            accessibilityLabel="Daily digest"
          />
        </Field>
        {NOTIFICATION_NUMBER_FIELDS.filter(
          (field) => field !== "digestHour" || state.values.digestEnabled,
        ).map((field) => (
          <NumberSetting
            key={field}
            field={field}
            size={size}
            value={state.values[field]}
            saving={state.saving}
            model={model}
          />
        ))}
        {state.error ? <Text style={styles.error}>{state.error}</Text> : null}
        <Button
          variant="default"
          loading={state.saving}
          onPress={save}
          testID="notification-settings-save"
        >
          Save
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));

function NumberSetting({
  field,
  size,
  value,
  saving,
  model,
}: {
  field: (typeof NOTIFICATION_NUMBER_FIELDS)[number];
  size: "md" | "sm";
  value: string;
  saving: boolean;
  model: ReturnType<typeof openNotificationSettingsForm>;
}) {
  const change = useCallback((text: string) => model.setNumber(field, text), [model, field]);
  return (
    <Field label={LABELS[field]}>
      <FormTextInput
        size={size}
        initialValue={value}
        onChangeText={change}
        keyboardType="number-pad"
        editable={!saving}
        accessibilityLabel={LABELS[field]}
        testID={`notification-${field}`}
      />
    </Field>
  );
}
