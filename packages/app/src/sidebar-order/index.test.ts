import { beforeEach, expect, test, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SidebarOrderSnapshot } from "@getpaseo/protocol/messages";
import { emptyOrder } from "./projection";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));
vi.mock("@/stores/session-store", async () => {
  const { create } = await import("zustand");
  const { subscribeWithSelector } = await import("zustand/middleware");
  return {
    useSessionStore: create(
      subscribeWithSelector(() => ({
        sessions: { host: { projects: new Map(), workspaces: new Map() } },
      })),
    ),
  };
});
function fakeClient(initial: SidebarOrderSnapshot) {
  let snapshot = initial;
  let listener: ((message: { payload: SidebarOrderSnapshot }) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const methods = {
    on: vi.fn((_event: string, next: typeof listener) => {
      listener = next;
      return unsubscribe;
    }),
    getSidebarOrder: vi.fn(
      async (): Promise<Awaited<ReturnType<DaemonClient["getSidebarOrder"]>>> => ({
        accepted: true,
        snapshot,
        error: null,
        requestId: "get",
      }),
    ),
    initializeSidebarOrder: vi.fn(async (order: SidebarOrderSnapshot["order"]) => {
      snapshot = { revision: 1, initialized: true, order };
      return { accepted: true, snapshot, error: null, requestId: "initialize" };
    }),
    updateSidebarOrder: vi.fn(
      async (): Promise<Awaited<ReturnType<DaemonClient["updateSidebarOrder"]>>> => ({
        accepted: true,
        snapshot,
        error: null,
        requestId: "update",
      }),
    ),
  };
  return {
    client: methods as unknown as DaemonClient,
    methods,
    unsubscribe,
    emit(next: SidebarOrderSnapshot) {
      snapshot = next;
      listener?.({ payload: next });
    },
  };
}
beforeEach(() => {
  storage.clear();
  vi.resetModules();
});
const uninitialized = (): SidebarOrderSnapshot => ({
  revision: 0,
  initialized: false,
  order: emptyOrder(),
});

test("phone connection never auto-imports; desktop's saved copy survives remote adoption", async () => {
  storage.set(
    "sidebar-project-workspace-order",
    JSON.stringify({
      version: 1,
      state: { ...emptyOrder(), projectGroupOrder: ["desktop", "phone"] },
    }),
  );
  const { sidebarOrderSync } = await import("./index");
  const { useSidebarOrderStore } = await import("@/stores/sidebar-order-store");
  const fake = fakeClient(uninitialized());
  await sidebarOrderSync.connect("host", fake.client, true);
  expect(fake.methods.initializeSidebarOrder).not.toHaveBeenCalled();
  fake.emit({
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["phone", "desktop"] },
  });
  expect(useSidebarOrderStore.getState().projectGroupOrder).toEqual(["phone", "desktop"]);
  expect(
    JSON.parse(storage.get("sidebar-order-sync")!).state.importOrder.projectGroupOrder,
  ).toEqual(["desktop", "phone"]);
});

test("import failure remains actionable and retry succeeds", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const fake = fakeClient(uninitialized());
  fake.methods.initializeSidebarOrder.mockRejectedValueOnce(new Error("Disk full"));
  await sidebarOrderSync.connect("host", fake.client, true);
  await sidebarOrderSync.initialize("host");
  expect(useSidebarOrderSync.getState().hosts.host.error).toBe("Disk full");
  expect(useSidebarOrderSync.getState().hosts.host.pending).toBe(false);
  await sidebarOrderSync.initialize("host");
  expect(useSidebarOrderSync.getState().hosts.host.snapshot?.initialized).toBe(true);
  expect(useSidebarOrderSync.getState().hosts.host.error).toBeNull();
});

test("reconnect detaches the old subscription and a late old response cannot replace current order", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const old = fakeClient(uninitialized());
  let resolve!: (value: Awaited<ReturnType<DaemonClient["getSidebarOrder"]>>) => void;
  old.methods.getSidebarOrder.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const connecting = sidebarOrderSync.connect("host", old.client, true);
  await vi.waitFor(() => expect(old.methods.getSidebarOrder).toHaveBeenCalledTimes(1));
  const next = fakeClient({ revision: 2, initialized: true, order: emptyOrder() });
  await sidebarOrderSync.connect("host", next.client, true);
  resolve({ requestId: "old", accepted: true, snapshot: uninitialized(), error: null });
  await connecting;
  expect(old.unsubscribe).toHaveBeenCalledTimes(1);
  expect(useSidebarOrderSync.getState().hosts.host.snapshot?.revision).toBe(2);
  sidebarOrderSync.disconnect("host");
  expect(next.unsubscribe).toHaveBeenCalledTimes(1);
  expect(useSidebarOrderSync.getState().hosts.host.status).toBe("offline");
});

