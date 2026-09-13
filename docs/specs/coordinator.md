# Coordinator

Status: draft spec, revised 2026-09-11. Nothing here is built. Every decision under
[Settled](#settled) was made by Tim during the brainstorm and is not open in review; the defaults
under [Assumptions](#assumptions) are.

The coordinator is two tiers of persistent, delegate-only agent sessions. One **global
coordinator** per daemon is the human's counterpart: it owns the global board, goals, policies,
the digest, and the conversation you have. One **project coordinator** per project per daemon
does the work: it watches that repository's change requests and CI, runs the project's compiled
goals, spawns investigators, implementers, and reviewers, and reports upward in summaries. The
split keeps every agent's context small: the global tier sees decision rows and summaries, a
project tier sees one repository.

It is the fork's answer to Cursor Projects (announced 2026-09-10), built on primitives Paseo
already has: durable idle agent sessions, `create_agent` with notify-on-finish, heartbeats that
steer an existing session, handoff, schedules, the forge service, plugin lifecycle hooks, and
push notifications.

## Definitions

From `docs/glossary.md`, restated because ownership hangs on them.

- **Daemon** (UI: host). One Paseo server process on one machine. Agents run only inside a
  daemon. Nothing daemon-side spans two daemons except the CLI's remote-host route.
- **Project.** One selected root path on one daemon, with an opaque host-local ID and a
  cross-host key derived from the git remote. Clients may recognize the same repository on two
  machines as one logical project; daemons never do.
- **Workspace.** One directory on one daemon with git state, belonging to exactly one project.
  The local checkout is a workspace and every worktree cut from it is another workspace of the
  same project. Agent sessions live in workspaces.

So a project coordinator is per repository per machine, watches every workspace of that
repository, and its own session lives in the workspace at the project root. A global
coordinator is per machine.

## Vocabulary

- **Global coordinator** — The one agent session per daemon carrying the global role. UI:
  "Coordinator" (the sidebar item). Forbidden: "orchestrator", "bot", "assistant".
- **Project coordinator** — The one agent session per project carrying the project role. UI:
  the project's name in a board header; "project coordinator" in prose.
- **Board** — A coordinator's home view. Lanes reuse the Kanban plugin's labels: **Needs you**,
  **Working**, **Done**. The global board adds **Goals** and **Policy** tabs.
- **Wake** — One steer delivered into a coordinator's turn by the daemon, with a reason and a
  payload. Sources: change-request poll, goal fire, heartbeat, subagent finish, agent
  lifecycle hook, user message.
- **Decision** — A question a coordinator asks you. An ordinary permission request of the
  question kind with two extensions: a default answer after a timeout, and lock-screen actions.
- **Proposal** — A decision whose answers are Approve, Edit, Ignore, raised by a coordinator on
  its own initiative with cited evidence. Board only, never pushed.
- **Goal** — A sentence you or a coordinator wrote, that you approved, compiled into a rule: a
  trigger, a filter, a step with an agent profile and prompt, and a runaway guard. Personal in
  v1: rules live under your Paseo home and run only on your daemon.
- **Rule** — The compiled form of a goal. Shaped like a Hub workflow file
  (`public-docs/hub/workflows.md`). Executed by the daemon without waking a coordinator when
  the trigger is deterministic; otherwise a heartbeat check the project coordinator runs with
  judgment. The Goals pane says which kind each goal is.
- **Trust level** — Per-project notch bounding what a wake may do: Observe, Propose, Ship,
  Autopilot. Host-local, with a global default and a committed per-project cap.
- **Scope** — Per-project setting for what the project coordinator watches: Everything (the
  repository and every agent session in the project's workspaces, the default) or Project only.
- **Policy** — Your personal permission allowlist at daemon level with per-project overrides:
  tool patterns a coordinator may approve on your behalf at Ship and above. Grown
  interactively, never hand-edited as YAML.
- **Merge policy** — Committed per-project rules in `.paseo/coordinator.yml` that Autopilot must
  satisfy before merging.
- **Usage expectation** — A soft monthly number for spawns and tokens per project. Crossing it
  writes one board row. Nothing pauses.
- **Runaway guard** — Hard caps that exist to catch bugs, not spend: concurrent subagents per
  coordinator and a nesting depth of two.
- **Team memory** — Committed markdown under `.paseo/memory/` in a repository: `project.md`, written
  by the project coordinator only, and `learned.md`, appended by subagents.
- **Personal memory** — Markdown under the Paseo home: `coordinator/memory.md` about you, and
  `projects/{projectId}/memory.md` about you in one project. Never committed.

## Experience

### Global board

The global board is a top-level sidebar item, "Coordinator", beside Schedules and History,
because it belongs to the daemon and not to any project. Needs you is a flat list across
projects, oldest first, each row labeled with its project. Working and Done group under project
headers. A project filter narrows everything. Goals and Policy are tabs on the same screen. The
composer at the bottom sends to the global coordinator.

### Project board

**Settled:** a project board lives at the workspace home, the view you land on when a workspace
of that project is selected and no tab is focused. Today that slot hosts the draft-agent
composer (`packages/app/src/composer/draft/workspace-tab.tsx`). With a project coordinator
enabled, every workspace of the project shows the same board, filtered to that project, with a
composer that sends to the project coordinator. The draft-agent flow moves to the New tab menu.
With no project coordinator, the slot is unchanged except for one chevron row in the settings-row
pattern, "Set up a coordinator".

### Chat

**Settled:** a coordinator's transcript is its ordinary agent tab. A ghost "Chat" button at the
top right of a board opens it and closing the tab returns to the board. On compact the header
menu gets "Open coordinator chat". There is no drawer and no in-pane toggle.

### Board layout and rows

**Settled:** on desktop, Needs you is a strip across the top, Working and Done are two columns
beneath, and the composer stays docked at the bottom with the tracks row above it. The strip
has a fixed row height and no empty placeholder, so a quiet board collapses to two columns and
nothing shifts when a decision arrives. Done is capped at five rows per project with a "24h"
link to the chat. On compact it is one vertical scroll with sticky section headers, Needs you
first, decisions answered inline, Working rows collapsed to one line, and Done collapsed behind
"Done (n)" the way the Kanban plugin collapses lanes.

```
NEEDS YOU
● paseo · Retry CI on #41?                       [Retry] [Investigate] [Ignore]
  test-e2e failed · same test passed on retry twice · default Retry in 1h 40m
● paseo · Proposed goal: rebase PRs idle 3 days      [Approve] [Edit] [Ignore]
  4 of the last 6 PRs went stale · cites #38 #39 #40 #42

WORKING                                DONE · 24h
paseo                                  paseo
⟳ Woke: CI failed on #41 · Propose     ○ Opened #43: fix timezone bug
○ Investigate test-e2e on #41            2h ago · #43
  4m · claude/opus                     ○ Goal: keep dependencies current, opened #51
○ Yours: fix-auth                        6h ago · #51
  2h 10m · waiting on permission 40m

Retried CI on #41 and it is green. Nothing else needs you.
[● Propose] [Everything]
┌ Ask the coordinator…                                                 ↑ ┐
```

Everything on the board is a row, not a card. Section labels use the structural-label tier.
Row titles are normal weight at base size, second lines are muted and small. Dots come from
`getStatusDotColor`: `needs_input` for decisions, the running ring for live subagents, `done`
for outcomes. No bespoke badges, no trust chips on rows, no "all caught up" illustration.

- **Decision row.** The question in the imperative, then who is asking, how long it has waited,
  and the default with a countdown. Buttons right-aligned, secondary tier, first option primary,
  rendered with the transcript's permission action button and question form primitives.
  Tapping the text opens the peek modal promoted from the Kanban plugin.
- **Proposal row.** A decision row whose answers are Approve, Edit, Ignore. The second line is
  the evidence. Edit is an ordinary option that resolves the request and focuses the composer
  with the proposal quoted; the coordinator reposts a new proposal for a fresh Approve.
- **Working row.** Goal on the first line, elapsed time and provider on the second. Your own
  agent sessions appear here under Everything scope, marked "Yours", with the goal line taken
  from your first message. Tap opens the session's tab. Cost is not on the row.
- **Done row.** Verb-first outcome, then time and the link. Change request rows open the PR,
  goal rows name the goal, memory rows open the file diff.
- **Wake line.** One muted system line at the top of each project's Working with no dot:
  "Woke: CI failed on #41 · Propose · spawned investigator". Only the last wake shows.
- **Reply area.** **Settled:** one short area above the composer showing the coordinator's
  latest reply only. A question like "what's the status of #41?" is answered there and creates
  no row. A work request is acknowledged there and creates a Working row. The full exchange is
  in Chat.

### Trust pill, scope, sidebar, and memory pane

The trust level is a `ComposerTrackPill` reading the current notch with its dot. It opens the
standard popover on desktop and a sheet on compact: a four-notch `<SegmentedControl>`, one muted
line under the selected notch stating what it may do unprompted, this month's spawns and tokens
against the usage expectation as a meter in the context meter's style, and a ghost row opening
the personal memory pane. Stepping down applies instantly. Stepping to Autopilot highlights the
notch and reveals a secondary button "Allow autopilot in this project", so it takes a second tap
and never a modal. On the global board the pill sets the global default and lists projects that
override it.

Scope is a second pill, "Everything" or "Project only". Switching to Project only removes your own
sessions from Working and stops proposals about them.

The sidebar workspace row reuses the status bucket dot and adds no glyph. When decisions are
open for the project, the meta row gains one dot-separated item, "2 need you". The Coordinator
sidebar item carries the host-wide count the Kanban plugin's sidebar badge carries today.

Personal memory opens as a side pane: an editable text area over the file with a muted line
naming the path. From the global board it edits the daemon-level file; from a project board,
that project's file.

### Enabling and the first five minutes

The global coordinator is enabled once per daemon from the Coordinator sidebar item: an
`<AdaptiveModalSheet>` with the coordinator agent profile picker (Claude, Codex, or OpenCode
only, see [Providers](#providers)) and an Enable button. Its first act is to list the daemon's
projects and propose a project coordinator for each, one proposal row per project.

A project coordinator is enabled from that proposal or from the "Set up a coordinator" row: the
same sheet asks for an investigator profile and an implementer profile, or the coordinator falls
back to `inspect_provider` and says so, as the `paseo` skill requires. Trust defaults to Observe
and scope to Everything.

Unprompted, the project coordinator reads the README, CI configuration, `.paseo/`, and the last
twenty change requests, then posts exactly one decision row: "Here's what I think this project
is" with the answers "Looks right" and "Correct it", where the second focuses the composer with
the draft quoted in. It writes a first draft of `.paseo/memory/project.md` as an uncommitted
diff. It spawns nothing and opens nothing on first run regardless of trust level. If the
repository has no CI, the sheet says the CI watch has nothing to poll and offers a goal to add
one.

When a project is added to Paseo later, the global coordinator notices through the lifecycle
hook and proposes a project coordinator for it.

### The phone loop

Five shapes. Each is a decision with one-tap answers, except the digest. Answers go straight to
the raising session's permission request, never through the global coordinator.

1. **Decision.** "CI failed on #41 (test-e2e). Same test passed on retry twice this week.
   Retrying in 1h 40m if no answer." Answers: Retry, Investigate, Ignore.
2. **Review ready.** "Opened #43: fix timezone bug in scheduler. 2 files, checks green."
   Answers: Open, Merge, Request changes. Merge appears only at Ship or above.
3. **Blocked subagent.** The subagent's own permission request, surfaced by the daemon directly
   on the board and the phone. A coordinator relays it in plain words only when it cannot answer
   within its trust level and policy.
4. **Your stalled session.** Under Everything scope: "Your agent on fix-auth has waited on a
   Bash permission for 40m: `npm test`." Answers: Allow, Deny, Leave it, Always allow this.
   Your tap answers at any trust level; only the coordinator answering on its own is gated to
   Ship and above. "Always allow this" writes policy at any level.
5. **Digest.** One push per day inside your active hours, on by default, from the global
   coordinator, written as a product manager's note: change requests opened and merged, stale
   ones, goals fired, proposals waiting.

Never pushed: proposals, heartbeat wakes, subagent starts, memory writes, usage rows, anything
with no action attached. Delivery obeys `computeNotificationPlan` in
`packages/server/src/server/agent-attention-policy.ts`.

### Trust levels

| Level     | May do                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------- |
| Observe   | Read, write board rows, ask decisions and proposals. Spawns nothing.                                      |
| Propose   | Spawn read-only subagents (investigate, review, summarize). Opens nothing.                                |
| Ship      | Spawn writing subagents in worktrees, open change requests, retry CI, act on your sessions within policy. |
| Autopilot | Ship, plus merge change requests that satisfy the merge policy, unattended.                               |

Each level is a strict superset of the one below. There is no per-trigger matrix. The level is
per project, stored on the host, with a global default, and printed on every wake row.

**Settled:** every implementer output gets an independent reviewer subagent before a change
request opens, at every level that opens one. At Ship the coordinator posts the review as a
change request comment and, for a change request your own session authored, sends the fix
request to your session. At Propose it asks you first.

### Goals and proposals

**Settled:** goals come from two sources, both approved by you. You state one in a composer:
"keep dependencies current". A coordinator proposes one from evidence: "4 of the last 6 PRs
went stale for more than five days; when a PR is idle 3 days, rebase it, rerun CI, and post a
one-line summary." Either way one proposal row appears with the trigger, action, and guard in a
sentence, and nothing runs until Approve. The compiled rule is one tap away in the Goals pane.

A goal stated on the global board fans out as one rule per project, approved once. A goal
stated on a project board is that project's alone. Every goal shows its plain line, its rule,
its kind (deterministic or judgment), last run, a fired count, and a pause toggle. A goal that
fires three times without producing anything gets a proposal to pause it.

**Settled:** a coordinator may propose whenever it notices something. Proposals are board rows
and never push. An ignored proposal is not re-raised for thirty days.

### Policy

**Settled:** the permission allowlist is grown interactively, never written by hand. Every
permission a coordinator relays to you carries a fourth answer, "Always allow this", which
appends a rule to your personal policy. The Policy tab shows rules as a list of tool patterns
with a toggle and a fired count each. Coordinators propose expansions from evidence: "You've
approved `npm test` five times this month, allow it automatically?" Rules are personal at
daemon level with per-project overrides. Committed team rules come later with team goals.

### Merge policy

**Settled:** Autopilot exists in v1 and its rules live per project as `.paseo/coordinator.yml`,
committed so they are reviewed and versioned, and a phase change is a pull request.

```yaml
max_trust_level: autopilot # caps what any host may select for this project
merge:
  enabled: true
  only: coordinator-authored # v1 accepts only this value
  required_checks: all # or a list of check names
  max_changed_lines: 300
  protected_paths:
    - packages/protocol/**
    - .github/**
  method: squash
```

Autopilot merges only when every rule passes, the forge reports all required checks green, the
branch is up to date with its base, and the reviewer subagent passed. It never pushes to the
base branch, never force-pushes, and never overrides forge branch protection. A merge writes a
Done row, archives the worktree workspace, and counts toward the digest. A policy file that
fails to parse disables Autopilot for the project and posts one Needs-you row saying so.

### Usage and guards

**Settled:** there is no budget. Each project has a soft usage expectation for spawns and
tokens per month, shown in the trust pill. Crossing it writes one board row and changes nothing
else. Separately, the runaway guard is hard: at most 8 concurrent subagents per coordinator and
no spawning below depth two, both editable, enforced in `create_agent` for every agent whose
parent chain reaches a coordinator. When the guard trips, in-flight subagents finish and the
coordinator gets a wake saying why nothing new started.

## Daemon design

New code lives in `packages/server/src/server/coordinator/`. Existing files this branch edits,
all named so a sync knows where to look: `paseo-tools.ts` (new tools), `agent-manager.ts`
(required-tools gate, guard in `create_agent`, in-process events at the lifecycle emit sites),
`agent-prompt.ts` (successor resolution), `handoff-context.ts` (reparenting), `schedule/service.ts`
(goal target, retargeting), `agent-continuation/safety.ts` (coordinator routing),
`workspace-registry*.ts` and `messages.ts` (hidden flag, additive fields), `track-presentation.ts`
(pending count), the push payload builder, the sidebar items model, and the workspace route
state views.

### Identity and residency

Both tiers are ordinary agent records with a role label: `paseo.role = coordinator.global` or
`coordinator.project`, plus the project ID on the project role. The daemon enforces one active
session per role scope on creation and on load. Project coordinators carry the global
coordinator as parent, so the existing finish-notification path carries their turn summaries
upward.

**Settled:** the global coordinator's session lives in a daemon-owned directory workspace under
the Paseo home, kind `directory`, excluded from the sidebar and from project counts. The
Coordinator sidebar item is its only surface. A project coordinator's session lives in the
workspace at the project's root path, reused if present and created if not.

On daemon start both tiers load through `ensureAgentLoaded`, so they are resident before the
first wake. Archiving a project archives its coordinator and cascades to its subagents through
the existing rule. Disabling pauses goals, keeps memory on disk, and re-enabling restores the
transcript lineage.

### Board model

The daemon derives rows; coordinators never post them. Needs you rows are pending permission
requests on any session the board covers. Working rows are live subagents plus, under
Everything scope, your own sessions. Done rows are written by the coordinator service on subagent
finish, change-request events, goal runs, `remember` writes, guard trips, and answered decisions.
The wake line is written at wake time with reason and level, and its "what it did" clause is
filled from spawns observed during that turn. Rows persist per project under
`$PASEO_HOME/coordinator/board/{projectId}.json`, Done retained seven days, and the global board
is the union. The reply area is the coordinator's last assistant message; the app needs a hook
for that, mirroring the Kanban plugin's `lastAssistantLine` over the app's own timeline store,
since no such client selector exists today.

The singleton rule on load: if two active sessions carry one role scope, the one with the
latest turn stays and the others are archived with a board row saying so.

### Decision timers

`timeoutAt` and `defaultAnswer` live on the permission request record. The coordinator service
checks pending requests on the schedule service's tick, answers expired ones with the default
through `respond_to_permission`, and writes a Done row "(default after 2h)". Pending requests are
re-read on daemon start, so timers survive a restart. The quiet-hours rule shifts `timeoutAt`
to delivery plus the timeout.

### Wake sources

- **Change-request poll.** The existing PR status poll covers only the current branch's change
  request and stops when no client is subscribed; a service can retain it through
  `workspaceGitService.registerWorkspace`. The coordinator needs every open change request, so
  the service runs its own loop per project over `listPullRequests` plus `getCheckDetails`
  (`packages/server/src/services/forge-service.ts`) at the same cadence. It hashes open change requests plus check states
  and steers on change with the diff in the payload. Hub has no CI-completed event, so local
  polling is the design. After a daemon outage the first wake carries the whole diff once.
- **Goal fire.** The schedule service runs deterministic rules with a new target type and only
  the finish notification reaches the coordinator. Judgment goals are heartbeats on the project
  coordinator. Missed crons fire once each on restart.
- **Lifecycle events.** Plugin lifecycle hooks are dispatched only to plugin subprocesses over
  IPC (`plugins/runtime.ts` `emit`); there is no in-process bus. This branch adds one, emitted
  beside `pluginLifecycle.emit` at the same call sites in `agent-manager.ts`, and the
  coordinator service subscribes to it. Under Everything scope it observes `agent.created`, `agent.turn_ended`, `agent.permission_requested`, and
  `agent.permission_resolved` for sessions in the project's workspaces, and wakes the project
  coordinator on a stall: a permission pending longer than a threshold, or a session idle after
  an error. Project additions wake the global coordinator.
- **Subagent finish.** The existing notify-on-finish steer.
- **User.** A message from either board's composer.

Every wake envelope carries a fresh `git log -20`, the open change-request snapshot, the trust
level and scope, usage against expectation, and the personal memory files. The transcript is a
coordinator's memory of decisions, never of repository facts.

### Delegation

**Settled:** the global coordinator hands work down with `send_agent_prompt` to the project
coordinator, notify on finish, so the summary flows back on the existing path. It never spawns
workers itself. A project coordinator receives only a subagent's last message, capped as the
finish notification already caps it, never a raw transcript, and reads finished chains through
`read_agent_handoff`. Its launch config applies the provider-native restriction from
[Providers](#providers), so "never edits files" is enforced by the provider, not by prompt.

### Goals engine

A rule file lives under `$PASEO_HOME/coordinator/goals/{projectId}/{goalId}.yml`:

```yaml
name: rebase-stale-prs
on: pr.idle
filters:
  days: 3
  authors: any
step:
  profile: implementer
  prompt: |
    Rebase this change request onto its base, rerun CI, and post a one-line summary.
    <change-request>${{ paseo.change_request }}</change-request>
guard:
  max_concurrent: 1
```

Triggers in v1: `cron`, `pr.opened`, `pr.ci_failed`, `pr.idle`, `pr.merged`, `agent.stalled`.
A goal whose sentence compiles to none of these becomes a `heartbeat` kind whose prompt is the
sentence. Compilation is the coordinator's job; validation and execution are the daemon's.

The schedule service is cron-only and knows no events. Every goal is a schedule with a new
`goal` target type so runs appear in the schedule surface with logs. A `cron` goal is a normal
schedule. An event goal is a paused schedule that the coordinator service runs once through the
existing run-once path when its own poll or the lifecycle bus matches the trigger and filter.

### Policy engine

Rules are `{ pattern, scope: daemon | projectId, enabled, firedCount }` under
`$PASEO_HOME/coordinator/policy.json`. The coordinator service answers a matching permission
request on a coordinator's subagent or, under Everything scope at Ship and above, on your own
session, and writes a Done row naming the rule. Every other permission is yours.

### Memory

One MCP tool, `remember`, with `scope: team | personal | personal-project` and a markdown body.
Team writes land in `.paseo/memory/project.md` (coordinator only: the project summary and its
decisions) or `.paseo/memory/learned.md` (subagents append) as an uncommitted diff in the workspace. Personal writes land under the
Paseo home. The tool defaults to personal and rejects a team entry phrased about a person rather
than the codebase. Team memory is read from the workspace's own checkout, so a coordinator in
a worktree sees the branch's view of it until the branch merges.

### Rotation

When a coordinator's transcript passes a token threshold the daemon runs the existing handoff
(`handoffAgent`, `packages/server/src/server/agent/handoff-context.ts`) with a briefing composed
from its memory layers, its open board rows, and its live subagent list. It prunes `learned.md`
in the turn before rotation. The board follows the successor. Rotation reparents live
subagents, retargets agent-targeted schedules, and forwards notifications that land during the
switch, see [Orchestration layer](#orchestration-layer). A capacity rejection on a coordinator
rotates through this path, never through automatic account continuation alone, so a fallback
profile can be named per coordinator.

## Orchestration layer

Both tiers are orchestrating agents in the sense of `public-docs/orchestration.md` and the
`paseo` skill, so they inherit that contract: delegate through `create_agent`, choose settings
through `list_profiles` notes, leave `notifyOnFinish` on, never poll `list_agents` to check on a
subagent, use `send_agent_prompt` for follow-ups, and put writing subagents in worktrees through
`create_workspace`. Four of those mechanics hold today and six break for long-lived parents that
rotate. Each break is a daemon change in this branch.

What holds, verified 2026-09-11:

- A steer into an idle agent starts a new turn, and concurrent steers are serialized per agent
  in arrival order (`agent-manager.ts` `steerOrReplaceActiveTurn`, `runForegroundMutation`).
- Subagents of an agent-scoped `create_agent` are unattended for account selection and must use
  their parent's account for the same provider (`agent-manager.ts` `resolveCreationAccount`).
  The global coordinator launches with `unattended: true` explicitly, since it has no parent.
- Automatic account continuation never fires for subagents or schedule-driven agents
  (`agent-continuation/safety.ts` `isOrdinaryAgent`).
- Cross-workspace subagents stay subagents but appear as tabs in their own workspace, and
  archiving the parent detaches them rather than archiving them.

What breaks, with the fix and milestone:

1. **Tool injection is a daemon-wide toggle.** `daemon.mcp.injectIntoAgents` defaults off and
   `prepareSessionConfig` has no per-agent override. Fix: a `paseoTools: "required"` launch
   option the daemon sets for coordinators and propagates to their subagents, honored ahead of
   the host toggle, not exposed on the `create_agent` tool. Milestone 1.
2. **Handoff orphans subagents.** `handoffAgent` never rewrites `paseo.parent-agent-id`, and a
   finish notification to the closed source throws in `assertAgentCanAcceptPrompt` and is
   swallowed by `notifySafely`. Fix: rotation reparents live subagents to the successor, the
   finish path resolves the parent through the handoff successor label, and notifications that
   land while the successor is starting go into the fork's durable instruction queue. Successor
   resolution in milestone 1, the rest in milestone 6. With two tiers this fix runs at both
   levels: a rotated project coordinator keeps the global coordinator as parent.
3. **Heartbeats keep firing at a closed agent.** `completeForAgent` runs only on archive and
   `sweepOrphanedSchedules` only at startup. Fix: handoff retargets agent-targeted schedules to
   the successor. Milestone 6.
4. **A subagent's pending permission is invisible.** `track-presentation.ts` builds subagent
   rows with `requiresAttention: false` and no `pendingPermissionCount`. Fix: the board reads
   child `pendingPermissions` directly into Needs you, and the subagents track passes the count.
   Milestone 1.
5. **No fan-out or depth limit anywhere.** Fix: the runaway guard in `create_agent` for every
   agent whose parent chain reaches a coordinator. Milestone 2.
6. **Automatic account continuation can rotate a coordinator on its own.** Fix: continuation on
   a coordinator role routes through coordinator rotation. Milestone 6.

Subagents that shell out to `paseo run` inherit `PASEO_AGENT_SPAWN_ISOLATION=worktree` from the
coordinator's environment at Ship and above.

## Protocol

New RPCs follow `docs/rpc-namespacing.md`:

- `coordinator.global.enable.request` / `.response`, `.disable`, `.update`
- `coordinator.project.enable.request` / `.response`, `.disable`, `.update` — trust, scope,
  profiles, usage expectation
- `coordinator.board.subscribe.request` / `.response` plus a `coordinator.board.changed` server
  message, named after the existing `agent.continuation.changed`, filterable by project
- `coordinator.goal.list`, `.approve`, `.pause`, `.delete` request and response pairs
- `coordinator.policy.list`, `.update` request and response pairs

Gate the feature once on `server_info.features.coordinator`. The push payload gains an optional
`actions` array (label plus the `respond_to_permission` answer it maps to) and the permission
request gains optional `timeoutAt` and `defaultAnswer`. All additive.

## Providers

| Provider | Delegate-only mechanism                              | Coordinator eligible |
| -------- | ---------------------------------------------------- | -------------------- |
| Claude   | `disallowedTools: [Bash, Edit, Write, NotebookEdit]` | yes                  |
| Codex    | `sandbox_mode: read-only`, `approval_policy: never`  | yes                  |
| OpenCode | `permission` map denying edit and bash               | yes                  |
| Copilot  | none                                                 | no                   |
| Pi       | none                                                 | no                   |

MCP tools such as `create_agent`, `send_agent_prompt`, `create_heartbeat`, `read_agent_handoff`,
and `remember` stay available under every listed restriction. Subagents may use any provider.

## Security

A coordinator is an unattended agent with forge credentials. Containment is the provider
restriction above, the trust level, the policy, the merge policy, and the runaway guard, in that
order. Under Ship it opens change requests and never pushes to the base branch. Under Autopilot
it merges only its own change requests that pass every rule and a reviewer. Wake payloads that
quote forge content are wrapped as untrusted the way `public-docs/hub/security.md` prescribes.
The `automation.manage` permission covers enabling and configuring coordinators, goals, and
policy; `workspace.write` covers talking to one.

## Fork placement

Core, in new directories: `packages/server/src/server/coordinator/`,
`packages/app/src/coordinator/`, and the promoted board under `packages/app/src/coordinator/board/`.
Add a row to the ledger in `docs/fork.md` in the final milestone. Expected sync conflicts: the
workspace route state views, the tracks row, the sidebar items model, the permission request
schema, the push payload builder, and the launch-context tool gate.

## Milestones

Each milestone names its stories, its tests, and its evidence. A milestone is done when every
listed test passes, the runtime evidence is appended to the PR body, and the review protocol in
[Handoff](#handoff) has passed including re-review of fixes.

1. **Project coordinator core.** Stories 1, 2, 3, 5, 35. Role label, residency, singleton,
   required-tools launch option, delegate-only launch, protocol scaffolding
   (`features.coordinator`, `coordinator.project.*`, `coordinator.board.*`), the board model, the
   project board at the workspace home with composer and reply area, Chat tab, child permissions
   on the board, successor resolution in the finish path, and a first `remember` limited to team
   `project.md` so first contact completes. Trust is Observe only: nothing spawns. Tests: ad-hoc
   daemon test for singleton and residency across restart; delegate-only test per eligible
   provider with the fake agent client asking for a file edit and being refused; finish
   notification through a manual handoff reaching the successor; a Playwright spec that the
   board replaces the draft pane and the reply area shows the last message. Evidence: web via
   the Paseo browser tools, desktop via `computer-use`.
2. **Wakes and levels.** Stories 4, 8, 10, 12, 13, 14, 29, 30, 32, 34, 37. The all-PR poll with
   hashing and outage replay, wake envelopes, trust levels through Ship with the reviewer step,
   the in-process lifecycle bus, scope, usage expectation, runaway guard. Tests: poll diff and
   replay against `workspace-git-service-stub.ts`; guard trip in the ad-hoc harness; reviewer
   spawned before a change request opens; scope switch removes own sessions.
3. **Global tier.** Stories 23, 25, 26, 28, 33. Hidden workspace and project flag, Coordinator
   sidebar item, global board, delegation and summaries, reparenting of existing project
   coordinators under the global one on enable. Tests: hidden records absent from the sidebar
   projection; delegation round trip in the ad-hoc harness. Evidence: global board on web and
   desktop.
4. **Decisions and digest.** Stories 6, 7, 11. Timers, additive push fields, notification
   categories with actions that answer without foregrounding, the digest. Tests: timer expiry in
   the ad-hoc harness across a restart; push payload snapshot. Evidence: lock-screen actions
   cannot be driven by an agent; record them in the QA table as manually verified by Tim on iOS
   and Android or as untested, never as passed by inference.
5. **Memory and rotation.** Stories 15, 16, 31, 36. Full `remember`, three layers, memory pane,
   rotation with reparenting, schedule retargeting, notification forwarding through the
   instruction queue, continuation routing. Tests: rotation in the ad-hoc harness asserting
   reparented children, a retargeted heartbeat, and a forwarded notification; a memory pane edit
   reflected in the next wake envelope.
6. **Goals, proposals, policy.** Stories 17 to 22, 24, 27. Goal compilation and the `goal`
   schedule target, event goals through run-once, Goals and Policy tabs, "Always allow this",
   proposals. Depends on 5 so a rotation cannot orphan goals. Tests: rule validation; a cron goal
   fires once after a missed window; an event goal fires from a stubbed poll; policy answers a
   matching permission and writes the row.
7. **Merge policy and Autopilot.** Story 9. Policy file parsing, Autopilot merge against
   `temp-github-repo.ts`. Tests: every rule rejecting; parse failure disables Autopilot with a
   row. Evidence: a real merge on a throwaway repository.

## Handoff

This section exists because the implementing session will not have this brainstorm's context.

**Non-goals for this branch.** Hub triggers, team goals and committed permission policy, Copilot
and Pi as coordinator providers, budgets or spend limits, label opt-in for human-authored change
requests, a global agent that spans daemons.

**Settled means settled.** Do not re-ask anything under [Settled](#settled). If one proves
infeasible, stop that piece, quote the settled line inside an `AskUserQuestion` with the concrete
obstacle and two options, and continue every piece that does not depend on it. Never downgrade a
settled decision silently. Assumptions may be changed with a note in the commit.

**Review protocol.** Load the `multi-agent-review` skill before the first review and
`proven-working-code` before claiming any milestone done. The non-Claude blocking gate is Codex,
and Codex is unavailable until 2026-09-15; the approved fallback is OpenCode as recorded in the
`opencode-fallback-reviewer` memory. Every fix round is re-reviewed. A same-lineage "looks good"
is not confidence.

**Evidence.** Append to the PR body's Evidence section per milestone: the commands run, the raw
outcome, what was observed on the real UI, and what was not covered. A diff summary is not
evidence. Web is driven with the Paseo browser tools and desktop with `computer-use`; read
`docs/qa.md` for the platform table and fill it per milestone.

**Docs obligations.** Read `docs/expo-router.md` before touching the workspace home. Add a
glossary row for every term in [Vocabulary](#vocabulary). Add the `docs/fork.md` ledger row and a
docs-table row in `CLAUDE.md` in the final milestone. Tag the three additive schema fields with
`// COMPAT(coordinator): added in <version>, remove after <date>` per
`docs/protocol-compatibility.md`.

**Code facts that will cost a detour otherwise.**

- "Kanban plugin" is `plugin-examples/inbox`. Its views are plain React Native and move; its data
  layer (`usePaseo`, `@tanstack/react-query`, `paseo.agents.ref(...).timeline`) is the plugin
  sandbox API and must be rewritten onto the app's session store hooks.
- `injectIntoAgents` defaults to `false` in `config.ts` and `true` in `bootstrap.ts`. The
  required-tools option makes the default irrelevant for coordinators; do not fix the mismatch
  here.
- `AgentSessionConfig.internal` in `agent-sdk-types.ts` is the precedent for threading a
  per-agent launch flag; follow it for `paseoTools: "required"`.
- Workspaces have no hidden flag and `createWorkspaceForDirectory` also creates a project, so
  the hidden flag goes on both records and both payload schemas.
- `AgentPermissionRequest` already carries `actions` with custom labels; `timeoutAt` and
  `defaultAnswer` are new.
- `expo-notifications` is installed but no category is registered anywhere; lock-screen actions
  are new end to end.
- The sidebar item pattern is four files: `sidebar-nav/model.ts`, `sidebar-nav-rows.tsx`,
  `app/_layout.tsx`, and the appearance settings section. Copy "schedules".
- Test templates: `packages/server/src/server/test-utils/` (`daemon-client`,
  `daemon-test-context`, `paseo-daemon`, `workspace-git-service-stub`, `temp-github-repo`) and
  `docs/ad-hoc-daemon-testing.md`; app tests follow sibling `*.test.tsx` files; Maestro flows
  live in `packages/app/maestro/`.
- Run only the test files you changed, never a whole workspace, per `CLAUDE.md`.

## User stories

Each story ends in what you see. Numbers are stable for review references.

**Enabling and first contact**

1. Opening a workspace with no project coordinator, I see one row under the draft composer,
   "Set up a coordinator". I pick an investigator and an implementer profile, leave Observe,
   enable. The board replaces the draft pane, and within minutes one decision row appears:
   "Here's what I think this project is", with Looks right and Correct it.
2. I tap Correct it. The composer focuses with the draft quoted, I edit two lines and send, the
   coordinator rewrites the uncommitted memory file, and the row moves to Done as "Learned:
   project summary corrected".

**Handing it work**

3. I type "add a retry to the token refresh, it fails on cold start" into a project composer. A
   Working row appears, "Investigate token refresh cold-start failure", and the acknowledgement
   shows in the reply area.
4. At Propose, the investigator finishes and instead of a PR I get a decision: "Fix is a 12-line
   change in `auth/refresh.ts`. Raise trust to Ship to open a PR, or I'll post the diff here."
   with Ship it and Show diff.
5. I ask "what's the status of #41?" The answer appears in the reply area and no row is created.

**Decisions from the phone**

6. On a bus I get "CI failed on #41 (test-e2e). Same test passed on retry twice this week.
   Retrying in 1h 40m if no answer." with Retry, Investigate, Ignore on the lock screen. I tap
   Investigate. The app doesn't open, the row moves to Done as answered, and a Working row
   appears for the investigator.
7. I ignore that push. After the timeout the coordinator retries CI, and the Done row reads
   "Retried CI on #41 (default after 2h), green".

**Change requests and merging**

8. At Ship, an implementer finishes in its worktree. The coordinator spawns a reviewer, the
   reviewer passes, a PR opens, and I get "Opened #43: retry token refresh. 2 files, checks
   green." with Open, Merge, Request changes.
9. At Autopilot with a merge policy allowing coordinator-authored PRs under 300 lines, the same
   PR merges itself. The Done row reads "Merged #43 under policy", the worktree workspace is
   archived, and the digest counts it.

**Living with it**

10. Working all day in my own agent tabs, I open the project board and see my sessions in
    Working marked "Yours", with the goal line from my first message.
11. My own session has sat on a permission prompt for forty minutes while I'm in a meeting. A
    decision row and a push say "Your agent on fix-auth is waiting on a Bash permission for
    40m: `npm test`." with Allow, Deny, Leave it, Always allow this.
12. My session opened a PR without me noticing. The PR watch picks it up, spawns the reviewer,
    and I get "Review of #52 found two issues" with Open and Send to my agent.
13. I find this too much and switch scope to Project only. My sessions vanish from Working and the
    coordinator stops proposing anything about them.
14. I open the trust pill, see "Propose · 14 spawns · 1.2M of 5M tokens expected", and step down
    to Observe. The next wake row says "Level: Observe" and nothing spawns.
15. I open the personal memory pane, delete "prefers squash merges", save. The next wake's
    envelope no longer contains it.
16. A coordinator rotates overnight. Nothing changes on the board, Chat opens the successor, and
    the old transcript is one link back.

**Goals**

17. I type "keep dependencies current" into a composer. A proposal row appears: "Proposed goal:
    keep dependencies current. Weekly on Monday 08:00, spawn an implementer to bump minor and
    patch versions, open one PR." with Approve, Edit, Ignore. Nothing runs until Approve.
18. I tap Approve. The goal appears in the Goals tab with its plain line, the rule beneath, a
    last-run time, and a pause toggle.
19. The coordinator notices four of the last six PRs went stale for more than five days. A
    proposal appears: "I noticed PRs go stale. Proposed goal: when a PR is idle 3 days, rebase
    it, rerun CI, and post a one-line summary." citing the four PRs.
20. I tap Edit. The composer focuses with the proposal quoted, I change three days to five and
    send, and the coordinator reposts the proposal with the new rule for a fresh Approve.
21. Monday comes. The dependency goal fires as a schedule, the daemon spawns the implementer from
    the rule, the coordinator only sees the finish, and the Done row reads "Goal: keep
    dependencies current, opened #51".
22. A goal has fired three times without producing anything. The coordinator proposes pausing
    it, and the goal shows the streak.

**Global**

23. Starting my day I open Coordinator in the sidebar. Needs you lists five decisions across
    three projects, oldest first, each labeled with its project, and I clear them without
    opening a project.
24. I type "every repo should keep dependencies current" into the global composer. One proposal
    row appears with the rule fanned to each project, I approve once, and each project's Goals
    tab shows its copy.
25. I ask "what happened in paseo this week?" The global coordinator answers in the reply area
    from the project coordinator's summaries, without waking it.
26. I say "have paseo add retry to the token refresh". The global coordinator forwards it, the
    paseo Working row appears under paseo on the global board, and the acknowledgement names the
    project.
27. The global coordinator notices two projects hit the same flaky runner. One proposal appears
    citing both, and approving it writes a rule into both projects.
28. I add a new project to Paseo. The global coordinator proposes a project coordinator for it,
    and accepting runs story 1.

**Edges and failures**

29. I cross the usage expectation mid-month. One board row says so, nothing pauses, and the
    trust pill meter turns to the warning token.
30. The runaway guard trips on a recursive spawn. In-flight subagents finish, nothing new
    starts, and the wake row says "Guard: 8 concurrent subagents reached".
31. My Claude account hits its quota. The coordinator rotates to the Codex fallback profile I
    set. The wake row says "Rotated to codex/gpt-5 after capacity rejection", subagents keep
    their parent, and nothing is lost.
32. My daemon was off for the weekend. Monday the project coordinator wakes once with the full
    PR and CI diff since Friday, and goals that missed their cron fire once each.
33. I have three worktree workspaces in one project. Opening any of them shows the same project
    board, because the coordinator belongs to the project.
34. The repository has no CI. The setup sheet says the CI watch has nothing to poll, offers a
    goal to add CI, and the PR watch still works.
35. A subagent in Working has been at it for an hour with no visible progress. I tap the row,
    land in its tab, and Stop is where it always is. The coordinator records "Stopped by you".
36. I disable a project coordinator. The board disappears, the draft pane returns, goals pause
    rather than delete, memory stays on disk, and re-enabling restores the transcript lineage.
37. A reviewer flags an issue on a PR my own session authored. At Ship the coordinator posts the
    review as a PR comment and sends the fix request to my session. At Propose it asks me first.

## Settled

Decisions made 2026-09-11, in the order they were taken.

- Core, not a plugin. New code in new directories; sync cost accepted.
- First trigger is a local GitHub PR and CI poll over the forge service. Hub later.
- Memory is layered: team memory committed per repository, personal memory under the Paseo
  home at daemon level and per project, written only through the `remember` tool.
- Four trust levels in v1 including Autopilot, with a committed per-project merge policy.
- Trust level is host-local per project with a global default; the policy file caps it.
- Autopilot merges coordinator-authored change requests only.
- Personal memory is editable in the app.
- Board home at the workspace home; chat is the ordinary agent tab; Needs-you strip over two
  columns on desktop; digest push on by default.
- Coordinator replies land in a reply area above the composer.
- Every implementer output gets a reviewer subagent before a change request opens.
- Scope defaults to Everything: the coordinator tracks all sessions in the project and may act
  on yours within trust level and policy. Project only is the minimized setting.
- Goals from both you and the coordinator, approved by you, compiled into rules, shown as a
  plain line with the rule on tap. Personal in v1.
- Proposals whenever the coordinator notices something, board only, never pushed.
- No budget. A soft usage expectation plus a hard runaway guard: 8 concurrent, depth 2.
- Policy is grown interactively through "Always allow this" and evidence proposals. Personal.
- Two tiers: a global coordinator per daemon as the human's counterpart in a hidden
  daemon-owned workspace, project coordinators per project in the project-root workspace,
  delegation as subagent with per-turn notify, project composers talk to project coordinators,
  the global board shows Needs you across projects then Working by project.

## Assumptions

Defaults taken without a decision. Change them in the settings screen, not here.

- A decision takes its default answer after 2 hours.
- The digest sends at 08:00 local time.
- No pushes between 22:00 and 07:00 local time; a decision raised then waits for 07:00 and its
  timeout clock starts at delivery.
- The rotation threshold is 60% of the provider's context window.
- A stalled session is one with a permission pending for 30 minutes.
- Idle for the `pr.idle` trigger means no commits, comments, or reviews in the period.
- The global coordinator uses the same agent profile for every project coordinator it proposes,
  overridable per project in the sheet.
