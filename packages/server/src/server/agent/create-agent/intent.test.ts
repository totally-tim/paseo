import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { resolveCreateAgentIntent } from "./intent.js";

describe("resolveCreateAgentIntent", () => {
  it("keeps caller parentage when an explicit workspace changes placement", async () => {
    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: "workspace-isolated",
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      labels: { purpose: "review" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/isolated" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-isolated",
      cwd: "/isolated",
      parentAgentId: "parent-agent",
      labels: {
        purpose: "review",
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
      },
    });
  });

  it("defaults an agent caller to its workspace without creating one", async () => {
    let createCount = 0;
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => {
        createCount += 1;
        return { workspaceId: "workspace-created", cwd: "/created" };
      },
    });

    expect(intent.workspaceId).toBe("workspace-parent");
    expect(intent.cwd).toBe("/parent");
    expect(intent.parentAgentId).toBe("parent-agent");
    expect(createCount).toBe(0);
  });

  it("creates a workspace for a human caller with no workspace context", async () => {
    const intent = await resolveCreateAgentIntent({
      caller: null,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-created",
      cwd: "/created",
      parentAgentId: null,
      labels: {},
    });
  });

  it("mints a fresh workspace for a caller that asked for one, inside the caller's gate", async () => {
    let createCount = 0;
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      preferCreateWorkspace: true,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => {
        createCount += 1;
        return { workspaceId: "workspace-created", cwd: "/requested-dir" };
      },
    });

    expect(intent.workspaceId).toBe("workspace-created");
    expect(intent.cwd).toBe("/requested-dir");
    expect(intent.parentAgentId).toBe("parent-agent");
    expect(createCount).toBe(1);
  });

  it("an explicit workspace still wins over preferCreateWorkspace", async () => {
    let createCount = 0;
    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: "workspace-isolated",
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      preferCreateWorkspace: true,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/isolated" }),
      createWorkspace: async () => {
        createCount += 1;
        return { workspaceId: "workspace-created", cwd: "/created" };
      },
    });

    expect(intent.workspaceId).toBe("workspace-isolated");
    expect(createCount).toBe(0);
  });

  it("keeps legacy detached creation independent", async () => {
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      labels: { [PARENT_AGENT_ID_LABEL]: "spoofed-parent" },
      legacyDetached: true,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-parent",
      cwd: "/parent",
      parentAgentId: null,
      labels: {},
    });
  });
});
