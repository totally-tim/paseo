import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
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
      for (const account of [a, b]) {
        expect(
          (await ctx.client.manageProviderAccount({ kind: "inspect", accountId: account.id }))
            .account?.authState,
        ).toBe("ready");
        expect(
          (
            await ctx.client.manageProviderAccount({
              kind: "edit",
              accountId: account.id,
              changes: { enabled: true },
            })
          ).error,
        ).toBeNull();
      }
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

test("managed account homes link the host user layer and keep account state private", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-user-layer-e2e-"));
  const claudeHost = join(root, "host-claude");
  const codexHost = join(root, "host-codex");
  await mkdir(claudeHost, { recursive: true });
  await mkdir(codexHost, { recursive: true });
  await mkdir(join(claudeHost, "skills", "host-skill"), { recursive: true });
  await mkdir(join(claudeHost, "agents"));
  await writeFile(join(claudeHost, "settings.json"), "{}");
  await writeFile(join(claudeHost, "CLAUDE.md"), "# user instructions");
  await writeFile(join(codexHost, "AGENTS.md"), "# agent rules");
  await writeFile(join(codexHost, "config.toml"), "model = 'x'");
  await mkdir(join(codexHost, "skills", "host-skill"), { recursive: true });
  await mkdir(join(codexHost, "skills", ".system"), { recursive: true });

  const ctx = await createDaemonTestContext({
    paseoHomeRoot: root,
    staticDir: join(root, "static"),
    cleanup: false,
    dependencies: {
      accountStoreOptions: {
        resolveHostConfigDir: (provider) => (provider === "claude" ? claudeHost : codexHost),
      },
    },
  });
  try {
    const claude = (
      await ctx.client.manageProviderAccount({ kind: "add", provider: "claude", label: "C" })
    ).account!;
    const codex = (
      await ctx.client.manageProviderAccount({ kind: "add", provider: "codex", label: "X" })
    ).account!;
    const claudeHome = join(ctx.daemon.paseoHome, "provider-accounts", claude.id);
    const codexHome = join(ctx.daemon.paseoHome, "provider-accounts", codex.id);

    expect(readlinkSync(join(claudeHome, "skills"))).toBe(join(claudeHost, "skills"));
    expect(readlinkSync(join(claudeHome, "settings.json"))).toBe(join(claudeHost, "settings.json"));
    expect(readlinkSync(join(claudeHome, "CLAUDE.md"))).toBe(join(claudeHost, "CLAUDE.md"));
    // Account state is not shared in: no host .claude.json or projects are linked.
    expect(existsSync(join(claudeHome, ".claude.json"))).toBe(false);
    expect(existsSync(join(claudeHome, "projects"))).toBe(false);

    expect(readlinkSync(join(codexHome, "AGENTS.md"))).toBe(join(codexHost, "AGENTS.md"));
    expect(readlinkSync(join(codexHome, "config.toml"))).toBe(join(codexHost, "config.toml"));
    const codexSkills = lstatSync(join(codexHome, "skills"));
    expect(codexSkills.isDirectory()).toBe(true);
    expect(codexSkills.isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(codexHome, "skills", "host-skill"))).toBe(
      join(codexHost, "skills", "host-skill"),
    );
    expect(existsSync(join(codexHome, "skills", ".system"))).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  } finally {
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
