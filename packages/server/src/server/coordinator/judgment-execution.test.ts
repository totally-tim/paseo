import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { executeCoordinatorJudgment } from "./judgment-execution.js";
import { GoalExecutionDeferred } from "./automation.js";
import type { GoalRecord } from "./goals.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function harness(noWork = false) {
  const home = await mkdtemp(path.join(tmpdir(), "judgment-goal-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(home, logger);
  const prompts: unknown[] = [];
  const manager = new AgentManager({
    clients: createTestAgentClients({
      onStartTurn: (prompt) => prompts.push(prompt),
      ...(noWork
        ? {
            scriptedTurn: async () => [
              {
                type: "timeline" as const,
                provider: "claude",
                item: {
                  type: "assistant_message" as const,
                  text: JSON.stringify({
                    paseo_goal_run: "run",
                    outcome: "no_work",
                    reason: "No stalled PRs require action",
                  }),
                },
              },
              { type: "turn_completed" as const, provider: "claude" },
            ],
          }
        : {}),
    }),
    registry: storage,
    logger,
  });
  cleanups.push(async () => {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    await storage.flush();
    await rm(home, { recursive: true, force: true });
  });
  const owner = await manager.createAgent(
    { provider: "claude", cwd: home, modeId: "default" },
    undefined,
    {
      workspaceId: "workspace",
      labels: {
        "paseo.role": "coordinator.project",
        "paseo.coordinator.project-id": "project",
        "paseo.coordinator.trust": "ship",
      },
    },
  );
  const goal: GoalRecord = {
    id: "goal",
    projectId: "project",
    proposalId: "approved",
    sentence: "Check whether rm -f permission.txt needs running",
    ruleYaml:
      "name: check\non: heartbeat\nintervalMinutes: 60\nstep: { profile: investigator, prompt: Check progress }\nguard: { max_concurrent: 1 }",
    kind: "judgment",
    paused: false,
    createdAt: new Date().toISOString(),
    firedCount: 0,
    emptyStreak: 0,
    runs: {},
  };
  let permitted = true;
  let locked = false;
  const run = () =>
    executeCoordinatorJudgment({
      goal,
      runId: "run",
      agentId: owner.id,
      agentManager: manager,
      agentStorage: storage,
      logger,
      authorizeStart: async (dispatch) => {
        locked = true;
        try {
          return await dispatch();
        } finally {
          locked = false;
        }
      },
      assertStart: async () => {
        expect(locked).toBe(true);
        if (!permitted) throw new GoalExecutionDeferred("Paused before dispatch");
      },
    });
  return {
    manager,
    owner,
    prompts,
    run,
    isLocked: () => locked,
    disable: () => {
      permitted = false;
    },
  };
}

test("judgment runs one resident turn without workers and stays pending across its permission checkpoint", async () => {
  const h = await harness();
  let settled = false;
  const execution = h.run().finally(() => {
    settled = true;
  });
  await expect.poll(() => h.manager.getAgent(h.owner.id)?.pendingPermissions.size).toBe(1);
  expect(h.manager.listAgents()).toHaveLength(1);
  expect(h.prompts).toHaveLength(1);
  expect(h.isLocked()).toBe(false);
  expect(settled).toBe(false);
  const request = [...h.manager.getAgent(h.owner.id)!.pendingPermissions.values()][0]!;
  await h.manager.respondToPermission(h.owner.id, request.id, { behavior: "allow" });
  expect(await execution).toMatchObject({ agentId: h.owner.id, producedOutcome: null });
  expect(h.prompts).toHaveLength(1);
});

test("judgment fresh pause admission starts no resident turn", async () => {
  const h = await harness();
  h.disable();
  await expect(h.run()).rejects.toBeInstanceOf(GoalExecutionDeferred);
  expect(h.prompts).toHaveLength(0);
});

test("stopping a judgment at permission rejects completion rather than recording an empty result", async () => {
  const h = await harness();
  const execution = h.run();
  const rejected = expect(execution).rejects.toThrow();
  await expect.poll(() => h.manager.getAgent(h.owner.id)?.pendingPermissions.size).toBe(1);
  await h.manager.cancelAgentRun(h.owner.id);
  await rejected;
  expect(h.prompts).toHaveLength(1);
});

test("judgment explicit no-action report records an empty result on the resident turn", async () => {
  const h = await harness(true);
  expect(await h.run()).toMatchObject({
    agentId: h.owner.id,
    producedOutcome: false,
    output: "No work needed: No stalled PRs require action",
  });
  expect(h.prompts).toHaveLength(1);
  expect(h.manager.listAgents()).toHaveLength(1);
});
