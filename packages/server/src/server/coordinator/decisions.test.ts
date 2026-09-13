import { describe, expect, it } from "vitest";
import { nextDeliveryAt } from "./decisions.js";

describe("decision delivery", () => {
  it("starts an overnight decision clock at the next local quiet-hours end", () => {
    const raised = new Date(2026, 8, 12, 23, 10);
    expect(nextDeliveryAt(raised.getTime(), { quietStartHour: 22, quietEndHour: 7 })).toBe(
      new Date(2026, 8, 13, 7).getTime(),
    );
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoordinatorDecisions, DEFAULT_DECISION_SETTINGS, type DecisionDeps } from "./decisions.js";

it("restores a durable quiet-hours decision and applies its explicit default once", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-decisions-"));
  let now = new Date(2026, 8, 12, 23).getTime();
  const requests = new Map<string, Parameters<DecisionDeps["register"]>[0]>();
  const answers: string[] = [];
  const pushes: string[] = [];
  const deps: DecisionDeps = {
    paseoHome: home,
    now: () => now,
    settings: async () => ({ ...DEFAULT_DECISION_SETTINGS, digestEnabled: false }),
    eligible: async () => ({ projectId: "project", provider: "codex" }),
    register: (input) => {
      requests.set(input.request.id, input);
      return () => {
        requests.delete(input.request.id);
      };
    },
    respond: async (_agentId, requestId, response) => {
      await requests.get(requestId)!.respond(response);
      requests.delete(requestId);
    },
    deliverAnswer: async (_record, text) => {
      answers.push(text);
      return true;
    },
    sendDecision: async (input) => {
      pushes.push(input.request.id);
    },
    digest: async () => null,
  };
  try {
    const first = new CoordinatorDecisions(deps);
    const { requestId } = await first.raise({
      callerAgentId: "coordinator",
      question: "Retry CI?",
      actions: [{ id: "retry", label: "Retry", response: { behavior: "allow" } }],
      defaultActionId: "retry",
    });
    expect(requests.size).toBe(0);
    expect(pushes).toEqual([]);
    await first.stop();
    const second = new CoordinatorDecisions(deps);
    now = new Date(2026, 8, 13, 7).getTime();
    await second.tick();
    expect(requests.get(requestId)?.request).toMatchObject({
      requestedAt: new Date(now).toISOString(),
      timeoutAt: new Date(now + 120 * 60_000).toISOString(),
    });
    expect(pushes).toEqual([requestId]);
    now += 120 * 60_000;
    await second.tick();
    expect(answers).toEqual(["Answered Retry CI?: Retry (default after 2h)"]);
    await second.stop();
    const third = new CoordinatorDecisions(deps);
    await third.tick();
    expect(answers).toEqual(["Answered Retry CI?: Retry (default after 2h)"]);
    expect(requests.size).toBe(0);
    expect(pushes).toEqual([requestId]);
    await third.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("never chooses a default implicitly and persists daily digest delivery across restart", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-digest-"));
  let now = new Date(2026, 8, 12, 8).getTime();
  const requests = new Map<string, Parameters<DecisionDeps["register"]>[0]>();
  const digests: string[] = [];
  const deps: DecisionDeps = {
    paseoHome: home,
    now: () => now,
    settings: async () => DEFAULT_DECISION_SETTINGS,
    eligible: async () => ({ projectId: "project", provider: "codex" }),
    register: (input) => {
      requests.set(input.request.id, input);
      return () => {
        requests.delete(input.request.id);
      };
    },
    respond: async () => {
      throw new Error("No implicit default allowed");
    },
    deliverAnswer: async () => {
      throw new Error("No answer expected");
    },
    digest: async () => ({ agentId: "global", title: "Digest", body: "One pending decision" }),
    sendDigest: async (input) => {
      digests.push(input.body);
    },
  };
  try {
    const first = new CoordinatorDecisions(deps);
    const { requestId } = await first.raise({
      callerAgentId: "coordinator",
      question: "Allow?",
      actions: [{ id: "allow", label: "Allow", response: { behavior: "allow" } }],
    });
    expect(requests.get(requestId)?.request).not.toHaveProperty("timeoutAt");
    await first.tick();
    now += 4 * 60 * 60_000;
    await first.tick();
    await first.stop();
    const second = new CoordinatorDecisions(deps);
    await second.tick();
    expect(digests).toEqual(["One pending decision"]);
    expect(requests.size).toBe(1);
    now += 24 * 60 * 60_000;
    await second.tick();
    expect(digests).toEqual(["One pending decision", "One pending decision"]);
    await second.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("defers quiet-hours stalled pushes and persists Leave it without answering the provider", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-stalled-"));
  let now = new Date(2026, 8, 12, 23).getTime();
  const pushes: string[] = [];
  const deps: DecisionDeps = {
    paseoHome: home,
    now: () => now,
    settings: async () => DEFAULT_DECISION_SETTINGS,
    eligible: async () => null,
    register: () => {
      throw new Error("Stalled permission already belongs to its provider");
    },
    respond: async () => {
      throw new Error("Leave it never answers a provider permission");
    },
    deliverAnswer: async () => {
      throw new Error("No coordinator decision answered");
    },
    digest: async () => null,
    sendDecision: async (input) => {
      pushes.push(input.request.id);
    },
  };
  const notification: Parameters<CoordinatorDecisions["notifyStalledPermission"]>[1] = {
    agentId: "worker",
    title: "Waiting",
    body: "npm test",
    request: { id: "permission", provider: "codex", kind: "tool", name: "Bash" },
  };
  try {
    const first = new CoordinatorDecisions(deps);
    await first.notifyStalledPermission("worker:permission", notification);
    expect(pushes).toEqual([]);
    await first.silencePermission("worker:leave-it");
    await first.stop();
    now = new Date(2026, 8, 13, 7).getTime();
    const second = new CoordinatorDecisions(deps);
    await second.notifyStalledPermission("worker:leave-it", {
      ...notification,
      request: { ...notification.request, id: "leave-it" },
    });
    await second.notifyStalledPermission("worker:permission", notification);
    expect(pushes).toEqual(["permission"]);
    await second.stop();
    const third = new CoordinatorDecisions(deps);
    await third.notifyStalledPermission("worker:permission", notification);
    expect(pushes).toEqual(["permission"]);
    await third.stop();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
