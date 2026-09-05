import { beforeEach, expect, test, vi } from "vitest";
import type { AgentContinuationSnapshot } from "@getpaseo/protocol/messages";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));
vi.mock("@/data/query-client", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
const local = vi.hoisted(() => ({
  knownAgents: new Map<string, object>(),
  drafts: new Map<string, { text: string; attachments: never[] }>(),
  flush: vi.fn(async () => {}),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({ sessions: { host: { agents: local.knownAgents } } }),
  },
}));
vi.mock("@/stores/draft-store", () => ({
  flushDraftPersistStorage: local.flush,
  useDraftStore: {
    getState: () => ({
      getDraftInput: (key: string) => local.drafts.get(key),
      saveDraftInput: ({
        draftKey,
        draft,
      }: {
        draftKey: string;
        draft: { text: string; attachments: never[] };
      }) => local.drafts.set(draftKey, draft),
    }),
  },
}));

import {
  useWorkspaceLayoutStore,
  collectAllTabs,
  type SplitPane,
} from "@/stores/workspace-layout-store";
import { retargetContinuationTab } from "./runtime";

const key = "host:workspace";
const snapshot: AgentContinuationSnapshot = {
  rootAgentId: "source",
  agentId: "successor",
  queuedMessages: [],
  continuation: {
    rootAgentId: "source",
    agentId: "successor",
    previousAgentId: "source",
    status: "active",
    reason: "Capacity limit",
    updatedAt: new Date(2000).toISOString(),
    transitionedAt: new Date(1000).toISOString(),
  },
};
beforeEach(() => {
  local.knownAgents.clear();
  local.knownAgents.set("successor", {});
  local.drafts.clear();
  local.flush.mockClear();
  useWorkspaceLayoutStore.setState({
    continuationPendingIdsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
    layoutByWorkspace: {
      [key]: {
        focusedPaneId: "pane",
        root: {
          kind: "pane",
          pane: {
            id: "pane",
            tabIds: ["task", "foreground"],
            focusedTabId: "foreground",
            tabs: [
              { tabId: "task", target: { kind: "agent", agentId: "source" }, createdAt: 500 },
              {
                tabId: "foreground",
                target: { kind: "agent", agentId: "another" },
                createdAt: 500,
              },
            ],
          } as SplitPane,
        },
      },
    },
  });
});

test("a background continuation retains tab identity, order, focus, and an unsent local draft", async () => {
  local.drafts.set("agent:host:source", { text: "Still drafting", attachments: [] });
  await retargetContinuationTab("host", "source", snapshot);
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  expect(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab.target])).toEqual([
    ["task", { kind: "agent", agentId: "successor" }],
    ["foreground", { kind: "agent", agentId: "another" }],
  ]);
  expect(layout.focusedPaneId).toBe("pane");
  expect(layout.root.kind === "pane" && layout.root.pane.focusedTabId).toBe("foreground");
  expect(local.drafts.get("agent:host:successor")?.text).toBe("Still drafting");
  expect(local.drafts.get("agent:host:source")?.text).toBe("Still drafting");
  expect(local.flush).toHaveBeenCalledOnce();
});

test("a conversation explicitly opened after continuation remains a history view", async () => {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  collectAllTabs(layout.root)[0].createdAt = 1500;
  await retargetContinuationTab("host", "source", snapshot);
  expect(collectAllTabs(layout.root)[0].target).toEqual({ kind: "agent", agentId: "source" });
});

test("an existing successor draft is never overwritten", async () => {
  local.drafts.set("agent:host:source", { text: "Old draft", attachments: [] });
  local.drafts.set("agent:host:successor", { text: "New draft", attachments: [] });
  await retargetContinuationTab("host", "source", snapshot);
  expect(local.drafts.get("agent:host:successor")?.text).toBe("New draft");
});

test("a successor opened by directory reconciliation does not replace the original tab identity", async () => {
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: key,
    target: { kind: "agent", agentId: "successor" },
    intent: "background",
  });
  await retargetContinuationTab("host", "source", snapshot);
  useWorkspaceLayoutStore.getState().reconcileTabs(key, {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["source", "successor", "another"],
    autoOpenAgentIds: ["successor", "another"],
    knownAgentIds: ["source", "successor", "another"],
    standaloneTerminalIds: [],
  });
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual(["task", "foreground"]);
  expect(layout.root.kind === "pane" && layout.root.pane.focusedTabId).toBe("foreground");
});

test("an event that precedes the directory waits before retargeting", async () => {
  local.knownAgents.clear();
  await retargetContinuationTab("host", "source", snapshot);
  expect(
    collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root)[0].target,
  ).toEqual({ kind: "agent", agentId: "source" });
  local.knownAgents.set("successor", {});
  await retargetContinuationTab("host", "source", snapshot);
  expect(
    collectAllTabs(useWorkspaceLayoutStore.getState().layoutByWorkspace[key].root)[0].target,
  ).toEqual({ kind: "agent", agentId: "successor" });
});

test("a React reconciliation with an older directory cannot undo a continuation", async () => {
  await retargetContinuationTab("host", "source", snapshot);
  const store = useWorkspaceLayoutStore.getState();
  store.reconcileTabs(key, {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["source", "another"],
    knownAgentIds: ["source", "another"],
    autoOpenAgentIds: ["source", "another"],
    standaloneTerminalIds: [],
  });
  store.reconcileTabs(key, {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["source", "successor", "another"],
    knownAgentIds: ["source", "successor", "another"],
    autoOpenAgentIds: ["successor", "another"],
    standaloneTerminalIds: [],
  });
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  expect(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab.target])).toEqual([
    ["task", { kind: "agent", agentId: "successor" }],
    ["foreground", { kind: "agent", agentId: "another" }],
  ]);
  expect(useWorkspaceLayoutStore.getState().continuationPendingIdsByWorkspace[key]?.size ?? 0).toBe(
    0,
  );
});

test("a history tab stays historical after a later account transition", async () => {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  collectAllTabs(layout.root)[0].createdAt = 1500;
  await retargetContinuationTab("host", "source", {
    ...snapshot,
    continuation: {
      ...snapshot.continuation!,
      firstTransitionedAt: new Date(1000).toISOString(),
      transitionedAt: new Date(3000).toISOString(),
    },
  });
  expect(collectAllTabs(layout.root)[0].target).toEqual({ kind: "agent", agentId: "source" });
});
