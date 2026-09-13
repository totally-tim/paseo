import { useRef } from "react";
import { collectAllPanes, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { deriveWorkspacePaneState } from "./workspace-pane-state";

export function selectVisibleAgentIds(input: {
  layout: WorkspaceLayout | null;
  tabs: WorkspaceTab[];
  routeFocused: boolean;
  focusedPaneOnly: boolean;
  /**
   * Resolves the coordinator session for a board's projectId. A visible board
   * keeps the coordinator's timeline warm so the reply area streams live.
   */
  coordinatorAgentIdForProjectId?: (projectId: string) => string | null;
}): string[] {
  if (!input.routeFocused || !input.layout) {
    return [];
  }
  const panes = input.focusedPaneOnly
    ? collectAllPanes(input.layout.root).filter((pane) => pane.id === input.layout?.focusedPaneId)
    : collectAllPanes(input.layout.root);

  return [
    ...new Set(
      panes.flatMap((pane) => {
        const target = deriveWorkspacePaneState({ pane, tabs: input.tabs }).activeTab?.descriptor
          .target;
        if (target?.kind === "agent") {
          return [target.agentId];
        }
        if (target?.kind === "coordinator_board") {
          const agentId = input.coordinatorAgentIdForProjectId?.(target.projectId) ?? null;
          return agentId ? [agentId] : [];
        }
        return [];
      }),
    ),
  ].sort();
}

export function useVisibleAgentIds(input: {
  layout: WorkspaceLayout | null;
  tabs: WorkspaceTab[];
  routeFocused: boolean;
  focusedPaneOnly: boolean;
  coordinatorAgentIdForProjectId?: (projectId: string) => string | null;
}): string[] {
  const nextAgentIds = selectVisibleAgentIds(input);
  const stableAgentIds = useRef<string[]>([]);
  if (
    stableAgentIds.current.length !== nextAgentIds.length ||
    stableAgentIds.current.some((agentId, index) => agentId !== nextAgentIds[index])
  ) {
    stableAgentIds.current = nextAgentIds;
  }
  return stableAgentIds.current;
}
