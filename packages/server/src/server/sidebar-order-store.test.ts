import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SidebarOrderStore } from "./sidebar-order-store.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const order = {
  projectOrder: ["b", "a"],
  projectGroupOrder: ["work", "personal"],
  pinnedWorkspaceOrder: ["two", "one"],
  workspaceOrderByProject: { a: ["two", "one"] },
};
async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "sidebar-order-"));
  directories.push(directory);
  const path = join(directory, "order.json");
  return { store: new SidebarOrderStore(path), path };
}
test("reading from a phone does not seed the store; exactly one import wins and survives reload", async () => {
  const { store, path } = await createStore();
  expect((await store.get()).initialized).toBe(false);
  const results = await Promise.all([
    store.initialize(order),
    store.initialize({ ...order, projectOrder: ["a", "b"] }),
  ]);
  expect(results.map((result) => result.accepted)).toEqual([true, false]);
  expect(await new SidebarOrderStore(path).get()).toEqual({
    initialized: true,
    revision: 1,
    order,
  });
});
test("rejects concurrent stale edits and preserves unrelated scopes", async () => {
  const { store } = await createStore();
  await store.initialize(order);
  const results = await Promise.all([
    store.update(1, { kind: "projects", keys: ["a", "b"] }),
    store.update(1, { kind: "groups", keys: ["personal", "work"] }),
  ]);
  expect(results.map((result) => result.accepted)).toEqual([true, false]);
  expect(results[1].snapshot).toEqual({
    initialized: true,
    revision: 2,
    order: { ...order, projectOrder: ["a", "b"] },
  });
  expect(
    (await store.update(2, { kind: "workspaces", projectId: "a", keys: ["one", "two"] })).snapshot
      .order,
  ).toEqual({ ...order, projectOrder: ["a", "b"], workspaceOrderByProject: { a: ["one", "two"] } });
});
test("publishes committed snapshots to two subscribers and removes subscriptions", async () => {
  const { store } = await createStore();
  const phone: number[] = [];
  const desktop: number[] = [];
  const unsubscribe = store.subscribe((snapshot) => phone.push(snapshot.revision));
  store.subscribe((snapshot) => desktop.push(snapshot.revision));
  await store.initialize(order);
  unsubscribe();
  await store.update(1, { kind: "pins", keys: ["one"] });
  expect(phone).toEqual([1]);
  expect(desktop).toEqual([1, 2]);
});
test("refuses updates before explicit import", async () => {
  const { store } = await createStore();
  expect((await store.update(0, { kind: "projects", keys: ["a"] })).accepted).toBe(false);
  expect((await store.get()).revision).toBe(0);
});

test("failed persistence leaves the revision unchanged and can be retried", async () => {
  const { store, path } = await createStore();
  await store.get();
  await mkdir(path);
  const events: number[] = [];
  store.subscribe((snapshot) => events.push(snapshot.revision));
  await expect(store.initialize(order)).rejects.toThrow();
  expect((await store.get()).revision).toBe(0);
  expect(events).toEqual([]);
  await rm(path, { recursive: true });
  expect((await store.initialize(order)).accepted).toBe(true);
  expect(events).toEqual([1]);
});
