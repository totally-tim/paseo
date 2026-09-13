import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import type { CoordinatorTrustLevel } from "@getpaseo/protocol/messages";
import { runGitCommand } from "../../utils/run-git-command.js";
import type { ForgeService, PullRequestMergeFacts } from "../../services/forge-service.js";

const levels = ["observe", "propose", "ship", "autopilot"] as const;
const ProtectedPattern = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !["\\", "[", "]", "{", "}", "!", "\0"].some((char) => value.includes(char)) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Use relative paths with *, **, or ? only",
  );
const PolicySchema = z
  .object({
    max_trust_level: z.enum(levels),
    merge: z
      .object({
        enabled: z.boolean(),
        only: z.literal("coordinator-authored"),
        required_checks: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
        max_changed_lines: z.number().int().nonnegative(),
        protected_paths: z.array(ProtectedPattern),
        method: z.enum(["squash", "merge", "rebase"]),
      })
      .strict(),
  })
  .strict();
export type MergePolicy = z.infer<typeof PolicySchema>;
export type AutopilotMergeFacts = PullRequestMergeFacts;
export function parseMergePolicy(yaml: string): MergePolicy {
  if (Buffer.byteLength(yaml) > 32000) throw new Error("Merge policy exceeds 32 KB");
  const document = parseDocument(yaml, { strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new Error(
      [...document.errors, ...document.warnings].map((entry) => entry.message).join("; "),
    );
  return PolicySchema.parse(document.toJS({ maxAliasCount: 0 }));
}
export type MergePolicyState =
  | { policy: MergePolicy; reason?: never }
  | { policy: null; reason: string };
export async function loadMergePolicy(
  cwd: string,
  committedRef?: string,
): Promise<MergePolicyState> {
  try {
    if (committedRef !== undefined) {
      if (!/^[a-f0-9]{40,64}$/i.test(committedRef))
        throw new Error("An exact committed base SHA is required");
      const result = await runGitCommand(["show", `${committedRef}:.paseo/coordinator.yml`], {
        cwd,
      });
      return { policy: parseMergePolicy(result.stdout) };
    }
    return {
      policy: parseMergePolicy(
        await fs.readFile(path.join(cwd, ".paseo", "coordinator.yml"), "utf8"),
      ),
    };
  } catch (error) {
    return {
      policy: null,
      reason:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "No coordinator merge policy is available"
          : `Invalid coordinator merge policy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
/** An unreadable cap cannot authorize the most permissive level. */
export function capCoordinatorTrust(
  requested: CoordinatorTrustLevel,
  state: MergePolicyState,
): CoordinatorTrustLevel {
  const cap = state.policy?.max_trust_level ?? "ship";
  return levels[Math.min(levels.indexOf(requested), levels.indexOf(cap))];
}
function pathMatches(pattern: string, file: string): boolean {
  const parts = pattern.split("/");
  const expression = parts
    .map((part, index) => {
      if (part === "**") return index === parts.length - 1 ? ".*" : "(?:[^/]+/)*";
      let result = "";
      for (const char of part) {
        if (char === "*") result += "[^/]*";
        else if (char === "?") result += "[^/]";
        else result += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      return result + (index < parts.length - 1 ? "/" : "");
    })
    .join("");
  return new RegExp(`^${expression}$`).test(file);
}
export type AutopilotMergeDecision =
  | { allowed: true; expectedHeadSha: string; method: MergePolicy["merge"]["method"] }
  | { allowed: false; reason: string };
export interface AutopilotMergeInput {
  policy: MergePolicy;
  trustLevel: CoordinatorTrustLevel;
  facts: AutopilotMergeFacts;
  coordinatorAuthored: boolean;
  reviewer: { passed: boolean; headSha: string };
}
export function evaluateAutopilotMerge(input: AutopilotMergeInput): AutopilotMergeDecision {
  const { policy, facts, reviewer } = input;
  const deny = (reason: string): AutopilotMergeDecision => ({ allowed: false, reason });
  if (input.trustLevel !== "autopilot" || policy.max_trust_level !== "autopilot")
    return deny("Autopilot exceeds the current trust level or policy cap");
  if (!policy.merge.enabled) return deny("Automatic merging is disabled by policy");
  if (!input.coordinatorAuthored)
    return deny("The change request was not authored by the coordinator");
  if (!/^[a-f0-9]{40,64}$/i.test(facts.headSha) || !/^[a-f0-9]{40,64}$/i.test(facts.baseSha))
    return deny("The exact head and base commits are unavailable");
  if (
    facts.state !== "open" ||
    facts.draft !== false ||
    facts.mergeable !== true ||
    facts.mergeReady !== true
  )
    return deny("The forge does not report an open, ready, mergeable change request");
  if (facts.upToDate !== true || facts.strictBaseProtection !== true)
    return deny("The base must be current and enforced by strict forge protection");
  if (!reviewer.passed || reviewer.headSha !== facts.headSha)
    return deny("A reviewer has not passed this exact head commit");
  const diffFailure = validateChangedFiles(policy, facts);
  if (diffFailure) return deny(diffFailure);
  const checkFailure = validateChecks(policy, facts);
  if (checkFailure) return deny(checkFailure);
  return { allowed: true, expectedHeadSha: facts.headSha, method: policy.merge.method };
}
function validateChangedFiles(policy: MergePolicy, facts: AutopilotMergeFacts): string | null {
  if (facts.filesComplete !== true || !Array.isArray(facts.files) || !facts.files.length)
    return "The complete changed-file list is unavailable";
  if (
    ![facts.additions, facts.deletions].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    return "Changed-line counts are unavailable";
  if (facts.additions + facts.deletions > policy.merge.max_changed_lines)
    return "The change request exceeds the changed-line cap";
  for (const file of facts.files) {
    if (file.lineCountsKnown !== true) return `Line counts are unknown for ${file.path}`;
    for (const name of [file.path, file.previousPath].filter(
      (entry): entry is string => entry !== undefined,
    )) {
      if (
        !name ||
        name.startsWith("/") ||
        name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === "..")
      )
        return "A changed-file path is invalid";
      // A policy cannot grant authority to rewrite itself or the checks that enforce it.
      // Include ancestor replacements and case aliases on case-insensitive checkouts.
      const authorityPath = name.toLowerCase();
      if (
        authorityPath === ".paseo" ||
        authorityPath === ".paseo/coordinator.yml" ||
        authorityPath === ".github" ||
        authorityPath === ".github/workflows" ||
        authorityPath.startsWith(".github/workflows/")
      )
        return `Changes to ${name} require a human merge`;
      if (policy.merge.protected_paths.some((pattern) => pathMatches(pattern, name)))
        return `Protected path changed: ${name}`;
    }
  }
  return null;
}
function validateChecks(policy: MergePolicy, facts: AutopilotMergeFacts): string | null {
  if (facts.checksComplete !== true || !Array.isArray(facts.checks) || !facts.checks.length)
    return "The complete passing-check set is unavailable";
  const names =
    policy.merge.required_checks === "all"
      ? [...new Set(facts.checks.map((check) => check.name))]
      : policy.merge.required_checks;
  for (const name of names) {
    const checks = facts.checks.filter((check) => check.name === name);
    if (
      !checks.length ||
      checks.some((check) => check.status !== "success" || check.traits?.length)
    )
      return `Required check is not green: ${name}`;
  }
  return null;
}
/** The service supplies provenance; this function refreshes forge facts and binds the mutation to that head. */
export async function mergeCoordinatorPullRequest(input: {
  forge: Pick<ForgeService, "getPullRequestMergeFacts" | "mergePullRequest">;
  cwd: string;
  prNumber: number;
  policy: MergePolicy;
  trustLevel: CoordinatorTrustLevel;
  coordinatorAuthored: boolean;
  reviewer: { passed: boolean; headSha: string };
  loadPolicyForBase?: (baseSha: string) => Promise<MergePolicyState>;
  onAuthorized?: (approval: { facts: AutopilotMergeFacts; policy: MergePolicy }) => Promise<void>;
}): Promise<{ merged: true; headSha: string }> {
  if (!input.forge.getPullRequestMergeFacts)
    throw new Error("This forge does not support verified automatic merging");
  const facts = await input.forge.getPullRequestMergeFacts({
    cwd: input.cwd,
    prNumber: input.prNumber,
  });
  const state = input.loadPolicyForBase
    ? await input.loadPolicyForBase(facts.baseSha)
    : { policy: input.policy };
  if (!state.policy) throw new Error(state.reason);
  const decision = evaluateAutopilotMerge({ ...input, policy: state.policy, facts });
  if (!decision.allowed) throw new Error(decision.reason);
  await input.onAuthorized?.({ facts, policy: state.policy });
  const result = await input.forge.mergePullRequest({
    cwd: input.cwd,
    prNumber: input.prNumber,
    mergeMethod: decision.method,
    expectedHeadSha: decision.expectedHeadSha,
  });
  if (result.merged !== true) throw new Error("The forge did not confirm an immediate merge");
  return { merged: true, headSha: decision.expectedHeadSha };
}
