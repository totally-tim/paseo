import { expect, it } from "vitest";
import {
  CoordinatorMemoryGetRequestSchema,
  CoordinatorMemoryUpdateRequestSchema,
  CoordinatorGlobalUpdateRequestSchema,
  CoordinatorProjectUpdateRequestSchema,
  GlobalCoordinatorStateSchema,
  ProjectCoordinatorStateSchema,
} from "./messages.js";

it("preserves empty pane edits, exact revision and scope while rejecting team pane access", () => {
  const update = {
    type: "coordinator.memory.update.request",
    requestId: "rpc",
    scope: "personal-project",
    projectId: "project",
    content: "",
    expectedRevision: "sha256",
  };
  expect(CoordinatorMemoryUpdateRequestSchema.parse(update)).toEqual(update);
  expect(
    CoordinatorMemoryGetRequestSchema.safeParse({
      type: "coordinator.memory.get.request",
      requestId: "rpc",
      scope: "team",
    }).success,
  ).toBe(false);
});
it("keeps rotation configuration additive and supports clearing a coordinator fallback", () => {
  const global = {
    enabled: false,
    agentId: null,
    workspaceId: null,
    projectId: null,
    trustLevel: "observe",
  };
  expect(GlobalCoordinatorStateSchema.parse(global)).toEqual(global);
  const project = {
    enabled: false,
    agentId: null,
    projectId: "project",
    trustLevel: "observe",
    scope: "everything",
  };
  expect(ProjectCoordinatorStateSchema.parse(project)).toEqual(project);
  const edit = { requestId: "rpc", fallbackProfile: null, rotationThresholdPercent: 60 };
  expect(
    CoordinatorGlobalUpdateRequestSchema.parse({
      type: "coordinator.global.update.request",
      ...edit,
    }),
  ).toMatchObject(edit);
  expect(
    CoordinatorProjectUpdateRequestSchema.parse({
      type: "coordinator.project.update.request",
      projectId: "project",
      ...edit,
    }),
  ).toMatchObject(edit);
  expect(
    CoordinatorGlobalUpdateRequestSchema.safeParse({
      type: "coordinator.global.update.request",
      ...edit,
      rotationThresholdPercent: 101,
    }).success,
  ).toBe(false);
});
