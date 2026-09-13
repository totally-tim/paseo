import type { Logger } from "pino";
import type { AgentStorage } from "../agent/agent-storage.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { GoalExecutionDeferred } from "./automation.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { CoordinatorProfileSelection } from "@getpaseo/protocol/messages";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { CoordinatorSubagentKind } from "@getpaseo/protocol/agent-labels";
import { sanitizeUntrustedText, setupFinishNotification } from "../agent/agent-prompt.js";
import { parseGoalRule, type GoalEvent, type GoalRecord } from "./goals.js";

const runFile = promisify(execFile);
async function repositoryOutcome(cwd: string): Promise<string | null> {
  try {
    const head = await runFile("git", ["rev-parse", "HEAD"], { cwd });
    const diff = await runFile("git", ["diff", "--binary", "HEAD"], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    const status = await runFile("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
    });
    return createHash("sha256")
      .update(head.stdout)
      .update(diff.stdout)
      .update(status.stdout)
      .digest("hex");
  } catch {
    return null;
  }
}

export async function executeCoordinatorGoal(input: {
  goal: GoalRecord;
  runId: string;
  event?: GoalEvent;
  owner: { agentId: string; cwd: string; workspaceId: string };
  profile: CoordinatorProfileSelection;
  createAgent: BoundCreateAgentCommand;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  cleanupNeverStartedWorkspace?: (input: {
    workerAgentId: string;
    workspaceId: string;
    cwd: string;
  }) => Promise<void>;
  assertStart: () => Promise<void>;
  authorizeStart: <T>(run: () => Promise<T>) => Promise<T | undefined>;
}) {
  const rule = parseGoalRule(input.goal.ruleYaml);
  const kind: CoordinatorSubagentKind =
    rule.step.profile === "reviewer" || rule.step.profile === "investigator"
      ? rule.step.profile
      : "implementer";
  const prompt = `Run the approved goal: ${input.goal.sentence}\n${renderGoalPrompt(rule.step.prompt, input.event)}\nReport the concrete outcome and any blockers to your coordinator. Do not claim completion from a successful command alone.\n${goalNoWorkInstructions(input.runId)}`;
  let before: string | null = null;
  let minted: CreatePaseoWorktreeWorkflowResult | undefined;
  let neverStarted: { id: string; cwd: string; workspaceId?: string | null } | undefined;
  let dispatchAttempted = false;
  let created;
  try {
    created = await input.createAgent({
      onWorktreeCreated: (worktree) => {
        minted = worktree;
      },
      kind: "mcp",
      callerAgentId: input.owner.agentId,
      provider: input.profile.provider,
      config: input.profile,
      cwd: input.owner.cwd,
      workspaceId: input.owner.workspaceId,
      title: input.goal.sentence.slice(0, 100),
      subagentKind: kind,
      unattended: true,
      background: true,
      notifyOnFinish: true,
      promptFailure: "throw",
      initialPrompt: prompt,
      dispatchInitialPrompt: async (snapshot, dispatch) => {
        neverStarted = snapshot;
        let stopNotification: (() => void) | undefined;
        try {
          before =
            snapshot.cwd !== input.owner.cwd && snapshot.workspaceId !== input.owner.workspaceId
              ? await repositoryOutcome(snapshot.cwd)
              : null;
          const started = await input.authorizeStart(async () => {
            await input.assertStart();
            stopNotification = setupFinishNotification({
              agentManager: input.agentManager,
              agentStorage: input.agentStorage,
              logger: input.logger,
              childAgentId: snapshot.id,
              callerAgentId: input.owner.agentId,
              requireParentOwnership: true,
            });
            dispatchAttempted = true;
            return dispatch();
          });
          if (!started)
            throw new GoalExecutionDeferred(
              "Goal deferred because coordinator eligibility changed before dispatch",
            );
          return started;
        } catch (error) {
          stopNotification?.();
          if (dispatchAttempted) await input.agentManager.closeAgent(snapshot.id);
          throw error;
        }
      },
      callerContext: { lockedCwd: input.owner.cwd, allowCustomCwd: false },
    });
  } catch (error) {
    // This runs after createAgent releases the coordinator spawn lock. Never clean
    // up a dispatched turn, even if its provider rejected the first prompt.
    await cleanupNeverStartedGoalWorker(input, neverStarted, minted, dispatchAttempted);
    if (!dispatchAttempted) {
      const eligible = await input.authorizeStart(async () => {
        await input.assertStart();
        return true;
      });
      if (!eligible)
        throw new GoalExecutionDeferred(
          "Goal deferred because coordinator eligibility changed before dispatch",
        );
    }
    throw error;
  }
  let finished = await input.agentManager.waitForAgentEvent(created.snapshot.id, {
    waitForActive: true,
  });
  while (finished.permission) {
    await waitForPermissionResolution(
      input.agentManager,
      created.snapshot.id,
      finished.permission.id,
    );
    finished = await input.agentManager.waitForAgentEvent(created.snapshot.id, {
      waitForActive: true,
    });
  }
  if (finished.status === "error") throw new Error(finished.lastMessage ?? "Goal worker failed");
  const attributable = await isAttributableGoalWorkspace(input, created.snapshot);
  const after = attributable ? await repositoryOutcome(created.snapshot.cwd) : null;
  const stillOwned = await isAttributableGoalWorkspace(input, created.snapshot);
  const producedOutcome = classifyGoalOutcome({
    isolated: attributable && stillOwned,
    before,
    after,
    output: finished.lastMessage,
    runId: input.runId,
  });
  return {
    agentId: created.snapshot.id,
    output: goalOutcomeSummary(finished.lastMessage, input.runId, producedOutcome),
    producedOutcome,
  };
}

