import { expect, test } from "vitest";
import { readGitHubAutopilotFacts } from "./github-autopilot.js";
import { createGitHubService } from "./github-service.js";
import { evaluateAutopilotMerge, parseMergePolicy } from "../server/coordinator/merge-policy.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
function fixture(changedHead = false) {
  let reads = 0;
  const pull = {
    head: { sha: head },
    base: { sha: base, ref: "main" },
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    additions: 10,
    deletions: 2,
    changed_files: 1,
  };
  return {
    get: async (endpoint: string): Promise<unknown> => {
      if (endpoint.endsWith("/pulls/1")) {
        reads++;
        return changedHead && reads > 1 ? { ...pull, head: { sha: "c".repeat(40) } } : pull;
      }
      if (endpoint.includes("/files?"))
        return [
          [
            {
              filename: "src/a.ts",
              previous_filename: ".github/a.ts",
              additions: 10,
              deletions: 2,
              patch: "@@ text diff",
            },
          ],
        ];
      if (endpoint.includes("/check-runs?"))
        return [
          {
            total_count: 1,
            check_runs: [{ name: "CI", status: "completed", conclusion: "success" }],
          },
        ];
      if (endpoint.includes("/statuses?"))
        return [
          [
            { context: "lint", state: "success", created_at: "2026-09-13T10:00:00Z" },
            { context: "lint", state: "failure", created_at: "2026-09-12T10:00:00Z" },
          ],
        ];
      if (endpoint.includes("/compare/")) return { status: "ahead" };
      if (endpoint.endsWith("/protection"))
        return { required_status_checks: { strict: true }, enforce_admins: { enabled: true } };
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };
}
test("GitHub merge facts retain renamed paths and reject head movement during pagination", async () => {
  const facts = await readGitHubAutopilotFacts(fixture(), "owner/repo", 1);
  expect(facts).toMatchObject({
    headSha: head,
    baseSha: base,
    filesComplete: true,
    checksComplete: true,
    strictBaseProtection: true,
    files: [{ path: "src/a.ts", previousPath: ".github/a.ts", lineCountsKnown: true }],
    checks: [
      { name: "CI", status: "success" },
      { name: "lint", status: "success" },
    ],
  });
  await expect(readGitHubAutopilotFacts(fixture(true), "owner/repo", 1)).rejects.toThrow("moved");
});
test("guarded GitHub merge sends the expected SHA and requires immediate merge confirmation", async () => {
  const calls: string[][] = [];
  let merged = true;
  const service = createGitHubService({
    resolveGhPath: async () => "/fake/gh",
    resolveRepoHost: async () => "github.example",
    resolveRepoSlug: async () => "owner/repo",
    runner: async (args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ merged }), stderr: "" };
    },
  });
  expect(
    await service.mergePullRequest({
      cwd: "/repo",
      prNumber: 1,
      mergeMethod: "squash",
      expectedHeadSha: head,
    }),
  ).toEqual({ success: true, merged: true });
  expect(calls).toEqual([
    [
      "api",
      "--method",
      "PUT",
      "repos/owner/repo/pulls/1/merge",
      "-f",
      `sha=${head}`,
      "-f",
      "merge_method=squash",
    ],
  ]);
  merged = false;
  await expect(
    service.mergePullRequest({
      cwd: "/repo",
      prNumber: 1,
      mergeMethod: "squash",
      expectedHeadSha: head,
    }),
  ).rejects.toThrow("immediate merge");
});

test("GitHub merged PR facts distinguish a confirmed merge from an unmerged closed PR for recovery", async () => {
  const api = fixture();
  for (const merged of [true, false]) {
    const facts = await readGitHubAutopilotFacts(
      {
        get: async (endpoint) => {
          const result = await api.get(endpoint);
          return endpoint.endsWith("/pulls/1")
            ? { ...(result as Record<string, unknown>), state: "closed", merged }
            : result;
        },
      },
      "owner/repo",
      1,
    );
    expect(facts.state).toBe(merged ? "merged" : "closed");
  }
});

const requiredCheckPolicy = parseMergePolicy(`max_trust_level: autopilot
merge:
  enabled: true
  only: coordinator-authored
  required_checks: all
  max_changed_lines: 300
  protected_paths: []
  method: squash
`);

test.each([
  { source: "contexts", reported: "absent" },
  { source: "checks", reported: "absent" },
  { source: "contexts", reported: "pending" },
  { source: "checks", reported: "pending" },
  { source: "checks", reported: "success" },
])(
  "required $source context is enforced when $reported despite clean merge state",
  async ({ source, reported }) => {
    const api = fixture();
    const facts = await readGitHubAutopilotFacts(
      {
        get: async (endpoint) => {
          if (endpoint.includes("/files?"))
            return [[{ filename: "src/a.ts", additions: 10, deletions: 2, patch: "@@ text diff" }]];
          if (endpoint.endsWith("/protection"))
            return {
              required_status_checks: {
                strict: true,
                contexts: source === "contexts" ? ["delayed-CI"] : [],
                checks: source === "checks" ? [{ context: "delayed-CI", app_id: 123 }] : [],
              },
              enforce_admins: { enabled: true },
            };
          if (endpoint.includes("/statuses?"))
            return [
              [
                { context: "lint", state: "success", created_at: "2026-09-13T10:00:00Z" },
                ...(reported === "absent"
                  ? []
                  : [
                      {
                        context: "delayed-CI",
                        state: reported,
                        created_at: "2026-09-13T10:00:00Z",
                      },
                    ]),
              ],
            ];
          return api.get(endpoint);
        },
      },
      "owner/repo",
      1,
    );
    expect(facts.mergeReady).toBe(reported === "success");
    expect(facts.checksComplete).toBe(true);
    expect(facts.checks).toEqual([
      { name: "CI", status: "success" },
      { name: "lint", status: "success" },
      { name: "delayed-CI", status: reported === "success" ? "success" : "pending" },
    ]);
    for (const policy of [
      requiredCheckPolicy,
      { ...requiredCheckPolicy, merge: { ...requiredCheckPolicy.merge, required_checks: ["CI"] } },
    ]) {
      expect(
        evaluateAutopilotMerge({
          policy,
          trustLevel: "autopilot",
          facts,
          coordinatorAuthored: true,
          reviewer: { passed: true, headSha: head },
        }),
      ).toEqual(
        reported === "success"
          ? { allowed: true, expectedHeadSha: head, method: "squash" }
          : {
              allowed: false,
              reason: "The forge does not report an open, ready, mergeable change request",
            },
      );
    }
  },
);
