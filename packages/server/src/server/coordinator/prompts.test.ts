import { describe, expect, test } from "vitest";

import {
  buildProjectCoordinatorFirstContactPrompt,
  buildProjectCoordinatorSystemPrompt,
} from "./prompts.js";

describe("buildProjectCoordinatorSystemPrompt", () => {
  test("names the project and the observe contract", () => {
    const prompt = buildProjectCoordinatorSystemPrompt("paseo");
    expect(prompt).toContain('"paseo"');
    expect(prompt).toContain("Observe");
    expect(prompt).toContain("remember");
    // The prompt states the restrictions the daemon enforces.
    expect(prompt).toMatch(/may NOT spawn agents/);
    expect(prompt).toMatch(/edit files/);
    expect(prompt).toMatch(/shell commands/);
  });
});

describe("buildProjectCoordinatorFirstContactPrompt", () => {
  test("describes first-contact steps and the everything scope", () => {
    const prompt = buildProjectCoordinatorFirstContactPrompt({
      projectId: "prj_1",
      projectName: "paseo",
      rootPath: "/repos/paseo",
      scope: "everything",
      trustLevel: "observe",
    });
    expect(prompt).toContain("prj_1");
    expect(prompt).toContain("/repos/paseo");
    expect(prompt).toContain("observe");
    expect(prompt).toContain("every session");
    expect(prompt).toContain("project.md");
    expect(prompt).toContain("exactly one decision");
  });

  test("project scope tells the coordinator your sessions are out of scope", () => {
    const prompt = buildProjectCoordinatorFirstContactPrompt({
      projectId: "prj_1",
      projectName: "paseo",
      rootPath: "/repos/paseo",
      scope: "project",
      trustLevel: "observe",
    });
    expect(prompt).toContain("delegated sessions only");
  });
});
