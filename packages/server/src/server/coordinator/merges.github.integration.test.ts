import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createGitHubService } from "../../services/github-service.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTempGithubRepoName } from "../test-utils/temp-github-repo.js";
import { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { archivePersistedWorkspaceRecord } from "../workspace-archive-service.js";
import { CoordinatorMerges, type CoordinatorMergesDeps } from "./merges.js";

const exec = promisify(execFile);
const optedIn = process.env.RUN_PASEO_M7_GITHUB_MERGE === "1";
const policy = `max_trust_level: autopilot
merge:
  enabled: true
  only: coordinator-authored
  required_checks: [smoke]
  max_changed_lines: 300
  protected_paths: [.github/**, .paseo/**]
  method: squash
`;
const workflow = `name: M7 policy smoke
on: pull_request
permissions:
  contents: read
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - name: Verify the exact pull request head
        env:
          REPOSITORY_URL: https://github.com/\${{ github.repository }}.git
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          git init --quiet .
          git remote add origin "$REPOSITORY_URL"
          git fetch --depth=1 origin "$HEAD_SHA"
          git checkout --detach FETCH_HEAD
          test "$(cat result.txt)" = reviewed
`;

// Explicit opt-in only. This test creates, pushes, protects, merges, then deletes ONE namespaced public repo.
// It does not probe provider authentication or change existing repositories/account settings.
test.skipIf(!optedIn)(
  "real GitHub policy merge binds the reviewed head and archives its dedicated workspace",
  async () => {
    const owner = process.env.PASEO_M7_GITHUB_OWNER;
    if (!owner || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner))
      throw new Error("Set PASEO_M7_GITHUB_OWNER to the approved GitHub owner");
    const repoName = createTempGithubRepoName("m7-autopilot");
    const slug = `${owner}/${repoName}`;
    const home = await mkdtemp(path.join(tmpdir(), "paseo-m7-live-"));
    const repo = path.join(home, "repository");
    const worktree = path.join(home, "worker");
    const evidencePath =
      process.env.PASEO_M7_EVIDENCE_PATH ?? path.join(tmpdir(), `${repoName}.json`);
    const evidence: Record<string, unknown> = {
      repository: slug,
      repositoryUrl: `https://github.com/${slug}`,
      evidencePath,
      created: false,
      deleted: false,
    };
    const command = async (file: string, args: string[], cwd = repo) =>
      (
        await exec(file, args, {
          cwd,
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
        })
      ).stdout;
    const git = (args: string[], cwd = repo) => command("git", args, cwd);
    const gh = (args: string[]) => command("gh", args);
    let created = false;
    let primaryError: unknown;
    try {
      await mkdir(path.join(repo, ".paseo"), { recursive: true });
      await mkdir(path.join(repo, ".github/workflows"), { recursive: true });
      await git(["init", "--quiet", "--initial-branch=main"]);
      await git(["config", "user.name", "Paseo temporary integration test"]);
      await git(["config", "user.email", "paseo-test@example.invalid"]);
      await writeFile(path.join(repo, ".paseo/coordinator.yml"), policy);
      await writeFile(path.join(repo, ".github/workflows/smoke.yml"), workflow);
      await writeFile(path.join(repo, "result.txt"), "baseline\n");
      await git(["add", "."]);
      await git(["commit", "--quiet", "-m", "Add committed merge policy and CI fixture"]);
      const baseSha = (await git(["rev-parse", "HEAD"])).trim();
      await gh([
        "repo",
        "create",
        slug,
        "--public",
        "--description",
        "Temporary Paseo M7 policy merge integration test; safe to delete",
        "--source",
        repo,
        "--remote",
        "origin",
      ]);
      created = true;
      evidence.created = true;
      await git(["push", "--set-upstream", "origin", "main"]);
      const protectionPath = path.join(home, "protection.json");
      await writeFile(
        protectionPath,
        JSON.stringify({
          required_status_checks: { strict: true, contexts: ["smoke"] },
          enforce_admins: true,
          required_pull_request_reviews: null,
          restrictions: null,
          allow_force_pushes: false,
          allow_deletions: false,
        }),
      );
      await gh([
        "api",
        "--method",
        "PUT",
        `repos/${slug}/branches/main/protection`,
        "--input",
        protectionPath,
      ]);
      await git(["worktree", "add", "-b", "m7-reviewed-change", worktree, "main"]);
      await writeFile(path.join(worktree, "result.txt"), "reviewed\n");
      await git(["add", "result.txt"], worktree);
      await git(["commit", "--quiet", "-m", "Make the reviewed fixture change"], worktree);
      await git(["push", "--set-upstream", "origin", "m7-reviewed-change"], worktree);
      const headSha = (await git(["rev-parse", "HEAD"], worktree)).trim();
      const forge = createGitHubService({ ttlMs: 0 });
      const pull = await forge.createPullRequest({
        cwd: repo,
        title: "M7 reviewed policy fixture",
        body: "Disposable integration fixture: exact-head review, strict checks, guarded merge, archive.",
        head: "m7-reviewed-change",
        base: "main",
      });
      evidence.pullRequest = pull;
      evidence.reviewedHeadSha = headSha;
      evidence.baseSha = baseSha;
      await expect
        .poll(
          async () => {
            const facts = await forge.getPullRequestMergeFacts!({
              cwd: repo,
              prNumber: pull.number,
            });
            return (
              facts.mergeReady &&
              facts.mergeable &&
              facts.upToDate &&
              facts.strictBaseProtection &&
              facts.checksComplete &&
              facts.checks.some((check) => check.name === "smoke" && check.status === "success") &&
              facts.checks.every((check) => check.status === "success")
            );
          },
          { timeout: 360000, interval: 3000 },
        )
        .toBe(true);
      const readyFacts = await forge.getPullRequestMergeFacts!({
        cwd: repo,
        prNumber: pull.number,
      });
      evidence.readyFacts = readyFacts;
      await expect(
        forge.mergePullRequest({
          cwd: repo,
          prNumber: pull.number,
          mergeMethod: "squash",
          expectedHeadSha: "0".repeat(40),
        }),
      ).rejects.toThrow();
      expect(
        (await forge.getPullRequestMergeFacts!({ cwd: repo, prNumber: pull.number })).state,
      ).toBe("open");
      evidence.staleHeadRejected = true;
      const registry = new FileBackedWorkspaceRegistry(
        path.join(home, "workspaces.json"),
        createTestLogger(),
      );
      const timestamp = new Date().toISOString();
      await registry.upsert({
        workspaceId: "worker-workspace",
        projectId: "project",
        cwd: worktree,
        kind: "worktree",
        displayName: "M7 fixture",
        title: null,
        branch: "m7-reviewed-change",
        worktreeRoot: worktree,
        baseBranch: "main",
        isPaseoOwnedWorktree: true,
        mainRepoRoot: repo,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        autoArchivedChangeRequestUrl: null,
      });
      const done: string[] = [];
      const deps: CoordinatorMergesDeps = {
        paseoHome: home,
        now: Date.now,
        resolveActor: async (id) => ({
          projectId: "project",
          coordinatorAgentId: "coordinator",
          trustLevel: "autopilot",
          cwd: repo,
          workspaceId: id === "coordinator" ? "owner-workspace" : "reviewer-workspace",
          kind: id === "reviewer" ? "reviewer" : "coordinator",
        }),
        resolveForge: async () => forge,
        policyBase: async () => ({ cwd: repo, baseSha }),
        workspaceForHead: async (projectId, head) =>
          projectId === "project" && head === "m7-reviewed-change"
            ? { workspaceId: "worker-workspace", cwd: worktree }
            : null,
        authorizeMerge: async (_project, _owner, run) => run(),
        appendDone: async (_project, text, refs, dedupe) => {
          done.push(text);
          await writeFile(path.join(home, "done.json"), JSON.stringify({ text, refs, dedupe }));
        },
        archiveWorkspace: async (id) => {
          expect(id).toBe("worker-workspace");
          await git(["worktree", "remove", worktree]);
          await archivePersistedWorkspaceRecord({ workspaceId: id, workspaceRegistry: registry });
        },
        attention: async (_project, reason) => {
          throw new Error(reason);
        },
      };
      const service = new CoordinatorMerges(deps);
      await service.initialize();
      // A deterministic independent reviewer inspects the actual diff before recording an explicit verdict.
      expect((await git(["diff", "--name-only", `${baseSha}...${headSha}`])).trim()).toBe(
        "result.txt",
      );
      expect(await readFile(path.join(worktree, "result.txt"), "utf8")).toBe("reviewed\n");
      await service.recordReview({ callerAgentId: "reviewer", headSha, passed: true });
      await service.recordCreated({
        callerAgentId: "coordinator",
        reviewerAgentId: "reviewer",
        cwd: repo,
        number: pull.number,
        url: pull.url,
        head: "m7-reviewed-change",
      });
      const merged = await service.merge({ callerAgentId: "coordinator", number: pull.number });
      expect(merged.headSha).toBe(headSha);
      const confirmed = JSON.parse(await gh(["api", `repos/${slug}/pulls/${pull.number}`])) as {
        merged: boolean;
        merge_commit_sha: string;
      };
      expect(confirmed.merged).toBe(true);
      expect(done).toEqual([`Merged #${pull.number} under policy`]);
      expect((await registry.get("worker-workspace"))?.archivedAt).toBeTruthy();
      const reloadedRegistry = new FileBackedWorkspaceRegistry(
        path.join(home, "workspaces.json"),
        createTestLogger(),
      );
      expect((await reloadedRegistry.get("worker-workspace"))?.archivedAt).toBeTruthy();
      evidence.merge = confirmed;
      evidence.done = done;
      evidence.archivedWorkspace = await reloadedRegistry.get("worker-workspace");
      evidence.passed = true;
    } catch (error) {
      primaryError = error;
      evidence.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (created) {
        try {
          await gh(["repo", "delete", slug, "--yes"]);
          evidence.deleted = true;
        } catch (error) {
          evidence.cleanupError = error instanceof Error ? error.message : String(error);
          primaryError ??= error;
        }
      }
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
      process.stdout.write(`M7 GitHub evidence: ${evidencePath}\n`);
      await rm(home, { recursive: true, force: true });
    }
    if (primaryError) throw primaryError;
  },
  480000,
);
