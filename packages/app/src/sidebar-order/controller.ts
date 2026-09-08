import equal from "fast-deep-equal";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  SidebarOrderDataSchema,
  SidebarOrderSnapshotSchema,
  type SidebarOrderChange,
  type SidebarOrderSnapshot,
} from "@getpaseo/protocol/messages";
import { createStore } from "zustand/vanilla";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import { renameOrderKey, type LocalOrderChange } from "./change";
import { mergeHostOrders, orderForHost, type LocalOrder } from "./projection";

export interface SidebarOrderClient extends Pick<
  DaemonClient,
  "getSidebarOrder" | "initializeSidebarOrder" | "updateSidebarOrder"
> {
  on(
    event: "sidebar.order.changed",
    listener: (message: { payload: SidebarOrderSnapshot }) => void,
  ): () => void;
}
export interface SidebarOrderPorts {
  storage: StateStorage;
  hydrateLocalOrder(): Promise<void>;
  getLocalOrder(): LocalOrder;
  applyOrder(order: LocalOrder): void;
  projects(): WorkspaceStructureProject[];
  visibleServerIds(): readonly string[];
}
export interface HostOrderState {
  status: "loading" | "online" | "offline" | "unsupported";
  snapshot: SidebarOrderSnapshot | null;
  pending: boolean;
  error: string | null;
  failedWrite?: { change: SidebarOrderChange; baseKeys: string[] };
}

