import { describe, expect, it } from "vitest";
import { boardLanes, boardReady, searchLanes } from "./review";
import { EMPTY_SNAPSHOT } from "./store";
import type { InboxCard } from "./lanes";

const card = {
  agent: { id: "a", workspaceId: "ws" },
  workspace: { projectId: "project" },
} as InboxCard;
const snapshot = {
  ...EMPTY_SNAPSHOT,
  loaded: true,
  lanes: { needsYou: [card], working: [], done: [] },
};

describe("review scope", () => {
  it("withholds global review targets until saved filters finish loading", () => {
    expect(boardReady(snapshot)).toBe(false);
    expect(boardLanes(snapshot).needsYou).toEqual([]);
    const ready = {
      ...snapshot,
      filtersReady: true,
      filters: { projectId: "other", projectGroup: null },
    };
    expect(boardReady(ready)).toBe(true);
    expect(boardLanes(ready).needsYou).toEqual([]);
  });
  it("keeps explicit workspace panels independent of the global filters", () => {
    expect(boardReady(snapshot, "ws")).toBe(true);
    expect(boardLanes(snapshot, "ws").needsYou).toEqual([card]);
    expect(boardLanes(snapshot, "other").needsYou).toEqual([]);
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
