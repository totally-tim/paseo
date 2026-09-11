import { describe, expect, it } from "vitest";
import {
  activityInFlight,
  formatSince,
  formatUntil,
  type InboxCard,
  laneFlexGrow,
  projectLanes,
  quietText,
  urgencyLevel,
} from "./lanes";
import type { Agent, PermissionRequest, Workspace } from "./types";

function agent(input: Partial<Agent> & { id: string }): Agent {
  return {
    provider: "claude",
    cwd: "/repo",
    workspaceId: "ws_1",
    model: "claude-fable-5-1",
    status: "idle",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
    lastUserMessageAt: null,
    pendingPermissions: [],
    title: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    ...input,
  } as unknown as Agent;
}

const question = {
  id: "perm_q",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }] }] },
} as unknown as PermissionRequest;

const workspaces = new Map<string, Workspace>();

describe("projectLanes", () => {
  it("puts a running agent with a pending question in Needs you only", () => {
    const lanes = projectLanes(
      [agent({ id: "a", status: "running", pendingPermissions: [question] })],
      workspaces,
    );
    expect(lanes.needsYou.map((card) => card.reason)).toEqual(["question"]);
    expect(lanes.working).toEqual([]);
    expect(lanes.done).toEqual([]);
  });

  it("rolls a same-workspace subagent's request up into its root", () => {
    const lanes = projectLanes(
      [
        agent({ id: "root", status: "running" }),
        agent({
          id: "child",
          labels: { "paseo.parent-agent-id": "root" },
          pendingPermissions: [question],
        }),
      ],
      workspaces,
    );
    expect(lanes.needsYou).toHaveLength(1);
    expect(lanes.needsYou[0].agent.id).toBe("root");
    expect(lanes.needsYou[0].subject.id).toBe("child");
    expect(lanes.needsYou[0].subagentCount).toBe(1);
  });

  it("uses the oldest requesting child's identity and attention time", () => {
    const lanes = projectLanes(
      [
        agent({ id: "root", updatedAt: "2026-09-04T08:00:00Z" }),
        agent({
          id: "later",
          labels: { "paseo.parent-agent-id": "root" },
          pendingPermissions: [question],
          attentionTimestamp: "2026-09-04T11:00:00Z",
        }),
        agent({
          id: "earlier",
          labels: { "paseo.parent-agent-id": "root" },
          pendingPermissions: [question],
          attentionTimestamp: "2026-09-04T10:00:00Z",
        }),
      ],
      workspaces,
    );
    expect(lanes.needsYou[0].subject.id).toBe("earlier");
    expect(lanes.needsYou[0].since).toBe("2026-09-04T10:00:00Z");
    expect(lanes.needsYou[0].members).toHaveLength(3);
  });

  it("keeps unread child results available after the parent has been read", () => {
    const lanes = projectLanes(
      [
        agent({ id: "root" }),
        agent({
          id: "child",
          labels: { "paseo.parent-agent-id": "root" },
          requiresAttention: true,
          attentionReason: "finished",
        }),
      ],
      workspaces,
    );
    expect(lanes.done[0].agent.id).toBe("root");
    expect(lanes.done[0].subject.id).toBe("child");
  });

  it("keeps a cross-workspace subagent as its own card", () => {
    const lanes = projectLanes(
      [
        agent({ id: "root", status: "running" }),
        agent({
          id: "child",
          labels: { "paseo.parent-agent-id": "root" },
          workspaceId: "ws_2",
          status: "running",
        }),
      ],
      workspaces,
    );
    expect(lanes.working.map((card) => card.agent.id).sort()).toEqual(["child", "root"]);
  });

  it("hides idle agents without attention and archived agents", () => {
    const lanes = projectLanes(
      [
        agent({ id: "idle" }),
        agent({
          id: "archived",
          requiresAttention: true,
          attentionReason: "finished",
          archivedAt: "2026-09-04T11:00:00.000Z",
        }),
      ],
      workspaces,
    );
    expect(lanes).toEqual({ needsYou: [], working: [], done: [] });
  });

  it("sorts Needs you oldest first and Done newest first", () => {
    const lanes = projectLanes(
      [
        agent({
          id: "newer",
          requiresAttention: true,
          attentionReason: "error",
          status: "error",
          attentionTimestamp: "2026-09-04T10:05:00.000Z",
        }),
        agent({
          id: "older",
          pendingPermissions: [question],
          attentionTimestamp: "2026-09-04T10:01:00.000Z",
        }),
        agent({
          id: "done-old",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-09-04T09:00:00.000Z",
        }),
        agent({
          id: "done-new",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-09-04T09:30:00.000Z",
        }),
      ],
      workspaces,
    );
    expect(lanes.needsYou.map((card) => card.agent.id)).toEqual(["older", "newer"]);
    expect(lanes.done.map((card) => card.agent.id)).toEqual(["done-new", "done-old"]);
  });

  it("filters to one workspace when asked", () => {
    const lanes = projectLanes(
      [
        agent({ id: "a", status: "running" }),
        agent({ id: "b", status: "running", workspaceId: "ws_2" }),
      ],
      workspaces,
      { workspaceId: "ws_2" },
    );
    expect(lanes.working.map((card) => card.agent.id)).toEqual(["b"]);
  });
});

