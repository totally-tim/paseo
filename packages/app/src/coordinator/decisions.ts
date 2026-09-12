import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { CoordinatorDecisionBoardRow } from "@getpaseo/protocol/messages";
import type { PendingPermission } from "@/types/shared";

/**
 * The live permission a decision row resolves through, when it is still
 * pending. Row `requestId` is the request's own id, so the canonical key is
 * `agentId:requestId` — the scan only has to exist for rows whose request came
 * in through a path that keyed the map differently.
 */
export function resolveDecisionPermission(
  pendingPermissions: ReadonlyMap<string, PendingPermission>,
  row: Pick<CoordinatorDecisionBoardRow, "agentId" | "requestId">,
): PendingPermission | null {
  const direct = pendingPermissions.get(`${row.agentId}:${row.requestId}`);
  if (direct) {
    return direct;
  }
  for (const permission of pendingPermissions.values()) {
    if (permission.agentId === row.agentId && permission.request.id === row.requestId) {
      return permission;
    }
  }
  return null;
}

export interface BoardAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant: "primary" | "secondary" | "danger" | undefined;
  /** Spec: the first renderable answer renders as the primary action. */
  primary: boolean;
}

/**
 * Row answers are the permission request's action ids. The live request is the
 * only place an action's allow/deny behavior exists, so it wins when present.
 * A coordinator-owned answer whose request already left the pending map still
 * resolves daemon-side by `selectedActionId`, where allow is the pass-through
 * — the row is about to disappear either way.
 */
export function resolveBoardActions(
  row: Pick<CoordinatorDecisionBoardRow, "actions">,
  permission: PendingPermission | null,
): BoardAction[] {
  const requestActions = new Map(
    (permission?.request.actions ?? []).map((action) => [action.id, action]),
  );
  return row.actions.map((action, index) => {
    const requestAction = requestActions.get(action.id);
    return {
      id: action.id,
      label: action.label,
      behavior: requestAction?.behavior ?? "allow",
      variant: requestAction?.variant,
      primary: requestAction?.variant === "primary" || (requestAction == null && index === 0),
    };
  });
}

export function buildBoardActionResponse(
  action: Pick<BoardAction, "id" | "behavior">,
): AgentPermissionResponse {
  if (action.behavior === "deny") {
    return { behavior: "deny", selectedActionId: action.id, message: "Denied by user" };
  }
  return { behavior: "allow", selectedActionId: action.id };
}
