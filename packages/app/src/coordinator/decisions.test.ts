import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { CoordinatorDecisionBoardRow } from "@getpaseo/protocol/messages";
import type { PendingPermission } from "@/types/shared";
import {
  buildBoardActionResponse,
  resolveBoardActions,
  resolveDecisionPermission,
} from "./decisions";

function makeRequest(input: {
  id: string;
  actions?: AgentPermissionRequest["actions"];
}): AgentPermissionRequest {
  return {
    id: input.id,
    provider: "claude",
    name: "Bash",
    kind: "tool",
    actions: input.actions,
  };
}

function makePermission(input: {
  key: string;
  agentId: string;
  requestId: string;
  actions?: AgentPermissionRequest["actions"];
}): PendingPermission {
  return {
    key: input.key,
    agentId: input.agentId,
    request: makeRequest({ id: input.requestId, actions: input.actions }),
  };
}

function makeRow(input: {
  agentId: string;
  requestId: string;
  actions?: { id: string; label: string }[];
}): Pick<CoordinatorDecisionBoardRow, "agentId" | "requestId" | "actions"> {
  return {
    agentId: input.agentId,
    requestId: input.requestId,
    actions: input.actions ?? [
      { id: "allow-once", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
  };
}

describe("resolveDecisionPermission", () => {
  it("hits the canonical agentId:requestId key first", () => {
    const permission = makePermission({
      key: "agent-1:req-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
    const pending = new Map([[permission.key, permission]]);

    expect(
      resolveDecisionPermission(pending, makeRow({ agentId: "agent-1", requestId: "req-1" })),
    ).toBe(permission);
  });

  it("scans for a request match when the map key differs", () => {
    const permission = makePermission({
      key: "srv:agent-1:req-1",
      agentId: "agent-1",
      requestId: "req-1",
    });
    const pending = new Map([[permission.key, permission]]);

    expect(
      resolveDecisionPermission(pending, makeRow({ agentId: "agent-1", requestId: "req-1" })),
    ).toBe(permission);
  });

  it("does not match another agent's request with the same request id", () => {
    const permission = makePermission({
      key: "agent-2:req-1",
      agentId: "agent-2",
      requestId: "req-1",
    });
    const pending = new Map([[permission.key, permission]]);

    expect(
      resolveDecisionPermission(pending, makeRow({ agentId: "agent-1", requestId: "req-1" })),
    ).toBeNull();
  });

  it("returns null once the request left the pending map", () => {
    expect(
      resolveDecisionPermission(new Map(), makeRow({ agentId: "agent-1", requestId: "req-gone" })),
    ).toBeNull();
  });
});

describe("resolveBoardActions", () => {
  it("takes behavior and variant from the live permission request", () => {
    const permission = makePermission({
      key: "agent-1:req-1",
      agentId: "agent-1",
      requestId: "req-1",
      actions: [
        { id: "allow-once", label: "Allow", behavior: "allow", variant: "primary" },
        { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
      ],
    });
    const row = makeRow({ agentId: "agent-1", requestId: "req-1" });

    expect(resolveBoardActions(row, permission)).toEqual([
      { id: "allow-once", label: "Allow", behavior: "allow", variant: "primary", primary: true },
      { id: "deny", label: "Deny", behavior: "deny", variant: "danger", primary: false },
    ]);
  });

  it("marks the first row action primary when the permission is gone", () => {
    const row = makeRow({ agentId: "agent-1", requestId: "req-1" });
    const actions = resolveBoardActions(row, null);

    expect(actions[0]?.primary).toBe(true);
    expect(actions[1]?.primary).toBe(false);
    expect(actions[0]?.behavior).toBe("allow");
  });

  it("keeps row order and passes through ids the request no longer lists", () => {
    const permission = makePermission({
      key: "agent-1:req-1",
      agentId: "agent-1",
      requestId: "req-1",
      actions: [{ id: "deny", label: "Deny", behavior: "deny" }],
    });
    const row = makeRow({ agentId: "agent-1", requestId: "req-1" });
    const actions = resolveBoardActions(row, permission);

    expect(actions.map((action) => action.id)).toEqual(["allow-once", "deny"]);
    expect(actions[0]?.behavior).toBe("allow");
    expect(actions[0]?.primary).toBe(true);
    expect(actions[1]?.behavior).toBe("deny");
  });

  it("renders nothing for a row with no actions", () => {
    const row = makeRow({ agentId: "agent-1", requestId: "req-1", actions: [] });
    expect(resolveBoardActions(row, null)).toEqual([]);
  });
});

describe("buildBoardActionResponse", () => {
  it("allows with the selected action id", () => {
    expect(buildBoardActionResponse({ id: "allow-once", behavior: "allow" })).toEqual({
      behavior: "allow",
      selectedActionId: "allow-once",
    });
  });

  it("denies with the selected action id and a message", () => {
    expect(buildBoardActionResponse({ id: "deny", behavior: "deny" })).toEqual({
      behavior: "deny",
      selectedActionId: "deny",
      message: "Denied by user",
    });
  });
});
