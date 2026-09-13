import { describe, expect, it } from "vitest";
import {
  buildDraftStoreKey,
  buildCoordinatorBoardDraftKey,
  buildGlobalCoordinatorDraftKey,
} from "./draft-keys";

describe("buildDraftStoreKey", () => {
  it("isolates agent drafts by server and agent ids", () => {
    const keyA = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-1",
    });
    const keyB = buildDraftStoreKey({
      serverId: "server-b",
      agentId: "agent-1",
    });
    const keyC = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "agent-2",
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
    expect(keyB).not.toBe(keyC);
  });

  it("uses draftId keyspace for create flow drafts", () => {
    const key = buildDraftStoreKey({
      serverId: "server-a",
      agentId: "__new_agent__",
      draftId: "draft-123",
    });

    expect(key).toBe("draft:server-a:draft-123");
  });
});

describe("coordinator draft identity", () => {
  it("keeps a project's board and Chat draft through rotation and disconnection", () => {
    const labels = {
      "paseo.role": "coordinator.project",
      "paseo.coordinator.project-id": "project-1",
    };
    const board = buildCoordinatorBoardDraftKey({
      serverId: "host",
      projectId: "project-1",
      coordinatorAgentId: "source",
    });
    expect(buildDraftStoreKey({ serverId: "host", agentId: "source", labels })).toBe(board);
    expect(buildDraftStoreKey({ serverId: "host", agentId: "successor", labels })).toBe(board);
    // Connection status is absent: persisted agent labels identify the role offline.
    expect(
      buildDraftStoreKey({ serverId: "host", agentId: "successor", labels: { ...labels } }),
    ).toBe(board);
    expect(buildDraftStoreKey({ serverId: "other-host", agentId: "successor", labels })).not.toBe(
      board,
    );
    expect(buildDraftStoreKey({ serverId: "host", agentId: "worker", labels: {} })).not.toBe(board);
  });
  it("shares the global coordinator draft without requiring a project label", () => {
    const labels = { "paseo.role": "coordinator.global" };
    const board = buildGlobalCoordinatorDraftKey("host");
    expect(buildDraftStoreKey({ serverId: "host", agentId: "global-source", labels })).toBe(board);
    expect(buildDraftStoreKey({ serverId: "host", agentId: "global-successor", labels })).toBe(
      board,
    );
    expect(buildCoordinatorBoardDraftKey({ serverId: "host", projectId: "global" })).not.toBe(
      board,
    );
  });
});
