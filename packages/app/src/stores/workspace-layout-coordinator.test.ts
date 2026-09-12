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

describe("coordinator home transitions", () => {
  function layoutWithDraftHome(target?: WorkspaceTab["target"]) {
    return {
      root: {
        kind: "pane" as const,
        pane: {
          id: "main",
          tabIds: ["draft_home"],
          focusedTabId: "draft_home",
          tabs: [
            {
              tabId: "draft_home",
              target: target ?? { kind: "draft" as const, draftId: "draft_home" },
              createdAt: 1,
            },
          ],
        },
      },
      focusedPaneId: "main",
    };
  }

  function layoutWithBoardTab() {
    return {
      root: {
        kind: "pane" as const,
        pane: {
          id: "main",
          tabIds: ["coordinator_board_proj-1"],
          focusedTabId: "coordinator_board_proj-1",
          tabs: [
            {
              tabId: "coordinator_board_proj-1",
              target: { kind: "coordinator_board" as const, projectId: "proj-1" },
              createdAt: 1,
            },
          ],
        },
      },
      focusedPaneId: "main",
    };
  }

  it("replaces the focused draft home with the board when the coordinator enables on an open workspace", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithDraftHome()),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: true, agentIds: [] },
      }),
    );

    const tabs = collectAllTabs(result.layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target).toEqual({ kind: "coordinator_board", projectId: "proj-1" });
    // The draft's slot becomes the board, so focus survives without a reopen.
    expect(tabs[0]?.tabId).toBe("draft_home");
    expect(result.layout.root.kind === "pane" ? result.layout.root.pane.focusedTabId : null).toBe(
      "draft_home",
    );
  });

  it("leaves the draft home alone until the first board payload lands", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithDraftHome()),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: false, agentIds: [] },
      }),
    );

    expect(tabTargets(result)).toContainEqual({ kind: "draft", draftId: "draft_home" });
    expect(tabTargets(result)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );
  });

  it("does not open a second board when one is already present", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithBoardTab()),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: true, agentIds: [] },
      }),
    );

    expect(
      tabTargets(result).filter(
        (target) => target.kind === "coordinator_board" && target.projectId === "proj-1",
      ),
    ).toHaveLength(1);
  });

  it("does not consume a draft that carries a setup bundle", () => {
    const setupDraft = {
      kind: "draft" as const,
      draftId: "draft_home",
      setup: {
        provider: "claude" as const,
        cwd: "/repo",
        modeId: null,
        model: null,
        thinkingOptionId: null,
        featureValues: {},
      },
    };
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithDraftHome(setupDraft)),
      makeSnapshot({
        coordinator: { projectId: "proj-1", boardsHydrated: true, agentIds: [] },
      }),
    );

    expect(tabTargets(result)).toContainEqual(setupDraft);
    expect(tabTargets(result)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );
  });

  it("closes the project's board tab and reseeds the draft home when the coordinator disables", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithBoardTab()),
      makeSnapshot({
        coordinator: { projectId: null, boardsHydrated: true, agentIds: [] },
      }),
    );

    expect(tabTargets(result)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );
    expect(tabTargets(result)).toContainEqual(expect.objectContaining({ kind: "draft" }));
  });
});
