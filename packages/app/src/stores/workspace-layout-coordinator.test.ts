import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import type { WorkspaceTab } from "@/workspace-tabs/model";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  collectAllTabs,
  createDefaultLayout,
  reconcileWorkspaceTabs,
  type WorkspaceTabReconcileState,
  type WorkspaceTabSnapshot,
} from "@/stores/workspace-layout-actions";
import { createWorkspaceLayoutStore, findPaneContainingTab } from "@/stores/workspace-layout-store";
import type { WorkspaceLayoutIdSource } from "@/stores/workspace-layout-ids";
import { useDraftStore } from "@/stores/draft-store";
import { buildWorkspaceDraftTabDraftKey } from "@/stores/draft-keys";

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

function makeState(
  layout: WorkspaceTabReconcileState["layout"],
  overrides: Partial<WorkspaceTabReconcileState> = {},
): WorkspaceTabReconcileState {
  return { layout, explorerSidebarPaneId: null, ...overrides };
}

function coordinatorSnapshot(projectId: string | null): WorkspaceTabSnapshot {
  return makeSnapshot({
    coordinator: { projectId, boardsHydrated: true, agentIds: [] },
  });
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

  it("replaces the ambient draft home with the board when the coordinator enables on an open workspace", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithDraftHome(), {
        ambientHomeDraftTabIds: new Set(["draft_home"]),
      }),
      coordinatorSnapshot("proj-1"),
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

  it("converts the seeded ambient draft in place when the coordinator enables", () => {
    const seeded = reconcileWorkspaceTabs(
      makeState(createDefaultLayout()),
      coordinatorSnapshot(null),
    );
    expect(seeded.ambientHomeDraftTabIds?.size).toBe(1);

    const result = reconcileWorkspaceTabs(seeded, coordinatorSnapshot("proj-1"));

    const tabs = collectAllTabs(result.layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target).toEqual({ kind: "coordinator_board", projectId: "proj-1" });
    expect(result.ambientHomeDraftTabIds?.size ?? 0).toBe(0);
  });

  it("does not consume a draft the user opened when the coordinator enables", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithDraftHome()),
      coordinatorSnapshot("proj-1"),
    );

    expect(tabTargets(result)).toContainEqual({ kind: "draft", draftId: "draft_home" });
    expect(tabTargets(result)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
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

  it("reseeds a draft home after the board is closed and never converts it back", () => {
    const seeded = reconcileWorkspaceTabs(
      makeState(createDefaultLayout(), {
        closedCoordinatorBoardProjectIds: new Set(["proj-1"]),
      }),
      coordinatorSnapshot("proj-1"),
    );

    expect(tabTargets(seeded)).toContainEqual(expect.objectContaining({ kind: "draft" }));
    expect(tabTargets(seeded)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );

    // The reseeded draft is ambient-marked, but the dismissal still blocks conversion.
    expect(seeded.ambientHomeDraftTabIds?.size).toBe(1);
    const again = reconcileWorkspaceTabs(seeded, coordinatorSnapshot("proj-1"));
    expect(tabTargets(again)).toContainEqual(expect.objectContaining({ kind: "draft" }));
    expect(tabTargets(again)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );
  });

  it("keeps a user-opened draft a draft after the board is closed", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithDraftHome(), {
        closedCoordinatorBoardProjectIds: new Set(["proj-1"]),
      }),
      coordinatorSnapshot("proj-1"),
    );

    expect(tabTargets(result)).toContainEqual({ kind: "draft", draftId: "draft_home" });
    expect(tabTargets(result)).not.toContainEqual(
      expect.objectContaining({ kind: "coordinator_board" }),
    );
  });

  it("clears the dismissal while the board is open again", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithBoardTab(), {
        closedCoordinatorBoardProjectIds: new Set(["proj-1"]),
      }),
      coordinatorSnapshot("proj-1"),
    );

    expect(tabTargets(result)).toContainEqual({
      kind: "coordinator_board",
      projectId: "proj-1",
    });
    expect(result.closedCoordinatorBoardProjectIds?.size ?? 0).toBe(0);
  });

  it("reconverts the ambient home when the coordinator re-enables after the board was closed", () => {
    const tombstoned = reconcileWorkspaceTabs(
      makeState(createDefaultLayout(), {
        closedCoordinatorBoardProjectIds: new Set(["proj-1"]),
      }),
      coordinatorSnapshot("proj-1"),
    );
    expect(tabTargets(tombstoned)).toContainEqual(expect.objectContaining({ kind: "draft" }));

    const disabled = reconcileWorkspaceTabs(tombstoned, coordinatorSnapshot(null));
    expect(disabled.closedCoordinatorBoardProjectIds?.size ?? 0).toBe(0);
    expect(tabTargets(disabled)).toContainEqual(expect.objectContaining({ kind: "draft" }));

    const reenabled = reconcileWorkspaceTabs(disabled, coordinatorSnapshot("proj-1"));
    const tabs = collectAllTabs(reenabled.layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target).toEqual({ kind: "coordinator_board", projectId: "proj-1" });
  });

  it("drops dismissals for projects other than the enabled one", () => {
    const result = reconcileWorkspaceTabs(
      makeState(layoutWithBoardTab(), {
        closedCoordinatorBoardProjectIds: new Set(["proj-2", "proj-3"]),
      }),
      coordinatorSnapshot("proj-1"),
    );

    expect(result.closedCoordinatorBoardProjectIds?.size ?? 0).toBe(0);
  });
});

