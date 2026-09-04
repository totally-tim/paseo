import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MaterializedAgentProfile } from "@/agent-profiles";

export type HandoffSelection = MaterializedAgentProfile;

export function openHandoffForm<T>(
  submit: (selection: HandoffSelection, briefing: string) => Promise<T>,
) {
  const listeners = new Set<() => void>();
  let selection: HandoffSelection = {
    provider: "",
    modelId: "",
    modeId: "",
    thinkingOptionId: "",
    featureValues: {},
  };
  let entries: ProviderSnapshotEntry[] = [];
  let connected = false;
  let pending = false;
  let error: string | null = null;
  let briefing = "";
  let snapshot = buildSnapshot();

  function buildSnapshot() {
    const provider = entries.find((entry) => entry.provider === selection.provider);
    const modes = provider?.modes ?? [];
    const modeValid = !selection.modeId || modes.some((mode) => mode.id === selection.modeId);
    return {
      selection,
      entries,
      briefing,
      pending,
      error,
      modes,
      canSubmit:
        connected &&
        !pending &&
        provider?.enabled === true &&
        provider.status === "ready" &&
        modeValid,
    };
  }
  function commit() {
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => snapshot,
    replaceCatalog(next: ProviderSnapshotEntry[], isConnected: boolean) {
      if (entries === next && connected === isConnected) return;
      entries = next;
      connected = isConnected;
      commit();
    },
    selectModel(provider: string, modelId: string) {
      if (pending) return;
      selection =
        provider === selection.provider
          ? { ...selection, modelId, thinkingOptionId: "" }
          : { provider, modelId, modeId: "", thinkingOptionId: "", featureValues: {} };
      error = null;
      commit();
    },
    applyProfile(profile: HandoffSelection) {
      if (pending) return;
      selection = { ...profile };
      error = null;
      commit();
    },
    selectMode(modeId: string) {
      if (pending) return;
      selection = { ...selection, modeId };
      commit();
    },
    setBriefing(value: string) {
      if (pending) return;
      briefing = value;
      commit();
    },
    async submit(): Promise<T | null> {
      if (!snapshot.canSubmit) return null;
      pending = true;
      error = null;
      commit();
      try {
        return await submit(selection, briefing);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        return null;
      } finally {
        pending = false;
        commit();
      }
    },
  };
}
