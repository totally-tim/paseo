import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { AccountOperation } from "@getpaseo/protocol/provider-accounts";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function useProviderAccounts(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "providerAccounts");
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["provider-accounts", serverId],
    enabled: Boolean(client && connected && supported),
    staleTimeMs: 30_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const result = await client.listProviderAccounts();
      if (result.error) throw new Error(result.error);
      return result;
    },
  });
  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["provider-accounts", serverId] });
  }, [queryClient, serverId]);
  const manage = useCallback(
    async (operation: AccountOperation) => {
      if (!client || !connected) throw new Error("Host disconnected");
      const result = await client.manageProviderAccount(operation);
      if (result.error) throw new Error(result.error);
      if (operation.kind !== "login-status") await invalidate();
      return result;
    },
    [client, connected, invalidate],
  );
  return { ...query, manage, refresh: invalidate, supported, connected };
}