describe("coordinator board close and reopen", () => {
  const SERVER_ID = "server-1";
  const WORKSPACE_ID = "ws-main";
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
  }) as string;

  function makeStore() {
    let index = 0;
    const ids: WorkspaceLayoutIdSource = {
      createNodeId: (prefix) => `${prefix}_store-${(index += 1)}`,
      createFocusRestorationToken: () => `focus_store-${(index += 1)}`,
    };
    return createWorkspaceLayoutStore(ids);
  }

  function tabsIn(store: ReturnType<typeof makeStore>): WorkspaceTab[] {
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    return layout ? collectAllTabs(layout.root) : [];
  }

  function closedBoardProjectIds(store: ReturnType<typeof makeStore>): ReadonlySet<string> {
    return store.getState().closedCoordinatorBoardProjectIdsByWorkspace[workspaceKey] ?? new Set();
  }

  beforeEach(() => {
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
  });

  it("reseeds a draft home when the board tab closes and never converts it back", () => {
    const store = makeStore();
    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    const boardTab = tabsIn(store).find((tab) => tab.target.kind === "coordinator_board");
    expect(boardTab).toBeDefined();

    store.getState().closeTab(workspaceKey, boardTab?.tabId as string);
    expect(closedBoardProjectIds(store).has("proj-1")).toBe(true);

    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    const targets = tabsIn(store).map((tab) => tab.target.kind);
    expect(targets).toContain("draft");
    expect(targets).not.toContain("coordinator_board");

    // The reseeded ambient draft stays a draft across further reconciles.
    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    expect(tabsIn(store).map((tab) => tab.target.kind)).not.toContain("coordinator_board");
  });

  it("dismisses the board when its pane closes", () => {
    const store = makeStore();
    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    const boardTab = tabsIn(store).find((tab) => tab.target.kind === "coordinator_board");
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    const boardPaneId =
      boardTab && layout ? findPaneContainingTab(layout.root, boardTab.tabId)?.id : null;
    expect(boardPaneId).toBeTruthy();

    store.getState().splitPaneEmpty(workspaceKey, {
      targetPaneId: boardPaneId as string,
      position: "right",
    });
    store.getState().closePane(workspaceKey, boardPaneId as string);

    expect(closedBoardProjectIds(store).has("proj-1")).toBe(true);
    expect(tabsIn(store).map((tab) => tab.target.kind)).not.toContain("coordinator_board");
  });

  it("openCoordinatorBoard lifts the dismissal and keeps the board open", () => {
    const store = makeStore();
    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    const boardTab = tabsIn(store).find((tab) => tab.target.kind === "coordinator_board");
    store.getState().closeTab(workspaceKey, boardTab?.tabId as string);
    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    expect(tabsIn(store).map((tab) => tab.target.kind)).toContain("draft");

    const tabId = store.getState().openCoordinatorBoard(workspaceKey, "proj-1");
    expect(tabId).toBeTruthy();
    expect(closedBoardProjectIds(store).size).toBe(0);
    expect(tabsIn(store).map((tab) => tab.target)).toContainEqual({
      kind: "coordinator_board",
      projectId: "proj-1",
    });

    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    expect(tabsIn(store).map((tab) => tab.target)).toContainEqual({
      kind: "coordinator_board",
      projectId: "proj-1",
    });
  });

  it("does not consume a draft the user opened after the board was closed", () => {
    const store = makeStore();
    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    const boardTab = tabsIn(store).find((tab) => tab.target.kind === "coordinator_board");
    store.getState().closeTab(workspaceKey, boardTab?.tabId as string);

    const draftTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft_user" },
      intent: "new",
    });
    expect(draftTabId).toBeTruthy();

    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));
    const targets = tabsIn(store).map((tab) => tab.target);
    expect(targets).toContainEqual({ kind: "draft", draftId: "draft_user" });
    expect(targets).not.toContainEqual(expect.objectContaining({ kind: "coordinator_board" }));
  });

  it("carries the ambient draft's composer text onto the board composer key", () => {
    const store = makeStore();
    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot(null));
    const draftTab = tabsIn(store).find((tab) => tab.target.kind === "draft");
    if (!draftTab || draftTab.target.kind !== "draft") {
      throw new Error("expected a seeded draft home tab");
    }
    const sourceKey = buildWorkspaceDraftTabDraftKey({
      serverId: SERVER_ID,
      draftId: draftTab.target.draftId,
    });
    useDraftStore.getState().saveDraftInput({
      draftKey: sourceKey,
      draft: { text: "wip note", attachments: [] },
    });

    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));

    const boardTab = tabsIn(store).find((tab) => tab.target.kind === "coordinator_board");
    expect(boardTab?.tabId).toBe(draftTab?.tabId);
    expect(
      useDraftStore.getState().getDraftInput(`coordinator-board:${SERVER_ID}:proj-1`)?.text,
    ).toBe("wip note");
    expect(useDraftStore.getState().getDraftInput(sourceKey)).toBeUndefined();
  });

  it("leaves a user-opened draft's composer text alone when nothing converts", () => {
    const store = makeStore();
    const draftTabId = store.getState().openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft_user" },
      intent: "new",
    });
    expect(draftTabId).toBeTruthy();
    const sourceKey = buildWorkspaceDraftTabDraftKey({
      serverId: SERVER_ID,
      draftId: "draft_user",
    });
    useDraftStore.getState().saveDraftInput({
      draftKey: sourceKey,
      draft: { text: "mine", attachments: [] },
    });

    store.getState().reconcileTabs(workspaceKey, coordinatorSnapshot("proj-1"));

    expect(useDraftStore.getState().getDraftInput(sourceKey)?.text).toBe("mine");
    expect(
      useDraftStore.getState().getDraftInput(`coordinator-board:${SERVER_ID}:proj-1`),
    ).toBeUndefined();
  });
});
