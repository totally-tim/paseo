import { expect, test, type Page } from "../support/fixtures";
import { waitForDraftComposer } from "../support/helpers/command-center-agent-controls";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

/**
 * The coordinator session runs the dev-only mock provider so its turns are
 * deterministic: `mockAssistantResponse` answers every turn, including the
 * first-contact prompt the daemon sends on enable.
 */
const COORDINATOR_REPLY = "Watching the project; one session needs a decision.";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

function boardTabTestId(projectId: string): string {
  return `workspace-tab-coordinator_board_${projectId}`;
}

function agentTabTestId(agentId: string): string {
  return `workspace-tab-agent_${agentId}`;
}

async function enableMockCoordinator(
  workspace: SeededWorkspace,
): Promise<{ coordinatorAgentId: string }> {
  const { coordinator } = await workspace.client.enableProjectCoordinator({
    projectId: workspace.projectId,
    profile: {
      provider: "mock",
      featureValues: { mockAssistantResponse: COORDINATOR_REPLY },
    },
  });
  if (!coordinator?.agentId) {
    throw new Error("enableProjectCoordinator returned no coordinator session");
  }
  return { coordinatorAgentId: coordinator.agentId };
}

async function closeAgentTab(page: Page, agentId: string): Promise<void> {
  const tab = page.getByTestId(agentTabTestId(agentId)).filter({ visible: true }).first();
  await tab.click({ button: "right" });
  await page.getByTestId(`workspace-tab-context-agent_${agentId}-close`).click();
  await expect(tab).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Coordinator board", () => {
  // The first test after a spec-file switch can fail while the shared daemon
  // releases stale sessions from the previous spec; one retry stabilizes it.
  test.describe.configure({ retries: 1 });
  test.setTimeout(120_000);

  test("the draft home offers coordinator setup until the project enables one", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "coordinator-setup-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForDraftComposer(page);

      const setupRow = page.getByTestId("coordinator-setup-row").filter({ visible: true });
      await expect(setupRow).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("coordinator-board")).toHaveCount(0);

      await setupRow.click();
      const sheet = page.getByTestId("coordinator-enable-sheet").filter({ visible: true });
      await expect(sheet).toBeVisible({ timeout: 15_000 });
      for (const provider of ["claude", "codex", "opencode"]) {
        await expect(
          page.getByTestId(`coordinator-enable-provider-${provider}`).filter({ visible: true }),
        ).toBeVisible();
      }
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test("enabling while the workspace is open swaps the draft home for the board", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "coordinator-enable-open-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForDraftComposer(page);
      await expect(
        page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true }).first(),
      ).toBeVisible();

      await enableMockCoordinator(workspace);

      // The draft home tab becomes the board in place — no navigation, no reopen.
      const board = page.getByTestId("coordinator-board").filter({ visible: true });
      await expect(board).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
      const boardTab = page
        .getByTestId(boardTabTestId(workspace.projectId))
        .filter({ visible: true })
        .first();
      await expect(boardTab).toBeVisible();
      await expect(boardTab).toHaveAttribute("aria-selected", "true");
    } finally {
      await workspace.cleanup();
    }
  });

  test("the board replaces the draft pane and the reply area shows the last message", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "coordinator-board-" });
    try {
      const { coordinatorAgentId } = await enableMockCoordinator(workspace);
      await gotoWorkspace(page, workspace.workspaceId);

      // The seeded home is the board, not a draft tab.
      const board = page.getByTestId("coordinator-board").filter({ visible: true });
      await expect(board).toBeVisible({ timeout: 30_000 });
      const boardTab = page
        .getByTestId(boardTabTestId(workspace.projectId))
        .filter({ visible: true })
        .first();
      await expect(boardTab).toBeVisible();
      await expect(boardTab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
      await expect(page.getByTestId("coordinator-setup-row")).toHaveCount(0);

      // Enabling wrote the wake line; the mock coordinator's first-contact
      // reply is the board's reply area.
      await expect(page.getByTestId("coordinator-wake").filter({ visible: true })).toContainText(
        "Woke",
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("coordinator-reply").filter({ visible: true })).toContainText(
        COORDINATOR_REPLY,
        { timeout: 30_000 },
      );

      // The board composer talks to the coordinator session.
      const boardComposer = board.getByRole("textbox").first();
      await expect(boardComposer).toBeEditable({ timeout: 30_000 });
      await boardComposer.fill("What is happening?");
      await boardComposer.press("Enter");
      await expect(page.getByTestId("coordinator-reply").filter({ visible: true })).toContainText(
        COORDINATOR_REPLY,
        { timeout: 30_000 },
      );

      // Chat opens the coordinator's ordinary agent tab; closing it returns to
      // the still-open board.
      await page.getByTestId("coordinator-chat-button").filter({ visible: true }).click();
      const chatTab = page
        .getByTestId(agentTabTestId(coordinatorAgentId))
        .filter({ visible: true })
        .first();
      await expect(chatTab).toBeVisible({ timeout: 15_000 });
      await expect(chatTab).toHaveAttribute("aria-selected", "true");
      await expect(board).toHaveCount(0);

      await closeAgentTab(page, coordinatorAgentId);
      await expect(board).toBeVisible({ timeout: 15_000 });
      await expect(boardTab).toHaveAttribute("aria-selected", "true");
    } finally {
      await workspace.cleanup();
    }
  });

  test("a workspace session's pending permission lands in Needs you and answers from the board", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "coordinator-decision-" });
    try {
      await enableMockCoordinator(workspace);
      await gotoWorkspace(page, workspace.workspaceId);
      const board = page.getByTestId("coordinator-board").filter({ visible: true });
      await expect(board).toBeVisible({ timeout: 30_000 });

      // A regular project session opens its tab in the background; the board
      // stays focused and reports the session under Working.
      const agent = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Board test session",
      });
      const workingRow = page
        .getByTestId(`coordinator-working-working:${agent.id}`)
        .filter({ visible: true });
      await expect(workingRow).toBeVisible({ timeout: 30_000 });
      await expect(workingRow).toContainText("Board test session");

      // The session raises a plan-approval permission; the board surfaces it
      // as a Needs-you decision with the request's own actions.
      await workspace.client.sendAgentMessage(agent.id, "emit a synthetic plan approval");
      const needsYou = page.getByTestId("coordinator-section-needs-you").filter({ visible: true });
      await expect(needsYou).toBeVisible({ timeout: 30_000 });
      await expect(needsYou).toContainText("Plan");
      const implementAction = needsYou.getByRole("button", { name: "Implement" });
      await expect(implementAction).toBeVisible();
      await expect(needsYou.getByRole("button", { name: "Dismiss" })).toBeVisible();
      await implementAction.click();

      // Resolving empties Needs you and records the answer in Done.
      await expect(
        page.getByTestId("coordinator-section-needs-you").filter({ visible: true }),
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(
        page.getByTestId("coordinator-section-done").filter({ visible: true }),
      ).toContainText("Answered", { timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test("compact layout stacks the sections and the header menu opens the chat", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    const workspace = await seedWorkspace({ repoPrefix: "coordinator-compact-" });
    try {
      await enableMockCoordinator(workspace);
      await gotoWorkspace(page, workspace.workspaceId);

      const board = page.getByTestId("coordinator-board").filter({ visible: true });
      await expect(board).toBeVisible({ timeout: 30_000 });
      // Done collapses behind a count toggle on compact layouts.
      await expect(
        page.getByTestId("coordinator-done-toggle").filter({ visible: true }),
      ).toBeVisible();

      await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
      await page
        .getByTestId("workspace-header-open-coordinator-chat")
        .filter({ visible: true })
        .click();
      await expect(board).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }).first(),
      ).toBeEditable({ timeout: 30_000 });
      // The chat shows the coordinator transcript, including its latest reply.
      await expect(
        page
          .getByTestId("assistant-message")
          .filter({ hasText: COORDINATOR_REPLY })
          .filter({ visible: true })
          .last(),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
