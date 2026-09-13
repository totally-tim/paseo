import type { ProjectDescriptor } from "@/stores/session-store";
import type { CoordinatorBoardSnapshot } from "@getpaseo/protocol/messages";

export interface GlobalBoardProjectOption {
  projectId: string;
  projectName: string;
}

/** Projects awaiting a coordinator still need a filter entry for their setup proposal. */
export function globalBoardProjectOptions(
  projects: Iterable<
    Pick<ProjectDescriptor, "projectId" | "projectDisplayName" | "projectCustomName" | "hidden">
  >,
): GlobalBoardProjectOption[] {
  return [...projects]
    .filter((project) => !project.hidden)
    .map((project) => ({
      projectId: project.projectId,
      projectName: project.projectCustomName ?? project.projectDisplayName,
    }))
    .sort(
      (a, b) =>
        a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId),
    );
}

/** Filtering changes the rows, never the session receiving the global composer. */
export function projectGlobalBoard(
  snapshots: Iterable<CoordinatorBoardSnapshot>,
  globalBoard: CoordinatorBoardSnapshot,
  projectId: string | null,
): { board: CoordinatorBoardSnapshot; groups: CoordinatorBoardSnapshot[] } {
  const enabledBoards = [...snapshots].filter((board) => board.enabled);
  const groups = enabledBoards
    .filter((board) => !projectId || board.projectId === projectId)
    .sort((a, b) => (a.projectName ?? a.projectId).localeCompare(b.projectName ?? b.projectId));
  return {
    board: {
      ...globalBoard,
      needsYou: enabledBoards
        .flatMap((group) => group.needsYou)
        .filter((row) => !projectId || (row.setupProjectId ?? row.projectId) === projectId)
        .sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id)),
      working: groups.flatMap((group) => group.working),
      done: groups.flatMap((group) => group.done),
    },
    groups,
  };
}
