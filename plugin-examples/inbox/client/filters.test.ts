import { describe, expect, it } from "vitest";
import { filterLanes, parseFilters } from "./filters";
import type { InboxCard, Lanes } from "./lanes";

const cards = [
  { agent: { id: "a" }, workspace: { projectId: "p1", projectGroup: "Work" } },
  { agent: { id: "b" }, workspace: { projectId: "p2", projectGroup: "Personal" } },
  { agent: { id: "c" }, workspace: { projectId: "p3", projectGroup: null } },
] as InboxCard[];
const agentId = (card: InboxCard) => card.agent.id;
const lanes: Lanes = { needsYou: cards, working: cards, done: cards };

describe("project and group filters", () => {
  it("intersects project and group on every lane without changing the host queue", () => {
    const result = filterLanes(lanes, { projectId: "p1", projectGroup: "Work" });
    expect(Object.values(result).map((lane) => lane.map(agentId))).toEqual([["a"], ["a"], ["a"]]);
    expect(filterLanes(lanes, { projectId: "p1", projectGroup: "Personal" }).needsYou).toEqual([]);
    expect(filterLanes(lanes, { projectId: null, projectGroup: "" }).needsYou).toEqual([cards[2]]);
    expect(lanes.needsYou).toHaveLength(3);
  });
  it("validates stored preferences, including the ungrouped selection", () => {
    expect(parseFilters(null)).toEqual({ projectId: null, projectGroup: null });
    expect(parseFilters('{"projectId":null,"projectGroup":""}').projectGroup).toBe("");
    expect(() => parseFilters('{"projectId":123}')).toThrow("invalid");
    expect(() => parseFilters("broken")).toThrow();
  });
});
