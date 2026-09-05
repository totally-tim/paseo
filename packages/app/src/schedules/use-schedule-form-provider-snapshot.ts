import { useAccountCatalog } from "@/provider-accounts/use-account-catalog";
import { useEffect } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { ScheduleFormModel, ScheduleFormState } from "./schedule-form-model";

export function useScheduleFormProviderSnapshot(
  model: ScheduleFormModel,
  state: ScheduleFormState,
) {
  const serverId = state.providerSnapshotRequest?.serverId ?? state.selectedServerId;
  const cwd = state.providerSnapshotRequest?.cwd ?? state.workingDir;
  const enabled = state.targetKind === "new-agent" && Boolean(serverId && cwd.trim());
  const snapshot = useProvidersSnapshot(serverId ?? null, {
    cwd,
    enabled,
  });

  const entries = useAccountCatalog({
    serverId: serverId ?? "",
    entries: snapshot.entries,
    cwd,
    provider: state.selectedProvider,
    selection: state.accountSelection,
    model: state.selectedModel,
  });

  useEffect(() => {
    if (!enabled || !serverId || !entries) {
      return;
    }
    model.applyProviderSnapshot(serverId, { entries });
  }, [enabled, model, serverId, entries]);

  return snapshot;
}
