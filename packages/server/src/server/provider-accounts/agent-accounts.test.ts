import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AccountProvider } from "@getpaseo/protocol/provider-accounts";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { importSessionFromPersistence } from "../agent/provider-session-import.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { handoffAgent } from "../agent/handoff-agent.js";
import type { AgentClient } from "../agent/agent-sdk-types.js";
import { ProviderAccountStore } from "./account-store.js";
import { ProviderAccountService } from "./account-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(usedPct = 10) {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-accounts-"));
  const logger = createTestLogger();
  const store = new ProviderAccountStore(directory);
  const accounts = new ProviderAccountService(store, (account) => ({
    inspect: async () => ({ key: account.id, email: `${account.id}@example.invalid` }),
    login: async () => ({ key: account.id }),
    logout: async () => {},
    usage: async () => ({
      providerId: account.provider,
      displayName: account.label,
      status: "available",
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", usedPct, resetsAt: null }],
    }),
  }));
  await accounts.initialize();
  const agentStorage = new AgentStorage(path.join(directory, "agents"), logger);
  const accountClients = new Map<string, AgentClient>();
  const managers: AgentManager[] = [];
  const buildManager = () => {
    const manager = new AgentManager({
      clients: createTestAgentClients(),
      registry: agentStorage,
      logger,
      accounts,
      createAccountClient: (provider, context) => {
        const client = accountClients.get(context.accountId) ?? createTestAgentClient(provider);
        accountClients.set(context.accountId, client);
        return client;
      },
    });
    managers.push(manager);
    return manager;
  };
  const manager = buildManager();
  const add = async (provider: AccountProvider, label: string) => {
    const account = await accounts.add(provider, label);
    await accounts.inspect(account.id);
    return account;
  };
  cleanup.push(async () => {
    for (const entry of managers) {
      for (const agent of entry.listAgents()) await entry.closeAgent(agent.id);
      await entry.flush();
    }
    await accounts.close();
    await agentStorage.flush();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    logger,
    accounts,
    store,
    manager,
    agentStorage,
    accountClients,
    buildManager,
    add,
  };
}

