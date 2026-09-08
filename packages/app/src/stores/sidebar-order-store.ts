import type { SidebarOrderData } from "@getpaseo/protocol/messages";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

import { renameOrderKey, type LocalOrderChange } from "@/sidebar-order/change";
export { renameOrderKey, type LocalOrderChange } from "@/sidebar-order/change";
let orderWriter: ((change: LocalOrderChange) => void) | null = null;
export function setSidebarOrderWriter(writer: (change: LocalOrderChange) => void): void {
  orderWriter = writer;
}
/** Replica updates and automatic discovery never invoke user mutation handlers. */
export function applySidebarOrder(order: SidebarOrderData): void {
  useSidebarOrderStore.setState(order);
}

interface SidebarOrderStoreState {
  projectOrder: string[];
  /** Project group keys in the order the user arranged them; see `orderProjectGroups`. */
  projectGroupOrder: string[];
  pinnedWorkspaceOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
  getProjectOrder: () => string[];
  setProjectOrder: (keys: string[], serverIds?: readonly string[]) => void;
  getProjectGroupOrder: () => string[];
  setProjectGroupOrder: (keys: string[], serverIds?: readonly string[]) => void;
  /** A renamed group keeps its place: its entry moves to the new key. */
  renameProjectGroupOrderKey: (
    fromKey: string,
    toKey: string,
    serverIds?: readonly string[],
  ) => void;
  getPinnedWorkspaceOrder: () => string[];
  setPinnedWorkspaceOrder: (keys: string[], serverIds?: readonly string[]) => void;
  getWorkspaceOrder: (projectViewKey: string) => string[];
  setWorkspaceOrder: (
    projectViewKey: string,
    keys: string[],
    serverIds?: readonly string[],
  ) => void;
}

interface SidebarOrderPersistedState {
  projectOrder?: string[];
  projectGroupOrder?: string[];
  pinnedWorkspaceOrder?: string[];
  workspaceOrderByProject?: Record<string, string[]>;
  projectOrderByServerId?: Record<string, string[]>;
  workspaceOrderByServerAndProject?: Record<string, string[]>;
}

const StringArrayRecordSchema = z.record(z.string(), z.array(z.string()));
const SidebarOrderPersistedStateSchema = z.strictObject({
  projectOrder: z.array(z.string()).optional(),
  projectGroupOrder: z.array(z.string()).optional(),
  pinnedWorkspaceOrder: z.array(z.string()).optional(),
  workspaceOrderByProject: StringArrayRecordSchema.optional(),
  projectOrderByServerId: StringArrayRecordSchema.optional(),
  workspaceOrderByServerAndProject: StringArrayRecordSchema.optional(),
});

interface SidebarWorkspaceOrderScope {
  serverId: string;
  projectViewKey: string;
}

function normalizeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

function normalizeWorkspaceOrderByProject(
  workspaceOrderByProject: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [projectViewKey, order] of Object.entries(workspaceOrderByProject ?? {})) {
    const scope = projectViewKey.trim();
    if (!scope) continue;
    normalized[scope] = normalizeKeys(order);
  }
  return normalized;
}

function extractWorkspaceOrderScope(scopeKey: string): SidebarWorkspaceOrderScope | null {
  const separatorIndex = scopeKey.indexOf("::");
  if (separatorIndex < 0) return null;
  const serverId = scopeKey.slice(0, separatorIndex).trim();
  const projectViewKey = scopeKey.slice(separatorIndex + 2).trim();
  if (!serverId || !projectViewKey) return null;
  return { serverId, projectViewKey };
}

function normalizeLegacyWorkspaceKey(serverId: string, rawWorkspaceKey: string): string | null {
  const workspaceKey = rawWorkspaceKey.trim();
  if (!workspaceKey) return null;
  const serverPrefix = `${serverId}:`;
  return workspaceKey.startsWith(serverPrefix) ? workspaceKey : `${serverPrefix}${workspaceKey}`;
}

