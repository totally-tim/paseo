import type { Agent, PermissionRequest, TimelineItem, Workspace } from "./types";

const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

function parentId(agent: Agent): string | null {
  return agent.labels[PARENT_AGENT_ID_LABEL] ?? null;
}

/** The most recent activity the snapshot exposes. */
function activityAt(agent: Agent): string {
  return agent.lastUserMessageAt && agent.lastUserMessageAt > agent.updatedAt
    ? agent.lastUserMessageAt
    : agent.updatedAt;
}

export type Lane = "needsYou" | "working" | "done";
export type CardReason = "question" | "permission" | "error" | "working" | "finished";
/** The reasons a card can sit in the needs-you lane; the reason filter's domain. */
export type NeedsReason = Extract<CardReason, "question" | "permission" | "error">;

export interface InboxCard {
  agent: Agent;
  /** The member whose request, activity, error, or result gives the card its state. */
  subject: Agent;
  members: readonly Agent[];
  workspace: Workspace | null;
  lane: Lane;
  reason: CardReason;
  /** The request to answer. May belong to a same-workspace subagent. */
  request: PermissionRequest | null;
  subagentCount: number;
  /** When the agent entered its current state. */
  since: string | null;
}

export type Lanes = Record<Lane, InboxCard[]>;

export interface ProjectLanesOptions {
  workspaceId?: string;
}

/**
 * A subagent rolls up into its parent when both live in the same workspace,
 * which mirrors how the sidebar aggregates workspace status. A cross-workspace
 * subagent is its own card.
 */
function groupByRoot(agents: readonly Agent[]): Map<string, Agent[]> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, Agent[]>();
  for (const agent of agents) {
    let root = agent;
    const seen = new Set<string>();
    let parentAgentId = parentId(root);
    while (parentAgentId && !seen.has(root.id)) {
      seen.add(root.id);
      const parent = byId.get(parentAgentId);
      if (!parent || parent.workspaceId !== root.workspaceId) break;
      root = parent;
      parentAgentId = parentId(root);
    }
    const group = groups.get(root.id) ?? [];
    if (root.id === agent.id) group.unshift(agent);
    else group.push(agent);
    groups.set(root.id, group);
  }
  return groups;
}

function firstRequest(
  agents: readonly Agent[],
): { request: PermissionRequest; agent: Agent } | null {
  const ordered = [...agents].sort(
    (a, b) =>
      time(a.attentionTimestamp ?? activityAt(a)) - time(b.attentionTimestamp ?? activityAt(b)),
  );
  for (const agent of ordered) {
    const request = agent.pendingPermissions[0];
    if (request) return { request, agent };
  }
  return null;
}

function toCard(
  root: Agent,
  members: readonly Agent[],
  workspace: Workspace | null,
): InboxCard | null {
  const base = {
    agent: root,
    members,
    workspace,
    subagentCount: members.length - 1,
  };
  const pending = firstRequest(members);
  if (pending) {
    return {
      ...base,
      lane: "needsYou",
      reason: pending.request.kind === "question" ? "question" : "permission",
      request: pending.request,
      subject: pending.agent,
      since: pending.agent.attentionTimestamp ?? activityAt(pending.agent),
    };
  }
  const errored = members.find(
    (agent) =>
      agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error"),
  );
  if (errored) {
    return {
      ...base,
      lane: "needsYou",
      reason: "error",
      request: null,
      subject: errored,
      since: errored.attentionTimestamp ?? activityAt(errored),
    };
  }
  const running = members.find(
    (agent) => agent.status === "running" || agent.status === "initializing",
  );
  if (running) {
    return {
      ...base,
      lane: "working",
      reason: "working",
      request: null,
      subject: running,
      since: running.activeTurn?.startedAt ?? activityAt(running),
    };
  }
  const finished = members.find(
    (agent) => agent.requiresAttention && agent.attentionReason === "finished",
  );
  if (finished) {
    return {
      ...base,
      lane: "done",
      reason: "finished",
      request: null,
      subject: finished,
      since: finished.attentionTimestamp ?? activityAt(finished),
    };
  }
  return null;
}

