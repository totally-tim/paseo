import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "../../server/messages.js";
import type { ProviderUsageFetcher } from "./provider.js";
import { CopilotQuotaProvider } from "./providers/copilot.js";
import { CursorQuotaProvider } from "./providers/cursor.js";
import { GrokQuotaProvider } from "./providers/grok.js";
import { KimiQuotaProvider } from "./providers/kimi.js";
import { MiniMaxQuotaProvider } from "./providers/minimax.js";
import { ZaiQuotaProvider } from "./providers/zai.js";
import { ProviderUsageService } from "./service.js";

function kimiCredentialPath(dir: string): string {
  return join(dir, "credentials", "kimi-code.json");
}

function writeKimiCredentials(dir: string, accessToken: string, overrides: object = {}): void {
  mkdirSync(join(dir, "credentials"), { recursive: true });
  writeFileSync(
    kimiCredentialPath(dir),
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "rt_kimi",
      expires_at: 1_798_812_800,
      expires_in: 900,
      scope: "kimi-code",
      token_type: "Bearer",
      ...overrides,
    }),
  );
}

// node:sqlite has no @types/node@20 typings; require it with a narrow local type.
const testRequire = createRequire(import.meta.url);
interface TestSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
}

// Cursor builds have stored ItemTable values as both TEXT and BLOB. Keys map to the
// real layouts: a plain modern token or the legacy JSON object.
function writeCursorStateDb(homeDir: string, rows: Record<string, string | Uint8Array>): void {
  const dir = join(homeDir, ".config", "Cursor", "User", "globalStorage");
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = testRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => TestSqliteDb;
  };
  const db = new DatabaseSync(join(dir, "state.vscdb"));
  db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) {
    insert.run(key, value);
  }
  db.close();
}

function writeCursorAuthJson(homeDir: string, accessToken: string): void {
  const dir = join(homeDir, ".config", "cursor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ accessToken }));
}

function writeGrokAuth(home: string, auth: Record<string, unknown>): void {
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify(auth));
}

function writeMiniMaxConfig(dir: string, payload: Record<string, unknown>): void {
  mkdirSync(join(dir, ".mmx"), { recursive: true });
  writeFileSync(join(dir, ".mmx", "config.json"), JSON.stringify(payload));
}

function writeMiniMaxCredentials(
  dir: string,
  accessToken: string,
  expiresAt?: string,
  resourceUrl?: string,
): void {
  mkdirSync(join(dir, ".mmx"), { recursive: true });
  const payload: Record<string, unknown> = { access_token: accessToken };
  if (expiresAt !== undefined) payload["expires_at"] = expiresAt;
  if (resourceUrl !== undefined) payload["resource_url"] = resourceUrl;
  writeFileSync(join(dir, ".mmx", "credentials.json"), JSON.stringify(payload));
}

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createLogger() {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as never;
}

function usageFetcher(usage: ProviderUsage): ProviderUsageFetcher {
  return {
    providerId: usage.providerId,
    displayName: usage.displayName,
    fetchUsage: async () => usage,
  };
}

function findProvider(result: { providers: ProviderUsage[] }, providerId: string): ProviderUsage {
  const provider = result.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) {
    throw new Error(`Missing provider ${providerId}`);
  }
  return provider;
}

