import type { CoordinatorBoardSnapshot } from "@getpaseo/protocol/messages";
import { create } from "zustand";

export interface HostCoordinatorBoards {
  /**
   * False until the host's first subscribe payload lands. Workspace seeding
   * waits on this so an enabled project's home never flashes a draft before the
   * board arrives; `markUnavailable` lifts the wait when the host cannot serve
   * boards at all.
   */
  hydrated: boolean;
  /** Board snapshots keyed by projectId. */
  boards: ReadonlyMap<string, CoordinatorBoardSnapshot>;
}

interface CoordinatorBoardStoreState {
  hosts: Record<string, HostCoordinatorBoards>;
  applySnapshots: (serverId: string, snapshots: readonly CoordinatorBoardSnapshot[]) => void;
  applyBoardChange: (serverId: string, snapshot: CoordinatorBoardSnapshot) => void;
  /** Mark the host hydrated with whatever boards are known (a failed subscription). */
  markUnavailable: (serverId: string) => void;
  clearHost: (serverId: string) => void;
}

const EMPTY_BOARDS: ReadonlyMap<string, CoordinatorBoardSnapshot> = new Map();

export const useCoordinatorBoardStore = create<CoordinatorBoardStoreState>((set) => ({
  hosts: {},

  applySnapshots: (serverId, snapshots) =>
    set((state) => {
      const boards = new Map<string, CoordinatorBoardSnapshot>();
      for (const snapshot of snapshots) {
        boards.set(snapshot.projectId, snapshot);
      }
      return { hosts: { ...state.hosts, [serverId]: { hydrated: true, boards } } };
    }),

  applyBoardChange: (serverId, snapshot) =>
    set((state) => {
      const host = state.hosts[serverId] ?? { hydrated: true, boards: EMPTY_BOARDS };
      const boards = new Map(host.boards);
      boards.set(snapshot.projectId, snapshot);
      return { hosts: { ...state.hosts, [serverId]: { ...host, boards } } };
    }),

  markUnavailable: (serverId) =>
    set((state) => {
      const host = state.hosts[serverId];
      if (host?.hydrated) {
        return {};
      }
      return {
        hosts: {
          ...state.hosts,
          [serverId]: { hydrated: true, boards: host?.boards ?? EMPTY_BOARDS },
        },
      };
    }),

  clearHost: (serverId) =>
    set((state) => {
      if (!(serverId in state.hosts)) {
        return {};
      }
      const next = { ...state.hosts };
      delete next[serverId];
      return { hosts: next };
    }),
}));

export function useCoordinatorBoardsHydrated(serverId: string | null | undefined): boolean {
  const key = serverId?.trim() ?? "";
  return useCoordinatorBoardStore((state) => state.hosts[key]?.hydrated ?? false);
}

export function useCoordinatorBoardSnapshot(
  serverId: string | null | undefined,
  projectId: string | null | undefined,
): CoordinatorBoardSnapshot | null {
  const serverKey = serverId?.trim() ?? "";
  const projectKey = projectId?.trim() ?? "";
  return useCoordinatorBoardStore((state) =>
    projectKey ? (state.hosts[serverKey]?.boards.get(projectKey) ?? null) : null,
  );
}