export function createSidebarOrderController(ports: SidebarOrderPorts) {
  const useSidebarOrderSync = createStore<{ hosts: Record<string, HostOrderState> }>(() => ({
    hosts: {},
  }));
  interface OrderCache {
    snapshots: Record<string, SidebarOrderSnapshot>;
    importOrder: LocalOrder | null;
  }
  const cache = createStore<OrderCache>()(
    persist((): OrderCache => ({ snapshots: {}, importOrder: null }), {
      name: "sidebar-order-sync",
      storage: createValidatedPersistStorage(
        ports.storage,
        z.object({
          snapshots: z.record(z.string(), SidebarOrderSnapshotSchema),
          importOrder: SidebarOrderDataSchema.nullable(),
        }),
      ),
    }),
  );
  interface Connection {
    client: SidebarOrderClient;
    unsubscribe: () => void;
    latestRevision: number | null;
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
      await Promise.all([hydrated(cache.persist), ports.hydrateLocalOrder()]);
      if (!cache.getState().importOrder)
        cache.setState({
          importOrder: ports.getLocalOrder(),
        });
    })());
  }
  const projects = ports.projects;
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
    const visible = ports.visibleServerIds();
    const entries = Object.entries(hosts).filter(([id]) => !visible.length || visible.includes(id));
    const next = mergeHostOrders(
      Object.fromEntries(entries.map(([id, host]) => [id, host.snapshot])),
      cache.getState().importOrder!,
      projects(),
    );
    if (!equal(next, ports.getLocalOrder())) ports.applyOrder(next);
  }
  function accept(serverId: string, snapshot: SidebarOrderSnapshot): void {
    const connection = connections.get(serverId);
    if (!connection) return;
    if (connection.latestRevision !== null && connection.latestRevision > snapshot.revision) return;
    connection.latestRevision = snapshot.revision;
    cache.setState((state) => ({ snapshots: { ...state.snapshots, [serverId]: snapshot } }));
    publish(serverId, { snapshot });
    publishProjection();
  }
  function keysForChange(snapshot: SidebarOrderSnapshot, change: SidebarOrderChange): string[] {
    switch (change.kind) {
      case "groups":
        return snapshot.order.projectGroupOrder;
      case "projects":
        return snapshot.order.projectOrder;
      case "pins":
        return snapshot.order.pinnedWorkspaceOrder;
      case "workspaces":
        return snapshot.order.workspaceOrderByProject[change.projectId] ?? [];
    }
  }

  function needsRetry(
    snapshot: SidebarOrderSnapshot,
    failedWrite: NonNullable<HostOrderState["failedWrite"]>,
  ): boolean {
    const keys = keysForChange(snapshot, failedWrite.change);
    if (equal(keys, failedWrite.change.keys)) return false;
    if (!equal(keys, failedWrite.baseKeys))
      throw new Error(
        "Ordering changed on another device. Discard this failed change and reorder again.",
      );
    return true;
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
    for (const id of change.serverIds) {
      if (!hosts[id]) continue;
      const order = orderForHost(id, local, allProjects);
      const previous = hosts[id].snapshot?.order;
      const beforeOrder = orderForHost(id, original, allProjects);
      let wire: SidebarOrderChange;
      let before: string[] | undefined;
      switch (change.kind) {
        case "renameGroup": {
          if (
            hosts[id].status === "unsupported" ||
            !hosts[id].snapshot?.initialized ||
            !previous?.projectGroupOrder.includes(change.fromKey)
          )
            continue;
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

  const sidebarOrderSync = {
    async connect(serverId: string, client: SidebarOrderClient, supported: boolean): Promise<void> {
      this.disconnect(serverId);
      const connection: Connection = { client, unsubscribe: () => undefined, latestRevision: null };
      connections.set(serverId, connection);
      // COMPAT(sidebarOrderSync): added after v1.2.0; remove this host gate after 2027-03-08.
      if (!supported) {
        publish(serverId, { status: "unsupported" });
        publishProjection();
        return;
      }
      await prepare();
      if (connections.get(serverId) !== connection) return;
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
        publish(serverId, {
          status: "online",
          error: useSidebarOrderSync.getState().hosts[serverId]?.failedWrite
            ? useSidebarOrderSync.getState().hosts[serverId].error
            : null,
        });
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
        if (host.failedWrite)
          return "Retry or discard the failed sidebar change before rearranging this host.";
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
      if (!useSidebarOrderSync.getState().hosts[serverId]?.pending)
        publish(serverId, { error: null, failedWrite: undefined });
    },
    async retry(serverId: string): Promise<void> {
      const host = useSidebarOrderSync.getState().hosts[serverId];
      const failedWrite = host?.failedWrite;
      if (!failedWrite || host.pending) return;
      const connection = connections.get(serverId);
      if (!connection || host.status === "unsupported") {
        publish(serverId, {
          error: "Connect to the host and reload sidebar ordering before retrying.",
        });
        return;
      }
      publish(serverId, { pending: true });
      try {
        await this.refresh(serverId);
        if (connections.get(serverId) !== connection) return;
        const current = useSidebarOrderSync.getState().hosts[serverId];
        if (current.status !== "online" || !current.snapshot)
          throw new Error(current.error ?? "Could not reload sidebar ordering.");
        if (needsRetry(current.snapshot, failedWrite)) {
          const result = await connection.client.updateSidebarOrder(
            current.snapshot.revision,
            failedWrite.change,
          );
          if (connections.get(serverId) !== connection) return;
          if (result.snapshot) accept(serverId, result.snapshot);
          if (!result.accepted) throw new Error(result.error ?? "Could not save sidebar ordering.");
        }
        if (useSidebarOrderSync.getState().hosts[serverId]?.failedWrite === failedWrite)
          publish(serverId, { failedWrite: undefined, error: null });
      } catch (error) {
        if (connections.get(serverId) === connection)
          publish(serverId, { error: errorMessage(error) });
      } finally {
        if (connections.get(serverId) === connection) publish(serverId, { pending: false });
      }
    },
    async write(change: LocalOrderChange): Promise<void> {
      await prepare();
      const allProjects = projects();
      const original = ports.getLocalOrder();
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
          const failedWrite = {
            change: target.change,
            baseKeys: [...keysForChange(hosts[target.id].snapshot!, target.change)],
          };
          // Retain the intent across disconnects too; a retry first checks whether it already committed.
          publish(target.id, { failedWrite });
          try {
            const result = await connection.client.updateSidebarOrder(revision, target.change);
            if (connections.get(target.id) !== connection) return;
            if (result.snapshot) accept(target.id, result.snapshot);
            if (!result.accepted)
              throw new Error(result.error ?? "Could not save sidebar ordering.");
            if (useSidebarOrderSync.getState().hosts[target.id]?.failedWrite === failedWrite)
              publish(target.id, { failedWrite: undefined });
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

  return { sidebarOrderSync, state: useSidebarOrderSync, publishProjection };
}
