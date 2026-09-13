import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GlobalCoordinatorState } from "@getpaseo/protocol/messages";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { PersistedProjectRecord } from "../workspace-registry.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ProposalSchema = z.object({
  projectId: z.string(),
  requestId: z.string(),
  requestedAt: z.string(),
  ignoredUntil: z.number().nullable(),
});
const ProposalsSchema = z.array(ProposalSchema);
type Proposal = z.infer<typeof ProposalSchema>;

interface ProjectSetupDependencies {
  paseoHome: string;
  agentManager: Pick<AgentManager, "getAgent" | "registerDaemonQuestion">;
  listProjects: () => Promise<PersistedProjectRecord[]>;
  coordinatorEnabled: (projectId: string) => Promise<boolean>;
  now?: () => number;
}

/** Setup needs profile choices in the app, so approval cannot grant an agent an enable tool. */
export class ProjectSetupProposals {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly active = new Map<string, (resolution?: AgentPermissionResponse) => void>();
  private proposals: Proposal[] | null = null;
  private tail: Promise<void> = Promise.resolve();
  private agentId: string | null = null;

  constructor(private readonly deps: ProjectSetupDependencies) {
    this.filePath = path.join(deps.paseoHome, "coordinator", "project-setup.json");
    this.now = deps.now ?? Date.now;
  }

  reconcile(state: GlobalCoordinatorState): Promise<void> {
    return this.serialize(async () => {
      if (this.agentId !== state.agentId || !state.enabled) this.clearActive();
      this.agentId = state.agentId;
      if (!state.enabled || !state.agentId) return;
      const agent = this.deps.agentManager.getAgent(state.agentId);
      if (!agent || agent.lifecycle === "closed") return;
      await this.load();
      const projects = await this.deps.listProjects();
      const eligible = projects.filter((project) => !project.hidden && !project.archivedAt);
      const eligibleIds = new Set(eligible.map((project) => project.projectId));
      for (const [projectId, unregister] of this.active) {
        if (eligibleIds.has(projectId)) continue;
        unregister();
        this.active.delete(projectId);
      }
      for (const project of eligible) {
        if (await this.deps.coordinatorEnabled(project.projectId)) {
          const proposals = await this.load();
          this.proposals = proposals.filter((entry) => entry.projectId !== project.projectId);
          if (this.proposals.length !== proposals.length) await this.save();
          this.active.get(project.projectId)?.({ behavior: "allow" });
          this.active.delete(project.projectId);
          continue;
        }
        if (this.active.has(project.projectId)) continue;
        const proposals = await this.load();
        let proposal = proposals.find((entry) => entry.projectId === project.projectId);
        if (proposal?.ignoredUntil && proposal.ignoredUntil > this.now()) continue;
        if (!proposal || proposal.ignoredUntil) {
          proposal = {
            projectId: project.projectId,
            requestId: `coordinator-setup:${randomUUID()}`,
            requestedAt: new Date(this.now()).toISOString(),
            ignoredUntil: null,
          };
          this.proposals = proposals.filter((entry) => entry.projectId !== project.projectId);
          this.proposals.push(proposal);
          // Persist before exposing the request, including across an interrupted startup.
          await this.save();
        }
        const projectName = project.customName ?? project.displayName;
        const request = proposal;
        const unregister = this.deps.agentManager.registerDaemonQuestion({
          agentId: agent.id,
          request: {
            id: request.requestId,
            provider: agent.provider,
            name: "Set up project coordinator",
            kind: "question",
            title: `Set up a coordinator for ${projectName}?`,
            requestedAt: request.requestedAt,
            input: {
              coordinatorProjectSetup: { projectId: project.projectId, projectName },
              questions: [
                {
                  header: "Coordinator",
                  question: `Set up a coordinator for ${projectName}?`,
                  options: [{ label: "Set up" }, { label: "Ignore" }],
                },
              ],
            },
          },
          respond: (response) => this.answer(request, response),
        });
        this.active.set(project.projectId, unregister);
      }
    });
  }

  stop(): void {
    this.clearActive();
  }

  private answer(proposal: Proposal, response: AgentPermissionResponse): Promise<void> {
    return this.serialize(async () => {
      const answers = response.behavior === "allow" ? response.updatedInput?.answers : undefined;
      const ignored =
        response.behavior === "deny" ||
        (typeof answers === "object" &&
          answers !== null &&
          Reflect.get(answers, "Coordinator") === "Ignore");
      if (!ignored && !(await this.deps.coordinatorEnabled(proposal.projectId))) {
        throw new Error(
          "Choose profiles and enable this project from the Coordinator board setup sheet.",
        );
      }
      const proposals = await this.load();
      this.proposals = proposals.filter((entry) => entry.requestId !== proposal.requestId);
      if (ignored) {
        this.proposals.push({ ...proposal, ignoredUntil: this.now() + 30 * 24 * 60 * 60 * 1000 });
      }
      await this.save();
      this.active.delete(proposal.projectId);
    });
  }

  private clearActive(): void {
    for (const unregister of this.active.values()) unregister();
    this.active.clear();
  }

  private async load(): Promise<Proposal[]> {
    if (this.proposals) return this.proposals;
    try {
      this.proposals = ProposalsSchema.parse(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      this.proposals = [];
    }
    return this.proposals;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, this.proposals);
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
}
