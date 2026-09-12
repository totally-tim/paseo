import { getAccountUsageWindows } from "@getpaseo/protocol/provider-accounts";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAccount,
  ProviderAccountIdentity,
} from "@getpaseo/protocol/provider-accounts";
import type { ProviderAccountResetCreditOutcome, ProviderUsage } from "../messages.js";
import { ProviderAccountStore } from "./account-store.js";
import {
  AccountHelperShutdownError,
  ProviderAccountService,
  type AccountBackend,
} from "./account-service.js";

class TestAccountBackend implements AccountBackend {
  identity: ProviderAccountIdentity | null = null;
  usedPct: number | null = 10;
  failUsage = false;
  logouts = 0;
  consumeResetCredit?: AccountBackend["consumeResetCredit"];
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
    await service.edit(account.id, { enabled: true });
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
    await service.edit(managed.id, { enabled: true });
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
    await add("b");
    const leases = await Promise.all(
      [0, 1].map(() =>
        service.reserve({ provider: "codex", selection: { kind: "automatic" }, unattended: false }),
      ),
    );
    expect(new Set(leases.map((lease) => lease!.accountId))).toEqual(new Set([a.account.id]));
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

it("does not verify an account whose fresh reading was skipped by another operation", async () => {
  const { service, add } = await setup();
  const a = await add("busy-a");
  const b = await add("busy-b");
  a.backend.usedPct = 100;
  const input = { provider: "codex" as const, accountIds: [a.account.id, b.account.id] };
  // Warm the cache with a good reading, then hold the account with a settings edit.
  expect((await service.recoveryChoice(input)).accountId).toBe(b.account.id);
  b.backend.usedPct = 100;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = b.backend.inspect.bind(b.backend);
  vi.spyOn(b.backend, "inspect").mockImplementation(async () => {
    await gate;
    return original();
  });
  const edit = service.edit(b.account.id, { label: "renamed" });
  const choice = await service.recoveryChoice(input);
  release();
  await edit;
  expect(choice.accountId).toBeNull();
});

it("excludes an already-tried subscription that also has a managed context", async () => {
  const { service, store, backends, add } = await setup();
  const managed = await add("shared-managed");
  const host = store.get("default:codex");
  const backend = new TestAccountBackend();
  backend.identity = managed.backend.identity;
  backends.set(host.id, backend);
  await service.inspect(host.id);
  await service.edit(host.id, { enabled: true });
  const input = {
    provider: "codex" as const,
    accountIds: [host.id, managed.account.id],
    exclude: [host.id],
  };
  expect((await service.recoveryChoice(input)).accountId).toBeNull();
});

it("re-checks for a duplicate identity when a removed account is restored", async () => {
  const { service, store, backends, add } = await setup();
  const first = await add("original");
  await service.remove(first.account.id, "retain");
  // A removed account cannot quarantine a new sign-in, so the same identity is admitted twice.
  const replacement = await service.add("codex", "replacement");
  const backend = new TestAccountBackend();
  backend.identity = first.backend.identity;
  backends.set(replacement.id, backend);
  await service.inspect(replacement.id);
  expect(store.get(replacement.id)).toMatchObject({ authState: "ready" });
  await service.restore(first.account.id);
  expect(store.get(first.account.id)).toMatchObject({ authState: "error", enabled: false });
});

it("follows the host CLI login when the user signs in as somebody else", async () => {
  const { service, store, backends } = await setup();
  const host = store.get("default:codex");
  const backend = new TestAccountBackend();
  backend.identity = { key: "codex:first", email: "first@example.invalid" };
  backends.set(host.id, backend);
  await service.inspect(host.id);
  expect(store.get(host.id)).toMatchObject({ authState: "ready" });
  backend.identity = { key: "codex:second", email: "second@example.invalid" };
  await service.inspect(host.id);
  expect(store.get(host.id)).toMatchObject({
    authState: "ready",
    identity: { key: "codex:second" },
  });
});

it("keeps the account locked when a login helper will not shut down", async () => {
  const { service, store, add } = await setup();
  const { account, backend } = await add("stranded");
  vi.spyOn(backend, "login").mockRejectedValue(new AccountHelperShutdownError());
  const login = await service.startLogin(account.id);
  expect(login.accountId).toBe(account.id);
  await vi.waitFor(() => expect(store.get(account.id)).toMatchObject({ authState: "error" }));
  // The helper may still hold the credential files, so nothing may change this login.
  await expect(service.logout(account.id)).rejects.toThrow();
  await expect(service.startLogin(account.id)).rejects.toThrow();
});

it("keeps the running login visible through a status check and a submitted code", async () => {
  const { service, add } = await setup();
  const { account, backend } = await add("polling");
  backend.identity = null;
  const started = await service.startLogin(account.id);
  expect(service.activeLogin(account.id)).toMatchObject({ id: started.id });
  expect(service.activeLogin(account.id, started.id)).toMatchObject({ id: started.id });
  expect(service.activeLogin(account.id, "other-login")).toBeNull();
  await service.cancelLogin(account.id, started.id);
  expect(service.activeLogin(account.id)).toBeNull();
});

it("keeps a rejection without a reported reset until a reset is known", async () => {
  const { service, add, advance } = await setup();
  const a = await add("no-reset");
  await service.reportCapacity(a.account.id);
  const input = { provider: "codex" as const, accountIds: [a.account.id] };
  // A fresh reading alone cannot show the limit lifted when the provider named no reset.
  expect((await service.recoveryChoice(input)).accountId).toBeNull();
  advance(10 * 60_000);
  expect((await service.recoveryChoice(input)).accountId).toBeNull();
  // It must not strand the account either: after a bounded cooldown a fresh reading counts.
  advance(6 * 60_000);
  expect((await service.recoveryChoice(input)).accountId).toBe(a.account.id);
  // A rejection that did name a reset clears once that time passes and usage is re-read.
  const b = await add("with-reset");
  await service.reportCapacity(b.account.id, undefined, "2026-09-04T00:00:00.000Z");
  expect(
    (await service.recoveryChoice({ provider: "codex", accountIds: [b.account.id] })).accountId,
  ).toBe(b.account.id);
});

it("picks up a host CLI login that happened after the daemon started", async () => {
  const { service, store, backends } = await setup();
  const host = store.get("default:codex");
  const backend = new TestAccountBackend();
  backends.set(host.id, backend);
  await service.inspect(host.id);
  expect(store.get(host.id).authState).toBe("signed-out");
  backend.identity = { key: "codex:late", email: "late@example.invalid" };
  service.refreshUsage();
  await vi.waitFor(() => expect(store.get(host.id).authState).toBe("ready"));
});

it("keeps unreadable account metadata and refuses to replace it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-account-store-"));
  cleanups.push(async () => {
    await fs
      .chmod(path.join(directory, "provider-accounts", "accounts.json"), 0o600)
      .catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const first = new ProviderAccountStore(directory);
  await first.initialize();
  await first.create("codex", "Keep me");
  const file = path.join(directory, "provider-accounts", "accounts.json");
  const original = await fs.readFile(file, "utf8");
  await fs.chmod(file, 0o000);
  const second = new ProviderAccountStore(directory);
  await expect(second.initialize()).resolves.toBeUndefined();
  // A file we could not read is not a corrupt file: it stays put, and writes refuse.
  await fs.chmod(file, 0o600);
  expect(await fs.readFile(file, "utf8")).toBe(original);
  await expect(second.setPolicy({ unknownQuota: "allow" })).rejects.toThrow("could not be read");
});

