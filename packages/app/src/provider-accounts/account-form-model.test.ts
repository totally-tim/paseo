import { describe, expect, it } from "vitest";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { openAccountForm } from "./account-form-model";

const account: ProviderAccount = {
  id: "account-a",
  provider: "codex",
  label: "A",
  ownership: "managed",
  enabled: false,
  authState: "signed-out",
  identity: null,
  error: null,
  revision: 0,
  createdAt: "2026-09-05",
  updatedAt: "2026-09-05",
};

describe("account form", () => {
  it("accepts edits after a development cleanup and setup cycle", async () => {
    const form = openAccountForm(account);
    form.activate();
    form.close();
    form.activate();
    form.setLabel("Renamed");
    expect(form.saveOperation()).toMatchObject({ changes: { label: "Renamed" } });
    expect(await form.run(async () => "submitted")).toBe("submitted");
  });

  it("serializes actions and clears a one-time login code on success and failure", async () => {
    const form = openAccountForm(account);
    form.setCode("one-time-code");
    let finish!: () => void;
    const pending = form.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(await form.run(async () => "duplicate")).toBeUndefined();
    finish();
    await pending;
    expect(form.getState().code).toBe("");
    form.setCode("another-code");
    await form.run(async () => {
      throw new Error("Login failed");
    });
    expect(form.getState().code).toBe("");
    expect(form.getState().error).toBe("Login failed");
    form.setCode("final-code");
    form.close();
    expect(form.getState().code).toBe("");
  });

  it("rejects an invalid reserve before sending an operation", () => {
    const form = openAccountForm(account);
    for (const reserve of ["-1", "101", "invalid"]) {
      form.setReserve(reserve);
      expect(form.saveOperation()).toBeNull();
    }
    form.setReserve("23");
    expect(form.saveOperation()).toMatchObject({ changes: { reservePercent: 23 } });
  });
});
