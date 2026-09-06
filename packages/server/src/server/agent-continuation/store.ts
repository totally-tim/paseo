import { createHash } from "node:crypto";
import type { AgentQueuedMessageInput } from "../messages.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AgentContinuationPolicySchema,
  AgentContinuationStatusSchema,
} from "@getpaseo/protocol/agent-continuation";
import { AgentQueuedMessageSchema } from "../messages.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

const RecoverySchema = AgentContinuationStatusSchema.extend({
  operationId: z.string(),
  sourceAgentId: z.string(),
  eventId: z.string(),
  attempts: z.array(z.string()),
  resumeDispatch: z.enum(["dispatching", "started"]).optional(),
  backoffMs: z.number().optional(),
  /** The turn that Stop or Cancel wait fenced; a later turn may start a new episode. */
  cancelledTurnId: z.string().nullable().optional(),
});

const RecordSchema = z.object({
  rootAgentId: z.uuid(),
  agentId: z.uuid(),
  agentIds: z.array(z.uuid()),
  policy: AgentContinuationPolicySchema.optional(),
  recovery: RecoverySchema.nullable(),
  queue: z.array(AgentQueuedMessageSchema),
  receipts: z.record(
    z.string(),
    z.object({
      digest: z.string(),
      outcome: z.enum(["queued", "sent", "cancelled"]),
    }),
  ),
  queuePaused: z.boolean(),
  generation: z.number().int().nonnegative().default(0),
  /** When each former owner stopped owning the task, keyed by agent ID. */
  retired: z.record(z.string(), z.string()).default({}),
});
export type ContinuationRecord = z.infer<typeof RecordSchema>;
export type RecoveryState = z.infer<typeof RecoverySchema>;

export function newContinuationRecord(agentId: string): ContinuationRecord {
  return {
    rootAgentId: agentId,
    agentId,
    agentIds: [agentId],
    recovery: null,
    queue: [],
    receipts: {},
    queuePaused: false,
    generation: 0,
    retired: {},
  };
}

/** One atomic record owns the active agent, recovery decision, and queued work. */
export class AgentContinuationStore {
  private readonly directory: string;
  private readonly records = new Map<string, ContinuationRecord>();
  private readonly roots = new Map<string, string>();
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(paseoHome: string) {
    this.directory = path.join(paseoHome, "agent-continuations");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    for (const entry of await fs.readdir(this.directory)) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(this.directory, entry);
      let record: ContinuationRecord;
      try {
        record = RecordSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
        if (entry !== `${record.rootAgentId}.json`)
          throw new Error("Continuation record identity does not match its filename");
      } catch {
        // One unreadable record must not keep the daemon from starting. Keep the bytes for
        // inspection; the task simply has no continuation state until someone restores it.
        // A failed rename is not a reason to refuse startup either.
        await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined);
        continue;
      }
      this.publish(record);
    }
  }

  /** Delete retained attachment copies that no queued item references any more. */
  /**
   * Delete the copies this message held that nothing queued still points at. Runs on the same
   * per-task queue as every record write, so it always reads the committed queue: retained
   * paths are content-addressed, and two messages with the same bytes share one file.
   */
  releaseAttachments(rootAgentId: string, message: AgentQueuedMessageInput): Promise<void> {
    return this.serialize(rootAgentId, async () => {
      const directory = path.join(this.directory, rootAgentId);
      const referenced = new Set<string>();
      for (const item of this.records.get(rootAgentId)?.queue ?? [])
        for (const attachment of item.attachments ?? [])
          if (attachment.type === "uploaded_file") referenced.add(attachment.path);
      for (const attachment of message.attachments ?? []) {
        if (attachment.type !== "uploaded_file") continue;
        if (path.dirname(attachment.path) !== directory) continue;
        if (referenced.has(attachment.path)) continue;
        await fs.rm(attachment.path, { force: true });
      }
    });
  }

  /** Forget a task entirely, including its retained attachments. */
  async remove(rootAgentId: string): Promise<void> {
    await this.serialize(rootAgentId, async () => {
      const existing = this.records.get(rootAgentId);
      if (!existing) return;
      this.records.delete(rootAgentId);
      for (const id of existing.agentIds)
        if (this.roots.get(id) === rootAgentId) this.roots.delete(id);
      await fs.rm(path.join(this.directory, `${rootAgentId}.json`), { force: true });
      await fs.rm(path.join(this.directory, rootAgentId), { recursive: true, force: true });
    });
  }

  async retainAttachments(
    rootAgentId: string,
    message: AgentQueuedMessageInput,
  ): Promise<AgentQueuedMessageInput> {
    const retained = structuredClone(message);
    for (const attachment of retained.attachments ?? []) {
      if (attachment.type !== "uploaded_file") continue;
      const source = await fs.stat(attachment.path);
      if (!source.isFile() || source.size !== attachment.size || source.size > 32 * 1024 * 1024)
        throw new Error(
          "A queued attachment is missing, changed, or exceeds 32 MB. Attach the file again.",
        );
      const bytes = await fs.readFile(attachment.path);
      if (bytes.length !== attachment.size)
        throw new Error("The queued attachment changed while it was being retained.");
      const key = createHash("sha256")
        .update(JSON.stringify([message.id, attachment.id]))
        .update(bytes)
        .digest("hex");
      const directory = path.join(this.directory, rootAgentId);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = path.join(directory, key);
      try {
        await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await fs.chmod(destination, 0o600);
      attachment.path = destination;
    }
    return retained;
  }

  list(): ContinuationRecord[] {
    return structuredClone([...this.records.values()]);
  }

  forAgent(agentId: string): ContinuationRecord | undefined {
    const root = this.roots.get(agentId);
    const record = root ? this.records.get(root) : undefined;
    return record ? structuredClone(record) : undefined;
  }

  create(record: ContinuationRecord): Promise<ContinuationRecord> {
    return this.serialize(record.rootAgentId, async () => {
      const existing = this.records.get(record.rootAgentId);
      if (existing) return structuredClone(existing);
      await this.commit(record);
      return structuredClone(record);
    });
  }

  update(
    rootAgentId: string,
    mutate: (record: ContinuationRecord) => void,
  ): Promise<ContinuationRecord> {
    return this.serialize(rootAgentId, async () => {
      const existing = this.records.get(rootAgentId);
      if (!existing) throw new Error("Continuation record not found");
      const record = structuredClone(existing);
      mutate(record);
      await this.commit(record);
      return structuredClone(record);
    });
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  private async commit(record: ContinuationRecord): Promise<void> {
    const checked = RecordSchema.parse(record);
    const file = path.join(this.directory, `${checked.rootAgentId}.json`);
    await writeJsonFileAtomic(file, checked);
    await fs.chmod(file, 0o600);
    this.publish(checked);
  }

  private publish(record: ContinuationRecord): void {
    this.records.set(record.rootAgentId, record);
    for (const id of record.agentIds) this.roots.set(id, record.rootAgentId);
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writes.set(id, next);
    const cleanup = () => {
      if (this.writes.get(id) === next) this.writes.delete(id);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}
