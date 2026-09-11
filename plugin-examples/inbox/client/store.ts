import type { PluginClientStorage } from "@getpaseo/plugin/client";

import { ALL_PROJECTS, type InboxFilters, parseFilters } from "./filters";
import { type InboxCard, type Lanes, projectLanes, snoozeStamp } from "./lanes";
import type { Agent, PaseoApi, PermissionResponse, Workspace } from "./types";

export interface Operation {
  status: "pending" | "succeeded" | "failed";
  error?: string;
}

export const responseKey = (agentId: string, requestId: string) =>
  JSON.stringify(["answer", agentId, requestId]);
export const replyKey = (agentId: string) => JSON.stringify(["reply", agentId]);
export const readKey = (agentId: string) => JSON.stringify(["read", agentId]);
export const archiveKey = (agentId: string) => JSON.stringify(["archive", agentId]);
export const READ_ALL_KEY = JSON.stringify(["readAll"]);

/** Parses the stored snooze map: agentId -> the card `since` the user dismissed. */
export function parseSnoozed(value: string | null): Map<string, string> {
  if (!value) return new Map();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Saved snoozed cards are invalid.");
  const entries = Object.entries(parsed);
  if (entries.some(([, since]) => typeof since !== "string"))
    throw new Error("Saved snoozed cards are invalid.");
  return new Map(entries as [string, string][]);
}

export function isSnoozed(card: InboxCard, snoozed: ReadonlyMap<string, string>): boolean {
  return snoozed.get(card.agent.id) === snoozeStamp(card);
}

export function unsnoozedCards(
  cards: readonly InboxCard[],
  snoozed: ReadonlyMap<string, string>,
): InboxCard[] {
  return cards.filter((card) => !isSnoozed(card, snoozed));
}

export interface InboxSnapshot {
  agents: ReadonlyMap<string, Agent>;
  workspaces: ReadonlyMap<string, Workspace>;
  /** All workspaces on this host. Filtering never changes the sidebar badge. */
  lanes: Lanes;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  pendingOpenAgentId: string | null;
  drafts: ReadonlyMap<string, string>;
  draftsReady: boolean;
  draftsError: string | null;
  operations: ReadonlyMap<string, Operation>;
  filters: InboxFilters;
  filtersReady: boolean;
  filtersSaving: boolean;
  filtersError: string | null;
  snoozed: ReadonlyMap<string, string>;
  snoozedReady: boolean;
  snoozedError: string | null;
  snoozedLoadError: string | null;
}

export interface InboxStore {
  getSnapshot(): InboxSnapshot;
  subscribe(listener: () => void): () => void;
  getBadge(): number | null;
  requestOpen(agentId: string): void;
  clearPendingOpen(): void;
  retryLoad(): Promise<void>;
  setDraft(agentId: string, text: string): void;
  /** False means the action failed, is already running, or was already acknowledged. */
  respond(agentId: string, requestId: string, response: PermissionResponse): Promise<boolean>;
  sendReply(agentId: string): Promise<boolean>;
  markRead(agentId: string): Promise<boolean>;
  markAllRead(agentIds: readonly string[]): Promise<boolean>;
  archive(agentId: string): Promise<boolean>;
  snooze(card: InboxCard): void;
  unsnooze(agentId: string): void;
  setFilters(filters: InboxFilters): void;
  retryFilters(): void;
  retryDrafts(): void;
  retrySnoozed(): void;
  dispose(): void;
}