/** A permission checkpoint is still the same goal run, including a fast policy answer. */
async function waitForPermissionResolution(
  manager: AgentManager,
  agentId: string,
  requestId: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const check = () => {
      const agent = manager.getAgent(agentId);
      if (
        agent &&
        agent.lifecycle !== "closed" &&
        agent.lifecycle !== "error" &&
        agent.pendingPermissions.has(requestId)
      )
        return;
      settled = true;
      unsubscribe?.();
      resolve();
    };
    unsubscribe = manager.subscribe(check, { agentId, replayState: false });
    if (settled) unsubscribe();
    else check();
  });
}

/** Event values are data, including when substituted into approved instructions. */
export function renderGoalPrompt(prompt: string, event?: GoalEvent): string {
  const fence = (value: unknown) =>
    `<untrusted-wake-details>\n${sanitizeUntrustedText(JSON.stringify(value ?? null))}\n</untrusted-wake-details>`;
  const rendered = prompt.replace(
    /\$\{\{\s*paseo\.(change_request|agent)\s*\}\}/g,
    (_token, key: string) =>
      fence(
        key === "agent" && event?.trigger === "agent.stalled" && !event.context?.agent
          ? {
              id: event.context?.agentId,
              requestId: event.context?.requestId,
              waitedMinutes: event.context?.waitedMinutes,
            }
          : event?.context?.[key],
      ),
  );
  return `${rendered}\n${fence(event?.context ?? {})}`;
}

export function classifyGoalOutcome(input: {
  isolated: boolean;
  before: string | null;
  after: string | null;
  output?: string | null;
  runId?: string;
}): boolean | null {
  if (
    input.isolated &&
    input.before !== null &&
    input.after !== null &&
    input.before !== input.after
  )
    return true;
  // Identical Git state alone cannot rule out a remote write. Only the explicit
  // run-bound no-work report, corroborated by this dedicated checkout, is empty.
  if (
    input.isolated &&
    input.before !== null &&
    input.before === input.after &&
    input.runId &&
    reportsGoalNoWork(input.output, input.runId)
  )
    return false;
  return null;
}

