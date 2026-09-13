import { useEffect, useState, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { openAutomation, type AutomationView } from "./model";
export function useAutomation(
  view: AutomationView,
  projectId: string | undefined,
  client: DaemonClient | null,
) {
  const [model] = useState(() => openAutomation(view, projectId));
  const active = useRetainedPanelActive();
  useEffect(() => {
    model.setClient(client);
  }, [model, client]);
  useEffect(() => {
    if (!active) return;
    void model.reload();
    const timer = setInterval(() => void model.reload(), 15000);
    return () => clearInterval(timer);
  }, [model, active]);
  useEffect(() => () => model.close(), [model]);
  return { model, state: useSyncExternalStore(model.subscribe, model.getState, model.getState) };
}
