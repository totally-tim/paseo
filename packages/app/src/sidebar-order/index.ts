import equal from "fast-deep-equal";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  SidebarOrderDataSchema,
  SidebarOrderSnapshotSchema,
  type SidebarOrderChange,
  type SidebarOrderSnapshot,
} from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceStructureProjects } from "@/projects/workspace-structure";
import {
  applySidebarOrder,
  renameOrderKey,
  setSidebarOrderWriter,
  useSidebarOrderStore,
  type LocalOrderChange,
} from "@/stores/sidebar-order-store";
import { mergeHostOrders, orderForHost, type LocalOrder } from "./projection";

export interface HostOrderState {
  status: "loading" | "online" | "offline" | "unsupported";
  snapshot: SidebarOrderSnapshot | null;
  pending: boolean;
  error: string | null;
}
export const useSidebarOrderSync = create<{ hosts: Record<string, HostOrderState> }>(() => ({
  hosts: {},
}));
interface OrderCache {
  snapshots: Record<string, SidebarOrderSnapshot>;
  importOrder: LocalOrder | null;
}
const cache = create<OrderCache>()(
  persist((): OrderCache => ({ snapshots: {}, importOrder: null }), {
    name: "sidebar-order-sync",
    storage: createValidatedPersistStorage(
      AsyncStorage,
      z.object({
        snapshots: z.record(z.string(), SidebarOrderSnapshotSchema),
        importOrder: SidebarOrderDataSchema.nullable(),
      }),
    ),
  }),
);
interface Connection {
  client: DaemonClient;
  unsubscribe: () => void;
}
const connections = new Map<string, Connection>();
const offlineOwners = new Map<string, object>();

