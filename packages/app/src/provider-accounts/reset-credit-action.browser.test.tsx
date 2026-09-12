import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { en } from "@/i18n/resources/en";
import { ResetCreditAction, type ResetCreditRedemptionResult } from "./reset-credit-action";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
async function confirm() {
  return true;
}
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

async function mountAction() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const container = document.createElement("div");
  container.style.width = "320px";
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const response = Promise.withResolvers<ResetCreditRedemptionResult>();
  let calls = 0;
  const actions = {
    redeem() {
      calls++;
      return response.promise;
    },
  };
  const render = (count: number) =>
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ResetCreditAction
            accountId="test"
            accountLabel="Work"
            count={count}
            connected
            confirm={confirm}
            redeem={actions.redeem}
          />
        </I18nextProvider>,
      ),
    );
  render(1);
  return { render, response, calls: () => calls };
}

it("keeps success visible after the last credit disappears during refresh", async () => {
  const action = await mountAction();
  await page.getByTestId("use-reset-credit-test").click();
  expect(action.calls()).toBe(1);
  await expect.element(page.getByTestId("use-reset-credit-test")).toBeDisabled();
  action.render(0);
  await expect.element(page.getByTestId("reset-credit-test")).toBeVisible();
  await act(async () => action.response.resolve({ outcome: "reset", confirmed: true }));
  await expect
    .element(page.getByText(en.providerAccounts.resetCreditApplied, { exact: true }))
    .toBeVisible();
  await expect.element(page.getByTestId("use-reset-credit-test")).not.toBeInTheDocument();
});

it("keeps the unconfirmed warning visible when the refreshed usage has no credit count", async () => {
  const action = await mountAction();
  await page.getByTestId("use-reset-credit-test").click();
  action.render(0);
  await act(async () => action.response.resolve({ outcome: "reset", confirmed: false }));
  await expect
    .element(page.getByText(en.providerAccounts.resetCreditUnconfirmed, { exact: true }))
    .toBeVisible();
});

it("keeps a transport failure visible even if the account refresh removes the credit", async () => {
  const action = await mountAction();
  await page.getByTestId("use-reset-credit-test").click();
  action.render(0);
  await act(async () =>
    action.response.reject(new Error("Host disconnected. Reconnect to retry.")),
  );
  await expect
    .element(page.getByText("Host disconnected. Reconnect to retry.", { exact: true }))
    .toBeVisible();
  action.render(1);
  await expect.element(page.getByTestId("use-reset-credit-test")).toBeEnabled();
});
