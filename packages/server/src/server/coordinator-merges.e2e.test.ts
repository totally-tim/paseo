import { runGitCommand } from "../utils/run-git-command.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "./test-utils/daemon-test-context.js";
let context: DaemonTestContext | null = null;
const directories: string[] = [];
afterEach(async () => {
  await context?.cleanup();
  context = null;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("daemon caps unverifiable Autopilot before launch, persists one Needs you issue, and verifies reviewer lineage", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "merge-daemon-home-"));
  directories.push(paseoHomeRoot);
  context = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
  const cwd = await mkdtemp(path.join(tmpdir(), "merge-policy-project-"));
  directories.push(cwd);
  const opened = await context.client.openProject(cwd);
  const workspace = opened.workspace!;
  const enabled = await context.client.enableProjectCoordinator({
    projectId: workspace.projectId,
    profile: { provider: "opencode" },
    trustLevel: "autopilot",
  });
  expect(enabled.coordinator?.trustLevel).toBe("ship");
  const daemon = context.daemon.daemon;
  const ownerId = enabled.coordinator!.agentId!;
  expect(daemon.agentManager.getAgent(ownerId)?.labels["paseo.coordinator.trust"]).toBe("ship");
  await context.client.updateProjectCoordinator({
    projectId: workspace.projectId,
    trustLevel: "autopilot",
  });
  const board = await daemon.coordinatorService.getBoardSnapshot(workspace.projectId);
  expect(board.needsYou.filter((row) => row.requestId.startsWith("merge-policy:"))).toHaveLength(1);
  const saved = JSON.parse(
    await readFile(
      path.join(context.daemon.paseoHome, "coordinator", "board", `${workspace.projectId}.json`),
      "utf8",
    ),
  );
  expect(saved.attention).toHaveLength(1);
  const reviewer = await daemon.agentManager.createAgent({ provider: "opencode", cwd }, undefined, {
    workspaceId: workspace.id,
    labels: { "paseo.parent-agent-id": ownerId, "paseo.coordinator.subagent-kind": "reviewer" },
  });
  await daemon.coordinatorService.recordCoordinatorReview({
    callerAgentId: reviewer.id,
    headSha: "a".repeat(40),
    passed: true,
  });
  const unrelated = await daemon.agentManager.createAgent(
    { provider: "opencode", cwd },
    undefined,
    {
      workspaceId: workspace.id,
      labels: { "paseo.coordinator.subagent-kind": "reviewer" },
    },
  );
  await expect(
    daemon.coordinatorService.recordCoordinatorReview({
      callerAgentId: unrelated.id,
      headSha: "a".repeat(40),
      passed: true,
    }),
  ).rejects.toThrow("lineage");
  await context.cleanup();
  context = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
  const restored = context.daemon.daemon.coordinatorService;
  const restoredBoard = await restored.getBoardSnapshot(workspace.projectId);
  const issues = restoredBoard.needsYou.filter((row) => row.requestId.startsWith("merge-policy:"));
  expect(issues).toHaveLength(1);
  expect(issues[0]!.actions[0]?.label).toBe("Dismiss");
  await context.client.respondToPermissionAndWait(ownerId, issues[0]!.requestId, {
    behavior: "deny",
    selectedActionId: "dismiss",
  });
  expect(
    (await restored.getBoardSnapshot(workspace.projectId)).needsYou.filter((row) =>
      row.requestId.startsWith("merge-policy:"),
    ),
  ).toHaveLength(0);
  expect((await restored.getProjectCoordinator(workspace.projectId))?.trustLevel).toBe("ship");
  await expect(
    restored.mergeCoordinatorPullRequest({ callerAgentId: ownerId, number: 1 }),
  ).rejects.toThrow("Autopilot");
  await context.client.disableProjectCoordinator(workspace.projectId);
  await expect(
    restored.recordCoordinatorReview({
      callerAgentId: reviewer.id,
      headSha: "a".repeat(40),
      passed: true,
    }),
  ).rejects.toThrow("inactive");
}, 60000);