it("sets aside an unreadable account file instead of stopping the daemon", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-account-store-"));
  cleanups.push(async () => fs.rm(directory, { recursive: true, force: true }));
  const first = new ProviderAccountStore(directory);
  await first.initialize();
  await fs.writeFile(path.join(directory, "provider-accounts", "accounts.json"), "{ truncated");
  const second = new ProviderAccountStore(directory);
  await expect(second.initialize()).resolves.toBeUndefined();
  const entries = await fs.readdir(path.join(directory, "provider-accounts"));
  expect(entries.filter((entry) => entry.includes(".corrupt-"))).toHaveLength(1);
});

it("matches a model-scoped window whose label is spaced differently from the model id", async () => {
  const { service, add } = await setup();
  const account = await add("model-scoped");
  vi.spyOn(account.backend, "usage").mockResolvedValue({
    providerId: "claude",
    displayName: "model-scoped",
    status: "available",
    planLabel: "max",
    windows: [
      { id: "five_hour", label: "Session", usedPct: 5, resetsAt: "2099-01-01T00:00:00Z" },
      {
        id: "model:0:Claude Opus 4.5",
        label: "Weekly · Claude Opus 4.5",
        usedPct: 100,
        resetsAt: "2099-01-01T00:00:00Z",
      },
    ],
  });
  const input = { provider: "codex" as const, accountIds: [account.account.id] };
  // The exhausted bucket belongs to this model, so it must block admission.
  expect(
    (await service.recoveryChoice({ ...input, model: "claude-opus-4-5-20251101" })).accountId,
  ).toBeNull();
  // A different model is unaffected by that bucket.
  expect((await service.recoveryChoice({ ...input, model: "claude-haiku-4-5" })).accountId).toBe(
    account.account.id,
  );
});

