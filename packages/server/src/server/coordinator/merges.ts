import { MergePolicyUnavailableError } from "./committed-policy.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CoordinatorTrustLevel } from "@getpaseo/protocol/messages";
import type { ForgeService } from "../../services/forge-service.js";
import { AutomationStore } from "./automation-store.js";
import {
  capCoordinatorTrust,
  loadMergePolicy,
  mergeCoordinatorPullRequest,
  type MergePolicyState,
} from "./merge-policy.js";

export interface MergeActor {
  projectId: string;
  coordinatorAgentId: string;
  trustLevel: CoordinatorTrustLevel;
  cwd: string;
  workspaceId: string;
  kind: "coordinator" | "reviewer" | "other";
}
export interface CoordinatorMergesDeps {
  paseoHome: string;
  now: () => number;
  resolveActor: (agentId: string) => Promise<MergeActor>;
  resolveForge: (
    cwd: string,
  ) => Promise<Pick<ForgeService, "getPullRequestMergeFacts" | "mergePullRequest">>;
  ensurePolicyCommit?: (cwd: string, sha: string) => Promise<void>;
  policyBase: (projectId: string) => Promise<{ cwd: string; baseSha: string }>;
  workspaceForHead: (
    projectId: string,
    head: string,
  ) => Promise<{ workspaceId: string; cwd: string } | null>;
  authorizeMerge: <T>(
    projectId: string,
    coordinatorAgentId: string,
    run: () => Promise<T>,
  ) => Promise<T | undefined>;
  appendDone: (
    projectId: string,
    text: string,
    refs: { agentId: string; artifactUrl: string },
    dedupe: string,
  ) => Promise<void>;
  authorizeRecovery?: <T>(projectId: string, run: () => Promise<T>) => Promise<T | undefined>;
  archiveWorkspace: (
    workspaceId: string,
    expected: { projectId: string; head: string; cwd?: string },
  ) => Promise<void>;
  attention: (projectId: string, reason: string, dedupe: string) => Promise<void>;
}
const Sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const OriginSchema = z.object({
  projectId: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  cwd: z.string(),
  workspaceId: z.string(),
  workspaceCwd: z.string().optional(),
  head: z.string(),
  createdHeadSha: Sha,
  callerAgentId: z.string(),
  reviewerAgentId: z.string(),
  createdAt: z.string(),
});
const StateSchema = z.object({
  policyCaps: z
    .array(
      z.object({ projectId: z.string(), cap: z.enum(["observe", "propose", "ship", "autopilot"]) }),
    )
    .default([]),
  origins: z.array(OriginSchema),
  reviews: z.array(
    z.object({
      projectId: z.string(),
      reviewerAgentId: z.string(),
      headSha: Sha,
      passed: z.boolean(),
      recordedAt: z.string(),
    }),
  ),
  merges: z.array(
    z.object({
      projectId: z.string(),
      number: z.number(),
      headSha: Sha,
      state: z.enum(["merging", "merged", "done", "archived"]),
      authorizedBaseSha: Sha.optional(),
      policyFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      putConfirmed: z.boolean().optional(),
      startedAt: z.string(),
    }),
  ),
});
export interface CoordinatorCreatedPullRequest {
  callerAgentId: string;
  reviewerAgentId: string;
  cwd: string;
  number: number;
  url: string;
  head: string;
}

/** Provenance and review verdicts are daemon records, never inferred from conversation text. */
export type ProjectMergePolicyState = MergePolicyState & { unavailable?: boolean };

