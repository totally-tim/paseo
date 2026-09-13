import { expect, it } from "vitest";
import {
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
  buildDeterministicWorkspaceTabId,
} from "@/workspace-tabs/identity";
import { panelSupportsHost } from "@/panels/panel-manifest";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
it("restores personal memory and keeps project scopes separate when reusing panes", () => {
  const personal: WorkspaceTabTarget = { kind: "coordinator_memory", scope: "personal" };
  const project: WorkspaceTabTarget = {
    kind: "coordinator_memory",
    scope: "personal-project",
    projectId: "p1",
  };
  const restored = normalizeWorkspaceTabTarget(JSON.parse(JSON.stringify(project)));
  expect(restored).toEqual(project);
  expect(workspaceTabTargetsEqual(project, restored!)).toBe(true);
  expect(workspaceTabTargetsEqual(project, personal)).toBe(false);
  expect(workspaceTabTargetsEqual(project, { ...project, projectId: "p2" })).toBe(false);
  expect(buildDeterministicWorkspaceTabId(project)).not.toBe(
    buildDeterministicWorkspaceTabId(personal),
  );
  expect(panelSupportsHost("coordinator_memory", "main")).toBe(true);
  expect(panelSupportsHost("coordinator_memory", "explorer")).toBe(false);
  expect(
    normalizeWorkspaceTabTarget({
      kind: "coordinator_memory",
      scope: "personal-project",
      projectId: " ",
    }),
  ).toBeNull();
});
