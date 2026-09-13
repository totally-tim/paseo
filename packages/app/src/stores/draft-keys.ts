import {
  COORDINATOR_GLOBAL_ROLE,
  getCoordinatorRole,
  getCoordinatorProjectIdFromLabels,
} from "@getpaseo/protocol/agent-labels";
import { generateMessageId } from "@/types/stream";

export const NEW_WORKSPACE_DRAFT_KEY = "new-workspace";
const NEW_WORKSPACE_FORK_DRAFT_PREFIX = `${NEW_WORKSPACE_DRAFT_KEY}:draft:`;

export function generateDraftId(): string {
  return `draft_${generateMessageId()}`;
}

export function buildNewWorkspaceDraftKey(draftId?: string): string {
  const explicitDraftId = draftId?.trim();
  if (explicitDraftId) {
    return `${NEW_WORKSPACE_FORK_DRAFT_PREFIX}${explicitDraftId}`;
  }
  return NEW_WORKSPACE_DRAFT_KEY;
}

export function isLegacyNewWorkspaceDraftKey(draftKey: string): boolean {
  return (
    draftKey.startsWith(`${NEW_WORKSPACE_DRAFT_KEY}:`) &&
    !draftKey.startsWith(NEW_WORKSPACE_FORK_DRAFT_PREFIX)
  );
}

export function buildDraftStoreKey(input: {
  serverId: string;
  agentId: string;
  draftId?: string | null;
  labels?: Record<string, string> | null;
}): string {
  const serverId = input.serverId.trim();
  const explicitDraftId = input.draftId?.trim();
  if (explicitDraftId) {
    return buildWorkspaceDraftTabDraftKey({ serverId, draftId: explicitDraftId });
  }
  const role = getCoordinatorRole(input.labels);
  if (role === COORDINATOR_GLOBAL_ROLE) return buildGlobalCoordinatorDraftKey(serverId);
  const projectId = role ? getCoordinatorProjectIdFromLabels(input.labels) : null;
  if (projectId) return buildCoordinatorBoardDraftKey({ serverId, projectId });
  return `agent:${serverId}:${input.agentId.trim()}`;
}

/** A workspace draft tab's composer key — the draft id, not a session. */
export function buildWorkspaceDraftTabDraftKey(input: {
  serverId: string;
  draftId: string;
}): string {
  return `draft:${input.serverId.trim()}:${input.draftId.trim()}`;
}

/** The coordinator role owns the draft, shared by its board and successor Chat tabs. */
export function buildGlobalCoordinatorDraftKey(serverId: string): string {
  return `coordinator-global:${serverId.trim()}`;
}
export function buildCoordinatorBoardDraftKey(input: {
  serverId: string;
  projectId: string;
  coordinatorAgentId?: string | null;
}): string {
  return `coordinator-board:${input.serverId.trim()}:${input.projectId.trim()}`;
}
