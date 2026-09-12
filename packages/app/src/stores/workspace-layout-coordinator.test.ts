import { describe, expect, it } from "vitest";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import {
  collectAllTabs,
  createDefaultLayout,
  reconcileWorkspaceTabs,
  type WorkspaceTabReconcileState,
  type WorkspaceTabSnapshot,
} from "@/stores/workspace-layout-actions";

function makeSnapshot(overrides: Partial<WorkspaceTabSnapshot> = {}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: [],
    autoOpenAgentIds: [],
    knownAgentIds: [],
    standaloneTerminalIds: [],
    hasActivePendingTerminalCreate: false,
    hasActivePendingDraftCreate: false,
    ...overrides,
  };
}

function makeState(layout: WorkspaceTabReconcileState["layout"]): WorkspaceTabReconcileState {
  return { layout, explorerSidebarPaneId: null };
}

function tabTargets(state: WorkspaceTabReconcileState): WorkspaceTab["target"][] {
  return collectAllTabs(state.layout.root).map((tab) => tab.target);
}

describe("coordinator board home seeding", () => {
  it("seeds the coordinator board as the workspace home when the project has a coordinator", () => {
    const result = reconcileWorkspaceTabs(
      makeState(createDefaultLayout()),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: true, agentIds: [] },
      }),
    );

    expect(tabTargets(result)).toContainEqual({ kind: "coordinator_board", projectId: "proj-1" });
    expect(tabTargets(result)).not.toContainEqual(expect.objectContaining({ kind: "draft" }));
  });

  it("holds the home seed until the host's first board payload lands", () => {
    const result = reconcileWorkspaceTabs(
      makeState(createDefaultLayout()),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: false, agentIds: [] },
      }),
    );

    expect(tabTargets(result)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );
    expect(tabTargets(result)).not.toContainEqual(expect.objectContaining({ kind: "draft" }));
  });

  it("seeds the draft home when the workspace's project has no coordinator", () => {
    const result = reconcileWorkspaceTabs(
      makeState(createDefaultLayout()),
      makeSnapshot({
        coordinator: { projectId: null, boardsHydrated: true, agentIds: [] },
      }),
    );

    expect(tabTargets(result)).toContainEqual(expect.objectContaining({ kind: "draft" }));
    expect(tabTargets(result)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );
  });

  it("seeds the draft home when the host has no coordinator feature", () => {
    const result = reconcileWorkspaceTabs(makeState(createDefaultLayout()), makeSnapshot());

    expect(tabTargets(result)).toContainEqual(expect.objectContaining({ kind: "draft" }));
  });
});

describe("coordinator agent tab survival", () => {
  function layoutWithCoordinatorChatTab() {
    return {
      root: {
        kind: "pane" as const,
        pane: {
          id: "main",
          tabIds: ["agent_coord-1"],
          focusedTabId: "agent_coord-1",
          tabs: [
            {
              tabId: "agent_coord-1",
              target: { kind: "agent" as const, agentId: "coord-1" },
              createdAt: 1,
            },
          ],
        },
      },
      focusedPaneId: "main",
    };
  }

  it("keeps an explicitly opened coordinator chat tab when the agent leaves the session cache", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithCoordinatorChatTab()),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: true, agentIds: ["coord-1"] },
      }),
    );

    expect(tabTargets(result)).toContainEqual({ kind: "agent", agentId: "coord-1" });
  });

  it("closes a stale agent tab that is not a coordinator", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithCoordinatorChatTab()),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: true, agentIds: [] },
      }),
    );

    expect(tabTargets(result)).not.toContainEqual({ kind: "agent", agentId: "coord-1" });
  });
});
