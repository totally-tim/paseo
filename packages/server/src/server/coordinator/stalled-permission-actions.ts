import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "../agent/agent-sdk-types.js";

function oneTimeAnswer(action: AgentPermissionAction, behavior: "allow" | "deny"): boolean {
  if (action.behavior !== behavior) return false;
  if (action.response && action.response.behavior !== behavior) return false;
  if (action.response?.behavior === "allow" && action.response.updatedPermissions?.length)
    return false;
  const description = `${action.id} ${action.label} ${action.response?.selectedActionId ?? ""}`;
  if (/always|session|persistent|permanent|remember/i.test(description)) return false;
  const standardId = behavior === "allow" ? /^(?:accept|allow|approve)$/i : /^(?:deny|reject)$/i;
  return (
    /\bonce\b|one[- ]time|this (?:time|command|tool|request)/i.test(description) ||
    standardId.test(action.id)
  );
}

function selectedActions(
  request: AgentPermissionRequest,
): { allow?: AgentPermissionAction; deny?: AgentPermissionAction } | null {
  if (request.kind === "question") return null;
  const actions = request.actions ?? [];
  const options = request.metadata?.options;
  if (options !== undefined) {
    // ACP's option kind owns scope. Labels and option IDs are provider-controlled presentation.
    if (!Array.isArray(options)) return null;
    const once = (kind: string, behavior: "allow" | "deny") => {
      const candidates = options.filter(
        (option) =>
          typeof option === "object" && option !== null && "kind" in option && option.kind === kind,
      );
      if (candidates.length !== 1) return undefined;
      const candidate = candidates[0];
      if (!candidate || typeof candidate !== "object" || !("optionId" in candidate))
        return undefined;
      const action = actions.find(
        (entry) => entry.id === candidate.optionId && entry.behavior === behavior,
      );
      if (!action) return undefined;
      if (action.response && action.response.behavior !== behavior) return undefined;
      if (action.response?.selectedActionId && action.response.selectedActionId !== action.id)
        return undefined;
      if (action.response?.behavior === "allow" && action.response.updatedPermissions?.length)
        return undefined;
      return action;
    };
    const allow = once("allow_once", "allow");
    const deny = once("reject_once", "deny");
    return allow && deny ? { allow, deny } : null;
  }
  if (actions.length === 0) return request.kind === "tool" ? {} : null;
  const allow = actions.filter((action) => oneTimeAnswer(action, "allow"));
  const deny = actions.filter((action) => oneTimeAnswer(action, "deny"));
  return allow.length === 1 && deny.length === 1 ? { allow: allow[0], deny: deny[0] } : null;
}

function actionResponse(
  action: AgentPermissionAction | undefined,
  behavior: "allow" | "deny",
): AgentPermissionResponse {
  if (!action) return { behavior };
  return {
    ...(action.response ?? { behavior: action.behavior }),
    selectedActionId: action.response?.selectedActionId ?? action.id,
  };
}

/** Notification category labels are fixed; provider-specific one-time answers remain intact. */
export function stalledPermissionActions(request: AgentPermissionRequest): AgentPermissionAction[] {
  const selected = selectedActions(request);
  if (!selected) return [];
  const { allow, deny } = selected;
  return [
    { id: "allow", label: "Allow", behavior: "allow", response: actionResponse(allow, "allow") },
    { id: "deny", label: "Deny", behavior: "deny", response: actionResponse(deny, "deny") },
    {
      id: "leave_it",
      label: "Leave it",
      behavior: "deny",
      response: { behavior: "deny", selectedActionId: "leave_it" },
    },
    {
      id: "always_allow_this",
      label: "Always allow this",
      behavior: "deny",
      response: { behavior: "deny", selectedActionId: "always_allow_this" },
    },
  ];
}