test("renaming retains the host order even before project metadata catches up", async () => {
  const { sidebarOrderSync } = await import("./index");
  const fake = fakeClient({
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["old", "other"] },
  });
  await sidebarOrderSync.connect("host", fake.client, true);
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "new" });
  expect(fake.methods.updateSidebarOrder).toHaveBeenCalledWith(1, {
    kind: "groups",
    keys: ["new", "other"],
  });
});

test("offline writes are refused without changing the displayed order", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const { useSidebarOrderStore } = await import("@/stores/sidebar-order-store");
  const fake = fakeClient({
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["old", "other"] },
  });
  await sidebarOrderSync.connect("host", fake.client, true);
  sidebarOrderSync.disconnect("host");
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "new" });
  expect(fake.methods.updateSidebarOrder).not.toHaveBeenCalled();
  expect(useSidebarOrderStore.getState().projectGroupOrder).toEqual(["old", "other"]);
  expect(useSidebarOrderSync.getState().hosts.host.error).toContain("Connect");
});

test("stale writes adopt the returned snapshot and leave a visible conflict", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const { useSidebarOrderStore } = await import("@/stores/sidebar-order-store");
  const fake = fakeClient({
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["old", "other"] },
  });
  await sidebarOrderSync.connect("host", fake.client, true);
  fake.methods.updateSidebarOrder.mockImplementationOnce(async () => {
    const snapshot = {
      revision: 2,
      initialized: true,
      order: { ...emptyOrder(), projectGroupOrder: ["other", "old"] },
    };
    fake.emit(snapshot);
    return { accepted: false, snapshot, error: "Changed on another device", requestId: "update" };
  });
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "new" });
  expect(useSidebarOrderStore.getState().projectGroupOrder).toEqual(["other", "old"]);
  expect(useSidebarOrderSync.getState().hosts.host.error).toBe("Changed on another device");
  expect(useSidebarOrderSync.getState().hosts.host.pending).toBe(false);
});

test("unsupported hosts never receive a new RPC and uninitialized hosts cannot be reordered", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const fake = fakeClient(uninitialized());
  await sidebarOrderSync.connect("host", fake.client, false);
  expect(fake.methods.getSidebarOrder).not.toHaveBeenCalled();
  expect(sidebarOrderSync.readiness(["host"])).toContain("Update");
  await sidebarOrderSync.connect("host", fake.client, true);
  await sidebarOrderSync.write({ kind: "pins", keys: ["host:w"] });
  expect(fake.methods.updateSidebarOrder).not.toHaveBeenCalled();
  expect(useSidebarOrderSync.getState().hosts.host.error).toContain("Use this device");
});

test("accepts a reset host revision on reconnect", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const old = fakeClient({ revision: 10, initialized: true, order: emptyOrder() });
  await sidebarOrderSync.connect("host", old.client, true);
  const reset = fakeClient(uninitialized());
  await sidebarOrderSync.connect("host", reset.client, true);
  expect(useSidebarOrderSync.getState().hosts.host.snapshot).toEqual(uninitialized());
  await sidebarOrderSync.initialize("host");
  expect(reset.methods.initializeSidebarOrder).toHaveBeenCalledTimes(1);
});

test("does not let an older initial response replace a new connection event", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const fake = fakeClient(uninitialized());
  let resolve!: (value: Awaited<ReturnType<DaemonClient["getSidebarOrder"]>>) => void;
  fake.methods.getSidebarOrder.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const connecting = sidebarOrderSync.connect("host", fake.client, true);
  await vi.waitFor(() => expect(fake.methods.getSidebarOrder).toHaveBeenCalledTimes(1));
  fake.emit({ revision: 2, initialized: true, order: emptyOrder() });
  resolve({ requestId: "get", accepted: true, snapshot: uninitialized(), error: null });
  await connecting;
  expect(useSidebarOrderSync.getState().hosts.host.snapshot?.revision).toBe(2);
});

test("unsupported host connection does not wait for local storage hydration", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const { useSidebarOrderStore } = await import("@/stores/sidebar-order-store");
  const hydration = vi.spyOn(useSidebarOrderStore.persist, "hasHydrated").mockReturnValue(false);
  const fake = fakeClient(uninitialized());
  try {
    await sidebarOrderSync.connect("host", fake.client, false);
    expect(useSidebarOrderSync.getState().hosts.host.status).toBe("unsupported");
    expect(fake.methods.getSidebarOrder).not.toHaveBeenCalled();
  } finally {
    hydration.mockRestore();
  }
});

