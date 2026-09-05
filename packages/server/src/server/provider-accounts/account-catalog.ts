import pLimit from "p-limit";
import { homedir } from "node:os";
import type { AccountProvider, AccountSelection } from "@getpaseo/protocol/provider-accounts";
import type { AgentClient, ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { expandTilde } from "../../utils/path.js";
import { runProviderRefreshWithDeadline } from "../agent/provider-refresh-deadline.js";
import type { ProviderAccountService } from "./account-service.js";

export interface AccountCatalogInput {
  provider: AccountProvider;
  selection?: AccountSelection;
  cwd?: string;
  model?: string;
}
export interface AccountCatalogResult {
  accountId: string | null;
  reason: string;
  entry: ProviderSnapshotEntry | null;
  error: string | null;
}

export class AccountCatalog {
  private readonly limit = pLimit(2);
  private readonly cache = new Map<
    string,
    { at: number; result: Promise<ProviderSnapshotEntry> }
  >();

  async read(
    input: AccountCatalogInput,
    accounts: ProviderAccountService,
    client: (provider: string, accountId: string) => AgentClient,
  ): Promise<AccountCatalogResult> {
    // A fixed account's catalog must stay readable when its quota is exhausted.
    const choice =
      input.selection?.kind === "fixed"
        ? { accountId: input.selection.accountId, reason: "Fixed account" }
        : accounts.preview(input.provider, input.selection, input.model);
    if (!choice.accountId) return { ...choice, entry: null, error: choice.reason };
    const account = accounts.store.get(choice.accountId);
    if (account.provider !== input.provider) throw new Error("Account and provider do not match.");
    const cwd = input.cwd ? expandTilde(input.cwd) : homedir();
    const key = JSON.stringify([account.id, account.revision, cwd]);
    let cached = this.cache.get(key);
    if (!cached || Date.now() - cached.at >= 300_000) {
      const result = this.limit(async () => {
        const lease = await accounts.reserve({
          provider: input.provider,
          pinnedAccountId: account.id,
          unattended: false,
        });
        try {
          const catalog = await runProviderRefreshWithDeadline({
            label: "account models",
            timeoutMs: 20_000,
            operation: (context) =>
              client(input.provider, account.id).fetchCatalog(
                { scope: "workspace", cwd, force: true },
                context,
              ),
          });
          if (accounts.store.get(account.id).revision !== account.revision)
            throw new Error("Account changed during model discovery.");
          return {
            provider: input.provider,
            enabled: true,
            status: "ready" as const,
            ...catalog,
            fetchedAt: new Date().toISOString(),
          };
        } finally {
          lease?.release();
        }
      });
      cached = { at: Date.now(), result };
      this.cache.set(key, cached);
      void result.catch(() => this.cache.delete(key));
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    }
    return { ...choice, entry: await cached.result, error: null };
  }
}

export async function handleAccountCatalog(
  manager: AgentManager,
  request: Extract<SessionInboundMessage, { type: "provider.accounts.catalog.request" }>,
  emit: (message: SessionOutboundMessage) => void,
): Promise<void> {
  let result: AccountCatalogResult;
  try {
    result = await manager.getAccountCatalog(request);
  } catch {
    result = {
      accountId: null,
      entry: null,
      reason: "Account catalog is unavailable.",
      error: "Could not read this account's models. Check its login and try again.",
    };
  }
  emit({
    type: "provider.accounts.catalog.response",
    payload: { requestId: request.requestId, ...result },
  });
}
