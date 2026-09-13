import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { CoordinatorProposals } from "./proposals.js";

const input = {
  sourceAgentId: "coordinator",
  projectIds: ["a", "b"],
  sentence: "Keep dependencies current",
  evidence: [{ title: "Four stale PRs" }],
  payload: {
    kind: "goal" as const,
    ruleYaml:
      "name: dependencies\non: cron\ncron: '0 8 * * 1'\nstep: { profile: implementer, prompt: Update dependencies }\nguard: { max_concurrent: 1 }\n",
  },
};

test("proposal approval is durable before fanout and unapplied approval resumes after restart", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-proposals-"));
  let fail = true;
  const applied = new Set<string>();
  const deps = {
    paseoHome: home,
    now: () => 1000,
    apply: async (proposal: { id: string }) => {
      applied.add(proposal.id);
      if (fail) throw new Error("schedule unavailable");
    },
  };
  try {
    const proposals = new CoordinatorProposals(deps);
    await proposals.initialize();
    const proposal = (await proposals.propose(input))!;
    expect(applied.size).toBe(0);
    await expect(proposals.approve(proposal.id)).rejects.toThrow("schedule unavailable");
    expect((await proposals.list())[0]).toMatchObject({
      status: "approved",
      error: "schedule unavailable",
    });
    fail = false;
    const restored = new CoordinatorProposals(deps);
    await restored.initialize();
    await restored.reconcile();
    await restored.approve(proposal.id);
    expect(applied.size).toBe(1);
    expect((await restored.list())[0]).toMatchObject({
      status: "approved",
      appliedAt: new Date(1000).toISOString(),
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ignored semantic proposals stay suppressed for thirty days and edited proposals need fresh approval", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coordinator-proposal-ignore-"));
  let now = 1000;
  const applied: string[] = [];
  try {
    const proposals = new CoordinatorProposals({
      paseoHome: home,
      now: () => now,
      apply: async (proposal) => {
        applied.push(proposal.id);
      },
    });
    await proposals.initialize();
    const original = (await proposals.propose(input))!;
    const edited = await proposals.edit(original.id, { ...input, sentence: "Use a different day" });
    expect(edited.id).not.toBe(original.id);
    expect(applied).toEqual([]);
    await expect(proposals.approve(original.id)).rejects.toThrow("cannot be approved");
    await proposals.ignore(edited.id);
    expect(
      await proposals.propose({
        ...input,
        payload: {
          ...input.payload,
          ruleYaml: `${input.payload.ruleYaml}\n# Same approved meaning\n`,
        },
      }),
    ).toBeNull();
    now += 30 * 86400000;
    const fresh = (await proposals.propose(input))!;
    expect(fresh.status).toBe("pending");
    expect(fresh.id).not.toBe(edited.id);
    expect(applied).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
