import { expect, test, type Page } from "../support/fixtures";
import {
  applyProfileFromPicker,
  openModelPicker,
  seedAgentProfiles,
} from "../support/helpers/agent-profiles";
import { gotoAppShell } from "../support/helpers/app";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openNewWorkspaceComposer } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The new-agent composer in an existing workspace sits at the bottom of the viewport, so a
// popover that opens downward lands below the window edge. The new-workspace screen puts the
// same composer mid-page, which is why the bug only showed in one of the two flows.
const CLAUDE_PROFILE = {
  id: "agent_profile_e2e_account_anchor",
  name: "Claude anchor",
  provider: "claude",
};

async function expectAccountPickerAboveComposer(page: Page, screenshotPath: string) {
  await openModelPicker(page);
  await applyProfileFromPicker(page, CLAUDE_PROFILE.name);

  const trigger = page.getByTestId("provider-account-selection").filter({ visible: true });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();

  const popover = page.getByTestId("combobox-desktop-container");
  await expect(popover).toBeVisible({ timeout: 30_000 });
  // The combobox paints at opacity 0 until its position resolves, and Playwright's visibility
  // checks ignore opacity, so a picker stuck at its unresolved origin would pass the geometry
  // assertions below. Wait for the reveal first.
  await expect(popover).toHaveCSS("opacity", "1");
  const rows = popover.locator('[data-testid^="account-option-"]');
  await expect(rows.first()).toBeVisible();
  await page.screenshot({ path: screenshotPath });

  const triggerBox = (await trigger.boundingBox())!;
  for (const row of await rows.all()) {
    await expect(row).toBeInViewport({ ratio: 1 });
    const box = (await row.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(triggerBox.y);
  }
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
}

test("the account picker opens above the composer in an existing workspace and on the new-workspace screen", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const profile = await seedAgentProfiles([CLAUDE_PROFILE]);
  try {
    const workspace = await seedWorkspace({ repoPrefix: "account-picker-placement-" });
    try {
      await test.step("new agent in an existing workspace", async () => {
        await gotoWorkspace(page, workspace.workspaceId);
        await clickNewChat(page);
        await expectComposerVisible(page);
        await expectAccountPickerAboveComposer(
          page,
          testInfo.outputPath("account-picker-existing-workspace.png"),
        );
      });

      await test.step("new workspace screen", async () => {
        await gotoAppShell(page);
        await waitForSidebarHydration(page);
        await openNewWorkspaceComposer(page, {
          projectKey: workspace.projectKey,
          projectDisplayName: workspace.projectDisplayName,
        });
        await expectComposerVisible(page);
        await expectAccountPickerAboveComposer(
          page,
          testInfo.outputPath("account-picker-new-workspace.png"),
        );
      });
    } finally {
      await workspace.cleanup();
    }
  } finally {
    await profile.restore();
  }
});
