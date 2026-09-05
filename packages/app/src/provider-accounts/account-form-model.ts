import type {
  AccountLogin,
  AccountOperation,
  ProviderAccount,
} from "@getpaseo/protocol/provider-accounts";

export function openAccountForm(account: ProviderAccount) {
  let closed = false;
  let epoch = 0;
  const listeners = new Set<() => void>();
  let state = {
    label: account.label,
    reserve: account.reservePercent?.toString() ?? "",
    interactiveOnly: account.interactiveOnly ?? false,
    pending: false,
    error: null as string | null,
    login: null as AccountLogin | null,
    code: "",
  };
  const commit = (patch: Partial<typeof state>) => {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    activate() {
      closed = false;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      epoch++;
      state = { ...state, pending: false, code: "", login: null };
      listeners.clear();
    },
    setLabel(value: string) {
      if (!state.pending) commit({ label: value });
    },
    setReserve(value: string) {
      if (!state.pending) commit({ reserve: value });
    },
    setInteractiveOnly(value: boolean) {
      if (!state.pending) commit({ interactiveOnly: value });
    },
    setCode(value: string) {
      if (!state.pending) commit({ code: value });
    },
    receiveLogin(login: AccountLogin | null) {
      commit({ login });
    },
    saveOperation(): AccountOperation | null {
      const reservePercent = state.reserve.trim() ? Number(state.reserve) : 0;
      if (
        !state.label.trim() ||
        !Number.isFinite(reservePercent) ||
        reservePercent < 0 ||
        reservePercent > 100
      ) {
        commit({ error: "Enter a label and a reserve between 0 and 100 percent." });
        return null;
      }
      return {
        kind: "edit",
        accountId: account.id,
        changes: {
          label: state.label.trim(),
          reservePercent,
          interactiveOnly: state.interactiveOnly,
        },
      };
    },
    async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
      if (closed || state.pending) return;
      const started = epoch;
      commit({ pending: true, error: null });
      try {
        return await operation();
      } catch (error) {
        if (started === epoch)
          commit({ error: error instanceof Error ? error.message : "Account operation failed" });
      } finally {
        if (started === epoch) commit({ pending: false, code: "" });
      }
    },
  };
}
