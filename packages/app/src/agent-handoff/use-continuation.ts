import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AgentQueueOperation } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function useAgentContinuation(serverId: string, agentId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "agentContinuation");
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["agent-continuation", serverId, agentId],
    enabled: Boolean(client && supported && connected && agentId),
    staleTimeMs: 5_000,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const response = await client.inspectAgentContinuation(agentId);
      if (response.error || !response.snapshot) throw new Error(response.error ?? "Task not found");
      return response.snapshot;
    },
  });
  const manage = useCallback(
    async (operation: AgentQueueOperation) => {
      if (!supported)
        throw new Error("Update this host to queue messages and use automatic continuation.");
      if (!client || !connected)
        throw new Error("Host disconnected. Your message remains in the draft.");
      const response = await client.manageAgentQueue(agentId, operation);
      if (response.error || !response.snapshot)
        throw new Error(response.error ?? "Could not update the task queue.");
      await queryClient.invalidateQueries({ queryKey: ["agent-continuation", serverId] });
      return response.snapshot;
    },
    [agentId, client, connected, queryClient, serverId, supported],
  );
  const cancel = useCallback(async () => {
    if (!client || !connected) throw new Error("Host disconnected");
    const response = await client.cancelAgentContinuation(agentId);
    if (response.error) throw new Error(response.error);
    await queryClient.invalidateQueries({ queryKey: ["agent-continuation", serverId] });
  }, [agentId, client, connected, queryClient, serverId]);
  return { ...query, manage, cancel, supported, connected };
}
