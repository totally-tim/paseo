import type pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { buildAgentAttentionNotificationPayload } from "@getpaseo/protocol/agent-attention-notification";
import { PushService } from "./push-service.js";

afterEach(() => vi.unstubAllGlobals());

test("Expo carries the registered category and exact responses in the decision payload", async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({
    ok: true,
    json: async () => ({ data: [{ status: "ok" }] }),
  }));
  vi.stubGlobal("fetch", fetch);
  const logger = { child: () => logger, error: vi.fn() } as unknown as pino.Logger;
  await new PushService(logger, vi.fn()).sendPush(
    ["ExponentPushToken[test]"],
    buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "server",
      workspaceId: "workspace",
      agentId: "agent",
      permissionRequest: {
        id: "request",
        provider: "codex",
        name: "Decision",
        kind: "question",
        title: "CI failed on #41",
        actions: [
          {
            id: "a",
            label: "Retry",
            behavior: "allow",
            response: { behavior: "allow", updatedInput: { choice: "retry" } },
          },
          { id: "b", label: "Investigate", behavior: "allow" },
          { id: "c", label: "Ignore", behavior: "deny" },
        ],
      },
    }),
  );
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchSnapshot();
});
