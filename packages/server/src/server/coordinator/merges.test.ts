import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import type { PullRequestMergeFacts } from "../../services/forge-service.js";
import { CoordinatorMerges, type CoordinatorMergesDeps, type MergeActor } from "./merges.js";
const exec = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const policy =
  "max_trust_level: autopilot\nmerge:\n  enabled: true\n  only: coordinator-authored\n  required_checks: all\n  max_changed_lines: 300\n  protected_paths: [.github/**]\n  method: squash\n";
async function harness() {
  const home = await mkdtemp(path.join(tmpdir(), "merge-integration-"));
  homes.push(home);
  await exec("git", ["init", "--quiet"], { cwd: home });
  await mkdir(path.join(home, ".paseo"));
  await writeFile(path.join(home, ".paseo/coordinator.yml"), policy);
  await exec("git", ["add", "."], { cwd: home });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Policy",
    ],
    { cwd: home },
  );
  const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: home })).stdout.trim();
  let facts: PullRequestMergeFacts = {
    headSha: "a".repeat(40),
    baseSha,
    state: "open",
    draft: false,
    mergeable: true,
    mergeReady: true,
    upToDate: true,
    strictBaseProtection: true,
    additions: 10,
    deletions: 2,
    filesComplete: true,
    files: [{ path: "src/file.ts", lineCountsKnown: true }],
    checksComplete: true,
    checks: [{ name: "test", status: "success" }],
  };
  let mergeCalls = 0;
  let factReads = 0;
  let failPut = false;
  let authorized = false;
  let failArchive = false;
  let recoveryEnabled = true;
  const archived: string[] = [];
  const done: string[] = [];
  const attentions: string[] = [];
  const doneKeys = new Set<string>();
  const actor = (kind: MergeActor["kind"]): MergeActor => ({
    kind,
    projectId: "project",
    coordinatorAgentId: "coordinator",
    trustLevel: "autopilot",
    cwd: home,
    workspaceId: kind === "coordinator" ? "root-workspace" : "review-workspace",
  });
  const deps: CoordinatorMergesDeps = {
    paseoHome: home,
    now: () => 1000000,
    resolveActor: async (id) => {
      if (id === "coordinator") return actor("coordinator");
      if (id === "reviewer") return actor("reviewer");
      return actor("other");
    },
    policyBase: async () => ({ cwd: home, baseSha }),
    workspaceForHead: async () => ({ workspaceId: "worker-workspace", cwd: home }),
    authorizeRecovery: async (_project, run) => (recoveryEnabled ? run() : undefined),
    authorizeMerge: async (_project, _owner, run) => {
      authorized = true;
      try {
        return await run();
      } finally {
        authorized = false;
      }
    },
    resolveForge: async () => ({
      getPullRequestMergeFacts: async () => {
        expect(authorized).toBe(false);
        factReads++;
        return structuredClone(facts);
      },
      mergePullRequest: async (input) => {
        expect(authorized).toBe(true);
        expect(input.expectedHeadSha).toBe(facts.headSha);
        const attempts = JSON.parse(
          await readFile(path.join(home, "coordinator/merges.json"), "utf8"),
        ) as {
          merges: Array<{
            state: string;
            headSha: string;
            authorizedBaseSha: string;
            policyFingerprint: string;
          }>;
        };
        expect(attempts.merges[0]).toMatchObject({
          state: "merging",
          headSha: facts.headSha,
          authorizedBaseSha: baseSha,
          policyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        mergeCalls++;
        if (failPut) throw new Error("PUT response unavailable");
        facts = { ...facts, state: "merged" };
        return { success: true, merged: true };
      },
    }),
    appendDone: async (_project, text, _refs, key) => {
      if (!doneKeys.has(key)) {
        doneKeys.add(key);
        done.push(text);
      }
    },
    archiveWorkspace: async (id) => {
      if (failArchive) throw new Error("Archive temporarily unavailable");
      archived.push(id);
    },
    attention: async (_project, text) => {
      attentions.push(text);
    },
  };
  let service = new CoordinatorMerges(deps);
  await service.initialize();
  return {
    home,
    get service() {
      return service;
    },
    get facts() {
      return facts;
    },
    protectChangedPath: () => {
      facts = {
        ...facts,
        files: [{ path: ".github/workflows/unsafe.yml", lineCountsKnown: true }],
      };
    },
    markExternallyMerged: () => {
      facts = { ...facts, state: "merged" };
    },
    changeHead: () => {
      facts = { ...facts, headSha: "b".repeat(40) };
    },
    deps,
    get factReads() {
      return factReads;
    },
    failPut: () => {
      failPut = true;
    },
    get mergeCalls() {
      return mergeCalls;
    },
    archived,
    done,
    attentions,
    setRecoveryEnabled: (value: boolean) => {
      recoveryEnabled = value;
    },
    failArchive: (value: boolean) => {
      failArchive = value;
    },
    restart: async (recover = true) => {
      service = new CoordinatorMerges(deps);
      await service.initialize();
      if (recover) await service.reconcile();
    },
    created: () =>
      service.recordCreated({
        callerAgentId: "coordinator",
        reviewerAgentId: "reviewer",
        cwd: home,
        number: 43,
        url: "https://example.invalid/pull/43",
        head: "feature",
      }),
  };
}

test("only actual provenance and a passed independent exact-head review permit guarded merge", async () => {
  const h = await harness();
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "provenance",
  );
  await h.created();
  await expect(
    h.service.recordReview({
      callerAgentId: "coordinator",
      headSha: h.facts.headSha,
      passed: true,
    }),
  ).rejects.toThrow("independent reviewer");
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "not passed",
  );
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  h.changeHead();
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "not passed",
  );
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  await Promise.all([
    h.service.merge({ callerAgentId: "coordinator", number: 43 }),
    h.service.merge({ callerAgentId: "coordinator", number: 43 }),
  ]);
  expect(h.mergeCalls).toBe(1);
  expect(h.done).toEqual(["Merged #43 under policy"]);
  expect(h.archived).toEqual(["worker-workspace"]);
});

