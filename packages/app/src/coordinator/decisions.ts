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

type BoardActionVariant = "primary" | "secondary" | "danger";

export interface BoardAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant: BoardActionVariant | undefined;
  /**
   * The spec's Correct-it/Edit path: resolving still answers the request, and
   * the composer focuses with the row's question quoted for a free-text
   * correction.
   */
  composerQuote: boolean;
  /** Spec: the first renderable answer renders as the primary action. */
  primary: boolean;
}

function normalizeWireVariant(variant: string | undefined): BoardActionVariant | undefined {
  return variant === "primary" || variant === "secondary" || variant === "danger"
    ? variant
    : undefined;
}

/**
 * Row answers are the permission request's action ids. The live request is the
 * freshest source for behavior and variant, so it wins when present — but the
 * wire row carries the same fields for requests that have not reached (or have
 * already left) the pending map, and a deny must stay a deny: the behavior only
 * defaults to allow when neither side names one.
 */
export function resolveBoardActions(
  row: Pick<CoordinatorDecisionBoardRow, "actions">,
  permission: PendingPermission | null,
): BoardAction[] {
  const requestActions = new Map(
    (permission?.request.actions ?? []).map((action) => [action.id, action]),
  );
  const resolved: BoardAction[] = row.actions.map((action) => {
    const requestAction = requestActions.get(action.id);
    const variant = requestAction?.variant ?? normalizeWireVariant(action.variant);
    return {
      id: action.id,
      label: action.label,
      behavior: requestAction?.behavior ?? action.behavior ?? "allow",
      variant,
      composerQuote: action.composerQuote === true,
      primary: false,
    };
  });
  const hasPrimary = resolved.some((action) => action.variant === "primary");
  for (const [index, action] of resolved.entries()) {
    action.primary = action.variant === "primary" || (!hasPrimary && index === 0);
  }
  return resolved;
}

/**
 * A multi-question request cannot be answered with one tap — the row routes to
 * the asking session's chat, where the full question form renders.
 */
export function isMultiQuestionRow(
  row: Pick<CoordinatorDecisionBoardRow, "questionCount">,
): boolean {
  return (row.questionCount ?? 0) > 1;
}

/**
 * The response a board action produces. Question-kind rows carry no live
 * request the app can rely on, so their answer is built from the row alone:
 * the option label, keyed by the question's header, inside
 * `updatedInput.answers` — the shape question providers consume. A row with
 * more than one question never gets that shape — one tap cannot answer the
 * whole request.
 */
export function buildBoardActionResponse(
  row: Pick<CoordinatorDecisionBoardRow, "requestKind" | "questionHeader" | "questionCount">,
  action: Pick<BoardAction, "id" | "label" | "behavior">,
): AgentPermissionResponse {
  if (action.behavior === "deny") {
    return { behavior: "deny", selectedActionId: action.id, message: "Denied by user" };
  }
  if (row.requestKind === "question" && row.questionHeader && !isMultiQuestionRow(row)) {
    return {
      behavior: "allow",
      updatedInput: { answers: { [row.questionHeader]: action.label } },
    };
  }
  return { behavior: "allow", selectedActionId: action.id };
}

/**
 * The text a composerQuote action quotes — the proposal body when the wire
 * carries one, the row's question otherwise.
 */
export function resolveComposerQuoteSource(
  row: Pick<CoordinatorDecisionBoardRow, "question" | "quoteText">,
): string {
  return row.quoteText ?? row.question;
}

/**
 * The composer prefill for a composerQuote action: the row's question as a
 * blockquote, with a blank line left for the correction.
 */
export function buildComposerQuoteText(question: string): string {
  const quoted = question
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}
