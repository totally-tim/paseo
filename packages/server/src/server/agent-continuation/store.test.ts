import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentContinuationStore, newContinuationRecord } from "./store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("retains acknowledged instructions and serialized updates after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-continuation-store-"));
  directories.push(directory);
  const id = randomUUID();
  const store = new AgentContinuationStore(directory);
  await store.initialize();
  await store.create(newContinuationRecord(id));
  await Promise.all(
    ["first", "second"].map((text) =>
      store.update(id, (record) => {
        record.queue.push({
          id: text,
          text,
          status: "queued",
          revision: 1,
          createdAt: "2026-09-05T00:00:00Z",
        });
      }),
    ),
  );
  const restarted = new AgentContinuationStore(directory);
  await restarted.initialize();
  expect(restarted.forAgent(id)?.queue.map((item) => item.text)).toEqual(["first", "second"]);
  expect((await stat(join(directory, "agent-continuations"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, "agent-continuations", `${id}.json`))).mode & 0o777).toBe(
    0o600,
  );
});

test("a rejected transaction does not publish its partial changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-continuation-store-"));
  directories.push(directory);
  const store = new AgentContinuationStore(directory);
  await store.initialize();
  const id = randomUUID();
  await store.create(newContinuationRecord(id));
  await expect(
    store.update(id, (record) => {
      record.agentIds.push(randomUUID());
      throw new Error("cancelled operation");
    }),
  ).rejects.toThrow("cancelled operation");
  expect(store.forAgent(id)?.agentIds).toEqual([id]);
});

test("an unreadable record is set aside so the other tasks still load", async () => {
  const { writeFile, readdir } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "paseo-continuation-store-"));
  directories.push(directory);
  const store = new AgentContinuationStore(directory);
  await store.initialize();
  const id = randomUUID();
  await store.create(newContinuationRecord(id));
  await writeFile(join(directory, "agent-continuations", `${randomUUID()}.json`), "null");
  const restarted = new AgentContinuationStore(directory);
  await restarted.initialize();
  expect(restarted.forAgent(id)?.rootAgentId).toBe(id);
  const entries = await readdir(join(directory, "agent-continuations"));
  expect(entries.filter((entry) => entry.includes(".corrupt-"))).toHaveLength(1);
});
