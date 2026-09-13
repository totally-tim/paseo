import type { CoordinatorProfileSelection } from "@getpaseo/protocol/messages";
export interface CoordinatorRotationSettings {
  fallbackProfile?: CoordinatorProfileSelection;
  rotationThresholdPercent?: number;
}
export interface CoordinatorRotationUpdate {
  fallbackProfile: CoordinatorProfileSelection | null;
  rotationThresholdPercent: number;
}
export function openCoordinatorSettings(snapshot: CoordinatorRotationSettings) {
  let state = {
    fallbackProfile: snapshot.fallbackProfile ?? null,
    threshold: String(snapshot.rotationThresholdPercent ?? 60),
    saving: false,
    error: null as string | null,
  };
  const listeners = new Set<() => void>();
  let closed = false;
  const publish = () => {
    if (!closed) for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    setThreshold: (threshold: string) => {
      if (closed || state.saving) return;
      state = { ...state, threshold, error: null };
      publish();
    },
    setFallback: (selection: { provider: string; modelId: string } | null) => {
      if (closed || state.saving) return;
      state = {
        ...state,
        fallbackProfile: selection
          ? {
              ...(state.fallbackProfile?.provider === selection.provider
                ? state.fallbackProfile
                : {}),
              provider: selection.provider,
              model: selection.modelId || undefined,
            }
          : null,
        error: null,
      };
      publish();
    },
    async submit(save: (value: CoordinatorRotationUpdate) => Promise<void>) {
      if (closed || state.saving) return false;
      const value = Number(state.threshold);
      if (!/^\d+$/.test(state.threshold) || !Number.isInteger(value) || value < 1 || value > 100) {
        state = { ...state, error: "Enter a rotation threshold from 1 to 100 percent." };
        publish();
        return false;
      }
      state = { ...state, saving: true, error: null };
      publish();
      try {
        await save({ fallbackProfile: state.fallbackProfile, rotationThresholdPercent: value });
        return !closed;
      } catch (error) {
        state = {
          ...state,
          error:
            error instanceof Error
              ? error.message
              : "Couldn't save coordinator settings. Try again.",
        };
        return false;
      } finally {
        state = { ...state, saving: false };
        publish();
      }
    },
  };
}