describe("account management order and removal", () => {
  it("persists explicit ordering across updates and reloads", async () => {
    const { service, store, directory, add } = await setup();
    const a = await add("First");
    const b = await add("Second");
    const original = service.list().map((account) => account.id);
    await service.edit(a.account.id, { label: "Renamed" });
    expect(service.list().map((account) => account.id)).toEqual(original);
    const order = [
      b.account.id,
      a.account.id,
      ...original.filter((id) => id !== a.account.id && id !== b.account.id),
    ];
    await service.reorder(order);
    await service.inspect(a.account.id);
    expect(service.list().map((account) => account.id)).toEqual(order);
    const reloaded = new ProviderAccountStore(directory);
    await reloaded.initialize();
    expect(reloaded.list().map((account) => account.id)).toEqual(order);
    await expect(service.reorder([a.account.id, a.account.id])).rejects.toThrow();
    expect(store.list().map((account) => account.id)).toEqual(order);
  });

  it("releases removed account slots and enforces the limit on restore", async () => {
    const { service } = await setup();
    const removed = await service.add("codex", "Removed");
    await service.remove(removed.id, "retain");
    for (let index = 0; index < 32; index++) await service.add("codex", `Account ${index}`);
    await expect(service.add("codex", "Overflow")).rejects.toThrow("32");
    await expect(service.restore(removed.id)).rejects.toThrow("32");
    const active = service
      .list()
      .find((account) => account.ownership === "managed" && !account.removedAt)!;
    await service.remove(active.id, "retain");
    await service.restore(removed.id);
    expect(service.store.get(removed.id).removedAt).toBeUndefined();
    expect(service.store.get(removed.id).enabled).toBe(false);
  });
});

it("keeps a newly verified account out of automatic selection until setup is saved", async () => {
  const { service, backends, store } = await setup();
  const account = await service.add("codex", "Setup");
  const backend = new TestAccountBackend();
  backend.identity = { key: "setup-identity" };
  backends.set(account.id, backend);
  await service.inspect(account.id);
  expect(store.get(account.id).authState).toBe("ready");
  expect(store.get(account.id).enabled).toBe(false);
  expect(
    service.choice("codex", { kind: "automatic", accountIds: [account.id] }, false).accountId,
  ).toBeNull();
  await service.edit(account.id, { enabled: true, interactiveOnly: true, reservePercent: 25 });
  expect(store.get(account.id)).toMatchObject({
    enabled: true,
    interactiveOnly: true,
    reservePercent: 25,
  });
});

it("keeps automatic accounts through a rename, a reorder, an earlier account resetting, and restart", async () => {
  const { service, add, store, directory, backends } = await setup();
  const a = await add("sticky-a");
  const b = await add("sticky-b");
  const input = {
    provider: "codex",
    selection: { kind: "automatic" as const },
    unattended: false,
    model: "gpt-6-astra",
  };
  const first = await service.reserve(input);
  expect(first?.accountId).toBe(a.account.id);
  first?.release();
  a.backend.usedPct = 70;
  b.backend.usedPct = 0;
  await service.usage(a.account.id, true);
  await service.usage(b.account.id, true);
  // A materially larger balance moves the choice: the remembered account is a tiebreak, not a
  // lock. Below, an equal balance, a rename, a reorder and a restart all leave it alone.
  expect(service.preview("codex", input.selection, input.model).accountId).toBe(b.account.id);
  a.backend.usedPct = 100;
  await service.usage(a.account.id, true);
  const next = await service.reserve(input);
  expect(next?.accountId).toBe(b.account.id);
  next?.release();
  a.backend.usedPct = 0;
  await service.usage(a.account.id, true);
  expect(service.preview("codex", input.selection, input.model).accountId).toBe(b.account.id);
  await service.edit(b.account.id, { label: "Renamed" });
  // Put A first, so the assertion after the restart can only pass if the remembered choice for
  // B survived. Reversing the list left B first and let display order carry it either way.
  await service.reorder([
    a.account.id,
    b.account.id,
    ...store
      .list()
      .filter((account) => !account.removedAt)
      .map((account) => account.id)
      .filter((id) => id !== a.account.id && id !== b.account.id),
  ]);
  await service.close();
  const restarted = new ProviderAccountService(
    new ProviderAccountStore(directory),
    (account) => backends.get(account.id) ?? new TestAccountBackend(),
  );
  cleanups.push(() => restarted.close());
  await restarted.initialize();
  const resumed = await restarted.reserve(input);
  expect(resumed?.accountId).toBe(b.account.id);
  resumed?.release();
});

