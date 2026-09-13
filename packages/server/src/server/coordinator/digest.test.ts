import { expect, it } from "vitest";
import type { CoordinatorBoardSnapshot } from "@getpaseo/protocol/messages";
import type { ChangeRequestSnapshot } from "./change-request-poll.js";
import { formatCoordinatorDigest } from "./digest.js";

const now = Date.parse("2026-09-13T08:00:00Z");
function board(): CoordinatorBoardSnapshot {
  return {
    projectId: "project",
    projectName: "Paseo",
    tier: "project",
    needsYou: [],
    working: [],
    done: [],
    wake: null,
    coordinatorAgentId: "coordinator",
    enabled: true,
    trustLevel: "observe",
    scope: "everything",
  };
}
it("reports observed requests, stale activity, and reported merge outcomes without inferring closures", () => {
  const project = board();
  project.done = [
    {
      kind: "done",
      id: "merged",
      projectId: "project",
      at: "2026-09-13T07:00:00Z",
      text: "Merged #40: token refresh retry",
    },
  ];
  const snapshot: ChangeRequestSnapshot = {
    fetchedAt: "2026-09-12T06:00:00Z",
    forge: "github",
    truncated: true,
    entries: [
      {
        number: 41,
        title: "Fix auth",
        url: "https://example.test/41",
        state: "OPEN",
        headRef: "fix-auth",
        updatedAt: "2026-09-08T07:00:00Z",
        isDraft: false,
        mergeable: null,
        reviewDecision: null,
        checksStatus: "failure",
        checks: [],
      },
    ],
  };
  const text = formatCoordinatorDigest([project], new Map([["project", snapshot]]), now);
  expect(text).toContain("At least 1 open change request (listing capped)");
  expect(text).toContain("#41 Fix auth — checks failure, unchanged 5d");
  expect(text).toContain("Last observed 2026-09-12T06:00:00Z; cached data");
  expect(text).toContain("Reported in the last 24h: Merged #40: token refresh retry");
  expect(text).not.toContain("0 merged");
});

it("counts evidenced proposals and states unavailable watch data without inventing goal totals", () => {
  const project = board();
  project.needsYou = [
    {
      kind: "decision",
      id: "proposal",
      projectId: "project",
      agentId: "coordinator",
      requestId: "setup",
      setupProjectId: "new-project",
      question: "Set up new project?",
      askedAt: "2026-09-13T07:00:00Z",
      actions: [],
    },
  ];
  const text = formatCoordinatorDigest([project], new Map(), now);
  expect(text).toContain("1 item needs you (1 proposal)");
  expect(text).toContain("Change-request watch has no snapshot yet");
  expect(text).not.toContain("0 goals");
  expect(text).not.toContain("No completed outcomes");
});