export class CoordinatorMerges {
  private readonly policyRefreshIds = new Map<string, number>();
  private readonly policySnapshots = new Map<string, ProjectMergePolicyState>();
  private readonly store: AutomationStore<z.infer<typeof StateSchema>>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: CoordinatorMergesDeps) {
    this.store = new AutomationStore(
      path.join(deps.paseoHome, "coordinator", "merges.json"),
      StateSchema,
      () => ({ policyCaps: [], origins: [], reviews: [], merges: [] }),
    );
  }
  async initialize(): Promise<void> {
    await this.store.read();
  }
  cachedProjectPolicy(projectId: string): ProjectMergePolicyState | undefined {
    return this.policySnapshots.get(projectId);
  }
  async lastVerifiedCap(projectId: string): Promise<CoordinatorTrustLevel | undefined> {
    return (await this.store.read()).policyCaps.find((entry) => entry.projectId === projectId)?.cap;
  }
  async projectPolicy(projectId: string): Promise<ProjectMergePolicyState> {
    const refreshId = (this.policyRefreshIds.get(projectId) ?? 0) + 1;
    this.policyRefreshIds.set(projectId, refreshId);
    let result: ProjectMergePolicyState;
    try {
      const base = await this.deps.policyBase(projectId);
      result = await loadMergePolicy(base.cwd, base.baseSha);
    } catch (error) {
      result = {
        policy: null,
        reason: String(error),
        ...(error instanceof MergePolicyUnavailableError ? { unavailable: true } : {}),
      };
    }
    if (this.policyRefreshIds.get(projectId) !== refreshId) return result;
    this.policySnapshots.set(projectId, result);
    if (!result.unavailable)
      await this.store.change((state) => {
        const cap = result.policy?.max_trust_level ?? "ship";
        const existing = state.policyCaps.find((entry) => entry.projectId === projectId);
        if (existing) existing.cap = cap;
        else state.policyCaps.push({ projectId, cap });
      });
    return result;
  }
  async capTrust(
    projectId: string,
    requested: CoordinatorTrustLevel,
  ): Promise<CoordinatorTrustLevel> {
    const state = await this.projectPolicy(projectId);
    if (state.unavailable)
      return capCoordinatorTrust(requested, {
        policy: null,
        reason: state.reason ?? "Policy unavailable",
      });
    const capped = capCoordinatorTrust(requested, state);
    if (requested === "autopilot" && !state.policy)
      await this.policyAttention(projectId, state.reason);
    return capped;
  }
  private async policyAttention(projectId: string, reason: string): Promise<void> {
    await this.deps.attention(
      projectId,
      `Autopilot is unavailable: ${reason}`,
      `merge-policy:${projectId}:${createHash("sha256").update(reason).digest("hex").slice(0, 16)}`,
    );
  }
  async recordReview(input: {
    callerAgentId: string;
    headSha: string;
    passed: boolean;
  }): Promise<void> {
    return this.serial(async () => {
      const actor = await this.deps.resolveActor(input.callerAgentId);
      if (actor.kind !== "reviewer")
        throw new Error("Only the independent reviewer may submit its verdict");
      const headSha = Sha.parse(input.headSha);
      await this.store.change((state) => {
        const prior = state.reviews.find(
          (review) =>
            review.projectId === actor.projectId &&
            review.reviewerAgentId === input.callerAgentId &&
            review.headSha === headSha,
        );
        const next = {
          projectId: actor.projectId,
          reviewerAgentId: input.callerAgentId,
          headSha,
          passed: input.passed,
          recordedAt: new Date(this.deps.now()).toISOString(),
        };
        if (prior) Object.assign(prior, next);
        else state.reviews.push(next);
      });
    });
  }
  /** Called only after the forge confirmed create. Failure leaves the successful PR result intact. */
  async recordCreated(input: CoordinatorCreatedPullRequest): Promise<void> {
    const actor = await this.deps.resolveActor(input.callerAgentId);
    if (actor.kind !== "coordinator")
      throw new Error("Only coordinator-created pull requests qualify");
    try {
      const reviewer = await this.deps.resolveActor(input.reviewerAgentId);
      if (
        reviewer.kind !== "reviewer" ||
        reviewer.projectId !== actor.projectId ||
        reviewer.coordinatorAgentId !== actor.coordinatorAgentId
      )
        throw new Error("The reviewer belongs to another coordinator");
      const workspace = await this.deps.workspaceForHead(actor.projectId, input.head);
      if (!workspace || workspace.workspaceId === actor.workspaceId)
        throw new Error("A unique dedicated worktree workspace is required");
      const forge = await this.deps.resolveForge(input.cwd);
      if (!forge.getPullRequestMergeFacts)
        throw new Error("The forge cannot provide verified merge facts");
      const facts = await forge.getPullRequestMergeFacts({
        cwd: input.cwd,
        prNumber: input.number,
      });
      const origin = OriginSchema.parse({
        ...input,
        projectId: actor.projectId,
        workspaceId: workspace.workspaceId,
        workspaceCwd: workspace.cwd,
        createdHeadSha: facts.headSha,
        createdAt: new Date(this.deps.now()).toISOString(),
      });
      await this.store.change((state) => {
        const prior = state.origins.find(
          (entry) => entry.projectId === actor.projectId && entry.number === input.number,
        );
        if (prior) {
          if (
            prior.url !== origin.url ||
            prior.workspaceId !== origin.workspaceId ||
            prior.reviewerAgentId !== origin.reviewerAgentId
          )
            throw new Error("Pull request provenance is already recorded differently");
          return;
        }
        state.origins.push(origin);
      });
    } catch (error) {
      await this.deps.attention(
        actor.projectId,
        `Opened #${input.number}, but Autopilot provenance could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        `merge-provenance:${actor.projectId}:${input.number}`,
      );
    }
  }
  merge(input: {
    callerAgentId: string;
    number: number;
  }): Promise<{ merged: true; headSha: string }> {
    return this.serial(async () => {
      const actor = await this.deps.resolveActor(input.callerAgentId);
      if (actor.kind !== "coordinator" || actor.trustLevel !== "autopilot")
        throw new Error("Autopilot project coordinator is required to merge");
      const state = await this.store.read();
      const origin = state.origins.find(
        (entry) => entry.projectId === actor.projectId && entry.number === input.number,
      );
      if (!origin) throw new Error("This pull request has no coordinator-created provenance");
      const existing = state.merges.find(
        (entry) => entry.projectId === actor.projectId && entry.number === input.number,
      );
      if (existing && existing.state !== "merging") {
        const result = await this.deps.authorizeMerge(
          actor.projectId,
          actor.coordinatorAgentId,
          async () => {
            await this.finish(existing, origin);
            return { merged: true as const, headSha: existing.headSha };
          },
        );
        if (!result) throw new Error("Coordinator ownership changed before merge");
        return result;
      }
      // All forge reads and missing-object fetches happen before the mutation lock.
      const forge = await this.deps.resolveForge(origin.cwd);
      if (!forge.getPullRequestMergeFacts)
        throw new Error("This forge cannot verify automatic merges");
      const facts = await forge.getPullRequestMergeFacts({
        cwd: origin.cwd,
        prNumber: input.number,
      });
      const verdict = await this.requireCurrentReview(actor, origin, facts.headSha);
      await this.deps.ensurePolicyCommit?.(origin.cwd, facts.baseSha);
      const policy = await loadMergePolicy(origin.cwd, facts.baseSha);
      if (!policy.policy) {
        await this.policyAttention(actor.projectId, policy.reason);
        throw new Error(policy.reason);
      }
      let approved:
        | Parameters<
            NonNullable<Parameters<typeof mergeCoordinatorPullRequest>[0]["onAuthorized"]>
          >[0]
        | undefined;
      const receipt = {
        projectId: actor.projectId,
        number: input.number,
        headSha: facts.headSha,
        state: "merging" as const,
        startedAt: new Date(this.deps.now()).toISOString(),
      };
      const merged = await mergeCoordinatorPullRequest({
        forge: {
          getPullRequestMergeFacts: forge.getPullRequestMergeFacts.bind(forge),
          mergePullRequest: async (mergeInput) => {
            const result = await this.deps.authorizeMerge(
              actor.projectId,
              actor.coordinatorAgentId,
              async () => {
                const current = await this.deps.resolveActor(input.callerAgentId);
                if (
                  current.kind !== "coordinator" ||
                  current.projectId !== actor.projectId ||
                  current.coordinatorAgentId !== actor.coordinatorAgentId ||
                  current.trustLevel !== "autopilot"
                )
                  throw new Error("Autopilot ownership changed before merge");
                if (!approved || mergeInput.expectedHeadSha !== approved.facts.headSha)
                  throw new Error("Missing authorized merge facts");
                await this.requireCurrentReview(current, origin, approved.facts.headSha);
                // Save only after fresh local authority admits this exact guarded mutation.
                await this.saveMergeReceipt({
                  ...receipt,
                  headSha: approved.facts.headSha,
                  authorizedBaseSha: approved.facts.baseSha,
                  policyFingerprint: createHash("sha256")
                    .update(JSON.stringify(approved.policy))
                    .digest("hex"),
                });
                return forge.mergePullRequest(mergeInput);
              },
            );
            if (!result) throw new Error("Coordinator ownership changed before merge");
            return result;
          },
        },
        cwd: origin.cwd,
        prNumber: input.number,
        policy: policy.policy,
        trustLevel: actor.trustLevel,
        coordinatorAuthored: true,
        reviewer: { passed: verdict.passed, headSha: verdict.headSha },
        loadPolicyForBase: async (baseSha) => {
          await this.deps.ensurePolicyCommit?.(origin.cwd, baseSha);
          const currentPolicy = await loadMergePolicy(origin.cwd, baseSha);
          if (!currentPolicy.policy)
            await this.policyAttention(actor.projectId, currentPolicy.reason);
          return currentPolicy;
        },
        onAuthorized: async (value) => {
          approved = value;
        },
      });
      await this.store.change((saved) => {
        const attempt = saved.merges.find(
          (entry) => entry.projectId === actor.projectId && entry.number === input.number,
        );
        if (attempt) {
          attempt.state = "merged";
          attempt.putConfirmed = true;
        }
      });
      const finish = () =>
        this.finish(
          { ...receipt, headSha: merged.headSha, putConfirmed: true, state: "merged" },
          origin,
        );
      if (this.deps.authorizeRecovery) await this.deps.authorizeRecovery(actor.projectId, finish);
      else await finish();
      return merged;
    });
  }
  private async requireCurrentReview(
    actor: MergeActor,
    origin: z.infer<typeof OriginSchema>,
    headSha: string,
  ) {
    const reviewer = await this.deps.resolveActor(origin.reviewerAgentId);
    if (
      reviewer.kind !== "reviewer" ||
      reviewer.projectId !== actor.projectId ||
      reviewer.coordinatorAgentId !== actor.coordinatorAgentId
    )
      throw new Error("The recorded reviewer is outside current coordinator ownership");
    const verdict = (await this.store.read()).reviews.find(
      (entry) =>
        entry.projectId === actor.projectId &&
        entry.reviewerAgentId === origin.reviewerAgentId &&
        entry.headSha === headSha,
    );
    if (!verdict?.passed)
      throw new Error("The independent reviewer has not passed the current head commit");
    return verdict;
  }
  reconcile(): Promise<void> {
    return this.serial(async () => {
      const state = await this.store.read();
      for (const receipt of state.merges) {
        if (receipt.state === "archived") continue;
        const origin = state.origins.find(
          (entry) => entry.projectId === receipt.projectId && entry.number === receipt.number,
        );
        if (!origin) continue;
        try {
          if (receipt.state === "merging") {
            if (!receipt.authorizedBaseSha || !receipt.policyFingerprint) continue;
            const forge = await this.deps.resolveForge(origin.cwd);
            const facts = await forge.getPullRequestMergeFacts?.({
              cwd: origin.cwd,
              prNumber: origin.number,
            });
            if (facts?.state.toLowerCase() !== "merged" || facts.headSha !== receipt.headSha)
              continue;
          }
          const recover = async () => {
            if (receipt.state === "merging") {
              await this.setMergeState(receipt.projectId, receipt.number, "merged");
              receipt.state = "merged";
            }
            await this.finish(receipt, origin);
          };
          if (this.deps.authorizeRecovery)
            await this.deps.authorizeRecovery(receipt.projectId, recover);
          else await recover();
        } catch (error) {
          await this.deps.attention(
            receipt.projectId,
            `Merge #${receipt.number} needs recovery: ${String(error)}`,
            `merge-recovery:${receipt.projectId}:${receipt.number}`,
          );
        }
      }
    });
  }
  private async finish(
    receipt: z.infer<typeof StateSchema>["merges"][number],
    origin: z.infer<typeof OriginSchema>,
  ): Promise<void> {
    if (receipt.state === "archived") return;
    if (receipt.state === "merged") {
      await this.deps.appendDone(
        origin.projectId,
        receipt.putConfirmed
          ? `Merged #${origin.number} under policy`
          : `Merge confirmed for #${origin.number} at the authorized head`,
        { agentId: origin.callerAgentId, artifactUrl: origin.url },
        `merge:${origin.projectId}:${origin.number}:${receipt.headSha}`,
      );
      await this.setMergeState(origin.projectId, origin.number, "done");
    }
    await this.deps.archiveWorkspace(origin.workspaceId, {
      projectId: origin.projectId,
      head: origin.head,
      cwd: origin.workspaceCwd,
    });
    await this.setMergeState(origin.projectId, origin.number, "archived");
  }
  private async saveMergeReceipt(
    receipt: z.infer<typeof StateSchema>["merges"][number],
  ): Promise<void> {
    await this.store.change((current) => {
      const prior = current.merges.find(
        (entry) => entry.projectId === receipt.projectId && entry.number === receipt.number,
      );
      if (prior) Object.assign(prior, receipt);
      else current.merges.push(receipt);
    });
  }
  private async setMergeState(
    projectId: string,
    number: number,
    value: z.infer<typeof StateSchema>["merges"][number]["state"],
  ): Promise<void> {
    await this.store.change((state) => {
      state.merges.find(
        (entry) => entry.projectId === projectId && entry.number === number,
      )!.state = value;
    });
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const job = this.tail.then(run);
    this.tail = job.catch(() => undefined);
    return job;
  }
}
