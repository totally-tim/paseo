import type { CoordinatorProjectResult } from "@getpaseo/client/internal/daemon-client";
import type { ProjectCoordinatorState } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * What `coordinator.project.get` knows that the board snapshot does not: the
 * stored coordinator record (usage expectation, profiles, guard) and
 * `ciConfigured`, a fact about the repository rather than the coordinator. The
 * snapshot stays the source of truth for trust level and scope; this record
 * fills in the fields the pill and the setup sheet cannot read off it.
 */
export interface CoordinatorProjectRecord {
  /** Null when the host answered "no coordinator configured for this project". */
  coordinator: ProjectCoordinatorState | null;
  /** False when the project repository has no CI config; absent on older daemons. */
  ciConfigured?: boolean;
}

interface CoordinatorProjectStoreState {
  hosts: Record<string, ReadonlyMap<string, CoordinatorProjectRecord>>;
  /** Writes a `coordinator.project.*` response under the project it describes. */
  applyProjectResult: (
    serverId: string,
    projectId: string,
    result: CoordinatorProjectResult,
  ) => void;
  clearHost: (serverId: string) => void;
}

const EMPTY_RECORDS: ReadonlyMap<string, CoordinatorProjectRecord> = new Map();

export const useCoordinatorProjectStore = create<CoordinatorProjectStoreState>()((set) => ({
  hosts: {},

  applyProjectResult: (serverId, projectId, result) =>
    set((state) => {
      const records = new Map(state.hosts[serverId] ?? EMPTY_RECORDS);
      records.set(projectId, {
        coordinator: result.coordinator,
        ciConfigured: result.ciConfigured,
      });
      return { hosts: { ...state.hosts, [serverId]: records } };
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

export function useProjectCoordinatorRecord(
  serverId: string | null | undefined,
  projectId: string | null | undefined,
): CoordinatorProjectRecord | null {
  const serverKey = serverId?.trim() ?? "";
  const projectKey = projectId?.trim() ?? "";
  return useCoordinatorProjectStore((state) =>
    projectKey ? (state.hosts[serverKey]?.get(projectKey) ?? null) : null,
  );
}

const inflightRefreshes = new Map<string, Promise<CoordinatorProjectRecord | null>>();

/**
 * One `coordinator.project.get` per (host, project) in flight. Callers do not
 * await a record the store already holds — the setup sheet refreshes on open
 * either way, since `ciConfigured` is the answer to "does this repo have CI
 * right now" and a stale false would hide the note after the user adds CI.
 */
export function refreshProjectCoordinator(
  serverId: string,
  projectId: string,
): Promise<CoordinatorProjectRecord | null> {
  const key = `${serverId}:${projectId}`;
  const inflight = inflightRefreshes.get(key);
  if (inflight) {
    return inflight;
  }
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client ?? null;
  if (!client) {
    return Promise.resolve(null);
  }
  const request = client
    .getProjectCoordinator(projectId)
    .then((result) => {
      // A response that lands after the host dropped its client belongs to a dead
      // connection — writing it would resurrect a record `clearHost` removed and,
      // because refreshes skip projects that already have one, keep it stale.
      if (getHostRuntimeStore().getSnapshot(serverId)?.client !== client) {
        return null;
      }
      useCoordinatorProjectStore.getState().applyProjectResult(serverId, projectId, result);
      return useCoordinatorProjectStore.getState().hosts[serverId]?.get(projectId) ?? null;
    })
    .catch((error) => {
      console.warn("[Coordinator] Failed to read project coordinator", {
        serverId,
        projectId,
        error,
      });
      return null;
    })
    .finally(() => {
      inflightRefreshes.delete(key);
    });
  inflightRefreshes.set(key, request);
  return request;
}
