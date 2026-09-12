import { describe, expect, test } from "vitest";

import {
  COORDINATOR_PROJECT_ID_LABEL,
  COORDINATOR_PROJECT_ROLE,
  COORDINATOR_TRUST_LABEL,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { CoordinatorTrustLevel } from "@getpaseo/protocol/messages";

import {
  assertCoordinatorToolAllowed,
  coordinatorTrustAtLeast,
  coordinatorTrustLevelFromLabels,
  CoordinatorToolDeniedError,
} from "./tool-policy.js";

const coordinatorAt = (trustLevel?: CoordinatorTrustLevel | string) => ({
  labels: {
    [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
    [COORDINATOR_PROJECT_ID_LABEL]: "prj_1",
    ...(trustLevel ? { [COORDINATOR_TRUST_LABEL]: trustLevel } : {}),
  },
});

const coordinator = coordinatorAt();

describe("coordinatorTrustLevelFromLabels", () => {
  test("absent, unknown, and non-string values fail closed to observe", () => {
    expect(coordinatorTrustLevelFromLabels(undefined)).toBe("observe");
    expect(coordinatorTrustLevelFromLabels({})).toBe("observe");
    expect(coordinatorTrustLevelFromLabels({ [COORDINATOR_TRUST_LABEL]: "godmode" })).toBe(
      "observe",
    );
    expect(coordinatorTrustLevelFromLabels({ [COORDINATOR_TRUST_LABEL]: 7 })).toBe("observe");
  });

  test("known levels pass through", () => {
    for (const level of ["observe", "propose", "ship", "autopilot"] as const) {
      expect(coordinatorTrustLevelFromLabels({ [COORDINATOR_TRUST_LABEL]: level })).toBe(level);
    }
  });
});

describe("coordinatorTrustAtLeast", () => {
  test("orders observe < propose < ship < autopilot", () => {
    expect(coordinatorTrustAtLeast("observe", "observe")).toBe(true);
    expect(coordinatorTrustAtLeast("observe", "propose")).toBe(false);
    expect(coordinatorTrustAtLeast("propose", "observe")).toBe(true);
    expect(coordinatorTrustAtLeast("propose", "ship")).toBe(false);
    expect(coordinatorTrustAtLeast("ship", "propose")).toBe(true);
    expect(coordinatorTrustAtLeast("autopilot", "ship")).toBe(true);
    expect(coordinatorTrustAtLeast("ship", "autopilot")).toBe(false);
  });
});

describe("assertCoordinatorToolAllowed", () => {
  test("observe coordinators may read and remember", () => {
    for (const tool of [
      "list_workspaces",
      "list_agents",
      "get_agent_status",
      "get_agent_activity",
      "list_pending_permissions",
      "list_terminals",
      "inspect_schedule",
      "remember",
    ]) {
      expect(() => assertCoordinatorToolAllowed(coordinator, tool)).not.toThrow();
    }
  });

  test("observe coordinators may list terminals but not capture output", () => {
    // Listing is live metadata; capture reads agent output — a covered session's
    // transcript content is not observational at Observe.
    expect(() => assertCoordinatorToolAllowed(coordinator, "list_terminals")).not.toThrow();
    expect(() => assertCoordinatorToolAllowed(coordinator, "capture_terminal")).toThrow(
      /not available/,
    );
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

  test("propose adds delegation plumbing but no writing or forge tools", () => {
    const caller = coordinatorAt("propose");
    for (const tool of ["create_agent", "send_agent_prompt", "cancel_agent"]) {
      expect(() => assertCoordinatorToolAllowed(caller, tool)).not.toThrow();
    }
    for (const tool of [
      "update_agent",
      "respond_to_permission",
      "create_workspace",
      "archive_workspace",
      "create_change_request",
      "comment_on_change_request",
      "retry_change_request_checks",
      "handoff_agent",
      "kill_agent",
      "archive_agent",
      "create_terminal",
      "create_schedule",
    ]) {
      expect(() => assertCoordinatorToolAllowed(caller, tool)).toThrow(/at Propose trust/);
    }
  });

  test("ship adds workspaces, permission answers, and the forge tools", () => {
    const caller = coordinatorAt("ship");
    for (const tool of [
      "create_agent",
      "send_agent_prompt",
      "cancel_agent",
      "update_agent",
      "respond_to_permission",
      "create_workspace",
      "create_change_request",
      "comment_on_change_request",
      "retry_change_request_checks",
    ]) {
      expect(() => assertCoordinatorToolAllowed(caller, tool)).not.toThrow();
    }
    // Schedules, terminals, archives, and kills stay outside every level.
    for (const tool of [
      "archive_workspace",
      "create_terminal",
      "send_terminal_keys",
      "create_schedule",
      "create_heartbeat",
      "handoff_agent",
      "kill_agent",
      "archive_agent",
      "set_agent_mode",
    ]) {
      expect(() => assertCoordinatorToolAllowed(caller, tool)).toThrow(/at Ship trust/);
    }
  });

  test("autopilot holds every ship capability", () => {
    const caller = coordinatorAt("autopilot");
    for (const tool of [
      "create_agent",
      "send_agent_prompt",
      "cancel_agent",
      "update_agent",
      "respond_to_permission",
      "create_workspace",
      "create_change_request",
      "comment_on_change_request",
      "retry_change_request_checks",
      "remember",
      "list_agents",
    ]) {
      expect(() => assertCoordinatorToolAllowed(caller, tool)).not.toThrow();
    }
    expect(() => assertCoordinatorToolAllowed(caller, "create_schedule")).toThrow(
      /at Autopilot trust/,
    );
  });

  test("non-coordinator callers pass through", () => {
    expect(() => assertCoordinatorToolAllowed({ labels: {} }, "create_agent")).not.toThrow();
    expect(() => assertCoordinatorToolAllowed(null, "create_agent")).not.toThrow();
    expect(() => assertCoordinatorToolAllowed(undefined, "create_agent")).not.toThrow();
    // Delegated subagents are not coordinators — the ownership boundary, not
    // the tool allowlist, scopes what they may touch.
    expect(() =>
      assertCoordinatorToolAllowed(
        { labels: { "paseo.coordinator.subagent-kind": "implementer" } },
        "create_agent",
      ),
    ).not.toThrow();
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
