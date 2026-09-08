import { expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  SidebarOrderSnapshotSchema,
} from "./messages.js";
const order = {
  projectOrder: [],
  projectGroupOrder: [],
  pinnedWorkspaceOrder: [],
  workspaceOrderByProject: {},
};
test("sidebar ordering RPCs and subscribed snapshots pass the wire schemas", () => {
  for (const message of [
    { type: "sidebar.order.get.request", requestId: "read", subscribe: true },
    { type: "sidebar.order.initialize.request", requestId: "import", order },
    {
      type: "sidebar.order.update.request",
      requestId: "write",
      expectedRevision: 1,
      change: { kind: "workspaces", projectId: "p", keys: ["w"] },
    },
  ])
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  const snapshot = { revision: 2, initialized: true, order };
  expect(
    SessionOutboundMessageSchema.parse({ type: "sidebar.order.changed", payload: snapshot }),
  ).toEqual({ type: "sidebar.order.changed", payload: snapshot });
  expect(SidebarOrderSnapshotSchema.safeParse({ ...snapshot, revision: -1 }).success).toBe(false);
});
