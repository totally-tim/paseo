import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AccountSelectionSchema } from "@getpaseo/protocol/provider-accounts";
import { AgentContinuationPolicySchema } from "@getpaseo/protocol/agent-continuation";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  createCoordinatorHandoff,
  type HandoffDependencies,
  type HandoffAgentInput,
} from "../agent/handoff-agent.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { CapacityRecoveryTrigger } from "../agent-continuation/capacity-trigger.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

const RotationRecordSchema = z.object({
  sourceAgentId: z.string(),
  successorAgentId: z.string().optional(),
  reason: z.enum(["context", "capacity"]),
  phase: z.enum(["moving", "active"]),
  input: z.object({
    sourceAgentId: z.string(),
    accountSelection: AccountSelectionSchema.optional(),
    continuationPolicy: AgentContinuationPolicySchema.optional(),
    provider: z.string(),
    model: z.string().optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    briefing: z.string().optional(),
  }),
});
export type RotationRecord = z.infer<typeof RotationRecordSchema>;
export interface CoordinatorRotationDeps extends HandoffDependencies {
  paseoHome: string;
  authorize: (sourceAgentId: string, successorAgentId?: string) => Promise<boolean>;
  commitOwner: (sourceAgentId: string, successor: StoredAgentRecord) => Promise<void>;
  onAttention?: (record: RotationRecord, error: unknown) => Promise<void>;
  onRotated: (record: RotationRecord) => Promise<void>;
  schedules: () => {
    retargetAgent(sourceAgentId: string, successorAgentId: string): Promise<void>;
  };
  retargetDecisions: (sourceAgentId: string, successorAgentId: string) => Promise<void>;
}

