import { filterLanes } from "./filters";
import type { CardReason, InboxCard, Lanes } from "./lanes";
import { isSnoozed, type InboxSnapshot } from "./store";

const EMPTY: Lanes = { needsYou: [], working: [], done: [] };

export interface BoardLanes extends Lanes {
  /** Needs-you cards the user dismissed until their wait state changes. */
  snoozed: InboxCard[];
}

/**
 * The lanes a board surface shows. Snoozed needs-you cards leave the review
 * queue and the lane list, but stay reachable through `snoozed`.
 */
export function boardLanes(snapshot: InboxSnapshot, workspaceId?: string): BoardLanes {
  let lanes: Lanes;
  if (!workspaceId) {
    lanes = snapshot.filtersReady ? filterLanes(snapshot.lanes, snapshot.filters) : EMPTY;
  } else {
    const matches = (card: InboxCard) => card.agent.workspaceId === workspaceId;
    lanes = {
      needsYou: snapshot.lanes.needsYou.filter(matches),
      working: snapshot.lanes.working.filter(matches),
      done: snapshot.lanes.done.filter(matches),
    };
  }
  return {
    ...lanes,
    needsYou: lanes.needsYou.filter((card) => !isSnoozed(card, snapshot.snoozed)),
    snoozed: lanes.needsYou.filter((card) => isSnoozed(card, snapshot.snoozed)),
  };
}

export function boardReady(snapshot: InboxSnapshot, workspaceId?: string): boolean {
  return (
    snapshot.loaded && snapshot.snoozedReady && (Boolean(workspaceId) || snapshot.filtersReady)
  );
}

export function filterNeedsYouReason(lanes: Lanes, reason: CardReason | null): Lanes {
  if (!reason) return lanes;
  return { ...lanes, needsYou: lanes.needsYou.filter((card) => card.reason === reason) };
}

export interface CardGroup {
  key: string;
  label: string;
  cards: InboxCard[];
}

/** Groups by project in first-appearance order, preserving the lane's sort. */
export function groupCardsByProject(cards: readonly InboxCard[]): CardGroup[] {
  const groups = new Map<string, CardGroup>();
  for (const card of cards) {
    const key = card.workspace?.projectId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: card.workspace?.projectDisplayName || "No project", cards: [] };
      groups.set(key, group);
    }
    group.cards.push(card);
  }
  return Array.from(groups.values());
}

/** Search the whole family so a matching child keeps its parent card and review actions. */
export function searchCards(cards: readonly InboxCard[], query: string): InboxCard[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...cards];
  const matches = (card: InboxCard) => {
    const text = [
      card.workspace?.projectDisplayName,
      card.workspace?.name,
      ...card.members.flatMap((member) => [member.title, member.provider, member.model]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  };
  return cards.filter(matches);
}

export function searchLanes(lanes: Lanes, query: string): Lanes {
  if (!query.trim()) return lanes;
  return {
    needsYou: searchCards(lanes.needsYou, query),
    working: searchCards(lanes.working, query),
    done: searchCards(lanes.done, query),
  };
}
