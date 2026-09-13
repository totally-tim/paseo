import { expect, it } from "vitest";
import { openCoordinatorSettings } from "./settings-model";
it("preserves the selected fallback account and can explicitly remove the fallback", async () => {
  const model = openCoordinatorSettings({
    fallbackProfile: {
      provider: "codex",
      model: "existing",
      accountSelection: { kind: "automatic" },
    },
    rotationThresholdPercent: 60,
  });
  const saved: unknown[] = [];
  model.setThreshold("70");
  expect(
    await model.submit(async (value) => {
      saved.push(value);
    }),
  ).toBe(true);
  expect(saved).toEqual([
    {
      fallbackProfile: {
        provider: "codex",
        model: "existing",
        accountSelection: { kind: "automatic" },
      },
      rotationThresholdPercent: 70,
    },
  ]);
  model.setFallback(null);
  await model.submit(async (value) => {
    saved.push(value);
  });
  expect(saved[1]).toEqual({ fallbackProfile: null, rotationThresholdPercent: 70 });
});
it("rejects invalid thresholds and keeps edits on a failed save", async () => {
  const model = openCoordinatorSettings({});
  model.setThreshold("101");
  let writes = 0;
  expect(
    await model.submit(async () => {
      ++writes;
    }),
  ).toBe(false);
  expect(writes).toBe(0);
  model.setThreshold("55");
  model.setFallback({ provider: "claude", modelId: "fallback" });
  expect(
    await model.submit(async () => {
      throw new Error("offline");
    }),
  ).toBe(false);
  expect(model.getState()).toMatchObject({
    threshold: "55",
    fallbackProfile: { provider: "claude", model: "fallback" },
    error: "offline",
  });
});
