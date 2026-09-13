/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CoordinatorBoardSnapshot,
  CoordinatorDecisionBoardRow,
} from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useCoordinatorBoardStore } from "@/coordinator/board-store";
import { SidebarWorkspaceRowContent } from "./sidebar-workspace-row-content";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
});

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

// The hover card's desktop half pulls in expo-clipboard, which ships untranspiled
// JSX the test transform cannot parse. The row content under test never mounts it.
vi.mock("@/components/workspace-hover-card", () => ({
  WorkspaceHoverCard: ({ children }: { children?: ReactNode }) => children ?? null,
}));

const SERVER_ID = "srv";
const PROJECT_ID = "project-a";

function decision(id: string): CoordinatorDecisionBoardRow {
  return {
    kind: "decision",
    id,
    projectId: PROJECT_ID,
    agentId: "coordinator-agent",
    requestId: `request-${id}`,
    question: "Ship it?",
    askedAt: "2026-04-19T00:00:00.000Z",
    actions: [],
  };
}

function board(
  projectId: string,
  needsYou: CoordinatorDecisionBoardRow[],
): CoordinatorBoardSnapshot {
  return {
    projectId,
    needsYou,
    working: [],
    done: [],
    wake: null,
    coordinatorAgentId: "coordinator-agent",
    trustLevel: "observe",
    scope: "everything",
    enabled: true,
  };
}

function workspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${SERVER_ID}:ws-1`,
    serverId: SERVER_ID,
    workspaceId: "ws-1",
    // The grouped view key is deliberately not the coordinator's project id —
    // the meta item answers to the host-local id the board is keyed by.
    projectViewKey: '["placement","srv","project-a"]',
    projectId: PROJECT_ID,
    projectName: "Paseo",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo/ws-1",
    workspaceDirectoryLabel: "ws-1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "ws-1",
    title: null,
    pinnedAt: null,
    labels: [],
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    ...overrides,
  };
}

function renderRow(entry: SidebarWorkspaceEntry) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SidebarWorkspaceRowContent
        workspace={entry}
        hostBadge={null}
        serviceSummary={null}
        backdrop="surfaceSidebar"
        isHovered={false}
        isLoading={false}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useCoordinatorBoardStore.setState({ hosts: {} });
});

afterEach(() => {
  cleanup();
});

describe("sidebar workspace row coordinator item", () => {
  it("names the count of open decisions on the workspace's project board", () => {
    useCoordinatorBoardStore
      .getState()
      .applyBoardChange(SERVER_ID, board(PROJECT_ID, [decision("one"), decision("two")]));

    renderRow(workspace());

    expect(screen.getByTestId("sidebar-workspace-needs-you").textContent).toBe("2 need you");
  });

  it("pluralizes the single open decision", () => {
    useCoordinatorBoardStore
      .getState()
      .applyBoardChange(SERVER_ID, board(PROJECT_ID, [decision("one")]));

    renderRow(workspace());

    expect(screen.getByTestId("sidebar-workspace-needs-you").textContent).toBe("1 needs you");
  });

  it("draws nothing while the project's board has no open decisions", () => {
    useCoordinatorBoardStore.getState().applyBoardChange(SERVER_ID, board(PROJECT_ID, []));

    renderRow(workspace());

    expect(screen.queryByTestId("sidebar-workspace-needs-you")).toBeNull();
  });

  it("draws nothing while the project has no board snapshot at all", () => {
    renderRow(workspace());
    expect(screen.queryByTestId("sidebar-workspace-needs-you")).toBeNull();
  });

  it("reads the board by project id, not by the grouped view key or another project", () => {
    // Open decisions on a different project of the same host must not leak in.
    useCoordinatorBoardStore
      .getState()
      .applyBoardChange(SERVER_ID, board("project-b", [decision("other")]));

    renderRow(workspace({ projectViewKey: '["host","srv","project-a"]' }));

    expect(screen.queryByTestId("sidebar-workspace-needs-you")).toBeNull();
  });
});
