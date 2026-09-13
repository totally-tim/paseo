import { expect, it, vi } from "vitest";
import { openPermissionPolicy, resolvePolicyNotification } from "./permission-policy-model";
const preview = {
  pattern: '{"provider":"claude","tool":"Write","input":{"path":"file"}}',
  projectId: "p1",
};
it("reviews exact pattern, defaults to project and commits only after explicit save", async () => {
  const client = {
    getCoordinatorPermissionPolicyPreview: vi.fn().mockResolvedValue(preview),
    alwaysAllowCoordinatorPermission: vi.fn().mockResolvedValue({}),
  };
  const model = openPermissionPolicy("a", "r");
  await model.load(client);
  expect(client.alwaysAllowCoordinatorPermission).not.toHaveBeenCalled();
  expect(model.getState()).toMatchObject({ scope: "project" });
  model.setScope("daemon");
  await model.save(client);
  expect(client.alwaysAllowCoordinatorPermission).toHaveBeenCalledWith({
    agentId: "a",
    requestId: "r",
    scope: "daemon",
    expectedPattern: preview.pattern,
  });
  expect(model.getState()).toMatchObject({ saved: true });
  await model.save(client);
  expect(client.alwaysAllowCoordinatorPermission).toHaveBeenCalledTimes(1);
});
it("retains reviewed scope and error after conflict, permitting explicit retry", async () => {
  const client = {
    getCoordinatorPermissionPolicyPreview: vi.fn().mockResolvedValue(preview),
    alwaysAllowCoordinatorPermission: vi
      .fn()
      .mockRejectedValueOnce(new Error("Permission changed"))
      .mockResolvedValue({}),
  };
  const model = openPermissionPolicy("a", "r");
  await model.load(client);
  await model.save(client);
  expect(model.getState()).toMatchObject({
    saved: false,
    error: "Permission changed",
    scope: "project",
  });
  await model.save(client);
  expect(model.getState()).toMatchObject({ saved: true });
});
it("never saves after preview failure or disconnected load", async () => {
  const client = {
    getCoordinatorPermissionPolicyPreview: vi.fn().mockRejectedValue(new Error("Resolved")),
    alwaysAllowCoordinatorPermission: vi.fn(),
  };
  const model = openPermissionPolicy("a", "r");
  await model.load(client);
  await model.save(client);
  expect(client.alwaysAllowCoordinatorPermission).not.toHaveBeenCalled();
  expect(model.getState()).toMatchObject({ status: "error" });
});
it("routes only complete Always foreground intents to review", () => {
  expect(
    resolvePolicyNotification("always_allow", { serverId: "s", agentId: "a", requestId: "r" }),
  ).toEqual({ serverId: "s", agentId: "a", requestId: "r" });
  expect(
    resolvePolicyNotification("allow", { serverId: "s", agentId: "a", requestId: "r" }),
  ).toBeNull();
  expect(resolvePolicyNotification("always_allow", { agentId: "a" })).toBeNull();
});
