import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { openSidebarDisplayPage } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  addConnectedHostAndReload,
  openSidebarHostFilter,
  toggleHostFilter,
  reloadPreservingHostRegistry,
} from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import type { Page } from "@playwright/test";

async function capture(page: Page, path: string): Promise<string> {
  await page.screenshot({ path });
  return path;
}

async function groupOrder(page: Page) {
  return page
    .locator('[data-testid^="sidebar-project-group-header-"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
}

test("desktop import syncs to a compact client and an import failure stays visible for retry", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120000);
  const first = await seedWorkspace({ repoPrefix: "sidebar-order-alpha-", title: "Alpha" });
  const second = await seedWorkspace({ repoPrefix: "sidebar-order-zulu-", title: "Zulu" });
  let phoneContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    await first.client.setProjectGroup(first.projectId, "Alpha");
    await second.client.setProjectGroup(second.projectId, "Zulu");
    let failImport = true;
    let failUpdate = false;
    let failGet = false;
    await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
      const server = browserSocket.connectToServer();
      browserSocket.onMessage((raw) => {
        let envelope;
        try {
          envelope = JSON.parse(String(raw));
        } catch {
          server.send(raw);
          return;
        }
        if (failImport && envelope.message?.type === "sidebar.order.initialize.request") {
          failImport = false;
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "sidebar.order.initialize.response",
                payload: {
                  requestId: envelope.message.requestId,
                  accepted: false,
                  snapshot: null,
                  error: "Could not save sidebar order. Try again.",
                },
              },
            }),
          );
        } else if (failUpdate && envelope.message?.type === "sidebar.order.update.request") {
          failUpdate = false;
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "sidebar.order.update.response",
                payload: {
                  requestId: envelope.message.requestId,
                  accepted: false,
                  snapshot: null,
                  error: "Reorder failed. Try again.",
                },
              },
            }),
          );
        } else if (failGet && envelope.message?.type === "sidebar.order.get.request") {
          failGet = false;
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "sidebar.order.get.response",
                payload: {
                  requestId: envelope.message.requestId,
                  accepted: false,
                  snapshot: null,
                  error: "Reload timeout",
                },
              },
            }),
          );
        } else server.send(raw);
      });
      server.onMessage((raw) => browserSocket.send(raw));
    });
    await page.addInitScript(
      ({ firstKey, secondKey }) => {
        if (!localStorage.getItem("sidebar-project-workspace-order"))
          localStorage.setItem(
            "sidebar-project-workspace-order",
            JSON.stringify({
              version: 1,
              state: {
                projectOrder: [secondKey, firstKey],
                projectGroupOrder: ["zulu", "alpha"],
                pinnedWorkspaceOrder: [],
                workspaceOrderByProject: {},
              },
            }),
          );
      },
      { firstKey: first.projectKey, secondKey: second.projectKey },
    );
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const storageState = await page.context().storageState();
    for (const origin of storageState.origins)
      origin.localStorage = origin.localStorage.filter(
        (item) =>
          item.name !== "sidebar-project-workspace-order" && item.name !== "sidebar-order-sync",
      );
    phoneContext = await browser.newContext({
      storageState,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await phoneContext.route(/:(6767)\b/, (route) => route.abort());
    await phoneContext.routeWebSocket(/:(6767)\b/, (socket) => socket.close());
    const phone = await phoneContext.newPage();
    await phone.goto(page.url());
    await phone.getByRole("button", { name: "Open menu", exact: true }).click();
    await expect(phone.getByTestId("sidebar-display-preferences-menu")).toBeVisible({
      timeout: 30000,
    });
    expect((await first.client.getSidebarOrder(false)).snapshot?.initialized).toBe(false);
    await openSidebarDisplayPage(page, "sidebar-order-settings");
    const importButton = page.getByTestId(`sidebar-order-import-${getServerId()}`);
    await expect(importButton).toBeVisible();
    await importButton.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Could not save sidebar order" }).first(),
    ).toBeVisible();
    await expect(importButton).toBeEnabled();
    await importButton.click();
    await expect(page.getByTestId(`sidebar-order-host-${getServerId()}`)).toContainText(
      "Order synced",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => groupOrder(phone))
      .toEqual(["sidebar-project-group-header-zulu", "sidebar-project-group-header-alpha"]);
    await expect.poll(() => groupOrder(page)).toEqual(await groupOrder(phone));
    await testInfo.attach("desktop-synced", {
      path: await capture(page, testInfo.outputPath("desktop-synced.png")),
      contentType: "image/png",
    });
    await testInfo.attach("compact-synced", {
      path: await capture(phone, testInfo.outputPath("compact-synced.png")),
      contentType: "image/png",
    });
    failUpdate = true;
    await page.getByTestId("sidebar-project-group-header-zulu").hover();
    await page.getByTestId("sidebar-project-group-kebab-zulu").click();
    await page.getByTestId("sidebar-project-group-menu-move-down-zulu").click();
    await expect(page.getByTestId("sidebar-order-notice")).toContainText(
      "Reorder failed. Try again.",
    );
    await expect
      .poll(() => groupOrder(phone))
      .toEqual(["sidebar-project-group-header-zulu", "sidebar-project-group-header-alpha"]);
    await openSidebarDisplayPage(page, "sidebar-order-settings");
    failGet = true;
    await page.getByText("Reload shared order", { exact: true }).click();
    await expect(page.getByTestId(`sidebar-order-host-${getServerId()}`)).toContainText(
      "Reload timeout",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const retry = page
      .getByTestId("sidebar-order-notice")
      .getByRole("button", { name: "Retry failed change" });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect
      .poll(() => groupOrder(page))
      .toEqual(["sidebar-project-group-header-alpha", "sidebar-project-group-header-zulu"]);
    await expect.poll(() => groupOrder(phone)).toEqual(await groupOrder(page));
    await phone.getByTestId("sidebar-project-group-kebab-alpha").click();
    await phone.getByTestId("sidebar-project-group-menu-move-down-alpha").click();
    await expect
      .poll(() => groupOrder(page))
      .toEqual(["sidebar-project-group-header-zulu", "sidebar-project-group-header-alpha"]);
    await expect.poll(() => groupOrder(phone)).toEqual(await groupOrder(page));
    await phone.reload();
    await phone.getByRole("button", { name: "Open menu", exact: true }).click();
    await expect.poll(() => groupOrder(phone)).toEqual(await groupOrder(page));
  } finally {
    await phoneContext?.close();
    await second.cleanup();
    await first.cleanup();
  }
});

test("ordering settings can import a host excluded by the sidebar filter", async ({ page }) => {
  test.setTimeout(120000);
  const secondary = await startIsolatedHostDaemon("sidebar-order-filtered");
  const primary = await seedWorkspace({
    repoPrefix: "sidebar-order-filter-",
    title: "Visible workspace",
  });
  try {
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: secondary.serverId,
      port: secondary.port,
      label: "Filtered host",
    });
    await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();
    await openSidebarHostFilter(page);
    await toggleHostFilter(page, getServerId());
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await reloadPreservingHostRegistry(page);
    await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();
    await openSidebarDisplayPage(page, "sidebar-order-settings");
    const controls = page.getByTestId(`sidebar-order-host-${secondary.serverId}`);
    await expect(controls).toContainText("Use this device", { timeout: 30000 });
    await page.getByTestId(`sidebar-order-import-${secondary.serverId}`).click();
    await expect(controls).toContainText("Order synced");
  } finally {
    await primary.cleanup();
    await secondary.close();
  }
});
