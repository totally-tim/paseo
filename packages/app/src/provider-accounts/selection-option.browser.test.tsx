import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import { en } from "@/i18n/resources/en";
import type { ProviderUsage } from "@/provider-usage/types";
import { AccountSelectionOption, type AccountOptionDetail } from "./selection-option";

/**
 * A picker row exists to tell two logins apart at a glance, and both ways it used to fail were
 * layout: the help text was clipped to one line and the quota was not there at all. So the row is
 * mounted in a real browser, at the width the popover gives it, and measured.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const text = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
      if (typeof text !== "string") return key;
      return text.replaceAll(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? "");
    },
  }),
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

/** `OPTION_MIN_WIDTH` in selection-field.tsx: the narrowest the popover ever gets. */
const POPOVER_WIDTH = 320;
const HOUR = 3_600_000;

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

const AUTOMATIC_OPTION = { id: "automatic", value: "automatic", label: "Automatic" };
const MANAGED_OPTION = { id: "managed-1", value: "managed-1", label: "gmail claude" };
const HOST_OPTION = { id: "default:claude", value: "default:claude", label: "tim.eu claude" };

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mountRow(option: typeof AUTOMATIC_OPTION, detail: AccountOptionDetail): HTMLElement {
  const container = document.createElement("div");
  container.style.width = `${POPOVER_WIDTH}px`;
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <AccountSelectionOption
        option={option}
        detail={detail}
        selected={false}
        active={false}
        onPress={vi.fn()}
      />,
    ),
  );
  mounted.push({ root, container });
  const row = container.querySelector(`[data-testid="account-option-${option.id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`row ${option.id} did not render`);
  return row;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

/** Every line the row draws, so a clipped one cannot hide behind a passing sibling. */
function textLines(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll("div, span")].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.innerText.trim().length > 0,
  );
}

describe("account picker row", () => {
  it("names the login and the quota that applies to the model", () => {
    const row = mountRow(MANAGED_OPTION, {
      account: account({
        id: "managed-1",
        label: "gmail claude",
        identity: { key: "claude:gmail", email: "tim.timkraus@gmail.com" },
      }),
      model: "claude-opus-5",
      usage: usage([
        { id: "five_hour", label: "Session", usedPct: 42 },
        { id: "seven_day_opus", label: "Weekly · Opus", usedPct: 61 },
      ]),
    });

    expect(row.innerText).toContain("gmail claude");
    expect(row.innerText).toContain("tim.timkraus@gmail.com");
    expect(row.innerText).toContain("Session");
    expect(row.innerText).toContain("42%");
    expect(row.innerText).toContain("Weekly · Opus");
    expect(row.innerText).toContain("61%");
  });

  it("says so when the provider has reported no usage for a signed-in account", () => {
    const row = mountRow(MANAGED_OPTION, {
      account: account({ id: "managed-1", label: "gmail claude" }),
      usage: null,
    });

    expect(row.innerText).toContain(en.providerAccounts.usageUnavailable);
  });

  it("marks an account the daemon will refuse for capacity", () => {
    const row = mountRow(HOST_OPTION, {
      help: en.providerAccounts.externalHelp,
      account: account({
        id: "default:claude",
        label: "tim.eu claude",
        ownership: "external",
        identity: { key: "claude:host", email: "tim@timkraus.eu" },
        capacityLimit: {
          observedAt: new Date(Date.now() - HOUR).toISOString(),
          resetsAt: new Date(Date.now() + 100 * HOUR).toISOString(),
        },
      }),
      usage: usage([{ id: "seven_day", label: "Weekly", usedPct: 100 }]),
    });

    const note = row.querySelector('[data-testid="account-option-capacity-default:claude"]');
    expect((note as HTMLElement).innerText).toBe("Account capacity exhausted · resets 4d");
  });

  it("draws every line in full at the popover's narrowest width", () => {
    const row = mountRow(AUTOMATIC_OPTION, {
      help: en.providerAccounts.automaticHelp,
    });

    expect(row.innerText).toContain(en.providerAccounts.automaticHelp);
    const lines = textLines(row);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.scrollHeight).toBeLessThanOrEqual(line.clientHeight + 1);
      expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth + 1);
    }
  });
});
