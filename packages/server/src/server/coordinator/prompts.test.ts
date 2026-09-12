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

  test("propose names the read-only kinds and keeps implementers out", () => {
    const prompt = buildProjectCoordinatorSystemPrompt("paseo", "propose");
    expect(prompt).toContain("Propose");
    expect(prompt).toContain('"investigator"');
    expect(prompt).toContain('"reviewer"');
    expect(prompt).toContain("subagentKind");
    expect(prompt).toMatch(/may NOT spawn implementers/);
    expect(prompt).toMatch(/open change requests/);
    // The delegation section teaches the steering tools once they exist.
    expect(prompt).toContain("DELEGATION");
    expect(prompt).toContain("send_agent_prompt");
  });

  test("ship names implementers, worktree isolation, and change requests", () => {
    const prompt = buildProjectCoordinatorSystemPrompt("paseo", "ship");
    expect(prompt).toContain("Ship");
    expect(prompt).toMatch(/implementers write in isolated worktrees/i);
    expect(prompt).toContain("change requests");
    expect(prompt).toMatch(/may NOT merge/);
  });

  test("autopilot names merge automation under the merge policy", () => {
    const prompt = buildProjectCoordinatorSystemPrompt("paseo", "autopilot");
    expect(prompt).toContain("Autopilot");
    expect(prompt).toMatch(/merge automation/);
    expect(prompt).toMatch(/merge policy/);
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

  test("the trust line tracks the level", () => {
    const at = (trustLevel: "observe" | "propose" | "ship" | "autopilot") =>
      buildProjectCoordinatorFirstContactPrompt({
        projectId: "prj_1",
        projectName: "paseo",
        rootPath: "/repos/paseo",
        scope: "everything",
        trustLevel,
      });
    expect(at("observe")).toContain("spawn nothing");
    expect(at("propose")).toContain("investigator and reviewer subagents");
    expect(at("ship")).toContain("own worktrees");
    expect(at("autopilot")).toContain("merge automation");
  });
});
