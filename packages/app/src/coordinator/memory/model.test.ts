import { expect, it } from "vitest";
import { openMemoryEditor } from "./model";
const initial = {
  filePath: "/paseo/coordinator/memory.md",
  content: "prefers squash merges",
  revision: "r1",
};
function ready(model: ReturnType<typeof openMemoryEditor>) {
  if (model.getState().load.status === "loaded") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = model.subscribe(() => {
      if (model.getState().load.status === "loaded") {
        unsubscribe();
        resolve();
      }
    });
  });
}
it("saves a personal memory edit with its loaded revision, including an empty file", async () => {
  const writes: unknown[] = [];
  const model = openMemoryEditor({ scope: "personal" });
  model.setClient({
    getCoordinatorMemory: async () => initial,
    updateCoordinatorMemory: async (input) => {
      writes.push(input);
      return { ...initial, content: input.content, revision: "r2" };
    },
  });
  await ready(model);
  model.edit("");
  await model.save();
  expect(writes).toEqual([{ scope: "personal", content: "", expectedRevision: "r1" }]);
  expect(model.getState()).toMatchObject({
    text: "",
    dirty: false,
    saving: false,
    load: { snapshot: { revision: "r2" } },
  });
});
it("preserves the draft and revision on conflict instead of overwriting newer memory", async () => {
  const model = openMemoryEditor({ scope: "personal-project", projectId: "project-a" });
  const writes: unknown[] = [];
  model.setClient({
    getCoordinatorMemory: async () => initial,
    updateCoordinatorMemory: async (input) => {
      writes.push(input);
      throw new Error("Memory changed. Reload before saving.");
    },
  });
  await ready(model);
  model.edit("edited locally");
  await model.save();
  expect(writes).toEqual([
    {
      scope: "personal-project",
      projectId: "project-a",
      content: "edited locally",
      expectedRevision: "r1",
    },
  ]);
  expect(model.getState()).toMatchObject({
    text: "edited locally",
    dirty: true,
    error: "Memory changed. Reload before saving.",
    load: { snapshot: { revision: "r1" } },
  });
});
it("keeps offline edits on reconnect, then saves against the original revision", async () => {
  const model = openMemoryEditor({ scope: "personal" });
  let reads = 0;
  const client = {
    getCoordinatorMemory: async () => {
      ++reads;
      return initial;
    },
    updateCoordinatorMemory: async (input: { content: string }) => ({
      ...initial,
      content: input.content,
      revision: "r2",
    }),
  };
  model.setClient(client);
  await ready(model);
  model.setClient(null);
  model.edit("keep this edit");
  await model.save();
  expect(model.getState()).toMatchObject({ text: "keep this edit", dirty: true, connected: false });
  model.setClient(client);
  expect(reads).toBe(1);
  await model.save();
  expect(model.getState()).toMatchObject({ text: "keep this edit", dirty: false });
});
it("does not let a closed pane's late load replace another project's memory", async () => {
  let complete: (value: typeof initial) => void = () => {};
  const first = openMemoryEditor({ scope: "personal-project", projectId: "a" });
  first.setClient({
    getCoordinatorMemory: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    updateCoordinatorMemory: async () => initial,
  });
  first.close();
  const second = openMemoryEditor({ scope: "personal-project", projectId: "b" });
  second.setClient({
    getCoordinatorMemory: async (target) => ({ ...initial, content: target.projectId ?? "global" }),
    updateCoordinatorMemory: async () => initial,
  });
  await ready(second);
  complete(initial);
  await Promise.resolve();
  expect(second.getState().text).toBe("b");
  expect(first.getState().load.status).toBe("loading");
});