export const EMPTY_SNAPSHOT: InboxSnapshot = {
  agents: new Map(),
  workspaces: new Map(),
  lanes: { needsYou: [], working: [], done: [] },
  loaded: false,
  loading: true,
  loadError: null,
  pendingOpenAgentId: null,
  drafts: new Map(),
  draftsReady: false,
  draftsError: null,
  operations: new Map(),
  filters: ALL_PROJECTS,
  filtersReady: false,
  filtersSaving: false,
  filtersError: null,
  snoozed: new Map(),
  snoozedReady: false,
  snoozedError: null,
  snoozedLoadError: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One instance per host/plugin installation, including all retained surfaces and panels. */
export function createInboxStore(paseo: PaseoApi, storage?: PluginClientStorage): InboxStore {
  let snapshot: InboxSnapshot = { ...EMPTY_SNAPSHOT };
  const listeners = new Set<() => void>();
  let disposed = false;
  let loading: Promise<void> | null = null;
  const changedAgents = new Set<string>();
  const changedWorkspaces = new Set<string>();

  const publish = (patch: Partial<InboxSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    if (patch.agents || patch.workspaces || patch.operations) {
      const visible = Array.from(snapshot.agents.values(), (agent) => ({
        ...agent,
        pendingPermissions: agent.pendingPermissions.filter(
          (request) =>
            snapshot.operations.get(responseKey(agent.id, request.id))?.status !== "succeeded",
        ),
      }));
      snapshot.lanes = projectLanes(visible, snapshot.workspaces);
    }
    for (const listener of listeners) listener();
  };
  const setOperation = (key: string, operation: Operation) => {
    const operations = new Map(snapshot.operations);
    operations.set(key, operation);
    publish({ operations });
  };

  const unsubscribeAgents = paseo.agents.subscribe((update) => {
    const agents = new Map(snapshot.agents);
    const id = update.kind === "upsert" ? update.agent.id : update.agentId;
    changedAgents.add(id);
    if (update.kind === "upsert") agents.set(id, update.agent);
    else agents.delete(id);
    publish({ agents });
  });
  const unsubscribeWorkspaces = paseo.workspaces.subscribe((update) => {
    const workspaces = new Map(snapshot.workspaces);
    const id = update.kind === "upsert" ? update.workspace.id : update.id;
    changedWorkspaces.add(id);
    if (update.kind === "upsert") workspaces.set(id, update.workspace);
    else workspaces.delete(id);
    publish({ workspaces });
  });

  const loadAgents = async () => {
    const agents = new Map<string, Agent>();
    let cursor: string | undefined;
    for (;;) {
      const page = await paseo.agents.list({
        scope: "active",
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of page.entries) agents.set(entry.agent.id, entry.agent);
      const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      if (!next || disposed) return agents;
      cursor = next;
    }
  };
  const loadWorkspaces = async () => {
    const workspaces = new Map<string, Workspace>();
    let cursor: string | undefined;
    for (;;) {
      const page = await paseo.workspaces.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const workspace of page.entries) workspaces.set(workspace.id, workspace);
      const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      if (!next || disposed) return workspaces;
      cursor = next;
    }
  };
  const retryLoad = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (loading) return loading;
    changedAgents.clear();
    changedWorkspaces.clear();
    publish({ loading: true, loadError: null });
    loading = Promise.all([loadAgents(), loadWorkspaces()])
      .then(([agents, workspaces]) => {
        // Events received during a directory fetch are newer, including deletions.
        for (const id of changedAgents) {
          const agent = snapshot.agents.get(id);
          if (agent) agents.set(id, agent);
          else agents.delete(id);
        }
        for (const id of changedWorkspaces) {
          const workspace = snapshot.workspaces.get(id);
          if (workspace) workspaces.set(id, workspace);
          else workspaces.delete(id);
        }
        publish({ agents, workspaces, loaded: true, loading: false });
        return undefined;
      })
      .catch((error: unknown) => publish({ loading: false, loadError: errorMessage(error) }))
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  // Claim synchronously: React state cannot prevent two views from sending in one tick.
  const run = async (
    key: string,
    action: () => Promise<unknown>,
    once = false,
  ): Promise<boolean> => {
    if (disposed) return false;
    const status = snapshot.operations.get(key)?.status;
    if (status === "pending" || (once && status === "succeeded")) return false;
    setOperation(key, { status: "pending" });
    try {
      await action();
      if (disposed) return false;
      setOperation(key, { status: "succeeded" });
      return true;
    } catch (error) {
      setOperation(key, { status: "failed", error: errorMessage(error) });
      return false;
    }
  };

  let filterRevision = 0;
  const saveFilters = () => {
    if (disposed) return;
    if (!storage) return;
    const revision = ++filterRevision;
    const value = JSON.stringify(snapshot.filters);
    publish({ filtersSaving: true, filtersError: null });
    // A slow old selection must not overwrite a newer one.
    void storage
      .setItem("filters", value)
      .then(() => {
        if (revision === filterRevision) publish({ filtersSaving: false, filtersError: null });
        return undefined;
      })
      .catch((error: unknown) => {
        if (revision === filterRevision)
          publish({ filtersSaving: false, filtersError: errorMessage(error) });
      });
  };
  const loadFilters = () => {
    if (!storage) {
      publish({ filtersError: "Update the app to save Kanban filters." });
      return;
    }
    const revision = filterRevision;
    publish({ filtersError: null });
    void storage
      .getItem("filters")
      .then((value) => {
        if (revision === filterRevision)
          publish({ filters: parseFilters(value), filtersReady: true });
        return undefined;
      })
      .catch((error: unknown) => publish({ filtersError: errorMessage(error) }));
  };
  let snoozedRevision = 0;
  const saveSnoozed = () => {
    if (disposed || !storage) return;
    const revision = ++snoozedRevision;
    // Drop entries whose card left the lane; a stale stamp can never match again.
    const snoozed = new Map(snapshot.snoozed);
    for (const [agentId] of snoozed) {
      if (
        !snapshot.lanes.needsYou.some(
          (card) => card.agent.id === agentId && snoozeStamp(card) === snoozed.get(agentId),
        )
      )
        snoozed.delete(agentId);
    }
    void storage
      .setItem("snoozed", JSON.stringify(Object.fromEntries(snoozed)))
      .then(() => {
        if (revision === snoozedRevision) publish({ snoozedError: null, snoozedLoadError: null });
        return undefined;
      })
      .catch((error: unknown) => {
        if (revision === snoozedRevision) publish({ snoozedError: errorMessage(error) });
      });
  };
  const loadSnoozed = () => {
    if (!storage) {
      publish({ snoozedReady: true });
      return;
    }
    const revision = snoozedRevision;
    void storage
      .getItem("snoozed")
      .then((value) => {
        // A newer save already holds truth; still mark the load path ready so
        // the board does not wait on a gate that will never open.
        if (revision !== snoozedRevision) publish({ snoozedReady: true });
        else
          publish({
            snoozed: parseSnoozed(value),
            snoozedReady: true,
            snoozedError: null,
            snoozedLoadError: null,
          });
        return undefined;
      })
      .catch((error: unknown) =>
        publish({ snoozedReady: true, snoozedLoadError: errorMessage(error) }),
      );
  };

  let draftRevision = 0;
  const saveDrafts = () => {
    if (disposed) return;
    const revision = ++draftRevision;
    if (!storage) return;
    void storage
      .setItem("drafts", JSON.stringify(Object.fromEntries(snapshot.drafts)))
      .then(() => {
        if (revision === draftRevision) publish({ draftsError: null });
        return undefined;
      })
      .catch((error: unknown) => {
        if (revision === draftRevision) publish({ draftsError: errorMessage(error) });
      });
  };
  const loadDrafts = () => {
    if (!storage) {
      publish({ draftsReady: true });
      return;
    }
    const revision = draftRevision;
    void storage
      .getItem("drafts")
      .then((value) => {
        if (revision !== draftRevision) return undefined;
        const parsed: unknown = value ? JSON.parse(value) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Saved drafts are invalid.");
        const entries = Object.entries(parsed);
        if (entries.some(([, text]) => typeof text !== "string"))
          throw new Error("Saved drafts are invalid.");
        publish({
          drafts: new Map(entries as [string, string][]),
          draftsReady: true,
          draftsError: null,
        });
        return undefined;
      })
      .catch((error: unknown) => publish({ draftsError: errorMessage(error) }));
  };
  loadDrafts();
  loadFilters();
  loadSnoozed();
  void retryLoad();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getBadge: () => unsnoozedCards(snapshot.lanes.needsYou, snapshot.snoozed).length || null,
    requestOpen: (agentId) => publish({ pendingOpenAgentId: agentId }),
    clearPendingOpen() {
      if (snapshot.pendingOpenAgentId !== null) publish({ pendingOpenAgentId: null });
    },
    retryLoad,
    setDraft(agentId, text) {
      if (disposed) return;
      const drafts = new Map(snapshot.drafts);
      if (text) drafts.set(agentId, text);
      else drafts.delete(agentId);
      publish({ drafts, draftsReady: true });
      saveDrafts();
    },
    respond(agentId, requestId, response) {
      const key = responseKey(agentId, requestId);
      if (
        !snapshot.agents
          .get(agentId)
          ?.pendingPermissions.some((request) => request.id === requestId)
      )
        return Promise.resolve(false);
      return run(
        key,
        () => paseo.agents.ref(agentId).respondToPermission({ requestId, response }),
        true,
      );
    },
    async sendReply(agentId) {
      const draft = snapshot.drafts.get(agentId) ?? "";
      if (!draft.trim()) return false;
      const sent = await run(replyKey(agentId), () => paseo.agents.ref(agentId).send(draft.trim()));
      if (sent && snapshot.drafts.get(agentId) === draft) {
        const drafts = new Map(snapshot.drafts);
        drafts.delete(agentId);
        publish({ drafts });
        saveDrafts();
      }
      return sent;
    },
    markRead: (agentId) => run(readKey(agentId), () => paseo.agents.ref(agentId).clearAttention()),
    async markAllRead(agentIds) {
      // Per-card read keys show progress on each card; failures keep their own retry state.
      return run(READ_ALL_KEY, async () => {
        let failed = 0;
        for (const agentId of agentIds) {
          if (disposed) return;
          // A read already in flight will succeed on its own — don't count it.
          if (snapshot.operations.get(readKey(agentId))?.status === "pending") continue;
          if (!(await this.markRead(agentId))) failed += 1;
        }
        if (failed > 0) {
          throw new Error(`${failed} of ${agentIds.length} results could not be marked read.`);
        }
      });
    },
    archive: (agentId) => run(archiveKey(agentId), () => paseo.agents.ref(agentId).archive()),
    snooze(card) {
      if (disposed) return;
      const snoozed = new Map(snapshot.snoozed);
      snoozed.set(card.agent.id, snoozeStamp(card));
      publish({ snoozed });
      saveSnoozed();
    },
    unsnooze(agentId) {
      if (disposed || !snapshot.snoozed.has(agentId)) return;
      const snoozed = new Map(snapshot.snoozed);
      snoozed.delete(agentId);
      publish({ snoozed });
      saveSnoozed();
    },
    setFilters(filters) {
      if (disposed) return;
      publish({ filters, filtersReady: true });
      saveFilters();
    },
    retryDrafts() {
      if (snapshot.draftsReady) saveDrafts();
      else loadDrafts();
    },
    retryFilters() {
      if (snapshot.filtersReady) saveFilters();
      else loadFilters();
    },
    retrySnoozed() {
      // A failed save means the in-memory map is newer: write it again rather
      // than reloading a stale stored map over it. Otherwise reload.
      if (snapshot.snoozedError) saveSnoozed();
      else loadSnoozed();
    },
    dispose() {
      disposed = true;
      unsubscribeAgents();
      unsubscribeWorkspaces();
      listeners.clear();
    },
  };
}

let current: InboxStore | null = null;
export function setInboxStore(store: InboxStore | null): void {
  current = store;
}
export function getInboxStore(): InboxStore | null {
  return current;
}
