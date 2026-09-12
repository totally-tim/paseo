import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { AccountProvider } from "@getpaseo/protocol/provider-accounts";

/**
 * Managed account homes isolate credentials and history per account, but the CLIs
 * read their whole user layer — skills, commands, settings — from the same
 * directory. Reconcile links the shared entries in from the host config dir so a
 * managed agent sees the same user layer as a host agent. Everything not listed
 * here stays per-account; a file the CLI adds later defaults to private, which
 * fails safe for credentials.
 */

const CLAUDE_SHARED_ENTRIES = [
  "skills",
  "agents",
  "commands",
  "plugins",
  "hooks",
  "rules",
  "output-styles",
  "workflows",
  "themes",
  "scripts",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "keybindings.json",
  "statusline-command.sh",
];

const CODEX_SHARED_ENTRIES = ["AGENTS.md", "config.toml", "hooks.json", "rules", "prompts"];

const CODEX_SKILLS_DIR = "skills";
/** Codex rewrites skills/.system on every run, so it must stay a real per-account dir. */
const CODEX_SKILLS_PRIVATE = new Set([".system"]);

export interface EnsureUserLayerParams {
  provider: AccountProvider;
  accountDir: string;
  hostConfigDir: string;
  logger?: Logger;
}

export function ensureProviderAccountUserLayer(params: EnsureUserLayerParams): void {
  const { provider, accountDir, hostConfigDir } = params;
  if (hostConfigDir === accountDir) return;
  const names = provider === "claude" ? CLAUDE_SHARED_ENTRIES : CODEX_SHARED_ENTRIES;
  for (const name of names) {
    reconcileEntry(params, name);
  }
  if (provider === "codex") {
    reconcileCodexSkills(params);
  }
}

function reconcileEntry(params: EnsureUserLayerParams, name: string): void {
  const { accountDir, hostConfigDir, logger } = params;
  const target = path.join(hostConfigDir, name);
  const entryPath = path.join(accountDir, name);
  try {
    const hostExists = existsSync(target);
    const current = lstatOrNull(entryPath);

    if (!hostExists) {
      // Host removed the entry: drop our stale link, never real per-account content.
      if (current?.isSymbolicLink() && readlinkOrNull(entryPath) === target) {
        unlinkSync(entryPath);
      }
      return;
    }

    if (current?.isSymbolicLink()) {
      if (readlinkOrNull(entryPath) === target) return;
      unlinkSync(entryPath);
    } else if (current) {
      // A real file or directory already lives here (e.g. a plugins dir the CLI
      // created, or a temp+rename writer that replaced the link). Set it aside
      // rather than discarding it, then link.
      renameSync(entryPath, backupPath(entryPath));
    }

    symlinkSync(target, entryPath, statSync(target).isDirectory() ? "junction" : "file");
  } catch (error) {
    logger?.warn({ err: error, accountDir, entry: name }, "Failed to link provider user layer");
  }
}

function reconcileCodexSkills(params: EnsureUserLayerParams): void {
  const { accountDir, hostConfigDir, logger } = params;
  const hostSkills = path.join(hostConfigDir, CODEX_SKILLS_DIR);
  const managedSkills = path.join(accountDir, CODEX_SKILLS_DIR);
  try {
    const hostNames = new Set(
      existsSync(hostSkills)
        ? readdirSync(hostSkills).filter((name) => !CODEX_SKILLS_PRIVATE.has(name))
        : [],
    );
    const current = lstatOrNull(managedSkills);
    if (current?.isSymbolicLink()) unlinkSync(managedSkills);
    if (existsSync(hostSkills)) mkdirSync(managedSkills, { recursive: true, mode: 0o700 });
    if (!lstatOrNull(managedSkills)?.isDirectory()) return;

    for (const name of hostNames) {
      reconcileEntry({ ...params, accountDir: managedSkills, hostConfigDir: hostSkills }, name);
    }
    for (const name of readdirSync(managedSkills)) {
      const entryPath = path.join(managedSkills, name);
      const stat = lstatOrNull(entryPath);
      // Links are ours; a stale or unexpected one is removed. Real content stays.
      if (stat?.isSymbolicLink() && !hostNames.has(name)) unlinkSync(entryPath);
    }
  } catch (error) {
    logger?.warn({ err: error, accountDir }, "Failed to link Codex skills into account home");
  }
}

function backupPath(entryPath: string): string {
  const candidate = `${entryPath}.paseo-backup`;
  if (!existsSync(candidate)) return candidate;
  for (let i = 1; ; i += 1) {
    const next = `${candidate}-${i}`;
    if (!existsSync(next)) return next;
  }
}

function lstatOrNull(entryPath: string) {
  try {
    return lstatSync(entryPath);
  } catch {
    return null;
  }
}

function readlinkOrNull(entryPath: string): string | null {
  try {
    return readlinkSync(entryPath);
  } catch {
    return null;
  }
}
