import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { CoordinatorStore, type PersistedProjectCoordinator } from "./persistence.js";

const logger = createTestLogger();
const roots: string[] = [];

function makeStore(): { store: CoordinatorStore; home: string } {
  const home = mkdtempSync(path.join(tmpdir(), "coordinator-store-"));
  roots.push(home);
  return { store: new CoordinatorStore(home, logger), home };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeState(projectId: string): PersistedProjectCoordinator {
  const now = new Date().toISOString();
  return {
    version: 1,
    projectId,
    agentId: null,
    enabled: true,
    trustLevel: "observe",
    scope: "everything",
    profile: { provider: "codex" },
    createdAt: now,
    updatedAt: now,
  };
}

describe("CoordinatorStore", () => {
  test("state round-trips through disk", async () => {
    const { store } = makeStore();
    const state = makeState("prj_a");
    await store.saveState("prj_a", state);
    expect(await store.loadState("prj_a")).toEqual(state);
  });

  test("trust, guard, profiles, expectation, and usage round-trip through disk", async () => {
    const { store } = makeStore();
    const state: PersistedProjectCoordinator = {
      ...makeState("prj_a"),
      trustLevel: "ship",
      profiles: {
        investigator: { provider: "claude", model: "opus" },
        fallback: { provider: "codex" },
      },
      usageExpectation: { monthlySpawns: 20, monthlyTokens: 500_000 },
      guard: { maxConcurrentSubagents: 4, maxSpawnDepth: 3 },
      usage: {
        month: "2026-02",
        tokens: 42_000,
        lastSeenTokensByAgent: { "agent-1": 12_345 },
        reportedExpectations: ["tokens"],
      },
    };
    await store.saveState("prj_a", state);
    expect(await store.loadState("prj_a")).toEqual(state);
  });

  test("older state files without the m2 fields still parse", async () => {
    const { store } = makeStore();
    // What a milestone-1 daemon wrote: trust/scope/profile but no guard,
    // profiles map, expectation, or usage bucket.
    mkdirSync(path.dirname(store.statePath("prj_old")), { recursive: true });
    writeFileSync(
      store.statePath("prj_old"),
      JSON.stringify({
        version: 1,
        projectId: "prj_old",
        agentId: "agent-1",
        enabled: true,
        trustLevel: "observe",
        scope: "project",
        profile: { provider: "codex" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const state = await store.loadState("prj_old");
    expect(state?.projectId).toBe("prj_old");
    expect(state?.trustLevel).toBe("observe");
    expect(state?.guard).toBeUndefined();
    expect(state?.usage).toBeUndefined();
  });

  test("board round-trips with done and wake rows", async () => {
    const { store } = makeStore();
    const board = {
      version: 1 as const,
      done: [
        {
          kind: "done" as const,
          id: "done:1",
          projectId: "prj_a",
          text: "Answered a question",
          at: new Date().toISOString(),
        },
      ],
      wake: {
        kind: "wake" as const,
        id: "wake:1",
        projectId: "prj_a",
        text: "Woke: coordinator enabled",
        level: "observe" as const,
        at: new Date().toISOString(),
      },
    };
    await store.saveBoard("prj_a", board);
    expect(await store.loadBoard("prj_a")).toEqual(board);
  });

  test("loadState returns null for missing and unreadable files", async () => {
    const { store } = makeStore();
    expect(await store.loadState("prj_missing")).toBeNull();

    // Corrupt JSON is discarded rather than throwing.
    mkdirSync(path.dirname(store.statePath("prj_bad")), { recursive: true });
    writeFileSync(store.statePath("prj_bad"), "{ not json");
    expect(await store.loadState("prj_bad")).toBeNull();
  });

  test("loadBoard returns an empty board for missing files", async () => {
    const { store } = makeStore();
    expect(await store.loadBoard("prj_missing")).toEqual({
      version: 1,
      done: [],
      wake: null,
    });
  });

  test("listProjectIds enumerates configured projects only", async () => {
    const { store, home } = makeStore();
    await store.saveState("prj_b", makeState("prj_b"));
    await store.saveState("prj_a", makeState("prj_a"));
    // A board without state does not create a project entry.
    await store.saveBoard("prj_board_only", {
      version: 1,
      done: [],
      wake: null,
    });
    expect(await store.listProjectIds()).toEqual(["prj_a", "prj_b"]);
    expect(home).toBeTruthy();
  });

  test("writes are serialized per file", async () => {
    const { store } = makeStore();
    await Promise.all([
      store.saveBoard("prj_a", {
        version: 1,
        done: [
          {
            kind: "done" as const,
            id: "done:1",
            projectId: "prj_a",
            text: "one",
            at: new Date().toISOString(),
          },
        ],
        wake: null,
      }),
      store.saveBoard("prj_a", {
        version: 1,
        done: [
          {
            kind: "done" as const,
            id: "done:2",
            projectId: "prj_a",
            text: "two",
            at: new Date().toISOString(),
          },
        ],
        wake: null,
      }),
    ]);
    // Whatever ordering won, the file must be one intact document.
    const raw = await readFile(store.boardPath("prj_a"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
