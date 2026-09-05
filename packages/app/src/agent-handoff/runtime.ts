import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentContinuationSnapshot } from "@getpaseo/protocol/messages";
import { queryClient } from "@/data/query-client";
import { useWorkspaceLayoutStore, collectAllTabs } from "@/stores/workspace-layout-store";
import { useDraftStore, flushDraftPersistStorage } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useSessionStore } from "@/stores/session-store";

export async function retargetContinuationTab(
  serverId: string,
  sourceId: string,
  snapshot: AgentContinuationSnapshot,
): Promise<void> {
  if (snapshot.agentId === sourceId || !snapshot.continuation?.previousAgentId) return;
  // A continuation event can precede its directory row. Reconciliation must know the target first.
  if (!useSessionStore.getState().sessions[serverId]?.agents.has(snapshot.agentId)) return;
  const transitionAt = Date.parse(
    snapshot.continuation.firstTransitionedAt ??
      snapshot.continuation.transitionedAt ??
      snapshot.continuation.updatedAt,
  );
  const layouts = useWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(layouts.layoutByWorkspace)) {
    if (!workspaceKey.startsWith(`${serverId}:`)) continue;
    for (const tab of collectAllTabs(layout.root)) {
      // A conversation opened after the transition is an explicit history view.
      if (
        tab.target.kind !== "agent" ||
        tab.target.agentId !== sourceId ||
        tab.createdAt > transitionAt
      )
        continue;
      const sourceKey = buildDraftStoreKey({ serverId, agentId: sourceId });
      const targetKey = buildDraftStoreKey({ serverId, agentId: snapshot.agentId });
      const drafts = useDraftStore.getState();
      const source = drafts.getDraftInput(sourceKey);
      const target = drafts.getDraftInput(targetKey);
      if (
        source &&
        (source.text || source.attachments.length) &&
        (!target || (!target.text && !target.attachments.length))
      ) {
        drafts.saveDraftInput({ draftKey: targetKey, draft: source });
        await flushDraftPersistStorage();
      }
      // Same-kind replacement keeps the tab ID, position, and focused pane.
      layouts.retargetAgentContinuation(workspaceKey, tab.tabId, sourceId, snapshot.agentId);
    }
  }
}

export function mountContinuationRuntime(client: DaemonClient, serverId: string): () => void {
  let disposed = false;
  let supported = false;
  const pending = new Map<string, Promise<void>>();
  const refresh = (agentId: string): Promise<void> => {
    const existing = pending.get(agentId);
    if (existing) return existing;
    const operation = (async () => {
      const response = await client.inspectAgentContinuation(agentId);
      if (disposed || response.error || !response.snapshot) return;
      await retargetContinuationTab(serverId, agentId, response.snapshot);
    })()
      .catch(() => undefined)
      .finally(() => pending.delete(agentId));
    pending.set(agentId, operation);
    return operation;
  };
  const repair = async () => {
    if (!supported) return;
    void queryClient.invalidateQueries({ queryKey: ["agent-continuation", serverId] });
    const ids = new Set<string>();
    for (const [key, layout] of Object.entries(
      useWorkspaceLayoutStore.getState().layoutByWorkspace,
    )) {
      if (!key.startsWith(`${serverId}:`)) continue;
      for (const tab of collectAllTabs(layout.root))
        if (tab.target.kind === "agent") ids.add(tab.target.agentId);
    }
    // Keep reconnect reads bounded even with many old task tabs.
    const entries = [...ids];
    for (let index = 0; index < entries.length; index += 2) {
      if (disposed) return;
      await Promise.all(entries.slice(index, index + 2).map(refresh));
    }
  };
  const stopInfo = client.subscribe((event) => {
    if (event.type !== "status") return;
    supported = client.getLastServerInfoMessage()?.features?.agentContinuation === true;
    void repair();
  });
  supported = client.getLastServerInfoMessage()?.features?.agentContinuation === true;
  void repair();
  const stopDirectory = useSessionStore.subscribe((state, previous) => {
    if (state.sessions[serverId]?.agents !== previous.sessions[serverId]?.agents) void repair();
  });
  const stopChanged = client.on("agent.continuation.changed", (event) => {
    void queryClient.invalidateQueries({ queryKey: ["agent-continuation", serverId] });
    void refresh(event.payload.rootAgentId).then(() => repair());
  });
  return () => {
    disposed = true;
    stopInfo();
    stopDirectory();
    stopChanged();
  };
}