export function migrateSidebarOrderState(persistedState: unknown): {
  projectOrder: string[];
  projectGroupOrder: string[];
  pinnedWorkspaceOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
} {
  const result = SidebarOrderPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return {
      projectOrder: [],
      projectGroupOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
    };
  }
  const state: SidebarOrderPersistedState = result.data;

  const projectOrder = normalizeKeys(state.projectOrder ?? []);
  const seenProjects = new Set(projectOrder);
  for (const keys of Object.values(state.projectOrderByServerId ?? {})) {
    for (const key of normalizeKeys(keys)) {
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      projectOrder.push(key);
    }
  }

  const workspaceOrderByProject = normalizeWorkspaceOrderByProject(state.workspaceOrderByProject);
  for (const [scopeKey, order] of Object.entries(state.workspaceOrderByServerAndProject ?? {})) {
    const scope = extractWorkspaceOrderScope(scopeKey);
    if (!scope) continue;
    const existing = workspaceOrderByProject[scope.projectViewKey] ?? [];
    const merged = [...existing];
    const seen = new Set(merged);
    for (const key of order) {
      const workspaceKey = normalizeLegacyWorkspaceKey(scope.serverId, key);
      if (!workspaceKey || seen.has(workspaceKey)) continue;
      seen.add(workspaceKey);
      merged.push(workspaceKey);
    }
    workspaceOrderByProject[scope.projectViewKey] = merged;
  }

  return {
    projectOrder,
    projectGroupOrder: normalizeKeys(state.projectGroupOrder ?? []),
    pinnedWorkspaceOrder: normalizeKeys(state.pinnedWorkspaceOrder ?? []),
    workspaceOrderByProject,
  };
}

export const useSidebarOrderStore = create<SidebarOrderStoreState>()(
  persist(
    (set, get) => ({
      projectOrder: [],
      projectGroupOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
      getProjectOrder: () => get().projectOrder,
      setProjectOrder: (keys, serverIds = []) => {
        const normalized = normalizeKeys(keys);
        if (orderWriter) {
          orderWriter({ serverIds, kind: "projects", keys: normalized });
          return;
        }
        set({ projectOrder: normalized });
      },
      getProjectGroupOrder: () => get().projectGroupOrder,
      setProjectGroupOrder: (keys, serverIds = []) => {
        if (orderWriter) {
          orderWriter({ serverIds, kind: "groups", keys: normalizeKeys(keys) });
          return;
        }
        set({ projectGroupOrder: normalizeKeys(keys) });
      },
      renameProjectGroupOrderKey: (fromKey, toKey, serverIds = []) => {
        if (orderWriter) {
          orderWriter({ serverIds, kind: "renameGroup", fromKey, toKey });
          return;
        }
        get().setProjectGroupOrder(renameOrderKey(get().projectGroupOrder, fromKey, toKey));
      },
      getPinnedWorkspaceOrder: () => get().pinnedWorkspaceOrder,
      setPinnedWorkspaceOrder: (keys, serverIds = []) => {
        const normalized = normalizeKeys(keys);
        if (orderWriter) {
          orderWriter({ serverIds, kind: "pins", keys: normalized });
          return;
        }
        set({ pinnedWorkspaceOrder: normalized });
      },
      getWorkspaceOrder: (projectViewKey) => {
        const scope = projectViewKey.trim();
        if (!scope) return [];
        return get().workspaceOrderByProject[scope] ?? [];
      },
      setWorkspaceOrder: (projectViewKey, keys, serverIds = []) => {
        const scope = projectViewKey.trim();
        if (!scope) return;
        const normalized = normalizeKeys(keys);
        if (orderWriter) {
          orderWriter({ serverIds, kind: "workspaces", projectViewKey: scope, keys: normalized });
          return;
        }
        set((state) => ({
          workspaceOrderByProject: {
            ...state.workspaceOrderByProject,
            [scope]: normalized,
          },
        }));
      },
    }),
    {
      name: "sidebar-project-workspace-order",
      storage: createValidatedPersistStorage(AsyncStorage, SidebarOrderPersistedStateSchema),
      partialize: (state) => ({
        projectOrder: state.projectOrder,
        projectGroupOrder: state.projectGroupOrder,
        pinnedWorkspaceOrder: state.pinnedWorkspaceOrder,
        workspaceOrderByProject: state.workspaceOrderByProject,
      }),
      version: 1,
      migrate: migrateSidebarOrderState,
    },
  ),
);
