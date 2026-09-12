import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CurrentPullRequestStatus,
  ForgeService,
  PullRequestSummary,
} from "../../services/forge-service.js";
import type { ForgeResolution } from "../../services/forge-resolver.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  ChangeRequestPoll,
  diffChangeRequestSnapshots,
  hashChangeRequestSnapshot,
  type ChangeRequestPollChange,
  type ChangeRequestSnapshot,
} from "./change-request-poll.js";

const logger = createTestLogger();
const PROJECT_ID = "prj_test";

function makePullRequest(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 41,
    title: "Fix the bug",
    url: "https://github.com/o/r/pull/41",
    state: "open",
    body: null,
    baseRefName: "main",
    headRefName: "fix-bug",
    labels: [],
    updatedAt: "2026-09-11T10:00:00Z",
    ...overrides,
  };
}

function makeStatus(overrides: Partial<CurrentPullRequestStatus> = {}): CurrentPullRequestStatus {
  return {
    number: 41,
    url: "https://github.com/o/r/pull/41",
    title: "Fix the bug",
    state: "open",
    baseRefName: "main",
    headRefName: "fix-bug",
    isMerged: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    checks: [{ name: "test-e2e", status: "pending", url: null }],
    checksStatus: "pending",
    reviewDecision: "pending",
    ...overrides,
  };
}

class StubForgeService {
  pullRequests: PullRequestSummary[] = [];
  /** Status per headRef; absent entries resolve to null. */
  statuses = new Map<string, CurrentPullRequestStatus | null>();
  statusError: Error | null = null;
  listCalls = 0;
  statusCalls = 0;

  async listPullRequests(): Promise<PullRequestSummary[]> {
    this.listCalls += 1;
    return this.pullRequests;
  }

  async getCurrentPullRequestStatus(options: {
    headRef: string;
  }): Promise<CurrentPullRequestStatus | null> {
    this.statusCalls += 1;
    if (this.statusError) throw this.statusError;
    return this.statuses.get(options.headRef) ?? null;
  }
}

interface Harness {
  root: string;
  paseoHome: string;
  projectRoot: string;
  forge: StubForgeService;
  changes: ChangeRequestPollChange[];
  resolveForgeResult: ForgeResolution | null;
  makePoll: (deps?: {
    resolveProjectRoot?: (projectId: string) => Promise<string | null>;
    resolveForge?: () => Promise<ForgeResolution | null>;
  }) => ChangeRequestPoll;
}

function makeHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "cr-poll-test-"));
  const paseoHome = path.join(root, "paseo-home");
  const projectRoot = path.join(root, "project");
  const forge = new StubForgeService();
  const harness: Harness = {
    root,
    paseoHome,
    projectRoot,
    forge,
    changes: [],
    resolveForgeResult: {
      forge: "github",
      host: "github.com",
      service: forge as unknown as ForgeService,
    },
    makePoll: (deps) =>
      new ChangeRequestPoll({
        resolveProjectRoot: deps?.resolveProjectRoot ?? (async () => projectRoot),
        workspaceGitService: {
          resolveForge: deps?.resolveForge ?? (async () => harness.resolveForgeResult),
        },
        paseoHome,
        logger,
        onChange: (_projectId, change) => {
          harness.changes.push(change);
        },
        intervalMs: 60_000,
      }),
  };
  return harness;
}

