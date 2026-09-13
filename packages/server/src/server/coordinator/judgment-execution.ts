import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent, type AgentRunObserver } from "../agent/agent-prompt.js";
import { GoalExecutionDeferred, type GoalExecutionOutcome } from "./automation.js";
import { goalNoWorkInstructions, reportsGoalNoWork, goalOutcomeSummary } from "./goal-execution.js";
import type { GoalRecord } from "./goals.js";

/** A judgment goal is one resident turn, with no implementer profile or child session. */
export async function executeCoordinatorJudgment(input: {
  goal: GoalRecord;
  runId: string;
  agentId: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  /** Checks enabled/current owner, pause, rotation, and explicit user Stop afresh. */
  assertStart: () => Promise<void>;
  /** Holds the owning project lock only until dispatch has reserved the provider run. */
  authorizeStart: <T>(dispatch: () => Promise<T>) => Promise<T | undefined>;
}): Promise<GoalExecutionOutcome> {
  if (input.goal.kind !== "judgment") throw new Error("Expected a judgment goal");
  let resolve!: (result: GoalExecutionOutcome) => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<GoalExecutionOutcome>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A fast provider can settle while dispatch is still releasing the project lock.
  void completed.catch(() => undefined);
  let started = false;
  let terminal: "completed" | "failed" | "canceled" | null = null;
  let failure = "Judgment turn ended without a completion event";
  let output = "";
  const observer: AgentRunObserver = {
    onEvent(event) {
      if (event.type === "turn_started") {
        started = true;
        terminal = null;
        output = "";
      }
      if (event.type === "timeline" && event.item.type === "assistant_message")
        output = event.item.text;
      if (event.type === "turn_completed") terminal = "completed";
      if (event.type === "turn_failed") {
        terminal = "failed";
        failure = event.error;
      }
      if (event.type === "turn_canceled") {
        terminal = "canceled";
        failure = event.reason;
      }
    },
    onSettled(error) {
      if (!started && input.agentManager.hasInFlightRun(input.agentId)) {
        reject(
          new GoalExecutionDeferred("Judgment goal deferred because the coordinator became busy"),
        );
      } else if (error || terminal !== "completed") {
        reject(error ?? new Error(failure));
      } else {
        resolve({
          agentId: input.agentId,
          output: goalOutcomeSummary(output, input.runId),
          producedOutcome: reportsGoalNoWork(output, input.runId) ? false : null,
        });
      }
    },
  };
  const assertAvailable = async () => {
    await input.assertStart();
    const record = await input.agentStorage.get(input.agentId);
    const agent = input.agentManager.getAgent(input.agentId);
    if (
      !agent ||
      agent.lifecycle === "closed" ||
      record?.archivedAt ||
      agent.pendingPermissions.size ||
      input.agentManager.hasInFlightRun(input.agentId)
    )
      throw new GoalExecutionDeferred(
        "Judgment goal deferred until the resident coordinator is idle",
      );
  };
  let dispatched;
  try {
    dispatched = await input.authorizeStart(async () => {
      await assertAvailable();
      return sendPromptToAgent({
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        agentId: input.agentId,
        logger: input.logger,
        prompt: `<paseo-system>\nCheck this approved judgment goal using your current project context:\n${input.goal.sentence}\nReport the outcome or explain why no action is needed.\n${goalNoWorkInstructions(input.runId)}\n</paseo-system>`,
        messageId: `goal:${input.goal.id}:run:${input.runId}`,
        replaceRunning: false,
        unarchive: false,
        runObserver: observer,
        backgroundRecovery: (recover) =>
          input.authorizeStart(async () => {
            await assertAvailable();
            return recover();
          }),
      });
    });
  } catch (error) {
    if (!started && input.agentManager.hasInFlightRun(input.agentId))
      throw new GoalExecutionDeferred("Judgment goal deferred because the coordinator became busy");
    throw error;
  }
  if (!dispatched)
    throw new GoalExecutionDeferred(
      "Judgment goal deferred because coordinator eligibility changed",
    );
  return completed;
}
