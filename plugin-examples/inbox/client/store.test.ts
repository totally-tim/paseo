import { describe, expect, it, vi } from "vitest";
import { createInboxStore, replyKey, responseKey } from "./store";
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
  pendingPermissions: [{ id: "p", kind: "question", name: "AskUserQuestion", input: {} }],
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
    const saved = { projectId: "p", projectGroup: "group" };
    const storage = {
      getItem: vi.fn().mockResolvedValue(JSON.stringify(saved)),
      setItem: vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(undefined),
      removeItem: vi.fn(),
    };
    const store = createInboxStore(paseo, storage);
    await tick();
    expect(store.getSnapshot().filters).toEqual(saved);
    store.setFilters({ projectId: "new", projectGroup: null });
    await tick();
    expect(store.getSnapshot().filtersError).toBe("Disk full");
    store.retryFilters();
    await tick();
    expect(store.getSnapshot().filtersError).toBeNull();
    expect(storage.setItem).toHaveBeenLastCalledWith(
      "filters",
      JSON.stringify({ projectId: "new", projectGroup: null }),
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
    store.setFilters({ projectId: "chosen", projectGroup: null });
    read.resolve(JSON.stringify({ projectId: "old", projectGroup: null }));
    await tick();
    expect(store.getSnapshot().filters.projectId).toBe("chosen");
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
