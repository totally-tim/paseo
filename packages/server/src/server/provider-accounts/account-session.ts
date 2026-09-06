import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { AccountOperationError, type ProviderAccountService } from "./account-service.js";
import type { AccountLogin, ProviderAccount } from "@getpaseo/protocol/provider-accounts";

export async function handleAccountList(
  service: ProviderAccountService | undefined,
  request: Extract<SessionInboundMessage, { type: "provider.accounts.list.request" }>,
  emit: (message: SessionOutboundMessage) => void,
): Promise<void> {
  try {
    if (!service) throw new Error("Update the host to manage provider accounts.");
    const accounts = service.list();
    const usage = accounts.map((account) => service.usageSnapshot(account.id));
    service.refreshUsage();
    emit({
      type: "provider.accounts.list.response",
      payload: {
        requestId: request.requestId,
        error: null,
        accounts: service.list(),
        usage,
        policy: service.store.getPolicy(),
        next: (["claude", "codex"] as const).map((provider) =>
          Object.assign({ provider }, service.choice(provider, { kind: "automatic" }, false)),
        ),
      },
    });
  } catch {
    emit({
      type: "provider.accounts.list.response",
      payload: {
        requestId: request.requestId,
        error: "Could not load provider accounts.",
        accounts: [],
        usage: [],
        next: [],
        policy: null,
      },
    });
  }
}

export async function handleAccountOperation(
  service: ProviderAccountService | undefined,
  request: Extract<SessionInboundMessage, { type: "provider.accounts.manage.request" }>,
  emit: (message: SessionOutboundMessage) => void,
): Promise<void> {
  let account: ProviderAccount | null = null;
  let login: AccountLogin | null = null;
  let error: string | null = null;
  try {
    if (!service) throw new Error("Update the host to manage provider accounts.");
    const operation = request.operation;
    switch (operation.kind) {
      case "add":
        account = await service.add(operation.provider, operation.label);
        break;
      case "edit":
        account = await service.edit(operation.accountId, operation.changes);
        break;
      case "inspect":
        account = await service.inspect(operation.accountId);
        // Check login must not drop the challenge and Cancel control of a running login.
        login = service.activeLogin(operation.accountId);
        break;
      case "login-start":
        login = await service.startLogin(operation.accountId);
        break;
      case "login-status":
        login =
          service
            .activeLogins()
            .find(
              (entry) => entry.accountId === operation.accountId && entry.id === operation.loginId,
            ) ?? null;
        break;
      case "login-cancel":
        await service.cancelLogin(operation.accountId, operation.loginId);
        break;
      case "login-code":
        service.submitCode(operation.accountId, operation.loginId, operation.code);
        login = service.activeLogin(operation.accountId, operation.loginId);
        break;
      case "logout":
        await service.logout(operation.accountId);
        break;
      case "remove":
        await service.remove(operation.accountId, operation.credentials);
        break;
      case "restore":
        await service.restore(operation.accountId);
        break;
      case "policy":
        await service.setPolicy(operation.policy);
        break;
    }
    if ("accountId" in operation) account = service.store.get(operation.accountId);
  } catch (cause) {
    // Provider exceptions can include raw stdout or RPC payloads. Never send them to a client.
    error =
      cause instanceof AccountOperationError
        ? cause.message
        : "Account operation failed. Check its status and close any agents using this account before changing its login.";
  }
  emit({
    type: "provider.accounts.manage.response",
    payload: { requestId: request.requestId, error, account, login },
  });
}
