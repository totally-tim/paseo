import { beforeEach, expect, test, vi } from "vitest";
import type { AgentContinuationSnapshot } from "@getpaseo/protocol/messages";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => local.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      local.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      local.storage.delete(key);
    },
  },
}));
vi.mock("@/data/query-client", () => ({ queryClient: { invalidateQueries: vi.fn() } }));
const local = vi.hoisted(() => ({
  storage: new Map<string, string>(),
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
  local.storage.clear();
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
  local.storage.clear();
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

test("a tab opened while the previous successor was current follows the next transition", async () => {
  // A -> B at 1000, the user opened B's task tab at 2000, B -> C at 3000.
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  collectAllTabs(layout.root)[0].createdAt = 2000;
  local.knownAgents.set("third", {});
  await retargetContinuationTab("host", "source", {
    rootAgentId: "root",
    agentId: "third",
    queuedMessages: [],
    retiredAt: new Date(3000).toISOString(),
    continuation: {
      rootAgentId: "root",
      agentId: "third",
      previousAgentId: "source",
      status: "active",
      reason: "Capacity limit",
      updatedAt: new Date(3000).toISOString(),
      firstTransitionedAt: new Date(1000).toISOString(),
      transitionedAt: new Date(3000).toISOString(),
    },
  });
  const next = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  expect(collectAllTabs(next.root)[0].target).toEqual({ kind: "agent", agentId: "third" });
});

test("an unresolved queue attempt follows the task so a retry reuses its message id", async () => {
  local.storage.set(
    "paseo:queue-submission:host:source",
    JSON.stringify({ id: "msg-1", content: "Queued instruction" }),
  );
  await retargetContinuationTab("host", "source", snapshot);
  expect(local.storage.get("paseo:queue-submission:host:source")).toBeUndefined();
  expect(local.storage.get("paseo:queue-submission:host:successor")).toBe(
    JSON.stringify({ id: "msg-1", content: "Queued instruction" }),
  );
});

test("removing a duplicate successor tab does not move focus to another pane", async () => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {
      [key]: {
        focusedPaneId: "left",
        root: {
          kind: "group",
          group: {
            id: "root",
            direction: "horizontal",
            sizes: [0.5, 0.5],
            children: [
              {
                kind: "pane",
                pane: {
                  id: "left",
                  tabIds: ["task"],
                  focusedTabId: "task",
                  tabs: [
                    { tabId: "task", target: { kind: "agent", agentId: "source" }, createdAt: 500 },
                  ],
                },
              },
              {
                kind: "pane",
                pane: {
                  id: "right",
                  tabIds: ["duplicate", "other"],
                  focusedTabId: "duplicate",
                  tabs: [
                    {
                      tabId: "duplicate",
                      target: { kind: "agent", agentId: "successor" },
                      createdAt: 600,
                    },
                    {
                      tabId: "other",
                      target: { kind: "agent", agentId: "another" },
                      createdAt: 600,
                    },
                  ],
                },
              },
            ],
          },
        },
      } as never,
    },
  });
  await retargetContinuationTab("host", "source", snapshot);
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  expect(layout.focusedPaneId).toBe("left");
  expect(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab.target.kind])).toEqual([
    ["task", "agent"],
    ["other", "agent"],
  ]);
});

test("continuation protection ends when the successor is archived elsewhere", async () => {
  await retargetContinuationTab("host", "source", snapshot);
  expect(useWorkspaceLayoutStore.getState().continuationPendingIdsByWorkspace[key]).toContain(
    "successor",
  );
  useWorkspaceLayoutStore.getState().reconcileTabs(key, {
    agentsHydrated: true,
    terminalsHydrated: true,
    activeAgentIds: ["another"],
    autoOpenAgentIds: ["another"],
    knownAgentIds: ["another"],
    standaloneTerminalIds: [],
  });
  expect(
    useWorkspaceLayoutStore.getState().continuationPendingIdsByWorkspace[key] ?? [],
  ).not.toContain("successor");
});
