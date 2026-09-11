import { describe, expect, it, vi } from "vitest";
import { applyKeyEffect, type BoardKeyboardInput } from "./board";
import type { CardActions } from "./card";
import type { InboxCard } from "./lanes";
import type { Operation } from "./store";
import { archiveKey, readKey, responseKey } from "./store";
import type { PermissionRequest } from "./types";

function card(input: Partial<InboxCard> = {}): InboxCard {
  return {
    agent: { id: "a" },
    workspace: null,
    lane: "needsYou",
    reason: "question",
    request: null,
    subject: { id: "a" },
    members: [],
    subagentCount: 0,
    since: null,
    ...input,
  } as InboxCard;
}

const request = {
  id: "req_1",
  kind: "question",
  name: "AskUserQuestion",
  input: {},
} as unknown as PermissionRequest;

function fakeActions(overrides: Partial<CardActions> = {}): CardActions {
  return {
    canRespond: true,
    canArchive: true,
    canCheckout: false,
    active: true,
    drafts: new Map(),
    draftsReady: true,
    draftsError: null,
    onRetryDrafts: () => {},
    operations: new Map(),
    onDraft: () => {},
    onRespond: vi.fn().mockResolvedValue(true),
    onReply: () => {},
    onMarkRead: vi.fn().mockResolvedValue(true),
    onMarkAllRead: () => {},
    onArchive: vi.fn().mockResolvedValue(true),
    onSnooze: () => {},
    onUnsnooze: () => {},
    onOpen: () => {},
    ...overrides,
  } as CardActions;
}

function fakeInput(overrides: Partial<BoardKeyboardInput> = {}): BoardKeyboardInput {
  return {
    actions: fakeActions(),
    isActive: true,
    filtersOpen: false,
    helpOpen: false,
    keyboard: true,
    platform: "web",
    canRespond: true,
    canArchive: true,
    ordered: [],
    focusedId: "a",
    openCardId: null,
    interactionRevision: { current: 0 },
    setFocusedId: vi.fn(),
    setHelpOpen: vi.fn(),
    open: vi.fn(),
    closePeek: vi.fn(),
    ...overrides,
  } as BoardKeyboardInput;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("applyKeyEffect", () => {
  it("ignores a markRead effect while that card's read is already pending, without moving focus", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(true);
    const setFocusedId = vi.fn();
    const target = card({ lane: "done", reason: "finished" });
    const operations = new Map<string, Operation>([[readKey("a"), { status: "pending" }]]);
    const input = fakeInput({
      actions: fakeActions({ onMarkRead, operations }),
      setFocusedId,
    });
    applyKeyEffect({ kind: "markRead", card: target, nextFocusAgentId: "next" }, input);
    await flush();
    expect(onMarkRead).not.toHaveBeenCalled();
    expect(setFocusedId).not.toHaveBeenCalled();
  });

  it("ignores an archive effect while that card's archive is already pending, without moving focus", async () => {
    const onArchive = vi.fn().mockResolvedValue(true);
    const setFocusedId = vi.fn();
    const target = card({ lane: "done", reason: "finished" });
    const operations = new Map<string, Operation>([[archiveKey("a"), { status: "pending" }]]);
    const input = fakeInput({
      actions: fakeActions({ onArchive, operations }),
      setFocusedId,
    });
    applyKeyEffect({ kind: "archive", card: target, nextFocusAgentId: "next" }, input);
    await flush();
    expect(onArchive).not.toHaveBeenCalled();
    expect(setFocusedId).not.toHaveBeenCalled();
  });

  it("ignores a respond effect while that card's answer is already pending, without moving focus", async () => {
    const onRespond = vi.fn().mockResolvedValue(true);
    const setFocusedId = vi.fn();
    const target = card({ request });
    const operations = new Map<string, Operation>([
      [responseKey("a", "req_1"), { status: "pending" }],
    ]);
    const input = fakeInput({
      actions: fakeActions({ onRespond, operations }),
      setFocusedId,
    });
    applyKeyEffect(
      {
        kind: "respond",
        card: target,
        request,
        response: { behavior: "allow" },
        nextFocusAgentId: "next",
      },
      input,
    );
    await flush();
    expect(onRespond).not.toHaveBeenCalled();
    expect(setFocusedId).not.toHaveBeenCalled();
  });

  it("still dispatches markRead when no operation is pending for that key", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(true);
    const setFocusedId = vi.fn();
    const target = card({ lane: "done", reason: "finished" });
    const input = fakeInput({
      actions: fakeActions({ onMarkRead }),
      setFocusedId,
    });
    applyKeyEffect({ kind: "markRead", card: target, nextFocusAgentId: "next" }, input);
    await flush();
    expect(onMarkRead).toHaveBeenCalledWith("a");
    expect(setFocusedId).toHaveBeenCalledWith("next");
  });

  it("restores focus onto the card when the dispatched markRead genuinely resolves false", async () => {
    const onMarkRead = vi.fn().mockResolvedValue(false);
    const setFocusedId = vi.fn();
    const target = card({ lane: "done", reason: "finished" });
    const input = fakeInput({
      actions: fakeActions({ onMarkRead }),
      setFocusedId,
    });
    applyKeyEffect({ kind: "markRead", card: target, nextFocusAgentId: "next" }, input);
    await flush();
    expect(setFocusedId).toHaveBeenCalledWith("next");
    expect(setFocusedId).toHaveBeenLastCalledWith("a");
  });
});
