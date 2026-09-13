import { expect, test } from "vitest";
import {
  evaluateAutopilotMerge,
  parseMergePolicy,
  type AutopilotMergeFacts,
} from "./merge-policy.js";
const policyText =
  "max_trust_level: autopilot\nmerge:\n  enabled: true\n  only: coordinator-authored\n  required_checks: all\n  max_changed_lines: 300\n  protected_paths: [packages/protocol/**, .github/**]\n  method: squash\n";
const facts: AutopilotMergeFacts = {
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  state: "open",
  draft: false,
  mergeable: true,
  mergeReady: true,
  upToDate: true,
  strictBaseProtection: true,
  additions: 10,
  deletions: 5,
  filesComplete: true,
  files: [{ path: "src/app.ts", lineCountsKnown: true }],
  checksComplete: true,
  checks: [{ name: "test", status: "success" }],
};
test("merge policy admits only the reviewed coordinator head with complete passing facts", () => {
  const policy = parseMergePolicy(policyText);
  const input = {
    policy,
    trustLevel: "autopilot" as const,
    facts,
    coordinatorAuthored: true,
    reviewer: { passed: true, headSha: facts.headSha },
  };
  expect(evaluateAutopilotMerge(input)).toEqual({
    allowed: true,
    expectedHeadSha: facts.headSha,
    method: "squash",
  });
  for (const changed of [
    { coordinatorAuthored: false },
    { reviewer: { passed: true, headSha: "c".repeat(40) } },
    { facts: { ...facts, upToDate: false } },
    { facts: { ...facts, strictBaseProtection: false } },
    { facts: { ...facts, filesComplete: false } },
    { facts: { ...facts, checksComplete: false } },
    {
      facts: {
        ...facts,
        files: [
          { path: "src/app.ts", previousPath: ".github/workflows/ci.yml", lineCountsKnown: true },
        ],
      },
    },
    { facts: { ...facts, files: [{ path: "image.png", lineCountsKnown: false }] } },
    { facts: { ...facts, additions: 301 } },
  ])
    expect(evaluateAutopilotMerge({ ...input, ...changed }).allowed).toBe(false);
  expect(() => parseMergePolicy(policyText.replace("coordinator-authored", "any"))).toThrow();
  expect(() => parseMergePolicy(`${policyText}unexpected: true\n`)).toThrow();
});

import {
  capCoordinatorTrust,
  loadMergePolicy,
  mergeCoordinatorPullRequest,
} from "./merge-policy.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runGitCommand } from "../../utils/run-git-command.js";

test("named checks must exist and all instances pass; invalid policy disables Autopilot", () => {
  const policy = parseMergePolicy(
    policyText.replace("required_checks: all", "required_checks: [lint]"),
  );
  const input = {
    policy,
    trustLevel: "autopilot" as const,
    facts,
    coordinatorAuthored: true,
    reviewer: { passed: true, headSha: facts.headSha },
  };
  expect(evaluateAutopilotMerge(input)).toMatchObject({
    allowed: false,
    reason: "Required check is not green: lint",
  });
  expect(
    evaluateAutopilotMerge({
      ...input,
      facts: {
        ...facts,
        checks: [
          { name: "lint", status: "success" },
          { name: "lint", status: "failure" },
        ],
      },
    }).allowed,
  ).toBe(false);
  expect(evaluateAutopilotMerge({ ...input, facts: { ...facts, checks: [] } }).allowed).toBe(false);
  expect(capCoordinatorTrust("autopilot", { policy: null, reason: "Invalid YAML" })).toBe("ship");
  expect(capCoordinatorTrust("ship", { policy: { ...policy, max_trust_level: "observe" } })).toBe(
    "observe",
  );
});

test("committed base policy ignores an uncommitted attempt to widen merge authority", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-merge-policy-"));
  try {
    await runGitCommand(["init"], { cwd: home });
    await mkdir(path.join(home, ".paseo"));
    await writeFile(
      path.join(home, ".paseo", "coordinator.yml"),
      policyText.replace("max_trust_level: autopilot", "max_trust_level: ship"),
    );
    await runGitCommand(["add", ".paseo/coordinator.yml"], { cwd: home });
    await runGitCommand(
      [
        "-c",
        "user.name=Policy Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "Set reviewed policy",
      ],
      { cwd: home },
    );
    const sha = (await runGitCommand(["rev-parse", "HEAD"], { cwd: home })).stdout.trim();
    await writeFile(path.join(home, ".paseo", "coordinator.yml"), policyText);
    expect((await loadMergePolicy(home, sha)).policy?.max_trust_level).toBe("ship");
    await writeFile(path.join(home, ".paseo", "coordinator.yml"), "invalid: [");
    expect((await loadMergePolicy(home)).policy).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("merge wrapper reloads base policy and rejects a forge's queue-only acknowledgement", async () => {
  const calls: string[] = [];
  const policy = parseMergePolicy(policyText);
  const input = {
    cwd: "/repo",
    prNumber: 1,
    policy,
    trustLevel: "autopilot" as const,
    coordinatorAuthored: true,
    reviewer: { passed: true, headSha: facts.headSha },
    forge: {
      getPullRequestMergeFacts: async () => facts,
      mergePullRequest: async (request: { expectedHeadSha?: string }) => {
        calls.push(request.expectedHeadSha!);
        return { success: true as const };
      },
    },
  };
  await expect(
    mergeCoordinatorPullRequest({
      ...input,
      loadPolicyForBase: async (sha) => {
        expect(sha).toBe(facts.baseSha);
        return { policy: { ...policy, max_trust_level: "ship" } };
      },
    }),
  ).rejects.toThrow("policy cap");
  expect(calls).toEqual([]);
  await expect(mergeCoordinatorPullRequest(input)).rejects.toThrow("immediate merge");
  expect(calls).toEqual([facts.headSha]);
});

test("automatic merges cannot rewrite their own policy or CI workflows even with an empty protected list", async () => {
  const policy = parseMergePolicy(policyText);
  policy.merge.protected_paths = [];
  let mergeCalls = 0;
  for (const file of [
    { path: ".paseo/coordinator.yml" },
    { path: "retired-policy.yml", previousPath: ".paseo/coordinator.yml" },
    { path: ".PASEO/COORDINATOR.YML" },
    { path: ".paseo" },
    { path: ".github/workflows/ci.yml" },
    { path: "retired-ci.yml", previousPath: ".github/workflows/ci.yml" },
    { path: ".github/workflows" },
    { path: ".github" },
  ]) {
    await expect(
      mergeCoordinatorPullRequest({
        cwd: "/repo",
        prNumber: 1,
        policy,
        trustLevel: "autopilot",
        coordinatorAuthored: true,
        reviewer: { passed: true, headSha: facts.headSha },
        forge: {
          getPullRequestMergeFacts: async () => ({
            ...facts,
            files: [{ ...file, lineCountsKnown: true }],
          }),
          mergePullRequest: async () => {
            mergeCalls++;
            return { success: true, merged: true };
          },
        },
      }),
    ).rejects.toThrow("human merge");
  }
  expect(mergeCalls).toBe(0);
  expect(
    evaluateAutopilotMerge({
      policy,
      trustLevel: "autopilot",
      coordinatorAuthored: true,
      reviewer: { passed: true, headSha: facts.headSha },
      facts: { ...facts, files: [{ path: ".paseo/memory/learned.md", lineCountsKnown: true }] },
    }).allowed,
  ).toBe(true);
});
