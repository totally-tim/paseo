import { z } from "zod";
import type { PullRequestMergeFacts, PullRequestCheckStatus } from "./forge-service.js";

const Sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const PullSchema = z.object({
  head: z.object({ sha: Sha }),
  base: z.object({ sha: Sha, ref: z.string().min(1) }),
  state: z.string(),
  merged: z.boolean(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
});
const FileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});
const CheckSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const RequiredStatusChecksSchema = z.object({
  strict: z.boolean(),
  contexts: z.array(z.string().min(1)).optional(),
  checks: z.array(z.object({ context: z.string().min(1) })).optional(),
});
const StatusSchema = z.object({ context: z.string(), state: z.string(), created_at: z.string() });
export interface GitHubAutopilotApi {
  get: (endpoint: string, paginate?: boolean) => Promise<unknown>;
}
/** Every paginated fact is head-bound, then the PR's head/base are checked again. */
export async function readGitHubAutopilotFacts(
  api: GitHubAutopilotApi,
  repo: string,
  number: number,
): Promise<PullRequestMergeFacts> {
  const prefix = `repos/${repo}`;
  const pull = PullSchema.parse(await api.get(`${prefix}/pulls/${number}`));
  const [filePages, checkPages, statusPages, comparison, protection] = await Promise.all([
    api.get(`${prefix}/pulls/${number}/files?per_page=100`, true),
    api.get(`${prefix}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100`, true),
    api.get(`${prefix}/commits/${pull.head.sha}/statuses?per_page=100`, true),
    api.get(`${prefix}/compare/${pull.base.sha}...${pull.head.sha}`),
    api.get(`${prefix}/branches/${encodeURIComponent(pull.base.ref)}/protection`),
  ]);
  const files = z.array(z.array(FileSchema)).parse(filePages).flat();
  const pages = z
    .array(
      z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(CheckSchema) }),
    )
    .parse(checkPages);
  const checks = pages.flatMap((page) => page.check_runs);
  const statuses = z.array(z.array(StatusSchema)).parse(statusPages).flat();
  const latest = new Map<string, z.infer<typeof StatusSchema>>();
  for (const status of statuses) {
    if (!Number.isFinite(Date.parse(status.created_at)))
      throw new Error("A commit status has no valid timestamp");
    const previous = latest.get(status.context);
    if (!previous || Date.parse(status.created_at) > Date.parse(previous.created_at))
      latest.set(status.context, status);
  }
  const compare = z.object({ status: z.string() }).parse(comparison);
  const protectedBase = z
    .object({
      required_status_checks: RequiredStatusChecksSchema.nullable(),
      enforce_admins: z.object({ enabled: z.boolean() }),
    })
    .parse(protection);
  const reportedChecks = [
    ...checks.map((check) => ({
      name: check.name,
      status: checkStatus(check.status === "completed" ? check.conclusion : "pending"),
    })),
    ...[...latest.values()].map((status) => ({
      name: status.context,
      status: checkStatus(status.state),
    })),
  ];
  const requiredChecksGreen = includeRequiredChecks(
    protectedBase.required_status_checks,
    reportedChecks,
  );
  const current = PullSchema.parse(await api.get(`${prefix}/pulls/${number}`));
  if (
    current.head.sha !== pull.head.sha ||
    current.base.sha !== pull.base.sha ||
    current.base.ref !== pull.base.ref
  )
    throw new Error("The change request moved while merge facts were being checked");
  return {
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    state: current.merged ? "merged" : current.state,
    draft: current.draft,
    mergeable: current.mergeable === true,
    mergeReady: current.mergeable_state === "clean" && requiredChecksGreen,
    upToDate: compare.status === "ahead" || compare.status === "identical",
    strictBaseProtection:
      protectedBase.required_status_checks?.strict === true && protectedBase.enforce_admins.enabled,
    additions: pull.additions,
    deletions: pull.deletions,
    filesComplete:
      files.length === pull.changed_files &&
      new Set(files.map((file) => file.filename)).size === files.length &&
      files.reduce((sum, file) => sum + file.additions, 0) === pull.additions &&
      files.reduce((sum, file) => sum + file.deletions, 0) === pull.deletions,
    files: files.map((file) => ({
      path: file.filename,
      previousPath: file.previous_filename,
      // Binary and omitted zero-line diffs cannot be evaluated against a line cap.
      lineCountsKnown: file.patch !== undefined,
    })),
    checksComplete: pages.length > 0 && pages.every((page) => page.total_count === checks.length),
    checks: reportedChecks,
  };
}
function checkStatus(value: string | null): PullRequestCheckStatus {
  if (value === "success") return "success";
  if (value === "pending" || value === "in_progress" || value === "queued") return "pending";
  if (value === "cancelled") return "cancelled";
  if (value === "skipped" || value === "neutral") return "skipped";
  return "failure";
}

function includeRequiredChecks(
  protection: z.infer<typeof RequiredStatusChecksSchema> | null,
  checks: Array<{ name: string; status: PullRequestCheckStatus }>,
): boolean {
  const requiredContexts = new Set([
    ...(protection?.contexts ?? []),
    ...(protection?.checks ?? []).map((check) => check.context),
  ]);
  let green = true;
  for (const name of requiredContexts) {
    const reported = checks.filter((check) => check.name === name);
    if (!reported.length) {
      // Required workflows can be absent even while GitHub reports clean.
      checks.push({ name, status: "pending" });
      green = false;
    } else if (reported.some((check) => check.status !== "success")) {
      green = false;
    }
  }
  return green;
}
