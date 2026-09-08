import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("two clients share imported order, reject stale writes and reload on reconnect", async () => {
  const daemon = await createTestPaseoDaemon();
  const desktop = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let phone = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await Promise.all([desktop.connect(), phone.connect()]);
    expect((await phone.getSidebarOrder()).snapshot?.initialized).toBe(false);
    const desktopEvents: number[] = [];
    const phoneEvents: number[] = [];
    desktop.on("sidebar.order.changed", (message) => desktopEvents.push(message.payload.revision));
    phone.on("sidebar.order.changed", (message) => phoneEvents.push(message.payload.revision));
    await desktop.getSidebarOrder();
    const order = {
      projectOrder: ["b", "a"],
      projectGroupOrder: ["work", "personal"],
      pinnedWorkspaceOrder: ["w2", "w1"],
      workspaceOrderByProject: { a: ["w2", "w1"] },
    };
    expect((await desktop.initializeSidebarOrder(order)).accepted).toBe(true);
    await expect.poll(() => phoneEvents).toEqual([1]);
    expect((await phone.getSidebarOrder()).snapshot?.order).toEqual(order);
    expect(
      (await phone.updateSidebarOrder(1, { kind: "groups", keys: ["personal", "work"] })).accepted,
    ).toBe(true);
    await expect.poll(() => desktopEvents).toEqual([1, 2]);
    const stale = await desktop.updateSidebarOrder(1, { kind: "projects", keys: ["a", "b"] });
    expect(stale.accepted).toBe(false);
    expect(stale.snapshot?.revision).toBe(2);
    await phone.close();
    expect(
      (await desktop.updateSidebarOrder(2, { kind: "pins", keys: ["w1", "w2"] })).accepted,
    ).toBe(true);
    phone = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await phone.connect();
    expect((await phone.getSidebarOrder()).snapshot).toEqual({
      revision: 3,
      initialized: true,
      order: {
        ...order,
        projectGroupOrder: ["personal", "work"],
        pinnedWorkspaceOrder: ["w1", "w2"],
      },
    });
    await phone.getSidebarOrder(false);
    await desktop.updateSidebarOrder(3, { kind: "projects", keys: ["a", "b"] });
    await phone.getSidebarOrder(false);
    expect(phoneEvents).toEqual([1, 2]);
  } finally {
    await Promise.all([desktop.close(), phone.close()]);
    await daemon.close();
  }
}, 60000);

test("sidebar replies and subscriptions stay on their physical socket", async () => {
  const daemon = await createTestPaseoDaemon();
  const config = { url: `ws://127.0.0.1:${daemon.port}/ws`, clientId: "shared-sidebar-client" };
  const legacy = new DaemonClient(config);
  const first = new DaemonClient(config);
  const second = new DaemonClient(config);
  const traffic = (client: DaemonClient) => {
    const types: string[] = [];
    for (const type of [
      "sidebar.order.get.response",
      "sidebar.order.initialize.response",
      "sidebar.order.update.response",
      "sidebar.order.changed",
    ] as const) {
      client.on(type, () => types.push(type));
    }
    return types;
  };
  const legacyTraffic = traffic(legacy);
  const firstTraffic = traffic(first);
  const secondTraffic = traffic(second);
  try {
    await Promise.all([legacy.connect(), first.connect(), second.connect()]);
    await first.getSidebarOrder(true);
    await second.getSidebarOrder(true);
    expect(firstTraffic).toEqual(["sidebar.order.get.response"]);
    expect(secondTraffic).toEqual(["sidebar.order.get.response"]);
    const order = {
      projectOrder: [],
      projectGroupOrder: ["old"],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
    };
    await first.initializeSidebarOrder(order);
    await second.listProjects();
    expect(firstTraffic).toEqual([
      "sidebar.order.get.response",
      "sidebar.order.changed",
      "sidebar.order.initialize.response",
    ]);
    expect(secondTraffic).toEqual(["sidebar.order.get.response", "sidebar.order.changed"]);
    await first.getSidebarOrder(false);
    await second.updateSidebarOrder(1, { kind: "groups", keys: ["new"] });
    await first.listProjects();
    expect(firstTraffic).toEqual([
      "sidebar.order.get.response",
      "sidebar.order.changed",
      "sidebar.order.initialize.response",
      "sidebar.order.get.response",
    ]);
    expect(secondTraffic).toEqual([
      "sidebar.order.get.response",
      "sidebar.order.changed",
      "sidebar.order.changed",
      "sidebar.order.update.response",
    ]);
    await first.close();
    await second.updateSidebarOrder(2, { kind: "groups", keys: ["latest"] });
    await legacy.listProjects();
    expect(legacyTraffic).toEqual([]);
    expect(secondTraffic.slice(-2)).toEqual([
      "sidebar.order.changed",
      "sidebar.order.update.response",
    ]);
  } finally {
    await Promise.all([legacy.close(), first.close(), second.close()]);
    await daemon.close();
  }
}, 60000);
