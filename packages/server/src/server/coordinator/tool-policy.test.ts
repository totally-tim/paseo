import { describe, expect, test } from "vitest";

import {
  COORDINATOR_PROJECT_ID_LABEL,
  COORDINATOR_PROJECT_ROLE,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";

import { assertCoordinatorToolAllowed, CoordinatorToolDeniedError } from "./tool-policy.js";

const coordinator = {
  labels: {
    [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
    [COORDINATOR_PROJECT_ID_LABEL]: "prj_1",
  },
};

describe("assertCoordinatorToolAllowed", () => {
  test("observe coordinators may read and remember", () => {
    for (const tool of [
      "list_workspaces",
      "list_agents",
      "get_agent_status",
      "get_agent_activity",
      "list_pending_permissions",
      "capture_terminal",
      "inspect_schedule",
      "remember",
    ]) {
      expect(() => assertCoordinatorToolAllowed(coordinator, tool)).not.toThrow();
    }
  });

  test("observe coordinators may not spawn, mutate, or answer", () => {
    for (const tool of [
      "create_agent",
      "send_agent_prompt",
      "archive_agent",
      "respond_to_permission",
      "create_workspace",
      "archive_workspace",
      "start_workspace_script",
      "create_terminal",
      "create_schedule",
      "handoff_agent",
      "set_agent_mode",
    ]) {
      expect(() => assertCoordinatorToolAllowed(coordinator, tool)).toThrow(
        CoordinatorToolDeniedError,
      );
      expect(() => assertCoordinatorToolAllowed(coordinator, tool)).toThrow(
        /not available to a coordinator at Observe trust/,
      );
    }
  });

  test("non-coordinator callers pass through", () => {
    expect(() => assertCoordinatorToolAllowed({ labels: {} }, "create_agent")).not.toThrow();
    expect(() => assertCoordinatorToolAllowed(null, "create_agent")).not.toThrow();
    expect(() => assertCoordinatorToolAllowed(undefined, "create_agent")).not.toThrow();
  });

  test("the denial message names the tool", () => {
    try {
      assertCoordinatorToolAllowed(coordinator, "create_agent");
      expect.unreachable("expected a denial");
    } catch (error) {
      expect((error as CoordinatorToolDeniedError).toolName).toBe("create_agent");
      expect((error as Error).message).toContain("create_agent");
    }
  });
});
