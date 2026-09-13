import { buildSchedulesRoute } from "../../src/utils/host-routes";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, type Page } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";

async function propose(agentId: string, args: Record<string, unknown>) {
  const mcp = new Client({ name: "automation-browser-test", version: "1.0.0" });
  const url = new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents`);
  url.searchParams.set("callerAgentId", agentId);
  await mcp.connect(new StreamableHTTPClientTransport(url));
  try {
    const result = await mcp.callTool({ name: "coordinator_propose", arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
  } finally {
    await mcp.close();
  }
}
async function returnToBoard(page: Page, workspace: SeededWorkspace, compact: boolean) {
  if (compact) {
    await page.getByTestId("workspace-tab-switcher-trigger").click();
    await page
      .getByText(workspace.projectDisplayName, { exact: true })
      .filter({ visible: true })
      .last()
      .click();
    return;
  }
  await page
    .getByTestId(`workspace-tab-coordinator_board_${workspace.projectId}`)
    .filter({ visible: true })
    .first()
    .click();
}
for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "compact", width: 390, height: 844 },
])
  test(`${viewport.name}: approves goals and policy proposals into ordinary panes with reversible controls`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const workspace = await seedWorkspace({ repoPrefix: "coordinator-automation-" });
    try {
      const enabled = await workspace.client.enableProjectCoordinator({
        projectId: workspace.projectId,
        scope: "everything",
        profile: { provider: "mock", featureValues: { mockAssistantResponse: "Ready for goals." } },
      });
      if (!enabled.coordinator?.agentId) throw new Error("Coordinator did not start");
      const rule =
        "name: dependencies\non: cron\ncron: '0 8 * * 1'\nstep:\n  profile: implementer\n  prompt: Update dependencies\nguard:\n  max_concurrent: 1\n";
      await propose(enabled.coordinator.agentId, {
        sentence: "Keep dependencies current",
        payload: { kind: "goal", ruleYaml: rule },
      });
      await gotoWorkspace(page, workspace.workspaceId);
      const board = page.getByTestId("coordinator-board").filter({ visible: true });
      await expect(board).toBeVisible({ timeout: 30_000 });
      const proposal = board.getByTestId("coordinator-proposals");
      await expect(proposal).toContainText("Keep dependencies current", { timeout: 30_000 });
      await proposal.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(proposal).toHaveCount(0, { timeout: 30_000 });
      await board.getByRole("button", { name: "Goals", exact: true }).click();
      const goals = page.getByTestId("coordinator-goals-pane").filter({ visible: true });
      await expect(goals).toBeVisible();
      await expect(goals).toContainText("Keep dependencies current");
      await expect(goals).toContainText("Deterministic");
      await goals.getByRole("button", { name: "View rule", exact: true }).click();
      await expect(goals).toContainText("max_concurrent: 1");
      await page.screenshot({ path: testInfo.outputPath("goals-pane.png"), fullPage: true });
      const toggle = goals.getByRole("switch", { name: "Run goal: Keep dependencies current" });
      await toggle.click();
      await expect(goals.getByText("Goal paused", { exact: true })).toBeVisible();
      await toggle.click();
      await expect(goals.getByText("Goal resumed", { exact: true })).toBeVisible();
      await returnToBoard(page, workspace, viewport.name === "compact");
      const pattern = JSON.stringify({
        provider: "mock",
        tool: "Write",
        input: { path: "README.md", content: "hello" },
      });
      await propose(enabled.coordinator.agentId, {
        sentence: "Allow this README update",
        payload: { kind: "policy", pattern, scope: "projects" },
      });
      await expect(proposal).toContainText("Allow this README update", { timeout: 30_000 });
      await proposal.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(proposal).toHaveCount(0, { timeout: 30_000 });
      await board.getByRole("button", { name: "Policy", exact: true }).click();
      const policy = page.getByTestId("coordinator-policy-pane").filter({ visible: true });
      await expect(policy).toContainText("README.md");
      const policyToggle = policy.getByRole("switch");
      await policyToggle.click();
      await expect(policy.getByText("Rule disabled", { exact: true })).toBeVisible();
      await policyToggle.click();
      await expect(policy.getByText("Rule enabled", { exact: true })).toBeVisible();
      await returnToBoard(page, workspace, viewport.name === "compact");
      const worker = await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Policy test worker",
      });
      await workspace.client.sendAgentMessage(worker.id, "emit a synthetic tool permission");
      const needsYou = board.getByTestId("coordinator-section-needs-you");
      await expect(
        needsYou.getByRole("button", { name: "Always allow this", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await needsYou.getByRole("button", { name: "Always allow this", exact: true }).click();
      const confirmation =
        viewport.name === "compact"
          ? page
              .getByRole("slider", { name: "Bottom Sheet", exact: true })
              .filter({ visible: true })
          : page.getByTestId("coordinator-policy-confirmation").filter({ visible: true });
      await expect(confirmation).toContainText("npm test");
      await expect(confirmation).toContainText("Every field must match");
      await expect(confirmation).toContainText("different worktree or changed input");
      await expect(confirmation).toContainText("Ship or Autopilot");
      await expect(confirmation).toContainText(
        "At Observe or Propose, requests still need your approval.",
      );
      await confirmation.getByRole("button", { name: "This project", exact: true }).click();
      await page.screenshot({
        path: testInfo.outputPath("policy-confirmation.png"),
        fullPage: true,
      });

      await expect(
        confirmation.getByRole("button", { name: "This project", exact: true }),
      ).toBeVisible();
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(needsYou).toBeVisible();
      await needsYou.getByRole("button", { name: "Always allow this", exact: true }).click();
      await confirmation.getByRole("button", { name: "Save rule and allow", exact: true }).click();
      await expect(confirmation).toContainText("Rule saved and permission approved.");
      await confirmation.getByRole("button", { name: "Done", exact: true }).click();
      await expect(needsYou).toHaveCount(0, { timeout: 30_000 });
      const finished = await workspace.client.waitForFinish(worker.id, 30_000);
      expect(finished.status).toBe("idle");
      const installedGoals = await workspace.client.listCoordinatorGoals({
        projectId: workspace.projectId,
      });
      const installedGoal = installedGoals.find(
        (goal) => goal.sentence === "Keep dependencies current",
      );
      if (!installedGoal?.scheduleId) throw new Error("Approved goal has no schedule");
      await page.goto(buildSchedulesRoute());
      const scheduleRow = page.getByTestId(`schedule-row-${installedGoal.scheduleId}`);
      await expect(scheduleRow).toBeVisible({ timeout: 30_000 });
      await expect(scheduleRow).toContainText("Managed in Goals · schedule is read-only");
      await expect(
        scheduleRow.getByTestId(`schedule-kebab-${installedGoal.scheduleId}`),
      ).toHaveCount(0);
      await scheduleRow.getByRole("button", { name: "Open Goals", exact: true }).click();
      await expect(goals).toBeVisible({ timeout: 30_000 });
      await expect(goals).toHaveCount(1);
      await expect(goals).toContainText("Keep dependencies current");
      await goals.getByRole("switch", { name: "Run goal: Keep dependencies current" }).click();
      await expect(goals.getByText("Goal paused", { exact: true })).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("schedule-open-goals.png"),
        fullPage: true,
      });
    } finally {
      await workspace.cleanup();
    }
  });
