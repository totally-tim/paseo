import { homedir } from "node:os";
import path from "node:path";
import type { ProcessEnvRecord } from "../paseo-env.js";

/** Host-only launch context. Never serialize this into an agent or wire message. */
export interface ProviderAccountContext {
  accountId: string;
  provider: "claude" | "codex";
  configDir: string;
}

const SUBSCRIPTION_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CONFIG_PATH",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_AUTH_TOKEN",
] as const;

export function applyProviderAccountEnv(
  env: ProcessEnvRecord,
  context: ProviderAccountContext,
): void {
  // Apply last: a caller's launch env must never change a pinned identity.
  for (const key of SUBSCRIPTION_AUTH_ENV) env[key] = undefined;
  if (context.provider === "claude") {
    env.CLAUDE_CONFIG_DIR = context.configDir;
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = context.configDir;
  } else {
    env.CODEX_HOME = context.configDir;
  }
}

export function providerConfigDir(provider: "claude" | "codex", env: NodeJS.ProcessEnv): string {
  const configured = env[provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"];
  return configured || path.join(homedir(), provider === "claude" ? ".claude" : ".codex");
}
