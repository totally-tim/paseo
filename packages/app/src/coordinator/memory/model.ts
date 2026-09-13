import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CoordinatorMemorySnapshot } from "@getpaseo/protocol/messages";

export type MemoryTarget = { scope: "personal" } | { scope: "personal-project"; projectId: string };
type MemoryClient = Pick<DaemonClient, "getCoordinatorMemory" | "updateCoordinatorMemory">;
type MemoryLoad =
  | { status: "connecting" | "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; snapshot: CoordinatorMemorySnapshot };
export interface MemoryEditorState {
  load: MemoryLoad;
  text: string;
  editorVersion: number;
  connected: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Couldn't access personal memory. Try again.";

export function openMemoryEditor(target: MemoryTarget) {
  let state: MemoryEditorState = {
    load: { status: "connecting" },
    text: "",
    editorVersion: 0,
    connected: false,
    dirty: false,
    saving: false,
    error: null,
  };
  let client: MemoryClient | null = null;
  let active = true;
  let loadGeneration = 0;
  const listeners = new Set<() => void>();
  function publish(next: MemoryEditorState) {
    if (!active) return;
    state = next;
    for (const listener of listeners) listener();
  }
  async function reload() {
    if (!client || state.saving || !active) return;
    const generation = ++loadGeneration;
    const requestClient = client;
    publish({ ...state, load: { status: "loading" }, error: null });
    try {
      const snapshot = await requestClient.getCoordinatorMemory(target);
      if (!active || generation !== loadGeneration) return;
      publish({
        ...state,
        load: { status: "loaded", snapshot },
        text: snapshot.content,
        dirty: false,
        error: null,
        editorVersion: state.editorVersion + 1,
      });
    } catch (error) {
      if (generation === loadGeneration)
        publish({ ...state, load: { status: "error", error: message(error) } });
    }
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      active = false;
      ++loadGeneration;
      listeners.clear();
    },
    setClient(next: MemoryClient | null) {
      if (!active || client === next) return;
      client = next;
      publish({ ...state, connected: next !== null });
      if (state.load.status === "loaded") return; // A reconnect must never replace a draft.
      ++loadGeneration;
      if (!next) publish({ ...state, load: { status: "connecting" } });
      else void reload();
    },
    edit(text: string) {
      if (state.load.status !== "loaded" || state.saving) return;
      publish({ ...state, text, dirty: text !== state.load.snapshot.content, error: null });
    },
    reload,
    async save() {
      if (!active || state.load.status !== "loaded" || state.saving || !state.dirty) return;
      if (!client) {
        publish({ ...state, error: "Host disconnected. Your edits are kept here." });
        return;
      }
      const content = state.text;
      const expectedRevision = state.load.snapshot.revision;
      publish({ ...state, saving: true, error: null });
      try {
        const snapshot = await client.updateCoordinatorMemory({
          ...target,
          content,
          expectedRevision,
        });
        publish({
          ...state,
          load: { status: "loaded", snapshot },
          text: snapshot.content,
          dirty: false,
          editorVersion: state.editorVersion + 1,
        });
      } catch (error) {
        publish({ ...state, error: message(error) });
      } finally {
        publish({ ...state, saving: false });
      }
    },
  };
}
