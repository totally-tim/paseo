import { canSnooze, type InboxCard } from "./lanes";
import { buildAnswers, parseQuestions } from "./question-form";
import type { PermissionRequest, PermissionResponse } from "./types";
import type { WebKeyEvent } from "./web";

export type KeyAction =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "open" }
  | { kind: "openAgent" }
  | { kind: "close" }
  | { kind: "markRead" }
  | { kind: "archive" }
  | { kind: "snooze" }
  | { kind: "help" }
  | { kind: "option"; index: number }
  | { kind: "allow" }
  | { kind: "deny" };

/** Maps an unmodified keypress outside a text field to a board action. */
export function keyToAction(
  event: Pick<WebKeyEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): KeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  // ? arrives with shiftKey true on US layouts, so it has to clear this cutoff
  // before the general Shift block below — everything else with shiftKey set
  // (Shift+Enter, Shift+ArrowUp/Down included) falls through to the browser
  // default instead of firing a board action.
  if (event.key === "?") return { kind: "help" };
  // CapsLock flips a letter's case without setting shiftKey, so o/O is decided
  // by shiftKey, not key case, ahead of the cutoff: CapsLock+Shift together
  // report the lowercase letter with shiftKey true, and that combination must
  // still resolve to openAgent rather than being swallowed as a plain Shift+o.
  if (event.key.toLowerCase() === "o")
    return event.shiftKey ? { kind: "openAgent" } : { kind: "open" };
  if (event.shiftKey) return null;
  switch (event.key) {
    case "ArrowDown":
      return { kind: "move", delta: 1 };
    case "ArrowUp":
      return { kind: "move", delta: -1 };
    case "Enter":
      return { kind: "open" };
    case "Escape":
      return { kind: "close" };
    default:
      break;
  }
  const lowerKey = event.key.toLowerCase();
  switch (lowerKey) {
    case "j":
      return { kind: "move", delta: 1 };
    case "k":
      return { kind: "move", delta: -1 };
    case "y":
      return { kind: "allow" };
    case "n":
      return { kind: "deny" };
    case "m":
      return { kind: "markRead" };
    case "x":
      return { kind: "archive" };
    case "s":
      return { kind: "snooze" };
    default: {
      if (/^[1-9]$/.test(event.key)) return { kind: "option", index: Number(event.key) - 1 };
      return null;
    }
  }
}

/**
 * A digit answers a card only when the answer is unambiguous: one question,
 * single-select, and the digit names an existing option. Anything else returns
 * null and the board opens the peek instead.
 */
export function optionResponse(card: InboxCard, index: number): PermissionResponse | null {
  if (card.reason !== "question" || !card.request) return null;
  const questions = parseQuestions(card.request.input);
  if (!questions || questions.length !== 1) return null;
  const [question] = questions;
  if (question.multiSelect || !question.options[index]) return null;
  const input =
    typeof card.request.input === "object" && card.request.input ? card.request.input : {};
  return {
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: buildAnswers(questions, new Map([[0, new Set([index])]]), new Map()),
    },
  };
}

export function permissionResponse(
  card: InboxCard,
  behavior: "allow" | "deny",
): PermissionResponse | null {
  if (card.reason !== "permission" || !card.request) return null;
  const action = card.request.actions?.find((candidate) => candidate.behavior === behavior);
  if (behavior === "allow") {
    return action ? { behavior: "allow", selectedActionId: action.id } : { behavior: "allow" };
  }
  return action
    ? { behavior: "deny", selectedActionId: action.id, message: "Denied from Inbox" }
    : { behavior: "deny", message: "Denied from Inbox" };
}

export interface BoardKeyState {
  ordered: readonly InboxCard[];
  focusedId: string | null;
  openCardId: string | null;
}