describe("ProviderUsageService", () => {
  it("returns arbitrary registered providers and windows as normalized usage data", async () => {
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        usageFetcher({
          providerId: "glm",
          displayName: "GLM coding plan",
          status: "available",
          planLabel: "GLM coding plan",
          windows: [
            {
              id: "biweekly",
              label: "Biweekly",
              usedPct: 23,
              remainingPct: 77,
              resetsAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        }),
      ],
    });

    await expect(service.listUsage()).resolves.toEqual({
      fetchedAt: "2026-06-19T00:00:00.000Z",
      providers: [
        {
          providerId: "glm",
          displayName: "GLM coding plan",
          status: "available",
          planLabel: "GLM coding plan",
          windows: [
            {
              id: "biweekly",
              label: "Biweekly",
              usedPct: 23,
              remainingPct: 77,
              resetsAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("caches usage until forced to refresh", async () => {
    let now = Date.parse("2026-06-19T00:00:00.000Z");
    let calls = 0;
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => now,
      cacheTtlMs: 60_000,
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: async () => {
            calls += 1;
            return {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: "Max 20x",
              windows: [{ id: "session", label: "Session", usedPct: calls }],
            };
          },
        },
      ],
    });

    const first = await service.listUsage();
    now += 30_000;
    const cached = await service.listUsage();
    const refreshed = await service.listUsage({ forceRefresh: true });

    expect(calls).toBe(2);
    expect(cached).toBe(first);
    expect(refreshed.providers[0]?.windows[0]?.usedPct).toBe(2);
  });

  it("invalidates changed account revisions and cannot cache a late old response", async () => {
    let revision = "A:1";
    const pending: Array<(usage: ProviderUsage) => void> = [];
    const service = new ProviderUsageService({
      logger: createLogger(),
      cacheKey: () => revision,
      fetchers: [
        {
          providerId: "codex",
          displayName: "Codex",
          fetchUsage: () => new Promise<ProviderUsage>((resolve) => pending.push(resolve)),
        },
      ],
    });
    const first = service.listUsage();
    revision = "A:2";
    const second = service.listUsage();
    expect(pending).toHaveLength(2);
    const current: ProviderUsage = {
      providerId: "codex",
      displayName: "Current",
      status: "available",
      planLabel: null,
      windows: [],
    };
    pending[1]!(current);
    const secondResult = await second;
    pending[0]!({ ...current, displayName: "Old" });
    await first;
    expect(await service.listUsage()).toBe(secondResult);
  });

  it("deduplicates concurrent cache misses", async () => {
    let calls = 0;
    let resolveUsage: ((usage: ProviderUsage) => void) | null = null;
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: () => {
            calls += 1;
            return new Promise<ProviderUsage>((resolve) => {
              resolveUsage = resolve;
            });
          },
        },
      ],
    });

    const first = service.listUsage();
    const second = service.listUsage();

    expect(calls).toBe(1);
    resolveUsage?.({
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      planLabel: "Max 20x",
      windows: [{ id: "session", label: "Session", usedPct: 12 }],
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(calls).toBe(1);
  });

  it("isolates one provider error without dropping other providers", async () => {
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: async () => {
            throw new Error("Claude auth expired");
          },
        },
        usageFetcher({
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Pro 20x",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 29 }],
        }),
      ],
    });

    await expect(service.listUsage()).resolves.toEqual({
      fetchedAt: "2026-06-19T00:00:00.000Z",
      providers: [
        {
          providerId: "claude",
          displayName: "Claude",
          status: "error",
          planLabel: null,
          windows: [],
          balances: [],
          details: [],
          error: "Claude auth expired",
        },
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Pro 20x",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 29 }],
        },
      ],
    });
  });
});

