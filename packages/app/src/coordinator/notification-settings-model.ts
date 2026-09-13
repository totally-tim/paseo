import type { CoordinatorNotificationSettings } from "@getpaseo/protocol/messages";

type NumericField = Exclude<keyof CoordinatorNotificationSettings, "digestEnabled">;
export const NOTIFICATION_NUMBER_FIELDS: readonly NumericField[] = [
  "decisionTimeoutMinutes",
  "digestHour",
  "quietStartHour",
  "quietEndHour",
];

export function openNotificationSettingsForm(snapshot: CoordinatorNotificationSettings) {
  const listeners = new Set<() => void>();
  let closed = false;
  let state = {
    values: {
      decisionTimeoutMinutes: String(snapshot.decisionTimeoutMinutes),
      digestHour: String(snapshot.digestHour),
      quietStartHour: String(snapshot.quietStartHour),
      quietEndHour: String(snapshot.quietEndHour),
      digestEnabled: snapshot.digestEnabled,
    },
    saving: false,
    error: null as string | null,
  };
  function publish() {
    if (!closed) for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    setNumber: (field: NumericField, value: string) => {
      if (closed || state.saving) return;
      state = { ...state, values: { ...state.values, [field]: value }, error: null };
      publish();
    },
    setDigestEnabled: (digestEnabled: boolean) => {
      if (closed || state.saving) return;
      state = { ...state, values: { ...state.values, digestEnabled }, error: null };
      publish();
    },
    async submit(save: (settings: CoordinatorNotificationSettings) => Promise<void>) {
      if (closed || state.saving) return false;
      const values = state.values;
      const invalid = NOTIFICATION_NUMBER_FIELDS.find((field) => {
        const value = Number(values[field]);
        return (
          !/^\d+$/.test(values[field]) ||
          !Number.isSafeInteger(value) ||
          (field === "decisionTimeoutMinutes"
            ? value < 1 || value > 43200
            : value < 0 || value > 23)
        );
      });
      if (invalid) {
        state = {
          ...state,
          error:
            invalid === "decisionTimeoutMinutes"
              ? "Enter a timeout from 1 to 43,200 minutes."
              : "Enter hours from 0 to 23.",
        };
        publish();
        return false;
      }
      state = { ...state, saving: true, error: null };
      publish();
      try {
        await save({
          decisionTimeoutMinutes: Number(values.decisionTimeoutMinutes),
          digestEnabled: values.digestEnabled,
          digestHour: Number(values.digestHour),
          quietStartHour: Number(values.quietStartHour),
          quietEndHour: Number(values.quietEndHour),
        });
        return !closed;
      } catch {
        state = { ...state, error: "Couldn't save notification settings. Try again." };
        return false;
      } finally {
        state = { ...state, saving: false };
        publish();
      }
    },
  };
}
