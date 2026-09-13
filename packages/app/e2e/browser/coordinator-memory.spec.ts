import { expect, test, type Page } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";

const PROFILE = {
  provider: "mock",
  featureValues: { mockAssistantResponse: "Watching the project." },
};
async function openMemory(page: Page) {
  await page.getByTestId("coordinator-trust-pill").filter({ visible: true }).click();
  await page.getByTestId("coordinator-personal-memory").filter({ visible: true }).click();
  await expect(page.getByTestId("coordinator-memory-pane").filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("Coordinator personal memory", () => {
  test.setTimeout(120_000);
  test("global side pane saves deletions and preserves a draft when the daemon reports a concurrent edit", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "global-memory-" });
    let hiddenProjectId: string | null = null;
    try {
      await workspace.client.disableGlobalCoordinator();
      const global = await workspace.client.enableGlobalCoordinator({ profile: PROFILE });
      hiddenProjectId = global.projectId;
      const initial = await workspace.client.getCoordinatorMemory({ scope: "personal" });
      await workspace.client.updateCoordinatorMemory({
        scope: "personal",
        content: "prefers squash merges\nlikes short summaries",
        expectedRevision: initial.revision,
      });
      await gotoWorkspace(page, workspace.workspaceId);
      await page.getByTestId("sidebar-coordinator").click();
      await openMemory(page);
      const pane = page.getByTestId("coordinator-memory-pane").filter({ visible: true });
      const editor = pane.getByTestId("coordinator-memory-editor");
      await expect(page.getByTestId("coordinator-board").filter({ visible: true })).toBeVisible();
      await expect(pane.getByTestId("coordinator-memory-path")).toContainText(initial.filePath);
      await expect(editor).toHaveValue("prefers squash merges\nlikes short summaries");
      await editor.fill("likes short summaries");
      await pane.getByTestId("coordinator-memory-save").click();
      await expect(pane.getByTestId("coordinator-memory-save")).toBeDisabled();
      expect((await workspace.client.getCoordinatorMemory({ scope: "personal" })).content).toBe(
        "likes short summaries",
      );
      await testInfo.attach("global-memory-side-pane", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      const memoryTab = page
        .getByTestId("workspace-tab-coordinator_memory_personal")
        .filter({ visible: true })
        .first();
      await memoryTab.click({ button: "right" });
      await page.getByTestId("workspace-tab-context-coordinator_memory_personal-close").click();
      await expect(pane).toHaveCount(0);
      await openMemory(page);
      await expect(editor).toHaveValue("likes short summaries");
      const current = await workspace.client.getCoordinatorMemory({ scope: "personal" });
      await workspace.client.updateCoordinatorMemory({
        scope: "personal",
        content: "newer coordinator memory",
        expectedRevision: current.revision,
      });
      await editor.fill("my unsaved preference");
      await pane.getByTestId("coordinator-memory-save").click();
      await expect(pane.getByTestId("coordinator-memory-error")).toContainText("Memory changed");
      await expect(editor).toHaveValue("my unsaved preference");
      expect((await workspace.client.getCoordinatorMemory({ scope: "personal" })).content).toBe(
        "newer coordinator memory",
      );
    } finally {
      await workspace.client.disableGlobalCoordinator();
      if (hiddenProjectId) await workspace.client.removeProject(hiddenProjectId);
      await workspace.cleanup();
    }
  });

  test("compact project memory edits stay project-scoped and coordinator settings persist", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "project-memory-" });
    try {
      await workspace.client.enableProjectCoordinator({
        projectId: workspace.projectId,
        profile: PROFILE,
      });
      const personalBefore = await workspace.client.getCoordinatorMemory({ scope: "personal" });
      const target = { scope: "personal-project" as const, projectId: workspace.projectId };
      const initial = await workspace.client.getCoordinatorMemory(target);
      await workspace.client.updateCoordinatorMemory({
        ...target,
        content: "project preference",
        expectedRevision: initial.revision,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await gotoWorkspace(page, workspace.workspaceId);
      await openMemory(page);
      const pane = page.getByTestId("coordinator-memory-pane").filter({ visible: true });
      await expect(pane.getByTestId("coordinator-memory-path")).toContainText(initial.filePath);
      const editor = pane.getByTestId("coordinator-memory-editor");
      await expect(editor).toHaveValue("project preference");
      await editor.fill("changed project preference");
      await pane.getByTestId("coordinator-memory-save").click();
      await expect(pane.getByTestId("coordinator-memory-save")).toBeDisabled();
      expect((await workspace.client.getCoordinatorMemory(target)).content).toBe(
        "changed project preference",
      );
      expect((await workspace.client.getCoordinatorMemory({ scope: "personal" })).content).toBe(
        personalBefore.content,
      );
      await testInfo.attach("compact-project-memory", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page
        .getByTestId(`workspace-tab-coordinator_board_${workspace.projectId}`)
        .filter({ visible: true })
        .first()
        .click();
      await page.getByTestId("coordinator-trust-pill").filter({ visible: true }).click();
      await page.getByTestId("coordinator-open-settings").filter({ visible: true }).click();
      const settings = page.getByTestId("coordinator-settings-sheet").filter({ visible: true });
      const threshold = settings.getByTestId("coordinator-rotation-threshold");
      await expect(threshold).toHaveValue("60");
      await threshold.fill("70");
      await settings.getByTestId("coordinator-settings-save").click();
      await expect(settings).toHaveCount(0);
      expect(
        (await workspace.client.getProjectCoordinator(workspace.projectId)).coordinator
          ?.rotationThresholdPercent,
      ).toBe(70);
      await page.getByTestId("coordinator-trust-pill").filter({ visible: true }).click();
      await page.getByTestId("coordinator-open-settings").filter({ visible: true }).click();
      await expect(threshold).toHaveValue("70");
      await page.keyboard.press("Escape");
    } finally {
      await workspace.cleanup();
    }
  });
});
