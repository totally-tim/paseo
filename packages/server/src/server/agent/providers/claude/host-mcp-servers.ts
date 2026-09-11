import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { McpServerConfig } from "../../agent-sdk-types.js";

/**
 * User-scope and local-scope MCP servers live inside ~/.claude.json, which also
 * holds the OAuth identity and per-project state. That file stays per-account, so
 * managed sessions get the host's servers injected through the SDK instead.
 */
export function loadHostClaudeMcpServers(params: {
  hostConfigDir: string;
  cwd?: string;
}): Record<string, McpServerConfig> {
  const data = readClaudeState(hostClaudeStatePath(params.hostConfigDir));
  if (!data) return {};
  const result: Record<string, McpServerConfig> = {};
  collectServers(result, data["mcpServers"]);
  const projects = data["projects"];
  if (params.cwd && projects && typeof projects === "object") {
    const project = (projects as Record<string, unknown>)[params.cwd];
    if (project && typeof project === "object") {
      collectServers(result, (project as Record<string, unknown>)["mcpServers"]);
    }
  }
  return result;
}

/**
 * With the default config dir the state file sits beside it (~/.claude.json);
 * under a custom CLAUDE_CONFIG_DIR it moves inside the directory.
 */
function hostClaudeStatePath(hostConfigDir: string): string {
  const defaultDir = path.join(homedir(), ".claude");
  return hostConfigDir === defaultDir
    ? path.join(homedir(), ".claude.json")
    : path.join(hostConfigDir, ".claude.json");
}

function readClaudeState(statePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectServers(result: Record<string, McpServerConfig>, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  for (const [name, config] of Object.entries(raw)) {
    const server = toMcpServerConfig(config);
    if (server) result[name] = server;
  }
}

function toMcpServerConfig(raw: unknown): McpServerConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const type = entry["type"];
  if (type === "http" || type === "sse") {
    if (typeof entry["url"] !== "string") return undefined;
    const headers = pickStringMap(entry["headers"]);
    return { type, url: entry["url"], ...(headers ? { headers } : {}) };
  }
  if (type !== undefined && type !== "stdio") return undefined;
  if (typeof entry["command"] !== "string") return undefined;
  const args = pickStringList(entry["args"]);
  const env = pickStringMap(entry["env"]);
  return {
    type: "stdio",
    command: entry["command"],
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

function pickStringMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === "string") value[key] = item;
  }
  return Object.keys(value).length > 0 ? value : undefined;
}

function pickStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) return undefined;
  return raw;
}
