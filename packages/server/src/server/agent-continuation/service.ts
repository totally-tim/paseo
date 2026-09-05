import { randomUUID } from "node:crypto";
import type {
  AgentContinuationSnapshot,
  AgentQueuedMessageInput,
  AgentQueueOperation,
} from "../messages.js";
import { AgentContinuationStatusSchema } from "@getpaseo/protocol/agent-continuation";
import type { ProviderAccountService } from "../provider-accounts/account-service.js";
import {
  handoffAgent,
  type HandoffDependencies,
  type HandoffExecution,
} from "../agent/handoff-agent.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { sendPromptToAgent, waitForAgentRunStartWithTimeout } from "../agent/agent-prompt.js";
import { buildAgentPrompt } from "../agent/prompt-attachments.js";
import { AgentContinuationStore, newContinuationRecord, type ContinuationRecord } from "./store.js";
import { updateQueuedMessages, checkQueuedMessage, messageDigest } from "./queue.js";
import { continuationSafetyError, isOrdinaryAgent } from "./safety.js";
import { HANDOFF_FROM_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

interface Dependencies extends HandoffDependencies {
  store: AgentContinuationStore;
  accounts: ProviderAccountService;
  now?: () => number;
  timers?: boolean;
}

/** One worker per task owns recovery, handoff, and queued delivery across all clients. */
export class AgentContinuationService {
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingCapacity = new Set<string>();
  private readonly listeners = new Set<(rootAgentId: string, agentId: string) => void>();
  private readonly now: () => number;
  private unsubscribe?: () => void;
  private closed = false;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await this.deps.store.initialize();
    for (const previous of this.deps.store.list()) {
      const storedAgent = await this.deps.agentStorage.get(previous.agentId);
      const ambiguous =
        (previous.queue.length > 0 && storedAgent?.lastStatus === "running") ||
        previous.queue.some((item) => item.status === "dispatching") ||
        previous.recovery?.resumeDispatch === "dispatching" ||
        (previous.recovery?.status === "active" && previous.recovery.resumeDispatch === "started");
      if (ambiguous)
        await this.change(previous.rootAgentId, (record) => {
          for (const item of record.queue)
            if (item.status === "dispatching") {
              item.status = "attention";
              item.error =
                "The host restarted during delivery. Inspect the conversation before resending.";
            }
          record.queuePaused = true;
          if (record.recovery)
            Object.assign(record.recovery, {
              status: "attention",
              reason: "The host restarted during a turn. Inspect its outcome before continuing.",
              updatedAt: this.timestamp(),
            });
        });
    }
    this.unsubscribe = this.deps.agentManager.subscribe(
      (event) => {
        if (this.closed) return;
        if (event.type === "agent_stream") {
          const item = event.event;
          if (
            item.type === "timeline" &&
            item.item.type === "notification" &&
            item.item.code === "provider_capacity"
          ) {
            // Set synchronously: a following terminal event must not drain the queue first.
            if (this.pendingCapacity.has(event.agentId)) return;
            this.pendingCapacity.add(event.agentId);
            void this.reportCapacity(
              event.agentId,
              `${event.epoch ?? "live"}:${event.seq ?? randomUUID()}`,
              item.turnId,
            )
              .catch(() =>
                this.deps.logger.error(
                  { agentId: event.agentId },
                  "Could not retain account recovery decision",
                ),
              )
              .finally(() => this.pendingCapacity.delete(event.agentId));
          } else if (item.type === "turn_completed") {
            this.background(event.agentId, () => this.completed(event.agentId));
          } else if (item.type === "turn_failed" && !this.pendingCapacity.has(event.agentId)) {
            this.background(event.agentId, () => this.failed(event.agentId));
          }
        }
        if (event.type === "agent_state" && event.agent.lifecycle === "idle")
          this.wake(event.agent.id);
      },
      { replayState: false },
    );
    for (const record of this.deps.store.list()) this.wake(record.agentId);
  }

  subscribe(listener: (rootAgentId: string, agentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled(this.jobs.values());
    await this.deps.store.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.jobs.values());
    await this.deps.store.flush();
  }

  statusFor(agentId: string) {
    const recovery = this.deps.store.forAgent(agentId)?.recovery;
    return recovery ? AgentContinuationStatusSchema.parse(recovery) : undefined;
  }

  async inspect(agentId: string): Promise<AgentContinuationSnapshot> {
    const record = await this.ensureRecord(agentId);
    return this.snapshot(record, agentId);
  }

  async manageQueue(
    agentId: string,
    operation: AgentQueueOperation,
  ): Promise<AgentContinuationSnapshot> {
    const initial = await this.ensureRecord(agentId);
    const enqueueDigest =
      operation.kind === "enqueue" ? messageDigest(operation.message) : undefined;
    const retry =
      operation.kind === "enqueue" && Object.hasOwn(initial.receipts, operation.message.id);
    if (!retry && (operation.kind === "enqueue" || operation.kind === "edit")) {
      checkQueuedMessage(operation.message);
      operation = {
        ...operation,
        message: await this.deps.store.retainAttachments(initial.rootAgentId, operation.message),
      };
    }
    const active = await this.deps.agentStorage.get(initial.agentId);
    if (!active || active.archivedAt) {
      if (operation.kind === "enqueue" && !retry)
        await this.deps.store.releaseAttachments(initial.rootAgentId, operation.message);
      throw new Error("Restore the task before changing its queue.");
    }
    let released: AgentQueuedMessageInput | null = null;
    let record: ContinuationRecord;
    try {
      record = await this.change(initial.rootAgentId, (current) => {
        if (operation.kind === "cancel") {
          const cancelled = current.queue.find((entry) => entry.id === operation.messageId);
          if (cancelled) released = structuredClone(cancelled);
        }
        const inserted = operation.kind === "enqueue" && !retry;
        updateQueuedMessages(current, operation, this.timestamp(), enqueueDigest);
        // A replayed acknowledgement inserts nothing and must not undo Stop.
        if (inserted || operation.kind === "send_now") current.queuePaused = false;
      });
    } catch (error) {
      if (operation.kind === "enqueue" && !retry)
        await this.deps.store.releaseAttachments(initial.rootAgentId, operation.message);
      throw error;
    }
    if (released) await this.deps.store.releaseAttachments(record.rootAgentId, released);
    if (operation.kind === "send_now") {
      // User-authorized interruption, still serialized with recovery and every other dispatch.
      await this.exclusive(record.rootAgentId, async () => {
        const current = this.deps.store.forAgent(agentId)!;
        // Claim the item under the lock: a concurrent Send now may already have sent it.
        const item = current.queue.find((entry) => entry.id === operation.messageId);
        if (!item || item.status !== "queued")
          throw new Error("This message is no longer queued. Refresh the conversation.");
        if (
          current.recovery &&
          ["continuing", "waiting", "attention"].includes(current.recovery.status)
        )
          throw new Error("Finish or cancel account recovery before sending queued work now.");
        if (this.deps.agentManager.getAgent(current.agentId)?.pendingPermissions.size)
          throw new Error("Resolve the pending permission before sending queued work now.");
        if (this.deps.agentManager.getAgent(current.agentId)) {
          const cancellation = await this.deps.agentManager.cancelAgentRun(current.agentId);
          if (cancellation.status === "refused")
            throw new Error(
              "The current turn did not acknowledge Stop. Inspect it before sending more work.",
            );
        }
        await this.change(current.rootAgentId, (value) => {
          value.queuePaused = false;
        });
        await this.drain(current.rootAgentId, operation.messageId);
      });
    } else this.wake(record.agentId);
    return this.snapshot(this.deps.store.forAgent(agentId)!, agentId);
  }

  /** Drop a deleted task's continuation state. A deleted predecessor keeps the successor's. */
  async forget(agentId: string): Promise<void> {
    const record = this.deps.store.forAgent(agentId);
    if (!record || record.agentId !== agentId) return;
    const timer = this.timers.get(record.rootAgentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(record.rootAgentId);
    await this.deps.store.remove(record.rootAgentId);
  }

  async cancelExisting(agentId: string): Promise<void> {
    let record = this.deps.store.forAgent(agentId);
    if (!record) {
      const source = await this.deps.agentStorage.get(agentId);
      if (!source?.config?.continuationPolicy || !isOrdinaryAgent(source)) return;
      record = await this.ensureRecord(agentId);
    }
    // A historical conversation no longer owns the running task.
    if (!record || record.agentId !== agentId) return;
    const live = this.deps.agentManager.getAgent(agentId);
    const cancelledTurnId = live?.activeForegroundTurnId ?? live?.activeTurnId ?? null;
    await this.change(record.rootAgentId, (current) => {
      current.queuePaused = true;
      current.generation += 1;
      if (!current.recovery && current.policy)
        current.recovery = this.recovery(current, randomUUID(), "cancel", []);
      if (current.recovery)
        Object.assign(current.recovery, {
          operationId: randomUUID(),
          status: "cancelled",
          reason: "Automatic continuation was cancelled.",
          updatedAt: this.timestamp(),
          nextCheckAt: undefined,
          cancelledTurnId,
        });
    });
    const timer = this.timers.get(record.rootAgentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(record.rootAgentId);
  }

  async cancelWorkspace(workspaceId: string): Promise<void> {
    for (const record of this.deps.store.list()) {
      const agent = await this.deps.agentStorage.get(record.agentId);
      if (agent?.workspaceId === workspaceId) await this.cancelExisting(record.agentId);
    }
  }

  assertPromptAllowed(agentId: string, operationId?: string): void {
    if (this.closed) throw new Error("The host is shutting down.");
    const record = this.deps.store.forAgent(agentId);
    if (!record) return;
    if (record.agentId !== agentId) throw new Error(`This task continued in ${record.agentId}.`);
    if (operationId?.startsWith("queue:")) {
      if (
        record.queuePaused ||
        !record.queue.some(
          (item) =>
            item.status === "dispatching" &&
            operationId === `queue:${record.generation}:${item.id}`,
        )
      )
        throw new Error("Queued delivery was stopped or replaced.");
      return;
    }
    if (operationId) {
      if (record.recovery?.operationId !== operationId || record.recovery.status === "cancelled")
        throw new Error("This continuation was cancelled or replaced.");
      return;
    }
    if (record.recovery && ["continuing", "waiting", "attention"].includes(record.recovery.status))
      throw new Error("Cancel account recovery or use Continue with before sending new work.");
  }

  async manualHandoff(
    agentId: string,
    run: (execution: HandoffExecution) => Promise<StoredAgentRecord>,
  ): Promise<StoredAgentRecord> {
    const initial = await this.ensureRecord(agentId);
    if (initial.agentId !== agentId) {
      const existing = await this.deps.agentStorage.getHandoff(agentId);
      if (!existing || existing.successorAgentId !== initial.agentId)
        throw new Error(`This task continued in ${initial.agentId}. Inspect it before retrying.`);
      if (existing.phase === "started") return run({});
      if (existing.phase === "dispatching")
        throw new Error(
          `Continuation ${existing.successorAgentId} already exists, but its prompt delivery is uncertain. Open it and check its history before sending more work.`,
        );
      // The successor exists but never received its briefing. Resume it under the task lock.
      return this.exclusive(initial.rootAgentId, async () => {
        const operationId = randomUUID();
        await this.change(initial.rootAgentId, (record) => {
          record.recovery = {
            ...this.recovery(record, operationId, "manual", []),
            sourceAgentId: agentId,
          };
        });
        return this.runOwned(initial.rootAgentId, operationId, run);
      });
    }
    await this.cancelExisting(initial.agentId);
    const generation = this.deps.store.forAgent(agentId)?.generation;
    return this.exclusive(initial.rootAgentId, async () => {
      const current = this.deps.store.forAgent(agentId)!;
      // A Stop that arrived while this request waited for the lock wins.
      if (current.generation !== generation)
        throw new Error("The continuation was cancelled before it started.");
      if (current.agentId !== agentId) {
        const existing = await this.deps.agentStorage.getHandoff(agentId);
        if (existing?.phase === "started") return run({});
        throw new Error(`This task already continued in ${current.agentId}.`);
      }
      const operationId = randomUUID();
      await this.change(initial.rootAgentId, (record) => {
        record.recovery = this.recovery(record, operationId, "manual", []);
      });
      return this.runOwned(initial.rootAgentId, operationId, run);
    });
  }

  private async runOwned(
    rootAgentId: string,
    operationId: string,
    run: (execution: HandoffExecution) => Promise<StoredAgentRecord>,
  ): Promise<StoredAgentRecord> {
    try {
      const successor = await run(this.execution(rootAgentId, operationId));
      await this.stopIfDisowned(rootAgentId, operationId);
      await this.activate(rootAgentId, operationId);
      return successor;
    } catch (error) {
      await this.attention(
        rootAgentId,
        operationId,
        "The continuation could not be confirmed. Inspect the source and successor before continuing.",
      );
      throw error;
    }
  }

  /**
   * Cancellation can land while a provider is still starting the dispatched turn. The manager's
   * guard ran before that await, so interrupt the turn now and say so if the interrupt fails.
   */
  private async stopIfDisowned(rootAgentId: string, operationId: string): Promise<void> {
    const record = this.deps.store.forAgent(rootAgentId);
    if (!record || record.recovery?.operationId === operationId) return;
    const live = this.deps.agentManager.getAgent(record.agentId);
    if (!live || !this.deps.agentManager.hasInFlightRun(record.agentId)) return;
    const cancellation = await this.deps.agentManager
      .cancelAgentRun(record.agentId)
      .catch(() => ({ status: "refused" as const }));
    if (cancellation.status !== "refused") return;
    await this.change(rootAgentId, (current) => {
      if (current.recovery?.status !== "cancelled") return;
      Object.assign(current.recovery, {
        status: "attention",
        reason:
          "Cancellation could not stop the continued turn. Inspect the conversation before continuing.",
        updatedAt: this.timestamp(),
      });
    });
  }

  async reportCapacity(agentId: string, eventId: string, turnId?: string): Promise<void> {
    const source = await this.deps.agentStorage.get(agentId);
    if (!source || !isOrdinaryAgent(source) || !source.config?.continuationPolicy) return;
    const record = await this.ensureRecord(agentId);
    // Stop fences the turn it interrupted. A rejection from a later turn is new work under the
    // same policy, so only a known, different turn may open the next episode.
    const fenced = (recovery: ContinuationRecord["recovery"]) =>
      recovery?.status === "cancelled" &&
      (turnId === undefined || recovery.cancelledTurnId === turnId);
    if (
      record.agentId !== agentId ||
      fenced(record.recovery) ||
      record.recovery?.eventId === eventId
    )
      return;
    const episode = record.recovery;
    if (episode?.status === "continuing" && episode.sourceAgentId === agentId) return;
    const attempts =
      episode && ["continuing", "active"].includes(episode.status) ? episode.attempts : [];
    const operationId = randomUUID();
    await this.change(record.rootAgentId, (current) => {
      if (current.agentId !== agentId || fenced(current.recovery)) return;
      current.policy = source.config!.continuationPolicy;
      current.recovery = this.recovery(current, operationId, eventId, [
        ...new Set([...attempts, ...(source.config?.accountId ? [source.config.accountId] : [])]),
      ]);
    });
    this.wake(agentId);
  }

  wake(agentId: string): void {
    this.background(agentId, async () => {
      const record = this.deps.store.forAgent(agentId);
      if (!record || this.closed) return;
      if (
        record.recovery?.status === "waiting" &&
        Date.parse(record.recovery.nextCheckAt ?? "") > this.now()
      ) {
        this.schedule(record);
      } else if (record.recovery && ["continuing", "waiting"].includes(record.recovery.status)) {
        await this.recover(record);
      } else await this.drain(record.rootAgentId);
    });
  }

  private async recover(record: ContinuationRecord): Promise<void> {
    const recovery = record.recovery!;
    const operationId = recovery.operationId;
    try {
      await this.assertCurrent(record.rootAgentId, operationId);
      if (await this.reconcileHandoff(record)) return;
      const source = await this.deps.agentStorage.get(record.agentId);
      if (!source || !isOrdinaryAgent(source)) {
        await this.cancelExisting(record.agentId);
        return;
      }
      const before = await continuationSafetyError(this.deps.agentManager, source.id, false);
      if (before) {
        await this.attention(record.rootAgentId, operationId, before);
        return;
      }
      await this.deps.agentManager.suspendForContinuation(source.id);
      await this.assertCurrent(record.rootAgentId, operationId);
      const after = await continuationSafetyError(this.deps.agentManager, source.id);
      if (after) {
        await this.attention(record.rootAgentId, operationId, after);
        return;
      }
      if (!record.policy) throw new Error("Missing continuation policy");
      const choice = await this.deps.accounts.recoveryChoice({
        provider: source.provider as "claude" | "codex",
        accountIds: record.policy.accountIds,
        model: source.config?.model ?? undefined,
        exclude: recovery.status === "waiting" ? [] : recovery.attempts,
      });
      await this.assertCurrent(record.rootAgentId, operationId);
      if (!choice.accountId) {
        await this.waitForCapacity(record, choice);
        return;
      }

      await this.change(record.rootAgentId, (current) => {
        if (current.recovery?.operationId !== operationId) return;
        Object.assign(current.recovery, {
          status: "continuing",
          nextCheckAt: undefined,
          attempts:
            recovery.status === "waiting"
              ? [choice.accountId!]
              : [...new Set([...recovery.attempts, choice.accountId!])],
        });
      });
      if (
        choice.accountId === source.config?.accountId &&
        !(await this.deps.agentStorage.getHandoff(source.id))
      ) {
        if (!source.persistence) {
          await this.attention(
            record.rootAgentId,
            operationId,
            "The original provider session cannot be resumed. Use Continue with to start a successor.",
          );
          return;
        }
        await this.change(record.rootAgentId, (current) => {
          if (current.recovery?.operationId === operationId)
            current.recovery.resumeDispatch = "dispatching";
        });
        await this.assertCurrent(record.rootAgentId, operationId);
        await sendPromptToAgent({
          ...this.deps,
          agentId: source.id,
          prompt:
            "Continue the interrupted task after the account capacity reset. Inspect the last action's outcome before repeating it. Preserve the user's task and constraints.",
          messageId: `continuation:${operationId}`,
          runOptions: { continuationOperationId: operationId },
          unarchive: false,
          clearPendingPermissions: false,
          replaceRunning: false,
        });
        await waitForAgentRunStartWithTimeout(this.deps.agentManager, source.id);
      } else {
        await this.switchAccount(record, source, choice.accountId);
      }
      await this.stopIfDisowned(record.rootAgentId, operationId);
      await this.activate(record.rootAgentId, operationId);
    } catch {
      await this.attention(
        record.rootAgentId,
        operationId,
        "Automatic continuation could not be confirmed. Inspect the conversation and tool outcomes before continuing.",
      );
    }
  }

  private async reconcileHandoff(record: ContinuationRecord): Promise<boolean> {
    const recovery = record.recovery!;
    const state = await this.deps.agentStorage.getHandoff(recovery.sourceAgentId);
    if (!state) return false;
    const successor = await this.deps.agentStorage.get(state.successorAgentId);
    if (successor)
      await this.execution(record.rootAgentId, recovery.operationId).onCreated!(successor);
    if (state.phase === "dispatching" || state.phase === "started") {
      await this.attention(
        record.rootAgentId,
        recovery.operationId,
        "The host restarted during continuation delivery. Inspect the successor's conversation before continuing.",
      );
      return true;
    }
    const accountId =
      state.config.accountId ??
      (state.config.accountSelection?.kind === "fixed"
        ? state.config.accountSelection.accountId
        : null);
    if (!accountId || !record.policy?.accountIds.includes(accountId)) {
      await this.attention(
        record.rootAgentId,
        recovery.operationId,
        "The prepared continuation no longer has a permitted account.",
      );
      return true;
    }
    const choice = await this.deps.accounts.recoveryChoice({
      provider: state.config.provider as "claude" | "codex",
      accountIds: [accountId],
      model: state.config.model,
    });
    await this.assertCurrent(record.rootAgentId, recovery.operationId);
    if (!choice.accountId) {
      await this.waitForCapacity(record, choice);
      return true;
    }
    await handoffAgent(
      this.deps,
      {
        sourceAgentId: state.sourceAgentId,
        provider: state.config.provider,
        accountSelection: { kind: "fixed", accountId },
        continuationPolicy: record.policy,
        model: state.config.model,
        modeId: state.config.modeId,
        thinkingOptionId: state.config.thinkingOptionId,
        featureValues: state.config.featureValues,
      },
      {
        ...this.execution(record.rootAgentId, recovery.operationId),
        unattended: true,
        preserveConfiguration: true,
      },
    );
    await this.activate(record.rootAgentId, recovery.operationId);
    return true;
  }

  private async switchAccount(
    record: ContinuationRecord,
    source: StoredAgentRecord,
    accountId: string,
  ): Promise<void> {
    const catalog = await this.deps.agentManager.getAccountCatalog({
      provider: source.provider as "claude" | "codex",
      selection: { kind: "fixed", accountId },
      cwd: source.cwd,
    });
    const model = source.runtimeInfo?.model ?? source.config?.model;
    if (!catalog.entry || (model && !catalog.entry.models?.some((entry) => entry.id === model)))
      throw new Error("The destination cannot confirm the current model.");
    await this.assertCurrent(record.rootAgentId, record.recovery!.operationId);
    await handoffAgent(
      this.deps,
      {
        sourceAgentId: source.id,
        provider: source.provider,
        accountSelection: { kind: "fixed", accountId },
        continuationPolicy: record.policy,
        model: model ?? undefined,
        modeId: source.lastModeId ?? source.config?.modeId ?? undefined,
        thinkingOptionId: source.config?.thinkingOptionId ?? undefined,
        featureValues: source.config?.featureValues ?? undefined,
      },
      {
        ...this.execution(record.rootAgentId, record.recovery!.operationId),
        unattended: true,
        preserveConfiguration: true,
      },
    );
  }

  private async waitForCapacity(
    record: ContinuationRecord,
    choice: Awaited<ReturnType<ProviderAccountService["recoveryChoice"]>>,
  ): Promise<void> {
    const recovery = record.recovery!;
    const operationId = recovery.operationId;
    if (choice.needsAttention) {
      await this.attention(record.rootAgentId, operationId, choice.reason);
      return;
    }
    const backoffMs = Math.min(300_000, Math.max(15_000, (recovery.backoffMs ?? 7_500) * 2));
    const next = choice.resetsAt
      ? Math.max(this.now() + 1_000, Date.parse(choice.resetsAt))
      : this.now() + backoffMs;
    const waiting = await this.change(record.rootAgentId, (current) => {
      if (current.recovery?.operationId !== operationId) return;
      Object.assign(current.recovery, {
        status: "waiting",
        reason: choice.reason,
        backoffMs,
        nextCheckAt: new Date(next).toISOString(),
        resetsAt: choice.resetsAt,
        updatedAt: this.timestamp(),
      });
    });
    this.schedule(waiting);
    return;
  }

  private execution(rootAgentId: string, operationId: string): HandoffExecution {
    return {
      operationId,
      assertCurrent: () => this.assertCurrent(rootAgentId, operationId),
      onCreated: async (successor) => {
        const sourceId = this.deps.store.forAgent(rootAgentId)?.recovery?.sourceAgentId;
        const source = sourceId ? await this.deps.agentStorage.get(sourceId) : null;
        await this.change(rootAgentId, (record) => {
          // Retain ownership even if Stop won during create, but never dispatch the successor.
          if (!record.agentIds.includes(successor.id)) record.agentIds.push(successor.id);
          const changed = record.agentId !== successor.id;
          if (changed) record.retired[record.agentId] = this.timestamp();
          record.agentId = successor.id;
          if (record.recovery)
            Object.assign(record.recovery, {
              agentId: successor.id,
              previousAgentId: record.recovery.sourceAgentId,
              previousAccountId: source?.config?.accountId,
              transitionedAt: changed ? this.timestamp() : record.recovery.transitionedAt,
              firstTransitionedAt: record.recovery.firstTransitionedAt ?? this.timestamp(),
              accountId: successor.config?.accountId,
            });
        });
      },
    };
  }

  private async activate(rootAgentId: string, operationId: string): Promise<void> {
    await this.change(rootAgentId, (record) => {
      if (record.recovery?.operationId !== operationId) return;
      Object.assign(record.recovery, {
        status: "active",
        resumeDispatch: "started",
        updatedAt: this.timestamp(),
        reason: "The task continued after an account capacity limit.",
      });
      record.queuePaused = false;
    });
  }

  private async completed(agentId: string): Promise<void> {
    const record = this.deps.store.forAgent(agentId);
    if (!record || record.agentId !== agentId || this.pendingCapacity.has(agentId)) return;
    if (record.recovery?.status === "active")
      await this.change(record.rootAgentId, (current) => {
        if (current.recovery?.status === "active") {
          current.recovery.attempts = [];
          current.recovery.resumeDispatch = undefined;
        }
      });
    await this.drain(record.rootAgentId);
  }

  private async failed(agentId: string): Promise<void> {
    const record = this.deps.store.forAgent(agentId);
    if (!record || record.agentId !== agentId) return;
    if (record.recovery?.status === "active")
      await this.attention(
        record.rootAgentId,
        record.recovery.operationId,
        "The continued turn failed. Inspect the conversation before continuing.",
      );
    await this.change(record.rootAgentId, (current) => {
      current.queuePaused = true;
    });
  }

  private async queueWorkspaceActive(agentId: string): Promise<boolean> {
    const source = await this.deps.agentStorage.get(agentId);
    if (!source || source.archivedAt || source.owner) return false;
    const workspace = source.workspaceId ? await this.deps.getWorkspace(source.workspaceId) : null;
    if (!workspace || workspace.archivedAt) {
      await this.cancelExisting(agentId);
      return false;
    }
    return true;
  }

  private async drain(rootAgentId: string, messageId?: string): Promise<void> {
    const record = this.deps.store.forAgent(rootAgentId);
    if (!record || this.closed || record.queuePaused || this.pendingCapacity.has(record.agentId))
      return;
    if (record.recovery && ["waiting", "continuing", "attention"].includes(record.recovery.status))
      return;
    const item = messageId ? record.queue.find((entry) => entry.id === messageId) : record.queue[0];
    if (!item || item.status !== "queued") return;
    const manager = this.deps.agentManager;
    const live = manager.getAgent(record.agentId);
    if (
      manager.hasInFlightRun(record.agentId) ||
      live?.lifecycle === "running" ||
      live?.pendingPermissions.size
    )
      return;
    if (!(await this.queueWorkspaceActive(record.agentId))) return;
    await this.change(rootAgentId, (current) => {
      if (current.queuePaused) throw new Error("Queue was stopped");
      const queued = current.queue.find((entry) => entry.id === item.id);
      if (!queued || queued.revision !== item.revision || queued.status !== "queued")
        throw new Error("Queue changed before dispatch");
      queued.status = "dispatching";
    });
    await this.dispatch(record, item);
  }

  private async dispatch(
    record: ContinuationRecord,
    item: ContinuationRecord["queue"][number],
  ): Promise<void> {
    const rootAgentId = record.rootAgentId;
    const manager = this.deps.agentManager;
    let dispatched = false;
    try {
      await sendPromptToAgent({
        ...this.deps,
        agentId: record.agentId,
        messageId: item.id,
        prompt: buildAgentPrompt(item.text, item.images, item.attachments),
        runOptions: { continuationOperationId: `queue:${record.generation}:${item.id}` },
        unarchive: false,
        clearPendingPermissions: false,
        replaceRunning: false,
      });
      dispatched = true;
      await waitForAgentRunStartWithTimeout(manager, record.agentId);
      await this.change(rootAgentId, (current) => {
        current.queue = current.queue.filter((entry) => entry.id !== item.id);
        current.receipts[item.id].outcome = "sent";
      });
    } catch {
      // The manager refuses to start over an in-flight run before it sends anything.
      const busy = !dispatched && manager.hasInFlightRun(record.agentId);
      await this.change(rootAgentId, (current) => {
        const queued = current.queue.find((entry) => entry.id === item.id);
        if (!queued) return;
        if (busy) {
          // Another caller's turn won the race; the instruction simply waits its turn.
          queued.status = "queued";
          return;
        }
        queued.status = "attention";
        queued.error =
          "Delivery could not be confirmed. Inspect the conversation before resending.";
        current.queuePaused = true;
      });
      return;
    }
    // Stop or Cancel wait may have landed while the provider was still starting the turn.
    const after = this.deps.store.forAgent(rootAgentId);
    if (after && (after.queuePaused || after.generation !== record.generation))
      await manager.cancelAgentRun(record.agentId).catch(() => undefined);
  }

  private async ensureRecord(agentId: string): Promise<ContinuationRecord> {
    const record = this.deps.store.forAgent(agentId);
    if (record) return record;
    const source = await this.deps.agentStorage.get(agentId);
    if (!source || source.internal || source.owner) throw new Error("Task not found");
    // A successor seen before onCreated links it belongs to its predecessor's task.
    const predecessor = source.labels[HANDOFF_FROM_AGENT_ID_LABEL];
    const inherited = predecessor ? this.deps.store.forAgent(predecessor) : undefined;
    if (inherited) return inherited;
    return this.deps.store.create({
      ...newContinuationRecord(agentId),
      policy: source.config?.continuationPolicy,
    });
  }

  private recovery(
    record: ContinuationRecord,
    operationId: string,
    eventId: string,
    attempts: string[],
  ): NonNullable<ContinuationRecord["recovery"]> {
    return {
      rootAgentId: record.rootAgentId,
      agentId: record.agentId,
      sourceAgentId: record.agentId,
      operationId,
      eventId,
      attempts,
      status: "continuing",
      updatedAt: this.timestamp(),
      previousAgentId: record.recovery?.previousAgentId,
      previousAccountId:
        record.recovery?.previousAccountId ??
        this.deps.agentManager.getAgent(record.agentId)?.config.accountId,
      accountId: record.recovery?.accountId,
      transitionedAt: record.recovery?.transitionedAt,
      firstTransitionedAt: record.recovery?.firstTransitionedAt,
      reason:
        eventId === "manual"
          ? "Continuing with the selected account"
          : "The provider confirmed an account capacity limit",
    };
  }

  private async assertCurrent(rootAgentId: string, operationId: string): Promise<void> {
    const record = this.deps.store.forAgent(rootAgentId);
    if (
      this.closed ||
      record?.recovery?.operationId !== operationId ||
      record.recovery.status === "cancelled"
    )
      throw new Error("Continuation no longer owns this task");
    const source = await this.deps.agentStorage.get(record.agentId);
    const workspace = source?.workspaceId ? await this.deps.getWorkspace(source.workspaceId) : null;
    if (!source || source.archivedAt || !workspace || workspace.archivedAt) {
      await this.cancelExisting(record.agentId);
      throw new Error("Task or workspace archived");
    }
  }

  private async attention(rootAgentId: string, operationId: string, reason: string): Promise<void> {
    await this.change(rootAgentId, (record) => {
      if (record.recovery?.operationId !== operationId) return;
      Object.assign(record.recovery, {
        status: "attention",
        reason,
        updatedAt: this.timestamp(),
        nextCheckAt: undefined,
      });
      record.queuePaused = true;
    });
  }

  private schedule(record: ContinuationRecord): void {
    if (this.closed || this.deps.timers === false || record.recovery?.status !== "waiting") return;
    const previous = this.timers.get(record.rootAgentId);
    if (previous) clearTimeout(previous);
    const delay = Math.min(
      2_147_483_647,
      Math.max(1_000, Date.parse(record.recovery.nextCheckAt ?? "") - this.now()),
    );
    const timer = setTimeout(() => {
      this.timers.delete(record.rootAgentId);
      this.wake(record.agentId);
    }, delay);
    timer.unref();
    this.timers.set(record.rootAgentId, timer);
  }

  private snapshot(record: ContinuationRecord, inspected: string): AgentContinuationSnapshot {
    return {
      rootAgentId: record.rootAgentId,
      agentId: record.agentId,
      continuation: record.recovery ? AgentContinuationStatusSchema.parse(record.recovery) : null,
      queuedMessages: record.queue,
      retiredAt: inspected === record.agentId ? null : (record.retired[inspected] ?? null),
    };
  }

  private async change(
    rootAgentId: string,
    mutate: (record: ContinuationRecord) => void,
  ): Promise<ContinuationRecord> {
    const record = await this.deps.store.update(rootAgentId, mutate);
    for (const listener of this.listeners) listener(record.rootAgentId, record.agentId);
    return record;
  }
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private background(agentId: string, run: () => Promise<void>): void {
    const record = this.deps.store.forAgent(agentId);
    if (!record || this.closed) return;
    void this.exclusive(record.rootAgentId, run).catch(() => {
      this.deps.logger.error({ agentId }, "Continuation worker could not persist its state");
    });
  }
  private exclusive<T>(rootAgentId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.jobs.get(rootAgentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.jobs.set(rootAgentId, next);
    const cleanup = () => {
      if (this.jobs.get(rootAgentId) === next) this.jobs.delete(rootAgentId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}
