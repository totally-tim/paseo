import type { PluginClientStorage } from "@getpaseo/plugin/client";

import { ALL_PROJECTS, type InboxFilters, parseFilters } from "./filters";
import { canSnooze, type InboxCard, type Lanes, projectLanes, snoozeStamp } from "./lanes";
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

/** Mark-all-read's concurrency cap: enough to feel instant, not enough to flood the daemon. */
const MARK_ALL_READ_CONCURRENCY = 4;

/**
 * Runs `worker` over `items` with at most `limit` in flight at once, settling
 * like `Promise.allSettled` (index-aligned, never rejects itself). A worker
 * slot picks up the next queued item the moment it frees, instead of the
 * fixed batches `Promise.allSettled` in chunks would produce.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<boolean>,
): Promise<PromiseSettledResult<boolean>[]> {
  const results: PromiseSettledResult<boolean>[] = Array.from({ length: items.length });
  let next = 0;
  const runSlot = async (): Promise<void> => {
    const index = next++;
    if (index >= items.length) return;
    try {
      results[index] = { status: "fulfilled", value: await worker(items[index]) };
    } catch (error) {
      results[index] = { status: "rejected", reason: error };
    }
    await runSlot();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runSlot()));
  return results;
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
  // Agent ids unsnoozed since the last successful save. A load that resolves
  // before that unsnooze is persisted must not let the still-stale stored
  // entry resurrect it; each id is removed once a save actually carries it.
  const unsnoozedSinceSave = new Set<string>();
  // Guards the initial load, `retrySnoozed`, and the automatic reload a
  // blocked save triggers, from stacking: `loadSnoozed` itself returns early
  // when a load is already in flight, so callers never need to check first.
  let snoozedReloadInFlight = false;
  let snoozedLoadRevision = 0;
  // Chains every snoozed write through one promise: two setItem calls in
  // flight at once can land out of order at the backend, so a later write
  // carrying a tombstone can get overwritten by an earlier one that resolves
  // after it. A rejected write must not poison the chain — the catch below
  // always resolves so the next save still fires.
  let snoozedWrite: Promise<void> = Promise.resolve();
  const saveSnoozed = () => {
    if (disposed || !storage) return;
    // Bump before the blocked check below, not just on the write path: an
    // older in-flight setItem must stop matching the moment a newer save is
    // requested, blocked or not, or its stale resolution can clear tombstones
    // and clear the error banner for a save that never actually happened.
    const revision = ++snoozedRevision;
    // A failed load means storage truth is unknown: writing now would overwrite
    // whatever is actually stored with a map that never saw it. Keep the change
    // in memory and reload once so the merge can pick it up automatically; the
    // banner and manual Retry stay for when the reload itself fails.
    if (snapshot.snoozedLoadError) {
      publish({
        snoozedError:
          "Snoozed cards were not loaded, so this snooze is not saved yet. Retry loading.",
      });
      loadSnoozed();
      return;
    }
    const snoozed = new Map(snapshot.snoozed);
    let pruned = false;
    // Lanes are empty before the first load finishes, so pruning here would
    // drop every entry; save the map as-is and prune once agents are loaded.
    if (snapshot.loaded) {
      // Drop an entry once its agent is gone, or once a needs-you card for it
      // resurfaces with a different stamp. Keep it while the agent still exists
      // but has no needs-you card right now — that gap can be one broadcast
      // where the card is momentarily absent, not the wait actually resolving.
      for (const [agentId, stamp] of snoozed) {
        if (!snapshot.agents.has(agentId)) {
          snoozed.delete(agentId);
          pruned = true;
          continue;
        }
        const card = snapshot.lanes.needsYou.find((candidate) => candidate.agent.id === agentId);
        if (card && snoozeStamp(card) !== stamp) {
          snoozed.delete(agentId);
          pruned = true;
        }
      }
    }
    // A prune that only lands in storage leaves memory holding the ghost
    // entry, so every later load forces a redundant save; publish it too.
    if (pruned) publish({ snoozed });
    // Tombstones this save actually carries — captured now, not read off
    // `unsnoozedSinceSave` inside `.then`, so an unsnooze that arrives while
    // this write is still in flight is not dropped by a save that predates it.
    const carriedTombstones = new Set(unsnoozedSinceSave);
    snoozedWrite = snoozedWrite
      .then(() => {
        // A write queued behind a pending one can still fire after dispose
        // tears the store down; storage should not hear from a dead store.
        if (disposed) return;
        return storage.setItem("snoozed", JSON.stringify(Object.fromEntries(snoozed)));
      })
      .then(() => {
        if (disposed) return undefined;
        if (revision === snoozedRevision) {
          for (const agentId of carriedTombstones) unsnoozedSinceSave.delete(agentId);
          publish({ snoozedError: null });
        }
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
    if (snoozedReloadInFlight) return;
    snoozedReloadInFlight = true;
    const loadRevision = ++snoozedLoadRevision;
    void storage
      .getItem("snoozed")
      .then((value) => {
        // A newer load superseded this one; its own completion owns the publish.
        if (loadRevision !== snoozedLoadRevision) return undefined;
        let stored: Map<string, string>;
        let corrupt = false;
        try {
          stored = parseSnoozed(value);
        } catch {
          // A corrupt stored value can't be trusted; treat storage as empty
          // and force the save below so the corruption gets overwritten.
          stored = new Map();
          corrupt = true;
        }
        // An unsnooze made while a prior load was broken never reached storage;
        // the stored entry is the pre-unsnooze state and must not come back.
        let removedUnsnoozed = false;
        for (const agentId of unsnoozedSinceSave) {
          if (stored.delete(agentId)) removedUnsnoozed = true;
        }
        // Stored entries first, in-memory entries on top: a snooze made while a
        // prior load was broken outranks whatever storage last held for it.
        const memory = snapshot.snoozed;
        const merged = new Map([...stored, ...memory]);
        const hasUnsavedEntries =
          corrupt ||
          removedUnsnoozed ||
          Array.from(memory).some(([agentId, stamp]) => stored.get(agentId) !== stamp);
        // A save blocked by the failed load left snoozedError set; the merge
        // below either persists those entries or proves storage already had them.
        publish({
          snoozed: merged,
          snoozedReady: true,
          snoozedLoadError: null,
          snoozedError: null,
        });
        if (hasUnsavedEntries) saveSnoozed();
        return undefined;
      })
      .catch((error: unknown) => {
        if (loadRevision !== snoozedLoadRevision) return undefined;
        // A rejected getItem is the only failure that leaves storage truth
        // unknown — a parse failure above is handled, not rethrown here.
        publish({ snoozedReady: true, snoozedLoadError: errorMessage(error) });
        return undefined;
      })
      .finally(() => {
        snoozedReloadInFlight = false;
      });
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
    // Until the stored snoozes load, the badge would count cards the user hid.
    getBadge: () =>
      snapshot.snoozedReady
        ? unsnoozedCards(snapshot.lanes.needsYou, snapshot.snoozed).length || null
        : null,
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
        // A read already in flight will succeed on its own — don't count it.
        const eligible = agentIds.filter(
          (agentId) => snapshot.operations.get(readKey(agentId))?.status !== "pending",
        );
        const results = await runPool(eligible, MARK_ALL_READ_CONCURRENCY, (agentId) =>
          this.markRead(agentId),
        );
        // Nobody is left to show a failure to.
        if (disposed) return;
        const failed = results.filter(
          (result) => result.status === "rejected" || !result.value,
        ).length;
        if (failed > 0) {
          throw new Error(`${failed} of ${eligible.length} results could not be marked read.`);
        }
      });
    },
    archive: (agentId) => run(archiveKey(agentId), () => paseo.agents.ref(agentId).archive()),
    snooze(card) {
      if (disposed || !canSnooze(card)) return;
      const snoozed = new Map(snapshot.snoozed);
      snoozed.set(card.agent.id, snoozeStamp(card));
      publish({ snoozed });
      saveSnoozed();
    },
    unsnooze(agentId) {
      if (disposed || !snapshot.snoozed.has(agentId)) return;
      const snoozed = new Map(snapshot.snoozed);
      snoozed.delete(agentId);
      unsnoozedSinceSave.add(agentId);
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
      // A failed load means storage truth is unknown: reload and merge memory
      // on top. A failed save with a known-good load means the in-memory map
      // is newer: write it again rather than reloading over it.
      if (snapshot.snoozedLoadError) loadSnoozed();
      else if (snapshot.snoozedError) saveSnoozed();
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
