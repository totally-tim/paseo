import { describe, expect, it } from "vitest";
import { createNotificationAnswerHandler, resolveNotificationAnswer } from "./action-response";

const payload = {
  serverId: "paired-host",
  agentId: "original-agent",
  requestId: "original-request",
  categoryIdentifier: "paseo.coordinator.retry",
  actions: [
    {
      id: "investigate",
      label: "Investigate",
      response: {
        behavior: "allow",
        selectedActionId: "coordinator-investigate",
        updatedInput: { answers: { Next: "Investigate" } },
      },
    },
  ],
};
describe("notification answers", () => {
  it("answers the originating request once when the task and response listener race", async () => {
    const answers: unknown[] = [];
    const done = new Set<string>();
    const handle = createNotificationAnswerHandler({
      hasAnswered: async (key) => done.has(key),
      markAnswered: async (key) => {
        done.add(key);
      },
      answer: async (answer) => {
        answers.push(answer);
      },
    });
    expect(
      await Promise.all([handle("investigate", payload), handle("investigate", payload)]),
    ).toEqual([true, true]);
    expect(answers).toEqual([
      {
        operation: "answer",
        serverId: "paired-host",
        agentId: "original-agent",
        requestId: "original-request",
        response: payload.actions[0]!.response,
      },
    ]);
    const afterRestart = createNotificationAnswerHandler({
      hasAnswered: async (key) => done.has(key),
      markAnswered: async () => {},
      answer: async (answer) => {
        answers.push(answer);
      },
    });
    await afterRestart("investigate", payload);
    expect(answers).toHaveLength(1);
  });
  it("does not mark an offline answer as complete and retries delivery", async () => {
    let attempts = 0;
    let acknowledged = false;
    const handle = createNotificationAnswerHandler({
      hasAnswered: async () => acknowledged,
      markAnswered: async () => {
        acknowledged = true;
      },
      answer: async () => {
        if (++attempts === 1) throw new Error("offline");
      },
    });
    await expect(handle("investigate", payload)).rejects.toThrow("offline");
    expect(acknowledged).toBe(false);
    expect(await handle("investigate", payload)).toBe(true);
    expect(acknowledged).toBe(true);
  });
  it("routes foreground actions and unknown custom choices without answering", async () => {
    let answered = false;
    const handle = createNotificationAnswerHandler({
      hasAnswered: async () => false,
      markAnswered: async () => {},
      answer: async () => {
        answered = true;
      },
    });
    for (const id of ["open", "open_app", "always_allow", "unexpected"])
      expect(await handle(id, payload)).toBe(false);
    expect(
      await handle("investigate", {
        ...payload,
        actions: [{ ...payload.actions[0], label: "Delete everything" }],
      }),
    ).toBe(false);
    expect(
      resolveNotificationAnswer("investigate", { ...payload, requestId: undefined }),
    ).toBeNull();
    expect(answered).toBe(false);
  });
});

it("defers Leave it without answering and permits a later explicit answer", async () => {
  const operations: string[] = [];
  const done = new Set<string>();
  const handle = createNotificationAnswerHandler({
    hasAnswered: async (key) => done.has(key),
    markAnswered: async (key) => {
      done.add(key);
    },
    answer: async (action) => {
      operations.push(action.operation);
    },
  });
  const stalled = {
    ...payload,
    categoryIdentifier: "paseo.coordinator.permission",
    actions: [
      {
        id: "leave_it",
        label: "Leave it",
        response: { behavior: "allow", selectedActionId: "leave-it" },
      },
      {
        id: "allow",
        label: "Allow",
        response: { behavior: "allow", selectedActionId: "allow-once" },
      },
    ],
  };
  await handle("leave_it", stalled);
  await handle("leave_it", stalled);
  await handle("allow", stalled);
  expect(operations).toEqual(["defer", "answer"]);
});
