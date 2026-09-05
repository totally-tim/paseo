import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as spawn from "../../../utils/spawn.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createAccountBackend } from "../../provider-accounts/provider-backends.js";
import { ProviderAccountSchema } from "@getpaseo/protocol/provider-accounts";

afterEach(() => vi.restoreAllMocks());

test("Codex login fails promptly if the provider exits while waiting for device approval", async () => {
  const app = createFakeCodexAppServer({
    "account/login/start": () => ({
      type: "chatgptDeviceCode",
      loginId: "test-login",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "TEST-CODE",
    }),
  });
  vi.spyOn(spawn, "spawnProcess").mockReturnValue(app.child);
  const backend = createAccountBackend({
    account: ProviderAccountSchema.parse({
      id: "test-account",
      provider: "codex",
      label: "Test",
      ownership: "managed",
      enabled: false,
      authState: "signed-out",
      identity: null,
      error: null,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } },
    logger: createTestLogger(),
  });
  const controller = new AbortController();
  await expect(
    backend.login({
      signal: controller.signal,
      onChallenge: () => app.disconnect(),
      onSubmitCode: () => undefined,
    }),
  ).rejects.toThrow("Codex login did not complete");
  expect(controller.signal.aborted).toBe(false);
});

test("Codex import and rehydration use the selected home even for identical native IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-account-history-"));
  const sessions = [];
  const launches: Array<{ args: readonly string[]; home: string | undefined }> = [];
  vi.spyOn(spawn, "spawnProcess").mockImplementation((_command, args, options) => {
    const home = options?.envOverlay?.CODEX_HOME;
    const marker = home === join(root, "A") ? "PRIVATE_A" : "PRIVATE_B";
    launches.push({ args: args ?? [], home });
    const app = createFakeCodexAppServer({
      "thread/list": () => ({ data: [{ id: "same-native-id", cwd: root, preview: marker }] }),
      "thread/read": () => ({
        thread: {
          id: "same-native-id",
          turns: [{ items: [{ type: "agentMessage", id: "same-item", text: marker }] }],
        },
      }),
    });
    return app.child;
  });
  try {
    for (const accountId of ["A", "B"]) {
      await mkdir(join(root, accountId));
      const client = new CodexAppServerAgentClient(createTestLogger(), {
        command: { mode: "replace", argv: [process.execPath] },
        accountContext: { provider: "codex", accountId, configDir: join(root, accountId) },
      });
      // Feature-version probes are independent of the account boundary under test.
      Reflect.set(client, "goalsEnabledPromise", Promise.resolve(false));
      Reflect.set(client, "autoReviewEnabledPromise", Promise.resolve(false));
      const listed = await client.listImportableSessions({ cwd: root });
      expect(listed).toHaveLength(1);
      expect(listed[0].providerHandleId).toBe("same-native-id");
      expect(listed[0].firstPromptPreview).toBe(`PRIVATE_${accountId}`);
      const session = await client.resumeSession(
        { sessionId: "same-native-id" },
        { cwd: root },
        undefined,
        { purpose: "history" },
      );
      sessions.push(session);
      const history = [];
      for await (const event of session.streamHistory()) history.push(event);
      expect(JSON.stringify(history)).toContain(`PRIVATE_${accountId}`);
      expect(JSON.stringify(history)).not.toContain(`PRIVATE_${accountId === "A" ? "B" : "A"}`);
    }
    expect(launches.map((launch) => launch.home)).toEqual([
      join(root, "A"),
      join(root, "A"),
      join(root, "B"),
      join(root, "B"),
    ]);
    for (const launch of launches)
      expect(launch.args).toContain('cli_auth_credentials_store="file"');
  } finally {
    for (const session of sessions) await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex native usage rejection produces a recovery notification through the transport", async () => {
  const app = createFakeCodexAppServer();
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: process.cwd(), modeId: "auto" },
    null,
    createTestLogger(),
    async () => app.child,
  );
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  try {
    await session.startTurn("Continue the task");
    const request = await app.waitForTurnStart();
    app.child.stdout.write(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: request.threadId,
          turn: {
            status: "failed",
            error: { message: "Usage exceeded", codexErrorInfo: "usageLimitExceeded" },
          },
        },
      }) + "\n",
    );
    await expect.poll(() => events.some((event) => event.type === "turn_failed")).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({
          code: "provider_capacity",
          message: expect.stringContaining("Continue with"),
        }),
      }),
    );
    app.assertNoErrors();
  } finally {
    unsubscribe();
    await session.close();
  }
});