const mergePolicy =
  "max_trust_level: autopilot\nmerge:\n  enabled: true\n  only: coordinator-authored\n  required_checks: all\n  max_changed_lines: 300\n  protected_paths: [.github/**]\n  method: squash\n";
test("daemon trust uses origin default commit rather than dirty or candidate-branch policy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-committed-policy-"));
  directories.push(directory);
  const cwd = path.join(directory, "checkout");
  const origin = path.join(directory, "origin.git");
  await mkdir(cwd);
  const git = (args: string[]) => runGitCommand(args, { cwd });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  await mkdir(path.join(cwd, ".paseo"));
  const policyFile = path.join(cwd, ".paseo", "coordinator.yml");
  await writeFile(
    policyFile,
    mergePolicy.replace("max_trust_level: autopilot", "max_trust_level: ship"),
  );
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Committed policy",
  ]);
  await git(["remote", "add", "origin", origin]);
  await git(["push", "--quiet", "origin", "main"]);
  await writeFile(policyFile, mergePolicy);
  const paseoHomeRoot = path.join(directory, "daemon");
  context = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
  const opened = await context.client.openProject(cwd);
  const projectId = opened.workspace!.projectId;
  const enabled = await context.client.enableProjectCoordinator({
    projectId,
    profile: { provider: "opencode" },
    trustLevel: "autopilot",
  });
  expect(enabled.coordinator?.trustLevel).toBe("ship");
  await git(["checkout", "--quiet", "-b", "candidate"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Candidate cannot widen policy",
  ]);
  const updated = await context.client.updateProjectCoordinator({
    projectId,
    trustLevel: "autopilot",
  });
  expect(updated.coordinator?.trustLevel).toBe("ship");
  expect(
    context.daemon.daemon.agentManager.getAgent(enabled.coordinator!.agentId!)?.labels[
      "paseo.coordinator.trust"
    ],
  ).toBe("ship");
  await git(["push", "--quiet", "origin", "candidate:main"]);
  expect(
    (await context.client.updateProjectCoordinator({ projectId, trustLevel: "autopilot" }))
      .coordinator?.trustLevel,
  ).toBe("autopilot");
  await writeFile(
    policyFile,
    mergePolicy.replace("max_trust_level: autopilot", "max_trust_level: ship"),
  );
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Lower committed policy",
  ]);
  await git(["push", "--quiet", "origin", "candidate:main"]);
  await context.cleanup();
  context = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
  await expect
    .poll(
      async () =>
        (await context!.daemon.daemon.coordinatorService.getProjectCoordinator(projectId))
          ?.trustLevel,
    )
    .toBe("ship");
  const owner = await context.daemon.daemon.agentStorage.get(enabled.coordinator!.agentId!);
  expect(owner?.labels["paseo.coordinator.trust"]).toBe("ship");
  expect(owner?.config.systemPrompt).toContain("Ship trust level");
}, 60000);

