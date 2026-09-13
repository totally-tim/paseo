import { describe, expect, it } from "vitest";
import {
  buildNotificationActions,
  COORDINATOR_NOTIFICATION_CATEGORIES,
} from "./notification-actions.js";
import {
  CoordinatorDecisionBoardRowSchema,
  CoordinatorPermissionDeferRequestSchema,
  CoordinatorPermissionDeferResponseSchema,
  AgentPermissionRequestPayloadSchema,
  CoordinatorGlobalUpdateRequestSchema,
  GlobalCoordinatorStateSchema,
} from "./messages.js";

describe("coordinator notification contract", () => {
  it("distinguishes deferred and policy actions without inferring from labels", () => {
    const action = CoordinatorDecisionBoardRowSchema.shape.actions.element;
    expect(action.parse({ id: "leave", label: "Leave it", operation: "defer" }).operation).toBe(
      "defer",
    );
    expect(
      action.parse({ id: "always", label: "Always allow this", operation: "policy" }).operation,
    ).toBe("policy");
    expect(action.parse({ id: "allow", label: "Allow" })).toEqual({ id: "allow", label: "Allow" });
    expect(action.safeParse({ id: "bad", label: "Bad", operation: "allow" }).success).toBe(false);
  });

  it("acknowledges a deferral without describing the pending permission as resolved", () => {
    const request = {
      type: "coordinator.permission.defer.request",
      agentId: "agent",
      requestId: "permission",
    };
    expect(CoordinatorPermissionDeferRequestSchema.parse(request)).toEqual(request);
    const response = {
      type: "coordinator.permission.defer.response",
      payload: { agentId: "agent", requestId: "permission", error: null },
    };
    expect(CoordinatorPermissionDeferResponseSchema.parse(response)).toEqual(response);
  });

  it("only publishes answer buttons with an exactly registered label set", () => {
    for (const category of COORDINATOR_NOTIFICATION_CATEGORIES.slice(0, 3)) {
      const result = buildNotificationActions(
        category.actions.map((action) => ({ ...action, behavior: "allow" })),
      );
      expect(result.categoryIdentifier).toBe(category.id);
      expect(result.actions?.map((action) => action.id)).toEqual(
        category.actions.map((action) => action.id),
      );
    }
    expect(
      buildNotificationActions([{ id: "x", label: "Looks right", behavior: "allow" }]),
    ).toEqual({ categoryIdentifier: "paseo.coordinator.open" });
    expect(
      buildNotificationActions([
        { id: "open", label: "Open", behavior: "allow" },
        { id: "changes", label: "Request changes", behavior: "deny" },
      ]),
    ).toEqual({ categoryIdentifier: "paseo.coordinator.open" });
  });
  it("accepts legacy requests and preserves optional deadlines and answers", () => {
    const legacy = { id: "r", provider: "codex", name: "decision", kind: "question" };
    expect(AgentPermissionRequestPayloadSchema.parse(legacy)).toEqual(legacy);
    const timed = {
      ...legacy,
      timeoutAt: "2026-09-13T12:00:00.000Z",
      defaultAnswer: { behavior: "allow", updatedInput: { choice: "retry" } },
    };
    expect(AgentPermissionRequestPayloadSchema.parse(timed)).toEqual(timed);
  });
  it("keeps global settings optional and validates partial edits without wire defaults", () => {
    const legacy = {
      enabled: false,
      agentId: null,
      workspaceId: null,
      projectId: null,
      trustLevel: "observe",
    };
    expect(GlobalCoordinatorStateSchema.parse(legacy)).toEqual(legacy);
    const update = {
      type: "coordinator.global.update.request",
      requestId: "r",
      notificationSettings: { digestHour: 9 },
    };
    expect(CoordinatorGlobalUpdateRequestSchema.parse(update)).toEqual(update);
    expect(
      CoordinatorGlobalUpdateRequestSchema.safeParse({
        ...update,
        notificationSettings: { quietEndHour: 24 },
      }).success,
    ).toBe(false);
  });
});
