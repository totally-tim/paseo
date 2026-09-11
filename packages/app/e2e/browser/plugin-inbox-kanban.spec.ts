import type { TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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

/**
 * Opens the needs-you lane's snoozed section if it is currently collapsed.
 * Call only when the caller knows a snoozed card exists — this waits for the
 * toggle to render instead of racing it with an instant count check.
 */
async function revealSnoozed(page: Page) {
  const toggle = page.getByRole("button", { name: /^(Show \d+ snoozed|Hide snoozed)$/ });
  await expect(toggle).toBeVisible();
  const label = await toggle.textContent();
  if (label?.startsWith("Show")) await toggle.click();
}

/** Blurs whatever is focused, or no-ops when nothing is — a bare `:focus` locator throws instead. */
function blurActiveElement(page: Page) {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe("inbox kanban board", () => {
  test.describe.configure({ timeout: 300_000 });

  test("triages questions, approvals, errors, working and finished agents", async ({
    page,
  }, testInfo) => {
    // A base-mode diff compares the current branch against its origin tracking
    // branch (see getCheckoutDiff in checkout-git.ts) — it never includes
    // uncommitted or untracked changes. `withRemote` gives this repo a
    // resolvable origin/main so a later local-only commit has something to
    // diff against.
    const workspace = await seedWorkspace({
      repoPrefix: "kanban-e2e-",
      title: "Kanban e2e",
      repo: { withRemote: true },
    });
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
        // Establishes the 4th needs-you card before the queue-position check below
        // counts on it — this one comes from a different workspace/project, so it
        // can lag the others.
        await expect(previewButton(page, "Kanban other project")).toBeVisible({
          timeout: 30_000,
        });
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
        // A committed-but-unpushed file is what a base-mode diff picks up: it's
        // ahead of origin/main, which the diff resolves to as the base ref.
        await writeFile(path.join(workspace.repoPath, "kanban-e2e-change.txt"), "e2e change\n");
        execFileSync("git", ["add", "kanban-e2e-change.txt"], { cwd: workspace.repoPath });
        execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "kanban e2e change"], {
          cwd: workspace.repoPath,
        });
        await previewButton(page, "Kanban question").click();
        // 4 needs-you cards are seeded: question, approval, error, and the
        // other-project question — the queue position counts across all of them.
        await expect(page.getByText(/^Card \d+ of 4$/)).toBeVisible();
        await expect(page.getByText("Changed files", { exact: true })).toBeVisible();
        await expect(page.getByText("kanban-e2e-change.txt", { exact: true })).toBeVisible();
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

      await test.step("j then s snoozes the focused needs-you card via keyboard", async () => {
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("Kanban question");
        await expect(previewButton(page, "Kanban question")).toBeVisible();
        // The filter must have actually applied before "j" moves focus — otherwise
        // "j" could land on a card the search was meant to hide.
        await expect(previewButton(page, "Kanban error")).toHaveCount(0);
        // Blur the search field first — the keydown listener ignores keys targeting text fields.
        await blurActiveElement(page);
        await page.keyboard.press("j");
        await page.keyboard.press("s");
        await expect(previewButton(page, "Kanban question")).toHaveCount(0);
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("");
        await expect(previewButton(page, "Kanban approval")).toBeVisible();
        await expect(previewButton(page, "Kanban question")).toHaveCount(0);
        await revealSnoozed(page);
        const snoozedPreview = page.getByRole("button", {
          name: "Preview snoozed Kanban question",
          exact: true,
        });
        await expect(snoozedPreview).toBeVisible();
        await snoozedPreview.click();
        await expect(page.getByText("Changed files", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Unsnooze", exact: true }).click();
        await expect(previewButton(page, "Kanban question")).toBeVisible();
      });

      await test.step("snooze hides a waiting card until unsnoozed", async () => {
        await cardScope(page, "Kanban error")
          .getByRole("button", { name: "Snooze", exact: true })
          .click();
        await expect(previewButton(page, "Kanban error")).toHaveCount(0);
        await revealSnoozed(page);
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

      await test.step("x archives a finished agent out of Done via keyboard", async () => {
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
        // A finished agent must land in Done, not just somewhere on the board,
        // before archiving it proves anything about the Done-lane action.
        await expect(
          page
            .getByTestId("inbox-lane-done")
            .getByRole("button", { name: "Preview Kanban archived", exact: true }),
        ).toBeVisible({ timeout: 30_000 });
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("Kanban archived");
        await expect(card).toBeVisible();
        // The filter must have actually applied before "j" moves focus — otherwise
        // "j" could land on a card the search was meant to hide.
        await expect(previewButton(page, "Kanban working")).toHaveCount(0);
        // Blur the search field first — the keydown listener ignores keys targeting text fields.
        await blurActiveElement(page);
        await page.keyboard.press("j");
        await page.keyboard.press("x");
        await expect(card).toHaveCount(0, { timeout: 30_000 });
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("");
      });

      await test.step("j then m marks a focused done card read via keyboard", async () => {
        const readAgent = await spawn(workspace, {
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title: "Kanban keyboard read",
          model: "e2e-fast-stream",
          modeId: "load-test",
          initialPrompt: "Say hello and finish.",
        });
        await workspace.client.waitForFinish(readAgent.id, 30_000);
        await expect(previewButton(page, "Kanban keyboard read")).toBeVisible({
          timeout: 30_000,
        });
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("Kanban keyboard read");
        await expect(previewButton(page, "Kanban keyboard read")).toBeVisible();
        // The filter must have actually applied before "j" moves focus — otherwise
        // "j" could land on a card the search was meant to hide.
        await expect(previewButton(page, "Kanban working")).toHaveCount(0);
        // Blur the search field first — the keydown listener ignores keys targeting text fields.
        await blurActiveElement(page);
        await page.keyboard.press("j");
        await page.keyboard.press("m");
        await expect(previewButton(page, "Kanban keyboard read")).toHaveCount(0, {
          timeout: 30_000,
        });
        await page.getByRole("textbox", { name: "Search Kanban" }).fill("");
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
        // display-name matches are the group headers. Scope to the lanes wrapper —
        // the sidebar also shows project names and would otherwise match first.
        const lanes = page.getByTestId("inbox-lanes");
        await expect(
          lanes.getByText(workspace.projectDisplayName, { exact: true }).first(),
        ).toBeVisible();
        await expect(
          lanes.getByText(otherWorkspace.projectDisplayName, { exact: true }).first(),
        ).toBeVisible();
        await capture(page, testInfo, "04-grouped");
      });

      await test.step("compact layout keeps lanes usable", async () => {
        await page.setViewportSize(COMPACT);
        await expect(previewButton(page, "Kanban question")).toBeVisible();
        await capture(page, testInfo, "05-compact");
        // Working starts collapsed in the compact layout; expanding its header
        // must reveal the working card, and collapsing again must hide it.
        const workingHeader = page.getByRole("button", { name: /^Working/ });
        await workingHeader.click();
        await expect(previewButton(page, "Kanban working")).toBeVisible();
        await workingHeader.click();
        await expect(previewButton(page, "Kanban working")).toHaveCount(0);
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