describe("real provider usage fetchers", () => {
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-test-home-"));
    fetchApi = mockFetch(new Map());
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;

    for (const key of [
      "APPDATA",
      "COPILOT_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "CURSOR_ACCESS_TOKEN",
      "CURSOR_TOKEN",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "GROK_API_KEY",
      "GROK_TOKEN",
      "KIMI_TOKEN",
      "KIMI_API_KEY",
      "KIMI_CODE_HOME",
      "CODEX_HOME",
      "MINIMAX_API_KEY",
      "MINIMAX_BASE_URL",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key in originalEnv) {
      process.env[key] = originalEnv[key];
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  function service(
    options: {
      kimiHomeDir?: string;
      cursorHomeDir?: string;
      miniMaxConfigPath?: string;
      miniMaxCredentialsPath?: string;
    } = {},
  ) {
    const logger = createLogger();
    const fetchThroughTestDouble = ((url: RequestInfo | URL, init?: RequestInit) =>
      fetchApi(url, init)) as typeof fetch;
    return new ProviderUsageService({
      logger,
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        new CopilotQuotaProvider({ logger, fetch: fetchThroughTestDouble }),
        new CursorQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          homeDir: options.cursorHomeDir,
        }),
        new ZaiQuotaProvider({ logger, fetch: fetchThroughTestDouble }),
        new GrokQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          // Match Kimi: inject temp HOME so nested auth-file tests work on Windows
          // (os.homedir() uses USERPROFILE there and ignores process.env.HOME).
          homeDir,
        }),
        new KimiQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          // Never leave this undefined: the provider would fall back to os.homedir() and
          // read — and now write — the developer's real Kimi credentials.
          homeDir: options.kimiHomeDir ?? homeDir,
        }),
        new MiniMaxQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          configPath: options.miniMaxConfigPath ?? join(homeDir, ".mmx", "config.json"),
          credentialsPath:
            options.miniMaxCredentialsPath ?? join(homeDir, ".mmx", "credentials.json"),
        }),
      ],
      cacheTtlMs: 0,
    });
  }

  it("fetches Copilot usage from COPILOT_TOKEN", async () => {
    process.env["COPILOT_TOKEN"] = "copilot_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.github.com/copilot_internal/user",
          () =>
            jsonResponse({
              copilot_plan: "business",
              quota_reset_date: "2026-07-01T00:00:00Z",
            }),
        ],
      ]),
    );

    const copilot = findProvider(await service().listUsage(), "copilot");

    expect(copilot).toMatchObject({
      status: "available",
      planLabel: "business",
      details: [{ id: "reset", label: "Quota reset", value: "2026-07-01T00:00:00Z" }],
    });
  });

  it("fetches Cursor usage and normalizes malformed billing dates to null", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              planUsage: {
                totalSpend: "1500",
                includedSpend: "1000",
                bonusSpend: "500",
                remaining: "2500",
                limit: "4000",
              },
              billingCycleStart: "2026-01-14T12:42:14.000Z",
              billingCycleEnd: "not-a-date",
            }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "plan_usage",
          used: 15,
          remaining: 25,
          limit: 40,
          resetsAt: null,
        }),
      ],
    });
  });

  it("reads the Cursor token from the modern cursorAuth/accessToken key in state.vscdb", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_state_jwt" });
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_state_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "plan_usage", used: 15, remaining: 25, limit: 40 })],
    });
  });

  it("falls back to the legacy cursorAuthStatus JSON blob when the modern key is absent", async () => {
    writeCursorStateDb(homeDir, {
      cursorAuthStatus: Buffer.from(JSON.stringify({ accessToken: "cursor_legacy_jwt" }), "utf8"),
    });
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_legacy_jwt");
    expect(cursor.status).toBe("available");
  });

  it("reads the Cursor token from cursor-agent ~/.config/cursor/auth.json when desktop state is absent", async () => {
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: {
          totalSpend: "1500",
          includedSpend: "1000",
          bonusSpend: "500",
          remaining: "2500",
          limit: "4000",
        },
        billingCycleStart: "2026-01-14T12:42:14.000Z",
        billingCycleEnd: "2026-02-14T12:42:14.000Z",
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_cli_jwt");
    expect(cursor).toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ id: "plan_usage", used: 15, remaining: 25, limit: 40 })],
    });
  });

  it("prefers the desktop state.vscdb token over cursor-agent auth.json", async () => {
    writeCursorStateDb(homeDir, { "cursorAuth/accessToken": "cursor_desktop_jwt" });
    writeCursorAuthJson(homeDir, "cursor_cli_jwt");
    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        planUsage: { totalSpend: "0", remaining: "100", limit: "100" },
        billingCycleStart: null,
        billingCycleEnd: null,
      });
    }) as unknown as typeof fetch;

    const cursor = findProvider(await service({ cursorHomeDir: homeDir }).listUsage(), "cursor");

    expect(authorization).toBe("Bearer cursor_desktop_jwt");
    expect(cursor.status).toBe("available");
  });

  it("logs a debug diagnostic and stays unavailable when state.vscdb is unreadable", async () => {
    const dir = join(homeDir, ".config", "Cursor", "User", "globalStorage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.vscdb"), "not a sqlite database");
    const logger = createLogger();
    const provider = new CursorQuotaProvider({
      logger,
      fetch: (() => {
        throw new Error("usage API should not be called without a token");
      }) as unknown as typeof fetch,
      homeDir,
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining("state.vscdb") }),
      expect.stringContaining("Failed to read Cursor token"),
    );
  });

  it("fetches Z.ai usage from ZAI_API_KEY", async () => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.z.ai/api/biz/subscription/list",
          () =>
            jsonResponse({
              data: [
                {
                  productName: "GLM Coding Max",
                  status: "VALID",
                  purchaseTime: "2026-01-12 16:55:13",
                  valid: "2026-02-12 16:55:13-2026-03-12 16:55:13",
                },
              ],
            }),
        ],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");

    expect(zai).toMatchObject({
      status: "available",
      planLabel: "GLM Coding Max",
      details: expect.arrayContaining([{ id: "status", label: "Status", value: "VALID" }]),
    });
  });

  it("fetches Grok usage and preserves zero values", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: { monthlyLimit: { val: 0 }, used: { val: 0 } },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 0,
          remaining: 0,
          limit: 0,
        }),
      ],
    });
  });

  it("fetches Grok usage from live billing shape (config.used.val)", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: {
                monthlyLimit: { val: 150000 },
                used: { val: 37886 },
                billingPeriodStart: "2026-07-01T00:00:00+00:00",
                billingPeriodEnd: "2026-08-01T00:00:00+00:00",
              },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 37886,
          remaining: 112114,
          limit: 150000,
          unit: "credits",
        }),
      ],
    });
  });

  it("fetches Grok usage with nested ~/.grok/auth.json key token", async () => {
    writeGrokAuth(homeDir, {
      "https://auth.x.ai::test-user-id": {
        key: "nested_jwt_token",
        refresh_token: "rt_nested",
        expires_at: "2026-08-01T00:00:00Z",
        user_id: "test-user-id",
        email: "user@example.com",
      },
    });

    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        config: {
          monthlyLimit: { val: 100 },
          used: { val: 25 },
        },
      });
    }) as typeof fetch;

    const grok = findProvider(await service().listUsage(), "grok");

    expect(authorization).toBe("Bearer nested_jwt_token");
    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 25,
          remaining: 75,
          limit: 100,
        }),
      ],
    });
  });

  it("still accepts legacy Grok usage.creditUsage when config.used is absent", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: { monthlyLimit: { val: 50 } },
              usage: { creditUsage: 10 },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 10,
          remaining: 40,
          limit: 50,
        }),
      ],
    });
  });

  it("fetches Grok unified-billing usage as a weekly window", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: {
                currentPeriod: {
                  type: "USAGE_PERIOD_TYPE_WEEKLY",
                  start: "2026-08-24T09:41:40.001370+00:00",
                  end: "2026-08-31T09:41:40.001370+00:00",
                },
                creditUsagePercent: 76.0,
                isUnifiedBillingUser: true,
                billingPeriodStart: "2026-08-24T09:41:40.001370+00:00",
                billingPeriodEnd: "2026-08-31T09:41:40.001370+00:00",
              },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 76,
          remainingPct: 24,
          resetsAt: "2026-08-31T09:41:40.001370+00:00",
          tone: "warning",
        },
      ],
      balances: [],
    });
  });

  it("fetches Kimi usage from KIMI_TOKEN", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.kimi.com/coding/v1/usages",
          () =>
            jsonResponse({
              usage: {
                limit: "100",
                remaining: "74",
                resetTime: "2026-02-11T17:32:50Z",
              },
            }),
        ],
      ]),
    );

    const kimi = findProvider(await service().listUsage(), "kimi");

    expect(kimi).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({
          id: "coding_usage",
          usedPct: 26,
          remainingPct: 74,
          resetsAt: "2026-02-11T17:32:50Z",
        }),
      ],
    });
  });

  it("fetches Kimi usage from the CLI credential home", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "kimi_cli_token");
    let requestedUrl: string | null = null;
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url.toString();
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        usage: {
          limit: "200",
          remaining: "150",
          resetTime: "2026-06-23T05:12:17Z",
        },
      });
    }) as unknown as typeof fetch;

    const kimi = findProvider(await service({ kimiHomeDir: homeDir }).listUsage(), "kimi");

    expect(requestedUrl).toBe("https://api.kimi.com/coding/v1/usages");
    expect(authorization).toBe("Bearer kimi_cli_token");
    expect(kimi).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({
          id: "coding_usage",
          usedPct: 25,
          remainingPct: 75,
          resetsAt: "2026-06-23T05:12:17Z",
        }),
      ],
    });
  });

  it("reads Kimi credentials whose optional fields are null", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "kimi_cli_token", {
      expires_at: null,
      expires_in: null,
      scope: null,
      token_type: null,
    });
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.kimi.com/coding/v1/usages",
          () => jsonResponse({ usage: { limit: "100", remaining: "60" } }),
        ],
      ]),
    );

    const kimi = findProvider(await service({ kimiHomeDir: homeDir }).listUsage(), "kimi");

    expect(kimi.status).toBe("available");
  });

  it("returns unavailable on 401 without refreshing or rewriting the credential file", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "at_kimi_expired");
    const credPath = kimiCredentialPath(join(homeDir, ".kimi-code"));
    const before = readFileSync(credPath, "utf8");
    let usageCalls = 0;
    fetchApi = vi.fn(async (url: RequestInfo | URL) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.kimi.com/coding/v1/usages") {
        usageCalls += 1;
        return new Response(null, { status: 401 });
      }
      // The read-only fetcher must never hit the OAuth token endpoint.
      throw new Error(`Unmocked: ${endpoint}`);
    }) as never;

    const result = await service({ kimiHomeDir: homeDir }).listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
    expect(usageCalls).toBe(1);
    // The credentials file must be left untouched for the Kimi CLI to own.
    expect(readFileSync(credPath, "utf8")).toBe(before);
  });

  it("does not refresh Kimi tokens read from the environment", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const usageFetch = vi.fn(async () => new Response(null, { status: 401 }));
    fetchApi = usageFetch as never;

    const result = await service().listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
    expect(usageFetch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh Kimi tokens on a 403", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "at_kimi_forbidden");
    const usageFetch = vi.fn(async () => new Response(null, { status: 403 }));
    fetchApi = usageFetch as never;

    const result = await service({ kimiHomeDir: homeDir }).listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
    expect(usageFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches MiniMax usage from MINIMAX_API_KEY against the global endpoint", async () => {
    process.env["MINIMAX_API_KEY"] = "minimax_test_token";
    let requestedUrl: string | null = null;
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url.toString();
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        model_remains: [
          {
            model_name: "MiniMax-M2.7",
            end_time: Date.parse("2026-06-19T05:00:00.000Z"),
            weekly_end_time: Date.parse("2026-06-26T00:00:00.000Z"),
            current_interval_total_count: 1000,
            current_interval_usage_count: 250,
            current_interval_remaining_percent: 75,
            current_weekly_total_count: 5000,
            current_weekly_usage_count: 1200,
            current_weekly_remaining_percent: 76,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(requestedUrl).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect(authorization).toBe("Bearer minimax_test_token");
    expect(miniMax).toMatchObject({
      status: "available",
      windows: expect.arrayContaining([
        expect.objectContaining({
          id: "interval_MiniMax-M2.7",
          label: "MiniMax-M2.7 · Interval",
          usedPct: 25,
          remainingPct: 75,
          resetsAt: "2026-06-19T05:00:00.000Z",
        }),
        expect.objectContaining({
          id: "weekly_MiniMax-M2.7",
          label: "MiniMax-M2.7 · Weekly",
          usedPct: 24,
          remainingPct: 76,
          resetsAt: "2026-06-26T00:00:00.000Z",
        }),
      ]),
    });
  });

  it("returns unavailable MiniMax usage when no credentials are configured", async () => {
    fetchApi = vi.fn() as never;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(miniMax.status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("reads MiniMax OAuth credentials from the CLI credentials file", async () => {
    writeMiniMaxCredentials(
      homeDir,
      "minimax_oauth_token",
      "2030-01-01T00:00:00.000Z",
      "https://account.example.com",
    );
    let requestedUrl: string | null = null;
    fetchApi = (async (url: RequestInfo | URL) => {
      requestedUrl = url.toString();
      return jsonResponse({ model_remains: [] });
    }) as unknown as typeof fetch;

    await service().listUsage();

    expect(requestedUrl).toBe("https://account.example.com/v1/token_plan/remains");
  });

  it("falls back to MiniMax api_key in the CLI config file", async () => {
    writeMiniMaxConfig(homeDir, {
      api_key: "minimax_config_key",
      region: "cn",
    });
    let requestedUrl: string | null = null;
    fetchApi = (async (url: RequestInfo | URL) => {
      requestedUrl = url.toString();
      return jsonResponse({ model_remains: [] });
    }) as unknown as typeof fetch;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(requestedUrl).toBe("https://api.minimaxi.com/v1/token_plan/remains");
    expect(miniMax.status).toBe("unavailable");
  });

  it("marks exhausted MiniMax interval windows with a danger tone", async () => {
    process.env["MINIMAX_API_KEY"] = "minimax_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.minimax.io/v1/token_plan/remains",
          () =>
            jsonResponse({
              model_remains: [
                {
                  model_name: "MiniMax-M2.7",
                  end_time: Date.parse("2026-06-19T05:00:00.000Z"),
                  weekly_end_time: Date.parse("2026-06-26T00:00:00.000Z"),
                  current_interval_total_count: 100,
                  current_interval_usage_count: 100,
                  current_interval_remaining_percent: 0,
                  current_interval_status: 2,
                  current_weekly_total_count: 100,
                  current_weekly_usage_count: 10,
                  current_weekly_remaining_percent: 90,
                  current_weekly_status: 1,
                },
              ],
            }),
        ],
      ]),
    );

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(miniMax).toMatchObject({
      status: "available",
      windows: expect.arrayContaining([
        expect.objectContaining({
          id: "interval_MiniMax-M2.7",
          usedPct: 100,
          tone: "danger",
        }),
        expect.objectContaining({
          id: "weekly_MiniMax-M2.7",
          tone: "ok",
        }),
      ]),
    });
  });
});

