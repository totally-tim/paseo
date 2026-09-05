import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { createPaseoDaemon, type PaseoDaemonDependencies } from "../bootstrap.js";
import type { AgentClient, AgentSession, AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { createTestAgentClient, createTestAgentClients } from "./fake-agent-client.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { DaemonClient } from "./daemon-client.js";

/** Real daemon/RPC/persistence, with controlled provider turns and account readings. */
export async function createContinuationTestDaemon() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-continuation-daemon-"));
  const used = new Map<string, number>();
  const sessions = new Map<
    string,
    {
      emit: (event: AgentStreamEvent) => void;
      finish: () => void;
    }
  >();
  const clients = new Map<string, AgentClient>();
  const starts: Array<{ accountId: string; text: string }> = [];
  const dependencies: PaseoDaemonDependencies = {
    accountBackend: (account) => ({
      inspect: async () =>
        account.ownership === "managed"
          ? { key: account.id, email: `${account.label}@example.invalid` }
          : null,
      login: async () => ({ key: account.id }),
      logout: async () => {},
      usage: async () => ({
        providerId: account.provider,
        displayName: account.label,
        status: "available",
        planLabel: "Simulated",
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            usedPct: used.get(account.id) ?? 100,
            resetsAt: new Date(Date.now() + 20_000).toISOString(),
          },
        ],
      }),
    }),
    accountClient: (provider, context) => {
      const existing = clients.get(context.accountId);
      if (existing) return existing;
      const client = createTestAgentClient(provider, {
        supportsMcpServers: true,
        onStartTurn: (prompt) =>
          starts.push({ accountId: context.accountId, text: JSON.stringify(prompt) }),
      });
      const control = (session: AgentSession) => {
        const listeners = new Set<(event: AgentStreamEvent) => void>();
        let terminal: AgentStreamEvent | undefined;
        const emit = (event: AgentStreamEvent) => {
          for (const listener of listeners) listener(event);
        };
        session.subscribe((event) => {
          if (event.type === "turn_completed" || event.type === "turn_failed") terminal = event;
          else emit(event);
        });
        session.subscribe = (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        };
        sessions.set(context.accountId, {
          emit,
          finish: () => {
            if (terminal) {
              const event = terminal;
              terminal = undefined;
              emit(event);
            }
          },
        });
        return session;
      };
      const create = client.createSession.bind(client);
      client.createSession = async (...args) => control(await create(...args));
      const resume = client.resumeSession.bind(client);
      client.resumeSession = async (...args) => control(await resume(...args));
      clients.set(context.accountId, client);
      return client;
    },
  };
  const initial = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    dependencies,
    agentClients: createTestAgentClients(),
    corsAllowedOrigins: ["http://localhost:8095", "http://127.0.0.1:8095"],
  });
  let daemon = initial.daemon;
  const config = { ...initial.config, listen: `127.0.0.1:${initial.port}` };
  const connected: DaemonClient[] = [];
  const connect = async () => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${initial.port}/ws`,
      appVersion: "0.7.2",
    });
    await client.connect();
    connected.push(client);
    return client;
  };
  const client = await connect();
  const accounts = daemon.agentManager.accounts!;
  const a = await accounts.add("codex", "Account A");
  const b = await accounts.add("codex", "Account B");
  await accounts.inspect(a.id);
  await accounts.inspect(b.id);
  used.set(a.id, 10);
  used.set(b.id, 20);
  const workspace = await client.createWorkspace({
    source: { kind: "directory", path: root },
    title: "Continuation QA",
  });
  if (!workspace.workspace) throw new Error(workspace.error ?? "Missing test workspace");
  return {
    root,
    port: initial.port,
    paseoHome: initial.paseoHome,
    client,
    connect,
    a: a.id,
    b: b.id,
    workspaceId: workspace.workspace.id,
    used,
    starts,
    get daemon() {
      return daemon;
    },
    async start(title = "Capacity recovery task") {
      return client.createAgent({
        provider: "codex",
        cwd: root,
        workspaceId: workspace.workspace!.id,
        title,
        accountSelection: { kind: "fixed", accountId: a.id },
        continuationPolicy: { accountIds: [a.id, b.id] },
        model: "gpt-5.4-mini",
        modeId: "default",
        initialPrompt: "Investigate the project and report your findings.",
        clientMessageId: randomUUID(),
      });
    },
    capacity(accountId: string) {
      used.set(accountId, 100);
      sessions.get(accountId)?.emit({
        type: "timeline",
        provider: "codex",
        item: {
          type: "notification",
          code: "provider_capacity",
          level: "warning",
          message: "The provider confirmed a usage limit.",
        },
      });
    },
    finish(accountId: string) {
      sessions.get(accountId)?.finish();
    },
    async restart() {
      await daemon.stop();
      clients.clear();
      sessions.clear();
      daemon = await createPaseoDaemon(config, pino({ level: "silent" }), dependencies);
      await daemon.start();
      await client.connect();
    },
    async close() {
      for (const connection of connected) await connection.close();
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
      await rm(initial.staticDir, { recursive: true, force: true });
    },
  };
}