test("committed policy wins over a permissive working tree and archive retries without another merge", async () => {
  const h = await harness();
  await h.created();
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  await writeFile(path.join(h.home, ".paseo/coordinator.yml"), "broken: [");
  expect(await h.service.capTrust("project", "autopilot")).toBe("autopilot");
  h.failArchive(true);
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "Archive temporarily",
  );
  expect(h.mergeCalls).toBe(1);
  expect(h.done).toHaveLength(1);
  h.failArchive(false);
  await h.restart();
  expect(h.mergeCalls).toBe(1);
  expect(h.done).toHaveLength(1);
  expect(h.archived).toEqual(["worker-workspace"]);
});

test("a policy-rejected request later merged externally never gains an authorized attempt or archive", async () => {
  const h = await harness();
  await h.created();
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  h.protectChangedPath();
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "require a human merge",
  );
  h.markExternallyMerged();
  await h.restart();
  expect(h.mergeCalls).toBe(0);
  expect(h.done).toHaveLength(0);
  expect(h.archived).toHaveLength(0);
  const persisted = JSON.parse(
    await readFile(path.join(h.home, "coordinator/merges.json"), "utf8"),
  ) as { merges: unknown[] };
  expect(persisted.merges).toEqual([]);
});

test("disabled coordinator recovery leaves confirmed cleanup pending until re-enabled", async () => {
  const h = await harness();
  await h.created();
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  h.failArchive(true);
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow();
  h.failArchive(false);
  h.setRecoveryEnabled(false);
  await h.restart();
  expect(h.archived).toEqual([]);
  h.setRecoveryEnabled(true);
  await h.service.reconcile();
  expect(h.archived).toEqual(["worker-workspace"]);
  expect(h.mergeCalls).toBe(1);
});

test("failed PUT recovery initializes without network and reports confirmation without claiming our merge", async () => {
  const h = await harness();
  await h.created();
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  h.failPut();
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "PUT response unavailable",
  );
  h.markExternallyMerged();
  const reads = h.factReads;
  await h.restart(false);
  expect(h.factReads).toBe(reads);
  expect(h.done).toEqual([]);
  await h.service.reconcile();
  expect(h.done).toEqual(["Merge confirmed for #43 at the authorized head"]);
  expect(h.archived).toEqual(["worker-workspace"]);
  expect(h.mergeCalls).toBe(1);
});

test("authority revoked after forge reads cannot create an authorized receipt or invoke PUT", async () => {
  const h = await harness();
  await h.created();
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  h.deps.authorizeMerge = async () => undefined;
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "ownership changed",
  );
  expect(h.mergeCalls).toBe(0);
  const saved = JSON.parse(await readFile(path.join(h.home, "coordinator/merges.json"), "utf8"));
  expect(saved.merges).toEqual([]);
});

test("an older successful policy read cannot overwrite a newer invalid committed policy", async () => {
  const h = await harness();
  const oldBase = h.facts.baseSha;
  await writeFile(path.join(h.home, ".paseo/coordinator.yml"), "invalid: [");
  await exec("git", ["add", ".paseo/coordinator.yml"], { cwd: h.home });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Invalid policy",
    ],
    { cwd: h.home },
  );
  const newBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: h.home })).stdout.trim();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  h.deps.policyBase = async () => {
    if (++calls === 1) {
      await barrier;
      return { cwd: h.home, baseSha: oldBase };
    }
    return { cwd: h.home, baseSha: newBase };
  };
  const oldRead = h.service.projectPolicy("project");
  await h.service.projectPolicy("project");
  release();
  await oldRead;
  expect(h.service.cachedProjectPolicy("project")?.policy).toBeNull();
  expect(await h.service.lastVerifiedCap("project")).toBe("ship");
});

test("fresh merge fails closed on policy fetch outage despite a cached verified Autopilot cap", async () => {
  const h = await harness();
  await h.service.projectPolicy("project");
  expect(await h.service.lastVerifiedCap("project")).toBe("autopilot");
  await h.created();
  await h.service.recordReview({
    callerAgentId: "reviewer",
    headSha: h.facts.headSha,
    passed: true,
  });
  h.deps.ensurePolicyCommit = async () => {
    throw new Error("Policy transport unavailable");
  };
  await expect(h.service.merge({ callerAgentId: "coordinator", number: 43 })).rejects.toThrow(
    "Policy transport unavailable",
  );
  expect(h.mergeCalls).toBe(0);
  expect(h.attentions).toEqual([]);
  const state = JSON.parse(await readFile(path.join(h.home, "coordinator/merges.json"), "utf8"));
  expect(state.merges).toEqual([]);
  expect(await h.service.lastVerifiedCap("project")).toBe("autopilot");
});
