import { describe, expect, it } from "vitest";
import type {
  CoordinatorBoardSnapshot,
  CoordinatorDecisionBoardRow,
} from "@getpaseo/protocol/messages";
import { projectGlobalBoard, globalBoardProjectOptions } from "./global-board-model";

function board(
  projectId: string,
  extra: Partial<CoordinatorBoardSnapshot> = {},
): CoordinatorBoardSnapshot {
  return {
    projectId,
    projectName: projectId,
    coordinatorAgentId: `${projectId}-agent`,
    enabled: true,
    scope: "everything",
    trustLevel: "observe",
    needsYou: [],
    working: [],
    done: [],
    wake: null,
    ...extra,
  };
}
function decision(projectId: string, askedAt: string): CoordinatorDecisionBoardRow {
  return {
    kind: "decision",
    id: projectId,
    projectId,
    agentId: `${projectId}-agent`,
    requestId: projectId,
    question: "Continue?",
    askedAt,
    actions: [],
  };
}
describe("global board projection", () => {
  it("orders decisions across projects oldest first and retains project identity", () => {
    const global = board("global", { tier: "global" });
    const a = board("a", { needsYou: [decision("a", "2026-09-13T12:00:00Z")] });
    const b = board("b", { needsYou: [decision("b", "2026-09-13T10:00:00Z")] });
    const result = projectGlobalBoard(
      [global, a, b, board("disabled", { enabled: false })],
      global,
      null,
    );
    expect(result.board.needsYou.map((row) => row.projectId)).toEqual(["b", "a"]);
    expect(result.groups.map((group) => group.projectId)).toEqual(["a", "b", "global"]);
    expect(result.board.coordinatorAgentId).toBe("global-agent");
  });
  it("filters all row sections without changing the global composer target", () => {
    const global = board("global", { tier: "global" });
    const a = board("a", { needsYou: [decision("a", "2026-09-13T12:00:00Z")] });
    const b = board("b", { needsYou: [decision("b", "2026-09-13T10:00:00Z")] });
    const result = projectGlobalBoard([global, a, b], global, "b");
    expect(result.groups).toEqual([b]);
    expect(result.board.needsYou).toEqual(b.needsYou);
    expect(result.board.working).toEqual(b.working);
    expect(result.board.done).toEqual(b.done);
    expect(result.board.projectId).toBe("global");
    expect(result.board.coordinatorAgentId).toBe("global-agent");
  });
});

describe("global setup proposal filtering", () => {
  it("keeps a setup proposal for its target project before that project has a board", () => {
    const setup = {
      ...decision("global", "2026-09-13T10:00:00Z"),
      id: "setup-new",
      setupProjectId: "new",
    };
    const unrelated = { ...setup, id: "setup-other", setupProjectId: "other" };
    const general = { ...decision("global", "2026-09-13T09:00:00Z"), id: "general" };
    const global = board("global", { tier: "global", needsYou: [setup, unrelated, general] });
    const result = projectGlobalBoard([global, board("active")], global, "new");
    expect(result.board.needsYou).toEqual([setup]);
    expect(result.groups).toEqual([]);
    expect(result.board.coordinatorAgentId).toBe("global-agent");
    expect(projectGlobalBoard([global], global, null).board.needsYou).toEqual([
      general,
      setup,
      unrelated,
    ]);
  });
});

it("offers visible host projects without boards and excludes hidden coordinator backing records", () => {
  const projects = [
    { projectId: "new", projectDisplayName: "New project", projectCustomName: null },
    {
      projectId: "active",
      projectDisplayName: "Repository",
      projectCustomName: "Alpha",
      hidden: false,
    },
    {
      projectId: "global",
      projectDisplayName: "Coordinator",
      projectCustomName: null,
      hidden: true,
    },
  ];
  expect(globalBoardProjectOptions(projects)).toEqual([
    { projectId: "active", projectName: "Alpha" },
    { projectId: "new", projectName: "New project" },
  ]);
  expect(projects).toHaveLength(3);
});
