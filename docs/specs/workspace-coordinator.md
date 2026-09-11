# Workspace coordinator

Status: draft spec, 2026-09-11. Nothing here is built. Decisions marked **Settled** were made by
Tim during the brainstorm. There are no open gaps; see [Assumptions](#assumptions) for defaults
taken without a decision.

A workspace coordinator is one persistent, delegate-only agent session per workspace. It never
edits files. It watches the workspace's change requests and CI, spawns subagents for real work,
asks you for decisions on your phone, keeps memory across sessions, and can merge under a
per-project policy. It is the fork's answer to Cursor Projects (announced 2026-09-10), built on
primitives Paseo already has: durable idle agent sessions, `create_agent` with notify-on-finish,
heartbeats that steer an existing session, handoff, the forge service, and push notifications.

## Vocabulary

- **Coordinator** — The one agent session in a workspace carrying the coordinator role. UI:
  "Coordinator". Forbidden: "orchestrator", "project agent", "bot".
- **Wake** — One steer delivered into the coordinator's turn by the daemon, with a reason and a
  payload. Sources: change-request poll, heartbeat, subagent finish, user message.
- **Trust level** — Workspace-scoped notch that bounds what a wake may do: Observe, Propose,
  Ship, Autopilot. **Settled:** all four ship in v1.
- **Merge policy** — Per-project rules that Autopilot must satisfy before merging. Committed in
  the repository. **Settled:** exists in v1.
- **Decision** — A question the coordinator asks you. It is an ordinary permission request
  (`AgentPermissionRequest` of the question kind) with two extensions: a default answer taken
  after a timeout, and lock-screen action buttons.
- **Team memory** — Committed markdown under `.paseo/memory/` in the repository. About the
  codebase and the team's way of working.
- **Personal memory** — Markdown under `$PASEO_HOME/projects/{projectId}/memory.md`. About you.
  Never committed. Keyed by project, not workspace, so it survives worktrees.
- **Board** — The coordinator's home view. Lanes reuse the Kanban plugin's labels: **Needs you**,
  **Working**, **Done**.

## Experience

### Home

**Settled:** the coordinator lives at the workspace home, the view you land on when a workspace
is selected and no tab is focused. Today that slot hosts the draft-agent composer
(`packages/app/src/screens/workspace/workspace-draft-agent-config.ts`). With a coordinator
enabled, the slot shows the board with a composer that sends to the coordinator. The draft-agent
flow moves to the New tab menu, which already exists. With no coordinator, the slot is unchanged
except for one row offering to enable it.

The board is three lanes. Needs you holds open decisions and stuck subagents, oldest first, with a
count in the lane header and on the sidebar workspace row through the existing
`needs_input` bucket. Working holds live subagents, one row each: goal, elapsed time, cost so
far. Done holds the last 24 hours: one row per outcome with the change request or diff link first.
Every wake writes one row to Working or Done stating its reason, the trust level in force, and
what it did: "Woke on CI fail on #41. Level: Propose. Spawned investigator." The raw transcript
opens in a drawer below the board; it is never the primary view, because most of its content is
wake envelopes and subagent summaries.

The board machinery is promoted from `plugin-examples/inbox` into core: board, card, peek modal,
question card, permission card, keyboard navigation. The plugin stays as the cross-host review
surface; the core board reads coordinator state instead of the agent directory. This is the
first inbox code that stops being a plugin example.

### Enabling and the first five minutes

Enabling is a toggle on the workspace, a trust level, and a coordinator agent profile (provider,
model, mode). The provider picker offers only Claude, Codex, and OpenCode, the three that can
enforce delegate-only natively (see [Providers](#providers)).

Unprompted, the coordinator reads the README, CI configuration, `.paseo/`, and the last twenty
change requests, then posts exactly one Needs-you row: "Here's what I think this project is.
Correct me." and writes a first draft of `.paseo/memory/project.md` as an uncommitted diff for
you to review. It spawns nothing and opens nothing on first run regardless of trust level. A bad
first change request from a stranger is the fastest route to the off switch.

### The phone loop

Four shapes. Each is a Decision with one-tap answers, except the digest.

1. **Decision.** "CI failed on #41 (test-e2e). Same test passed on retry twice this week.
   Retrying in 2h if no answer." Answers: Retry, Investigate, Ignore.
2. **Review ready.** "Opened #43: fix timezone bug in scheduler. 2 files, checks green."
   Answers: Open, Merge, Request changes. Merge appears only at Ship or above.
3. **Blocked subagent.** "Investigator on #38 needs a call: rename `Foo` or add an alias?"
   The subagent's own permission request, already forwarded to the parent by notify-on-finish,
   re-asked in plain words. Answers are the subagent's options.
4. **Digest.** One push per day inside your active hours: "Overnight: 2 PRs opened, 1 CI retry,
   0 need you." The Done lane rendered as text.

Never pushed: heartbeat wakes, subagent starts, memory writes, budget accounting, anything with no
action attached. If the answer to "what do I do with this" is nothing, it goes on the board only.
Delivery still obeys `computeNotificationPlan` in
`packages/server/src/server/agent-attention-policy.ts`: a client focused on the coordinator
suppresses the push.

### Trust levels

| Level     | May do                                                                      |
| --------- | --------------------------------------------------------------------------- |
| Observe   | Read, write board rows, ask Decisions. Spawns nothing.                      |
| Propose   | Spawn read-only subagents (investigate, review, summarize). Opens nothing.  |
| Ship      | Spawn writing subagents in worktrees, open change requests, retry CI.       |
| Autopilot | Ship, plus merge change requests that satisfy the merge policy, unattended. |

Each level is a strict superset of the one below. There is no per-trigger matrix. The level is
stored per workspace on the host and printed on every wake row.

### Merge policy

**Settled:** Autopilot exists in v1 and its rules live per project, because some projects, and
some phases of important projects, are better off auto-merging. The policy is committed as
`.paseo/coordinator.yml` so it is reviewed and versioned, and a phase change is a pull request:

```yaml
max_trust_level: autopilot # caps what any host may select for this project
merge:
  enabled: true
  only: coordinator-authored # or: labelled
  label: coordinator/auto-merge
  required_checks: all # or a list of check names
  max_changed_lines: 300
  protected_paths:
    - packages/protocol/**
    - .github/**
  method: squash
```

Autopilot merges only when every rule passes, the forge reports all required checks green, the
branch is up to date with its base, and the daemon's own budget for the wake is not exhausted. It
never pushes to the base branch, never force-pushes, and never overrides forge branch protection.
A merge writes a Done row and counts toward the digest. A policy file that fails to parse
disables Autopilot for the workspace and posts one Needs-you row saying so.

## Daemon design

New code lives in `packages/server/src/server/coordinator/`. Touch points in existing files are
limited to registering the RPCs, the MCP tool, the push payload field, and the role label.

### Identity and residency

The coordinator is an ordinary agent record with the label `paseo.role = coordinator` and the
workspace's ID. The daemon enforces one active coordinator per workspace on creation and on
load. On daemon start the coordinator is loaded through `ensureAgentLoaded` like a heartbeat
target, so it is resident before the first wake. Archiving the workspace archives the coordinator
and cascades to its subagents through the existing rule.

### Wake sources

- **Change-request poll.** A standing subscription on the forge service's PR status poll
  (`retainCurrentPullRequestStatusPoll`, `packages/server/src/services/forge-service.ts`), one
  per enabled workspace, held by the coordinator service rather than a client. Today that poll
  stops when no client is subscribed; the coordinator service becomes a subscriber. The service
  hashes open change requests plus their check states and steers on change with the diff in the
  payload. Hub has no CI-completed event, so local polling is the design, not a fallback.
- **Heartbeat.** The coordinator may schedule itself with `create_heartbeat` as today.
- **Subagent finish.** The existing notify-on-finish steer, unchanged.
- **User.** A message from the board composer.

Every wake envelope carries a fresh `git log -20`, the open change-request snapshot, the trust
level, the remaining budget, and the personal memory file. The transcript is the coordinator's
memory of decisions, never of repository facts.

### Delegate-only

The coordinator receives only a subagent's last message, capped as the finish notification
already caps it, never a raw transcript. It reads finished chains through `read_agent_handoff`.
Its launch config applies the provider-native restriction from the table under
[Providers](#providers), so "never edits files" is enforced by the provider, not by prompt.

### Memory

One MCP tool, `remember`, with `scope: team | personal` and a markdown body. Team writes land in
`.paseo/memory/decisions.md` (coordinator only) or `.paseo/memory/learned.md` (subagents append)
as an uncommitted diff in the workspace. Personal writes land in
`$PASEO_HOME/projects/{projectId}/memory.md`. The tool defaults to personal and rejects a team
entry phrased about a person rather than the codebase. Subagents get the same tool through the
same MCP injection.

Team memory is read from the workspace's own checkout, so a coordinator in a worktree sees the
branch's view of it until the branch merges. That is correct and occasionally surprising; the
board row says which branch a memory entry came from.

### Rotation

When the coordinator's transcript passes a token threshold the daemon runs the existing handoff
(`handoffAgent`, `packages/server/src/server/agent/handoff-context.ts`) with a briefing composed
from both memory layers, the open board rows, and the live subagent list. The coordinator
prunes `learned.md` in the turn before rotation, because a fresh model is about to read all of
it. The board follows the successor the way the task tab already follows a handoff successor.
Rotation is the point where the coordinator can change provider or model for free.

### Budget

Each wake carries a cap on subagent spawns and on spend, taken from the workspace's coordinator
settings, and the workspace carries a monthly cap. The daemon already tracks per-request usage
(fork feature, `docs/fork.md`), so cost per wake on the board row is a display of existing data.
Hitting the monthly cap stops all wakes and sends one push.

## Protocol

New RPCs follow `docs/rpc-namespacing.md`:

- `coordinator.workspace.enable.request` / `.response`
- `coordinator.workspace.update.request` / `.response` — trust level, budget, profile
- `coordinator.workspace.disable.request` / `.response`
- `coordinator.board.subscribe.request` / `.response` plus a `coordinator.board.update` event

Gate the feature once on `server_info.features.workspaceCoordinator`. The push payload gains an
optional `actions` array (label plus the `respond_to_permission` answer it maps to) and the
permission request gains optional `timeoutAt` and `defaultAnswer`. All additive.

## Providers

| Provider | Delegate-only mechanism                              | Coordinator eligible |
| -------- | ---------------------------------------------------- | -------------------- |
| Claude   | `disallowedTools: [Bash, Edit, Write, NotebookEdit]` | yes                  |
| Codex    | `sandbox_mode: read-only`, `approval_policy: never`  | yes                  |
| OpenCode | `permission` map denying edit and bash               | yes                  |
| Copilot  | none                                                 | no                   |
| Pi       | none                                                 | no                   |

MCP tools such as `create_agent`, `create_heartbeat`, `read_agent_handoff`, and `remember` stay
available under every listed restriction. Subagents may use any provider.

## Security

The coordinator is an unattended agent with forge credentials. Containment is the provider
restriction above, the trust level, the merge policy, and the budget, in that order. Under Ship it
opens change requests and never pushes to the base branch. Under Autopilot it merges only its own
or labelled change requests that pass every policy rule. Wake payloads that quote forge content
(review comments, issue bodies) are wrapped as untrusted the way `public-docs/hub/security.md`
prescribes. The `automation.manage` permission covers enabling and configuring a coordinator;
`workspace.write` covers talking to it.

## Fork placement

Core, in new directories: `packages/server/src/server/coordinator/`,
`packages/app/src/coordinator/`, and the promoted board under `packages/app/src/coordinator/board/`.
Add a row to the ledger in `docs/fork.md`. Expected sync conflicts: the workspace route state
views, the tracks row, the permission request schema, and the push payload builder.

## Milestones

1. Coordinator identity, residency, singleton, delegate-only launch, board home with the
   composer, wake rows. No triggers beyond user messages and subagent finish.
2. Change-request poll as a standing subscription, wake envelopes, trust levels Observe through
   Ship, budgets.
3. Decisions with timeout defaults and push actions, daily digest.
4. Memory tool and both layers, rotation through handoff.
5. Merge policy and Autopilot.

## Settled on 2026-09-11

- **Trust level lives host-local per workspace.** A teammate cloning the repository starts at
  Observe. `coordinator.yml` may set `max_trust_level` to cap what any host can select.
- **Autopilot merges coordinator-authored change requests only.** `merge.only` accepts
  `coordinator-authored` in v1; `labelled` is reserved for later.
- **Budgets are spawns per wake and tokens per month.** Dollars appear on board rows only where
  the daemon already knows a price for the model.
- **Personal memory is editable in the app in v1.** A panel one tap from the board reads and
  writes `$PASEO_HOME/projects/{projectId}/memory.md`.

## Assumptions

Defaults taken without a decision. Change them in the settings screen, not here.

- A Decision takes its default answer after 2 hours.
- The digest sends at 08:00 local time.
- No pushes between 22:00 and 07:00 local time; a Decision raised then waits for 07:00 and its
  timeout clock starts at delivery.
- The rotation threshold is 60% of the provider's context window.
