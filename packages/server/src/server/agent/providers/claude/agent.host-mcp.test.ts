import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

function queryEvents(sessionId: string): unknown[] {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      permissionMode: "default",
      model: "opus",
    },
    { type: "assistant", message: { content: "done" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
}

describe("Claude host MCP servers", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("merges host user- and local-scope servers under the session's for managed accounts", async () => {
    const cwd = process.cwd();
    const root = await mkdtemp(path.join(tmpdir(), "paseo-host-mcp-session-"));
    roots.push(root);
    const hostDir = path.join(root, "host");
    const managedDir = path.join(root, "managed");
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      path.join(hostDir, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "host-only": { command: "host-cmd" },
          shared: { command: "host-version" },
        },
        projects: {
          [cwd]: {
            mcpServers: { "local-only": { type: "http", url: "http://localhost:1" } },
          },
          "/other/path": { mcpServers: { "other-project": { command: "nope" } } },
        },
      }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", hostDir);

    let captured: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      captured = options;
      return createQueryMock(queryEvents("host-mcp-session"));
    });
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000301",
        CLAUDE_CONFIG_DIR: managedDir,
      },
    };
    const session = await client.createSession(
      {
        provider: "claude",
        cwd,
        mcpServers: {
          shared: { type: "stdio", command: "session-version" },
          paseo: { type: "http", url: "http://127.0.0.1:9/mcp" },
        },
      },
      launchContext,
    );
    try {
      await session.run("mcp merge check");
    } finally {
      await session.close();
    }

    const servers = captured?.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers["host-only"]).toEqual({ type: "stdio", command: "host-cmd" });
    expect(servers["local-only"]).toEqual({ type: "http", url: "http://localhost:1" });
    // Session config wins name conflicts, and the injected paseo server survives.
    expect(servers.shared).toEqual({ type: "stdio", command: "session-version" });
    expect(servers.paseo).toEqual({ type: "http", url: "http://127.0.0.1:9/mcp" });
    // Local scope only matches the exact session cwd.
    expect(servers["other-project"]).toBeUndefined();
  });

  test("does not inject host servers when the session uses the daemon's own config dir", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-host-mcp-session-"));
    roots.push(root);
    const hostDir = path.join(root, "host");
    await mkdir(hostDir, { recursive: true });
    await writeFile(
      path.join(hostDir, ".claude.json"),
      JSON.stringify({ mcpServers: { "host-only": { command: "host-cmd" } } }),
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", hostDir);

    let captured: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      captured = options;
      return createQueryMock(queryEvents("host-mcp-unmanaged"));
    });
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      mcpServers: { session: { type: "stdio", command: "s" } },
    });
    try {
      await session.run("unmanaged check");
    } finally {
      await session.close();
    }

    const servers = captured?.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.session).toEqual({ type: "stdio", command: "s" });
    expect(servers["host-only"]).toBeUndefined();
  });
});