/** A declared no-work result is distinct from a daemon-verified produced artifact. */
export function goalNoWorkInstructions(runId: string): string {
  return `If this run required no action and you made no repository changes or external writes, return ONLY this JSON object as your final answer, replacing the reason with your finding: ${JSON.stringify({ paseo_goal_run: runId, outcome: "no_work", reason: "Explain why no action was needed" })}. Otherwise report the actual outcome or blocker normally; never use no_work for a failed or blocked attempt.`;
}
export function reportsGoalNoWork(output: string | null | undefined, runId: string): boolean {
  try {
    const value: unknown = JSON.parse(output ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const report = value as Record<string, unknown>;
    return (
      Object.keys(report).length === 3 &&
      report.paseo_goal_run === runId &&
      report.outcome === "no_work" &&
      typeof report.reason === "string" &&
      report.reason.trim().length > 0 &&
      report.reason.length <= 4000
    );
  } catch {
    return false;
  }
}

export function goalOutcomeSummary(
  output: string | null | undefined,
  runId: string,
  producedOutcome: boolean | null = null,
): string {
  if (producedOutcome === true) return output?.trim() || "Produced repository changes";
  if (reportsGoalNoWork(output, runId)) return `No work needed: ${JSON.parse(output!).reason}`;
  return output?.trim()
    ? `${output} (outcome unverified unless supported by an artifact)`
    : "No completion report; outcome unverified";
}

type GoalExecutionInput = Parameters<typeof executeCoordinatorGoal>[0];
interface NeverStartedWorker {
  id: string;
  cwd: string;
  workspaceId?: string | null;
}
async function cleanupNeverStartedGoalWorker(
  input: GoalExecutionInput,
  worker: NeverStartedWorker | undefined,
  minted: CreatePaseoWorktreeWorkflowResult | undefined,
  dispatched: boolean,
): Promise<void> {
  if (!worker || dispatched || input.agentManager.hasInFlightRun(worker.id)) return;
  try {
    const record = await input.agentStorage.get(worker.id);
    if (record?.lastUserMessageAt) return;
    await input.agentManager.archiveAgent(worker.id);
    if (
      !minted?.created ||
      minted.workspace.workspaceId !== worker.workspaceId ||
      minted.workspace.cwd !== worker.cwd ||
      !worker.workspaceId ||
      worker.workspaceId === input.owner.workspaceId ||
      worker.cwd === input.owner.cwd
    )
      return;
    await input.cleanupNeverStartedWorkspace?.({
      workerAgentId: worker.id,
      workspaceId: worker.workspaceId,
      cwd: worker.cwd,
    });
  } catch (err) {
    input.logger.warn({ err, agentId: worker.id }, "Could not clean up never-started goal worker");
  }
}
async function isAttributableGoalWorkspace(
  input: GoalExecutionInput,
  snapshot: ManagedAgent,
): Promise<boolean> {
  const current = input.agentManager.getAgent(snapshot.id);
  const stored = await input.agentStorage.get(snapshot.id);
  const owner = await input.agentStorage.get(input.owner.agentId);
  if (
    !current ||
    stored?.archivedAt ||
    owner?.archivedAt ||
    getParentAgentIdFromLabels(current.labels) !== input.owner.agentId ||
    current.cwd !== snapshot.cwd ||
    current.workspaceId !== snapshot.workspaceId ||
    current.cwd === input.owner.cwd ||
    current.workspaceId === input.owner.workspaceId
  )
    return false;
  const records = await input.agentStorage.list();
  if (
    records.some(
      (agent) =>
        agent.id !== current.id && agent.workspaceId === current.workspaceId && !agent.archivedAt,
    )
  )
    return false;
  return !input.agentManager
    .listAgents()
    .some((agent) => agent.id !== current.id && agent.workspaceId === current.workspaceId);
}
