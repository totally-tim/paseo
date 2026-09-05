import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAccount,
  ProviderAccountIdentity,
} from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "../messages.js";
import { ProviderAccountStore } from "./account-store.js";
import { ProviderAccountService, type AccountBackend } from "./account-service.js";

class TestAccountBackend implements AccountBackend {
  identity: ProviderAccountIdentity | null = null;
  usedPct: number | null = 10;
  failUsage = false;
  logouts = 0;
  inspect(): Promise<ProviderAccountIdentity | null> {
    return Promise.resolve(this.identity);
  }
  async login(input: Parameters<AccountBackend["login"]>[0]): Promise<ProviderAccountIdentity> {
    input.onChallenge({
      kind: "device",
      url: "https://auth.openai.com/codex/device",
      userCode: "TEST-CODE",
    });
    if (!this.identity) {
      await new Promise<void>((resolve) =>
        input.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("canceled");
    }
    return this.identity;
  }
  async logout(): Promise<void> {
    this.logouts++;
    this.identity = null;
  }
  async usage(): Promise<ProviderUsage> {
    if (this.failUsage) throw new Error("offline");
    return {
      providerId: "codex",
      displayName: "test",
      status: "available",
      planLabel: "test",
      windows: [
        { id: "weekly", label: "Weekly", usedPct: this.usedPct, resetsAt: "2099-01-01T00:00:00Z" },
      ],
    };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-account-test-"));
  const store = new ProviderAccountStore(directory);
  const backends = new Map<string, TestAccountBackend>();
  let now = Date.parse("2026-09-05T00:00:00Z");
  const service = new ProviderAccountService(
    store,
    (account) => {
      let backend = backends.get(account.id);
      if (!backend) {
        backend = new TestAccountBackend();
        backends.set(account.id, backend);
      }
      return backend;
    },
    () => now,
  );
  await service.initialize();
  cleanups.push(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function add(label: string, provider: "claude" | "codex" = "codex") {
    const account = await service.add(provider, label);
    const backend = new TestAccountBackend();
    backend.identity = { key: `${provider}:${label}`, email: `${label}@example.invalid` };
    backends.set(account.id, backend);
    await service.inspect(account.id);
    return { account: store.get(account.id), backend };
  }
  return {
    service,
    store,
    directory,
    backends,
    add,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function nextLoginResult(service: ProviderAccountService, id: string): Promise<ProviderAccount> {
  return new Promise((resolve) => {
    const unsubscribe = service.onChange((account) => {
      if (account.id === id && account.authState !== "authenticating") {
        unsubscribe();
        resolve(account);
      }
    });
  });
}

it("requires a fresh known reading for automatic recovery even when unknown usage is allowed", async () => {
  const { service, add } = await setup();
  const a = await add("recovery-a");
  const b = await add("recovery-b");
  a.backend.usedPct = 100;
  b.backend.usedPct = null;
  await service.setPolicy({ unknownQuota: "allow" });
  const input = { provider: "codex" as const, accountIds: [a.account.id, b.account.id] };
  expect((await service.recoveryChoice(input)).accountId).toBeNull();
  b.backend.usedPct = 10;
  expect((await service.recoveryChoice(input)).accountId).toBe(b.account.id);
  await service.edit(b.account.id, { reservePercent: 95 });
  expect((await service.recoveryChoice(input)).accountId).toBeNull();
  await service.edit(b.account.id, { reservePercent: 0, interactiveOnly: true });
  expect((await service.recoveryChoice(input)).accountId).toBeNull();
});

it("waits for all overlapping limits and ignores stale readings or disabled destinations", async () => {
  const { service, add, advance } = await setup();
  const { account, backend } = await add("overlap");
  const input = { provider: "codex" as const, accountIds: [account.id] };
  vi.spyOn(backend, "usage").mockResolvedValueOnce({
    providerId: "codex",
    displayName: "test",
    status: "available",
    planLabel: null,
    windows: [
      { id: "session", label: "Session", usedPct: 100, resetsAt: "2026-09-05T01:00:00Z" },
      { id: "weekly", label: "Weekly", usedPct: 100, resetsAt: "2026-09-06T00:00:00Z" },
    ],
  });
  expect(await service.recoveryChoice(input)).toMatchObject({
    accountId: null,
    resetsAt: "2026-09-06T00:00:00.000Z",
  });
  expect((await service.recoveryChoice(input)).accountId).toBe(account.id);
  advance(24 * 60 * 60 * 1000);
  backend.failUsage = true;
  expect((await service.recoveryChoice(input)).accountId).toBeNull();
  backend.failUsage = false;
  await service.edit(account.id, { enabled: false });
  expect(await service.recoveryChoice(input)).toMatchObject({
    accountId: null,
    needsAttention: true,
  });
});

it("counts a host login and managed profile for the same identity only once during recovery", async () => {
  const { service, backends, add } = await setup();
  const a = await add("first");
  const host = new TestAccountBackend();
  backends.set("default:codex", host);
  host.identity = a.backend.identity;
  await service.inspect("default:codex");
  const inspectA = vi.spyOn(a.backend, "inspect");
  const inspectB = vi.spyOn(host, "inspect");
  await service.recoveryChoice({ provider: "codex", accountIds: [a.account.id, "default:codex"] });
  expect(inspectA.mock.calls.length + inspectB.mock.calls.length).toBe(1);
});

it("waits for in-flight identity inspection before closing the account store", async () => {
  const { service, store, add } = await setup();
  const { account, backend } = await add("closing");
  let complete!: (identity: ProviderAccountIdentity | null) => void;
  vi.spyOn(backend, "inspect").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const inspection = service.inspect(account.id);
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
    return;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  complete(null);
  await Promise.all([inspection, closing]);
  expect(store.get(account.id).authState).toBe("signed-out");
  expect(closed).toBe(true);
  await expect(service.inspect(account.id)).rejects.toThrow();
});

describe("provider accounts", () => {
  it("persists only metadata with private permissions and stable directories", async () => {
    const { add, store, directory } = await setup();
    const { account } = await add("a", "claude");
    const context = store.context(account.id);
    const restored = new ProviderAccountStore(directory);
    await restored.initialize();
    expect(restored.get(account.id)).toEqual(account);
    expect(restored.context(account.id)).toEqual(context);
    expect((await fs.stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(store.directory, "accounts.json"))).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(context!.configDir)).toEqual([]);
  });

  it("does not mark a started login ready and cancels only that account", async () => {
    const { service, store, add } = await setup();
    const a = await add("a");
    const b = await service.add("codex", "b");
    const lease = await service.reserve({
      provider: "codex",
      selection: { kind: "fixed", accountId: a.account.id },
      unattended: false,
    });
    const login = await service.startLogin(b.id);
    expect(store.get(b.id).authState).toBe("authenticating");
    await service.cancelLogin(b.id, login.id);
    expect(store.get(b.id).authState).toBe("signed-out");
    expect(store.get(a.account.id).authState).toBe("ready");
    expect(a.backend.logouts).toBe(0);
    lease!.release();
  });

  it("keeps an incomplete new account outside the implicit automatic pool", async () => {
    const { service } = await setup();
    const account = await service.add("codex", "unfinished");
    expect(account.enabled).toBe(false);
    expect(service.preview("codex").accountId).toBe("default:codex");
    const login = await service.startLogin(account.id);
    await service.cancelLogin(account.id, login.id);
    expect(service.preview("codex").accountId).toBe("default:codex");
  });

  it("can add the host CLI identity to a private managed context without duplicating pool capacity", async () => {
    const { service, store, backends } = await setup();
    const host = new TestAccountBackend();
    host.identity = { key: "codex:host", email: "host@example.invalid" };
    backends.set("default:codex", host);
    await service.inspect("default:codex");
    const managed = await service.add("codex", "Private context");
    const backend = new TestAccountBackend();
    backend.identity = host.identity;
    backends.set(managed.id, backend);
    expect((await service.inspect(managed.id)).authState).toBe("ready");
    expect(service.choice("codex", { kind: "automatic" }, false).accountId).toBe(managed.id);
    expect(store.get("default:codex").ownership).toBe("external");
    expect(host.logouts).toBe(0);
  });

  it("rejects a duplicate identity without changing the original account", async () => {
    const { service, store, add, backends } = await setup();
    const a = await add("a");
    const b = await service.add("codex", "b");
    const backend = new TestAccountBackend();
    backend.identity = a.backend.identity;
    backends.set(b.id, backend);
    const result = nextLoginResult(service, b.id);
    await service.startLogin(b.id);
    expect((await result).authState).toBe("error");
    expect(store.get(b.id).enabled).toBe(false);
    expect(store.get(a.account.id)).toEqual(a.account);
  });

  it("recovers incomplete logins after restart without adopting unverified credentials", async () => {
    const { store, directory, add } = await setup();
    const { account } = await add("a");
    await store.save({ ...account, authState: "authenticating" });
    const restored = new ProviderAccountService(
      new ProviderAccountStore(directory),
      () => new TestAccountBackend(),
    );
    await restored.initialize();
    expect(restored.store.get(account.id).authState).toBe("signed-out");
    expect(restored.store.get(account.id).identity).toEqual(account.identity);
    await restored.close();
  });

  it("protects live credentials and preserves disabled accounts for pinned agents", async () => {
    const { service, add, store } = await setup();
    const { account, backend } = await add("a");
    const lease = await service.reserve({
      provider: "codex",
      selection: { kind: "fixed", accountId: account.id },
      unattended: false,
    });
    await expect(service.logout(account.id)).rejects.toThrow("Close this account's agents");
    await service.edit(account.id, { enabled: false, label: "Renamed" });
    await expect(
      service.reserve({
        provider: "codex",
        selection: { kind: "fixed", accountId: account.id },
        unattended: false,
      }),
    ).rejects.toThrow("unavailable");
    const resumed = await service.reserve({
      provider: "codex",
      pinnedAccountId: account.id,
      unattended: false,
    });
    expect(resumed!.context).toEqual(lease!.context);
    lease!.release();
    resumed!.release();
    await service.logout(account.id);
    expect(backend.logouts).toBe(1);
    expect(store.get(account.id).identity).toEqual(account.identity);
    await expect(service.logout("default:codex")).rejects.toThrow("host CLI login");
  });

  it("coordinates concurrent automatic starts and honors a fixed override", async () => {
    const { service, add } = await setup();
    const a = await add("a");
    const b = await add("b");
    const leases = await Promise.all(
      [0, 1].map(() =>
        service.reserve({ provider: "codex", selection: { kind: "automatic" }, unattended: false }),
      ),
    );
    expect(new Set(leases.map((lease) => lease!.accountId))).toEqual(
      new Set([a.account.id, b.account.id]),
    );
    const fixed = await service.reserve({
      provider: "codex",
      selection: { kind: "fixed", accountId: a.account.id },
      unattended: false,
    });
    expect(fixed!.accountId).toBe(a.account.id);
    for (const lease of [...leases, fixed]) lease!.release();
  });

  it("keeps failed and unknown quota separate from zero and applies only configured reserves", async () => {
    const { service, add, advance } = await setup();
    const { account, backend } = await add("a");
    backend.usedPct = null;
    await service.setPolicy({ unknownQuota: "pause-unattended" });
    expect((await service.usage(account.id)).windows[0].usedPct).toBeNull();
    await expect(service.reserve({ provider: "codex", unattended: true })).rejects.toThrow(
      "No eligible account",
    );
    const interactive = await service.reserve({ provider: "codex", unattended: false });
    interactive!.release();
    await service.edit(account.id, { reservePercent: 25 });
    backend.usedPct = 80;
    advance(300_001);
    await expect(service.reserve({ provider: "codex", unattended: true })).rejects.toThrow(
      "No eligible account",
    );
    await service.edit(account.id, { reservePercent: 10 });
    const unattended = await service.reserve({ provider: "codex", unattended: true });
    unattended!.release();
    backend.failUsage = true;
    await service.edit(account.id, { label: "Renamed" });
    advance(300_001);
    expect((await service.usage(account.id)).status).toBe("error");
    expect((await service.usage(account.id)).windows).toEqual([]);
  });

  it("preserves a usage reading across settings edits and invalidates it after login inspection", async () => {
    const { service, add } = await setup();
    const { account, backend } = await add("a");
    const fetchUsage = vi.spyOn(backend, "usage");
    await service.usage(account.id);
    await service.edit(account.id, { label: "Renamed", reservePercent: 20 });
    expect(service.usageSnapshot(account.id)).toMatchObject({
      stale: false,
      usage: { displayName: "Renamed", windows: [{ usedPct: 10 }] },
    });
    await service.usage(account.id);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    await service.inspect(account.id);
    expect(service.usageSnapshot(account.id).stale).toBe(true);
  });

  it("uses the distinct host login when a managed account is exhausted and respects an explicit pool", async () => {
    const { service, add, backends } = await setup();
    const { account, backend } = await add("full", "claude");
    backend.usedPct = 100;
    const host = new TestAccountBackend();
    host.identity = { key: "claude:host" };
    host.usedPct = 49;
    backends.set("default:claude", host);
    await service.inspect("default:claude");
    const lease = await service.reserve({ provider: "claude", unattended: false });
    expect(lease?.accountId).toBe("default:claude");
    expect(service.preview("claude").accountId).toBe("default:claude");
    lease?.release();
    await expect(
      service.reserve({
        provider: "claude",
        unattended: false,
        selection: { kind: "automatic", accountIds: [account.id] },
      }),
    ).rejects.toThrow("resets at");
    expect(
      service.catalogChoice("claude", { kind: "automatic", accountIds: [account.id] }).accountId,
    ).toBe(account.id);
  });

  it("rejects exhausted accounts and never copies an account ID across providers", async () => {
    const { service, add } = await setup();
    const { account, backend } = await add("a");
    backend.usedPct = 100;
    await expect(
      service.reserve({
        provider: "codex",
        selection: { kind: "fixed", accountId: account.id },
        unattended: false,
      }),
    ).rejects.toThrow("2099-01-01");
    await expect(
      service.reserve({ provider: "claude", pinnedAccountId: account.id, unattended: false }),
    ).rejects.toThrow("different provider");
    await expect(
      service.reserve({ provider: "opencode", pinnedAccountId: account.id, unattended: false }),
    ).rejects.toThrow("does not support");
  });
  it("deduplicates inspection and refuses a different identity on reauthentication", async () => {
    const { service, store, add, backends } = await setup();
    const a = await add("a");
    const b = await service.add("codex", "b");
    const backend = new TestAccountBackend();
    backend.identity = a.backend.identity;
    backends.set(b.id, backend);
    expect((await service.inspect(b.id)).authState).toBe("error");
    expect(store.get(b.id).enabled).toBe(false);
    a.backend.identity = { key: "codex:someone-else", email: "someone-else@example.invalid" };
    const result = nextLoginResult(service, a.account.id);
    await service.startLogin(a.account.id);
    expect((await result).authState).toBe("error");
    expect(store.get(a.account.id).identity).toEqual(a.account.identity);
  });

  it.each(["retain", "logout"] as const)(
    "removes with explicit %s semantics and retains history identity",
    async (credentials) => {
      const { service, store, add } = await setup();
      const a = await add("a");
      const b = await add("b");
      const context = store.context(b.account.id);
      await service.remove(b.account.id, credentials);
      expect(b.backend.logouts).toBe(credentials === "logout" ? 1 : 0);
      expect(a.backend.logouts).toBe(0);
      expect(store.context(b.account.id)).toEqual(context);
      expect(store.get(b.account.id).identity).toEqual(b.account.identity);
      await expect(
        service.reserve({ provider: "codex", pinnedAccountId: b.account.id, unattended: false }),
      ).rejects.toThrow("Restore");
      expect((await service.reserve({ provider: "codex", unattended: false }))?.accountId).toBe(
        a.account.id,
      );
      await service.restore(b.account.id);
      expect(store.get(b.account.id).removedAt).toBeUndefined();
      expect(store.get(b.account.id).enabled).toBe(false);
    },
  );

  it("discards a quota response from before an account edit and serializes metadata updates", async () => {
    const { service, store, add } = await setup();
    const { account, backend } = await add("a");
    let finish!: (usage: ProviderUsage) => void;
    vi.spyOn(backend, "usage").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.usage(account.id);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await Promise.all([
      service.edit(account.id, { label: "Renamed" }),
      service.reportCapacity(account.id, "model-a"),
    ]);
    finish({
      providerId: "codex",
      displayName: "Old",
      status: "available",
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", usedPct: 0, resetsAt: null }],
    });
    expect((await pending).status).toBe("unavailable");
    expect(service.usageSnapshot(account.id).stale).toBe(true);
    expect(store.get(account.id).label).toBe("Renamed");
    expect(store.get(account.id).capacityLimit?.model).toBe("model-a");
  });

  it("bounds quota helpers across simultaneous refresh and creation requests", async () => {
    const { service, add } = await setup();
    const releases: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const entries = await Promise.all(["a", "b", "c", "d"].map((label) => add(label)));
    for (const { backend } of entries)
      vi.spyOn(backend, "usage").mockImplementation(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running--;
        return {
          providerId: "codex",
          displayName: "test",
          status: "available",
          planLabel: null,
          windows: [],
        };
      });
    const requests = entries.map(({ account }) => service.usage(account.id));
    service.refreshUsage();
    await vi.waitFor(() => expect(releases.length).toBe(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases.length).toBe(2));
    releases.splice(0).forEach((release) => release());
    await Promise.all(requests);
    expect(peak).toBe(2);
  });

  it("keeps a native capacity rejection across restart until fresh usage or reset", async () => {
    const { service, store, directory, add, advance } = await setup();
    const { account, backend } = await add("a");
    await service.reportCapacity(account.id, "gpt-model", "2026-09-05T01:00:00Z");
    backend.failUsage = true;
    await expect(
      service.reserve({
        provider: "codex",
        model: "gpt-model",
        selection: { kind: "fixed", accountId: account.id },
        unattended: false,
      }),
    ).rejects.toThrow("01:00:00");
    const restored = new ProviderAccountStore(directory);
    await restored.initialize();
    expect(restored.get(account.id).capacityLimit).toEqual(store.get(account.id).capacityLimit);
    advance(3_600_001);
    const lease = await service.reserve({
      provider: "codex",
      model: "gpt-model",
      unattended: false,
    });
    expect(lease?.accountId).toBe(account.id);
    lease?.release();
  });

  it("does not reject Sonnet for an Opus-only weekly limit", async () => {
    const { service, add } = await setup();
    const { account, backend } = await add("a", "claude");
    vi.spyOn(backend, "usage").mockResolvedValue({
      providerId: "claude",
      displayName: "a",
      status: "available",
      planLabel: null,
      windows: [
        { id: "seven_day", label: "Weekly", usedPct: 10, resetsAt: null },
        { id: "seven_day_opus", label: "Opus", usedPct: 100, resetsAt: null },
      ],
    });
    const sonnet = await service.reserve({
      provider: "claude",
      model: "sonnet",
      unattended: false,
    });
    expect(sonnet?.accountId).toBe(account.id);
    sonnet?.release();
    await expect(
      service.reserve({ provider: "claude", model: "opus", unattended: false }),
    ).rejects.toThrow("No eligible account");
  });
});
