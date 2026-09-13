import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
type Client = Pick<
  DaemonClient,
  "getCoordinatorPermissionPolicyPreview" | "alwaysAllowCoordinatorPermission"
>;
interface Preview {
  pattern: string;
  projectId: string | null;
}
type State =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      preview: Preview;
      scope: "daemon" | "project";
      pending: boolean;
      error: string | null;
      saved: boolean;
    };
export function openPermissionPolicy(agentId: string, requestId: string) {
  let state: State = { status: "loading" };
  let active = true;
  let version = 0;
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    if (!active) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      active = false;
      ++version;
      listeners.clear();
    },
    async load(client: Client | null) {
      const current = ++version;
      publish({ status: "loading" });
      try {
        if (!client) throw new Error("Host disconnected. Reconnect and retry.");
        const preview = await client.getCoordinatorPermissionPolicyPreview({ agentId, requestId });
        if (current === version)
          publish({
            status: "ready",
            preview,
            scope: preview.projectId ? "project" : "daemon",
            pending: false,
            error: null,
            saved: false,
          });
      } catch (cause) {
        if (current === version)
          publish({
            status: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          });
      }
    },
    setScope(scope: "daemon" | "project") {
      if (
        state.status === "ready" &&
        !state.pending &&
        !state.saved &&
        (scope === "daemon" || state.preview.projectId)
      )
        publish({ ...state, scope });
    },
    async save(client: Client | null) {
      if (state.status !== "ready" || state.pending || state.saved) return;
      const snapshot = state;
      publish({ ...snapshot, pending: true, error: null });
      try {
        if (!client) throw new Error("Host disconnected. Reconnect and retry.");
        await client.alwaysAllowCoordinatorPermission({
          agentId,
          requestId,
          scope: snapshot.scope,
          expectedPattern: snapshot.preview.pattern,
        });
        publish({ ...snapshot, pending: false, saved: true });
      } catch (cause) {
        publish({
          ...snapshot,
          pending: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
  };
}
export function resolvePolicyNotification(
  action: string,
  data: unknown,
): { serverId: string; agentId: string; requestId: string } | null {
  if (action !== "always_allow" || !data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  return typeof value.serverId === "string" &&
    value.serverId.length > 0 &&
    typeof value.agentId === "string" &&
    value.agentId.length > 0 &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0
    ? { serverId: value.serverId, agentId: value.agentId, requestId: value.requestId }
    : null;
}