function time(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const NEEDS_YOU_RANK: Record<CardReason, number> = {
  question: 0,
  permission: 0,
  error: 1,
  working: 2,
  finished: 3,
};

export function projectLanes(
  agents: Iterable<Agent>,
  workspaces: ReadonlyMap<string, Workspace>,
  options: ProjectLanesOptions = {},
): Lanes {
  const active = Array.from(agents).filter(
    (agent) =>
      !agent.archivedAt && (!options.workspaceId || agent.workspaceId === options.workspaceId),
  );
  const lanes: Lanes = { needsYou: [], working: [], done: [] };
  for (const [rootId, members] of groupByRoot(active)) {
    const root = members.find((agent) => agent.id === rootId);
    if (!root) continue;
    const workspace = root.workspaceId ? (workspaces.get(root.workspaceId) ?? null) : null;
    const card = toCard(root, members, workspace);
    if (card) lanes[card.lane].push(card);
  }
  lanes.needsYou.sort(
    (a, b) => time(a.since) - time(b.since) || NEEDS_YOU_RANK[a.reason] - NEEDS_YOU_RANK[b.reason],
  );
  lanes.working.sort((a, b) => time(activityAt(b.agent)) - time(activityAt(a.agent)));
  lanes.done.sort((a, b) => time(b.since) - time(a.since));
  return lanes;
}

export function formatSince(iso: string | null, now: number = Date.now()): string {
  const start = time(iso);
  if (!start) return "";
  return formatDuration(Math.max(0, Math.round((now - start) / 1000)));
}

/** Future timestamps read "in 5m"; past or unparseable read "due now"/"". */
export function formatUntil(iso: string | null, now: number = Date.now()): string {
  const start = time(iso);
  if (!start) return "";
  const seconds = Math.round((start - now) / 1000);
  if (seconds <= 0) return "due now";
  return `in ${formatDuration(seconds)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** What a snooze records; the card resurfaces when its wait state changes. */
export function snoozeStamp(card: InboxCard): string {
  return card.since ?? "";
}

export type Urgency = "normal" | "warn" | "danger";

const URGENCY_WARN_MS = 4 * 60 * 60 * 1000;
const URGENCY_DANGER_MS = 24 * 60 * 60 * 1000;

/** Errors are urgent immediately; questions and approvals age into it. */
export function urgencyLevel(card: InboxCard, now: number = Date.now()): Urgency {
  if (card.lane !== "needsYou") return "normal";
  if (card.reason === "error") return "danger";
  // A missing timestamp must not age into danger: time(null) parses as epoch.
  const since = time(card.since);
  if (!since) return "normal";
  const waited = now - since;
  if (waited >= URGENCY_DANGER_MS) return "danger";
  if (waited >= URGENCY_WARN_MS) return "warn";
  return "normal";
}

/** Empty lanes shrink; busy lanes widen. Keeps populated columns readable. */
export function laneFlexGrow(count: number): number {
  if (count <= 0) return 0.55;
  return 1 + Math.min(count, 4) * 0.2;
}

/** Milliseconds without a new timeline row before a working card reads as quiet. */
export const QUIET_AFTER_MS = 2 * 60 * 1000;

/**
 * A running tool call or in-flight compaction is expected silence: the row sits
 * frozen until the operation ends. Everything else going quiet means the agent
 * produced nothing.
 */
export function activityInFlight(item: TimelineItem | undefined | null): boolean {
  if (!item) return false;
  if (item.type === "tool_call") return item.status === "running";
  if (item.type === "compaction") return item.status === "loading";
  return false;
}

/** Renders once the newest timeline row is older than QUIET_AFTER_MS. */
export function quietText(
  lastAt: string | null,
  inFlight: boolean,
  now: number = Date.now(),
): string | null {
  if (!lastAt || inFlight) return null;
  const quietMs = now - time(lastAt);
  if (quietMs < QUIET_AFTER_MS) return null;
  return `quiet ${formatDuration(Math.round(quietMs / 1000))}`;
}
