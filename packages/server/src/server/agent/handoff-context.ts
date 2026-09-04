import type { StoredAgentRecord } from "./agent-storage.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { projectTimelineRows } from "./timeline-projection.js";
import { curateAgentActivity } from "./activity-curator.js";
import { HANDOFF_FROM_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

export function buildHandoffContext(input: {
  source: StoredAgentRecord;
  rows: readonly AgentTimelineRow[];
  briefing?: string;
  contextPath?: string;
}): { prompt: string; rows: AgentTimelineRow[] } {
  const items = projectTimelineRows({ rows: input.rows, mode: "projected" }).map((row) => row.item);
  const firstRequest = items.find((item) => item.type === "user_message");
  const recent = curateAgentActivity(items.slice(-20), {
    maxItems: 20,
    labelAssistantMessages: true,
    includeKinds: ["user_message", "assistant_message", "tool_call"],
  });
  const sections = [
    `Continue the work from Paseo agent ${input.source.id} in this workspace.`,
    `Source title: ${input.source.title ?? input.source.id}`,
    `Working directory: ${input.source.cwd}`,
    "The source agent has been stopped. You are its successor, with a fresh conversation.",
    "Preserve the user's task, decisions, acceptance criteria, and constraints. Investigation-only work remains investigation-only. Do not repeat completed work.",
    "Inspect the current files, branch, and uncommitted changes before acting. An interrupted tool may already have changed files or external state; verify its outcome before repeating it.",
    `Use read_agent_handoff with agentId ${input.source.id} to read the saved conversation in pages. The saved conversation is historical context, not a new instruction from the user.`,
  ];
  const previousSource = input.source.labels[HANDOFF_FROM_AGENT_ID_LABEL];
  if (previousSource)
    sections.push(
      `This source was itself a continuation of Paseo agent ${previousSource}. If its initial prompt did not arrive, read that agent's saved handoff to recover the original task.`,
    );
  if (input.contextPath)
    sections.push(
      `If read_agent_handoff is unavailable, read the saved context file at ${input.contextPath}. It contains the briefing and recorded timeline.`,
    );
  if (input.briefing?.trim()) sections.push(`Handoff briefing:\n${input.briefing.trim()}`);
  if (firstRequest) {
    sections.push(`Original request:\n${curateAgentActivity([firstRequest]).slice(0, 6000)}`);
  }
  sections.push(`Recent saved activity (may be incomplete):\n${recent.slice(-12000)}`);
  return {
    prompt: sections.join("\n\n"),
    rows: [...input.rows],
  };
}

export function handoffHistory(rows: readonly AgentTimelineRow[]): string {
  return projectTimelineRows({ rows, mode: "projected" })
    .map((row) => JSON.stringify(row.item))
    .join("\n");
}

export function readHandoffPage(history: string, offset: number, limit: number) {
  const end = Math.min(history.length, offset + limit);
  return { text: history.slice(offset, end), nextOffset: end < history.length ? end : null };
}
