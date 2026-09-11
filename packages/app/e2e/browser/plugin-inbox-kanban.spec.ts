import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";

const WIDE = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };

async function openKanban(page: Page) {
  await page.getByTestId("plugin-sidebar-inbox-inbox").click();
  await expect(page.getByText("Needs you", { exact: true }).first()).toBeVisible();
}

async function capture(page: Page, info: TestInfo, name: string) {
  const file = info.outputPath(`${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  await info.attach(name, { path: file, contentType: "image/png" });
}

function previewButton(page: Page, title: string) {
  return page.getByRole("button", { name: `Preview ${title}`, exact: true });
}

/** Scopes a lookup to the card subtree that owns the titled preview pressable. */
function cardScope(page: Page, title: string) {
  return page
    .locator("div")
    .filter({ has: previewButton(page, title) })
    .filter({ has: page.getByRole("button", { name: "Preview", exact: true }) })
    .last();
}

test.describe("inbox kanban board", () => {
  test.describe.configure({ timeout: 300_000 });

  test("triages questions, approvals, errors, working and finished agents", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "kanban-e2e-", title: "Kanban e2e" });
    const otherWorkspace = await seedWorkspace({
      repoPrefix: "kanban-other-",
      title: "Kanban other",
    });
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previousConfig = await client.getDaemonConfig();
    const example = await copyPluginExample("inbox");
    const createdAgents: { id: string; client: SeedDaemonClient }[] = [];
    let scheduleId: string | null = null;

    const spawn = (
      seeded: typeof workspace,
      options: Parameters<SeedDaemonClient["createAgent"]>[0],
    ) =>
      seeded.client.createAgent(options).then((agent) => {
        createdAgents.push({ id: agent.id, client: seeded.client });
        return agent;
      });

    try {
      await spawn(workspace, {
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Kanban done",
        model: "e2e-fast-stream",
        modeId: "load-test",
        initialPrompt: "Say hello and finish.",
      }).then((agent) => workspace.client.waitForFinish(agent.id, 30_000));
      await spawn(workspace, {
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Kanban question",
        modeId: "load-test",
        initialPrompt: "emit a synthetic question",
      });
      await spawn(workspace, {
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Kanban approval",
        modeId: "load-test",
        initialPrompt: "emit a synthetic plan approval",
      });
      await spawn(workspace, {
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Kanban error",
        modeId: "load-test",
        initialPrompt: "emit a synthetic turn failure",
      });
      await spawn(workspace, {
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Kanban working",
        model: "thirty-minute-stream",
        modeId: "load-test",
        initialPrompt: "Stream for a long time.",
      });
      await spawn(otherWorkspace, {
        provider: "mock",
        cwd: otherWorkspace.repoPath,
        workspaceId: otherWorkspace.workspaceId,
        title: "Kanban other project",
        modeId: "load-test",
        initialPrompt: "emit a synthetic question",
      });
      const schedule = await client.scheduleCreate({
        name: "Kanban nightly review",
        prompt: "emit a synthetic question",
        cadence: { type: "cron", expression: "0 9 * * *" },
        target: {
          type: "new-agent",
          config: { provider: "mock", cwd: workspace.repoPath, model: "e2e-fast-stream" },
        },
      });
      scheduleId = schedule.schedule?.id ?? null;

      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(example.directory);
      await page.setViewportSize(WIDE);
      await gotoAppShell(page);
      await openKanban(page);

      await test.step("lanes show every agent state and the schedule strip", async () => {
        await expect(previewButton(page, "Kanban question")).toBeVisible({ timeout: 30_000 });
        await expect(previewButton(page, "Kanban approval")).toBeVisible();
        await expect(previewButton(page, "Kanban error")).toBeVisible();
        await expect(previewButton(page, "Kanban working")).toBeVisible();
        await expect(previewButton(page, "Kanban done")).toBeVisible();
        await expect(page.getByText(/Scheduled · Kanban nightly review/).first()).toBeVisible();
        await capture(page, testInfo, "01-lanes");
      });

      await test.step("reason chips filter the needs-you lane", async () => {
        await page.getByRole("button", { name: /^Errors \d+$/ }).click();
        await expect(previewButton(page, "Kanban error")).toBeVisible();
        await expect(previewButton(page, "Kanban question")).toHaveCount(0);
        await expect(previewButton(page, "Kanban approval")).toHaveCount(0);
        await page.getByRole("button", { name: /^Errors \d+$/ }).click();
        await expect(previewButton(page, "Kanban question")).toBeVisible();
      });

      await test.step("preview shows queue position, conversation, and changed files", async () => {
        await previewButton(page, "Kanban question").click();
        await expect(page.getByText(/Card \d+ of \d+/)).toBeVisible();
        await expect(page.getByText("Changed files", { exact: true })).toBeVisible();
        await expect(
          page.getByText("Which surface should this apply to?", { exact: true }).first(),
        ).toBeVisible();
        await capture(page, testInfo, "02-peek");
        await page.keyboard.press("Escape");
        await expect(page.getByText("Changed files", { exact: true })).toHaveCount(0);
      });

      await test.step("j then Enter opens the focused card", async () => {
        await page.keyboard.press("j");
        await page.keyboard.press("Enter");
        await expect(page.getByText(/Card \d+ of \d+/)).toBeVisible();
        await page.keyboard.press("Escape");
      });

      await test.step("the ? key opens the shortcut help", async () => {
        await page.keyboard.press("?");
        await expect(page.getByText("Kanban shortcuts", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByText("Kanban shortcuts", { exact: true })).toHaveCount(0);
      });

      await test.step("snooze hides a waiting card until unsnoozed", async () => {
        await cardScope(page, "Kanban error")
          .getByRole("button", { name: "Snooze", exact: true })
          .click();
        await expect(previewButton(page, "Kanban error")).toHaveCount(0);
        await page.getByRole("button", { name: /Show \d+ snoozed/ }).click();
        await expect(
          page.getByRole("button", { name: "Preview snoozed Kanban error", exact: true }),
        ).toBeVisible();
        // The snoozed row's preview must actually open the peek, not dead-end.
        // "Changed files" only renders inside the peek, so it proves it opened.
        await page
          .getByRole("button", { name: "Preview snoozed Kanban error", exact: true })
          .click();
        await expect(page.getByText("Changed files", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await capture(page, testInfo, "03-snoozed");
        await page.getByRole("button", { name: "Unsnooze", exact: true }).click();
        await expect(previewButton(page, "Kanban error")).toBeVisible();
      });

      await test.step("approving from the card resolves the request", async () => {
        await cardScope(page, "Kanban approval")
          .getByRole("button", { name: "Implement", exact: true })
          .click();
        await expect(page.getByRole("button", { name: "Implement", exact: true })).toHaveCount(0, {
          timeout: 30_000,
        });
      });

      await test.step("mark all read clears finished cards", async () => {
        await page.getByRole("button", { name: "Mark all read", exact: true }).click();
        await expect(previewButton(page, "Kanban done")).toHaveCount(0, { timeout: 30_000 });
      });

      await test.step("archive dismisses a finished agent", async () => {
        const archivedAgent = await spawn(workspace, {
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title: "Kanban archived",
          model: "e2e-fast-stream",
          modeId: "load-test",
          initialPrompt: "Say hello and finish.",
        });
        await workspace.client.waitForFinish(archivedAgent.id, 30_000);
        const card = previewButton(page, "Kanban archived");
        await expect(card).toBeVisible({ timeout: 30_000 });
        await cardScope(page, "Kanban archived")
          .getByRole("button", { name: "Archive", exact: true })
          .click();
        await expect(card).toHaveCount(0, { timeout: 30_000 });
      });

      await test.step("search filters every lane", async () => {
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("Kanban question");
        await expect(previewButton(page, "Kanban question")).toBeVisible();
        await expect(previewButton(page, "Kanban error")).toHaveCount(0);
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("");
        await expect(previewButton(page, "Kanban error")).toBeVisible();
      });

      await test.step("group by project sections the lanes", async () => {
        await page.getByRole("button", { name: "Group by project", exact: true }).click();
        // Card context lines render "project / workspace" as one node, so exact
        // display-name matches are the group headers (plus the sidebar row).
        await expect(
          page.getByText(workspace.projectDisplayName, { exact: true }).first(),
        ).toBeVisible();
        await expect(
          page.getByText(otherWorkspace.projectDisplayName, { exact: true }).first(),
        ).toBeVisible();
        await capture(page, testInfo, "04-grouped");
      });

      await test.step("compact layout keeps lanes usable", async () => {
        await page.setViewportSize(COMPACT);
        await expect(previewButton(page, "Kanban question")).toBeVisible();
        await capture(page, testInfo, "05-compact");
      });
    } finally {
      if (scheduleId) await client.scheduleDelete({ id: scheduleId }).catch(() => undefined);
      await client.removePlugin("inbox").catch(() => undefined);
      await client
        .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await client.close().catch(() => undefined);
      await example.cleanup().catch(() => undefined);
      for (const agent of createdAgents) {
        await agent.client.archiveAgent(agent.id).catch(() => undefined);
      }
      await otherWorkspace.cleanup().catch(() => undefined);
      await workspace.cleanup().catch(() => undefined);
    }
  });
});
