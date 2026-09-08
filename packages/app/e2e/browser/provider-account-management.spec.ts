import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHostSection } from "../support/helpers/settings";

test("reorders, removes and restores accounts through settings", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "agents");
  const section = page.getByTestId("provider-accounts-settings");
  await expect(section).toBeVisible();
  for (let index = 0; index < 2; index++) {
    await section.getByTestId("account-add-codex").click();
    const editor = page.getByTestId("account-editor");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Close", { exact: true }).click();
    await expect(editor).not.toBeVisible();
  }
  const rows = section.locator('[data-testid^="account-row-"]');
  const original = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")!),
  );
  const moved = original.at(-1)!;
  await section.getByTestId(moved.replace("account-row-", "account-up-")).click();
  await expect(rows.nth(original.length - 2)).toHaveAttribute("data-testid", moved);
  await expect(rows.last()).toHaveAttribute("data-testid", original.at(-2)!);
  await section.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(rows.nth(original.length - 2)).toHaveAttribute("data-testid", moved);
  await section
    .getByTestId(moved)
    .getByRole("button", { name: "Manage account", exact: true })
    .click();
  const editor = page.getByTestId("account-editor");
  await editor.getByTestId("account-remove").click();
  page.once("dialog", (dialog) => dialog.accept());
  await editor.getByTestId("account-remove-retain").click();
  await expect(editor).not.toBeVisible();
  await expect(section.getByTestId(moved)).toHaveCount(0);
  await section.getByRole("button", { name: /Removed accounts/ }).click();
  await section
    .getByTestId(moved)
    .getByRole("button", { name: "Restore account", exact: true })
    .click();
  await expect(editor.getByTestId("account-login")).toHaveCount(0);
  await editor.getByTestId("account-restore").click();
  await expect(editor).not.toBeVisible();
  await expect(section.getByTestId(moved)).toBeVisible();
  for (const width of [320, 375, 414, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(section).toBeVisible();
    // Crossing the settings breakpoint remounts the page while the locator is scrolling.
    await expect(async () => {
      await section.getByTestId(moved).scrollIntoViewIfNeeded();
    }).toPass({ timeout: 5_000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`accounts-${width}.png`), fullPage: true });
  }
});

test("keeps unknown context visible and anchors continuation to the agent tab", async ({
  page,
}, testInfo) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "account-context-",
    title: "Account context",
  });
  try {
    await openAgentRoute(page, workspace);
    const meter = page.getByTestId("context-window-meter");
    await expect(meter).toBeVisible();
    await meter.hover();
    await expect(page.getByText("Context usage not reported", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("context-unknown.png") });
    await expect(page.getByTestId("agent-handoff-open")).toHaveCount(0);
    const tab = page.getByTestId(`workspace-tab-agent_${workspace.agentId}`).first();
    await tab.click({ button: "right" });
    const action = page.getByTestId(
      `workspace-tab-context-agent_${workspace.agentId}-continue-agent`,
    );
    await expect(action).toBeVisible();
    await action.click();
    await expect(page.getByTestId("agent-handoff-sheet")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("continuation-sheet.png") });
    await page.getByTestId("agent-handoff-sheet").getByLabel("Close", { exact: true }).click();
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(meter).toBeVisible();
    await meter.click();
    await expect(page.getByText("Context usage not reported", { exact: true })).toBeVisible();
    await page.getByTestId("workspace-tab-switcher-trigger").click();
    await page.getByTestId(`workspace-tab-menu-agent_${workspace.agentId}-trigger`).click();
    await page.getByTestId(`workspace-tab-menu-agent_${workspace.agentId}-continue-agent`).click();
    await expect(page.getByTestId("agent-handoff-sheet")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("continuation-mobile.png") });
  } finally {
    await workspace.cleanup();
  }
});