describe("agent account boundaries", () => {
  it.each(["claude", "codex"] as const)(
    "pins %s before startup and keeps it after rename, disable, and restart",
    async (provider) => {
      const {
        add,
        manager,
        directory,
        accountClients,
        agentStorage,
        accounts,
        buildManager,
        logger,
      } = await setup();
      const account = await add(provider, "A");
      const id = randomUUID();
      const client = createTestAgentClient(provider);
      const create = client.createSession.bind(client);
      vi.spyOn(client, "createSession").mockImplementation(async (config, context) => {
        expect((await agentStorage.get(id))?.config?.accountId).toBe(account.id);
        expect(config.accountId).toBe(account.id);
        return create(config, context);
      });
      accountClients.set(account.id, client);
      const agent = await manager.createAgent({ provider, cwd: directory }, id, {
        workspaceId: "workspace",
      });
      expect(agent.config.accountId).toBe(account.id);
      await expect(accounts.logout(account.id)).rejects.toThrow("Close this account's agents");
      await manager.closeAgent(id);
      await accounts.edit(account.id, { label: "Renamed A", enabled: false });
      const restarted = buildManager();
      const restored = await ensureAgentLoaded(id, {
        agentManager: restarted,
        agentStorage,
        logger,
      });
      expect(restored.config.accountId).toBe(account.id);
      expect(accounts.hasRuntime(account.id)).toBe(true);
    },
  );

  it("coordinates concurrent starts, fixed selections, and same-provider children", async () => {
    const { add, manager, directory } = await setup();
    const a = await add("claude", "A");
    const b = await add("claude", "B");
    const c = await add("codex", "C");
    const starts = await Promise.all(
      [1, 2].map(() =>
        manager.createAgent({ provider: "claude", cwd: directory }, undefined, {
          workspaceId: "workspace",
        }),
      ),
    );
    expect(new Set(starts.map((agent) => agent.config.accountId))).toEqual(new Set([a.id, b.id]));
    const parent = starts[0];
    const child = await manager.createAgent({ provider: "claude", cwd: directory }, undefined, {
      labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
      workspaceId: "workspace",
    });
    expect(child.config.accountId).toBe(parent.config.accountId);
    await expect(
      manager.createAgent(
        {
          provider: "claude",
          cwd: directory,
          accountSelection: {
            kind: "fixed",
            accountId: parent.config.accountId === a.id ? b.id : a.id,
          },
        },
        undefined,
        { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: "workspace" },
      ),
    ).rejects.toThrow("parent's account");
    const otherProviderChild = await manager.createAgent(
      { provider: "codex", cwd: directory },
      undefined,
      { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: "workspace" },
    );
    expect(otherProviderChild.config.accountId).toBe(c.id);
    const fixed = await manager.createAgent(
      { provider: "claude", cwd: directory, accountSelection: { kind: "fixed", accountId: a.id } },
      undefined,
      { workspaceId: "workspace" },
    );
    expect(fixed.config.accountId).toBe(a.id);
  });

  it.each(["claude", "codex"] as const)(
    "continues %s A to B and reuses B on retry",
    async (provider) => {
      const { add, manager, accounts, directory, agentStorage, logger } = await setup();
      const a = await add(provider, "A");
      const b = await add(provider, "B");
      const source = await manager.createAgent(
        { provider, cwd: directory, accountSelection: { kind: "fixed", accountId: a.id } },
        undefined,
        { workspaceId: "workspace" },
      );
      const deps = {
        agentManager: manager,
        agentStorage,
        logger,
        getWorkspace: async () => ({ cwd: directory }),
        providerSnapshotManager: {
          resolveCreateConfig: async () => ({ modeId: "default", featureValues: {} }),
        },
      };
      const input = {
        sourceAgentId: source.id,
        provider,
        accountSelection: { kind: "fixed" as const, accountId: b.id },
      };
      const target = await handoffAgent(deps, input);
      expect(target.config?.accountId).toBe(b.id);
      expect(accounts.hasRuntime(a.id)).toBe(false);
      expect(accounts.hasRuntime(b.id)).toBe(true);
      expect((await handoffAgent(deps, input)).id).toBe(target.id);
      await expect(
        handoffAgent(deps, { ...input, accountSelection: { kind: "fixed", accountId: a.id } }),
      ).rejects.toThrow("pinned account");
      expect((await agentStorage.getHandoff(source.id))?.config.accountId).toBe(b.id);
      expect((await agentStorage.list()).length).toBe(2);
    },
  );

  it("retains the chosen account if startup fails and capacity changes before retry", async () => {
    const { add, manager, directory, accountClients, agentStorage, logger } = await setup();
    const a = await add("codex", "A");
    const client = createTestAgentClient("codex");
    vi.spyOn(client, "createSession").mockRejectedValueOnce(new Error("Startup failed"));
    accountClients.set(a.id, client);
    const id = randomUUID();
    await expect(
      manager.createAgent({ provider: "codex", cwd: directory }, id, { workspaceId: "workspace" }),
    ).rejects.toThrow("Startup failed");
    const b = await add("codex", "B");
    expect((await agentStorage.get(id))?.config?.accountId).toBe(a.id);
    const retried = await ensureAgentLoaded(id, { agentManager: manager, agentStorage, logger });
    expect(retried.config.accountId).toBe(a.id);
    expect(retried.config.accountId).not.toBe(b.id);
  });
  it("rejects concurrent creation of the same agent without leaking its account lease", async () => {
    const { add, manager, directory, accounts } = await setup();
    const account = await add("codex", "A");
    const id = randomUUID();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        manager.createAgent({ provider: "codex", cwd: directory }, id, {
          workspaceId: "workspace",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await manager.closeAgent(id);
    expect(accounts.hasRuntime(account.id)).toBe(false);
    await accounts.logout(account.id);
  });

  it("releases the account lease when a reload closes the runtime and the resume fails", async () => {
    const { add, manager, directory, accountClients, accounts } = await setup();
    const account = await add("codex", "A");
    const client = createTestAgentClient("codex");
    accountClients.set(account.id, client);
    const id = randomUUID();
    await manager.createAgent({ provider: "codex", cwd: directory }, id, {
      workspaceId: "workspace",
    });
    expect(accounts.hasRuntime(account.id)).toBe(true);

    // Reload closes the original runtime before resuming, so a failed resume leaves
    // the agent closed. The lease has to go with it or the account is stranded.
    vi.spyOn(client, "resumeSession").mockRejectedValue(new Error("Resume failed"));
    await expect(manager.reloadAgentSession(id)).rejects.toThrow("Resume failed");

    expect(accounts.hasRuntime(account.id)).toBe(false);
    vi.mocked(client.resumeSession).mockRestore();
    await expect(
      manager.createAgent({ provider: "codex", cwd: directory }, id, {
        workspaceId: "workspace",
      }),
    ).resolves.toBeDefined();
    await manager.closeAgent(id);
    await accounts.logout(account.id);
  });

  it("discovers catalogs by account and directory and invalidates them on account changes", async () => {
    const { add, manager, directory, accountClients, accounts } = await setup();
    const a = await add("codex", "A");
    const b = await add("codex", "B");
    const clients = [a, b].map((account) => {
      const client = createTestAgentClient("codex");
      vi.spyOn(client, "fetchCatalog").mockResolvedValue({
        models: [{ id: account.label, label: account.label }],
        modes: [],
      });
      accountClients.set(account.id, client);
      return client;
    });
    const request = {
      provider: "codex" as const,
      selection: { kind: "fixed" as const, accountId: a.id },
      cwd: directory,
    };
    expect((await manager.getAccountCatalog(request)).entry?.models?.[0].id).toBe("A");
    expect(
      (
        await manager.getAccountCatalog({
          ...request,
          selection: { kind: "fixed", accountId: b.id },
        })
      ).entry?.models?.[0].id,
    ).toBe("B");
    await manager.getAccountCatalog(request);
    expect(clients[0].fetchCatalog).toHaveBeenCalledTimes(1);
    await manager.getAccountCatalog({ ...request, cwd: path.join(directory, "another") });
    expect(clients[0].fetchCatalog).toHaveBeenCalledTimes(2);
    await accounts.edit(a.id, { label: "Renamed A" });
    await manager.getAccountCatalog(request);
    expect(clients[0].fetchCatalog).toHaveBeenCalledTimes(3);
    await expect(manager.getAccountCatalog({ ...request, provider: "claude" })).rejects.toThrow(
      "do not match",
    );
  });

  it("keeps automatic model discovery available when generation capacity is exhausted", async () => {
    const { add, manager, accounts, directory, accountClients } = await setup(100);
    const account = await add("codex", "Full account");
    const client = createTestAgentClient("codex");
    vi.spyOn(client, "fetchCatalog").mockResolvedValue({
      models: [{ id: "test-model", label: "Test model" }],
      modes: [],
    });
    accountClients.set(account.id, client);
    await accounts.usage(account.id);
    expect(accounts.preview("codex").accountId).toBeNull();
    const result = await manager.getAccountCatalog({
      provider: "codex",
      cwd: directory,
      selection: { kind: "automatic" },
    });
    expect(result.entry?.models?.[0].id).toBe("test-model");
    expect(accounts.hasRuntime(account.id)).toBe(false);
    await expect(accounts.reserve({ provider: "codex", unattended: false })).rejects.toThrow();
  });

  it("keeps concurrent account handoff requests distinct and retries a failed B startup", async () => {
    const { add, manager, directory, agentStorage, logger, accountClients } = await setup();
    const a = await add("codex", "A");
    const b = await add("codex", "B");
    const source = await manager.createAgent(
      { provider: "codex", cwd: directory, accountSelection: { kind: "fixed", accountId: a.id } },
      undefined,
      { workspaceId: "workspace" },
    );
    const targetClient = createTestAgentClient("codex");
    vi.spyOn(targetClient, "createSession").mockRejectedValueOnce(new Error("B startup failed"));
    accountClients.set(b.id, targetClient);
    const deps = {
      agentManager: manager,
      agentStorage,
      logger,
      getWorkspace: async () => ({ cwd: directory }),
      providerSnapshotManager: {
        resolveCreateConfig: async () => ({ modeId: "default", featureValues: {} }),
      },
    };
    const request = {
      sourceAgentId: source.id,
      provider: "codex",
      accountSelection: { kind: "fixed" as const, accountId: b.id },
    };
    const results = await Promise.allSettled([
      handoffAgent(deps, request),
      handoffAgent(deps, { ...request, accountSelection: { kind: "fixed", accountId: a.id } }),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect((await agentStorage.list()).length).toBe(2);
    const target = await handoffAgent(deps, request);
    expect(target.config?.accountId).toBe(b.id);
    expect((await agentStorage.list()).length).toBe(2);
  });

  it.each(["claude", "codex"] as const)(
    "pins %s imports before provider startup and preserves the native handle on failure",
    async (provider) => {
      const { add, manager, directory, agentStorage, accountClients, logger } = await setup();
      const a = await add(provider, "A");
      const b = await add(provider, "B");
      const clientA = createTestAgentClient(provider);
      const clientB = createTestAgentClient(provider);
      clientA.importSession = async (request, context) =>
        importSessionFromPersistence({
          provider,
          request,
          context,
          resumeSession: clientA.resumeSession.bind(clientA),
        });
      clientB.importSession = async () => {
        const pinned = (await agentStorage.list()).find(
          (record) => record.config?.accountId === b.id,
        );
        expect(pinned?.persistence?.sessionId).toBe("same-native-id");
        throw new Error("Import history unavailable");
      };
      accountClients.set(a.id, clientA);
      accountClients.set(b.id, clientB);
      const imported = await manager.importProviderSession({
        provider,
        accountId: a.id,
        providerHandleId: "same-native-id",
        cwd: directory,
        workspaceId: "workspace",
      });
      expect(imported.config.accountId).toBe(a.id);
      await expect(
        manager.importProviderSession({
          provider,
          accountId: b.id,
          providerHandleId: "same-native-id",
          cwd: directory,
          workspaceId: "workspace",
        }),
      ).rejects.toThrow("Import history unavailable");
      const failed = (await agentStorage.list()).find(
        (record) => record.config?.accountId === b.id,
      )!;
      expect(failed.lastStatus).toBe("error");
      expect(failed.persistence?.sessionId).toBe("same-native-id");
      const restored = await ensureAgentLoaded(failed.id, {
        agentManager: manager,
        agentStorage,
        logger,
      });
      expect(restored?.config.accountId).toBe(b.id);
      expect(restored?.persistence?.sessionId).toBe("same-native-id");
      expect(imported.config.accountId).toBe(a.id);
    },
  );
});
