import { beforeEach, describe, expect, it } from "vitest";
import type { CoordinatorBoardSnapshot } from "@getpaseo/protocol/messages";
import { useCoordinatorBoardStore } from "./board-store";

function makeSnapshot(input: {
  projectId: string;
  enabled?: boolean;
  coordinatorAgentId?: string | null;
}): CoordinatorBoardSnapshot {
  return {
    projectId: input.projectId,
    needsYou: [],
    working: [],
    done: [],
    wake: null,
    coordinatorAgentId: input.coordinatorAgentId ?? null,
    trustLevel: "observe",
    scope: "project",
    enabled: input.enabled ?? true,
  };
}

describe("coordinator board store", () => {
  beforeEach(() => {
    useCoordinatorBoardStore.setState({ hosts: {} });
  });

  it("hydrates a host from the subscribe snapshot payload, keyed by projectId", () => {
    useCoordinatorBoardStore
      .getState()
      .applySnapshots("srv", [
        makeSnapshot({ projectId: "proj-a" }),
        makeSnapshot({ projectId: "proj-b", enabled: false }),
      ]);

    const host = useCoordinatorBoardStore.getState().hosts["srv"];
    expect(host?.hydrated).toBe(true);
    expect(host?.boards.get("proj-a")?.enabled).toBe(true);
    expect(host?.boards.get("proj-b")?.enabled).toBe(false);
  });

  it("replaces a host's boards wholesale on each subscribe snapshot", () => {
    const store = useCoordinatorBoardStore.getState();
    store.applySnapshots("srv", [makeSnapshot({ projectId: "proj-a" })]);
    useCoordinatorBoardStore
      .getState()
      .applySnapshots("srv", [makeSnapshot({ projectId: "proj-b" })]);

    const host = useCoordinatorBoardStore.getState().hosts["srv"];
    expect(host?.boards.has("proj-a")).toBe(false);
    expect(host?.boards.get("proj-b")?.enabled).toBe(true);
  });

  it("upserts a single board on coordinator.board.changed", () => {
    const store = useCoordinatorBoardStore.getState();
    store.applySnapshots("srv", [makeSnapshot({ projectId: "proj-a" })]);
    useCoordinatorBoardStore.getState().applyBoardChange("srv", {
      ...makeSnapshot({ projectId: "proj-a" }),
      coordinatorAgentId: "agent-1",
    });

    const host = useCoordinatorBoardStore.getState().hosts["srv"];
    expect(host?.hydrated).toBe(true);
    expect(host?.boards.get("proj-a")?.coordinatorAgentId).toBe("agent-1");
  });

  it("marks an unknown host hydrated when a board change lands before the snapshot", () => {
    useCoordinatorBoardStore
      .getState()
      .applyBoardChange("srv", makeSnapshot({ projectId: "proj-a" }));

    const host = useCoordinatorBoardStore.getState().hosts["srv"];
    expect(host?.hydrated).toBe(true);
    expect(host?.boards.has("proj-a")).toBe(true);
  });

  it("markUnavailable lifts the hydration wait without boards", () => {
    useCoordinatorBoardStore.getState().markUnavailable("srv");

    const host = useCoordinatorBoardStore.getState().hosts["srv"];
    expect(host?.hydrated).toBe(true);
    expect(host?.boards.size).toBe(0);
  });

  it("markUnavailable keeps boards that already arrived", () => {
    useCoordinatorBoardStore
      .getState()
      .applySnapshots("srv", [makeSnapshot({ projectId: "proj-a" })]);
    useCoordinatorBoardStore.getState().markUnavailable("srv");

    const host = useCoordinatorBoardStore.getState().hosts["srv"];
    expect(host?.boards.has("proj-a")).toBe(true);
  });

  it("clearHost drops the host entry so a reconnect re-hydrates", () => {
    useCoordinatorBoardStore
      .getState()
      .applySnapshots("srv", [makeSnapshot({ projectId: "proj-a" })]);
    useCoordinatorBoardStore.getState().clearHost("srv");

    expect(useCoordinatorBoardStore.getState().hosts["srv"]).toBeUndefined();
  });

  it("clearHost on an absent host is a no-op", () => {
    useCoordinatorBoardStore
      .getState()
      .applySnapshots("srv", [makeSnapshot({ projectId: "proj-a" })]);
    const before = useCoordinatorBoardStore.getState().hosts;
    useCoordinatorBoardStore.getState().clearHost("other");
    expect(useCoordinatorBoardStore.getState().hosts).toBe(before);
  });
});
