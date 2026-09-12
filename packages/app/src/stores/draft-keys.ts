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
}): string {
  const serverId = input.serverId.trim();
  const explicitDraftId = input.draftId?.trim();
  if (explicitDraftId) {
    return buildWorkspaceDraftTabDraftKey({ serverId, draftId: explicitDraftId });
  }
  return `agent:${serverId}:${input.agentId.trim()}`;
}

/** A workspace draft tab's composer key — the draft id, not a session. */
export function buildWorkspaceDraftTabDraftKey(input: {
  serverId: string;
  draftId: string;
}): string {
  return `draft:${input.serverId.trim()}:${input.draftId.trim()}`;
}

/**
 * The board's composer rides on the coordinator session key so text typed on
 * the board shows up in the chat tab and vice versa. While no session is
 * running the draft is parked under a project-scoped key.
 */
export function buildCoordinatorBoardDraftKey(input: {
  serverId: string;
  projectId: string;
  coordinatorAgentId?: string | null;
}): string {
  const coordinatorAgentId = input.coordinatorAgentId?.trim();
  if (coordinatorAgentId) {
    return buildDraftStoreKey({ serverId: input.serverId, agentId: coordinatorAgentId });
  }
  return `coordinator-board:${input.serverId.trim()}:${input.projectId.trim()}`;
}
