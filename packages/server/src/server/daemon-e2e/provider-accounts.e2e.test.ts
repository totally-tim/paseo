import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { createDaemonTestContext } from "../test-utils/daemon-test-context.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { AgentClient } from "../agent/agent-sdk-types.js";

vi.mock("../provider-accounts/provider-backends.js", () => ({
  createAccountBackend: ({ account }: { account: { id: string; provider: string } }) => ({
    inspect: async () => ({ key: account.id, email: `${account.id}@example.invalid` }),
    login: async () => {
      throw new Error("SECRET_PROVIDER_STDOUT");
    },
    logout: async () => undefined,
    usage: async () => ({
      providerId: account.provider,
      displayName: "Account",
      status: "available",
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", usedPct: 10 }],
    }),
  }),
}));

test("account RPCs preserve both providers' handoff pins and historical context through restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-rpc-"));
  const clients = new Map<string, AgentClient>();
  const factory = vi
    .spyOn(ProviderSnapshotManager.prototype, "createAccountClient")
    .mockImplementation((provider, context) => {
      let client = clients.get(context.accountId);
      if (!client) {
        client = createTestAgentClient(provider);
        clients.set(context.accountId, client);
      }
      return client;
    });
  const options = { paseoHomeRoot: root, staticDir: join(root, "static"), cleanup: false };
  let ctx = await createDaemonTestContext(options);
  const sources: Array<{ id: string; accountId: string; target: string }> = [];
  try {
    for (const provider of ["claude", "codex"] as const) {
      const a = (
        await ctx.client.manageProviderAccount({ kind: "add", provider, label: `${provider} A` })
      ).account!;
      const b = (
        await ctx.client.manageProviderAccount({ kind: "add", provider, label: `${provider} B` })
      ).account!;
      for (const account of [a, b])
        expect(
          (await ctx.client.manageProviderAccount({ kind: "inspect", accountId: account.id }))
            .account?.authState,
        ).toBe("ready");
      const source = await ctx.client.createAgent({
        provider,
        cwd: root,
        accountSelection: { kind: "fixed", accountId: a.id },
        initialPrompt: `Preserve ${provider} account context`,
        clientMessageId: `${provider}-source`,
      });
      await ctx.client.waitForFinish(source.id, 10000);
      const removal = await ctx.client.manageProviderAccount({
        kind: "remove",
        accountId: a.id,
        credentials: "logout",
      });
      expect(removal.error).toContain("Close this account's agents");
      const target = await ctx.client.handoffAgent({
        sourceAgentId: source.id,
        provider,
        accountSelection: { kind: "fixed", accountId: b.id },
      });
      expect(target.accountId).toBe(b.id);
      expect(source.accountId).toBe(a.id);
      expect(target.workspaceId).toBe(source.workspaceId);
      await ctx.client.waitForFinish(target.id, 10000);
      expect(JSON.stringify((await ctx.client.fetchAgentTimeline(target.id)).entries)).toContain(
        `Preserve ${provider} account context`,
      );
      expect(ctx.daemon.daemon.agentManager.getAgent(source.id)).toBeNull();
      expect(
        (
          await ctx.client.handoffAgent({
            sourceAgentId: source.id,
            provider,
            accountSelection: { kind: "fixed", accountId: b.id },
          })
        ).id,
      ).toBe(target.id);
      sources.push({ id: source.id, accountId: a.id, target: target.id });
    }
    const failed = (
      await ctx.client.manageProviderAccount({
        kind: "add",
        provider: "codex",
        label: "Login failure",
      })
    ).account!;
    const login = await ctx.client.manageProviderAccount({
      kind: "login-start",
      accountId: failed.id,
    });
    expect(JSON.stringify(login)).not.toContain("SECRET_PROVIDER_STDOUT");
    await expect
      .poll(
        async () =>
          (await ctx.client.listProviderAccounts()).accounts.find((a) => a.id === failed.id)
            ?.authState,
      )
      .toBe("signed-out");
    expect(JSON.stringify(await ctx.client.listProviderAccounts())).not.toContain(
      "SECRET_PROVIDER_STDOUT",
    );
    expect(
      await readFile(join(ctx.daemon.paseoHome, "provider-accounts/accounts.json"), "utf8"),
    ).not.toContain("SECRET_PROVIDER_STDOUT");
    await ctx.cleanup();
    ctx = await createDaemonTestContext(options);
    for (const source of sources) {
      const history = await ctx.client.fetchAgentTimeline(source.id);
      expect(history.agent?.accountId).toBe(source.accountId);
      expect(JSON.stringify(history.entries)).toContain("account context");
      await expect(ctx.client.sendMessage(source.id, "Reopen")).rejects.toThrow("continued in");
    }
  } finally {
    await ctx.cleanup();
    factory.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