it("isolates automatic choices by model, permitted pool and work type", async () => {
  const { service, add } = await setup();
  const a = await add("scoped-a", "claude");
  const b = await add("scoped-b", "claude");
  vi.spyOn(a.backend, "usage").mockResolvedValue({
    providerId: "claude",
    displayName: "A",
    status: "available",
    windows: [
      // A consumed window carries a reset time in every real reading, and capacity ranking
      // needs it: consumption with no reset is a reading it cannot rank on.
      { id: "five_hour", label: "Session", usedPct: 10, resetsAt: "2026-09-05T04:00:00Z" },
      { id: "model:0:Fable", label: "Weekly · Fable", usedPct: 100 },
    ],
  });
  const defaultModel = await service.reserve({ provider: "claude", unattended: false });
  expect(defaultModel?.accountId).toBe(a.account.id);
  defaultModel?.release();
  await service.setPolicy({ unknownQuota: "allow" });
  const fable = await service.reserve({
    provider: "claude",
    model: "claude-fable-5.1",
    unattended: false,
  });
  expect(fable?.accountId).toBe(b.account.id);
  fable?.release();
  const opus = await service.reserve({
    provider: "claude",
    model: "claude-opus-5",
    unattended: false,
  });
  expect(opus?.accountId).toBe(a.account.id);
  opus?.release();
  await service.edit(a.account.id, { interactiveOnly: true });
  const background = await service.reserve({
    provider: "claude",
    model: "claude-opus-5",
    unattended: true,
  });
  expect(background?.accountId).toBe(b.account.id);
  background?.release();
  expect(service.preview("claude", undefined, "claude-opus-5").accountId).toBe(a.account.id);
  const restricted = await service.reserve({
    provider: "claude",
    model: "claude-opus-5",
    selection: { kind: "automatic", accountIds: [b.account.id] },
    unattended: false,
  });
  expect(restricted?.accountId).toBe(b.account.id);
  restricted?.release();
});

it("does not let exhausted Spark quota block a different Codex model", () => {
  const usage: ProviderUsage = {
    providerId: "codex",
    displayName: "Account",
    status: "available",
    windows: [
      { id: "codex:primary", label: "5-hour window · codex", usedPct: 10 },
      { id: "spark:secondary", label: "Weekly · GPT-5.3-Codex-Spark", usedPct: 100 },
      { id: "gpt-reserve:secondary", label: "Weekly · gpt-reserve", usedPct: 20 },
    ],
  };
  expect(getAccountUsageWindows(usage, "gpt-6-astra").map((window) => window.id)).toEqual([
    "codex:primary",
    "gpt-reserve:secondary",
  ]);
  expect(getAccountUsageWindows(usage, "gpt-5.3-codex-spark")).toHaveLength(3);
});

it("does not move a background account because a usage refresh failed", async () => {
  const { service, add } = await setup();
  const a = await add("telemetry-a");
  await add("telemetry-b");
  await service.setPolicy({ unknownQuota: "pause-unattended" });
  const input = { provider: "codex", model: "gpt-6-astra", unattended: true };
  const initial = await service.reserve(input);
  expect(initial?.accountId).toBe(a.account.id);
  initial?.release();
  a.backend.failUsage = true;
  await service.usage(a.account.id, true);
  await expect(service.reserve(input)).rejects.toThrow("wait");
  a.backend.failUsage = false;
  await service.usage(a.account.id, true);
  const recovered = await service.reserve(input);
  expect(recovered?.accountId).toBe(a.account.id);
  recovered?.release();
});

/**
 * Quota windows are use-it-or-lose-it, so these fixtures are the two live accounts the ranking
 * was designed against: A has a nearly untouched weekly that resets last, B has a heavily used
 * weekly that resets first, and B's session window has not started so it reports no reset.
 */