describe("ChangeRequestPoll", () => {
  test("the first successful poll establishes a baseline without waking", async () => {
    const harness = makeHarness();
    try {
      harness.forge.pullRequests = [makePullRequest()];
      harness.forge.statuses.set("fix-bug", makeStatus());
      const poll = harness.makePoll();

      const outcome = await poll.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("baseline");
      expect(harness.changes).toHaveLength(0);
      const statePath = path.join(harness.paseoHome, "coordinator", "poll", `${PROJECT_ID}.json`);
      expect(existsSync(statePath)).toBe(true);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("an identical snapshot stays quiet; a check-state change wakes once", async () => {
    const harness = makeHarness();
    try {
      harness.forge.pullRequests = [makePullRequest()];
      harness.forge.statuses.set("fix-bug", makeStatus());
      const poll = harness.makePoll();
      await poll.runOnce(PROJECT_ID);

      expect((await poll.runOnce(PROJECT_ID)).kind).toBe("unchanged");
      expect(harness.changes).toHaveLength(0);

      harness.forge.statuses.set(
        "fix-bug",
        makeStatus({
          checks: [{ name: "test-e2e", status: "failure", url: null }],
          checksStatus: "failure",
        }),
      );
      const outcome = await poll.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("changed");
      expect(harness.changes).toHaveLength(1);
      expect(harness.changes[0].diffSummary).toContain("#41");
      expect(harness.changes[0].diffSummary).toContain("test-e2e pending→failure");
      expect(harness.changes[0].diffSummary).toContain("checks pending→failure");

      // The same state polled again does not wake a second time.
      expect((await poll.runOnce(PROJECT_ID)).kind).toBe("unchanged");
      expect(harness.changes).toHaveLength(1);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("a new open change request and a closed one both appear in the diff", async () => {
    const harness = makeHarness();
    try {
      harness.forge.pullRequests = [makePullRequest()];
      const poll = harness.makePoll();
      await poll.runOnce(PROJECT_ID);

      harness.forge.pullRequests = [
        makePullRequest({ number: 52, title: "Add retry", headRefName: "add-retry" }),
      ];
      const outcome = await poll.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("changed");
      expect(harness.changes[0].diffSummary).toContain("#52 opened: Add retry");
      expect(harness.changes[0].diffSummary).toContain("#41 is no longer open");
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("persisted state survives a service restart: the first poll diffs against it", async () => {
    const harness = makeHarness();
    try {
      harness.forge.pullRequests = [makePullRequest()];
      harness.forge.statuses.set("fix-bug", makeStatus());
      const first = harness.makePoll();
      await first.runOnce(PROJECT_ID);
      first.stop();

      // "Daemon restarted": a fresh poll instance over the same paseo home.
      harness.forge.statuses.set(
        "fix-bug",
        makeStatus({
          checks: [{ name: "test-e2e", status: "success", url: null }],
          checksStatus: "success",
          reviewDecision: "approved",
        }),
      );
      const second = harness.makePoll();
      const outcome = await second.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("changed");
      expect(harness.changes).toHaveLength(1);
      expect(harness.changes[0].diffSummary).toContain("review pending→approved");
      second.stop();
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("no forge means no polling, no state file, and no wake", async () => {
    const harness = makeHarness();
    try {
      const poll = harness.makePoll({ resolveForge: async () => null });
      const outcome = await poll.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("no_forge");
      expect(harness.forge.listCalls).toBe(0);
      expect(harness.changes).toHaveLength(0);
      expect(
        existsSync(path.join(harness.paseoHome, "coordinator", "poll", `${PROJECT_ID}.json`)),
      ).toBe(false);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("a gone project reports no_project and skips the forge entirely", async () => {
    const harness = makeHarness();
    try {
      const poll = harness.makePoll({ resolveProjectRoot: async () => null });
      const outcome = await poll.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("no_project");
      expect(harness.forge.listCalls).toBe(0);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("a failing status read carries forward the previous status instead of waking", async () => {
    const harness = makeHarness();
    try {
      harness.forge.pullRequests = [makePullRequest()];
      harness.forge.statuses.set("fix-bug", makeStatus());
      const poll = harness.makePoll();
      await poll.runOnce(PROJECT_ID);

      harness.forge.statusError = new Error("gh offline");
      const outcome = await poll.runOnce(PROJECT_ID);

      // The snapshot keeps the carried-forward status, so the hash is stable.
      expect(outcome.kind).toBe("unchanged");
      expect(harness.changes).toHaveLength(0);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("a status resolved for a different request number is ignored", async () => {
    const harness = makeHarness();
    try {
      harness.forge.pullRequests = [makePullRequest()];
      harness.forge.statuses.set("fix-bug", makeStatus());
      const poll = harness.makePoll();
      await poll.runOnce(PROJECT_ID);

      // The head ref resolves to another PR — the status must not bleed in.
      harness.forge.statuses.set("fix-bug", makeStatus({ number: 99, checksStatus: "failure" }));
      const outcome = await poll.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("unchanged");
      expect(harness.changes).toHaveLength(0);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test("corrupt persisted state is discarded and the next poll re-baselines", async () => {
    const harness = makeHarness();
    try {
      harness.forge.pullRequests = [makePullRequest()];
      const pollDir = path.join(harness.paseoHome, "coordinator", "poll");
      mkdirSync(pollDir, { recursive: true });
      writeFileSync(path.join(pollDir, `${PROJECT_ID}.json`), "{ not json");
      const poll = harness.makePoll();

      const outcome = await poll.runOnce(PROJECT_ID);

      expect(outcome.kind).toBe("baseline");
      expect(harness.changes).toHaveLength(0);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});

describe("hashChangeRequestSnapshot", () => {
  test("is order-insensitive across entries and checks", () => {
    const base: ChangeRequestSnapshot = {
      fetchedAt: "2026-09-11T10:00:00Z",
      forge: "github",
      entries: [
        {
          number: 1,
          title: "a",
          url: "u1",
          state: "open",
          headRef: "a",
          updatedAt: "t",
          isDraft: null,
          mergeable: null,
          reviewDecision: null,
          checksStatus: null,
          checks: [
            { name: "b", status: "success" },
            { name: "a", status: "pending" },
          ],
        },
        {
          number: 2,
          title: "b",
          url: "u2",
          state: "open",
          headRef: "b",
          updatedAt: "t",
          isDraft: null,
          mergeable: null,
          reviewDecision: null,
          checksStatus: null,
          checks: [],
        },
      ],
    };
    const reordered: ChangeRequestSnapshot = {
      ...base,
      fetchedAt: "different-timestamp",
      entries: [
        base.entries[1],
        { ...base.entries[0], checks: [base.entries[0].checks[1], base.entries[0].checks[0]] },
      ],
    };
    expect(hashChangeRequestSnapshot(reordered)).toBe(hashChangeRequestSnapshot(base));
  });
});

describe("diffChangeRequestSnapshots", () => {
  function entry(overrides: Partial<ChangeRequestSnapshot["entries"][number]> = {}) {
    return {
      number: 41,
      title: "Fix the bug",
      url: "u",
      state: "open",
      headRef: "fix-bug",
      updatedAt: "t1",
      isDraft: null,
      mergeable: null,
      reviewDecision: null,
      checksStatus: null,
      checks: [],
      ...overrides,
    };
  }

  function snapshot(entries: ChangeRequestSnapshot["entries"]): ChangeRequestSnapshot {
    return { fetchedAt: "t", forge: "github", entries };
  }

  test("names retitles, state flips, and per-check transitions", () => {
    const before = snapshot([
      entry({
        checks: [
          { name: "build", status: "success" },
          { name: "lint", status: "pending" },
        ],
        mergeable: "UNKNOWN",
      }),
    ]);
    const after = snapshot([
      entry({
        title: "Fix the bug properly",
        mergeable: "MERGEABLE",
        checks: [
          { name: "build", status: "success" },
          { name: "lint", status: "failure" },
          { name: "e2e", status: "pending" },
        ],
      }),
    ]);

    const diff = diffChangeRequestSnapshots(before, after);
    expect(diff).toContain('retitled to "Fix the bug properly"');
    expect(diff).toContain("mergeable UNKNOWN→MERGEABLE");
    expect(diff).toContain("lint pending→failure");
    expect(diff).toContain("check e2e appeared (pending)");
    expect(diff).not.toContain("build");
  });
});
