import { describe, expect, test } from "vitest";
import {
  COORDINATOR_PROJECT_ROLE,
  PARENT_AGENT_ID_LABEL,
  PASEO_ROLE_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { StoredAgentRecord } from "../agent/agent-storage.js";
import { isOrdinaryAgent } from "./safety.js";

function makeRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = new Date().toISOString();
  return {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/project",
    workspaceId: "workspace-1",
    createdAt: now,
    updatedAt: now,
    labels: {},
    lastStatus: "idle",
    ...overrides,
  };
}

describe("isOrdinaryAgent", () => {
  test("accepts a plain workspace agent", () => {
    expect(isOrdinaryAgent(makeRecord())).toBe(true);
  });

  test("rejects a project coordinator", () => {
    expect(
      isOrdinaryAgent(
        makeRecord({
          labels: {
            [PASEO_ROLE_LABEL]: COORDINATOR_PROJECT_ROLE,
            "paseo.coordinator.project-id": "project-1",
          },
        }),
      ),
    ).toBe(false);
  });

  test("rejects any role-labeled record, not just coordinators", () => {
    expect(
      isOrdinaryAgent(makeRecord({ labels: { [PASEO_ROLE_LABEL]: "some.future.role" } })),
    ).toBe(false);
  });

  test("still rejects delegated, archived, internal, and schedule agents", () => {
    expect(isOrdinaryAgent(makeRecord({ labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" } }))).toBe(
      false,
    );
    expect(isOrdinaryAgent(makeRecord({ archivedAt: new Date().toISOString() }))).toBe(false);
    expect(isOrdinaryAgent(makeRecord({ internal: true }))).toBe(false);
    expect(isOrdinaryAgent(makeRecord({ labels: { "paseo.schedule-id": "schedule-1" } }))).toBe(
      false,
    );
    expect(isOrdinaryAgent(makeRecord({ workspaceId: undefined }))).toBe(false);
  });
});
