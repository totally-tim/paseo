import type { SidebarOrderData, SidebarOrderSnapshot } from "@getpaseo/protocol/messages";
import type { WorkspaceStructureProject } from "@/projects/workspace-structure";
import { projectGroupKey } from "@/project-groups/key";

export type LocalOrder = SidebarOrderData;
const unique = (keys: string[]) => [...new Set(keys)];
export function emptyOrder(): LocalOrder {
  return {
    projectOrder: [],
    projectGroupOrder: [],
    pinnedWorkspaceOrder: [],
    workspaceOrderByProject: {},
  };
}

/** Translate only at this boundary; the daemon never stores a client equivalence key. */
export function orderForHost(
  serverId: string,
  local: LocalOrder,
  projects: readonly WorkspaceStructureProject[],
): SidebarOrderData {
  const placements = projects.flatMap((project) =>
    project.hosts
      .filter((host) => host.serverId === serverId)
      .map((host) => ({ project, projectId: host.projectId })),
  );
  const ids = new Map(placements.map(({ project, projectId }) => [project.viewKey, projectId]));
  const groups = new Set(
    placements.flatMap(({ project }) => (project.group ? [projectGroupKey(project.group)] : [])),
  );
  const workspaceIds = (keys: string[]) =>
    keys
      .filter((key) => key.startsWith(`${serverId}:`))
      .map((key) => key.slice(serverId.length + 1));
  return {
    projectOrder: unique([
      ...local.projectOrder,
      ...placements.map(({ project }) => project.viewKey),
    ]).flatMap((key) => (ids.has(key) ? [ids.get(key)!] : [])),
    projectGroupOrder: unique([
      ...local.projectGroupOrder.filter((key) => groups.has(key)),
      ...[...groups].sort(),
    ]),
    pinnedWorkspaceOrder: workspaceIds(local.pinnedWorkspaceOrder),
    workspaceOrderByProject: Object.fromEntries(
      placements.map(({ project, projectId }) => [
        projectId,
        workspaceIds(
          unique([
            ...(local.workspaceOrderByProject[project.viewKey] ?? []),
            ...project.workspaceKeys,
          ]),
        ),
      ]),
    ),
  };
}

export function mergeHostOrders(
  hosts: Record<string, SidebarOrderSnapshot | null>,
  local: LocalOrder,
  projects: readonly WorkspaceStructureProject[],
): LocalOrder {
  const merged = emptyOrder();
  for (const serverId of Object.keys(hosts).sort()) {
    const snapshot = hosts[serverId];
    const order = snapshot?.initialized ? snapshot.order : orderForHost(serverId, local, projects);
    const views = new Map(
      projects.flatMap((project) =>
        project.hosts
          .filter((host) => host.serverId === serverId)
          .map((host) => [host.projectId, project.viewKey] as const),
      ),
    );
    merged.projectOrder.push(
      ...order.projectOrder.flatMap((id) => (views.has(id) ? [views.get(id)!] : [])),
    );
    merged.projectGroupOrder.push(...order.projectGroupOrder);
    merged.pinnedWorkspaceOrder.push(
      ...order.pinnedWorkspaceOrder.map((id) => `${serverId}:${id}`),
    );
    for (const [id, keys] of Object.entries(order.workspaceOrderByProject)) {
      const view = views.get(id);
      if (view)
        merged.workspaceOrderByProject[view] = unique([
          ...(merged.workspaceOrderByProject[view] ?? []),
          ...keys.map((key) => `${serverId}:${key}`),
        ]);
    }
  }
  return {
    ...merged,
    projectOrder: unique(merged.projectOrder),
    projectGroupOrder: unique(merged.projectGroupOrder),
    pinnedWorkspaceOrder: unique(merged.pinnedWorkspaceOrder),
  };
}
