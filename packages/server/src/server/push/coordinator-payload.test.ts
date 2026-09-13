import type pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { boundCoordinatorPushPayload } from "./coordinator-payload.js";
import { PushService, type PushPayload } from "./push-service.js";

afterEach(() => vi.unstubAllGlobals());

const routing = {
  serverId: "server",
  workspaceId: "workspace",
  agentId: "agent",
  requestId: "request",
  categoryIdentifier: "paseo.coordinator.retry",
};

async function encodedExpoMessage(payload: PushPayload): Promise<Record<string, unknown>> {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: true,
    json: async () => ({ data: [{ status: "ok" }] }),
  }));
  vi.stubGlobal("fetch", fetch);
  const logger = { child: () => logger, error: vi.fn() } as unknown as pino.Logger;
  // The transport overhead also covers future channel fields within the reserved KiB.
  await new PushService(logger, vi.fn()).sendPush(
    [`ExponentPushToken[${"t".repeat(256)}]`],
    payload,
  );
  const message = JSON.parse(String(fetch.mock.calls[0]![1].body))[0];
  expect(
    Buffer.byteLength(
      JSON.stringify({ ...message, channelId: "coordinator", priority: "high" }),
      "utf8",
    ),
  ).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(3072);
  return message;
}

it("fits a large multibyte digest in the final Expo envelope and points to the board", async () => {
  const payload = boundCoordinatorPushPayload({
    title: "Daily digest",
    body: '项目已完成 🐑 "review"\n'.repeat(1000),
    data: { serverId: "server", agentId: "agent" },
  });
  const message = await encodedExpoMessage(payload);
  expect(message.body).toContain("More in Coordinator");
  expect(payload.body).not.toContain("\uFFFD");
});

it("keeps a fitting exact response unchanged while shortening the surrounding question", async () => {
  const actions = [
    {
      id: "retry",
      label: "Retry",
      response: { behavior: "allow", updatedInput: { command: 'echo "你好"' } },
    },
  ];
  const payload = boundCoordinatorPushPayload({
    title: "🐑".repeat(500),
    body: "Long question ".repeat(1000),
    data: { ...routing, actions },
  });
  const message = await encodedExpoMessage(payload);
  expect(payload.data?.actions).toEqual(actions);
  expect(message.categoryId).toBe("paseo.coordinator.retry");
  expect(message.body).toContain("More in Coordinator");
});

it("replaces oversized exact responses with Open app instead of truncating them", async () => {
  const actions = [
    {
      id: "retry",
      label: "Retry",
      response: { behavior: "allow", updatedInput: { command: "🐑".repeat(2000) } },
    },
  ];
  const original = { title: "Decision", body: "Retry CI?", data: { ...routing, actions } };
  const payload = boundCoordinatorPushPayload(original);
  const message = await encodedExpoMessage(payload);
  expect(payload.data?.actions).toBeUndefined();
  expect(payload.data?.requestId).toBe("request");
  expect(message.categoryId).toBe("paseo.coordinator.open");
  expect(message.body).toContain("More in Coordinator");
  expect(original.data.actions).toEqual(actions);
});

it("never truncates an oversized opaque routing identifier", async () => {
  const payload = boundCoordinatorPushPayload({
    title: "Decision",
    body: "Review",
    data: { ...routing, requestId: "x".repeat(10000) },
  });
  await encodedExpoMessage(payload);
  expect(payload.data).toBeUndefined();
  expect(payload.categoryId).toBe("paseo.coordinator.open");
});

it("preserves an already fitting payload", () => {
  const payload = { title: "Decision", body: "Review", data: routing };
  expect(boundCoordinatorPushPayload(payload)).toBe(payload);
});
