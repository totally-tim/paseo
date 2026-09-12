import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import type {
  CurrentPullRequestStatus,
  ForgeService,
  PullRequestCheck,
  PullRequestSummary,
} from "../../services/forge-service.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";

const OPEN_PULL_REQUEST_LIMIT = 50;
const DEFAULT_INTERVAL_MS = 120_000;
const MAX_BACKOFF_MULTIPLIER = 16;
const POLL_READ_REASON = "coordinator-change-request-poll";

const ChangeRequestCheckSchema = z.object({
  name: z.string(),
  status: z.string(),
});

const ChangeRequestEntrySchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  headRef: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean().nullable(),
  mergeable: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  checksStatus: z.string().nullable(),
  checks: z.array(ChangeRequestCheckSchema),
});

const ChangeRequestSnapshotSchema = z.object({
  fetchedAt: z.string(),
  forge: z.string(),
  entries: z.array(ChangeRequestEntrySchema),
});

const PersistedPollStateSchema = z.object({
  version: z.literal(1),
  hash: z.string(),
  snapshot: ChangeRequestSnapshotSchema,
});

export type ChangeRequestCheck = z.infer<typeof ChangeRequestCheckSchema>;
export type ChangeRequestEntry = z.infer<typeof ChangeRequestEntrySchema>;
export type ChangeRequestSnapshot = z.infer<typeof ChangeRequestSnapshotSchema>;
type PersistedPollState = z.infer<typeof PersistedPollStateSchema>;

export interface ChangeRequestPollChange {
  snapshot: ChangeRequestSnapshot;
  /** Human-readable diff lines, one per changed request. */
  diffSummary: string;
}

export type ChangeRequestPollOutcome =
  | { kind: "baseline"; snapshot: ChangeRequestSnapshot }
  | { kind: "unchanged"; snapshot: ChangeRequestSnapshot }
  | { kind: "changed"; snapshot: ChangeRequestSnapshot; diffSummary: string }
  | { kind: "no_project" }
  | { kind: "no_forge" }
  | { kind: "error"; error: unknown };

export interface ChangeRequestPollDeps {
  /** Project root on disk, or null when the project is gone/archived. */
  resolveProjectRoot: (projectId: string) => Promise<string | null>;
  workspaceGitService: Pick<WorkspaceGitService, "resolveForge">;
  paseoHome: string;
  logger: Logger;
  /** Called once per changed snapshot — never on the baseline poll. */
  onChange: (projectId: string, change: ChangeRequestPollChange) => void | Promise<void>;
  intervalMs?: number;
  now?: () => number;
}

interface TrackedProject {
  timer: NodeJS.Timeout | null;
  failures: number;
  cycle: Promise<void>;
  snapshot: ChangeRequestSnapshot | null;
}

