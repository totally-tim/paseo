/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProjectCoordinatorState } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";

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

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
  persistAttachmentFromDataUrl: async () => {
    throw new Error("not implemented in test");
  },
  persistAttachmentFromFileUri: async () => {
    throw new Error("not implemented in test");
  },
}));

const hostClient = vi.hoisted(() => ({
  current: null as Pick<DaemonClient, "getProjectCoordinator" | "enableProjectCoordinator"> | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => hostClient.current,
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({ client: hostClient.current }),
  }),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => true,
}));

const providersSnapshot = vi.hoisted(() => ({
  current: {
    entries: [
      { provider: "claude", status: "ready", enabled: true, label: "Claude" },
      { provider: "codex", status: "ready", enabled: true, label: "Codex" },
      { provider: "opencode", status: "ready", enabled: true, label: "OpenCode" },
    ] as ProviderSnapshotEntry[],
  },
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: providersSnapshot.current.entries,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: true,
    refresh: vi.fn(async () => undefined),
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: () => () => null,
}));

vi.mock("@/components/combined-model-selector", () => ({
  CombinedModelSelector: () => null,
}));

// The combobox under SelectFieldTrigger mounts reanimated, whose Flow sources do
// not survive the test transform; the delegate pickers are not under test here.
vi.mock("@/components/ui/select-field", () => ({
  SelectFieldTrigger: () => null,
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    header,
    children,
    testID,
  }: {
    visible: boolean;
    header?: { title: string };
    children: ReactNode;
    testID?: string;
  }) =>
    visible ? (
      <section data-testid={testID}>
        <h1>{header?.title}</h1>
        {children}
      </section>
    ) : null,
  AdaptiveTextInput: () => null,
}));

import { CoordinatorEnableSheet } from "./setup-row";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useCoordinatorProjectStore } from "./project-store";

const SERVER_ID = "server-1";
const PROJECT_ID = "project-1";

function clientWith(result: {
  coordinator: ProjectCoordinatorState | null;
  ciConfigured?: boolean;
}) {
  return {
    getProjectCoordinator: vi.fn(async () => result),
    enableProjectCoordinator: vi.fn(async () => result),
  };
}

function coordinatorRecord(agentId: string | null) {
  return {
    projectId: PROJECT_ID,
    agentId,
    enabled: true,
    trustLevel: "observe" as const,
    scope: "everything" as const,
  };
}

function renderSheet() {
  return render(
    <CoordinatorEnableSheet
      visible
      projectId={PROJECT_ID}
      serverId={SERVER_ID}
      cwd="/repo/paseo"
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  useCoordinatorProjectStore.setState({ hosts: {} });
  useDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
});

describe("coordinator setup sheet CI note", () => {
  it("says the CI watch has nothing to poll when the repository has no CI", async () => {
    hostClient.current = clientWith({ coordinator: null, ciConfigured: false });
    renderSheet();

    const note = await screen.findByTestId("coordinator-setup-no-ci");
    expect(note.textContent).toContain("CI watch has nothing to poll");
    expect(screen.getByTestId("coordinator-setup-add-ci")).toBeTruthy();
  });

  it("stays out of the sheet when the repository already has CI", async () => {
    hostClient.current = clientWith({ coordinator: null, ciConfigured: true });
    renderSheet();

    await screen.findByTestId("coordinator-enable-sheet");
    await waitFor(() =>
      expect(hostClient.current?.getProjectCoordinator).toHaveBeenCalledWith(PROJECT_ID),
    );
    expect(screen.queryByTestId("coordinator-setup-no-ci")).toBeNull();
  });

  it("stays out of the sheet while the project record has not answered", async () => {
    hostClient.current = clientWith({ coordinator: null });
    renderSheet();

    await screen.findByTestId("coordinator-enable-sheet");
    await waitFor(() => expect(hostClient.current?.getProjectCoordinator).toHaveBeenCalled());
    expect(screen.queryByTestId("coordinator-setup-no-ci")).toBeNull();
  });

  it("queues the add-CI ask into the new coordinator's composer draft on enable", async () => {
    const client = clientWith({
      coordinator: coordinatorRecord("coordinator-agent-1"),
      ciConfigured: false,
    });
    hostClient.current = client;
    renderSheet();

    fireEvent.click(await screen.findByTestId("coordinator-setup-add-ci"));
    expect(screen.getByTestId("coordinator-setup-ci-queued")).toBeTruthy();
    expect(screen.queryByTestId("coordinator-setup-add-ci")).toBeNull();

    fireEvent.click(screen.getByTestId("coordinator-enable-submit"));
    await waitFor(() => expect(client.enableProjectCoordinator).toHaveBeenCalled());

    const draftKey = buildDraftStoreKey({
      serverId: SERVER_ID,
      agentId: "coordinator-agent-1",
    });
    await waitFor(() =>
      expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toBe(
        "Set up CI for this repository.",
      ),
    );
    expect(
      useCoordinatorProjectStore.getState().hosts[SERVER_ID]?.get(PROJECT_ID)?.coordinator?.agentId,
    ).toBe("coordinator-agent-1");
  });

  it("leaves the composer draft alone when the ask was never queued", async () => {
    hostClient.current = clientWith({
      coordinator: coordinatorRecord("coordinator-agent-2"),
      ciConfigured: false,
    });
    renderSheet();

    await screen.findByTestId("coordinator-setup-no-ci");
    fireEvent.click(screen.getByTestId("coordinator-enable-submit"));
    await waitFor(() => expect(hostClient.current?.enableProjectCoordinator).toHaveBeenCalled());

    const draftKey = buildDraftStoreKey({
      serverId: SERVER_ID,
      agentId: "coordinator-agent-2",
    });
    expect(useDraftStore.getState().getDraftInput(draftKey)).toBeUndefined();
  });
});
