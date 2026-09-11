import { describe, expect, it } from "vitest";
import {
  CoordinatorBoardRowSchema,
  CoordinatorBoardSnapshotSchema,
  ProjectCoordinatorStateSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const DECISION_ROW = {
  kind: "decision" as const,
  id: "row-1",
  projectId: "project-1",
  agentId: "agent-asking",
  requestId: "permission-1",
  question: "Retry CI on #41?",
  askedAt: "2026-09-12T10:00:00.000Z",
  actions: [
    { id: "retry", label: "Retry" },
    { id: "investigate", label: "Investigate" },
    { id: "ignore", label: "Ignore" },
  ],
  defaultAnswerLabel: "Retry",
  dueAt: "2026-09-12T12:00:00.000Z",
  waitingMs: 600_000,
};

const WORKING_ROW = {
  kind: "working" as const,
  id: "row-2",
  projectId: "project-1",
  agentId: "agent-worker",
  goal: "Investigate test-e2e on #41",
  startedAt: "2026-09-12T10:05:00.000Z",
  provider: "claude",
  yours: false,
};

const DONE_ROW = {
  kind: "done" as const,
  id: "row-3",
  projectId: "project-1",
  text: "Opened #43: fix timezone bug",
  at: "2026-09-12T09:00:00.000Z",
  link: { url: "https://github.com/paseo/paseo/pull/43" },
};

const WAKE_ROW = {
  kind: "wake" as const,
  id: "row-4",
  projectId: "project-1",
  text: "Woke: CI failed on #41",
  level: "observe" as const,
  at: "2026-09-12T10:04:00.000Z",
};

const SNAPSHOT = {
  projectId: "project-1",
  projectName: "paseo",
  needsYou: [DECISION_ROW],
  working: [WORKING_ROW, { ...WORKING_ROW, id: "row-5", agentId: "agent-mine", yours: true }],
  done: [DONE_ROW],
  wake: WAKE_ROW,
  coordinatorAgentId: "agent-coordinator",
  trustLevel: "observe",
  scope: "everything",
  enabled: true,
};

const COORDINATOR_STATE = {
  projectId: "project-1",
  agentId: "agent-coordinator",
  enabled: true,
  trustLevel: "observe",
  scope: "everything",
};

describe("coordinator wire schemas", () => {
  it("parses every project coordinator request through the inbound union", () => {
    const enable = {
      type: "coordinator.project.enable.request",
      requestId: "req-enable",
      projectId: "project-1",
      profile: {
        provider: "claude",
        model: "opus",
        modeId: "default",
        accountSelection: { kind: "fixed", accountId: "acct-1" },
        featureValues: { thinking: true },
      },
      profiles: {
        investigator: { provider: "codex", model: "gpt-5" },
        implementer: { provider: "claude" },
      },
      trustLevel: "observe",
      scope: "everything",
    };
    expect(SessionInboundMessageSchema.parse(enable)).toEqual(enable);

    const disable = {
      type: "coordinator.project.disable.request",
      requestId: "req-disable",
      projectId: "project-1",
    };
    expect(SessionInboundMessageSchema.parse(disable)).toEqual(disable);

    const update = {
      type: "coordinator.project.update.request",
      requestId: "req-update",
      projectId: "project-1",
      trustLevel: "propose",
      scope: "project",
      usageExpectation: { monthlySpawns: 40, monthlyTokens: 5_000_000 },
      profiles: { reviewer: { provider: "opencode" } },
    };
    expect(SessionInboundMessageSchema.parse(update)).toEqual(update);

    const get = {
      type: "coordinator.project.get.request",
      requestId: "req-get",
      projectId: "project-1",
    };
    expect(SessionInboundMessageSchema.parse(get)).toEqual(get);
  });

  it("accepts an enable request carrying only the coordinator profile", () => {
    const minimal = {
      type: "coordinator.project.enable.request",
      requestId: "req-enable-min",
      projectId: "project-1",
      profile: { provider: "claude" },
    };
    expect(SessionInboundMessageSchema.parse(minimal)).toEqual(minimal);
  });

  it("accepts a board subscribe request with and without a project filter", () => {
    const global = {
      type: "coordinator.board.subscribe.request",
      requestId: "req-sub-all",
    };
    expect(SessionInboundMessageSchema.parse(global)).toEqual(global);

    const perProject = { ...global, projectId: "project-1" };
    expect(SessionInboundMessageSchema.parse(perProject)).toEqual(perProject);
  });

  it("round-trips the project state result through every response type", () => {
    for (const type of [
      "coordinator.project.enable.response",
      "coordinator.project.disable.response",
      "coordinator.project.update.response",
      "coordinator.project.get.response",
    ] as const) {
      const message = {
        type,
        payload: { requestId: "req-1", coordinator: COORDINATOR_STATE, error: null },
      };
      expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
    }
  });

  it("parses a get response with no coordinator configured", () => {
    const message = {
      type: "coordinator.project.get.response",
      payload: { requestId: "req-2", coordinator: null, error: null },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses the board subscribe response and the per-project changed push", () => {
    const response = {
      type: "coordinator.board.subscribe.response",
      payload: {
        requestId: "req-sub",
        subscriptionId: "board-sub-1",
        projectId: "project-1",
        snapshots: [SNAPSHOT],
        error: null,
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);

    const changed = {
      type: "coordinator.board.changed",
      payload: {
        subscriptionId: "board-sub-1",
        projectId: "project-1",
        snapshot: SNAPSHOT,
      },
    };
    expect(SessionOutboundMessageSchema.parse(changed)).toEqual(changed);
  });

  it("accepts a changed push without a subscriptionId", () => {
    const changed = {
      type: "coordinator.board.changed",
      payload: { projectId: "project-1", snapshot: { ...SNAPSHOT, wake: null } },
    };
    expect(SessionOutboundMessageSchema.parse(changed)).toEqual(changed);
  });

  it("discriminates board rows on kind and rejects unknown kinds", () => {
    for (const row of [DECISION_ROW, WORKING_ROW, DONE_ROW, WAKE_ROW]) {
      expect(CoordinatorBoardRowSchema.parse(row)).toEqual(row);
    }
    expect(CoordinatorBoardRowSchema.safeParse({ kind: "proposal", id: "row-x" }).success).toBe(
      false,
    );
  });

  it("parses a quiet board: empty lanes and no wake", () => {
    const quiet = {
      ...SNAPSHOT,
      projectName: undefined,
      needsYou: [],
      working: [],
      done: [],
      wake: null,
      coordinatorAgentId: null,
      enabled: false,
    };
    const parsed = CoordinatorBoardSnapshotSchema.parse(quiet);
    expect(parsed.needsYou).toEqual([]);
    expect(parsed.wake).toBeNull();
    expect(parsed.enabled).toBe(false);
  });

  it("parses a disabled coordinator state", () => {
    const parsed = ProjectCoordinatorStateSchema.parse({
      projectId: "project-1",
      agentId: null,
      enabled: false,
      trustLevel: "observe",
      scope: "project",
    });
    expect(parsed.agentId).toBeNull();
    expect(parsed.enabled).toBe(false);
  });

  it("rejects unknown trust levels and scopes", () => {
    expect(
      CoordinatorBoardSnapshotSchema.safeParse({ ...SNAPSHOT, trustLevel: "yolo" }).success,
    ).toBe(false);
    expect(CoordinatorBoardSnapshotSchema.safeParse({ ...SNAPSHOT, scope: "daemon" }).success).toBe(
      false,
    );
  });

  it("advertises the feature through server_info.features.coordinator", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      features: { coordinator: true },
    });
    expect(parsed.features?.coordinator).toBe(true);
    // Older daemons omit the flag entirely.
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-1",
      features: {},
    });
    expect(legacy.features?.coordinator).toBeUndefined();
  });
});