test("confirmed coordinator merge appends Done and archives its original dedicated worktree through daemon workflow", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-workflow-"));
  directories.push(directory);
  const cwd = path.join(directory, "checkout");
  const origin = path.join(directory, "origin.git");
  await mkdir(cwd);
  const git = (args: string[]) => runGitCommand(args, { cwd });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  await mkdir(path.join(cwd, ".paseo"));
  await writeFile(path.join(cwd, ".paseo", "coordinator.yml"), mergePolicy);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Policy",
  ]);
  await git(["remote", "add", "origin", origin]);
  await git(["push", "--quiet", "origin", "main"]);
  const baseSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  let headSha = baseSha;
  let merged = false;
  let mergeCalls = 0;
  context = await createDaemonTestContext({
    dependencies: {
      coordinatorMergeForge: async () => ({
        getPullRequestMergeFacts: async () => ({
          headSha,
          baseSha,
          state: merged ? "merged" : "open",
          draft: false,
          mergeable: true,
          mergeReady: true,
          upToDate: true,
          strictBaseProtection: true,
          additions: 1,
          deletions: 0,
          filesComplete: true,
          files: [{ path: "result.txt", lineCountsKnown: true }],
          checksComplete: true,
          checks: [{ name: "test", status: "success" }],
        }),
        mergePullRequest: async (input) => {
          expect(input.expectedHeadSha).toBe(headSha);
          mergeCalls++;
          merged = true;
          return { success: true, merged: true };
        },
      }),
    },
  });
  const opened = await context.client.openProject(cwd);
  const projectId = opened.workspace!.projectId;
  const enabled = await context.client.enableProjectCoordinator({
    projectId,
    profile: { provider: "opencode" },
    trustLevel: "autopilot",
  });
  expect(enabled.coordinator?.trustLevel).toBe("autopilot");
  const ownerId = enabled.coordinator!.agentId!;
  const created = await context.client.createPaseoWorktree({
    cwd,
    projectId,
    worktreeSlug: "merge-worker",
    action: "branch-off",
    refName: "main",
  });
  expect(created.error).toBeNull();
  const workerWorkspace = created.workspace!;
  await writeFile(path.join(workerWorkspace.workspaceDirectory!, "result.txt"), "verified\n");
  const workerGit = (args: string[]) =>
    runGitCommand(args, { cwd: workerWorkspace.workspaceDirectory! });
  await workerGit(["add", "."]);
  await workerGit([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Worker result",
  ]);
  headSha = (await workerGit(["rev-parse", "HEAD"])).stdout.trim();
  const branch = (await workerGit(["branch", "--show-current"])).stdout.trim();
  await workerGit(["push", "--quiet", "--set-upstream", "origin", branch]);
  const daemon = context.daemon.daemon;
  const reviewer = await daemon.agentManager.createAgent(
    { provider: "opencode", cwd: workerWorkspace.workspaceDirectory! },
    undefined,
    {
      workspaceId: workerWorkspace.id,
      labels: { "paseo.parent-agent-id": ownerId, "paseo.coordinator.subagent-kind": "reviewer" },
    },
  );
  const service = daemon.coordinatorService;
  await service.recordCoordinatorCreatedPullRequest({
    callerAgentId: ownerId,
    reviewerAgentId: reviewer.id,
    cwd,
    number: 43,
    url: "https://example.invalid/pull/43",
    head: branch,
  });
  await service.recordCoordinatorReview({ callerAgentId: reviewer.id, headSha, passed: true });
  expect(
    await service.mergeCoordinatorPullRequest({ callerAgentId: ownerId, number: 43 }),
  ).toMatchObject({ merged: true, headSha });
  expect(mergeCalls).toBe(1);
  expect(
    (await service.getBoardSnapshot(projectId)).done.some(
      (row) => row.text === "Merged #43 under policy",
    ),
  ).toBe(true);
  const registry = JSON.parse(
    await readFile(path.join(context.daemon.paseoHome, "projects", "workspaces.json"), "utf8"),
  );
  expect(
    (registry as Array<{ workspaceId: string; archivedAt?: string }>).find(
      (record) => record.workspaceId === workerWorkspace.id,
    )?.archivedAt,
  ).toBeTruthy();
}, 60000);

