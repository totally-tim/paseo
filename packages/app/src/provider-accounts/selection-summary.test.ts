import { expect, it } from "vitest";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { selectedAccount } from "./selection-summary";

const account: ProviderAccount = {
  id: "account-a",
  provider: "codex",
  label: "Work",
  ownership: "managed",
  enabled: true,
  authState: "ready",
  identity: null,
  error: null,
  revision: 1,
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
};
const data = {
  requestId: "test",
  error: null,
  accounts: [account],
  usage: [],
  policy: null,
  next: [{ provider: "codex" as const, accountId: account.id, reason: "Available" }],
};
it("shows the fixed account without claiming an automatic preview", () => {
  expect(selectedAccount(data, "codex", { kind: "fixed", accountId: account.id })).toEqual(account);
  expect(selectedAccount(data, "codex", { kind: "automatic" })).toBeUndefined();
});
it("does not claim a provider-wide preview for an explicitly restricted pool", () => {
  expect(
    selectedAccount(data, "codex", { kind: "automatic", accountIds: [account.id] }),
  ).toBeUndefined();
});
it("does not resolve removed accounts or an account from another provider", () => {
  expect(
    selectedAccount({ ...data, accounts: [{ ...account, removedAt: account.updatedAt }] }, "codex"),
  ).toBeUndefined();
  expect(selectedAccount(data, "claude", { kind: "fixed", accountId: account.id })).toBeUndefined();
});
