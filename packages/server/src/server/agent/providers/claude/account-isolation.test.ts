import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

it("lists and rehydrates the same native session ID only inside its account", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-account-history-"));
  const cwd = path.join(root, "workspace");
  const sessionId = randomUUID();
  const logger = createTestLogger();
  const sessions = [];
  try {
    await mkdir(cwd);
    for (const accountId of ["A", "B"]) {
      const configDir = path.join(root, accountId);
      const projectDir = claudeProjectDirSync(cwd, { configDir });
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          sessionId,
          cwd,
          message: { role: "user", content: `PRIVATE_TO_ACCOUNT_${accountId}` },
        }) + "\n",
      );
    }
    for (const accountId of ["A", "B"]) {
      // Construct a fresh client, as on daemon restart; the ambient CLI home is unused.
      const client = new ClaudeAgentClient({
        logger,
        runtimeSettings: {
          accountContext: { accountId, provider: "claude", configDir: path.join(root, accountId) },
        },
      });
      const listed = await client.listImportableSessions({ cwd });
      expect(listed).toHaveLength(1);
      expect(listed[0].providerHandleId).toBe(sessionId);
      expect(listed[0].firstPromptPreview).toContain(`PRIVATE_TO_ACCOUNT_${accountId}`);
      const session = await client.resumeSession({ provider: "claude", sessionId }, { cwd });
      sessions.push(session);
      const events = [];
      for await (const event of session.streamHistory()) events.push(event);
      expect(JSON.stringify(events)).toContain(`PRIVATE_TO_ACCOUNT_${accountId}`);
      expect(JSON.stringify(events)).not.toContain(
        `PRIVATE_TO_ACCOUNT_${accountId === "A" ? "B" : "A"}`,
      );
      await expect(
        client.resumeSession({ provider: "claude", sessionId: "../../B/private" }, { cwd }),
      ).rejects.toThrow("Invalid Claude session identifier");
    }
  } finally {
    for (const session of sessions) await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