const RANKING_LATE_SESSION_RESET = "2026-09-05T04:00:00Z";

function ranked(windows: ProviderUsage["windows"]): ProviderUsage {
  return {
    providerId: "codex",
    displayName: "test",
    status: "available",
    planLabel: null,
    windows,
  };
}

const FIVE_HOUR = 5 * 60;
const SEVEN_DAY = 7 * 24 * 60;

/** A: session 10% resetting in 1h53m, weekly 9% resetting in 6d9h. */
function accountA(session?: Partial<ProviderUsage["windows"][number]>): ProviderUsage {
  return ranked([
    {
      id: "session",
      label: "Session",
      usedPct: 10,
      resetsAt: "2026-09-05T01:53:00Z",
      periodMinutes: FIVE_HOUR,
      ...session,
    },
    {
      id: "weekly",
      label: "Weekly",
      usedPct: 9,
      resetsAt: "2026-09-11T09:00:00Z",
      periodMinutes: SEVEN_DAY,
    },
  ]);
}

/** B: session unstarted, weekly 86% resetting in 4d6h — sooner than A's. */
function accountB(session?: Partial<ProviderUsage["windows"][number]>): ProviderUsage {
  return ranked([
    {
      id: "session",
      label: "Session",
      usedPct: 0,
      resetsAt: null,
      periodMinutes: FIVE_HOUR,
      ...session,
    },
    {
      id: "weekly",
      label: "Weekly",
      usedPct: 86,
      resetsAt: "2026-09-09T06:00:00Z",
      periodMinutes: SEVEN_DAY,
    },
  ]);
}

/**
 * `firstAdded` is the account display order would pick with no ranking. Every test names the
 * one it does *not* expect to win, so removing the comparator makes the test fail rather than
 * pass for ordering reasons.
 */
async function rankingPair(input: { usageB?: ProviderUsage; firstAdded: "a" | "b" }) {
  const context = await setup();
  const first = await context.add(`rank-${input.firstAdded}`);
  const second = await context.add(input.firstAdded === "a" ? "rank-b" : "rank-a");
  const [a, b] = input.firstAdded === "a" ? [first, second] : [second, first];
  vi.spyOn(a.backend, "usage").mockResolvedValue(accountA());
  vi.spyOn(b.backend, "usage").mockResolvedValue(input.usageB ?? accountB());
  return { ...context, a, b };
}

