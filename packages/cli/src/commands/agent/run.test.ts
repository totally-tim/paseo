import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAgentSpawnIsolation,
  resolveAgentSpawnIsolation,
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  resolveRunWorkspace,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

describe("agent-spawned workspace isolation", () => {
  const originalEnv: Array<
    ["PASEO_AGENT_ID" | "PASEO_WORKSPACE_ID" | "PASEO_AGENT_SPAWN_ISOLATION", string | undefined]
  > = [
    ["PASEO_AGENT_ID", process.env.PASEO_AGENT_ID],
    ["PASEO_WORKSPACE_ID", process.env.PASEO_WORKSPACE_ID],
    ["PASEO_AGENT_SPAWN_ISOLATION", process.env.PASEO_AGENT_SPAWN_ISOLATION],
  ];
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.PASEO_AGENT_ID = "caller-agent";
    delete process.env.PASEO_WORKSPACE_ID;
    delete process.env.PASEO_AGENT_SPAWN_ISOLATION;
    stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    stderr.mockRestore();
  });

  it("enables isolation only for the worktree value", () => {
    expect(resolveAgentSpawnIsolation({ PASEO_AGENT_SPAWN_ISOLATION: " worktree " })).toBe(
      "worktree",
    );
    expect(resolveAgentSpawnIsolation({})).toBeUndefined();
    expect(resolveAgentSpawnIsolation({ PASEO_AGENT_SPAWN_ISOLATION: "  " })).toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("warns on stderr when the isolation value is not recognised", () => {
    expect(
      resolveAgentSpawnIsolation({ PASEO_AGENT_SPAWN_ISOLATION: "container" }),
    ).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring PASEO_AGENT_SPAWN_ISOLATION=container"),
    );
  });

  it("mints a worktree workspace instead of sharing the caller checkout", async () => {
    process.env.PASEO_AGENT_SPAWN_ISOLATION = "worktree";
    const createWorkspace = vi.fn().mockResolvedValue({
      workspace: { id: "ws-wt", name: "run", workspaceDirectory: "/wt/run" },
    });

    await expect(
      resolveRunWorkspace(
        { createWorkspace, fetchWorkspaces: vi.fn() },
        applyAgentSpawnIsolation({}),
        "/repo/main",
      ),
    ).resolves.toEqual({ id: "ws-wt", cwd: "/wt/run" });
    expect(createWorkspace).toHaveBeenCalledWith({
      source: { kind: "worktree", cwd: "/repo/main", action: "branch-off" },
    });
  });

  it("keeps explicit placement ahead of the isolation default", () => {
    process.env.PASEO_AGENT_SPAWN_ISOLATION = "worktree";
    expect(applyAgentSpawnIsolation({ workspace: "ws-1" })).toEqual({ workspace: "ws-1" });
    expect(applyAgentSpawnIsolation({ newWorkspace: "local" })).toEqual({ newWorkspace: "local" });
    expect(applyAgentSpawnIsolation({ worktree: "slug" })).toEqual({ worktree: "slug" });
  });

  it("applies the isolation default only to agent-spawned runs", () => {
    process.env.PASEO_AGENT_SPAWN_ISOLATION = "worktree";
    expect(applyAgentSpawnIsolation({ branch: "feature/x" })).toEqual({
      branch: "feature/x",
      newWorkspace: "worktree",
    });
    delete process.env.PASEO_AGENT_ID;
    expect(applyAgentSpawnIsolation({ branch: "feature/x" })).toEqual({ branch: "feature/x" });
  });

  it("shares the caller checkout and names the alternative by default", async () => {
    const createWorkspace = vi.fn();

    await expect(
      resolveRunWorkspace({ createWorkspace, fetchWorkspaces: vi.fn() }, {}, "/repo/main"),
    ).resolves.toEqual({ cwd: "/repo/main" });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--new-workspace worktree"));
  });

  it("leaves an explicit --new-workspace ahead of the caller checkout", async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      workspace: { id: "ws-local", name: "run", workspaceDirectory: "/repo/main" },
    });

    await resolveRunWorkspace(
      { createWorkspace, fetchWorkspaces: vi.fn() },
      { newWorkspace: "local" } as AgentRunOptions,
      "/repo/main",
    );
    expect(createWorkspace).toHaveBeenCalledWith({
      source: { kind: "directory", path: "/repo/main" },
    });
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(options: AgentRunOptions, messageMatch: RegExp) {
    await expect(runRunCommand("do something", options, {} as never)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand("do something", { newWorkspace: "worktree", provider: undefined }, {} as never),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("accepts worktree options when the isolation default supplies the kind", async () => {
    const saved = [process.env.PASEO_AGENT_ID, process.env.PASEO_AGENT_SPAWN_ISOLATION];
    process.env.PASEO_AGENT_ID = "caller-agent";
    process.env.PASEO_AGENT_SPAWN_ISOLATION = "worktree";
    try {
      // Clears validation and fails later (no daemon), which proves the
      // worktree options were not rejected for lack of --new-workspace.
      await expect(
        runRunCommand(
          "do something",
          { worktreeMode: "checkout-branch", branch: "feature/x" },
          {} as never,
        ),
      ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
      delete process.env.PASEO_AGENT_SPAWN_ISOLATION;
      await expectInvalidOptions(
        { worktreeMode: "checkout-branch", branch: "feature/x" },
        /Worktree options require --new-workspace worktree/,
      );
    } finally {
      for (const [name, value] of [
        ["PASEO_AGENT_ID", saved[0]],
        ["PASEO_AGENT_SPAWN_ISOLATION", saved[1]],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});
