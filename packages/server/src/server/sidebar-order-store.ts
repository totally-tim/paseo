import { promises as fs } from "node:fs";
import {
  SidebarOrderSnapshotSchema,
  type SidebarOrderSnapshot,
  type SidebarOrderData,
  type SidebarOrderChange,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "./atomic-file.js";

export class SidebarOrderStore {
  private state: SidebarOrderSnapshot = {
    revision: 0,
    initialized: false,
    order: {
      projectOrder: [],
      projectGroupOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
    },
  };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(snapshot: SidebarOrderSnapshot) => void>();
  constructor(private readonly filePath: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (!this.loaded) {
        try {
          this.state = SidebarOrderSnapshotSchema.parse(
            JSON.parse(await fs.readFile(this.filePath, "utf8")),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.loaded = true;
      }
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  get(): Promise<SidebarOrderSnapshot> {
    return this.serialize(async () => structuredClone(this.state));
  }
  subscribe(listener: (snapshot: SidebarOrderSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  initialize(order: SidebarOrderData) {
    return this.serialize(async () => {
      if (this.state.initialized)
        return this.result(
          false,
          "Ordering has already been imported. The shared order has been loaded.",
        );
      await this.commit(order);
      return this.result(true, null);
    });
  }
  update(expectedRevision: number, change: SidebarOrderChange) {
    return this.serialize(async () => {
      if (!this.state.initialized)
        return this.result(false, "Import this device's order in sidebar settings first.");
      if (expectedRevision !== this.state.revision)
        return this.result(
          false,
          "Ordering changed on another device. Review the updated order and retry.",
        );
      const order = structuredClone(this.state.order);
      switch (change.kind) {
        case "projects":
          order.projectOrder = change.keys;
          break;
        case "groups":
          order.projectGroupOrder = change.keys;
          break;
        case "pins":
          order.pinnedWorkspaceOrder = change.keys;
          break;
        case "workspaces":
          order.workspaceOrderByProject[change.projectId] = change.keys;
          break;
      }
      await this.commit(order);
      return this.result(true, null);
    });
  }
  private result(accepted: boolean, error: string | null) {
    return { accepted, error, snapshot: structuredClone(this.state) };
  }
  private async commit(order: SidebarOrderData): Promise<void> {
    const unique = (keys: string[]) => [...new Set(keys.filter((key) => key.length > 0))];
    const next: SidebarOrderSnapshot = {
      revision: this.state.revision + 1,
      initialized: true,
      order: {
        projectOrder: unique(order.projectOrder),
        projectGroupOrder: unique(order.projectGroupOrder),
        pinnedWorkspaceOrder: unique(order.pinnedWorkspaceOrder),
        workspaceOrderByProject: Object.fromEntries(
          Object.entries(order.workspaceOrderByProject).map(([key, keys]) => [key, unique(keys)]),
        ),
      },
    };
    await writeJsonFileAtomic(this.filePath, next);
    this.state = next;
    for (const listener of this.listeners) listener(structuredClone(next));
  }
}
