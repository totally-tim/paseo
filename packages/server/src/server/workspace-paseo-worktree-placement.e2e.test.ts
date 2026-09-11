import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { MockLoadTestAgentClient } from "./agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

// A Paseo-owned worktree is never a project root (docs/data-model.md). Both
// ways a client can hand the daemon a bare worktree path must land under the
// main checkout's project: workspace.create with a directory source (what a
// bare `paseo run` does first) and createAgent with only a cwd (old clients,
// agent-scoped creates that lost their caller id). Each still gets its own
// sibling workspace on the worktree; before this contract each also minted a
// sidebar project rooted at the worktree directory.

function createGitRepo(): { repoDir: string; tempRoot: string } {
  // realpath: the daemon reports git roots as git resolves them, and macOS
  // puts the temp dir behind a /private symlink.
  const tempRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "workspace-paseo-worktree-placement-")),
  );
  const repoDir = path.join(tempRoot, "repo");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { repoDir, tempRoot };
}

test("a bare path inside a Paseo worktree resolves to the worktree's workspace and project", async () => {
  const daemon = await createTestPaseoDaemon({
    // The mock provider is registered in dev builds only.
    isDev: true,
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  const { repoDir, tempRoot } = createGitRepo();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({
      metadataGeneration: { providers: [{ provider: "mock", model: "ten-second-stream" }] },
    });

    const created = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repoDir,
        action: "branch-off",
        branchName: "review/external-gate",
        worktreeSlug: "lawful-armadillo",
        baseBranch: "main",
      },
    });
    expect(created.error).toBeNull();
    const worktreeWorkspaceId = created.workspace?.id;
    const worktreeDir = created.workspace?.workspaceDirectory;
    if (!worktreeWorkspaceId || !worktreeDir) {
      throw new Error("worktree workspace was not created");
    }

    const projectsBefore = (await client.listProjects()).projects;
    expect(projectsBefore.map((project) => project.projectRootPath)).toEqual([repoDir]);

    const reopened = await client.createWorkspace({
      source: { kind: "directory", path: worktreeDir },
    });
    expect(reopened.error).toBeNull();
    expect(reopened.workspace?.id).not.toBe(worktreeWorkspaceId);

    const agent = await client.createAgent({
      provider: "mock",
      cwd: worktreeDir,
      model: "ten-second-stream",
      title: "[Review] external gate",
    });
    expect(agent.workspaceId).not.toBe(worktreeWorkspaceId);

    const projectsAfter = (await client.listProjects()).projects;
    expect(projectsAfter.map((project) => project.projectId)).toEqual(
      projectsBefore.map((project) => project.projectId),
    );
    const workspaces = await client.fetchWorkspaces();
    const onWorktree = workspaces.entries.filter(
      (entry) => entry.workspaceDirectory === worktreeDir,
    );
    expect(onWorktree.map((entry) => entry.id).sort()).toEqual(
      [worktreeWorkspaceId, reopened.workspace?.id, agent.workspaceId].sort(),
    );
    for (const entry of onWorktree) {
      expect(entry.projectId).toBe(projectsBefore[0]?.projectId);
    }
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 180000);
