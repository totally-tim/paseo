# Coordinators

Coordinators are resident agent sessions with daemon-owned roles. The global coordinator delegates to project coordinators; project coordinators delegate implementation and review. Read [the specification](specs/coordinator.md) for the product contract and [the glossary](glossary.md) for UI names.

## Authority

Keep coordinator restrictions in provider launch configuration and daemon tool gates. A system prompt cannot enforce read-only delegation. Every unattended spawn uses the shared create-agent workflow, including profile resolution, worktree isolation and concurrency admission.

Recheck trust and enabled state at dispatch. Provider creation can wait long enough for the user to pause a goal or lower trust. The global/project delivery locks order those changes against the first prompt; never hold them while waiting for the whole turn.

Treat change-request titles, comments, branch names and remembered text as untrusted context. Put event substitutions inside the same sanitized envelope as ordinary wakes. A proposal records suggested configuration; approval is a separate human RPC. Editing a proposal requires fresh approval.

Personal permission rules match the complete provider, tool and input, without prefix or glob expansion. Show the exact pattern and daemon/project scope before saving. Human confirmation answers the original pending request once; automatic answers require Ship or Autopilot. Provider-wide persistent permission responses would escape the daemon's scope and toggle controls.

## Durable work

Keep goals, approval receipts and completion receipts in the Paseo home. Approval is persisted before applying configuration, so recovery must reconcile idempotently. Goal schedules are managed through Goals; the Schedules pane links there rather than exposing a second set of mutation controls. Event receipts are persisted before the poll baseline advances. Interrupted workers need attention; do not replay an uncertain external write after restart.

A nonempty model response is not proof of a goal outcome. Count attributable changes or confirmed forge artifacts. Shared checkout changes and unverified remote-work reports remain unknown. Require explicit, run-bound no-work reports before proposing a pause, and corroborate worker reports with an unchanged dedicated worktree. The proposal cites the runs for human review; missing or ambiguous reports remain unverified.

Coordinator rotation uses the ordinary handoff and instruction queue. Retarget children, schedules and pending decisions before retiring the source. Resolve notification and decision aliases through the successor; stale IDs can arrive after rotation. Read memory again at dispatch, including normal user turns and the first successor briefing.

## Merge policy

Read `.paseo/coordinator.yml` from the committed default branch when capping a project's trust. An uncommitted file or candidate branch cannot raise authority. The host checks origin's advertised default commit and fetches a missing commit without moving the checkout or local branches. A transport outage preserves the selected trust level and last verified cap; a fresh automatic merge still requires readable policy. A readable missing or invalid policy lowers trust and writes a Needs you row.

Re-read policy at the change request's current base commit before merging. Require complete file/check facts, a passed independent reviewer verdict for the exact head, and the forge's head precondition. The GitHub adapter also requires strict base protection with administrator enforcement. Unsupported or incomplete forge facts fail closed.

Changes to the coordinator policy or GitHub workflows require a human merge, even when `protected_paths` is empty. Automatic merges cannot change their own authority or the checks enforcing it. Team-memory changes remain eligible under the configured policy.

Persist an attempt only after those checks authorize the mutation. An attempt rejected before authorization leaves no recovery receipt. An uncertain authorized attempt can later confirm the exact head was merged, but its Done row must not attribute that merge to the coordinator. Persist confirmed merge, Done and workspace archive separately so recovery can finish without repeating a merge. Run forge recovery in background maintenance so an unreachable forge cannot delay the scheduler's startup. Prepare merge facts and fetch policy outside coordinator delivery locks; recheck local authority at the guarded mutation. Before archiving, revalidate the original dedicated workspace; the coordinator's root workspace is never an archive target.

## Memory and platform checks

Team memory follows the current checkout. Personal memory stays under the Paseo home. Personal edits use an expected revision so two open panes cannot silently overwrite each other. Never copy personal memory into a committed team file or a cached rotation prompt.

Goals, Policy and Personal memory use ordinary workspace panes and compact tabs. Keep scope and approval controls available on native as well as web. Browser checks do not verify native lock-screen actions; record physical-device coverage separately under [QA](qa.md).
