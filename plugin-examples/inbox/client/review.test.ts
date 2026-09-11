import { describe, expect, it } from "vitest";
import {
  boardLanes,
  boardReady,
  filterNeedsYouReason,
  groupCardsByProject,
  searchLanes,
} from "./review";
import { EMPTY_SNAPSHOT } from "./store";
import type { InboxCard } from "./lanes";

const agent = { id: "a", workspaceId: "ws", attentionTimestamp: null };
const card = {
  agent,
  subject: agent,
  workspace: { projectId: "project" },
  since: "2026-09-04T10:00:00.000Z",
} as InboxCard;
const snapshot = {
  ...EMPTY_SNAPSHOT,
  loaded: true,
  snoozedReady: true,
  lanes: { needsYou: [card], working: [], done: [] },
};

describe("review scope", () => {
  it("withholds global review targets until saved filters finish loading", () => {
    expect(boardReady(snapshot)).toBe(false);
    expect(boardLanes(snapshot).needsYou).toEqual([]);
    const ready = {
      ...snapshot,
      filtersReady: true,
      filters: { projectId: "other", projectGroup: null, groupByProject: false },
    };
    expect(boardReady(ready)).toBe(true);
    expect(boardLanes(ready).needsYou).toEqual([]);
  });
  it("withholds the board until saved snoozes finish loading", () => {
    expect(boardReady({ ...snapshot, snoozedReady: false }, "ws")).toBe(false);
  });
  it("keeps explicit workspace panels independent of the global filters", () => {
    expect(boardReady(snapshot, "ws")).toBe(true);
    expect(boardLanes(snapshot, "ws").needsYou).toEqual([card]);
    expect(boardLanes(snapshot, "other").needsYou).toEqual([]);
  });
});

describe("snoozed cards", () => {
  it("leaves the review queue but resurfaces when the wait state changes", () => {
    const snoozed = {
      ...snapshot,
      filtersReady: true,
      snoozed: new Map([["a", card.since ?? ""]]),
    };
    const lanes = boardLanes(snoozed);
    expect(lanes.needsYou).toEqual([]);
    expect(lanes.snoozed).toEqual([card]);
    const renewed = {
      ...snoozed,
      lanes: {
        needsYou: [{ ...card, since: "2026-09-04T11:00:00.000Z" } as InboxCard],
        working: [],
        done: [],
      },
    };
    expect(boardLanes(renewed).needsYou).toHaveLength(1);
    expect(boardLanes(renewed).snoozed).toEqual([]);
  });
});

describe("reason filter and grouping", () => {
  const error = { ...card, agent: { id: "b", workspaceId: "ws" }, reason: "error" } as InboxCard;
  const question = { ...card, reason: "question" } as InboxCard;
  it("filters the needs-you lane by request reason only", () => {
    const lanes = { needsYou: [question, error], working: [error], done: [] };
    const result = filterNeedsYouReason(lanes, "error");
    expect(result.needsYou).toEqual([error]);
    expect(result.working).toEqual([error]);
    expect(filterNeedsYouReason(lanes, null)).toBe(lanes);
  });
  it("groups cards by project in first-appearance order", () => {
    const other = {
      ...card,
      agent: { id: "c", workspaceId: "ws" },
      workspace: { projectId: "two", projectDisplayName: "Two" },
    } as InboxCard;
    const own = {
      ...card,
      agent: { id: "d", workspaceId: "ws" },
      workspace: { projectId: "project", projectDisplayName: "One" },
    } as InboxCard;
    const groups = groupCardsByProject([question, other, own]);
    expect(groups.map((group) => group.label)).toEqual(["No project", "Two"]);
    expect(groups[0].cards).toEqual([question, own]);
  });
});

describe("board search", () => {
  const parent = {
    ...card,
    agent: { ...card.agent, title: "Parent", provider: "codex" },
    members: [{ ...card.agent, title: "Review migrations" }],
    workspace: { ...card.workspace, name: "Backend", projectDisplayName: "Paseo" },
  } as InboxCard;
  const lanes = { needsYou: [parent], working: [], done: [] };
  it("searches children and workspace context without losing card membership", () => {
    expect(searchLanes(lanes, "  MIGRATIONS ").needsYou).toEqual([parent]);
    expect(searchLanes(lanes, "paseo backend").needsYou).toEqual([parent]);
    expect(searchLanes(lanes, "missing").needsYou).toEqual([]);
    expect(searchLanes(lanes, "")).toBe(lanes);
  });
});
