import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectCoordinatorState } from "@getpaseo/protocol/messages";

const runtimeClient = vi.hoisted(() => ({
  current: null as Pick<DaemonClient, "getProjectCoordinator"> | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({ client: runtimeClient.current }),
  }),
}));

import { refreshProjectCoordinator, useCoordinatorProjectStore } from "./project-store";

function coordinatorState(
  projectId: string,
  overrides: Partial<ProjectCoordinatorState> = {},
): ProjectCoordinatorState {
  return {
    projectId,
    agentId: "coordinator-agent",
    enabled: true,
    trustLevel: "observe",
    scope: "everything",
    ...overrides,
  };
}

function records(serverId: string) {
  return useCoordinatorProjectStore.getState().hosts[serverId];
}

describe("coordinator project store", () => {
  beforeEach(() => {
    runtimeClient.current = null;
    useCoordinatorProjectStore.setState({ hosts: {} });
    vi.restoreAllMocks();
  });

  it("applies a project result under its own host and project", () => {
    useCoordinatorProjectStore.getState().applyProjectResult("srv", "project-a", {
      coordinator: coordinatorState("project-a", { trustLevel: "ship" }),
      ciConfigured: false,
    });
    useCoordinatorProjectStore.getState().applyProjectResult("srv", "project-b", {
      coordinator: coordinatorState("project-b"),
      ciConfigured: true,
    });

    expect(records("srv")?.get("project-a")).toEqual({
      coordinator: coordinatorState("project-a", { trustLevel: "ship" }),
      ciConfigured: false,
    });
    expect(records("srv")?.get("project-b")?.coordinator?.trustLevel).toBe("observe");
  });

  it("keeps a null coordinator with its ciConfigured answer", () => {
    useCoordinatorProjectStore
      .getState()
      .applyProjectResult("srv", "project-a", { coordinator: null, ciConfigured: false });

    expect(records("srv")?.get("project-a")).toEqual({
      coordinator: null,
      ciConfigured: false,
    });
  });

  it("clears one host's records without touching the others", () => {
    const store = useCoordinatorProjectStore.getState();
    store.applyProjectResult("srv", "project-a", { coordinator: null });
    store.applyProjectResult("other", "project-a", { coordinator: null });

    useCoordinatorProjectStore.getState().clearHost("srv");

    expect(records("srv")).toBeUndefined();
    expect(records("other")?.has("project-a")).toBe(true);
  });

  it("refreshes through the host client and lands the record", async () => {
    const getProjectCoordinator = vi.fn(async () => ({
      coordinator: coordinatorState("project-a"),
      ciConfigured: true,
    }));
    runtimeClient.current = { getProjectCoordinator };

    const record = await refreshProjectCoordinator("srv", "project-a");

    expect(getProjectCoordinator).toHaveBeenCalledWith("project-a");
    expect(record?.coordinator?.projectId).toBe("project-a");
    expect(records("srv")?.get("project-a")?.ciConfigured).toBe(true);
  });

  it("runs one request while a refresh is already in flight", async () => {
    let resolveGet!: (value: { coordinator: ProjectCoordinatorState }) => void;
    const getProjectCoordinator = vi.fn(
      () =>
        new Promise<{ coordinator: ProjectCoordinatorState }>((complete) => {
          resolveGet = complete;
        }),
    );
    runtimeClient.current = { getProjectCoordinator };

    const first = refreshProjectCoordinator("srv", "project-a");
    const second = refreshProjectCoordinator("srv", "project-a");
    expect(getProjectCoordinator).toHaveBeenCalledTimes(1);

    resolveGet({ coordinator: coordinatorState("project-a") });
    await Promise.all([first, second]);

    // After the shared request lands, the next open asks again — ciConfigured
    // answers "does the repo have CI now", so a cached false must not linger.
    const third = refreshProjectCoordinator("srv", "project-a");
    expect(getProjectCoordinator).toHaveBeenCalledTimes(2);
    resolveGet({ coordinator: coordinatorState("project-a") });
    await third;
  });

  it("drops a response that lands after the host's client went away", async () => {
    let resolveGet!: (value: { coordinator: ProjectCoordinatorState }) => void;
    const getProjectCoordinator = vi.fn(
      () =>
        new Promise<{ coordinator: ProjectCoordinatorState }>((complete) => {
          resolveGet = complete;
        }),
    );
    runtimeClient.current = { getProjectCoordinator };

    const pending = refreshProjectCoordinator("srv", "project-a");
    // The host disconnected and its records were cleared before the response landed.
    runtimeClient.current = null;
    useCoordinatorProjectStore.getState().clearHost("srv");
    resolveGet({ coordinator: coordinatorState("project-a") });

    await expect(pending).resolves.toBeNull();
    expect(records("srv")).toBeUndefined();
  });

  it("resolves null when the host has no client to ask", async () => {
    runtimeClient.current = null;
    await expect(refreshProjectCoordinator("srv", "project-a")).resolves.toBeNull();
    expect(records("srv")).toBeUndefined();
  });

  it("warns and resolves null when the request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runtimeClient.current = {
      getProjectCoordinator: vi.fn(async () => {
        throw new Error("daemon unreachable");
      }),
    };

    await expect(refreshProjectCoordinator("srv", "project-a")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
