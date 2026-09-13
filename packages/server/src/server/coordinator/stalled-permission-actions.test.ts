import { expect, it } from "vitest";
import { stalledPermissionActions } from "./stalled-permission-actions.js";

it("uses four canonical labels while retaining a provider's one-time answer", () => {
  const actions = stalledPermissionActions({
    id: "p",
    provider: "codex",
    name: "Bash",
    kind: "tool",
    actions: [
      {
        id: "remember",
        label: "Approve for this session",
        behavior: "allow",
        response: { behavior: "allow", updatedPermissions: [{ scope: "session" }] },
      },
      {
        id: "one-time",
        label: "Accept once",
        behavior: "allow",
        response: { behavior: "allow", updatedInput: { command: "npm test" } },
      },
      {
        id: "reject",
        label: "Reject command",
        behavior: "deny",
        response: { behavior: "deny", message: "Rejected" },
      },
    ],
  });
  expect(actions.map((action) => action.label)).toEqual([
    "Allow",
    "Deny",
    "Leave it",
    "Always allow this",
  ]);
  expect(actions[0]?.response).toEqual({
    behavior: "allow",
    selectedActionId: "one-time",
    updatedInput: { command: "npm test" },
  });
  expect(actions[1]?.response).toEqual({
    behavior: "deny",
    selectedActionId: "reject",
    message: "Rejected",
  });
});

it("requires opening the app when provider allow variants are ambiguous", () => {
  const actions = stalledPermissionActions({
    id: "p",
    provider: "codex",
    name: "Bash",
    kind: "tool",
    actions: [
      { id: "always", label: "Always approve", behavior: "allow" },
      { id: "edit", label: "Apply changes", behavior: "allow" },
    ],
  });
  expect(actions).toEqual([]);
});

it("does not map an ACP persistent-only approval to Allow", () => {
  expect(
    stalledPermissionActions({
      id: "p",
      provider: "acp",
      name: "Bash",
      kind: "tool",
      actions: [
        { id: "allow_always", label: "Always allow", behavior: "allow" },
        { id: "reject_once", label: "Reject once", behavior: "deny" },
      ],
    }),
  ).toEqual([]);
});

it("does not map a persistent rejection to Deny", () => {
  expect(
    stalledPermissionActions({
      id: "p",
      provider: "acp",
      name: "Bash",
      kind: "tool",
      actions: [
        { id: "allow_once", label: "Allow once", behavior: "allow" },
        { id: "reject_always", label: "Reject always", behavior: "deny" },
      ],
    }),
  ).toEqual([]);
});

it("retains generic one-request answers for providers with no explicit options", () => {
  const actions = stalledPermissionActions({
    id: "p",
    provider: "codex",
    name: "Bash",
    kind: "tool",
  });
  expect(actions[0]?.response).toEqual({ behavior: "allow" });
  expect(actions[1]?.response).toEqual({ behavior: "deny" });
});

it("trusts ACP option kind over an innocent Allow label", () => {
  expect(
    stalledPermissionActions({
      id: "p",
      provider: "acp",
      name: "Bash",
      kind: "tool",
      actions: [
        { id: "allow", label: "Allow", behavior: "allow" },
        { id: "deny", label: "Deny", behavior: "deny" },
      ],
      metadata: {
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    }),
  ).toEqual([]);
});

it("selects authoritative ACP one-time options even with arbitrary provider labels", () => {
  const actions = stalledPermissionActions({
    id: "p",
    provider: "acp",
    name: "Bash",
    kind: "tool",
    actions: [
      { id: "no-forever", label: "Remember no", behavior: "deny" },
      { id: "a", label: "Proceed", behavior: "allow" },
      { id: "b", label: "Stop", behavior: "deny" },
    ],
    metadata: {
      options: [
        { optionId: "no-forever", name: "Remember no", kind: "reject_always" },
        { optionId: "a", name: "Proceed", kind: "allow_once" },
        { optionId: "b", name: "Stop", kind: "reject_once" },
      ],
    },
  });
  expect(actions[0]?.response).toEqual({ behavior: "allow", selectedActionId: "a" });
  expect(actions[1]?.response).toEqual({ behavior: "deny", selectedActionId: "b" });
});

it("opens the app for questions instead of submitting an incomplete generic approval", () => {
  expect(
    stalledPermissionActions({
      id: "p",
      provider: "pi",
      name: "Question",
      kind: "question",
      input: { questions: [{ question: "Which branch?", options: ["main", "next"] }] },
    }),
  ).toEqual([]);
});
