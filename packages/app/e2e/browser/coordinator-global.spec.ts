import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

const GLOBAL_REPLY = "Paseo is watching token refresh. I have the project summary.";

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
    } finally {
      await workspace.client.disableGlobalCoordinator();
      if (hiddenProjectId) await workspace.client.removeProject(hiddenProjectId);
      await workspace.cleanup();
    }
  });
});