test("remote policy advances fetch exact objects while outages preserve trust and readable invalid policy demotes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "merge-policy-fetch-"));
  directories.push(directory);
  const cwd = path.join(directory, "daemon-checkout");
  const other = path.join(directory, "other-clone");
  const origin = path.join(directory, "origin.git");
  await mkdir(cwd);
  const git = (args: string[], root = cwd) => runGitCommand(args, { cwd: root });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  await mkdir(path.join(cwd, ".paseo"));
  await writeFile(path.join(cwd, ".paseo/coordinator.yml"), mergePolicy);
  const commit = async (root: string, message: string) => {
    await git(["add", "."], root);
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        message,
      ],
      root,
    );
  };
  await commit(cwd, "Policy");
  await git(["remote", "add", "origin", origin]);
  await git(["push", "--quiet", "origin", "main"]);
  const original = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["clone", "--quiet", origin, other]);
  context = await createDaemonTestContext();
  const opened = await context.client.openProject(cwd);
  const projectId = opened.workspace!.projectId;
  const enabled = await context.client.enableProjectCoordinator({
    projectId,
    profile: { provider: "opencode" },
    trustLevel: "autopilot",
  });
  const service = context.daemon.daemon.coordinatorService;
  expect(enabled.coordinator?.trustLevel).toBe("autopilot");
  let releaseLookup!: () => void;
  let enteredLookup!: () => void;
  const lookupBarrier = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const lookupEntered = new Promise<void>((resolve) => {
    enteredLookup = resolve;
  });
  const policyReader = service as unknown as {
    mergePolicyBase(projectId: string): Promise<{ cwd: string; baseSha: string }>;
  };
  const originalRead = policyReader.mergePolicyBase.bind(service);
  const read = vi.spyOn(policyReader, "mergePolicyBase").mockImplementation(async (id) => {
    enteredLookup();
    await lookupBarrier;
    return originalRead(id);
  });
  const pendingLookup = service.reconcileMergePolicies(true);
  await lookupEntered;
  try {
    const reduced = await context.client.updateProjectCoordinator({
      projectId,
      trustLevel: "ship",
    });
    expect(reduced.coordinator?.trustLevel).toBe("ship");
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    releaseLookup();
    await pendingLookup;
    read.mockRestore();
  }
  expect((await service.getProjectCoordinator(projectId))?.trustLevel).toBe("ship");
  await context.client.updateProjectCoordinator({ projectId, trustLevel: "autopilot" });
  await writeFile(path.join(other, "external.txt"), "external merge result");
  await commit(other, "Advance default from another clone");
  await git(["push", "--quiet", "origin", "main"], other);
  const advanced = (await git(["rev-parse", "HEAD"], other)).stdout.trim();
  await expect(git(["cat-file", "-e", `${advanced}^{commit}`])).rejects.toThrow();
  await service.reconcileMergePolicies(true);
  expect((await service.getProjectCoordinator(projectId))?.trustLevel).toBe("autopilot");
  await git(["cat-file", "-e", `${advanced}^{commit}`]);
  expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(original);
  expect((await git(["show", `${advanced}:.paseo/coordinator.yml`])).stdout).toBe(mergePolicy);
  await git(["remote", "set-url", "origin", path.join(directory, "temporarily-unreachable")]);
  expect(
    (await context.client.updateProjectCoordinator({ projectId, scope: "project" })).coordinator
      ?.trustLevel,
  ).toBe("autopilot");
  await service.reconcileMergePolicies(true);
  expect((await service.getProjectCoordinator(projectId))?.trustLevel).toBe("autopilot");
  await context.client.updateProjectCoordinator({ projectId, trustLevel: "ship" });
  expect(
    (await context.client.updateProjectCoordinator({ projectId, trustLevel: "autopilot" }))
      .coordinator?.trustLevel,
  ).toBe("ship");
  await git(["remote", "set-url", "origin", origin]);
  expect(
    (await context.client.updateProjectCoordinator({ projectId, trustLevel: "autopilot" }))
      .coordinator?.trustLevel,
  ).toBe("autopilot");
  await writeFile(path.join(other, ".paseo/coordinator.yml"), "invalid: [");
  await commit(other, "Invalid committed policy");
  await git(["push", "--quiet", "origin", "main"], other);
  await service.reconcileMergePolicies(true);
  expect((await service.getProjectCoordinator(projectId))?.trustLevel).toBe("ship");
  const owner = context.daemon.daemon.agentManager.getAgent(enabled.coordinator!.agentId!);
  expect(owner?.labels["paseo.coordinator.trust"]).toBe("ship");
  expect(owner?.config.systemPrompt).toContain("Ship trust level");
  const board = await service.getBoardSnapshot(projectId);
  expect(board.wake?.text).toBe("Trust: now at Ship");
  expect(board.needsYou.some((row) => row.requestId.startsWith("merge-policy:"))).toBe(true);
}, 60000);
