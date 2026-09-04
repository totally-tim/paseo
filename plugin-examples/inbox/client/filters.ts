import type { InboxCard, Lanes } from "./lanes";

export interface InboxFilters {
  projectId: string | null;
  projectGroup: string | null;
}

export const ALL_PROJECTS: InboxFilters = { projectId: null, projectGroup: null };

export function parseFilters(value: string | null): InboxFilters {
  if (!value) return ALL_PROJECTS;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Saved Kanban filters are invalid.");
  const input = parsed as Record<string, unknown>;
  if (
    !(input.projectId === null || typeof input.projectId === "string") ||
    !(input.projectGroup === null || typeof input.projectGroup === "string")
  )
    throw new Error("Saved Kanban filters are invalid.");
  return { projectId: input.projectId, projectGroup: input.projectGroup };
}

export function filterLanes(lanes: Lanes, filters: InboxFilters): Lanes {
  const matches = (card: InboxCard) =>
    (!filters.projectId || card.workspace?.projectId === filters.projectId) &&
    (filters.projectGroup === null ||
      (card.workspace?.projectGroup ?? "") === filters.projectGroup);
  return {
    needsYou: lanes.needsYou.filter(matches),
    working: lanes.working.filter(matches),
    done: lanes.done.filter(matches),
  };
}
