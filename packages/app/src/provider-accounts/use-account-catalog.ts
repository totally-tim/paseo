import { useMemo } from "react";
import type { AccountProvider, AccountSelection } from "@getpaseo/protocol/provider-accounts";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProviderAccounts } from "./use-provider-accounts";

interface Input {
  serverId: string;
  entries: ProviderSnapshotEntry[] | undefined;
  provider?: string | null;
  selection?: AccountSelection;
  cwd?: string | null;
  model?: string;
}

export function useAccountCatalog(input: Input): ProviderSnapshotEntry[] | undefined {
  const claude = useAccountCatalogEntry(input, "claude");
  const codex = useAccountCatalogEntry(input, "codex");
  return useMemo(() => {
    if (!claude && !codex) return input.entries;
    const entries = [...(input.entries ?? [])];
    for (const entry of [claude, codex]) {
      if (!entry) continue;
      const index = entries.findIndex((candidate) => candidate.provider === entry.provider);
      if (index === -1) entries.push(entry);
      else entries[index] = { ...entries[index], ...entry };
    }
    return entries;
  }, [input.entries, claude, codex]);
}

function useAccountCatalogEntry(
  input: Input,
  provider: AccountProvider,
): ProviderSnapshotEntry | null {
  const accounts = useProviderAccounts(input.serverId);
  const client = useHostRuntimeClient(input.serverId);
  const selection = input.provider === provider ? input.selection : undefined;
  const providerAccounts =
    accounts.data?.accounts.filter(
      (account) => account.provider === provider && !account.removedAt,
    ) ?? [];
  const enabled =
    accounts.supported &&
    accounts.connected &&
    input.entries?.find((entry) => entry.provider === provider)?.enabled !== false &&
    Boolean(client) &&
    selection?.kind !== "default" &&
    (providerAccounts.some((account) => account.ownership === "managed" && account.enabled) ||
      selection?.kind === "fixed");
  const revision = providerAccounts
    .map((account) => `${account.id}:${account.revision}`)
    .sort()
    .join("|");
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: [
      "account-catalog",
      input.serverId,
      provider,
      selection ?? { kind: "automatic" },
      input.cwd,
      revision,
    ],
    enabled,
    staleTimeMs: 300_000,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const result = await client.getProviderAccountCatalog({
        provider,
        selection,
        cwd: input.cwd ?? undefined,
      });
      if (result.error || !result.entry) throw new Error(result.error ?? result.reason);
      return result.entry;
    },
  });
  return useMemo(() => {
    if (!enabled) return null;
    if (query.data) return query.data;
    return {
      provider,
      enabled: true,
      status: query.isError ? "error" : "loading",
      error: query.error?.message,
    };
  }, [enabled, provider, query.data, query.isError, query.error]);
}
