import { filterLanes } from "./filters";
import type { InboxCard, Lanes } from "./lanes";
import type { InboxSnapshot } from "./store";

const EMPTY: Lanes = { needsYou: [], working: [], done: [] };

/** A global review must wait for its saved scope; a workspace panel already has an explicit scope. */
export function boardLanes(snapshot: InboxSnapshot, workspaceId?: string): Lanes {
  if (!workspaceId)
    return snapshot.filtersReady ? filterLanes(snapshot.lanes, snapshot.filters) : EMPTY;
  const matches = (card: InboxCard) => card.agent.workspaceId === workspaceId;
  return {
    needsYou: snapshot.lanes.needsYou.filter(matches),
    working: snapshot.lanes.working.filter(matches),
    done: snapshot.lanes.done.filter(matches),
  };
}

export function boardReady(snapshot: InboxSnapshot, workspaceId?: string): boolean {
  return snapshot.loaded && (Boolean(workspaceId) || snapshot.filtersReady);
}

/** Search the whole family so a matching child keeps its parent card and review actions. */
export function searchLanes(lanes: Lanes, query: string): Lanes {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return lanes;
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
  return {
    needsYou: lanes.needsYou.filter(matches),
    working: lanes.working.filter(matches),
    done: lanes.done.filter(matches),
  };
}
