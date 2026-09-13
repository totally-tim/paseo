import { expect, it } from "vitest";
import { openNotificationSettingsForm } from "./notification-settings-model";
const defaults = {
  decisionTimeoutMinutes: 120,
  digestEnabled: true,
  digestHour: 8,
  quietStartHour: 22,
  quietEndHour: 7,
};
it("validates hours before saving and preserves changes after a failed save", async () => {
  const model = openNotificationSettingsForm(defaults);
  const saves: unknown[] = [];
  model.setNumber("digestHour", "24");
  expect(
    await model.submit(async (values) => {
      saves.push(values);
    }),
  ).toBe(false);
  expect(saves).toEqual([]);
  model.setNumber("digestHour", "9");
  model.setNumber("decisionTimeoutMinutes", "60");
  expect(
    await model.submit(async () => {
      throw new Error("offline");
    }),
  ).toBe(false);
  expect(model.getState().values.decisionTimeoutMinutes).toBe("60");
  expect(
    await model.submit(async (values) => {
      saves.push(values);
    }),
  ).toBe(true);
  expect(saves).toEqual([{ ...defaults, decisionTimeoutMinutes: 60, digestHour: 9 }]);
});
it("discards closed drafts and seeds every setting from the next saved snapshot", () => {
  const first = openNotificationSettingsForm(defaults);
  first.setNumber("quietStartHour", "20");
  first.close();
  first.setNumber("quietStartHour", "19");
  const next = openNotificationSettingsForm({ ...defaults, digestEnabled: false });
  expect(next.getState().values).toEqual({
    decisionTimeoutMinutes: "120",
    digestEnabled: false,
    digestHour: "8",
    quietStartHour: "22",
    quietEndHour: "7",
  });
});

it("rejects a timeout beyond the decision service limit before saving and accepts the boundary", async () => {
  const model = openNotificationSettingsForm(defaults);
  const saved: number[] = [];
  const save = async (values: typeof defaults) => {
    saved.push(values.decisionTimeoutMinutes);
  };
  model.setNumber("decisionTimeoutMinutes", "43201");
  expect(await model.submit(save)).toBe(false);
  expect(saved).toEqual([]);
  expect(model.getState().error).toBe("Enter a timeout from 1 to 43,200 minutes.");
  model.setNumber("decisionTimeoutMinutes", "43200");
  expect(await model.submit(save)).toBe(true);
  expect(saved).toEqual([43200]);
});
