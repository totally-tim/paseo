import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { seedWorkspace } from "../support/helpers/seed-client";

const GLOBAL_REPLY = "Paseo is watching token refresh. I have the project summary.";

async function interceptSettingsSaveFailure(page: Page) {
  let failNextSave = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message) as {
          message?: { type?: string; requestId?: string };
        };
        if (failNextSave && envelope.message?.type === "coordinator.global.update.request") {
          failNextSave = false;
          browser.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "coordinator.global.update.response",
                payload: {
                  requestId: envelope.message.requestId,
                  coordinator: null,
                  error: "Injected settings save failure",
                },
              },
            }),
          );
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  return () => {
    failNextSave = true;
  };
}

test.describe("Global coordinator", () => {
  test.setTimeout(120_000);
  test("sidebar opens setup, global board receives composer text and Chat uses its hidden workspace", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "global-coordinator-" });
    let hiddenProjectId: string | null = null;
    try {
      await workspace.client.disableGlobalCoordinator();
      await gotoWorkspace(page, workspace.workspaceId);
      await page.getByTestId("sidebar-coordinator").click();
      await page.getByTestId("coordinator-global-setup").click();
      await expect(page.getByTestId("coordinator-global-enable-sheet")).toBeVisible();
      await expect(page.getByTestId("coordinator-global-profile")).toBeVisible();
      await page.keyboard.press("Escape");
      const global = await workspace.client.enableGlobalCoordinator({
        profile: { provider: "mock", featureValues: { mockAssistantResponse: GLOBAL_REPLY } },
      });
      hiddenProjectId = global.projectId;
      if (!global.agentId) throw new Error("Global coordinator missing its session");
      const board = page.getByTestId("coordinator-board").filter({ visible: true });
      await expect(board).toBeVisible({ timeout: 30_000 });
      // A project without a coordinator still appears in the filter because
      // its setup proposal belongs to the global session.
      const projectFilter = page
        .getByTestId("coordinator-project-filter")
        .filter({ visible: true });
      await projectFilter.click();
      await page.getByRole("menuitem", { name: workspace.projectDisplayName, exact: true }).click();
      await expect(projectFilter).toContainText(workspace.projectDisplayName);
      const needsYou = board.getByTestId("coordinator-section-needs-you");
      const setupQuestion = `${workspace.projectDisplayName} · Set up a coordinator for ${workspace.projectDisplayName}?`;
      await expect(needsYou).toContainText(setupQuestion, { timeout: 30_000 });
      await needsYou.getByRole("button", { name: "Ignore", exact: true }).click();
      await expect(board.getByText(setupQuestion, { exact: true })).toHaveCount(0);
      await expect(
        page.getByTestId("coordinator-enable-sheet").filter({ visible: true }),
      ).toHaveCount(0);
      expect(
        (await workspace.client.getProjectCoordinator(workspace.projectId)).coordinator?.enabled,
      ).not.toBe(true);

      const composer = page.getByPlaceholder("Ask the coordinator…").filter({ visible: true });
      await composer.fill("What happened in paseo this week?");
      await page.getByTestId("coordinator-global-send").filter({ visible: true }).click();
      await expect(page.getByTestId("coordinator-reply").filter({ visible: true })).toContainText(
        GLOBAL_REPLY,
        { timeout: 30_000 },
      );
      await page.getByTestId("coordinator-chat-button").filter({ visible: true }).click();
      const tab = page
        .getByTestId(`workspace-tab-agent_${global.agentId}`)
        .filter({ visible: true })
        .first();
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.click({ button: "right" });
      await page.getByTestId(`workspace-tab-context-agent_${global.agentId}-close`).click();
      await expect(
        page.getByTestId("coordinator-project-filter").filter({ visible: true }),
      ).toContainText("All projects");
      await expect(
        page.getByPlaceholder("Ask the coordinator…").filter({ visible: true }),
      ).toBeEditable();
      await expect(page.getByTestId("coordinator-reply").filter({ visible: true })).toContainText(
        GLOBAL_REPLY,
      );
      await page.getByTestId("coordinator-trust-pill").filter({ visible: true }).click();
      await page.getByTestId("coordinator-open-settings").filter({ visible: true }).click();
      await page.getByTestId("coordinator-disable-project").filter({ visible: true }).click();
      await expect(page.getByTestId("coordinator-global-setup")).toBeVisible();
      expect((await workspace.client.getGlobalCoordinator()).enabled).toBe(false);
    } finally {
      await workspace.client.disableGlobalCoordinator();
      if (hiddenProjectId) await workspace.client.removeProject(hiddenProjectId);
      await workspace.cleanup();
    }
  });

  test("notification settings load defaults, persist edits, and retain drafts after validation or save failure", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "global-notifications-" });
    let hiddenProjectId: string | null = null;
    const failNextSave = await interceptSettingsSaveFailure(page);
    try {
      await workspace.client.disableGlobalCoordinator();
      await gotoWorkspace(page, workspace.workspaceId);
      await page.getByTestId("sidebar-coordinator").click();
      const global = await workspace.client.enableGlobalCoordinator({
        profile: { provider: "mock", featureValues: { mockAssistantResponse: GLOBAL_REPLY } },
      });
      hiddenProjectId = global.projectId;
      const notifications = page.getByTestId("coordinator-notifications").filter({ visible: true });
      await expect(notifications).toBeVisible({ timeout: 30_000 });
      await notifications.click();
      const sheet = page.getByTestId("coordinator-notification-settings").filter({ visible: true });
      const timeout = sheet.getByTestId("notification-decisionTimeoutMinutes");
      const digest = sheet.getByTestId("notification-digestHour");
      const quietStart = sheet.getByTestId("notification-quietStartHour");
      const quietEnd = sheet.getByTestId("notification-quietEndHour");
      await expect(timeout).toHaveValue("120");
      await expect(digest).toHaveValue("8");
      await expect(quietStart).toHaveValue("22");
      await expect(quietEnd).toHaveValue("7");
      await timeout.fill("60");
      await digest.fill("9");
      await quietStart.fill("21");
      await quietEnd.fill("6");
      await sheet.getByTestId("notification-settings-save").click();
      await expect(sheet).toHaveCount(0);
      expect((await workspace.client.getGlobalCoordinator()).notificationSettings).toEqual({
        decisionTimeoutMinutes: 60,
        digestEnabled: true,
        digestHour: 9,
        quietStartHour: 21,
        quietEndHour: 6,
      });
      await notifications.click();
      await expect(timeout).toHaveValue("60");
      await expect(digest).toHaveValue("9");
      await expect(quietStart).toHaveValue("21");
      await expect(quietEnd).toHaveValue("6");
      await timeout.fill("43201");
      await sheet.getByTestId("notification-settings-save").click();
      await expect(
        sheet.getByText("Enter a timeout from 1 to 43,200 minutes.", { exact: true }),
      ).toBeVisible();
      expect(
        (await workspace.client.getGlobalCoordinator()).notificationSettings
          ?.decisionTimeoutMinutes,
      ).toBe(60);
      await timeout.fill("90");
      failNextSave();
      await sheet.getByTestId("notification-settings-save").click();
      await expect(
        sheet.getByText("Couldn't save notification settings. Try again.", { exact: true }),
      ).toBeVisible();
      await expect(timeout).toHaveValue("90");
      expect(
        (await workspace.client.getGlobalCoordinator()).notificationSettings
          ?.decisionTimeoutMinutes,
      ).toBe(60);
      await sheet.getByTestId("notification-settings-save").click();
      await expect(sheet).toHaveCount(0);
      expect(
        (await workspace.client.getGlobalCoordinator()).notificationSettings
          ?.decisionTimeoutMinutes,
      ).toBe(90);
      await notifications.click();
      await expect(timeout).toHaveValue("90");
      await page.keyboard.press("Escape");
    } finally {
      await workspace.client.disableGlobalCoordinator();
      if (hiddenProjectId) await workspace.client.removeProject(hiddenProjectId);
      await workspace.cleanup();
    }
  });
});
