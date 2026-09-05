# Kanban (`inbox`)

Review the agents that need your attention on one host. Open **Kanban** in the sidebar,
choose **Review next**, and answer without opening each agent's full conversation.
You can also add Kanban as a workspace panel or open it from the Command Center.

## Review

The three lanes follow agent state. You cannot drag cards between them.

- **Needs you** contains unanswered questions, approval requests, and errors, oldest first.
- **Working** contains running agents.
- **Done** contains unread results. **Mark read** dismisses a result without archiving the agent.

Idle agents without unread results are hidden. Same-workspace children share their parent's
card; children in another workspace get their own card. A waiting child supplies the card's
question, context, and waiting time. Its name appears above the question.

Open a card to select the parent or a child and read that agent's conversation. Reply and
**Open agent** always target the selected agent. Unread child results remain available after
you mark the parent read.

A successful answer advances an open review to the next waiting request, including another
child under the same parent. Failed answers stay in place with a retryable error. If you
select a different conversation while an answer is sending, completion leaves that selection
alone. **Next needing you** lets you skip a card without answering it.

## Drafts and filters

Replies save locally per host and agent, shared between cards and peeks. Switching agents,
closing a peek, refreshing the page, and reconnecting preserve the draft. A successful send
clears only the text that was sent. Save and send failures remain visible beside the composer.
Drafts stay on this app installation; they do not sync to another device.

Project and project-group filters also persist locally per host. A global review waits for
those filters to load. Workspace panels always show their own workspace, independently of
the global filters. The sidebar badge counts all waiting cards on the host.

Directory load failures show **Retry loading**. **Refresh** reloads the directory without
letting older fetch results replace newer live updates.

## Layout and shortcuts

Desktop gives Needs you more width; each lane scrolls independently. Compact layouts use
collapsible sections. Peeks use the host's scrolling modal so long questions and conversations
do not clip the actions. Cards use neutral borders; lane headings communicate status.

On the global web board, `j`/`k` move focus and Enter opens a card. Digits answer a
single-choice question; `y`/`n` allow or deny a permission. Shortcuts ignore text fields,
repeated keys, hidden views, and open peeks or filter pickers. Use the visible controls
inside a peek, where you can select a different child.

Update the Paseo app if the board asks you to. The host supplies active-view information and
local storage; a newer daemon alone cannot add these client capabilities.

## Development

This is a client-only directory plugin. Reload it after editing with the CLI targeting your
isolated dev daemon. See [the plugin guide](../../docs/plugins.md) for installation and reload.

Run only the affected test files, for example:

```sh
npx vitest run plugin-examples/inbox/client/store.test.ts --bail=1
npm run typecheck --workspace=@getpaseo/plugin
npm run lint
```

The plugin typecheck includes the example source. Browser checks need a real daemon and
provider session; unit tests alone do not prove provider delivery or native behavior.
