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
