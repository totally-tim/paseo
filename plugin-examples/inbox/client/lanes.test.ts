import { describe, expect, it } from "vitest";
import {
  activityInFlight,
  canSnooze,
  formatSince,
  formatUntil,
  type InboxCard,
  laneFlexGrow,
  projectLanes,
  quietText,
  snoozeStamp,
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

  it("ages a request from its own requestedAt, not the agent's later activity", () => {
    const lanes = projectLanes(
      [
        agent({
          id: "a",
          updatedAt: "2026-09-04T11:00:00.000Z",
          pendingPermissions: [{ ...question, requestedAt: "2026-09-04T09:00:00.000Z" }],
        }),
      ],
      workspaces,
    );
    expect(lanes.needsYou[0].since).toBe("2026-09-04T09:00:00.000Z");
  });

  it("orders pending requests by requestedAt ahead of agent activity", () => {
    const lanes = projectLanes(
      [
        agent({
          id: "newer-activity-older-request",
          updatedAt: "2026-09-04T11:00:00.000Z",
          pendingPermissions: [{ ...question, requestedAt: "2026-09-04T08:00:00.000Z" }],
        }),
        agent({
          id: "older-activity-newer-request",
          updatedAt: "2026-09-04T07:00:00.000Z",
          pendingPermissions: [{ ...question, requestedAt: "2026-09-04T09:00:00.000Z" }],
        }),
      ],
      workspaces,
    );
    expect(lanes.needsYou.map((card) => card.agent.id)).toEqual([
      "newer-activity-older-request",
      "older-activity-newer-request",
    ]);
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

describe("snoozeStamp", () => {
  const subject = agent({ id: "s", attentionTimestamp: null });
  const base = { since: "2026-09-04T10:00:00.000Z", request: null, subject } as InboxCard;
  it("keys a request card on the request id, not the shared since", () => {
    const first = { ...base, request: { ...question, id: "req_1" } } as InboxCard;
    const replaced = { ...base, request: { ...question, id: "req_2" } } as InboxCard;
    expect(snoozeStamp(first)).not.toBe(snoozeStamp(replaced));
    expect(snoozeStamp({ ...first, request: { ...question, id: "req_1" } } as InboxCard)).toBe(
      snoozeStamp(first),
    );
  });
  it("keys a request card on requestedAt too, so a reused id from a later turn is a different stamp", () => {
    const original = {
      ...base,
      request: { ...question, id: "req_1", requestedAt: "2026-09-04T09:00:00.000Z" },
    } as InboxCard;
    const retried = {
      ...base,
      request: { ...question, id: "req_1", requestedAt: "2026-09-04T11:00:00.000Z" },
    } as InboxCard;
    expect(snoozeStamp(original)).not.toBe(snoozeStamp(retried));
  });
  it("keys an error card, which has no request, on its subject's attentionTimestamp", () => {
    const error = {
      ...base,
      request: null,
      subject: agent({ id: "s", attentionTimestamp: "2026-09-04T09:00:00.000Z" }),
    } as InboxCard;
    expect(snoozeStamp(error)).toBe("2026-09-04T09:00:00.000Z");
  });
  it("falls back to lastError, then since, when an error card has no attentionTimestamp", () => {
    const withLastError = {
      ...base,
      request: null,
      subject: agent({ id: "s", attentionTimestamp: null, lastError: "boom" }),
    } as InboxCard;
    expect(snoozeStamp(withLastError)).toBe("boom");
    const withNeither = {
      ...base,
      request: null,
      subject: agent({ id: "s", attentionTimestamp: null }),
    } as InboxCard;
    expect(snoozeStamp(withNeither)).toBe("2026-09-04T10:00:00.000Z");
  });
  it("keeps an error card's stamp when its updatedAt changes but the error doesn't", () => {
    const errored = agent({
      id: "err",
      status: "error",
      attentionTimestamp: null,
      lastError: "boom",
      updatedAt: "2026-09-04T10:00:00.000Z",
    });
    const before = projectLanes([errored], workspaces).needsYou[0];
    const after = projectLanes([{ ...errored, updatedAt: "2026-09-04T12:00:00.000Z" }], workspaces)
      .needsYou[0];
    expect(snoozeStamp(before)).toBe("boom");
    expect(snoozeStamp(before)).toBe(snoozeStamp(after));
  });
});

describe("canSnooze", () => {
  const subject = agent({ id: "s" });
  it("is true for an error card whose subject has an attentionTimestamp", () => {
    const errored = agent({ id: "s", attentionTimestamp: "2026-09-04T09:00:00.000Z" });
    const card = { reason: "error", request: null, subject: errored } as InboxCard;
    expect(canSnooze(card)).toBe(true);
  });
  it("is true for an error card whose subject has lastError but no attentionTimestamp", () => {
    const errored = agent({ id: "s", attentionTimestamp: null, lastError: "boom" });
    const card = { reason: "error", request: null, subject: errored } as InboxCard;
    expect(canSnooze(card)).toBe(true);
  });
  it("is false for an error card whose subject has neither field", () => {
    // Without attentionTimestamp or lastError, snoozeStamp falls back to
    // `since`, which tracks the agent's own activity and moves on every
    // broadcast — the card would resurface immediately after being snoozed.
    const errored = agent({ id: "s", attentionTimestamp: null });
    const card = { reason: "error", request: null, subject: errored } as InboxCard;
    expect(canSnooze(card)).toBe(false);
  });
  it("is true for a question or permission card whose request carries requestedAt", () => {
    const stamped = { ...question, requestedAt: "2026-09-04T09:00:00.000Z" };
    expect(canSnooze({ reason: "question", request: stamped, subject } as InboxCard)).toBe(true);
    expect(canSnooze({ reason: "permission", request: stamped, subject } as InboxCard)).toBe(true);
  });
  it("is false for a question or permission card whose request has no requestedAt", () => {
    // Without requestedAt the stamp falls back to `since`, which tracks the
    // agent's own activity and moves on every broadcast — the card would
    // resurface immediately after being snoozed.
    expect(canSnooze({ reason: "question", request: question, subject } as InboxCard)).toBe(false);
  });
  it("is false for working and finished cards", () => {
    expect(canSnooze({ reason: "working", request: null, subject } as InboxCard)).toBe(false);
    expect(canSnooze({ reason: "finished", request: null, subject } as InboxCard)).toBe(false);
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
