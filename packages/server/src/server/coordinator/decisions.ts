import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
} from "../agent/agent-sdk-types.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

export interface CoordinatorDecisionInput {
  callerAgentId: string;
  question: string;
  actions: Array<{ id: string; label: string; response: AgentPermissionResponse }>;
  defaultActionId?: string;
  timeoutMinutes?: number;
}
export interface CoordinatorDecisionResult {
  requestId: string;
}
export interface DecisionSettings {
  decisionTimeoutMinutes: number;
  digestEnabled: boolean;
  digestHour: number;
  quietStartHour: number;
  quietEndHour: number;
}
export const DEFAULT_DECISION_SETTINGS: DecisionSettings = {
  decisionTimeoutMinutes: 120,
  digestEnabled: true,
  digestHour: 8,
  quietStartHour: 22,
  quietEndHour: 7,
};
const ActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  response: AgentPermissionResponseSchema,
});
const RecordSchema = z.object({
  requestId: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  question: z.string(),
  actions: z.array(ActionSchema),
  defaultActionId: z.string().optional(),
  timeoutMinutes: z.number().positive(),
  deliveryAt: z.number(),
  deliveredAt: z.number().optional(),
  notificationSent: z.boolean().optional(),
  timeoutAt: z.number().optional(),
  answer: z.object({ actionId: z.string(), defaulted: z.boolean() }).optional(),
  completed: z.boolean().optional(),
});
type DecisionRecord = z.infer<typeof RecordSchema>;
const StateSchema = z.object({
  version: z.literal(1),
  decisions: z.array(RecordSchema),
  digestDate: z.string().optional(),
  silencedPermissions: z.array(z.string()).default([]),
});
type DecisionState = z.infer<typeof StateSchema>;
export interface DecisionDeps {
  paseoHome: string;
  now: () => number;
  settings: () => Promise<DecisionSettings>;
  eligible: (agentId: string) => Promise<{ projectId: string; provider: AgentProvider } | null>;
  register: (input: {
    agentId: string;
    request: AgentPermissionRequest;
    respond: (response: AgentPermissionResponse) => Promise<void>;
  }) => () => void;
  respond: (
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ) => Promise<unknown>;
  deliverAnswer: (record: DecisionRecord, text: string) => Promise<boolean>;
  digest: () => Promise<{ agentId: string; title: string; body: string } | null>;
  sendDecision?: (input: {
    agentId: string;
    title: string;
    body: string;
    request: AgentPermissionRequest;
  }) => Promise<void>;
  sendDigest?: (input: { agentId: string; title: string; body: string }) => Promise<void>;
}

