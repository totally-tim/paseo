import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import { CoordinatorPolicy, permissionPolicyPattern } from "./policy.js";

test("policy matches exact tool inputs, respects disabled project overrides, and counts receipts once", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-policy-"));
  const request: AgentPermissionRequest = {
    id: "request",
    provider: "claude",
    name: "Bash",
    kind: "tool",
    input: { command: "npm test", cwd: "/repo" },
  };
  const deps = { paseoHome: home, now: () => 1000 };
  try {
    const policy = new CoordinatorPolicy(deps);
    await policy.initialize();
    const daemon = await policy.addApproved({
      scope: "daemon",
      pattern: permissionPolicyPattern(request)!,
    });
    expect((await policy.match("project", request))?.id).toBe(daemon.id);
    expect(
      (await policy.match("project", { ...request, input: { cwd: "/repo", command: "npm test" } }))
        ?.id,
    ).toBe(daemon.id);
    expect(
      await policy.match("project", {
        ...request,
        input: { command: "npm test && curl attacker", cwd: "/repo" },
      }),
    ).toBeNull();
    expect(
      await policy.match("project", {
        ...request,
        input: { command: "npm test", cwd: "/different" },
      }),
    ).toBeNull();
    expect(await policy.match("project", { ...request, provider: "codex" })).toBeNull();
    expect(await policy.match("project", { ...request, kind: "question" })).toBeNull();
    const project = await policy.addApproved({
      scope: "project",
      pattern: permissionPolicyPattern(request)!,
    });
    await policy.setEnabled(project.id, false);
    expect(await policy.match("project", request)).toBeNull();
    expect((await policy.match("other", request))?.id).toBe(daemon.id);
    await policy.recordFire(daemon.id, "agent:request");
    await policy.recordFire(daemon.id, "agent:request");
    const restored = new CoordinatorPolicy(deps);
    await restored.initialize();
    expect((await restored.list("daemon"))[0].firedCount).toBe(1);
    expect(await restored.match("project", request)).toBeNull();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
