import { useSessionStore } from "@/stores/session-store";
import { useCallback, useState } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { AgentHandoffSheet } from "./handoff-sheet";

export function useWorkspaceHandoff(serverId: string, cwd: string | null, visible: boolean) {
  const supported = useHostFeature(serverId, "agentHandoff");
  const connected = useHostRuntimeIsConnected(serverId);
  const [selection, setSelection] = useState<{
    agentId: string;
    serverId: string;
    cwd: string;
  } | null>(null);
  const open = useCallback(
    (agentId: string) => {
      if (cwd) setSelection({ agentId, serverId, cwd });
    },
    [serverId, cwd],
  );
  const close = useCallback(() => setSelection(null), []);
  const current = selection?.serverId === serverId && selection?.cwd === cwd;
  return {
    continueAgent: supported && connected ? open : undefined,
    sheet:
      selection && current && visible ? (
        <AgentHandoffSheet
          serverId={serverId}
          agentId={selection.agentId}
          cwd={selection.cwd}
          onClose={close}
        />
      ) : null,
  };
}

export function useAgentCanContinue(serverId: string, agentId: string | undefined) {
  return useSessionStore((state) => {
    if (!agentId) return false;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return Boolean(agent && !agent.archivedAt);
  });
}
