import { mkdtemp, rm } from "node:fs/promises";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProviderAccountUserLayer } from "./user-layer.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function homes(): Promise<{ root: string; host: string; account: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-user-layer-"));
  roots.push(root);
  const host = path.join(root, "host");
  const account = path.join(root, "account");
  mkdirSync(host, { recursive: true });
  mkdirSync(account, { recursive: true });
  return { root, host, account };
}

function link(provider: "claude" | "codex", account: string, host: string): void {
  ensureProviderAccountUserLayer({ provider, accountDir: account, hostConfigDir: host });
}

describe("ensureProviderAccountUserLayer", () => {
  it("links the claude user layer and leaves account state private", async () => {
    const { host, account } = await homes();
    mkdirSync(path.join(host, "skills", "bro"), { recursive: true });
    mkdirSync(path.join(host, "agents"));
    mkdirSync(path.join(host, "commands"));
    writeFileSync(path.join(host, "settings.json"), "{}");
    writeFileSync(path.join(host, "CLAUDE.md"), "# user instructions");
    writeFileSync(path.join(account, "session-notes.txt"), "private");

    link("claude", account, host);

    expect(lstatSync(path.join(account, "skills")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(account, "skills"))).toBe(path.join(host, "skills"));
    expect(readlinkSync(path.join(account, "settings.json"))).toBe(
      path.join(host, "settings.json"),
    );
    expect(readlinkSync(path.join(account, "CLAUDE.md"))).toBe(path.join(host, "CLAUDE.md"));
    // Not on the whitelist: stays per-account, unlinked.
    expect(lstatSync(path.join(account, "session-notes.txt")).isFile()).toBe(true);
    expect(existsSync(path.join(account, "projects"))).toBe(false);
  });

  it("skips host entries that do not exist", async () => {
    const { host, account } = await homes();
    writeFileSync(path.join(host, "settings.json"), "{}");

    link("claude", account, host);

    expect(readlinkSync(path.join(account, "settings.json"))).toBe(
      path.join(host, "settings.json"),
    );
    expect(existsSync(path.join(account, "skills"))).toBe(false);
  });

  it("sets a pre-existing real directory aside and links", async () => {
    const { host, account } = await homes();
    mkdirSync(path.join(host, "plugins"));
    mkdirSync(path.join(account, "plugins", "cache"), { recursive: true });
    writeFileSync(path.join(account, "plugins", "marker.txt"), "cli-written");

    link("claude", account, host);

    expect(readlinkSync(path.join(account, "plugins"))).toBe(path.join(host, "plugins"));
    expect(lstatSync(path.join(account, "plugins.paseo-backup")).isDirectory()).toBe(true);
    expect(existsSync(path.join(account, "plugins.paseo-backup", "marker.txt"))).toBe(true);
  });

  it("repoints a link whose target changed and repairs a link replaced by a real file", async () => {
    const { host, account, root } = await homes();
    const other = path.join(root, "other-host");
    mkdirSync(other);
    writeFileSync(path.join(other, "settings.json"), "{}");
    writeFileSync(path.join(host, "settings.json"), "{}");
    symlinkSync(path.join(other, "settings.json"), path.join(account, "settings.json"));

    link("claude", account, host);
    expect(readlinkSync(path.join(account, "settings.json"))).toBe(
      path.join(host, "settings.json"),
    );

    // A temp+rename writer replaced the link with a real file: it is set aside
    // and the link restored on the next reconcile.
    unlinkSync(path.join(account, "settings.json"));
    writeFileSync(path.join(account, "settings.json"), '{"local": true}');
    link("claude", account, host);
    expect(lstatSync(path.join(account, "settings.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(account, "settings.json.paseo-backup"))).toBe(true);
  });

  it("is a no-op on a second run", async () => {
    const { host, account } = await homes();
    mkdirSync(path.join(host, "skills"));
    writeFileSync(path.join(host, "settings.json"), "{}");
    link("claude", account, host);
    const before = lstatSync(path.join(account, "skills"));
    link("claude", account, host);
    expect(lstatSync(path.join(account, "skills")).mtimeMs).toBe(before.mtimeMs);
  });

  it("links the codex user layer and keeps skills per-skill inside a real dir", async () => {
    const { host, account } = await homes();
    writeFileSync(path.join(host, "AGENTS.md"), "# rules");
    writeFileSync(path.join(host, "config.toml"), "model = 'x'");
    writeFileSync(path.join(host, "hooks.json"), "{}");
    mkdirSync(path.join(host, "prompts"));
    mkdirSync(path.join(host, "skills", ".system"), { recursive: true });
    mkdirSync(path.join(host, "skills", "bro"));
    mkdirSync(path.join(host, "skills", "kraus-grill"));

    link("codex", account, host);

    expect(readlinkSync(path.join(account, "AGENTS.md"))).toBe(path.join(host, "AGENTS.md"));
    expect(readlinkSync(path.join(account, "config.toml"))).toBe(path.join(host, "config.toml"));
    const skills = lstatSync(path.join(account, "skills"));
    expect(skills.isDirectory()).toBe(true);
    expect(skills.isSymbolicLink()).toBe(false);
    expect(readlinkSync(path.join(account, "skills", "bro"))).toBe(
      path.join(host, "skills", "bro"),
    );
    // .system is never linked; Codex writes its own.
    expect(existsSync(path.join(account, "skills", ".system"))).toBe(false);
  });

  it("prunes stale codex skill links and preserves real managed content", async () => {
    const { host, account } = await homes();
    mkdirSync(path.join(host, "skills", "bro"), { recursive: true });
    const managedSkills = path.join(account, "skills");
    mkdirSync(path.join(managedSkills, ".system"), { recursive: true });
    mkdirSync(path.join(managedSkills, "local-only"));
    symlinkSync(path.join(host, "skills", "gone"), path.join(managedSkills, "gone"));

    link("codex", account, host);

    expect(existsSync(path.join(managedSkills, "gone"))).toBe(false);
    expect(lstatSync(path.join(managedSkills, "local-only")).isDirectory()).toBe(true);
    expect(lstatSync(path.join(managedSkills, ".system")).isDirectory()).toBe(true);
  });

  it("does nothing when the host config dir does not exist or equals the account dir", async () => {
    const { root, host, account } = await homes();
    link("codex", account, path.join(root, "missing"));
    expect(readdirSync(account)).toEqual([]);
    link("claude", account, account);
    expect(readdirSync(account)).toEqual([]);
    // And with an empty host dir nothing is created either.
    link("claude", account, host);
    expect(readdirSync(account)).toEqual([]);
  });

  it("removes a managed link when the host entry disappears", async () => {
    const { host, account } = await homes();
    mkdirSync(path.join(host, "commands"));
    link("claude", account, host);
    expect(lstatSync(path.join(account, "commands")).isSymbolicLink()).toBe(true);

    await rm(path.join(host, "commands"), { recursive: true });
    link("claude", account, host);
    expect(existsSync(path.join(account, "commands"))).toBe(false);
  });
});
