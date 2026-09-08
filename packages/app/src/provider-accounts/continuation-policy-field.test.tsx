/** @vitest-environment jsdom */
import React from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderAccount } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { ContinuationPolicyField } from "./continuation-policy-field";
import { AccountUsageTooltip } from "./usage-tooltip";

const state = vi.hoisted(() => ({
  data: undefined as
    | {
        accounts: ProviderAccount[];
        usage: { accountId: string; usage: ProviderUsage; stale: boolean }[];
      }
    | undefined,
}));
vi.mock("./use-provider-accounts", () => ({
  useProviderAccounts: () => ({ ...state, connected: true }),
}));
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
beforeEach(async () => {
  vi.stubGlobal("React", React);
  state.data = undefined;
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

it("does not offer to remove a saved account until the catalog resolves", () => {
  const onChange = vi.fn();
  const props = {
    serverId: "host",
    provider: "claude",
    value: { accountIds: ["saved"] },
    onChange,
  };
  const view = render(<ContinuationPolicyField {...props} />);
  expect(view.getByText("Loading accounts…")).toBeTruthy();
  expect(view.queryByText(i18n.t("providerAccounts.missingAccount"))).toBeNull();
  expect(view.queryByRole("button", { name: i18n.t("providerAccounts.remove") })).toBeNull();
  state.data = { accounts: [], usage: [] };
  view.rerender(<ContinuationPolicyField {...props} />);
  fireEvent.click(view.getByRole("button", { name: i18n.t("providerAccounts.remove") }));
  expect(onChange).toHaveBeenCalledWith({ accountIds: [] });
});

it("reports unavailable quota when every window belongs to another model", () => {
  state.data = {
    accounts: [],
    usage: [
      {
        accountId: "saved",
        stale: false,
        usage: {
          providerId: "codex",
          displayName: "Codex",
          planLabel: null,
          status: "available",
          windows: [
            {
              id: "gpt-5.3-codex-spark:secondary",
              label: "Weekly · GPT-5.3-Codex-Spark",
              usedPct: 10,
            },
          ],
        },
      },
    ],
  };
  const view = render(
    <AccountUsageTooltip serverId="host" accountId="saved" provider="codex" model="gpt-6-astra" />,
  );
  expect(view.getByText(i18n.t("providerAccounts.usageUnavailable"))).toBeTruthy();
  expect(view.queryByText("Weekly · GPT-5.3-Codex-Spark")).toBeNull();
});
