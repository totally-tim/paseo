import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

export interface CoordinatorMemoryTarget {
  scope: "personal" | "personal-project";
  projectId?: string;
}
export interface CoordinatorMemoryUpdate extends CoordinatorMemoryTarget {
  content: string;
  expectedRevision: string;
}
export interface CoordinatorMemorySnapshot {
  filePath: string;
  content: string;
  revision: string;
}
export interface RememberMemoryInput {
  scope?: "team" | "personal" | "personal-project";
  projectId?: string;
  cwd: string;
  coordinator: boolean;
  content: string;
  mode?: "append" | "replace";
  file?: "project.md" | "learned.md";
}

const MAX_MEMORY_BYTES = 128 * 1024;
const writes = new Map<string, Promise<unknown>>();

async function serialize<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const previous = writes.get(filePath) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(run);
  writes.set(filePath, operation);
  try {
    return await operation;
  } finally {
    if (writes.get(filePath) === operation) writes.delete(filePath);
  }
}

function validateContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES)
    throw new Error("Memory must be at most 128 KiB; remove older entries before saving.");
}
function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
function snapshot(filePath: string, content: string): CoordinatorMemorySnapshot {
  return { filePath, content, revision: revision(content) };
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Reject symlinks at every child component, including reads from a repository checkout. */
async function resolveFile(root: string, segments: string[], create: boolean): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  let current = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\")
    )
      throw new Error("Invalid memory path component");
    current = path.join(current, segment);
    const isDirectory = index < segments.length - 1;
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!missing(error)) throw error;
      if (create && isDirectory) {
        await fs.mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
          if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        });
        stat = await fs.lstat(current);
      }
    }
    if (stat?.isSymbolicLink())
      throw new Error(`Memory path must not contain symlinks: ${current}`);
    if (stat && (isDirectory ? !stat.isDirectory() : !stat.isFile()))
      throw new Error(`Invalid memory file: ${current}`);
  }
  return current;
}

async function readFile(filePath: string): Promise<string> {
  try {
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) return "";
    throw error;
  }
}

/** The parent path is rechecked before rename; responses never report an undurable write. */
async function replaceFile(
  root: string,
  segments: string[],
  content: string,
): Promise<CoordinatorMemorySnapshot> {
  validateContent(content);
  const filePath = await resolveFile(root, segments, true);
  const temporary = path.join(path.dirname(filePath), `.memory-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await resolveFile(root, segments, false);
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
  return snapshot(filePath, content);
}

function teamContentIsPersonal(content: string): boolean {
  return (
    /\b(?:prefers?|dislikes?|favourites?|favorites?)\b/i.test(content) ||
    /\b(?:my|your|his|her|their|user's|owner's)\s+preferences?\b/i.test(content) ||
    /\b(?:i|you|he|she|the user|the owner)\s+(?:like|likes|want|wants|need|needs|am|is|are)\b/i.test(
      content,
    ) ||
    /\b[A-Z][a-z]+\s+(?:likes|dislikes|prefers|lives)\b/.test(content)
  );
}

export class CoordinatorMemory {
  constructor(private readonly options: { paseoHome: string }) {}

  private personalSegments(target: CoordinatorMemoryTarget): string[] {
    if (target.scope === "personal") {
      if (target.projectId !== undefined)
        throw new Error("Use personal-project scope for project memory.");
      return ["coordinator", "memory.md"];
    }
    if (!target.projectId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.projectId))
      throw new Error("A valid projectId is required for personal-project memory.");
    return ["coordinator", "projects", target.projectId, "memory.md"];
  }

  async readPersonal(target: CoordinatorMemoryTarget): Promise<CoordinatorMemorySnapshot> {
    const filePath = await resolveFile(
      this.options.paseoHome,
      this.personalSegments(target),
      false,
    );
    return snapshot(filePath, await readFile(filePath));
  }

  async updatePersonal(input: CoordinatorMemoryUpdate): Promise<CoordinatorMemorySnapshot> {
    validateContent(input.content);
    const segments = this.personalSegments(input);
    const filePath = await resolveFile(this.options.paseoHome, segments, false);
    return serialize(filePath, async () => {
      await resolveFile(this.options.paseoHome, segments, false);
      const current = await readFile(filePath);
      if (revision(current) !== input.expectedRevision)
        throw new Error(
          "Memory changed since you opened it. Reload the latest text before saving your edits.",
        );
      return replaceFile(this.options.paseoHome, segments, input.content);
    });
  }

  async remember(input: RememberMemoryInput): Promise<CoordinatorMemorySnapshot> {
    const scope = input.scope ?? "personal";
    const content = input.content.trim();
    if (!content) throw new Error("remember content must not be empty");
    const file = input.file ?? (input.coordinator ? "project.md" : "learned.md");
    if (
      scope === "team" &&
      !input.coordinator &&
      (file !== "learned.md" || input.mode === "replace")
    )
      throw new Error(
        "Subagents may only append to team learned.md; ask the coordinator to revise project memory.",
      );
    if (scope === "team" && teamContentIsPersonal(content))
      throw new Error(
        "Team memory must describe the codebase. Store preferences or facts about a person with scope personal or personal-project.",
      );
    if (scope !== "team" && input.file !== undefined)
      throw new Error("The file option is only available for team memory.");
    const root = scope === "team" ? input.cwd : this.options.paseoHome;
    const segments =
      scope === "team"
        ? [".paseo", "memory", file]
        : this.personalSegments({
            scope,
            ...(scope === "personal-project" ? { projectId: input.projectId } : {}),
          });
    const filePath = await resolveFile(root, segments, false);
    return serialize(filePath, async () => {
      await resolveFile(root, segments, false);
      const existing = await readFile(filePath);
      const next =
        input.mode === "replace"
          ? `${content}\n`
          : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}## ${new Date().toISOString().slice(0, 10)}\n\n${content}\n`;
      return replaceFile(root, segments, next);
    });
  }

  async readLayers(input: {
    cwd: string;
    projectId?: string;
  }): Promise<{ team: string; learned: string; personalDaemon: string; personalProject: string }> {
    const [team, learned, personalDaemon, personalProject] = await Promise.all([
      resolveFile(input.cwd, [".paseo", "memory", "project.md"], false).then(readFile),
      resolveFile(input.cwd, [".paseo", "memory", "learned.md"], false).then(readFile),
      this.readPersonal({ scope: "personal" }),
      input.projectId
        ? this.readPersonal({ scope: "personal-project", projectId: input.projectId })
        : null,
    ]);
    return {
      team,
      learned,
      personalDaemon: personalDaemon.content,
      personalProject: personalProject?.content ?? "",
    };
  }
}