describe("capacity ranking", () => {
  it("sends a continuing start to the account whose quota expires soonest", async () => {
    const { service, a, b } = await rankingPair({ firstAdded: "a" });
    // B's weekly rolls on the 9th and A's on the 11th, so B's remaining 14% is the quota that
    // would otherwise evaporate first. This agent can hand itself over when B runs out.
    const lease = await service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(lease?.accountId).toBe(b.account.id);
    expect(lease?.accountId).not.toBe(a.account.id);
    expect(lease?.reason).toContain("expires soonest");
    expect(lease?.reason).toContain("2026-09-09T06:00:00Z");
    lease?.release();
  });

  it("sends a start with no continuation to the account with the most remaining capacity", async () => {
    const { service, a, b } = await rankingPair({ firstAdded: "b" });
    // Automatic continuation is off by default, so nothing moves this agent off B when B's
    // weekly runs out. Chasing the expiring account would strand it at 14% remaining.
    const lease = await service.reserve({ provider: "codex", unattended: false });
    expect(lease?.accountId).toBe(a.account.id);
    expect(lease?.accountId).not.toBe(b.account.id);
    expect(lease?.reason).toContain("most remaining capacity");
    lease?.release();
  });

  it("keeps an unattended start on remaining capacity even when continuation is enabled", async () => {
    const { service, a, b } = await rankingPair({ firstAdded: "b" });
    // Scheduled and execution-service agents are excluded from continuation, so the policy on
    // the profile does not buy them a handover.
    const lease = await service.reserve({
      provider: "codex",
      unattended: true,
      continuationEnabled: true,
    });
    expect(lease?.accountId).toBe(a.account.id);
    expect(lease?.accountId).not.toBe(b.account.id);
    lease?.release();
  });

  it("ranks capacity ahead of the account a previous start settled on", async () => {
    const { service, a, b, advance } = await rankingPair({ firstAdded: "a" });
    const first = await service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(first?.accountId).toBe(b.account.id);
    first?.release();
    // B's weekly rolled, so A is now the account whose quota expires first. The remembered
    // choice is a tiebreak, so it must not hold the next start on B.
    vi.spyOn(b.backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 1,
          resetsAt: "2026-09-16T06:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]),
    );
    advance(300_001);
    const second = await service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(second?.accountId).toBe(a.account.id);
    second?.release();
  });

  it("ranks a session window last only once it passes 90%", async () => {
    const onTheLine = await rankingPair({
      usageB: accountB({ usedPct: 90, resetsAt: RANKING_LATE_SESSION_RESET }),
      firstAdded: "a",
    });
    // Exactly 90 is not yet the wall, so B still wins on its earlier expiry.
    const allowed = await onTheLine.service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(allowed?.accountId).toBe(onTheLine.b.account.id);
    allowed?.release();
    const over = await rankingPair({
      usageB: accountB({ usedPct: 90.5, resetsAt: RANKING_LATE_SESSION_RESET }),
      firstAdded: "b",
    });
    // Just above it, B walls within minutes and loses despite the earlier expiry.
    const blocked = await over.service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(blocked?.accountId).toBe(over.a.account.id);
    blocked?.release();
  });

  it("still starts when every account's session window is nearly exhausted", async () => {
    const context = await setup();
    const low = await context.add("rank-low");
    const high = await context.add("rank-high");
    const hot = (usedPct: number, weeklyUsedPct: number) =>
      ranked([
        {
          id: "session",
          label: "Session",
          usedPct,
          resetsAt: RANKING_LATE_SESSION_RESET,
          periodMinutes: FIVE_HOUR,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: weeklyUsedPct,
          resetsAt: "2026-09-11T09:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]);
    // Added first, so display order would pick it; it has the least left of the two.
    vi.spyOn(low.backend, "usage").mockResolvedValue(hot(99, 80));
    vi.spyOn(high.backend, "usage").mockResolvedValue(hot(95, 20));
    // Both are past the wall, so neither can be preferred on that count. The fallback still
    // has to produce an account rather than refusing the start.
    const lease = await context.service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(lease?.accountId).toBe(high.account.id);
    lease?.release();
  });

  it("drops the near-exhaustion penalty once that window has reset", async () => {
    const context = await setup();
    const rolled = await context.add("rank-rolled");
    const healthy = await context.add("rank-healthy");
    // A cached session reading at 95% whose reset has already passed. The window rolled, so
    // the percentage is stale and must not hold this account back.
    vi.spyOn(rolled.backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "session",
          label: "Session",
          usedPct: 95,
          resetsAt: "2026-09-04T23:00:00Z",
          periodMinutes: FIVE_HOUR,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 10,
          resetsAt: "2026-09-11T09:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]),
    );
    vi.spyOn(healthy.backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "session",
          label: "Session",
          usedPct: 89,
          resetsAt: "2026-09-05T04:00:00Z",
          periodMinutes: FIVE_HOUR,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 50,
          resetsAt: "2026-09-07T00:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]),
    );
    const lease = await context.service.reserve({ provider: "codex", unattended: false });
    expect(lease?.accountId).toBe(rolled.account.id);
    expect(lease?.reason).toContain("Weekly at 10% used");
    lease?.release();
  });

  it("separates a window that has not started from one it could not read", async () => {
    // Consumption with no reset time is a reading we cannot place in time, unlike B's untouched
    // session window, which reports 0% and no reset because the window has not opened. The
    // first case unscores B and hands the start to A; the second is what the expiry test uses.
    const { service, a, b } = await rankingPair({
      usageB: accountB({ usedPct: 5, resetsAt: null }),
      firstAdded: "b",
    });
    const lease = await service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(lease?.accountId).toBe(a.account.id);
    expect(lease?.accountId).not.toBe(b.account.id);
    lease?.release();
  });

  it("does not treat a nearly exhausted weekly window as the session wall", async () => {
    const context = await setup();
    // Added first, and its weekly is at 95%. If the short-window guard applied to weekly
    // allowances it would rank last, and the later-resetting account would win instead.
    const soon = await context.add("rank-soon");
    const later = await context.add("rank-later");
    vi.spyOn(soon.backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 95,
          resetsAt: "2026-09-07T00:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]),
    );
    vi.spyOn(later.backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 50,
          resetsAt: "2026-09-11T00:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]),
    );
    const lease = await context.service.reserve({
      provider: "codex",
      unattended: false,
      continuationEnabled: true,
    });
    expect(lease?.accountId).toBe(soon.account.id);
    expect(lease?.accountId).not.toBe(later.account.id);
    lease?.release();
  });

  it("cannot score an account whose every window has already rolled", async () => {
    const context = await setup();
    // Added first. Its only reading predates its own reset, so it says nothing about what is
    // left now — another agent may already be spending the fresh allowance.
    const stale = await context.add("rank-stale");
    const measured = await context.add("rank-measured");
    vi.spyOn(stale.backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 95,
          resetsAt: "2026-09-04T23:59:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]),
    );
    vi.spyOn(measured.backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 1,
          resetsAt: "2026-09-05T04:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ]),
    );
    // Treating the discarded reading as full capacity would beat a real 99% remaining.
    const lease = await context.service.reserve({ provider: "codex", unattended: false });
    expect(lease?.accountId).toBe(measured.account.id);
    expect(lease?.accountId).not.toBe(stale.account.id);
    lease?.release();
  });

  it("orders automatic recovery by the same expiry rule", async () => {
    const { service, a, b } = await rankingPair({ firstAdded: "a" });
    const choice = await service.recoveryChoice({
      provider: "codex",
      accountIds: [a.account.id, b.account.id],
    });
    expect(choice.accountId).toBe(b.account.id);
  });
});

describe("reset credits", () => {
  async function credited() {
    const context = await setup();
    const { account, backend } = await context.add("credited");
    const keys: string[] = [];
    const outcomes: Array<
      ProviderAccountResetCreditOutcome | Error | Promise<ProviderAccountResetCreditOutcome>
    > = [];
    backend.consumeResetCredit = (input: { idempotencyKey: string }) => {
      keys.push(input.idempotencyKey);
      const outcome = outcomes.shift() ?? "reset";
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    };
    return { ...context, account, backend, keys, outcomes };
  }

  it("spends one credit, re-reads usage, and clears a remembered capacity limit", async () => {
    const { service, store, account, backend, keys } = await credited();
    const probe = vi.spyOn(backend, "usage");
    await service.reportCapacity(account.id, undefined, "2026-09-06T00:00:00Z");
    const result = await service.redeemResetCredit(account.id);
    expect(result).toEqual({ outcome: "reset", confirmed: true });
    expect(keys).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(store.get(account.id).capacityLimit).toBeNull();
  });

  it("keeps the capacity limit when the provider says there was nothing to spend", async () => {
    const { service, store, account, outcomes } = await credited();
    outcomes.push("noCredit");
    await service.reportCapacity(account.id, undefined, "2026-09-06T00:00:00Z");
    expect((await service.redeemResetCredit(account.id)).outcome).toBe("noCredit");
    expect(store.get(account.id).capacityLimit).not.toBeNull();
  });

  it("pins the idempotency key across a lost response and rotates it after one", async () => {
    const { service, account, keys, outcomes } = await credited();
    outcomes.push(new Error("connection lost"), "reset", "reset");
    await expect(service.redeemResetCredit(account.id)).rejects.toThrow("connection lost");
    await service.redeemResetCredit(account.id);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    await service.redeemResetCredit(account.id);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("serializes concurrent redemptions so one credit cannot be spent twice", async () => {
    const { service, account, keys, outcomes } = await credited();
    let release!: () => void;
    const gate = new Promise<"reset">((resolve) => {
      release = () => resolve("reset");
    });
    outcomes.push(gate, "reset");
    const first = service.redeemResetCredit(account.id);
    const second = service.redeemResetCredit(account.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(keys).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("reports an unconfirmed spend when the usage re-read fails", async () => {
    const { service, account, backend } = await credited();
    backend.failUsage = true;
    expect(await service.redeemResetCredit(account.id)).toEqual({
      outcome: "reset",
      confirmed: false,
    });
  });

  it("refuses accounts that cannot hold or spend a credit", async () => {
    const { service, add, account, backend } = await credited();
    const claude = await add("claude-side", "claude");
    await expect(service.redeemResetCredit("missing")).rejects.toThrow("Account not found");
    await expect(service.redeemResetCredit(claude.account.id)).rejects.toThrow("Only Codex");
    const signedOut = await add("signed-out");
    signedOut.backend.identity = null;
    await service.inspect(signedOut.account.id);
    await expect(service.redeemResetCredit(signedOut.account.id)).rejects.toThrow("Sign in");
    await service.remove(account.id, "retain");
    await expect(service.redeemResetCredit(account.id)).rejects.toThrow("Restore the account");
    backend.consumeResetCredit = undefined;
  });

  it("lists permitted accounts whose last read still shows a banked credit", async () => {
    const { service, account, backend } = await credited();
    const usage = ranked([
      { id: "primary", label: "5-hour window", usedPct: 100, periodMinutes: FIVE_HOUR },
    ]);
    vi.spyOn(backend, "usage").mockResolvedValue({
      ...usage,
      resetCredits: { availableCount: 1 },
    });
    expect(service.resetCreditAccounts("codex", [account.id])).toEqual([]);
    await service.usage(account.id);
    expect(service.resetCreditAccounts("codex", [account.id])).toEqual([account.id]);
    // A metadata edit keeps the reading, but signing out invalidates the account entirely.
    await service.edit(account.id, { label: "renamed" });
    expect(service.resetCreditAccounts("codex", [account.id])).toEqual([account.id]);
    await service.logout(account.id);
    expect(service.resetCreditAccounts("codex", [account.id])).toEqual([]);
  });
});

describe("live usage updates", () => {
  it("seeds a partial snapshot from events and still probes for admission", async () => {
    const { service, add } = await setup();
    const { account, backend } = await add("live");
    const probe = vi.spyOn(backend, "usage");
    service.applyLiveUsage(account.id, {
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    });
    const snapshot = service.usageSnapshot(account.id);
    expect(snapshot.usage.windows).toEqual([
      expect.objectContaining({ id: "primary", usedPct: 80, periodMinutes: 300 }),
    ]);
    expect(probe).not.toHaveBeenCalled();
    // An event names only the windows it carries, so admission re-probes for the full read.
    await service.usage(account.id);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("merges events into a probed snapshot without marking it partial", async () => {
    const { service, add } = await setup();
    const { account, backend } = await add("live-merge");
    vi.spyOn(backend, "usage").mockResolvedValue(
      ranked([
        {
          id: "codex:primary",
          label: "5-hour window · Codex",
          usedPct: 40,
          resetsAt: "2026-09-05T05:00:00Z",
          periodMinutes: FIVE_HOUR,
        },
      ]),
    );
    await service.usage(account.id);
    const probe = vi.mocked(backend.usage);
    service.applyLiveUsage(account.id, {
      primary: { usedPercent: 90 },
    });
    const snapshot = service.usageSnapshot(account.id);
    expect(snapshot.usage.windows[0]).toMatchObject({ id: "codex:primary", usedPct: 90 });
    await service.usage(account.id);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("folds Claude rate-limit events into the cached reading", async () => {
    const { service, add } = await setup();
    const { account, backend } = await add("live-claude", "claude");
    vi.spyOn(backend, "usage").mockResolvedValue({
      providerId: "claude",
      displayName: "test",
      status: "available",
      planLabel: "max",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          usedPct: 20,
          resetsAt: "2026-09-05T05:00:00Z",
          periodMinutes: FIVE_HOUR,
        },
        {
          id: "seven_day",
          label: "Weekly",
          usedPct: 30,
          resetsAt: "2026-09-12T00:00:00Z",
          periodMinutes: SEVEN_DAY,
        },
      ],
    });
    await service.usage(account.id);
    service.applyLiveUsage(account.id, {
      rateLimitType: "seven_day",
      utilization: 0.55,
      resetsAt: 1_800_000_000,
    });
    expect(service.usageSnapshot(account.id).usage.windows).toEqual([
      expect.objectContaining({ id: "five_hour", usedPct: 20 }),
      expect.objectContaining({
        id: "seven_day",
        usedPct: expect.closeTo(55),
        resetsAt: "2027-01-15T08:00:00.000Z",
      }),
    ]);
  });

  it("ignores events for accounts that cannot report or payloads that parse to nothing", async () => {
    const { service, add } = await setup();
    const { account } = await add("live-off");
    const signedOut = await add("live-signed-out");
    signedOut.backend.identity = null;
    await service.inspect(signedOut.account.id);
    service.applyLiveUsage(account.id, { unexpected: true });
    service.applyLiveUsage(signedOut.account.id, {
      primary: { usedPercent: 90 },
    });
    service.applyLiveUsage("missing", { primary: { usedPercent: 90 } });
    expect(service.usageSnapshot(account.id).usage.status).toBe("unavailable");
    expect(service.usageSnapshot(signedOut.account.id).usage.status).toBe("unavailable");
  });
});