/** Topology journal only: provider creation and prompt receipt remain in the existing handoff journal. */
export class CoordinatorRotation {
  private stopped = false;
  private records: RotationRecord[] = [];
  private readonly jobs = new Map<string, Promise<StoredAgentRecord>>();
  private readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private rotationTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: CoordinatorRotationDeps) {
    this.file = path.join(deps.paseoHome, "coordinator", "rotations.json");
  }
  async initialize(): Promise<void> {
    try {
      this.records = z
        .array(RotationRecordSchema)
        .parse(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  isProtectedAgentTarget(agentId: string): boolean {
    return this.records.some(
      (record) =>
        record.phase === "moving" &&
        (record.sourceAgentId === agentId || record.successorAgentId === agentId),
    );
  }
  notificationQueueTarget(agentId: string): string {
    return (
      this.records.find(
        (record) =>
          record.phase === "moving" &&
          (record.sourceAgentId === agentId || record.successorAgentId === agentId),
      )?.sourceAgentId ?? agentId
    );
  }
  async resume(): Promise<void> {
    for (const record of this.records.filter((entry) => entry.phase === "moving")) {
      if (!(await this.deps.authorize(record.sourceAgentId, record.successorAgentId))) continue;
      try {
        await this.rotate({
          sourceAgentId: record.sourceAgentId,
          profile: record.input,
          briefing: record.input.briefing,
          reason: record.reason,
        });
      } catch (error) {
        await this.deps.onAttention?.(record, error);
        this.deps.logger.warn(
          { err: error, sourceAgentId: record.sourceAgentId },
          "Coordinator rotation needs attention",
        );
      }
    }
  }
  rotate(input: {
    sourceAgentId: string;
    profile: Omit<HandoffAgentInput, "sourceAgentId">;
    briefing?: string;
    reason: "context" | "capacity";
  }): Promise<StoredAgentRecord> {
    if (this.stopped) return Promise.reject(new Error("Coordinator rotation is stopped"));
    const existing = this.jobs.get(input.sourceAgentId);
    if (existing) return existing;
    // A parent and its project may rotate concurrently. Serialize the entire operation,
    // so the later source/config snapshot sees the earlier topology and final owner.
    const run = this.rotationTail.then(() => {
      if (this.stopped) throw new Error("Coordinator rotation is stopped");
      return this.run(input);
    });
    const job = run.finally(() => this.jobs.delete(input.sourceAgentId));
    this.rotationTail = job.catch(() => undefined);
    this.jobs.set(input.sourceAgentId, job);
    return job;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.jobs.values());
    await this.tail;
  }
  private async save(record: RotationRecord): Promise<void> {
    const job = this.tail.then(async () => {
      const records = this.records.filter((entry) => entry.sourceAgentId !== record.sourceAgentId);
      records.push(record);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeJsonFileAtomic(this.file, records);
      this.records = records;
      return;
    });
    this.tail = job.catch(() => undefined);
    await job;
  }
  private async run(input: {
    sourceAgentId: string;
    profile: Omit<HandoffAgentInput, "sourceAgentId">;
    briefing?: string;
    reason: "context" | "capacity";
  }): Promise<StoredAgentRecord> {
    let record = this.records.find((entry) => entry.sourceAgentId === input.sourceAgentId);
    if (!(await this.deps.authorize(input.sourceAgentId, record?.successorAgentId)))
      throw new Error("Coordinator rotation is no longer authorized");
    record ??= {
      sourceAgentId: input.sourceAgentId,
      reason: input.reason,
      phase: "moving",
      input: { ...input.profile, sourceAgentId: input.sourceAgentId, briefing: input.briefing },
    };
    await this.save(record);
    const handoff = createCoordinatorHandoff(
      this.deps,
      async (source, successor) => !this.stopped && (await this.deps.authorize(source, successor)),
    );
    const successor = await handoff(record.input, {
      onPrepared: async (state) => {
        record = { ...record!, successorAgentId: state.successorAgentId };
        await this.save(record);
      },
      onCreated: async (created) => {
        for (const child of await this.deps.agentStorage.list()) {
          if (child.archivedAt || child.labels[PARENT_AGENT_ID_LABEL] !== input.sourceAgentId)
            continue;
          // Metadata mutation uses the lifecycle lane for both live and unloaded children;
          // writing the earlier whole snapshot could resurrect a concurrently archived child.
          await this.deps.agentManager.updateAgentMetadata(child.id, {
            labels: { [PARENT_AGENT_ID_LABEL]: created.id },
          });
        }
        await this.deps.schedules().retargetAgent(input.sourceAgentId, created.id);
        await this.deps.retargetDecisions(input.sourceAgentId, created.id);
        await this.deps.commitOwner(input.sourceAgentId, created);
      },
    });
    record = { ...record, phase: "active", successorAgentId: successor.id };
    await this.deps.onRotated(record);
    await this.save(record);
    return successor;
  }
}

export class CoordinatorRotationTrigger {
  private readonly capacity = new CapacityRecoveryTrigger();
  private readonly context = new Set<string>();
  observe(
    agentId: string,
    event: AgentStreamEvent,
    options: {
      thresholdPercent?: number;
      foregroundTurnId?: string;
      eventId?: string;
    },
  ): "context" | "capacity" | null {
    if (
      this.capacity.observe(
        agentId,
        event,
        options.eventId ?? ("turnId" in event ? event.turnId : undefined) ?? agentId,
        options.foregroundTurnId,
      )
    )
      return "capacity";
    const usage =
      event.type === "usage_updated" || event.type === "turn_completed" ? event.usage : undefined;
    const maximum = usage?.contextWindowMaxTokens;
    if (
      !this.context.has(agentId) &&
      maximum &&
      maximum > 0 &&
      (usage?.contextWindowUsedTokens ?? 0) / maximum >= (options.thresholdPercent ?? 60) / 100
    ) {
      this.context.add(agentId);
      return "context";
    }
    return null;
  }
  clear(agentId: string): void {
    this.context.delete(agentId);
    this.capacity.clear(agentId);
  }
}