export type BoardKeyEffect =
  | { kind: "focus"; agentId: string | null }
  | { kind: "open"; agentId: string }
  | { kind: "openAgent"; agentId: string }
  | { kind: "close" }
  | { kind: "help" }
  | {
      kind: "respond";
      card: InboxCard;
      /** `resolveAnswer` only builds this effect when `focused.request` exists. */
      request: PermissionRequest;
      response: PermissionResponse;
      /** Where focus goes after answering, so it does not follow the card into Done. */
      nextFocusAgentId: string | null;
    }
  | { kind: "markRead"; card: InboxCard; nextFocusAgentId: string | null }
  | { kind: "archive"; card: InboxCard; nextFocusAgentId: string | null }
  | { kind: "snooze"; card: InboxCard; nextFocusAgentId: string | null }
  | null;

function nextIndex(length: number, current: number, delta: 1 | -1): number {
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}

/**
 * A card's neighbor within its own lane — never across lanes, so dismissing or
 * answering the last needs-you card does not throw focus into Working or Done.
 */
function laneNeighborId(card: InboxCard, ordered: readonly InboxCard[]): string | null {
  const laneCards = ordered.filter((candidate) => candidate.lane === card.lane);
  const laneIndex = laneCards.findIndex((candidate) => candidate.agent.id === card.agent.id);
  return (laneCards[laneIndex + 1] ?? laneCards[laneIndex - 1])?.agent.id ?? null;
}

/** Cards that leave their lane when dismissed keep focus on a same-lane neighbor. */
function dismissEffect(
  kind: "markRead" | "archive" | "snooze",
  focused: InboxCard | null,
  ordered: readonly InboxCard[],
): BoardKeyEffect {
  const lane = kind === "snooze" ? "needsYou" : "done";
  if (focused?.lane !== lane) return null;
  // On a host without requestedAt, a request card's stamp degrades to `since`
  // and would resurface on every broadcast — don't let `s` fire a snooze
  // that can't stick.
  if (kind === "snooze" && !canSnooze(focused)) return null;
  return { kind, card: focused, nextFocusAgentId: laneNeighborId(focused, ordered) };
}

function resolveAnswer(
  action: Extract<KeyAction, { kind: "option" | "allow" | "deny" }>,
  focused: InboxCard | null,
  nextFocusAgentId: string | null,
): BoardKeyEffect {
  const request = focused?.request;
  if (!focused || !request) return null;
  if (action.kind === "option") {
    const response = optionResponse(focused, action.index);
    return response
      ? { kind: "respond", card: focused, request, response, nextFocusAgentId }
      : { kind: "open", agentId: focused.agent.id };
  }
  const response = permissionResponse(focused, action.kind);
  return response ? { kind: "respond", card: focused, request, response, nextFocusAgentId } : null;
}

/** Turns a key action plus the board's current state into one effect. Pure, so it is testable. */
export function resolveKeyAction(action: KeyAction, state: BoardKeyState): BoardKeyEffect {
  const { ordered, focusedId, openCardId } = state;
  const focusedIndex = ordered.findIndex((card) => card.agent.id === focusedId);
  const focused = focusedIndex >= 0 ? ordered[focusedIndex] : null;
  switch (action.kind) {
    case "move": {
      if (ordered.length === 0) return null;
      const index = nextIndex(ordered.length, focusedIndex, action.delta);
      return { kind: "focus", agentId: ordered[index].agent.id };
    }
    case "open":
    case "openAgent": {
      const target = focused ?? ordered[0];
      if (!target) return null;
      return action.kind === "open"
        ? { kind: "open", agentId: target.agent.id }
        : { kind: "openAgent", agentId: target.subject.id };
    }
    case "close":
      return openCardId ? { kind: "close" } : { kind: "focus", agentId: null };
    case "help":
      return { kind: "help" };
    case "markRead":
    case "archive":
    case "snooze":
      return dismissEffect(action.kind, focused, ordered);
    default:
      return resolveAnswer(action, focused, focused ? laneNeighborId(focused, ordered) : null);
  }
}