async function hydrated(store: {
  hasHydrated: () => boolean;
  onFinishHydration: (fn: () => void) => () => void;
}): Promise<void> {
  if (store.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = store.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}
let preparing: Promise<void> | null = null;
function prepare(): Promise<void> {
  return (preparing ??= (async () => {
    await Promise.all([hydrated(cache.persist), hydrated(useSidebarOrderStore.persist)]);
    if (!cache.getState().importOrder)
      cache.setState({
        importOrder: SidebarOrderDataSchema.parse(useSidebarOrderStore.getState()),
      });
  })());
}
function projects() {
  return buildWorkspaceStructureProjects({
    sessions: Object.entries(useSessionStore.getState().sessions).map(([serverId, session]) => ({
      serverId,
      projects: session.projects.values(),
      workspaces: session.workspaces.values(),
    })),
  });
}
function publish(serverId: string, patch: Partial<HostOrderState>): void {
  useSidebarOrderSync.setState((state) => ({
    hosts: {
      ...state.hosts,
      [serverId]: {
        ...(state.hosts[serverId] ?? {
          status: "offline",
          snapshot: cache.getState().snapshots[serverId] ?? null,
          pending: false,
          error: null,
        }),
        ...patch,
      },
    },
  }));
}
function publishProjection(): void {
  const hosts = useSidebarOrderSync.getState().hosts;
  if (!Object.keys(hosts).length || !cache.getState().importOrder) return;
  const next = mergeHostOrders(
    Object.fromEntries(Object.entries(hosts).map(([id, host]) => [id, host.snapshot])),
    cache.getState().importOrder!,
    projects(),
  );
  if (!equal(next, SidebarOrderDataSchema.parse(useSidebarOrderStore.getState())))
    applySidebarOrder(next);
}
function accept(serverId: string, snapshot: SidebarOrderSnapshot): void {
  const previous = useSidebarOrderSync.getState().hosts[serverId]?.snapshot;
  if (previous && previous.revision > snapshot.revision) return;
  cache.setState((state) => ({ snapshots: { ...state.snapshots, [serverId]: snapshot } }));
  publish(serverId, { snapshot });
  publishProjection();
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not sync sidebar ordering. Retry in sidebar settings.";
}

function planWrites(
  change: LocalOrderChange,
  original: LocalOrder,
  local: LocalOrder,
  allProjects: ReturnType<typeof projects>,
  hosts: Record<string, HostOrderState>,
) {
  const targets: Array<{ id: string; change: SidebarOrderChange }> = [];
  for (const id of Object.keys(hosts)) {
    const order = orderForHost(id, local, allProjects);
    const previous = hosts[id].snapshot?.order;
    const beforeOrder = orderForHost(id, original, allProjects);
    let wire: SidebarOrderChange;
    let before: string[] | undefined;
    switch (change.kind) {
      case "renameGroup": {
        if (!previous?.projectGroupOrder.includes(change.fromKey)) continue;
        wire = {
          kind: "groups",
          keys: renameOrderKey(previous.projectGroupOrder, change.fromKey, change.toKey),
        };
        before = previous.projectGroupOrder;
        break;
      }
      case "projects":
        wire = { kind: "projects", keys: order.projectOrder };
        before = beforeOrder.projectOrder;
        break;
      case "groups":
        wire = { kind: "groups", keys: order.projectGroupOrder };
        before = beforeOrder.projectGroupOrder;
        break;
      case "pins":
        wire = { kind: "pins", keys: order.pinnedWorkspaceOrder };
        before = beforeOrder.pinnedWorkspaceOrder;
        break;
      case "workspaces": {
        const placement = allProjects
          .find((project) => project.viewKey === change.projectViewKey)
          ?.hosts.find((host) => host.serverId === id);
        if (!placement) continue;
        wire = {
          kind: "workspaces",
          projectId: placement.projectId,
          keys: order.workspaceOrderByProject[placement.projectId] ?? [],
        };
        before = beforeOrder.workspaceOrderByProject[placement.projectId];
        break;
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(wire.keys)) targets.push({ id, change: wire });
  }
  return targets;
}

export const sidebarOrderSync = {
  async connect(serverId: string, client: DaemonClient, supported: boolean): Promise<void> {
    this.disconnect(serverId);
    const connection: Connection = { client, unsubscribe: () => undefined };
    connections.set(serverId, connection);
    await prepare();
    if (connections.get(serverId) !== connection) return;
    // COMPAT(sidebarOrderSync): added after v1.2.0; remove this host gate after 2027-03-08.
    if (!supported) {
      publish(serverId, { status: "unsupported" });
      publishProjection();
      return;
    }
    publish(serverId, { status: "loading" });
    connection.unsubscribe = client.on("sidebar.order.changed", (message) => {
      if (connections.get(serverId) === connection) accept(serverId, message.payload);
    });
    await this.refresh(serverId);
  },
  disconnect(serverId: string): void {
    connections.get(serverId)?.unsubscribe();
    connections.delete(serverId);
    publish(serverId, { status: "offline", pending: false });
    const owner = {};
    offlineOwners.set(serverId, owner);
    void prepare()
      .then(() => {
        if (connections.has(serverId) || offlineOwners.get(serverId) !== owner) return;
        publish(serverId, { snapshot: cache.getState().snapshots[serverId] ?? null });
        publishProjection();
        return undefined;
      })
      .catch((error) => {
        if (offlineOwners.get(serverId) === owner)
          publish(serverId, { error: errorMessage(error) });
      });
  },
  forget(serverId: string): void {
    this.disconnect(serverId);
    offlineOwners.delete(serverId);
    useSidebarOrderSync.setState((state) => {
      const hosts = { ...state.hosts };
      delete hosts[serverId];
      return { hosts };
    });
    publishProjection();
  },
  async refresh(serverId: string): Promise<void> {
    const connection = connections.get(serverId);
    if (!connection) return;
    try {
      const result = await connection.client.getSidebarOrder();
      if (connections.get(serverId) !== connection) return;
      if (!result.accepted || !result.snapshot)
        throw new Error(result.error ?? "Could not load sidebar ordering.");
      accept(serverId, result.snapshot);
      publish(serverId, { status: "online", error: null });
    } catch (error) {
      if (connections.get(serverId) === connection)
        publish(serverId, { status: "loading", error: errorMessage(error) });
    }
  },
  readiness(serverIds: readonly string[], allowUninitialized = false): string | null {
    for (const id of serverIds) {
      const host = useSidebarOrderSync.getState().hosts[id];
      if (host?.status === "unsupported") return "Update this host to sync sidebar ordering.";
      if (host?.status !== "online" || !connections.has(id))
        return "Connect to the host and reload sidebar ordering before rearranging.";
      if (host.pending) return "Wait for the current sidebar order to finish saving.";
      if (!allowUninitialized && !host.snapshot?.initialized)
        return "Use this device’s order in sidebar settings before rearranging.";
    }
    return null;
  },
  async initialize(serverId: string): Promise<void> {
    await prepare();
    const problem = this.readiness([serverId], true);
    if (problem) {
      publish(serverId, { error: problem });
      return;
    }
    const connection = connections.get(serverId)!;
    publish(serverId, { pending: true, error: null });
    try {
      const result = await connection.client.initializeSidebarOrder(
        orderForHost(serverId, cache.getState().importOrder!, projects()),
      );
      if (connections.get(serverId) !== connection) return;
      if (result.snapshot) accept(serverId, result.snapshot);
      if (!result.accepted) throw new Error(result.error ?? "Could not import sidebar ordering.");
    } catch (error) {
      if (connections.get(serverId) === connection)
        publish(serverId, { error: errorMessage(error) });
    } finally {
      if (connections.get(serverId) === connection) publish(serverId, { pending: false });
    }
  },
  dismiss(serverId: string): void {
    publish(serverId, { error: null });
  },
  async write(change: LocalOrderChange): Promise<void> {
    await prepare();
    const allProjects = projects();
    const original = SidebarOrderDataSchema.parse(useSidebarOrderStore.getState());
    const local = structuredClone(original);
    switch (change.kind) {
      case "renameGroup":
        break;
      case "projects":
        local.projectOrder = change.keys;
        break;
      case "groups":
        local.projectGroupOrder = change.keys;
        break;
      case "pins":
        local.pinnedWorkspaceOrder = change.keys;
        break;
      case "workspaces":
        local.workspaceOrderByProject[change.projectViewKey] = change.keys;
        break;
    }
    const hosts = useSidebarOrderSync.getState().hosts;
    const targets = planWrites(change, original, local, allProjects, hosts);
    const problem = this.readiness(targets.map((target) => target.id));
    if (problem) {
      for (const target of targets) publish(target.id, { error: problem });
      return;
    }
    // Preflight every affected host before starting any writes. Independent hosts commit separately.
    for (const target of targets) publish(target.id, { pending: true, error: null });
    await Promise.all(
      targets.map(async (target) => {
        const connection = connections.get(target.id)!;
        const revision = hosts[target.id].snapshot!.revision;
        try {
          const result = await connection.client.updateSidebarOrder(revision, target.change);
          if (connections.get(target.id) !== connection) return;
          if (result.snapshot) accept(target.id, result.snapshot);
          if (!result.accepted) throw new Error(result.error ?? "Could not save sidebar ordering.");
        } catch (error) {
          if (connections.get(target.id) === connection) {
            await this.refresh(target.id);
            if (connections.get(target.id) === connection)
              publish(target.id, { error: errorMessage(error) });
          }
        } finally {
          if (connections.get(target.id) === connection) publish(target.id, { pending: false });
        }
      }),
    );
  },
};
setSidebarOrderWriter((change) => {
  void sidebarOrderSync.write(change).catch((error) => {
    for (const id of Object.keys(useSidebarOrderSync.getState().hosts))
      publish(id, { error: errorMessage(error) });
  });
});
// Directory metadata changes can alter equivalence keys without changing the saved order.
useSessionStore.subscribe(
  (state) => Object.values(state.sessions).map((session) => [session.projects, session.workspaces]),
  () => publishProjection(),
  {
    equalityFn: (a, b) =>
      a.length === b.length && a.every((entry, i) => entry[0] === b[i][0] && entry[1] === b[i][1]),
  },
);
