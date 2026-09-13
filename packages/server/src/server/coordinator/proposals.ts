import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  CoordinatorProposalSchema,
  CoordinatorProposalPayloadSchema,
  type CoordinatorProposal,
} from "@getpaseo/protocol/coordinator-goals";
import { AutomationStore } from "./automation-store.js";
import { parseGoalRule } from "./goals.js";
import { validatePolicyPattern } from "./policy.js";

const StoredProposalSchema = CoordinatorProposalSchema.extend({ fingerprint: z.string() });
const StateSchema = z.object({ proposals: z.array(StoredProposalSchema) });
export interface CoordinatorProposalInput {
  sourceAgentId: string;
  projectIds: string[];
  sentence: string;
  evidence?: CoordinatorProposal["evidence"];
  payload: CoordinatorProposal["payload"];
}
export class CoordinatorProposals {
  private readonly store: AutomationStore<z.infer<typeof StateSchema>>;
  private applyTail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly deps: {
      paseoHome: string;
      now: () => number;
      /** Idempotent by proposal ID: approval is durable before this callback can run. */
      apply: (proposal: CoordinatorProposal) => Promise<void>;
    },
  ) {
    this.store = new AutomationStore(
      path.join(deps.paseoHome, "coordinator", "proposals.json"),
      StateSchema,
      () => ({ proposals: [] }),
    );
  }
  async initialize(): Promise<void> {
    await this.store.read();
  }
  async list(projectId?: string): Promise<CoordinatorProposal[]> {
    return (await this.store.read()).proposals.filter(
      (proposal) => !projectId || proposal.projectIds.includes(projectId),
    );
  }
  private prepare(input: CoordinatorProposalInput): z.infer<typeof StoredProposalSchema> {
    const payload = CoordinatorProposalPayloadSchema.parse(input.payload);
    if (payload.kind === "goal") parseGoalRule(payload.ruleYaml);
    if (payload.kind === "policy") payload.pattern = validatePolicyPattern(payload.pattern);
    if (!input.projectIds.length && !(payload.kind === "policy" && payload.scope === "daemon"))
      throw new Error("Choose at least one project");
    const projectIds = [...new Set(input.projectIds)].sort();
    const fingerprintPayload =
      payload.kind === "goal" ? { kind: "goal", rule: parseGoalRule(payload.ruleYaml) } : payload;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ projectIds, payload: fingerprintPayload }))
      .digest("hex");
    return StoredProposalSchema.parse({
      ...input,
      evidence: input.evidence ?? [],
      payload,
      projectIds,
      fingerprint,
      id: randomUUID(),
      status: "pending",
      createdAt: new Date(this.deps.now()).toISOString(),
    });
  }
  async propose(input: CoordinatorProposalInput): Promise<CoordinatorProposal | null> {
    const proposal = this.prepare(input);
    return this.store.change((state) => {
      const previous = state.proposals.findLast(
        (entry) => entry.fingerprint === proposal.fingerprint && entry.status !== "superseded",
      );
      if (previous?.status === "ignored" && Date.parse(previous.ignoredUntil!) > this.deps.now())
        return null;
      if (previous && ["pending", "approved"].includes(previous.status))
        return structuredClone(previous);
      state.proposals.push(proposal);
      return proposal;
    });
  }
  async edit(proposalId: string, input: CoordinatorProposalInput): Promise<CoordinatorProposal> {
    const replacement = this.prepare(input);
    return this.store.change((state) => {
      const previous = state.proposals.find((entry) => entry.id === proposalId);
      if (!previous || previous.status !== "pending")
        throw new Error("Only pending proposals can be edited");
      previous.status = "superseded";
      state.proposals.push(replacement);
      return replacement;
    });
  }
  /** Verified late evidence invalidates only pending automatic pause suggestions. */
  async supersedePauseSuggestions(projectId: string, goalId: string): Promise<void> {
    await this.store.change((state) => {
      for (const proposal of state.proposals)
        if (
          proposal.status === "pending" &&
          proposal.projectIds.length === 1 &&
          proposal.projectIds[0] === projectId &&
          proposal.payload.kind === "pause_goal" &&
          proposal.payload.goalId === goalId
        )
          proposal.status = "superseded";
    });
  }
  async ignore(proposalId: string): Promise<void> {
    await this.store.change((state) => {
      const proposal = state.proposals.find((entry) => entry.id === proposalId);
      if (!proposal || proposal.status !== "pending")
        throw new Error("Only pending proposals can be ignored");
      proposal.status = "ignored";
      proposal.ignoredUntil = new Date(this.deps.now() + 30 * 86400000).toISOString();
    });
  }
  async approve(proposalId: string): Promise<void> {
    await this.store.change((state) => {
      const proposal = state.proposals.find((entry) => entry.id === proposalId);
      if (!proposal || !["pending", "approved"].includes(proposal.status))
        throw new Error("Proposal cannot be approved");
      proposal.status = "approved";
      proposal.approvedAt ??= new Date(this.deps.now()).toISOString();
    });
    await this.reconcile();
  }
  reconcile(): Promise<void> {
    const job = this.applyTail.then(async () => {
      let firstError: unknown;
      for (const proposal of (await this.store.read()).proposals) {
        if (proposal.status !== "approved" || proposal.appliedAt) continue;
        try {
          await this.deps.apply(proposal);
          await this.store.change((state) => {
            const current = state.proposals.find((entry) => entry.id === proposal.id)!;
            current.appliedAt = new Date(this.deps.now()).toISOString();
            delete current.error;
          });
        } catch (error) {
          await this.store.change((state) => {
            state.proposals.find((entry) => entry.id === proposal.id)!.error =
              error instanceof Error ? error.message : String(error);
          });
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
      return;
    });
    this.applyTail = job.catch(() => undefined);
    return job;
  }
}
