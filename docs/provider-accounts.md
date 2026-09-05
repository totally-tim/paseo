# Provider accounts

Use **Settings → Host → Agents → Provider accounts** to add Claude or Codex subscription accounts. The host runs the provider's login flow. Complete it in the provider's browser page; a remote phone receives only the login link, device code when required, and status. A started login is not a signed-in account. Paseo verifies the identity after the provider completes authentication.

An account is a stable identity and provider configuration directory. An agent profile is launch configuration. A running agent keeps its resolved account when you edit a profile, rename an account, or change the automatic pool. See [agent lifecycle](agent-lifecycle.md) for continuation ownership.

## Provider ownership

|                 | Claude                                                           | Codex                                                  |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| Login           | Unmodified `claude auth login --claudeai`                        | Unmodified app-server device login                     |
| Identity        | `claude auth status --json`                                      | `account/read`, without a forced refresh               |
| Managed context | `CLAUDE_CONFIG_DIR` and matching provider secure-storage context | `CODEX_HOME`, with `cli_auth_credentials_store="file"` |
| Usage           | Claude Agent SDK usage control                                   | `account/rateLimits/read`                              |
| Refresh         | Claude Code                                                      | Codex                                                  |

Paseo stores metadata under `$PASEO_HOME/provider-accounts`. Each managed account gets a private directory with mode `0700`. The metadata file uses atomic replacement and mode `0600`. Credentials remain in storage owned by the provider: Claude's own secure-storage implementation on macOS or credential files on Linux, and Codex credential files inside its managed home. Do not copy tokens into Paseo metadata or introduce another refresh writer.

Use one directory per account, shared by that account's provider processes. Per-agent credential copies can race token rotation and lose the account's refreshed credentials. Processes for different accounts use different directories. Do not symlink their history together. Provider refresh behavior within one account remains the CLI's responsibility.

The **Host CLI account** preserves the existing environment and login. It is external: Paseo can inspect it but cannot log it out or remove it. Provider aliases retain their configured endpoints and credentials. Native account selection applies only to the built-in Claude and Codex providers; API-key aliases are described in [custom providers](custom-providers.md).

Use the unmodified provider binaries and the user's own provider login. Anthropic's [integration conditions](https://code.claude.com/docs/en/legal-and-compliance) distinguish hosting Claude Code from collecting credentials or offering an independent Claude.ai authentication client. [OpenAI's terms](https://openai.com/policies/row-terms-of-use/) prohibit circumventing rate limits. This feature does not establish permission to bypass a provider's limits or share another person's account.

## Selection and capacity

A profile, new-agent form, schedule, or continuation can request a fixed account, the host CLI account, or automatic selection. With no explicit choice, new agents use automatic selection when enabled managed accounts exist; otherwise they preserve the host CLI behavior. An incomplete account stays outside the pool until its identity is verified.

Automatic selection stays within the requested provider. It considers authentication, enabled state, reported capacity, user settings, and active reservations. Admission makes the choice and acquires a reservation in one synchronous step after usage reads. Simultaneous starts therefore observe earlier reservations. A reservation counts an active runtime; it does not reserve tokens or predict the next turn's cost.

The chosen account is persisted before provider startup. Resume and restart reuse it. Same-provider children inherit the parent's account; a child on another provider resolves an account for that provider. Handoff starts an independent successor and can select another account. It never changes the source process's credentials.

Configure the interactive reserve separately for each account, or mark an account for interactive work only. Paseo does not install a preset reserve percentage. Until you choose the policy for unknown usage, unattended managed-account starts with unknown usage stop with an actionable error. Interactive starts can proceed when usage is unknown; known exhaustion still blocks a new start. Existing host CLI behavior is preserved.

Usage windows reflect what the provider reports. Missing usage remains unknown, including when a provider supplies only one window. Cached usage has a five-minute lifetime; settings poll the cache and request bounded background refreshes. At most two quota helpers run at once. Native model catalogs are also account-scoped and bounded. A failed account read does not substitute another account's credentials or hide other accounts.

The next-account label is a preview. Another start, a quota refresh, or a settings change can alter the choice before submission. The agent's account label shows the resolved result. Reliable provider capacity rejections are remembered for future starts, while transient throttling, authentication errors, and network failures remain separate. Use **Continue with…** to choose recovery explicitly. Cross-provider and local continuation send context only after that choice.

## Removal and recovery

Close an account's agents before re-authenticating, signing out, or removing it. Login changes are also rejected while that account has an active helper. Disabling an account removes it from new-agent selection; existing pinned agents can still resume it.

Removal requires an explicit choice: retain the provider login or sign out. Both preserve the account ID, directory, and historical links. Restore the account before resuming its old agents. Restoration leaves automatic selection disabled until you enable it. Signing in with a different identity does not replace the old account's identity. Duplicate managed identities are quarantined instead of creating another eligible account. The external host CLI identity can also have a managed login; the host entry stays outside the automatic pool and its credentials remain untouched.

A daemon restart interrupts incomplete login. Sign in again or use **Check login** if the provider finished before the restart. Partial imports keep their original account and native session ID. Historical handoff pages use saved context and do not reopen the old provider. A created successor's retry keeps that successor and account; the handoff's existing ambiguous-delivery guard still applies.

## Compatibility and verification

Account wire fields are optional and the client gates the feature with `server_info.features.providerAccounts`. Metadata and catalogs require `daemon.read`; login links, one-time codes, and mutations require `daemon.manage`. Login requests are not queued for replay. Never include login challenges or provider output in logs, handoff exports, profiles, or persisted client state.

Claude usage uses an experimental SDK control. An unsupported installed binary reports usage as unavailable. Verify the current binary when changing that integration. The backend has been exercised with Claude Code 2.1.261 and Codex 0.153.2 on macOS, and Codex 0.144.4 in Linux Docker. These checks establish login startup/cancellation and native controls, not two authenticated identities or a completed live account handoff.

Keep deterministic account isolation tests separate from real-account evidence. Real A-to-B continuation requires two authenticated, usable identities for each provider. Never manufacture that proof from a fake provider or spend quota deliberately to hit a cap. Native mobile and packaged desktop proof remain separate from compact web checks. Follow [QA](qa.md) for the evidence bar.