function sortedCheckList(checks: PullRequestCheck[]): ChangeRequestCheck[] {
  return checks
    .map((check) => ({ name: check.name, status: check.status }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The listed request is authoritative for identity fields; the fetched status
 * wins for volatile fields, with the carried-forward prior entry as fallback
 * when the status read failed.
 */
function mergeStatusIntoEntry(
  pr: PullRequestSummary,
  status: CurrentPullRequestStatus | null,
  carried: ChangeRequestEntry | null,
): ChangeRequestEntry {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    headRef: pr.headRefName,
    updatedAt: pr.updatedAt,
    isDraft: status?.isDraft ?? carried?.isDraft ?? null,
    mergeable: status?.mergeable ?? carried?.mergeable ?? null,
    reviewDecision: status?.reviewDecision ?? carried?.reviewDecision ?? null,
    checksStatus: status?.checksStatus ?? carried?.checksStatus ?? null,
    checks: status !== null ? sortedCheckList(status.checks) : (carried?.checks ?? []),
  };
}

function normalizedEntries(snapshot: ChangeRequestSnapshot): ChangeRequestEntry[] {
  return snapshot.entries
    .map(
      (entry): ChangeRequestEntry => ({
        number: entry.number,
        title: entry.title,
        url: entry.url,
        state: entry.state,
        headRef: entry.headRef,
        updatedAt: entry.updatedAt,
        isDraft: entry.isDraft,
        mergeable: entry.mergeable,
        reviewDecision: entry.reviewDecision,
        checksStatus: entry.checksStatus,
        checks: entry.checks
          .map((check) => ({ name: check.name, status: check.status }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }),
    )
    .sort((a, b) => a.number - b.number);
}

/** Everything the hash covers, in a fixed shape and order. */
export function hashChangeRequestSnapshot(snapshot: ChangeRequestSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify({ forge: snapshot.forge, entries: normalizedEntries(snapshot) }))
    .digest("hex");
}

function describeFieldChanges(before: ChangeRequestEntry, entry: ChangeRequestEntry): string[] {
  const changes: string[] = [];
  if (before.title !== entry.title) changes.push(`retitled to "${entry.title}"`);
  if (before.state !== entry.state) changes.push(`state ${before.state}→${entry.state}`);
  if (before.isDraft !== null && entry.isDraft !== null && before.isDraft !== entry.isDraft) {
    changes.push(entry.isDraft ? "now a draft" : "left draft");
  }
  if (
    before.mergeable !== null &&
    entry.mergeable !== null &&
    before.mergeable !== entry.mergeable
  ) {
    changes.push(`mergeable ${before.mergeable}→${entry.mergeable}`);
  }
  if (
    before.reviewDecision !== null &&
    entry.reviewDecision !== null &&
    before.reviewDecision !== entry.reviewDecision
  ) {
    changes.push(`review ${before.reviewDecision}→${entry.reviewDecision}`);
  }
  if (
    before.checksStatus !== null &&
    entry.checksStatus !== null &&
    before.checksStatus !== entry.checksStatus
  ) {
    changes.push(`checks ${before.checksStatus}→${entry.checksStatus}`);
  }
  return [...changes, ...describeCheckChanges(before.checks, entry.checks)];
}

function describeCheckChanges(
  before: ChangeRequestCheck[],
  checks: ChangeRequestCheck[],
): string[] {
  const changes: string[] = [];
  const beforeChecks = new Map(before.map((check) => [check.name, check.status]));
  const nextCheckNames = new Set(checks.map((check) => check.name));
  for (const check of checks) {
    const previousStatus = beforeChecks.get(check.name);
    if (previousStatus === undefined) {
      changes.push(`check ${check.name} appeared (${check.status})`);
    } else if (previousStatus !== check.status) {
      changes.push(`${check.name} ${previousStatus}→${check.status}`);
    }
  }
  for (const check of before) {
    if (!nextCheckNames.has(check.name)) changes.push(`check ${check.name} removed`);
  }
  return changes;
}

/**
 * One line per change, e.g. `#41 opened: fix auth` or
 * `#41 test-e2e failure→success; mergeable UNKNOWN→MERGEABLE`.
 */
export function diffChangeRequestSnapshots(
  previous: ChangeRequestSnapshot,
  next: ChangeRequestSnapshot,
): string {
  const lines: string[] = [];
  const beforeByNumber = new Map(previous.entries.map((entry) => [entry.number, entry]));
  const nextNumbers = new Set(next.entries.map((entry) => entry.number));
  for (const entry of next.entries) {
    const before = beforeByNumber.get(entry.number);
    if (!before) {
      lines.push(`#${entry.number} opened: ${entry.title}`);
      continue;
    }
    const changes = describeFieldChanges(before, entry);
    if (changes.length === 0 && before.updatedAt !== entry.updatedAt) {
      changes.push("updated");
    }
    if (changes.length > 0) {
      lines.push(`#${entry.number} ${changes.join("; ")}`);
    }
  }
  for (const before of previous.entries) {
    if (!nextNumbers.has(before.number)) {
      lines.push(`#${before.number} is no longer open (${before.state}: ${before.title})`);
    }
  }
  return lines.join("\n");
}

/**
 * Standing per-project poll over the forge's open change requests plus their
 * check states — the spec's "PR poll" wake source. Every poll hashes a
 * normalized snapshot; the persisted hash survives restarts, so the first poll
 * after an outage diffs against the last pre-outage snapshot and wakes once
 * with the full diff.
 *
 * The poll lives on the service lifecycle, not on client subscriptions: the
 * existing workspace PR-status poll stops when nobody watches, which is exactly
 * why the coordinator cannot reuse it.
 */
export class ChangeRequestPoll {
  private readonly resolveProjectRoot: ChangeRequestPollDeps["resolveProjectRoot"];
  private readonly workspaceGitService: ChangeRequestPollDeps["workspaceGitService"];
  private readonly logger: Logger;
  private readonly onChange: ChangeRequestPollDeps["onChange"];
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly pollDir: string;
  private readonly tracked = new Map<string, TrackedProject>();
  private readonly writeTails = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(deps: ChangeRequestPollDeps) {
    this.resolveProjectRoot = deps.resolveProjectRoot;
    this.workspaceGitService = deps.workspaceGitService;
    this.logger = deps.logger.child({ module: "coordinator", component: "cr-poll" });
    this.onChange = deps.onChange;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
    this.pollDir = path.join(deps.paseoHome, "coordinator", "poll");
  }

  /** Start the per-project loop. The first cycle runs immediately. */
  trackProject(projectId: string): void {
    if (this.stopped || this.tracked.has(projectId)) return;
    this.tracked.set(projectId, {
      timer: null,
      failures: 0,
      cycle: Promise.resolve(),
      snapshot: null,
    });
    this.schedule(projectId, 0);
  }

  untrackProject(projectId: string): void {
    const entry = this.tracked.get(projectId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.tracked.delete(projectId);
  }

  stop(): void {
    this.stopped = true;
    // Map iteration is safe under deletion: untracked keys are simply skipped.
    for (const projectId of this.tracked.keys()) {
      this.untrackProject(projectId);
    }
  }

  /** The most recent snapshot for the project, in memory or on disk. */
  async lastSnapshot(projectId: string): Promise<ChangeRequestSnapshot | null> {
    const tracked = this.tracked.get(projectId);
    if (tracked?.snapshot) return tracked.snapshot;
    return (await this.loadPersisted(projectId))?.snapshot ?? null;
  }

  /**
   * Runs one poll cycle immediately, regardless of whether the project's timer
   * loop is tracked. Serialized per project so a manual call cannot overlap a
   * scheduled cycle.
   */
  async runOnce(projectId: string): Promise<ChangeRequestPollOutcome> {
    const tracked = this.tracked.get(projectId);
    const previous = tracked?.cycle ?? Promise.resolve();
    const cycle = previous.then(() => this.pollOnce(projectId));
    if (tracked)
      tracked.cycle = cycle.then(
        () => undefined,
        () => undefined,
      );
    return cycle;
  }

  private schedule(projectId: string, delayMs: number): void {
    const entry = this.tracked.get(projectId);
    if (!entry || this.stopped) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.tick(projectId);
    }, delayMs);
    entry.timer.unref?.();
  }

  private async tick(projectId: string): Promise<void> {
    const entry = this.tracked.get(projectId);
    if (!entry || this.stopped) return;
    const outcome = await this.runOnce(projectId);
    if (!this.tracked.has(projectId)) return;
    const delay =
      outcome.kind === "error"
        ? this.intervalMs * Math.min(2 ** Math.max(0, entry.failures - 1), MAX_BACKOFF_MULTIPLIER)
        : this.intervalMs;
    this.schedule(projectId, delay);
  }

  private async pollOnce(projectId: string): Promise<ChangeRequestPollOutcome> {
    try {
      const rootPath = await this.resolveProjectRoot(projectId);
      if (!rootPath) return { kind: "no_project" };
      const resolution = await this.workspaceGitService.resolveForge(rootPath);
      // No forge → nothing to poll. The timer keeps running so a remote added
      // later is picked up on the next cycle.
      if (!resolution) return { kind: "no_forge" };
      const previous = await this.loadPersisted(projectId);
      const snapshot = await this.fetchSnapshot(
        projectId,
        rootPath,
        resolution,
        previous?.snapshot ?? null,
      );
      const hash = hashChangeRequestSnapshot(snapshot);
      const tracked = this.tracked.get(projectId);
      if (tracked) {
        tracked.snapshot = snapshot;
        tracked.failures = 0;
      }
      if (!previous) {
        await this.savePersisted(projectId, { version: 1, hash, snapshot });
        return { kind: "baseline", snapshot };
      }
      if (previous.hash === hash) {
        return { kind: "unchanged", snapshot };
      }
      const diffSummary =
        diffChangeRequestSnapshots(previous.snapshot, snapshot) || "change-request state changed";
      await this.savePersisted(projectId, { version: 1, hash, snapshot });
      await this.onChange(projectId, { snapshot, diffSummary });
      return { kind: "changed", snapshot, diffSummary };
    } catch (error) {
      const tracked = this.tracked.get(projectId);
      if (tracked) tracked.failures += 1;
      this.logger.warn({ err: error, projectId }, "Change-request poll cycle failed");
      return { kind: "error", error };
    }
  }

  private async fetchSnapshot(
    projectId: string,
    rootPath: string,
    resolution: { forge: string; service: ForgeService },
    previousSnapshot: ChangeRequestSnapshot | null,
  ): Promise<ChangeRequestSnapshot> {
    const pullRequests = await resolution.service.listPullRequests({
      cwd: rootPath,
      limit: OPEN_PULL_REQUEST_LIMIT,
      reason: POLL_READ_REASON,
    });
    const previousByNumber = new Map(
      (previousSnapshot?.entries ?? []).map((entry) => [entry.number, entry]),
    );
    const entries: ChangeRequestEntry[] = [];
    // Sequential on purpose: each status read spawns a forge CLI call, and a
    // project rarely has more than a handful of open change requests.
    for (const pr of pullRequests) {
      entries.push(await this.fetchEntry(projectId, rootPath, resolution, pr, previousByNumber));
    }
    return {
      fetchedAt: new Date(this.now()).toISOString(),
      forge: resolution.forge,
      entries: entries.sort((a, b) => a.number - b.number),
    };
  }

  private async fetchEntry(
    projectId: string,
    rootPath: string,
    resolution: { forge: string; service: ForgeService },
    pr: PullRequestSummary,
    previousByNumber: Map<number, ChangeRequestEntry>,
  ): Promise<ChangeRequestEntry> {
    const status = await this.fetchStatus(projectId, rootPath, resolution, pr);
    return mergeStatusIntoEntry(pr, status, previousByNumber.get(pr.number) ?? null);
  }

  private async fetchStatus(
    projectId: string,
    rootPath: string,
    resolution: { forge: string; service: ForgeService },
    pr: PullRequestSummary,
  ): Promise<CurrentPullRequestStatus | null> {
    const fetched = await resolution.service
      .getCurrentPullRequestStatus({
        cwd: rootPath,
        headRef: pr.headRefName,
        reason: POLL_READ_REASON,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error, projectId, prNumber: pr.number },
          "Per-request check fetch failed; carrying forward the last snapshot's status",
        );
        return null;
      });
    // The head-ref lookup can resolve to a different change request (fork
    // heads, reused branch names); a mismatched status is treated as absent.
    return fetched !== null && fetched.number !== undefined && fetched.number !== pr.number
      ? null
      : fetched;
  }

  private pollStatePath(projectId: string): string {
    return path.join(this.pollDir, `${projectId}.json`);
  }

  private async loadPersisted(projectId: string): Promise<PersistedPollState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.pollStatePath(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.logger.warn({ projectId }, "Discarding unreadable change-request poll state");
      return null;
    }
    const parsed = PersistedPollStateSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(
        { projectId, issues: parsed.error.issues.length },
        "Discarding unreadable change-request poll state",
      );
      return null;
    }
    return parsed.data;
  }

  private async savePersisted(projectId: string, state: PersistedPollState): Promise<void> {
    const filePath = this.pollStatePath(projectId);
    const previous = this.writeTails.get(filePath) ?? Promise.resolve();
    const next = previous.then(() => this.writeStateFile(filePath, state));
    const tracked = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeTails.set(filePath, tracked);
    void tracked.finally(() => {
      if (this.writeTails.get(filePath) === tracked) this.writeTails.delete(filePath);
    });
    return next;
  }

  private async writeStateFile(filePath: string, state: PersistedPollState): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeJsonFileAtomic(filePath, state);
  }
}
