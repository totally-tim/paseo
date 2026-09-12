import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderAccountStore } from "./account-store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-account-store-"));
  roots.push(root);
  const host = path.join(root, "host");
  mkdirSync(host, { recursive: true });
  const store = new ProviderAccountStore(root, { resolveHostConfigDir: () => host });
  await store.initialize();
  return { root, host, store };
}

describe("managed account user layer", () => {
  it("links the host user layer into a new account home on create", async () => {
    const { host, store } = await setup();
    mkdirSync(path.join(host, "skills"));
    writeFileSync(path.join(host, "settings.json"), "{}");

    const account = await store.create("claude", "Work");
    const home = path.join(store.directory, account.id);

    expect(readlinkSync(path.join(home, "skills"))).toBe(path.join(host, "skills"));
    expect(readlinkSync(path.join(home, "settings.json"))).toBe(path.join(host, "settings.json"));
    expect(existsSync(path.join(home, ".claude.json"))).toBe(false);
    expect(existsSync(path.join(home, "projects"))).toBe(false);
  });

  it("reconciles an existing unlinked home when context() resolves it", async () => {
    const { host, store } = await setup();
    const account = await store.create("claude", "Work");
    const home = path.join(store.directory, account.id);

    // The host layer appeared after the account was created.
    mkdirSync(path.join(host, "agents"));
    writeFileSync(path.join(host, "settings.json"), "{}");
    const context = store.context(account.id);

    expect(context?.configDir).toBe(home);
    expect(readlinkSync(path.join(home, "agents"))).toBe(path.join(host, "agents"));
    expect(readlinkSync(path.join(home, "settings.json"))).toBe(path.join(host, "settings.json"));
  });

  it("keeps cli-written account state private next to the linked layer", async () => {
    const { host, store } = await setup();
    writeFileSync(path.join(host, "config.toml"), "model = 'x'");
    const account = await store.create("codex", "Work");
    const home = path.join(store.directory, account.id);

    // The CLI writes its own account state into the home.
    writeFileSync(path.join(home, "auth.json"), "{}");
    mkdirSync(path.join(home, "sessions"));
    store.context(account.id);

    expect(readlinkSync(path.join(home, "config.toml"))).toBe(path.join(host, "config.toml"));
    expect(lstatSync(path.join(home, "auth.json")).isFile()).toBe(true);
    expect(lstatSync(path.join(home, "sessions")).isDirectory()).toBe(true);
  });
});
