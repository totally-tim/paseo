import { expect, test } from "vitest";
import { emptyOrder, mergeHostOrders, orderForHost } from "./projection";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
const project = (
  viewKey: string,
  serverId: string,
  projectId: string,
  group: string,
): WorkspaceStructureProject => ({
  viewKey,
  projectKey: viewKey,
  projectName: viewKey,
  group,
  projectKind: "git",
  iconWorkingDir: "/tmp",
  hosts: [{ serverId, projectId, iconWorkingDir: "/tmp", worktreeSupport: "supported" }],
  workspaceKeys: [`${serverId}:${projectId}-one`, `${serverId}:${projectId}-two`],
});
test("imports the desktop order using host-local IDs, including projects hidden by filters", () => {
  const projects = [
    project("first", "a", "p1", "Work"),
    project("hidden", "a", "p2", "Personal"),
    project("remote", "b", "p3", "Other"),
  ];
  expect(
    orderForHost(
      "a",
      {
        ...emptyOrder(),
        projectOrder: ["hidden", "first", "remote"],
        projectGroupOrder: ["personal", "work"],
        pinnedWorkspaceOrder: ["b:p3-one", "a:p2-one"],
        workspaceOrderByProject: { first: ["a:p1-two", "a:p1-one"] },
      },
      projects,
    ),
  ).toEqual({
    projectOrder: ["p2", "p1"],
    projectGroupOrder: ["personal", "work"],
    pinnedWorkspaceOrder: ["p2-one"],
    workspaceOrderByProject: { p1: ["p1-two", "p1-one"], p2: ["p2-one", "p2-two"] },
  });
});
test("merges hosts by stable ID with first occurrence winning for shared projects and groups", () => {
  const projects = [project("shared", "a", "p1", "Work"), project("other", "b", "p2", "Personal")];
  projects[0].hosts.push({
    serverId: "b",
    projectId: "p3",
    iconWorkingDir: "/tmp",
    worktreeSupport: "supported",
  });
  const a = {
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectOrder: ["p1"], projectGroupOrder: ["work", "personal"] },
  };
  const b = {
    revision: 9,
    initialized: true,
    order: { ...emptyOrder(), projectOrder: ["p2", "p3"], projectGroupOrder: ["personal", "work"] },
  };
  expect(mergeHostOrders({ b, a }, emptyOrder(), projects)).toEqual(
    mergeHostOrders({ a, b }, emptyOrder(), projects),
  );
  expect(mergeHostOrders({ b, a }, emptyOrder(), projects).projectOrder).toEqual([
    "shared",
    "other",
  ]);
  expect(mergeHostOrders({ b, a }, emptyOrder(), projects).projectGroupOrder).toEqual([
    "work",
    "personal",
  ]);
});
test("uninitialized host retains the device arrangement until an explicit import", () => {
  const projects = [project("first", "a", "p1", "Work"), project("second", "a", "p2", "Work")];
  const local = { ...emptyOrder(), projectOrder: ["second", "first"] };
  expect(
    mergeHostOrders(
      { a: { revision: 0, initialized: false, order: emptyOrder() } },
      local,
      projects,
    ).projectOrder,
  ).toEqual(["second", "first"]);
});
