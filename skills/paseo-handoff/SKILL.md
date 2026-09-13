---
name: paseo-handoff
description: Launch a fresh Paseo agent with a task briefing while keeping the original session usable. Use when the user says "handoff", "hand off", "hand this to", or wants to pass work to another agent.
user-invocable: true
---

# Handoff Skill

Launch a fresh agent for the requested task with context, decisions, failed attempts, and constraints. Always keep the original session usable. Never call `handoff_agent`, stop, or archive the source as part of this skill. Session replacement belongs to Paseo’s **Continue with…** UI. The receiving agent starts with **zero context**, so the handoff prompt must be a self-contained briefing.

**User's arguments:** $ARGUMENTS

## Prerequisites

Read the **paseo** skill. Call `list_profiles` before choosing the receiving agent. Do not create it until you have read the configured profiles and their `notes`.

## Parsing arguments

1. **Agent profile** — explicit profile name first; otherwise choose the profile whose `notes` best match the work. Use its provider, model, mode, thinking option, feature values, and `accountSelection`. If no profile fits, use Paseo's provider discovery fallback. Explicit provider, model, and reasoning choices override profile defaults. Preserve the selected `accountSelection`; account resolution follows the **paseo** skill. A local provider remains an explicit target.
2. **Isolation** — pass the current `PASEO_WORKSPACE_ID` explicitly as `workspaceId` by default, so the new runtime shares the current files even when spawn isolation defaults to a worktree. If unavailable, resolve the source agent’s workspace through Paseo. When the user requests isolation, call `create_workspace` first and pass its returned workspace ID. A separate worktree does not carry uncommitted changes; include any relevant differences in the briefing.
3. **Task description** — anything else the user said.

## The handoff prompt

The receiving agent has zero context. Include:

```
## Task
[Imperative description.]

## Context
[Why this task exists, required context.]

## Relevant files
- `path/to/file.ts` — [what it is and why it matters]

## Current state
[What's done, what works, what doesn't.]

## What was tried
- [Approach] — [why it failed or was abandoned]

## Decisions
- [Decision — rationale]

## Acceptance criteria
- [ ] [Criterion]

## Constraints
- [Must-not / must-preserve]
```

**Preserve task semantics.** Investigate-only → "DO NOT edit files." Fix → "implement the fix." Refactor → "refactor, not rewrite." Carry the user's exact intent.

## Launch

Call `create_agent` with:

- `title`: a short description of the delegated task.
- `provider`: the selected `provider/model` value.
- `workspaceId`: the workspace resolved above.
- `initialPrompt`: the self-contained briefing.
- `settings`: map `modeId`, `thinkingOptionId`, `featureValues` → `features`, and `accountSelection` from the selected configuration. Omit absent values.
- `notifyOnFinish: true`: return completion and permission notifications to the original session.

Use `list_provider_accounts` to resolve an explicit account name to its stable ID. Do not copy credentials or change a global CLI login.

The new agent is a Paseo subagent with a fresh runtime. It receives the briefing, not an automatic conversation-history transfer. Report the returned agent ID and tell the user they can open it from the original session’s subagents track. Detach remains a manual user action.

If creation fails or the tool is unavailable, report the failure while preserving the original session. Never fall back to replacement. If a failed or interrupted call may already have created the agent, check for that agent before retrying; `create_agent` does not provide continuation-style retry deduplication.

Do not wait or poll for completion. Leave the original session available for the user and completion notifications; do not duplicate the delegated work.
