import { describe, expect, it } from "vitest";
import { createProviderEnv } from "./provider-launch-config.js";

describe("account runtime environment", () => {
  it("pins subscription credentials after provider and per-agent overrides", () => {
    const env = createProviderEnv({
      baseEnv: { ANTHROPIC_API_KEY: "default-key", CODEX_ACCESS_TOKEN: "default-token" },
      runtimeSettings: {
        env: { CLAUDE_CONFIG_DIR: "/default" },
        accountContext: { accountId: "b", provider: "claude", configDir: "/accounts/b" },
      },
      overlays: [{ CLAUDE_CONFIG_DIR: "/accounts/a", CLAUDE_CODE_OAUTH_TOKEN: "other-token" }],
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/accounts/b");
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/accounts/b");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("pins Codex home and removes subscription bypasses after every overlay", () => {
    const env = createProviderEnv({
      baseEnv: {
        CODEX_HOME: "/default",
        OPENAI_API_KEY: "other",
        OPENAI_BASE_URL: "https://other.invalid",
      },
      runtimeSettings: {
        accountContext: { accountId: "b", provider: "codex", configDir: "/accounts/b" },
      },
      overlays: [
        { CODEX_HOME: "/accounts/a", CODEX_ACCESS_TOKEN: "other", OPENAI_API_KEY: "override" },
      ],
    });
    expect(env.CODEX_HOME).toBe("/accounts/b");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("preserves external aliases when no managed account was selected", () => {
    const env = createProviderEnv({
      baseEnv: {},
      runtimeSettings: {
        env: { OPENAI_BASE_URL: "http://localhost:8000", OPENAI_API_KEY: "local" },
      },
    });
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:8000");
    expect(env.OPENAI_API_KEY).toBe("local");
  });
});
