import { expect, test, vi } from "vitest";
import { openHandoffForm } from "./form-model";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

const entries: ProviderSnapshotEntry[] = [
  {
    provider: "claude-work",
    enabled: true,
    status: "ready",
    modes: [{ id: "plan", label: "Plan" }],
  },
  { provider: "local", enabled: true, status: "ready", modes: [] },
];

test("late catalogs preserve choices and disconnected forms cannot submit", async () => {
  const send = vi.fn(async () => "successor");
  const form = openHandoffForm(send);
  form.selectModel("claude-work", "opus");
  expect(form.getState().canSubmit).toBe(false);
  form.replaceCatalog(entries, true);
  expect(form.getState().selection.modelId).toBe("opus");
  expect(form.getState().canSubmit).toBe(true);
  form.replaceCatalog(entries, false);
  expect(await form.submit()).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test("changing providers clears incompatible permissions and profile features", () => {
  const form = openHandoffForm(async () => true);
  form.replaceCatalog(entries, true);
  form.applyProfile({
    provider: "claude-work",
    modelId: "opus",
    modeId: "plan",
    thinkingOptionId: "high",
    featureValues: { fast: true },
  });
  form.selectModel("local", "qwen");
  expect(form.getState().selection).toEqual({
    provider: "local",
    modelId: "qwen",
    modeId: "",
    thinkingOptionId: "",
    featureValues: {},
  });
  expect(form.getState().canSubmit).toBe(true);
});

test("double clicks submit once and errors leave the selected target available for retry", async () => {
  let fail!: (error: Error) => void;
  const send = vi.fn(
    () =>
      new Promise<string>((_, reject) => {
        fail = reject;
      }),
  );
  const form = openHandoffForm(send);
  form.replaceCatalog(entries, true);
  form.selectModel("local", "qwen");
  const first = form.submit();
  expect(await form.submit()).toBeNull();
  form.selectModel("claude-work", "opus");
  expect(form.getState().selection.provider).toBe("local");
  fail(new Error("Source is still stopping"));
  expect(await first).toBeNull();
  expect(form.getState().error).toBe("Source is still stopping");
  expect(form.getState().canSubmit).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
});

test("unavailable providers and invalid profile modes block submission", () => {
  const form = openHandoffForm(async () => true);
  form.replaceCatalog(entries, true);
  form.applyProfile({
    provider: "claude-work",
    modelId: "opus",
    modeId: "removed-mode",
    thinkingOptionId: "",
    featureValues: {},
  });
  expect(form.getState().canSubmit).toBe(false);
  form.selectMode("plan");
  expect(form.getState().canSubmit).toBe(true);
  form.replaceCatalog([{ ...entries[0]!, status: "unavailable" }], true);
  expect(form.getState().canSubmit).toBe(false);
});

test("a saved profile submits its complete configuration without requiring custom controls", async () => {
  const send = vi.fn(async () => "successor");
  const form = openHandoffForm(send);
  form.replaceCatalog(entries, true);
  const profile = {
    provider: "claude-work",
    modelId: "opus",
    modeId: "plan",
    thinkingOptionId: "high",
    featureValues: { fast: true },
  };
  form.applyProfile(profile);
  expect(form.getState().canSubmit).toBe(true);
  expect(await form.submit()).toBe("successor");
  expect(send).toHaveBeenCalledWith(profile, "");
});
