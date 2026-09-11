import { describe, expect, it, vi } from "vitest";
import { type InboxCard, snoozeStamp } from "./lanes";
import { createInboxStore, READ_ALL_KEY, replyKey, responseKey } from "./store";
import type { Agent, PaseoApi } from "./types";

function fakePaseo(agents: Agent[]) {
  const agentListeners = new Set<(update: unknown) => void>();
  const paseo = {
    agents: {
      subscribe(handler: (update: unknown) => void) {
        agentListeners.add(handler);
        return () => agentListeners.delete(handler);
      },
      list: async () => ({
        entries: agents.map((agent) => ({ agent, project: null })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
    workspaces: {
      subscribe: () => () => {},
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    },
  } as unknown as PaseoApi;
  return {
    paseo,
    emit: (update: unknown) => agentListeners.forEach((listener) => listener(update)),
  };
}

const waiting = {
  id: "a",
  provider: "claude",
  cwd: "/repo",
  workspaceId: "ws",
  status: "running",
  updatedAt: "2026-09-04T10:00:00.000Z",
  lastUserMessageAt: null,
  // requestedAt pins the snooze stamp to the request's own clock, not the
  // agent's activity, so later unrelated activity doesn't look like a new wait.
  pendingPermissions: [
    {
      id: "p",
      kind: "question",
      name: "AskUserQuestion",
      input: {},
      requestedAt: "2026-09-04T09:30:00.000Z",
    },
  ],
  labels: {},
  archivedAt: null,
} as unknown as Agent;

describe("createInboxStore", () => {
  it("loads the directory, exposes lanes, and reports the badge count", async () => {
    const { paseo } = fakePaseo([waiting]);
    const store = createInboxStore(paseo);
    expect(store.getBadge()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot().loaded).toBe(true);
    expect(store.getSnapshot().lanes.needsYou.map((card) => card.agent.id)).toEqual(["a"]);
    expect(store.getBadge()).toBe(1);
    store.dispose();
  });

  it("clears the badge when the agent is removed and carries a pending open request once", async () => {
    const { paseo, emit } = fakePaseo([waiting]);
    const store = createInboxStore(paseo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.requestOpen("a");
    expect(store.getSnapshot().pendingOpenAgentId).toBe("a");
    store.clearPendingOpen();
    expect(store.getSnapshot().pendingOpenAgentId).toBeNull();
    emit({ kind: "remove", agentId: "a" });
    expect(store.getBadge()).toBeNull();
    expect(notified).toBe(3);
    store.dispose();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A ref factory whose `clearAttention` records the call and waits on a per-agent deferred. */
function refRecordingStarts(
  started: string[],
  pending: Record<"one" | "two", ReturnType<typeof deferred<void>>>,
) {
  return (id: string) => ({
    clearAttention: () => {
      started.push(id);
      return pending[id as "one" | "two"].promise;
    },
  });
}

describe("inbox recovery and review", () => {
  it("keeps each agent's draft after a failed send and clears only the sent text", async () => {
    const { paseo } = fakePaseo([waiting]);
    const first = deferred<void>();
    const second = deferred<void>();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const ref = vi.fn((_id: string) => ({ send }));
    paseo.agents.ref = ref as unknown as PaseoApi["agents"]["ref"];
    const store = createInboxStore(paseo);
    store.setDraft("a", "draft A");
    store.setDraft("b", "draft B");
    const failed = store.sendReply("a");
    expect(await store.sendReply("a")).toBe(false);
    first.reject(new Error("Offline"));
    expect(await failed).toBe(false);
    expect(store.getSnapshot().drafts.get("a")).toBe("draft A");
    expect(store.getSnapshot().operations.get(replyKey("a"))).toEqual({
      status: "failed",
      error: "Offline",
    });
    const success = store.sendReply("a");
    store.setDraft("a", "newer draft");
    second.resolve();
    expect(await success).toBe(true);
    expect(store.getSnapshot().drafts.get("a")).toBe("newer draft");
    expect(store.getSnapshot().drafts.get("b")).toBe("draft B");
    expect(ref.mock.calls.map((call) => call[0])).toEqual(["a", "a"]);
    store.dispose();
  });

  it("sends a pending answer once across views and advances only after acknowledgment", async () => {
    const child = {
      ...waiting,
      id: "child",
      labels: { "paseo.parent-agent-id": "a" },
      pendingPermissions: [{ ...waiting.pendingPermissions[0], id: "child-q" }],
    };
    const { paseo } = fakePaseo([waiting, child]);
    const response = deferred<void>();
    const respondToPermission = vi.fn(() => response.promise);
    paseo.agents.ref = vi.fn(() => ({
      respondToPermission,
    })) as unknown as PaseoApi["agents"]["ref"];
    const store = createInboxStore(paseo);
    await tick();
    const pending = store.respond("a", "p", { behavior: "allow" });
    expect(await store.respond("a", "p", { behavior: "allow" })).toBe(false);
    expect(store.getSnapshot().lanes.needsYou[0].subject.id).toBe("a");
    response.resolve();
    expect(await pending).toBe(true);
    expect(store.getSnapshot().lanes.needsYou[0].subject.id).toBe("child");
    expect(await store.respond("a", "p", { behavior: "allow" })).toBe(false);
    expect(respondToPermission).toHaveBeenCalledTimes(1);
    // The SDK handle takes one options object, not positional arguments.
    expect(respondToPermission).toHaveBeenCalledWith({
      requestId: "p",
      response: { behavior: "allow" },
    });
    store.dispose();
  });

  it("retains a failed answer in the queue and permits retry", async () => {
    const { paseo } = fakePaseo([waiting]);
    const respondToPermission = vi
      .fn()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce(undefined);
    paseo.agents.ref = vi.fn(() => ({
      respondToPermission,
    })) as unknown as PaseoApi["agents"]["ref"];
    const store = createInboxStore(paseo);
    await tick();
    expect(await store.respond("a", "p", { behavior: "allow" })).toBe(false);
    expect(store.getBadge()).toBe(1);
    expect(store.getSnapshot().operations.get(responseKey("a", "p"))?.error).toBe("Disconnected");
    expect(await store.respond("a", "p", { behavior: "allow" })).toBe(true);
    expect(store.getBadge()).toBeNull();
    store.dispose();
  });

  it("shows load failures and retries without resurrecting deleted or stale agents", async () => {
    const { paseo, emit } = fakePaseo([waiting]);
    const page = deferred<Awaited<ReturnType<PaseoApi["agents"]["list"]>>>();
    const entries = [waiting, { ...waiting, id: "deleted" }].map((agent) => ({
      agent,
      project: null,
    }));
    paseo.agents.list = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockReturnValueOnce(page.promise);
    const store = createInboxStore(paseo);
    await tick();
    expect(store.getSnapshot().loaded).toBe(false);
    expect(store.getSnapshot().loadError).toBe("Offline");
    const retry = store.retryLoad();
    emit({ kind: "upsert", agent: { ...waiting, title: "New title" } });
    emit({ kind: "remove", agentId: "deleted" });
    page.resolve({
      requestId: "test",
      entries,
      pageInfo: { hasMore: false, nextCursor: null },
    } as unknown as Awaited<ReturnType<PaseoApi["agents"]["list"]>>);
    await retry;
    expect(store.getSnapshot().loadError).toBeNull();
    expect(store.getSnapshot().loaded).toBe(true);
    expect(store.getSnapshot().agents.get("a")?.title).toBe("New title");
    expect(store.getSnapshot().agents.has("deleted")).toBe(false);
    store.dispose();
  });

  it("loads every workspace page so later projects can be filtered", async () => {
    const { paseo } = fakePaseo([]);
    paseo.workspaces.list = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [{ id: "one" }],
        pageInfo: { hasMore: true, nextCursor: "next" },
      })
      .mockResolvedValueOnce({
        entries: [{ id: "two" }],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    const store = createInboxStore(paseo);
    await tick();
    expect([...store.getSnapshot().workspaces.keys()]).toEqual(["one", "two"]);
    expect(paseo.workspaces.list).toHaveBeenLastCalledWith({
      page: { limit: 200, cursor: "next" },
    });
    store.dispose();
  });

  it("restores filters, serializes writes, and reports a failed save until retry", async () => {
    const { paseo } = fakePaseo([]);
    const saved = { projectId: "p", projectGroup: "group", groupByProject: true };
    const storage = {
      // Keyed, not blanket: an unkeyed mock would hand this filters-shaped value
      // to the snoozed/drafts loads too, which would read it as corrupt and burn
      // the one-shot setItem rejection below on their own self-heal save.
      getItem: vi.fn(async (key: string) => (key === "filters" ? JSON.stringify(saved) : null)),
      setItem: vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(undefined),
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().filters).toEqual(saved);
    store.setFilters({ projectId: "new", projectGroup: null, groupByProject: false });
    await tick();
    expect(store.getSnapshot().filtersError).toBe("Disk full");
    store.retryFilters();
    await tick();
    expect(store.getSnapshot().filtersError).toBeNull();
    expect(storage.setItem).toHaveBeenLastCalledWith(
      "filters",
      JSON.stringify({ projectId: "new", projectGroup: null, groupByProject: false }),
    );
    store.dispose();
  });

  it("does not apply a late preference read over a choice made in this session", async () => {
    const { paseo } = fakePaseo([]);
    const read = deferred<string | null>();
    const storage = {
      getItem: () => read.promise,
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    store.setFilters({ projectId: "chosen", projectGroup: null, groupByProject: false });
    read.resolve(JSON.stringify({ projectId: "old", projectGroup: null }));
    await tick();
    expect(store.getSnapshot().filters.projectId).toBe("chosen");
    store.dispose();
  });

  it("snoozes a waiting card out of the badge and review queue until it changes", async () => {
    const { paseo } = fakePaseo([waiting]);
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    expect(store.getSnapshot().snoozed.get("a")).toBe(snoozeStamp(card));
    expect(store.getBadge()).toBeNull();
    await tick();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({ a: snoozeStamp(card) });
    store.unsnooze("a");
    expect(store.getBadge()).toBe(1);
    store.dispose();
  });

  it("keeps a snoozed card hidden when the same request resurfaces unchanged", async () => {
    const { paseo, emit } = fakePaseo([waiting]);
    const store = createInboxStore(paseo);
    await tick();
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    expect(store.getBadge()).toBeNull();
    // Same request id, later agent activity — still the same wait, still snoozed.
    emit({ kind: "upsert", agent: { ...waiting, updatedAt: "2026-09-04T12:00:00.000Z" } });
    expect(store.getBadge()).toBeNull();
    store.dispose();
  });

  it("resurfaces a snoozed card when a withdrawn request is replaced, even with the same since", async () => {
    const { paseo, emit } = fakePaseo([waiting]);
    const store = createInboxStore(paseo);
    await tick();
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    expect(store.getBadge()).toBeNull();
    // Same `since` (updatedAt is unchanged), but a new request replaced the old one.
    emit({
      kind: "upsert",
      agent: {
        ...waiting,
        pendingPermissions: [{ ...waiting.pendingPermissions[0], id: "replacement" }],
      },
    });
    expect(store.getBadge()).toBe(1);
    store.dispose();
  });

  it("ignores a snooze for a card canSnooze rejects, instead of saving a stamp that can't stick", async () => {
    const unstamped = {
      ...waiting,
      pendingPermissions: [{ ...waiting.pendingPermissions[0], requestedAt: undefined }],
    } as unknown as Agent;
    const { paseo } = fakePaseo([unstamped]);
    const setItem = vi.fn().mockResolvedValue(undefined);
    const store = createInboxStore(paseo, {
      getItem: async () => null,
      setItem,
      removeItem: vi.fn(),
    });
    await tick();
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    await tick();
    expect(store.getSnapshot().snoozed.has("a")).toBe(false);
    expect(store.getBadge()).toBe(1);
    expect(setItem).not.toHaveBeenCalledWith("snoozed", expect.anything());
    store.dispose();
  });

  it("marks every unread result read and archives an agent through the handles", async () => {
    const done = {
      ...waiting,
      id: "done",
      status: "idle",
      pendingPermissions: [],
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: "2026-09-04T10:00:00.000Z",
    } as unknown as Agent;
    const { paseo } = fakePaseo([done]);
    const clearAttention = vi.fn().mockResolvedValue(undefined);
    const archive = vi.fn().mockResolvedValue(undefined);
    paseo.agents.ref = vi.fn(() => ({
      clearAttention,
      archive,
    })) as unknown as PaseoApi["agents"]["ref"];
    const store = createInboxStore(paseo);
    await tick();
    expect(store.getSnapshot().lanes.done.map((card) => card.agent.id)).toEqual(["done"]);
    expect(await store.markAllRead(["done"])).toBe(true);
    expect(clearAttention).toHaveBeenCalledTimes(1);
    expect(await store.archive("done")).toBe(true);
    expect(archive).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("reports mark-all-read as failed when a card's clear fails", async () => {
    const done = (id: string) =>
      ({
        ...waiting,
        id,
        status: "idle",
        pendingPermissions: [],
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: "2026-09-04T10:00:00.000Z",
      }) as unknown as Agent;
    const { paseo } = fakePaseo([done("one"), done("two")]);
    paseo.agents.ref = vi.fn((id: string) => ({
      clearAttention:
        id === "two"
          ? vi.fn().mockRejectedValue(new Error("Offline"))
          : vi.fn().mockResolvedValue(undefined),
    })) as unknown as PaseoApi["agents"]["ref"];
    const store = createInboxStore(paseo);
    await tick();
    expect(await store.markAllRead(["one", "two"])).toBe(false);
    expect(store.getSnapshot().operations.get(READ_ALL_KEY)?.error).toContain(
      "1 of 2 results could not be marked read",
    );
    store.dispose();
  });

  it("starts every eligible mark-all-read call before any of them resolves, when they fit within the pool", async () => {
    const done = (id: string) =>
      ({
        ...waiting,
        id,
        status: "idle",
        pendingPermissions: [],
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: "2026-09-04T10:00:00.000Z",
      }) as unknown as Agent;
    const { paseo } = fakePaseo([done("one"), done("two")]);
    const pendingByAgent = { one: deferred<void>(), two: deferred<void>() };
    const started: string[] = [];
    paseo.agents.ref = vi.fn(
      refRecordingStarts(started, pendingByAgent),
    ) as unknown as PaseoApi["agents"]["ref"];
    const store = createInboxStore(paseo);
    await tick();
    const result = store.markAllRead(["one", "two"]);
    await tick();
    // Both reads are in flight, neither has resolved yet: they ran concurrently.
    expect(started.sort()).toEqual(["one", "two"]);
    pendingByAgent.one.resolve();
    pendingByAgent.two.resolve();
    expect(await result).toBe(true);
    store.dispose();
  });

  it("caps mark-all-read concurrency at a pool of 4, starting the rest only as slots free up", async () => {
    const ids = ["one", "two", "three", "four", "five", "six"];
    const done = (id: string) =>
      ({
        ...waiting,
        id,
        status: "idle",
        pendingPermissions: [],
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: "2026-09-04T10:00:00.000Z",
      }) as unknown as Agent;
    const { paseo } = fakePaseo(ids.map(done));
    const pendingByAgent = new Map(ids.map((id) => [id, deferred<void>()]));
    const started: string[] = [];
    paseo.agents.ref = vi.fn((id: string) => ({
      clearAttention: () => {
        started.push(id);
        return pendingByAgent.get(id)!.promise;
      },
    })) as unknown as PaseoApi["agents"]["ref"];
    const store = createInboxStore(paseo);
    await tick();
    const result = store.markAllRead(ids);
    await tick();
    // Only 4 of the 6 eligible calls fit in the pool; the rest wait for a slot.
    expect(started.sort()).toEqual(["four", "one", "three", "two"]);
    pendingByAgent.get("one")!.resolve();
    await tick();
    // Resolving one call frees a slot for the next queued agent.
    expect(started.sort()).toEqual(["five", "four", "one", "three", "two"]);
    for (const id of ["two", "three", "four", "five"]) pendingByAgent.get(id)!.resolve();
    await tick();
    expect(started.sort()).toEqual(["five", "four", "one", "six", "three", "two"]);
    for (const id of ids) pendingByAgent.get(id)!.resolve();
    expect(await result).toBe(true);
    store.dispose();
  });

  it("surfaces a failed snooze save and retries it", async () => {
    const { paseo } = fakePaseo([waiting]);
    const values = new Map<string, string>();
    let failWrites = true;
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        if (failWrites && key === "snoozed") throw new Error("Disk full");
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    store.snooze(store.getSnapshot().lanes.needsYou[0]);
    await tick();
    expect(store.getSnapshot().snoozedError).toBe("Disk full");
    failWrites = false;
    store.retrySnoozed();
    await tick();
    expect(store.getSnapshot().snoozedError).toBeNull();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({
      a: store.getSnapshot().snoozed.get("a"),
    });
    store.dispose();
  });

  it("does not let a snooze made after a failed load overwrite storage", async () => {
    const { paseo } = fakePaseo([waiting]);
    const setItem = vi.fn().mockResolvedValue(undefined);
    const storage = {
      getItem: vi.fn(async (key: string) => {
        if (key === "snoozed") throw new Error("Offline");
        return null;
      }),
      setItem,
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBe("Offline");
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    expect(store.getSnapshot().snoozed.get("a")).toBe(snoozeStamp(card));
    expect(store.getSnapshot().snoozedError).toBe(
      "Snoozed cards were not loaded, so this snooze is not saved yet. Retry loading.",
    );
    expect(setItem).not.toHaveBeenCalled();
    store.dispose();
  });

  it("merges storage with in-memory snoozes and saves once when the load retry succeeds", async () => {
    const other = {
      ...waiting,
      id: "b",
      pendingPermissions: [{ ...waiting.pendingPermissions[0], id: "q2" }],
    };
    // The stamp storage already holds for "b" must match what its live card
    // computes today, or the prune step reads it as stale and drops it.
    const bStamp = snoozeStamp({
      request: other.pendingPermissions[0],
      subject: other,
      since: other.pendingPermissions[0].requestedAt,
    } as unknown as InboxCard);
    const { paseo } = fakePaseo([waiting, other]);
    const values = new Map<string, string>([["snoozed", JSON.stringify({ b: bStamp })]]);
    let failLoad = true;
    const setItem = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const storage = {
      getItem: vi.fn(async (key: string) => {
        if (key === "snoozed" && failLoad) throw new Error("Offline");
        return values.get(key) ?? null;
      }),
      setItem,
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBe("Offline");
    const cardA = store.getSnapshot().lanes.needsYou.find((c) => c.agent.id === "a");
    if (!cardA) throw new Error("expected a needs-you card for agent a");
    store.snooze(cardA);
    // The blocked save's own automatic reload attempt runs and fails here too
    // (storage is still down) before the manual retry below gets a turn.
    await tick();
    setItem.mockClear();
    failLoad = false;
    store.retrySnoozed();
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBeNull();
    expect(store.getSnapshot().snoozed.get("a")).toBe(snoozeStamp(cardA));
    expect(store.getSnapshot().snoozed.get("b")).toBe(bStamp);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({
      a: snoozeStamp(cardA),
      b: bStamp,
    });
    store.dispose();
  });

  it("does not let a load retry resurrect an unsnooze made while the load was broken", async () => {
    const { paseo } = fakePaseo([waiting]);
    const values = new Map<string, string>([["snoozed", JSON.stringify({ a: "stale" })]]);
    let failLoad = true;
    const setItem = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const storage = {
      getItem: vi.fn(async (key: string) => {
        if (key === "snoozed" && failLoad) throw new Error("Offline");
        return values.get(key) ?? null;
      }),
      setItem,
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBe("Offline");
    // The save this triggers is blocked by the load error, same as the prior snooze case.
    store.snooze(store.getSnapshot().lanes.needsYou[0]);
    store.unsnooze("a");
    expect(store.getSnapshot().snoozed.has("a")).toBe(false);
    // The blocked save's own automatic reload attempt runs and fails here too
    // (storage is still down) before the manual retry below gets a turn.
    await tick();
    setItem.mockClear();
    failLoad = false;
    store.retrySnoozed();
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBeNull();
    // The stored {a: "stale"} entry predates the unsnooze; it must not come back.
    expect(store.getSnapshot().snoozed.has("a")).toBe(false);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({});
    store.dispose();
  });

  it("saves a snooze made before agents finish loading without pruning it", async () => {
    const listGate = deferred<{
      entries: { agent: Agent; project: null }[];
      pageInfo: { hasMore: boolean; nextCursor: null };
    }>();
    const paseo = {
      agents: {
        subscribe: () => () => {},
        list: () => listGate.promise,
      },
      workspaces: {
        subscribe: () => () => {},
        list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      },
    } as unknown as PaseoApi;
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().loaded).toBe(false);
    // No agent has loaded, so lanes.needsYou is empty: a naive prune would drop this
    // entry as unmatched even though it belongs to an agent that hasn't arrived yet.
    const preloadCard = {
      agent: { id: "a" },
      reason: "question",
      request: { id: "p", requestedAt: "2026-09-04T10:00:00.000Z" },
      since: "2026-09-04T10:00:00.000Z",
    } as unknown as InboxCard;
    store.snooze(preloadCard);
    await tick();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({ a: snoozeStamp(preloadCard) });
    listGate.resolve({
      entries: [{ agent: waiting, project: null }],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    store.dispose();
  });

  it("self-heals a corrupt stored snooze value instead of blocking every future save", async () => {
    const { paseo } = fakePaseo([waiting]);
    const values = new Map<string, string>();
    const setItem = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const storage = {
      getItem: vi.fn(async (key: string) => (key === "snoozed" ? "not json" : null)),
      setItem,
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    const snapshot = store.getSnapshot();
    expect(snapshot.snoozedReady).toBe(true);
    // A parse failure is not an I/O failure: it must not block saves the way a
    // rejected getItem does.
    expect(snapshot.snoozedLoadError).toBeNull();
    // Treating storage as empty forces a save that overwrites the corrupt value.
    expect(JSON.parse(values.get("snoozed") ?? "null")).toEqual({});
    setItem.mockClear();
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    await tick();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({ a: snoozeStamp(card) });
    store.dispose();
  });

  it("reloads once automatically after a save is blocked by a failed load, then saves the merge", async () => {
    const { paseo } = fakePaseo([waiting]);
    const values = new Map<string, string>();
    let failLoad = true;
    const getItem = vi.fn(async (key: string) => {
      if (key === "snoozed" && failLoad) {
        failLoad = false;
        throw new Error("Offline");
      }
      return values.get(key) ?? null;
    });
    const setItem = vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    });
    const storage = { getItem, setItem, removeItem: vi.fn() };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBe("Offline");
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    await tick();
    // One reload beyond the initial failed one: the blocked save triggered it once.
    // (drafts/filters loads share this mock and also call getItem, so filter to "snoozed".)
    expect(getItem.mock.calls.filter(([key]) => key === "snoozed")).toHaveLength(2);
    expect(store.getSnapshot().snoozedLoadError).toBeNull();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({ a: snoozeStamp(card) });
    store.dispose();
  });

  it("resurfaces a snoozed card when the same request id gets a new requestedAt", async () => {
    const { paseo, emit } = fakePaseo([waiting]);
    const store = createInboxStore(paseo);
    await tick();
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    expect(store.getBadge()).toBeNull();
    // Same request id, but the provider is not guaranteed to keep ids unique
    // across turns — a later requestedAt means a different wait.
    emit({
      kind: "upsert",
      agent: {
        ...waiting,
        pendingPermissions: [
          { ...waiting.pendingPermissions[0], requestedAt: "2026-09-04T11:00:00.000Z" },
        ],
      },
    });
    expect(store.getBadge()).toBe(1);
    store.dispose();
  });

  it("drops a snoozed entry once its agent is gone", async () => {
    const other = {
      ...waiting,
      id: "b",
      pendingPermissions: [{ ...waiting.pendingPermissions[0], id: "q2" }],
    };
    const { paseo, emit } = fakePaseo([waiting, other]);
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    const cardA = store.getSnapshot().lanes.needsYou.find((c) => c.agent.id === "a");
    const cardB = store.getSnapshot().lanes.needsYou.find((c) => c.agent.id === "b");
    if (!cardA || !cardB) throw new Error("expected two needs-you cards");
    store.snooze(cardA);
    store.snooze(cardB);
    await tick();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({
      a: snoozeStamp(cardA),
      b: snoozeStamp(cardB),
    });
    emit({ kind: "remove", agentId: "a" });
    // Re-snoozing b triggers another save; that save must drop a's now-orphaned entry.
    store.snooze(cardB);
    await tick();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({ b: snoozeStamp(cardB) });
    store.dispose();
  });

  it("keeps a snoozed entry whose agent exists but currently has no needs-you card", async () => {
    const other = {
      ...waiting,
      id: "b",
      pendingPermissions: [{ ...waiting.pendingPermissions[0], id: "q2" }],
    };
    const { paseo, emit } = fakePaseo([waiting, other]);
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    const cardA = store.getSnapshot().lanes.needsYou.find((c) => c.agent.id === "a");
    const cardB = store.getSnapshot().lanes.needsYou.find((c) => c.agent.id === "b");
    if (!cardA || !cardB) throw new Error("expected two needs-you cards");
    store.snooze(cardA);
    await tick();
    // "a" briefly has no card in any lane between two broadcasts — its pending
    // request cleared without a result yet — but the agent itself is still known.
    emit({
      kind: "upsert",
      agent: { ...waiting, status: "idle", pendingPermissions: [], requiresAttention: false },
    });
    store.snooze(cardB);
    await tick();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({
      a: snoozeStamp(cardA),
      b: snoozeStamp(cardB),
    });
    store.dispose();
  });

  it("publishes the pruned snoozed map to memory, not just to storage", async () => {
    const { paseo } = fakePaseo([waiting]);
    const values = new Map<string, string>([
      ["snoozed", JSON.stringify({ ghost: "some-stale-stamp" })],
    ]);
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    // Loaded as-is: the load path merges storage with memory but does not prune.
    expect(store.getSnapshot().snoozed.has("ghost")).toBe(true);
    const card = store.getSnapshot().lanes.needsYou[0];
    store.snooze(card);
    await tick();
    // The save's own prune step drops the ghost from the write; it must drop
    // it from memory in the same pass, or every later load re-imports it and
    // forces a redundant save.
    expect(store.getSnapshot().snoozed.has("ghost")).toBe(false);
    expect(JSON.parse(values.get("snoozed") ?? "{}")).not.toHaveProperty("ghost");
    store.dispose();
  });

  it("does not stack a second reload when retrySnoozed is called before the first one resolves", async () => {
    const { paseo } = fakePaseo([waiting]);
    let getItemCalls = 0;
    const reload = deferred<string | null>();
    const storage = {
      getItem: vi.fn(async (key: string): Promise<string | null> => {
        if (key !== "snoozed") return null;
        getItemCalls += 1;
        if (getItemCalls === 1) throw new Error("Offline");
        return reload.promise;
      }),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBe("Offline");
    store.retrySnoozed(); // starts the one allowed reload, held open by `reload`
    await tick();
    expect(getItemCalls).toBe(2);
    // A second retry while the first reload is still in flight must return
    // early instead of starting a third `getItem("snoozed")` call.
    store.retrySnoozed();
    await tick();
    expect(getItemCalls).toBe(2);
    reload.resolve(null);
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBeNull();
    store.dispose();
  });

  it("serializes snoozed writes so a slow earlier write can't land after a later one", async () => {
    const other = {
      ...waiting,
      id: "b",
      pendingPermissions: [{ ...waiting.pendingPermissions[0], id: "q2" }],
    };
    const { paseo } = fakePaseo([waiting, other]);
    const values = new Map<string, string>();
    const firstWrite = deferred<void>();
    let setItemCalls = 0;
    const setItem = vi.fn(async (key: string, value: string) => {
      setItemCalls += 1;
      if (setItemCalls === 1) await firstWrite.promise;
      values.set(key, value);
    });
    const storage = { getItem: async () => null, setItem, removeItem: vi.fn() };
    const store = createInboxStore(paseo, storage);
    await tick();
    const cardA = store.getSnapshot().lanes.needsYou.find((c) => c.agent.id === "a");
    const cardB = store.getSnapshot().lanes.needsYou.find((c) => c.agent.id === "b");
    if (!cardA || !cardB) throw new Error("expected two needs-you cards");
    store.snooze(cardA);
    await tick();
    expect(setItem).toHaveBeenCalledTimes(1);
    // Issued while the first write is still stuck on `firstWrite` — the second
    // setItem must not fire until the first one resolves.
    store.snooze(cardB);
    await tick();
    await tick();
    expect(setItem).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await tick();
    await tick();
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({
      a: snoozeStamp(cardA),
      b: snoozeStamp(cardB),
    });
    store.dispose();
  });

  it("does not let a save queued before a load failure resurrect an unsnooze made while blocked", async () => {
    const { paseo } = fakePaseo([waiting]);
    const values = new Map<string, string>();
    const initialLoad = deferred<string | null>();
    const firstSave = deferred<void>();
    const reload = deferred<string | null>();
    let getItemCalls = 0;
    let setItemCalls = 0;
    const storage = {
      getItem: vi.fn((key: string) => {
        if (key !== "snoozed") return Promise.resolve(null);
        getItemCalls += 1;
        // Call 1 is the constructor's initial load, held open until it's
        // rejected below. Call 2 is the reload the blocked unsnooze triggers.
        return getItemCalls === 1 ? initialLoad.promise : reload.promise;
      }),
      setItem: vi.fn(async (key: string, value: string) => {
        setItemCalls += 1;
        // Call 1 is the snooze below, sent while the load is still pending —
        // held open until after the load fails and the unsnooze is blocked.
        if (setItemCalls === 1) await firstSave.promise;
        values.set(key, value);
      }),
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    const card = store.getSnapshot().lanes.needsYou[0];
    // Snooze while the initial load is still in flight — nothing has failed
    // yet, so this save goes out on the normal (unblocked) path.
    store.snooze(card);
    await tick();
    expect(store.getSnapshot().snoozed.get("a")).toBe(snoozeStamp(card));
    // The load that was already in flight now fails.
    initialLoad.reject(new Error("Offline"));
    await tick();
    expect(store.getSnapshot().snoozedLoadError).toBe("Offline");
    // Unsnooze while blocked: recorded as a tombstone, this save is blocked,
    // and it triggers its own reload (held open by `reload`).
    store.unsnooze("a");
    await tick();
    expect(store.getSnapshot().snoozed.has("a")).toBe(false);
    // The first save — queued before the load ever failed — resolves now and
    // writes the pre-unsnooze state to storage.
    firstSave.resolve();
    await tick();
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({ a: snoozeStamp(card) });
    // The reload the blocked unsnooze started now reads that pre-unsnooze
    // value. It must not let it override the unsnooze that happened after it
    // was queued.
    reload.resolve(values.get("snoozed") ?? null);
    await tick();
    await tick();
    expect(store.getSnapshot().snoozed.has("a")).toBe(false);
    expect(JSON.parse(values.get("snoozed") ?? "{}")).toEqual({});
    store.dispose();
  });
});

it("restores drafts across a plugin disconnect/reinstall after a failed send", async () => {
  const { paseo } = fakePaseo([waiting]);
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  paseo.agents.ref = vi.fn(() => ({
    send: vi.fn().mockRejectedValue(new Error("Disconnected")),
  })) as unknown as PaseoApi["agents"]["ref"];
  const first = createInboxStore(paseo, storage);
  await tick();
  first.setDraft("a", "Keep my reply");
  first.setDraft("b", "Other agent's reply");
  expect(await first.sendReply("a")).toBe(false);
  first.dispose();
  const reinstalled = createInboxStore(paseo, storage);
  await tick();
  expect(reinstalled.getSnapshot().draftsReady).toBe(true);
  expect(reinstalled.getSnapshot().drafts.get("a")).toBe("Keep my reply");
  expect(reinstalled.getSnapshot().drafts.get("b")).toBe("Other agent's reply");
  reinstalled.dispose();
});

it("ignores a disposed instance's late send completion after a new instance edits drafts", async () => {
  const { paseo } = fakePaseo([waiting]);
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  const delivery = deferred<void>();
  paseo.agents.ref = vi.fn(() => ({
    send: () => delivery.promise,
  })) as unknown as PaseoApi["agents"]["ref"];
  const first = createInboxStore(paseo, storage);
  await tick();
  first.setDraft("a", "Original reply");
  const pending = first.sendReply("a");
  first.dispose();
  const second = createInboxStore(paseo, storage);
  await tick();
  second.setDraft("a", "New reply");
  second.setDraft("b", "Another draft");
  delivery.resolve();
  expect(await pending).toBe(false);
  expect(JSON.parse(values.get("drafts") ?? "{}")).toEqual({ a: "New reply", b: "Another draft" });
  second.dispose();
});
