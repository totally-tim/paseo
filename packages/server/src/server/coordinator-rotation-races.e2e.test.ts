import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COORDINATOR_TRUST_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";
import { createTestAgentClient, createTestAgentClients } from "./test-utils/fake-agent-client.js";
import type { AgentClient, AgentPromptInput, AgentSessionConfig } from "./agent/agent-sdk-types.js";
import { assertCoordinatorToolAllowed } from "./coordinator/tool-policy.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function text(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
interface Turn {
  agentId: string;
  prompt: string;
  providerSystemPrompt: string | undefined;
  trust: string | undefined;
  writingAllowed: boolean;
}
let context: DaemonTestContext | null = null;
let directory: string | null = null;
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await context?.cleanup();
  context = null;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

async function setup() {
  const turns: Turn[] = [];
  let gate: {
    entered: ReturnType<typeof deferred<string>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;
  const base = createTestAgentClient("opencode");
  function sessionClient(config: AgentSessionConfig, agentId: string) {
    return createTestAgentClient("opencode", {
      onStartTurn: (prompt) => {
        const agent = context?.daemon.daemon.agentManager.getAgent(agentId);
        let writingAllowed = true;
        try {
          assertCoordinatorToolAllowed(agent, "create_workspace");
        } catch {
          writingAllowed = false;
        }
        turns.push({
          agentId,
          prompt: text(prompt),
          providerSystemPrompt: config.systemPrompt,
          trust: agent?.labels[COORDINATOR_TRUST_LABEL],
          writingAllowed,
        });
      },
    });
  }
  const controlled: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    fetchCatalog: (...args) => base.fetchCatalog(...args),
    isAvailable: (...args) => base.isAvailable(...args),
    async createSession(config, launch, options) {
      const waiting = gate;
      gate = null;
      if (waiting) {
        waiting.entered.resolve(launch?.agentId ?? "");
        await waiting.release.promise;
      }
      return sessionClient(config, launch?.agentId ?? "").createSession(config, launch, options);
    },
    resumeSession(handle, config, launch, options) {
      const resolved = { provider: "opencode", cwd: directory ?? tmpdir(), ...config };
      return sessionClient(resolved, launch?.agentId ?? "").resumeSession(
        handle,
        config,
        launch,
        options,
      );
    },
  };
  context = await createDaemonTestContext({
    agentClients: { ...createTestAgentClients(), opencode: controlled },
    dependencies: { coordinatorNow: () => new Date(2026, 8, 13, 12).getTime() },
  });
  directory = await mkdtemp(path.join(tmpdir(), "coordinator-rotation-races-"));
  const opened = await context.client.openProject(directory);
  if (!opened.workspace) throw new Error("Missing workspace");
  const enabled = await context.client.enableProjectCoordinator({
    projectId: opened.workspace.projectId,
    profile: { provider: "opencode" },
    trustLevel: "ship",
  });
  const sourceId = enabled.coordinator?.agentId;
  if (!sourceId) throw new Error("Missing coordinator");
  await expect.poll(() => context!.daemon.daemon.agentManager.hasInFlightRun(sourceId)).toBe(false);
  function holdNextCreation() {
    const waiting = { entered: deferred<string>(), release: deferred<void>() };
    gate = waiting;
    releases.push(() => waiting.release.resolve());
    return waiting;
  }
  return { ctx: context, sourceId, projectId: opened.workspace.projectId, turns, holdNextCreation };
}

test("a trust downgrade during provider creation governs the successor's first briefing", async () => {
  const { ctx, sourceId, projectId, turns, holdNextCreation } = await setup();
  const waiting = holdNextCreation();
  const rotation = ctx.daemon.daemon.coordinatorService.rotateCoordinator(sourceId);
  const successorId = await waiting.entered.promise;
  try {
    await ctx.client.updateProjectCoordinator({ projectId, trustLevel: "observe" });
  } finally {
    waiting.release.resolve();
  }
  await rotation;
  await expect.poll(() => turns.filter((turn) => turn.agentId === successorId).length).toBe(1);
  const first = turns.find((turn) => turn.agentId === successorId)!;
  expect(first.trust).toBe("observe");
  expect(first.writingAllowed).toBe(false);
  expect(first.providerSystemPrompt).toContain("Observe trust level");
  expect(first.providerSystemPrompt).not.toContain("Ship trust level");
  expect((await ctx.client.getProjectCoordinator(projectId)).coordinator?.trustLevel).toBe(
    "observe",
  );
}, 60_000);

test("an old decision response during creation waits for restoration and then reaches the successor once", async () => {
  const { ctx, sourceId, turns, holdNextCreation } = await setup();
  const service = ctx.daemon.daemon.coordinatorService;
  const manager = ctx.daemon.daemon.agentManager;
  const decision = await service.raiseDecision({
    callerAgentId: sourceId,
    question: "Investigate the race?",
    actions: [{ id: "investigate", label: "Investigate", response: { behavior: "allow" } }],
  });
  const waiting = holdNextCreation();
  const rotation = service.rotateCoordinator(sourceId);
  const successorId = await waiting.entered.promise;
  const response = { behavior: "allow" as const, selectedActionId: "investigate" };
  try {
    await expect(
      ctx.client.respondToPermissionAndWait(sourceId, decision.requestId, response),
    ).rejects.toThrow("restoring");
    expect(turns.filter((turn) => turn.agentId === successorId)).toEqual([]);
  } finally {
    waiting.release.resolve();
  }
  await rotation;
  await expect.poll(() => manager.hasInFlightRun(successorId)).toBe(false);
  const acknowledged = await ctx.client.respondToPermissionAndWait(
    sourceId,
    decision.requestId,
    response,
  );
  expect(acknowledged.agentId).toBe(sourceId);
  expect(acknowledged.requestId).toBe(decision.requestId);
  await service.tickDecisions();
  await expect
    .poll(
      () =>
        turns.filter(
          (turn) =>
            turn.agentId === successorId && turn.prompt.includes("<untrusted-decision-answer>"),
        ).length,
    )
    .toBe(1);
  const successorTurns = turns.filter((turn) => turn.agentId === successorId);
  expect(successorTurns[0]!.prompt).not.toContain("<untrusted-decision-answer>");
  expect(successorTurns[1]!.prompt).toContain("Investigate the race?");
  await service.tickDecisions();
  expect(
    turns.filter(
      (turn) => turn.agentId === successorId && turn.prompt.includes("<untrusted-decision-answer>"),
    ).length,
  ).toBe(1);
  expect(manager.getPendingPermissions(successorId).map((request) => request.id)).not.toContain(
    decision.requestId,
  );
}, 60_000);
