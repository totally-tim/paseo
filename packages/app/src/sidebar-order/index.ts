import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { SidebarOrderDataSchema } from "@getpaseo/protocol/messages";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useStore } from "zustand";
import { useSessionStore } from "@/stores/session-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";
import {
  applySidebarOrder,
  setSidebarOrderWriter,
  useSidebarOrderStore,
} from "@/stores/sidebar-order-store";
import { createSidebarOrderController } from "./controller";
export type { HostOrderState } from "./controller";
const controller = createSidebarOrderController({
  storage: AsyncStorage,
  visibleServerIds: () => useSidebarViewStore.getState().hostFilters,
  hydrateLocalOrder: async () => {
    if (useSidebarOrderStore.persist.hasHydrated()) return;
    await new Promise<void>((resolve) => {
      const unsubscribe = useSidebarOrderStore.persist.onFinishHydration(() => {
        unsubscribe();
        resolve();
      });
    });
  },
  getLocalOrder: () => SidebarOrderDataSchema.parse(useSidebarOrderStore.getState()),
  applyOrder: applySidebarOrder,
  projects: () =>
    buildWorkspaceStructureProjects({
      sessions: Object.entries(useSessionStore.getState().sessions).map(([serverId, session]) => ({
        serverId,
        projects: session.projects.values(),
        workspaces: session.workspaces.values(),
      })),
    }),
});
export const sidebarOrderSync = {
  ...controller.sidebarOrderSync,
  connect(serverId: string, client: DaemonClient, supported: boolean) {
    return controller.sidebarOrderSync.connect(
      serverId,
      {
        getSidebarOrder: (subscribe) => client.getSidebarOrder(subscribe),
        initializeSidebarOrder: (order) => client.initializeSidebarOrder(order),
        updateSidebarOrder: (revision, change) => client.updateSidebarOrder(revision, change),
        on: (_event, listener) => client.on("sidebar.order.changed", listener),
      },
      supported,
    );
  },
};
useSidebarViewStore.subscribe((state, previous) => {
  if (state.hostFilters !== previous.hostFilters) controller.publishProjection();
});
export function useSidebarOrderSync<T>(
  selector: (state: ReturnType<typeof controller.state.getState>) => T,
): T {
  return useStore(controller.state, selector);
}
setSidebarOrderWriter((change) => {
  void sidebarOrderSync.write(change).catch((error) => {
    const message = error instanceof Error ? error.message : "Could not sync sidebar ordering.";
    controller.state.setState((state) => {
      const hosts = { ...state.hosts };
      for (const id of change.serverIds) {
        if (hosts[id]) hosts[id] = { ...hosts[id], error: message };
      }
      return { hosts };
    });
  });
});
// Directory metadata changes can alter equivalence keys without changing the saved order.
useSessionStore.subscribe(
  (state) => Object.values(state.sessions).map((session) => [session.projects, session.workspaces]),
  () => controller.publishProjection(),
  {
    equalityFn: (a, b) =>
      a.length === b.length && a.every((entry, i) => entry[0] === b[i][0] && entry[1] === b[i][1]),
  },
);
