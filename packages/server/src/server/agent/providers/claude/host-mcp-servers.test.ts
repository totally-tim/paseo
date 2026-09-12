import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHostClaudeMcpServers } from "./host-mcp-servers.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function hostDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-claude-mcp-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeState(host: string, state: unknown): void {
  writeFileSync(path.join(host, ".claude.json"), JSON.stringify(state));
}

describe("loadHostClaudeMcpServers", () => {
  it("returns user-scope servers, defaulting a missing type to stdio", async () => {
    const host = await hostDir();
    writeState(host, {
      mcpServers: {
        railway: { command: "railway", args: ["mcp"] },
        docs: { type: "http", url: "https://example.invalid/mcp", headers: { "x-a": "b" } },
        local: {
          type: "stdio",
          command: "/bin/server",
          args: ["--flag"],
          env: { API_KEY: "k" },
        },
      },
    });
    const servers = loadHostClaudeMcpServers({ hostConfigDir: host });
    expect(servers["railway"]).toEqual({ type: "stdio", command: "railway", args: ["mcp"] });
    expect(servers["docs"]).toEqual({
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { "x-a": "b" },
    });
    expect(servers["local"]).toEqual({
      type: "stdio",
      command: "/bin/server",
      args: ["--flag"],
      env: { API_KEY: "k" },
    });
  });

  it("adds local-scope servers for the session cwd only", async () => {
    const host = await hostDir();
    const cwd = path.join(host, "project");
    writeState(host, {
      mcpServers: { shared: { type: "http", url: "https://example.invalid" } },
      projects: {
        [cwd]: { mcpServers: { local: { command: "/bin/local" } } },
        [path.join(host, "other")]: { mcpServers: { other: { command: "/bin/other" } } },
      },
    });
    const servers = loadHostClaudeMcpServers({ hostConfigDir: host, cwd });
    expect(Object.keys(servers).sort()).toEqual(["local", "shared"]);
  });

  it("drops malformed entries and keeps valid ones", async () => {
    const host = await hostDir();
    writeState(host, {
      mcpServers: {
        good: { command: "/bin/ok" },
        noCommand: { type: "stdio" },
        noUrl: { type: "http" },
        badType: { type: "weird", command: "/bin/x" },
        notAnObject: "nope",
      },
    });
    const servers = loadHostClaudeMcpServers({ hostConfigDir: host });
    expect(Object.keys(servers)).toEqual(["good"]);
  });

  it("returns empty when the state file is missing or malformed", async () => {
    const host = await hostDir();
    expect(loadHostClaudeMcpServers({ hostConfigDir: host })).toEqual({});
    writeFileSync(path.join(host, ".claude.json"), "not json {");
    expect(loadHostClaudeMcpServers({ hostConfigDir: host })).toEqual({});
    writeFileSync(path.join(host, ".claude.json"), JSON.stringify([1, 2]));
    expect(loadHostClaudeMcpServers({ hostConfigDir: host })).toEqual({});
  });
});
