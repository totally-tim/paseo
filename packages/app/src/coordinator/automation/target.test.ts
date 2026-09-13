import { expect, it } from "vitest";
import {
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
  buildDeterministicWorkspaceTabId,
} from "@/workspace-tabs/identity";
import { panelSupportsHost } from "@/panels/panel-manifest";
it.each(["coordinator_goals", "coordinator_policy"] as const)(
  "restores %s as an ordinary pane without conflating project and host scope",
  (kind) => {
    const global = { kind };
    const project = { kind, projectId: "p1" };
    expect(normalizeWorkspaceTabTarget(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(workspaceTabTargetsEqual(global, project)).toBe(false);
    expect(workspaceTabTargetsEqual(project, { kind, projectId: "p2" })).toBe(false);
    expect(buildDeterministicWorkspaceTabId(project)).not.toBe(
      buildDeterministicWorkspaceTabId(global),
    );
    expect(panelSupportsHost(kind, "main")).toBe(true);
    expect(panelSupportsHost(kind, "explorer")).toBe(false);
  },
);
