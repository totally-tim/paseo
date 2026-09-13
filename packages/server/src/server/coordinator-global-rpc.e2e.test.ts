import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";

let ctx: DaemonTestContext;
beforeEach(async () => {
  ctx = await createDaemonTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

describe("global coordinator over the wire", () => {
  test("get, enable, update, and disable return the persisted global state", async () => {
    expect(await ctx.client.getGlobalCoordinator()).toMatchObject({
      enabled: false,
      agentId: null,
      workspaceId: null,
      projectId: null,
      trustLevel: "observe",
    });
    const enabled = await ctx.client.enableGlobalCoordinator({ profile: { provider: "codex" } });
    expect(enabled.enabled).toBe(true);
    expect(enabled.agentId).toBeTruthy();
    expect(enabled.workspaceId).toBeTruthy();
    expect(enabled.projectId).toBeTruthy();
    expect(await ctx.client.getGlobalCoordinator()).toEqual(enabled);
    const updated = await ctx.client.updateGlobalCoordinator({ trustLevel: "propose" });
    expect(updated.trustLevel).toBe("propose");
    expect(updated.agentId).toBe(enabled.agentId);
    expect((await ctx.client.getGlobalCoordinator()).trustLevel).toBe("propose");
    const subscription = ctx.client.observeCoordinatorBoard();
    try {
      const board = await subscription.ready;
      expect(board.snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tier: "global", coordinatorAgentId: enabled.agentId }),
        ]),
      );
    } finally {
      await subscription.release();
    }
    const disabled = await ctx.client.disableGlobalCoordinator();
    expect(disabled.enabled).toBe(false);
    expect(await ctx.client.getGlobalCoordinator()).toEqual(disabled);
  });
});
