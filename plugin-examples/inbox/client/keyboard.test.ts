import { describe, expect, it } from "vitest";
import { keyToAction, optionResponse, permissionResponse, resolveKeyAction } from "./keyboard";
import type { InboxCard } from "./lanes";
import type { WebKeyEvent } from "./web";

function keyEvent(
  key: string,
  overrides: Partial<Omit<WebKeyEvent, "key">> = {},
): Pick<WebKeyEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides };
}

function card(input: Partial<InboxCard>): InboxCard {
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

describe("keyToAction", () => {
  it("maps plain keys and ignores modifiers", () => {
    expect(keyToAction(keyEvent("j"))).toEqual({ kind: "move", delta: 1 });
    expect(keyToAction(keyEvent("3"))).toEqual({ kind: "option", index: 2 });
    expect(keyToAction(keyEvent("k", { metaKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("x"))).toEqual({ kind: "archive" });
    expect(keyToAction(keyEvent("s"))).toEqual({ kind: "snooze" });
    expect(keyToAction(keyEvent("m"))).toEqual({ kind: "markRead" });
    expect(keyToAction(keyEvent("?"))).toEqual({ kind: "help" });
  });

  it("tolerates CapsLock: an uppercase letter with shiftKey false still maps", () => {
    // CapsLock flips the reported key's case without setting shiftKey.
    expect(keyToAction(keyEvent("J"))).toEqual({ kind: "move", delta: 1 });
    expect(keyToAction(keyEvent("X"))).toEqual({ kind: "archive" });
  });

  it("uses shiftKey, not key case, to tell O (openAgent) from o (open)", () => {
    expect(keyToAction(keyEvent("o"))).toEqual({ kind: "open" });
    // CapsLock+Shift together report the lowercase letter with shiftKey true.
    expect(keyToAction(keyEvent("o", { shiftKey: true }))).toEqual({ kind: "openAgent" });
  });

  it("ignores Shift+<letter> for every shortcut except O, so it does not fire destructive actions", () => {
    expect(keyToAction(keyEvent("X", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("s", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("n", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("m", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("y", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("j", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("k", { shiftKey: true }))).toBeNull();
  });

  it("ignores Shift+Enter and Shift+ArrowUp/Down so the browser default runs instead", () => {
    expect(keyToAction(keyEvent("Enter", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("ArrowUp", { shiftKey: true }))).toBeNull();
    expect(keyToAction(keyEvent("ArrowDown", { shiftKey: true }))).toBeNull();
  });

  it("keeps ? working even though it arrives with shiftKey true on US layouts", () => {
    expect(keyToAction(keyEvent("?", { shiftKey: true }))).toEqual({ kind: "help" });
  });
});

describe("optionResponse", () => {
  const request = {
    id: "p",
    kind: "question",
    input: {
      questions: [
        { question: "Which?", header: "Lane", options: [{ label: "A" }, { label: "B" }] },
      ],
    },
  } as unknown as InboxCard["request"];

  it("answers a single-select single question by option index", () => {
    expect(optionResponse(card({ request }), 1)).toEqual({
      behavior: "allow",
      updatedInput: { ...request!.input, answers: { Lane: "B" } },
    });
  });

  it("refuses when the digit has no option or the question is multi-select", () => {
    expect(optionResponse(card({ request }), 5)).toBeNull();
    const multi = {
      ...request!,
      input: {
        questions: [
          { question: "Which?", header: "Lane", options: [{ label: "A" }], multiSelect: true },
        ],
      },
    } as unknown as InboxCard["request"];
    expect(optionResponse(card({ request: multi }), 0)).toBeNull();
  });
});

describe("permissionResponse", () => {
  it("uses the request's own actions when present", () => {
    const request = {
      id: "p",
      kind: "tool",
      actions: [
        { id: "ok", label: "Allow", behavior: "allow" },
        { id: "no", label: "Deny", behavior: "deny" },
      ],
    } as unknown as InboxCard["request"];
    expect(permissionResponse(card({ reason: "permission", request }), "allow")).toEqual({
      behavior: "allow",
      selectedActionId: "ok",
    });
    expect(permissionResponse(card({ reason: "permission", request }), "deny")).toMatchObject({
      behavior: "deny",
      selectedActionId: "no",
    });
    expect(permissionResponse(card({ reason: "question", request }), "allow")).toBeNull();
  });
});

describe("resolveKeyAction", () => {
  const ordered = [card({ agent: { id: "a" } } as never), card({ agent: { id: "b" } } as never)];

  it("moves focus with wraparound and starts from the ends", () => {
    expect(
      resolveKeyAction({ kind: "move", delta: 1 }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "focus", agentId: "a" });
    expect(
      resolveKeyAction({ kind: "move", delta: -1 }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "focus", agentId: "b" });
    expect(
      resolveKeyAction({ kind: "move", delta: 1 }, { ordered, focusedId: "b", openCardId: null }),
    ).toEqual({ kind: "focus", agentId: "a" });
  });

  it("opens the focused card or the first one, and Escape closes before it unfocuses", () => {
    expect(
      resolveKeyAction({ kind: "open" }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "open", agentId: "a" });
    expect(
      resolveKeyAction({ kind: "close" }, { ordered, focusedId: "a", openCardId: "a" }),
    ).toEqual({ kind: "close" });
    expect(
      resolveKeyAction({ kind: "close" }, { ordered, focusedId: "a", openCardId: null }),
    ).toEqual({ kind: "focus", agentId: null });
  });
});

describe("resolveKeyAction respond", () => {
  const request = { id: "p", kind: "tool", actions: [] } as unknown as InboxCard["request"];
  const ordered = [
    card({ agent: { id: "a" }, reason: "permission", request } as never),
    card({ agent: { id: "b" } } as never),
  ];

  it("moves focus to the next card after answering", () => {
    const effect = resolveKeyAction(
      { kind: "allow" },
      { ordered, focusedId: "a", openCardId: null },
    );
    expect(effect).toMatchObject({ kind: "respond", nextFocusAgentId: "b" });
  });

  it("does not hand focus to a working card when it is the only needs-you card left", () => {
    const workingCard = card({ agent: { id: "w" }, lane: "working", reason: "working" } as never);
    const soloOrdered = [
      card({ agent: { id: "a" }, reason: "permission", request } as never),
      workingCard,
    ];
    const effect = resolveKeyAction(
      { kind: "allow" },
      { ordered: soloOrdered, focusedId: "a", openCardId: null },
    );
    expect(effect).toMatchObject({ kind: "respond", nextFocusAgentId: null });
  });
});

describe("resolveKeyAction card commands", () => {
  const doneA = card({ agent: { id: "a" }, lane: "done", reason: "finished" } as never);
  const doneC = card({ agent: { id: "c" }, lane: "done", reason: "finished" } as never);
  const waiting = card({
    agent: { id: "b" },
    // A stable attentionTimestamp keeps this error card's snooze stamp from
    // degrading to `since` — see canSnooze in lanes.ts.
    subject: { id: "b", attentionTimestamp: "2026-09-04T09:00:00.000Z" },
    lane: "needsYou",
    reason: "error",
  } as never);
  const ordered = [doneA, waiting, doneC];

  it("marks read and archives only done cards, moving focus to the next same-lane card", () => {
    for (const kind of ["markRead", "archive"] as const) {
      expect(
        resolveKeyAction({ kind }, { ordered, focusedId: "a", openCardId: null }),
      ).toMatchObject({ kind, nextFocusAgentId: "c" });
      expect(resolveKeyAction({ kind }, { ordered, focusedId: "b", openCardId: null })).toBeNull();
    }
  });

  it("does not cross lanes when dismissing the only card left in its lane", () => {
    // "a" is the only done card once "c" is out of the ordered list.
    const onlyOneDone = [doneA, waiting];
    expect(
      resolveKeyAction(
        { kind: "markRead" },
        { ordered: onlyOneDone, focusedId: "a", openCardId: null },
      ),
    ).toMatchObject({ kind: "markRead", nextFocusAgentId: null });
  });

  it("snoozes only needs-you cards", () => {
    // "b" is the only needs-you card, so no same-lane neighbor exists to focus.
    expect(
      resolveKeyAction({ kind: "snooze" }, { ordered, focusedId: "b", openCardId: null }),
    ).toMatchObject({ kind: "snooze", nextFocusAgentId: null });
    expect(
      resolveKeyAction({ kind: "snooze" }, { ordered, focusedId: "a", openCardId: null }),
    ).toBeNull();
  });

  it("does not snooze a needs-you card whose stamp can't survive a broadcast", () => {
    // A question/permission card with no requestedAt degrades to `since`,
    // which moves on every unrelated broadcast; firing a snooze that can
    // never stick would just look broken.
    const unstamped = card({
      agent: { id: "d" },
      subject: { id: "d" },
      lane: "needsYou",
      reason: "question",
      request: { id: "p", kind: "question" } as unknown as InboxCard["request"],
    } as never);
    expect(
      resolveKeyAction(
        { kind: "snooze" },
        { ordered: [...ordered, unstamped], focusedId: "d", openCardId: null },
      ),
    ).toBeNull();
  });

  it("opens the focused card's agent and shows help", () => {
    expect(
      resolveKeyAction({ kind: "openAgent" }, { ordered, focusedId: "b", openCardId: null }),
    ).toEqual({ kind: "openAgent", agentId: "b" });
    expect(
      resolveKeyAction({ kind: "openAgent" }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "openAgent", agentId: "a" });
    expect(
      resolveKeyAction({ kind: "help" }, { ordered, focusedId: null, openCardId: null }),
    ).toEqual({ kind: "help" });
  });
});
