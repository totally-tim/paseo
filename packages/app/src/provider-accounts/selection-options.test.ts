import { expect, test } from "vitest";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "@/provider-usage/types";
import { buildAccountOptions, defaultAccountSelection } from "./selection-options";

const labels = {
  automatic: "Automatic",
  automaticHelp: "Stays on one account per model until its capacity runs out.",
  hostAccount: "Host CLI account",
  hostHelp: "This login belongs to the host CLI. Manage it in the host terminal.",
};

function account(overrides: Partial<ProviderAccount> & Pick<ProviderAccount, "id" | "label">) {
  return {
    provider: "claude",
    ownership: "managed",
    enabled: true,
    authState: "ready",
    identity: null,
    error: null,
    revision: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as ProviderAccount;
}

function usage(windows: ProviderUsage["windows"]): ProviderUsage {
  return {
    providerId: "claude",
    displayName: "Claude",
    planLabel: "max",
    status: "available",
    windows,
  };
}

const host = account({
  id: "default:claude",
  label: "tim.eu claude",
  ownership: "external",
  identity: { key: "claude:host", email: "tim@timkraus.eu" },
});
const managed = account({
  id: "managed-1",
  label: "gmail claude",
  identity: { key: "claude:gmail", email: "tim.timkraus@gmail.com" },
});

test("every row carries the login and the quota it is chosen on", () => {
  const options = buildAccountOptions(
    {
      accounts: [host, managed],
      usage: [
        {
          accountId: "managed-1",
          stale: true,
          usage: usage([
            { id: "five_hour", label: "Session", usedPct: 42 },
            { id: "seven_day_opus", label: "Weekly · Opus", usedPct: 61 },
            { id: "seven_day_sonnet", label: "Weekly · Sonnet", usedPct: 90 },
          ]),
        },
      ],
    },
    "claude",
    "claude-opus-5",
    labels,
  );

  expect(options.map((option) => option.label)).toEqual([
    "Automatic",
    // The host row keeps the label the account was renamed to, not a generic one.
    "tim.eu claude",
    "gmail claude",
  ]);
  const detail = options[2].detail;
  expect(detail.account?.identity?.email).toBe("tim.timkraus@gmail.com");
  expect(detail.stale).toBe(true);
  // A window scoped to another model says nothing about starting this one.
  expect(detail.usage?.windows.map((window) => window.label)).toEqual(["Session", "Weekly · Opus"]);
});

test("the automatic row explains itself and claims no account", () => {
  const [automatic] = buildAccountOptions(
    { accounts: [managed], usage: [] },
    "claude",
    "claude-opus-5",
    labels,
  );
  expect(automatic.detail).toEqual({ help: labels.automaticHelp });
});

test("a host login the daemon does not report falls back to the generic name", () => {
  const [, hostRow] = buildAccountOptions({ accounts: [], usage: [] }, "claude", null, labels);
  expect(hostRow).toMatchObject({
    label: "Host CLI account",
    disabled: false,
    detail: { help: labels.hostHelp },
  });
});

test("a row nobody can start is offered as disabled rather than hidden", () => {
  const options = buildAccountOptions(
    {
      accounts: [
        { ...host, enabled: false },
        { ...managed, authState: "signed-out" },
        account({ id: "gone", label: "removed", removedAt: "2026-09-02T00:00:00.000Z" }),
        account({ id: "codex-1", label: "gmail codex", provider: "codex" }),
      ],
      usage: [],
    },
    "claude",
    null,
    labels,
  );
  expect(options.map((option) => [option.id, option.disabled])).toEqual([
    ["automatic", false],
    ["default", true],
    ["managed-1", true],
  ]);
});

test("automatic is the default only while a managed account can serve it", () => {
  expect(defaultAccountSelection([host], "claude")).toBe("default");
  expect(defaultAccountSelection([host, managed], "claude")).toBe("automatic");
  expect(defaultAccountSelection([{ ...managed, enabled: false }], "claude")).toBe("default");
});