test("retries only a failed host after a group rename and reconnect", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const initial = {
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["old", "other"] },
  };
  const a = fakeClient(initial);
  const b = fakeClient(initial);
  a.methods.updateSidebarOrder.mockImplementationOnce(async () => {
    const snapshot = {
      ...initial,
      revision: 2,
      order: { ...initial.order, projectGroupOrder: ["new", "other"] },
    };
    a.emit(snapshot);
    return { accepted: true, snapshot, error: null, requestId: "update-a" };
  });
  b.methods.updateSidebarOrder.mockRejectedValueOnce(new Error("B offline"));
  await sidebarOrderSync.connect("a", a.client, true);
  await sidebarOrderSync.connect("b", b.client, true);
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "new" });
  expect(useSidebarOrderSync.getState().hosts.a.failedWrite).toBeUndefined();
  expect(useSidebarOrderSync.getState().hosts.b.failedWrite?.change).toEqual({
    kind: "groups",
    keys: ["new", "other"],
  });
  await sidebarOrderSync.refresh("b");
  expect(useSidebarOrderSync.getState().hosts.b.failedWrite).toBeDefined();
  // A newer revision for a different scope is safe to retain while retrying the group rename.
  const reconnectSnapshot = {
    ...initial,
    revision: 3,
    order: { ...initial.order, pinnedWorkspaceOrder: ["new-pin"] },
  };
  const reconnected = fakeClient(reconnectSnapshot);
  reconnected.methods.updateSidebarOrder.mockImplementationOnce(async () => {
    const snapshot = {
      ...reconnectSnapshot,
      revision: 4,
      order: { ...reconnectSnapshot.order, projectGroupOrder: ["new", "other"] },
    };
    reconnected.emit(snapshot);
    return { accepted: true, snapshot, error: null, requestId: "retry" };
  });
  await sidebarOrderSync.connect("b", reconnected.client, true);
  await sidebarOrderSync.retry("b");
  expect(a.methods.updateSidebarOrder).toHaveBeenCalledTimes(1);
  expect(reconnected.methods.updateSidebarOrder).toHaveBeenCalledWith(3, {
    kind: "groups",
    keys: ["new", "other"],
  });
  expect(useSidebarOrderSync.getState().hosts.b.failedWrite).toBeUndefined();
  expect(useSidebarOrderSync.getState().hosts.b.snapshot?.order.pinnedWorkspaceOrder).toEqual([
    "new-pin",
  ]);
});

test("retains a failed change until retry or discard and refuses to overwrite a newer order", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const initial = {
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["old", "other"] },
  };
  const fake = fakeClient(initial);
  fake.methods.updateSidebarOrder.mockRejectedValueOnce(new Error("Disk full"));
  await sidebarOrderSync.connect("host", fake.client, true);
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "new" });
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "newer" });
  expect(fake.methods.updateSidebarOrder).toHaveBeenCalledTimes(1);
  fake.emit({
    ...initial,
    revision: 2,
    order: { ...initial.order, projectGroupOrder: ["other", "old"] },
  });
  await sidebarOrderSync.retry("host");
  expect(fake.methods.updateSidebarOrder).toHaveBeenCalledTimes(1);
  expect(useSidebarOrderSync.getState().hosts.host.error).toContain("changed on another device");
  expect(useSidebarOrderSync.getState().hosts.host.failedWrite).toBeDefined();
  sidebarOrderSync.dismiss("host");
  expect(useSidebarOrderSync.getState().hosts.host.failedWrite).toBeUndefined();
  expect(sidebarOrderSync.readiness(["host"])).toBeNull();
});

test("retries a failed write when its reload also failed on a connected host", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const initial = {
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["old"] },
  };
  const fake = fakeClient(initial);
  await sidebarOrderSync.connect("host", fake.client, true);
  fake.methods.updateSidebarOrder.mockRejectedValueOnce(new Error("Write timeout"));
  fake.methods.getSidebarOrder.mockRejectedValueOnce(new Error("Reload timeout"));
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "new" });
  expect(useSidebarOrderSync.getState().hosts.host.status).toBe("loading");
  expect(useSidebarOrderSync.getState().hosts.host.failedWrite).toBeDefined();
  await sidebarOrderSync.retry("host");
  expect(fake.methods.updateSidebarOrder).toHaveBeenCalledTimes(2);
  expect(useSidebarOrderSync.getState().hosts.host.status).toBe("online");
  expect(useSidebarOrderSync.getState().hosts.host.failedWrite).toBeUndefined();
});

test("recognizes a write that committed before its response was lost", async () => {
  const { sidebarOrderSync, useSidebarOrderSync } = await import("./index");
  const initial = {
    revision: 1,
    initialized: true,
    order: { ...emptyOrder(), projectGroupOrder: ["old"] },
  };
  const fake = fakeClient(initial);
  fake.methods.updateSidebarOrder.mockImplementationOnce(async () => {
    fake.emit({ ...initial, revision: 2, order: { ...initial.order, projectGroupOrder: ["new"] } });
    throw new Error("Lost response");
  });
  await sidebarOrderSync.connect("host", fake.client, true);
  await sidebarOrderSync.write({ kind: "renameGroup", fromKey: "old", toKey: "new" });
  await sidebarOrderSync.retry("host");
  expect(fake.methods.updateSidebarOrder).toHaveBeenCalledTimes(1);
  expect(useSidebarOrderSync.getState().hosts.host.failedWrite).toBeUndefined();
});