export function nextDeliveryAt(
  now: number,
  settings: Pick<DecisionSettings, "quietStartHour" | "quietEndHour">,
): number {
  const date = new Date(now);
  const hour = date.getHours();
  const { quietStartHour: start, quietEndHour: end } = settings;
  if (start === end) return now;
  const quiet = start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!quiet) return now;
  if (start > end && hour >= start) date.setDate(date.getDate() + 1);
  date.setHours(end, 0, 0, 0);
  return date.getTime();
}
function dateKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Answers remain durable until queued into an idle coordinator. No timer infers a provider permission default. */
export class CoordinatorDecisions {
  private state: DecisionState | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly registered = new Map<string, () => void>();
  private readonly defaulting = new Set<string>();
  private readonly file: string;
  constructor(private readonly deps: DecisionDeps) {
    this.file = path.join(deps.paseoHome, "coordinator", "decisions.json");
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async load(): Promise<DecisionState> {
    if (this.state) return this.state;
    try {
      this.state = StateSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { version: 1, decisions: [], silencedPermissions: [] };
    }
    return this.state;
  }
  private async save(next: DecisionState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeJsonFileAtomic(this.file, StateSchema.parse(next));
    this.state = next;
  }
  owns(requestId: string): boolean {
    return this.state?.decisions.some((record) => record.requestId === requestId) ?? false;
  }
  raise(input: CoordinatorDecisionInput): Promise<CoordinatorDecisionResult> {
    return this.serialize(async () => {
      const owner = await this.deps.eligible(input.callerAgentId);
      if (!owner) throw new Error("Only an enabled resident coordinator can raise a decision");
      const actions = z.array(ActionSchema).min(1).max(8).parse(input.actions);
      if (!input.question.trim()) throw new Error("A decision needs a question");
      if (new Set(actions.map((action) => action.id)).size !== actions.length)
        throw new Error("Decision action IDs must be unique");
      if (input.defaultActionId && !actions.some((action) => action.id === input.defaultActionId))
        throw new Error("Default action must name a decision action");
      const settings = await this.deps.settings();
      const timeoutMinutes = z
        .number()
        .finite()
        .positive()
        .max(43_200)
        .parse(input.timeoutMinutes ?? settings.decisionTimeoutMinutes);
      const deliveryAt = nextDeliveryAt(this.deps.now(), settings);
      const record: DecisionRecord = {
        requestId: `coordinator-decision:${randomUUID()}`,
        agentId: input.callerAgentId,
        projectId: owner.projectId,
        question: input.question.trim(),
        actions,
        defaultActionId: input.defaultActionId,
        timeoutMinutes,
        deliveryAt,
        ...(input.defaultActionId ? { timeoutAt: deliveryAt + timeoutMinutes * 60_000 } : {}),
      };
      const state = await this.load();
      await this.save({ ...state, decisions: [...state.decisions, record] });
      await this.register(record, true);
      return { requestId: record.requestId };
    });
  }
  private async register(record: DecisionRecord, locked = false): Promise<void> {
    if (!locked) return this.serialize(() => this.register(record, true));
    record = this.state?.decisions.find((item) => item.requestId === record.requestId) ?? record;
    if (
      record.answer ||
      this.registered.has(record.requestId) ||
      record.deliveryAt > this.deps.now()
    )
      return;
    const owner = await this.deps.eligible(record.agentId);
    if (!owner) return;
    if (record.deliveredAt === undefined) {
      const deliveredAt = this.deps.now();
      record = {
        ...record,
        deliveredAt,
        ...(record.defaultActionId
          ? { timeoutAt: deliveredAt + record.timeoutMinutes * 60_000 }
          : {}),
      };
      const updated = record;
      await this.save({
        ...this.state!,
        decisions: this.state!.decisions.map((item) =>
          item.requestId === updated.requestId ? updated : item,
        ),
      });
    }
    const defaultAction = record.actions.find((action) => action.id === record.defaultActionId);
    const request: AgentPermissionRequest = {
      id: record.requestId,
      provider: owner.provider,
      name: "coordinator_decision",
      kind: "question",
      title: record.question,
      requestedAt: new Date(record.deliveredAt ?? record.deliveryAt).toISOString(),
      metadata: { coordinatorDecision: true },
      actions: record.actions.map((action) => ({
        id: action.id,
        label: action.label,
        behavior: action.response.behavior,
        response: { ...action.response, selectedActionId: action.id },
      })),
      ...(record.timeoutAt && defaultAction
        ? {
            timeoutAt: new Date(record.timeoutAt).toISOString(),
            defaultAnswer: { ...defaultAction.response, selectedActionId: defaultAction.id },
          }
        : {}),
    };
    this.registered.set(
      record.requestId,
      this.deps.register({
        agentId: record.agentId,
        request,
        respond: (response) => this.answer(record.requestId, response),
      }),
    );
    if (!record.notificationSent && this.deps.sendDecision) {
      const notified = { ...record, notificationSent: true };
      await this.save({
        ...this.state!,
        decisions: this.state!.decisions.map((item) =>
          item.requestId === record.requestId ? notified : item,
        ),
      });
      await this.deps.sendDecision({
        agentId: record.agentId,
        title: "Coordinator decision",
        body: record.question,
        request,
      });
    }
  }

  silencePermission(key: string): Promise<void> {
    return this.serialize(async () => {
      const state = await this.load();
      if (state.silencedPermissions.includes(key)) return;
      await this.save({ ...state, silencedPermissions: [...state.silencedPermissions, key] });
    });
  }

  notifyStalledPermission(
    key: string,
    input: { agentId: string; title: string; body: string; request: AgentPermissionRequest },
  ): Promise<void> {
    return this.serialize(async () => {
      const state = await this.load();
      if (!this.deps.sendDecision || state.silencedPermissions.includes(key)) return;
      const now = this.deps.now();
      if (nextDeliveryAt(now, await this.deps.settings()) !== now) return;
      // Both a sent push and Leave it silence this exact provider request across restart.
      await this.save({ ...state, silencedPermissions: [...state.silencedPermissions, key] });
      await this.deps.sendDecision(input);
    });
  }

  private answer(requestId: string, response: AgentPermissionResponse): Promise<void> {
    // Called from the manager's response transaction; tick never holds the state lock while responding.
    return this.serialize(async () => {
      const state = await this.load();
      const record = state.decisions.find((item) => item.requestId === requestId);
      if (!record || record.answer) throw new Error("Decision is already answered");
      const action = record.actions.find((item) => item.id === response.selectedActionId);
      if (!action || action.response.behavior !== response.behavior)
        throw new Error("Choose one of this decision's actions");
      await this.save({
        ...state,
        decisions: state.decisions.map((item) =>
          item.requestId === requestId
            ? Object.assign({}, item, {
                answer: { actionId: action.id, defaulted: this.defaulting.has(requestId) },
              })
            : item,
        ),
      });
      this.registered.delete(requestId);
    });
  }
  private ticking: Promise<void> | null = null;
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }
  private async runTick(): Promise<void> {
    await this.load();
    for (let record of this.state!.decisions) {
      if (!(await this.deps.eligible(record.agentId))) continue;
      await this.register(record);
      record = this.state!.decisions.find((item) => item.requestId === record.requestId)!;
      if (!record.answer && record.defaultActionId && record.timeoutAt! <= this.deps.now()) {
        const action = record.actions.find((item) => item.id === record.defaultActionId)!;
        this.defaulting.add(record.requestId);
        try {
          await this.deps.respond(record.agentId, record.requestId, {
            ...action.response,
            selectedActionId: action.id,
          });
        } finally {
          this.defaulting.delete(record.requestId);
        }
      }
      const current = this.state!.decisions.find((item) => item.requestId === record.requestId)!;
      if (!current.answer || current.completed) continue;
      const action = current.actions.find((item) => item.id === current.answer!.actionId)!;
      const duration =
        current.timeoutMinutes % 60 === 0
          ? `${current.timeoutMinutes / 60}h`
          : `${current.timeoutMinutes}m`;
      const text = `Answered ${current.question}: ${action.label}${current.answer.defaulted ? ` (default after ${duration})` : ""}`;
      if (await this.deps.deliverAnswer(current, text))
        await this.serialize(async () => {
          await this.save({
            ...this.state!,
            decisions: this.state!.decisions.map((item) =>
              item.requestId === current.requestId
                ? Object.assign({}, item, { completed: true })
                : item,
            ),
          });
        });
    }
    const now = this.deps.now();
    const settings = await this.deps.settings();
    const date = new Date(now);
    date.setHours(settings.digestHour, 0, 0, 0);
    const digestAt = nextDeliveryAt(date.getTime(), settings);
    if (
      !settings.digestEnabled ||
      !this.deps.sendDigest ||
      now < digestAt ||
      nextDeliveryAt(now, settings) !== now ||
      this.state!.digestDate === dateKey(now)
    )
      return;
    const digest = await this.deps.digest();
    if (!digest) return;
    // Commit before the external send: a restart must not duplicate the daily notification.
    await this.serialize(() => this.save({ ...this.state!, digestDate: dateKey(now) }));
    await this.deps.sendDigest(digest);
  }
  async stop(): Promise<void> {
    await this.ticking;
    await this.tail;
    for (const unregister of this.registered.values()) unregister();
    this.registered.clear();
  }
}
