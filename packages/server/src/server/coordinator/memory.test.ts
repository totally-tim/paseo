import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { CoordinatorMemory } from "./memory.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "coordinator-memory-")));
  homes.push(home);
  return { home, memory: new CoordinatorMemory({ paseoHome: home }) };
}

it("defaults remember to personal and keeps a stale pane edit from overwriting a newer fact", async () => {
  const { home, memory } = await fixture();
  const before = await memory.readPersonal({ scope: "personal" });
  const remembered = await memory.remember({
    cwd: home,
    coordinator: true,
    content: "Prefers squash merges",
  });
  expect(remembered.filePath).toBe(path.join(home, "coordinator", "memory.md"));
  expect(remembered.content).toContain("Prefers squash merges");
  await expect(
    memory.updatePersonal({
      scope: "personal",
      content: "stale",
      expectedRevision: before.revision,
    }),
  ).rejects.toThrow("changed");
  expect(await readFile(remembered.filePath, "utf8")).toBe(remembered.content);
  const cleared = await memory.updatePersonal({
    scope: "personal",
    content: "",
    expectedRevision: remembered.revision,
  });
  expect(cleared.content).toBe("");
});

it("serializes concurrent appends across memory instances without losing facts", async () => {
  const { home, memory } = await fixture();
  const other = new CoordinatorMemory({ paseoHome: home });
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? other : memory).remember({
        cwd: home,
        coordinator: false,
        scope: "team",
        content: `Fact ${index}`,
      }),
    ),
  );
  const layers = await memory.readLayers({ cwd: home });
  for (let index = 0; index < 12; index++) expect(layers.learned).toContain(`Fact ${index}\n`);
  expect(layers.learned.match(/Fact /g)).toHaveLength(12);
  expect(layers.team).toBe("");
});

it("restricts worker team writes to appends while coordinators can prune learned memory", async () => {
  const { home, memory } = await fixture();
  await memory.remember({
    cwd: home,
    coordinator: false,
    scope: "team",
    content: "The tests require UTC.",
  });
  await expect(
    memory.remember({
      cwd: home,
      coordinator: false,
      scope: "team",
      file: "project.md",
      content: "Overwrite summary",
    }),
  ).rejects.toThrow("only append");
  await expect(
    memory.remember({
      cwd: home,
      coordinator: false,
      scope: "team",
      mode: "replace",
      content: "Overwrite learned",
    }),
  ).rejects.toThrow("only append");
  await memory.remember({
    cwd: home,
    coordinator: true,
    scope: "team",
    file: "learned.md",
    mode: "replace",
    content: "Tests run in UTC.",
  });
  expect((await memory.readLayers({ cwd: home })).learned).toBe("Tests run in UTC.\n");
  await expect(
    memory.remember({
      cwd: home,
      coordinator: true,
      scope: "team",
      content: "Tim prefers squash merges.",
    }),
  ).rejects.toThrow("scope personal or personal-project");
});

it("reads team memory from each checkout and shares personal project memory", async () => {
  const { home, memory } = await fixture();
  const branch = path.join(home, "branch");
  await mkdir(branch);
  await memory.remember({
    cwd: home,
    coordinator: true,
    scope: "team",
    mode: "replace",
    content: "Main branch facts",
  });
  await memory.remember({
    cwd: branch,
    coordinator: true,
    scope: "team",
    mode: "replace",
    content: "Feature branch facts",
  });
  await memory.remember({
    cwd: branch,
    coordinator: true,
    scope: "personal-project",
    projectId: "project",
    content: "Use squash merges",
  });
  const main = await memory.readLayers({ cwd: home, projectId: "project" });
  const feature = await memory.readLayers({ cwd: branch, projectId: "project" });
  expect(main.team).toBe("Main branch facts\n");
  expect(feature.team).toBe("Feature branch facts\n");
  expect(feature.personalProject).toBe(main.personalProject);
  expect(feature.personalProject).toContain("Use squash merges");
});

it("rejects traversal and symlink reads and writes without touching their target", async () => {
  const { home, memory } = await fixture();
  const outside = path.join(home, "outside.md");
  await writeFile(outside, "private");
  await mkdir(path.join(home, "coordinator"));
  await symlink(outside, path.join(home, "coordinator", "memory.md"));
  await expect(memory.readPersonal({ scope: "personal" })).rejects.toThrow("symlink");
  await expect(
    memory.remember({ cwd: home, coordinator: true, content: "overwrite" }),
  ).rejects.toThrow("symlink");
  await expect(
    memory.readPersonal({ scope: "personal-project", projectId: "../../outside" }),
  ).rejects.toThrow("valid projectId");
  await symlink(home, path.join(home, ".paseo"));
  await expect(memory.readLayers({ cwd: home })).rejects.toThrow("symlink");
  expect(await readFile(outside, "utf8")).toBe("private");
});

it("enforces the UTF8 limit before writing and keeps the previous revision", async () => {
  const { memory } = await fixture();
  const initial = await memory.readPersonal({ scope: "personal" });
  await expect(
    memory.updatePersonal({
      scope: "personal",
      content: "🐑".repeat(32769),
      expectedRevision: initial.revision,
    }),
  ).rejects.toThrow("128 KiB");
  expect(await memory.readPersonal({ scope: "personal" })).toEqual(initial);
});

it("allows codebase facts about preference storage while rejecting named personal preferences", async () => {
  const { home, memory } = await fixture();
  await memory.remember({
    cwd: home,
    coordinator: true,
    scope: "team",
    content: "User preferences are stored in settings.json.",
  });
  await expect(
    memory.remember({
      cwd: home,
      coordinator: true,
      scope: "team",
      content: "Alice likes concise replies.",
    }),
  ).rejects.toThrow("scope personal");
  expect((await memory.readLayers({ cwd: home })).team).toContain("settings.json");
});