describe("KimiQuotaProvider usage windows", () => {
  afterEach(() => {
    delete process.env["KIMI_TOKEN"];
    vi.restoreAllMocks();
  });

  it("normalizes weekly and enforced rolling usage windows", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        limited: true,
        usage: {
          limit: "100",
          used: "61",
          remaining: "39",
          resetTime: "2026-08-05T00:01:45Z",
        },
        limits: [
          {
            window: {
              duration: 300,
              timeUnit: "TIME_UNIT_MINUTE",
            },
            detail: {
              limit: "100",
              used: "100",
              resetTime: "2026-07-31T17:01:45Z",
            },
          },
        ],
      }),
    );
    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage).toMatchObject({
      status: "available",
      windows: [
        {
          id: "coding_usage",
          label: "Weekly limit",
          usedPct: 61,
          remainingPct: 39,
          resetsAt: "2026-08-05T00:01:45Z",
          tone: "ok",
        },
        {
          id: "coding_limit_300_time_unit_minute",
          label: "5-hour limit",
          usedPct: 100,
          remainingPct: 0,
          resetsAt: "2026-07-31T17:01:45Z",
          tone: "danger",
        },
      ],
    });
  });

  it("keeps valid windows when another limits entry is malformed", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const logger = createLogger() as unknown as { debug: ReturnType<typeof vi.fn> };
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        usage: {
          limit: "100",
          remaining: "75",
          resetTime: "2026-08-05T00:01:45Z",
        },
        limits: [
          { window: { duration: "invalid" }, detail: {} },
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "50" },
          },
        ],
      }),
    );
    const provider = new KimiQuotaProvider({ logger: logger as never, fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toHaveLength(2);
    expect(usage.windows[1]).toMatchObject({
      label: "5-hour limit",
      usedPct: 50,
      remainingPct: 50,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      { index: 0 },
      "Ignoring malformed Kimi usage limit window",
    );
  });

  it("accepts direct limit fields, alternate reset keys, and provider labels", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        usage: null,
        limits: [
          {
            name: "Burst quota",
            limit: "80",
            remaining: "20",
            reset_at: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    );
    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toEqual([
      expect.objectContaining({
        id: "coding_limit_burst_quota",
        label: "Burst quota",
        usedPct: 75,
        remainingPct: 25,
        resetsAt: "2026-08-01T00:00:00Z",
      }),
    ]);
  });

  it("keeps window ids unique when Kimi returns duplicate limit descriptors", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const duplicate = {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "10" },
    };
    const fetchApi = vi.fn(async () => jsonResponse({ limits: [duplicate, duplicate] }));
    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage.windows.map((window) => window.id)).toEqual([
      "coding_limit_300_time_unit_minute",
      "coding_limit_300_time_unit_minute_2",
    ]);
  });
});