describe("formatSince", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  it("formats seconds, minutes, hours, and days", () => {
    expect(formatSince("2026-09-04T11:59:30.000Z", now)).toBe("30s");
    expect(formatSince("2026-09-04T11:40:00.000Z", now)).toBe("20m");
    expect(formatSince("2026-09-04T09:00:00.000Z", now)).toBe("3h");
    expect(formatSince("2026-09-01T12:00:00.000Z", now)).toBe("3d");
    expect(formatSince(null, now)).toBe("");
  });
});

describe("formatUntil", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  it("counts down future timestamps and marks past ones due", () => {
    expect(formatUntil("2026-09-04T12:00:40.000Z", now)).toBe("in 40s");
    expect(formatUntil("2026-09-04T12:40:00.000Z", now)).toBe("in 40m");
    expect(formatUntil("2026-09-04T11:00:00.000Z", now)).toBe("due now");
    expect(formatUntil(null, now)).toBe("");
  });
});

describe("urgencyLevel", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  const base = {
    lane: "needsYou",
    reason: "question",
    since: "2026-09-04T11:00:00.000Z",
  } as InboxCard;
  it("treats errors as urgent immediately and ages requests into warnings", () => {
    expect(urgencyLevel({ ...base, reason: "error" } as InboxCard, now)).toBe("danger");
    expect(urgencyLevel(base, now)).toBe("normal");
    expect(urgencyLevel({ ...base, since: "2026-09-04T07:00:00.000Z" } as InboxCard, now)).toBe(
      "warn",
    );
    expect(urgencyLevel({ ...base, since: "2026-09-03T10:00:00.000Z" } as InboxCard, now)).toBe(
      "danger",
    );
    expect(urgencyLevel({ ...base, lane: "working" } as InboxCard, now)).toBe("normal");
  });
});

describe("laneFlexGrow", () => {
  it("shrinks empty lanes and widens busy ones up to a cap", () => {
    expect(laneFlexGrow(0)).toBeLessThan(1);
    expect(laneFlexGrow(1)).toBeGreaterThan(1);
    expect(laneFlexGrow(100)).toBe(laneFlexGrow(4));
  });
});

describe("quietText", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  it("anchors on the newest row's timestamp, not on observation time", () => {
    // A card mounted three hours into a stall reports the real stall length.
    expect(quietText("2026-09-04T09:00:00.000Z", false, now)).toBe("quiet 3h");
    expect(quietText("2026-09-04T11:59:30.000Z", false, now)).toBeNull();
    expect(quietText(null, false, now)).toBeNull();
  });

  it("stays silent while a tool call or compaction is in flight", () => {
    const stale = "2026-09-04T08:00:00.000Z";
    expect(quietText(stale, true, now)).toBeNull();
  });
});

describe("activityInFlight", () => {
  it("treats running tool calls and loading compactions as in-flight", () => {
    expect(activityInFlight({ type: "tool_call", status: "running" } as never)).toBe(true);
    expect(activityInFlight({ type: "tool_call", status: "completed" } as never)).toBe(false);
    expect(activityInFlight({ type: "compaction", status: "loading" } as never)).toBe(true);
    expect(activityInFlight({ type: "assistant_message", text: "hi" })).toBe(false);
    expect(activityInFlight(undefined)).toBe(false);
  });
});
