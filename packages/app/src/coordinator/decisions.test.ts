import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { CoordinatorDecisionBoardRow } from "@getpaseo/protocol/messages";
import type { PendingPermission } from "@/types/shared";
import {
  buildBoardActionResponse,
  buildComposerQuoteText,
  resolveBoardActions,
  resolveDecisionPermission,
} from "./decisions";

type WireAction = CoordinatorDecisionBoardRow["actions"][number];

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
  actions?: WireAction[];
  requestKind?: string;
  questionHeader?: string;
}): Pick<
  CoordinatorDecisionBoardRow,
  "agentId" | "requestId" | "actions" | "requestKind" | "questionHeader"
> {
  return {
    agentId: input.agentId,
    requestId: input.requestId,
    actions: input.actions ?? [
      { id: "allow-once", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    ...(input.requestKind ? { requestKind: input.requestKind } : {}),
    ...(input.questionHeader ? { questionHeader: input.questionHeader } : {}),
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
      {
        id: "allow-once",
        label: "Allow",
        behavior: "allow",
        variant: "primary",
        composerQuote: false,
        primary: true,
      },
      {
        id: "deny",
        label: "Deny",
        behavior: "deny",
        variant: "danger",
        composerQuote: false,
        primary: false,
      },
    ]);
  });

  it("marks the first row action primary when the permission is gone", () => {
    const row = makeRow({ agentId: "agent-1", requestId: "req-1" });
    const actions = resolveBoardActions(row, null);

    expect(actions[0]?.primary).toBe(true);
    expect(actions[1]?.primary).toBe(false);
    expect(actions[0]?.behavior).toBe("allow");
  });

  it("keeps a wire deny a deny when the live request is absent", () => {
    const row = makeRow({
      agentId: "agent-1",
      requestId: "req-1",
      actions: [
        { id: "allow-once", label: "Allow", behavior: "allow" },
        { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
      ],
    });
    const actions = resolveBoardActions(row, null);

    expect(actions[1]?.behavior).toBe("deny");
    expect(actions[1]?.variant).toBe("danger");
  });

  it("lets the live request override wire metadata but never silently allow a wire deny", () => {
    const permission = makePermission({
      key: "agent-1:req-1",
      agentId: "agent-1",
      requestId: "req-1",
      actions: [{ id: "deny", label: "Deny", behavior: "deny", variant: "secondary" }],
    });
    const row = makeRow({
      agentId: "agent-1",
      requestId: "req-1",
      actions: [
        { id: "allow-once", label: "Allow", behavior: "deny" },
        { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
      ],
    });
    const actions = resolveBoardActions(row, permission);

    // The live request lists only "deny", so the wire-only action keeps its own
    // behavior — a wire deny stays a deny.
    expect(actions[0]?.behavior).toBe("deny");
    expect(actions[1]?.behavior).toBe("deny");
    expect(actions[1]?.variant).toBe("secondary");
  });

  it("carries the wire composerQuote flag", () => {
    const row = makeRow({
      agentId: "agent-1",
      requestId: "req-1",
      actions: [
        { id: "yes", label: "Yes" },
        { id: "correct", label: "Correct it", composerQuote: true },
      ],
    });
    const actions = resolveBoardActions(row, null);

    expect(actions[0]?.composerQuote).toBe(false);
    expect(actions[1]?.composerQuote).toBe(true);
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
    expect(
      buildBoardActionResponse(makeRow({ agentId: "agent-1", requestId: "req-1" }), {
        id: "allow-once",
        label: "Allow",
        behavior: "allow",
      }),
    ).toEqual({
      behavior: "allow",
      selectedActionId: "allow-once",
    });
  });

  it("denies with the selected action id and a message", () => {
    expect(
      buildBoardActionResponse(makeRow({ agentId: "agent-1", requestId: "req-1" }), {
        id: "deny",
        label: "Deny",
        behavior: "deny",
      }),
    ).toEqual({
      behavior: "deny",
      selectedActionId: "deny",
      message: "Denied by user",
    });
  });

  it("answers a question-kind row with the option label under the question header", () => {
    const row = makeRow({
      agentId: "agent-1",
      requestId: "req-1",
      requestKind: "question",
      questionHeader: "Which scope?",
    });

    expect(
      buildBoardActionResponse(row, { id: "opt-1", label: "Staging", behavior: "allow" }),
    ).toEqual({
      behavior: "allow",
      updatedInput: { answers: { "Which scope?": "Staging" } },
    });
  });

  it("still denies a question-kind row when the chosen action is a deny", () => {
    const row = makeRow({
      agentId: "agent-1",
      requestId: "req-1",
      requestKind: "question",
      questionHeader: "Which scope?",
    });

    expect(
      buildBoardActionResponse(row, { id: "dismiss", label: "Dismiss", behavior: "deny" }),
    ).toEqual({
      behavior: "deny",
      selectedActionId: "dismiss",
      message: "Denied by user",
    });
  });
});

describe("buildComposerQuoteText", () => {
  it("quotes each line and leaves a blank line for the correction", () => {
    expect(buildComposerQuoteText("Ship it?\nTo production?")).toBe(
      "> Ship it?\n> To production?\n\n",
    );
  });

  it("keeps blank lines as bare quote markers", () => {
    expect(buildComposerQuoteText("First\n\nSecond")).toBe("> First\n>\n> Second\n\n");
  });
});
