import pLimit from "p-limit";
import { randomUUID } from "node:crypto";
import type {
  AccountLogin,
  AccountPolicy,
  AccountProvider,
  AccountSelection,
  ProviderAccount,
  ProviderAccountIdentity,
} from "@getpaseo/protocol/provider-accounts";
import { AccountProviderSchema } from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "../messages.js";
import { unavailableUsage } from "../../services/quota-fetcher/usage.js";
import type { ProviderAccountContext } from "../agent/provider-account-context.js";
import { ProviderAccountStore } from "./account-store.js";

export interface AccountBackend {
  inspect(): Promise<ProviderAccountIdentity | null>;
  login(input: {
    signal: AbortSignal;
    onChallenge: (challenge: AccountLogin["challenge"]) => void;
    onSubmitCode: (submit: (code: string) => void) => void;
  }): Promise<ProviderAccountIdentity>;
  logout(): Promise<void>;
  usage(): Promise<ProviderUsage>;
}

export interface AccountLease {
  accountId: string;
  context: ProviderAccountContext | undefined;
  reason: string;
  release(): void;
}

interface ActiveLogin {
  view: AccountLogin;
  abort: AbortController;
  done: Promise<void>;
  submit?: (code: string) => void;
}

export interface AccountChoice {
  accountId: string | null;
  reason: string;
}

export interface RecoveryAccountChoice extends AccountChoice {
  needsAttention: boolean;
  resetsAt?: string;
}

export class AccountOperationError extends Error {}

/** A login helper that would not terminate may still hold the account's credential files. */
export class AccountHelperShutdownError extends Error {
  constructor() {
    super("The account helper did not shut down. Check its status before changing this login.");
  }
}

const USAGE_TTL_MS = 5 * 60_000;
/** How long a capacity rejection stands when the provider reported no reset time. */
const UNDATED_CAPACITY_COOLDOWN_MS = 15 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export class ProviderAccountService {
  private readonly logins = new Map<string, ActiveLogin>();
  private readonly busy = new Set<string>();
  private readonly leases = new Map<string, number>();
  private readonly usageCache = new Map<
    string,
    { revision: number; at: number; usage: ProviderUsage }
  >();
  private readonly usageRequests = new Map<string, Promise<ProviderUsage>>();
  private readonly inspections = new Map<string, Promise<ProviderAccount>>();
  private closed = false;
  private usageRefresh: Promise<void> | null = null;
  private pendingAdds = 0;
  private readonly usageLimit = pLimit(2);
  private readonly updates = new Map<string, Promise<unknown>>();
  private identityQueue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(account: ProviderAccount) => void>();

  constructor(
    readonly store: ProviderAccountStore,
    private readonly backend: (
      account: ProviderAccount,
      context?: ProviderAccountContext,
    ) => AccountBackend,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.ensureExternal("claude");
    await this.store.ensureExternal("codex");
    for (const account of this.store.list()) {
      if (account.authState === "authenticating") {
        await this.update(account.id, {
          authState: "signed-out",
          error: "Login was interrupted by a daemon restart. Sign in again.",
        });
      }
    }
  }

  list(): ProviderAccount[] {
    return this.store.list();
  }

  onChange(listener: (account: ProviderAccount) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activeLogins(): AccountLogin[] {
    return [...this.logins.values()].map((login) => structuredClone(login.view));
  }

  /** The login still running for this account, so a status read cannot discard its controls. */
  activeLogin(accountId: string, loginId?: string): AccountLogin | null {
    const active = this.logins.get(accountId);
    if (!active || (loginId && active.view.id !== loginId)) return null;
    return structuredClone(active.view);
  }

  async add(provider: AccountProvider, label: string): Promise<ProviderAccount> {
    this.assertOpen();
    if (this.list().length + this.pendingAdds >= 34)
      throw new AccountOperationError("At most 32 managed accounts can be added.");
    this.pendingAdds++;
    try {
      return await this.store.create(provider, label);
    } finally {
      this.pendingAdds--;
    }
  }

  async edit(
    id: string,
    changes: Pick<
      Partial<ProviderAccount>,
      "label" | "enabled" | "reservePercent" | "interactiveOnly"
    >,
  ): Promise<ProviderAccount> {
    this.assertOpen();
    if (this.busy.has(id))
      throw new AccountOperationError("An account operation is still in progress.");
    this.busy.add(id);
    try {
      return await this.update(id, changes, true);
    } finally {
      this.busy.delete(id);
    }
  }

  async setPolicy(policy: AccountPolicy): Promise<void> {
    await this.store.setPolicy(policy);
  }

  async inspect(id: string): Promise<ProviderAccount> {
    this.assertOpen();
    const pending = this.inspections.get(id);
    if (pending) return pending;
    const inspection = this.inspectAccount(id);
    this.inspections.set(id, inspection);
    try {
      return await inspection;
    } finally {
      this.inspections.delete(id);
    }
  }

  private async inspectAccount(id: string): Promise<ProviderAccount> {
    const account = this.store.get(id);
    if (this.busy.has(id)) return account;
    this.busy.add(id);
    try {
      const identity = await this.backend(account, this.store.context(id)).inspect();
      // A managed account owns its directory, so a different identity there is a mistake. The
      // host CLI login is the user's own and can legitimately change outside Paseo.
      if (
        identity &&
        account.ownership === "managed" &&
        account.identity &&
        account.identity.key !== identity.key
      ) {
        return await this.update(id, {
          authState: "error",
          error:
            "The provider login belongs to a different identity. Re-authenticate the original account.",
        });
      }
      if (identity) return await this.commitIdentity(account, identity);
      return await this.update(id, { authState: "signed-out", error: null });
    } finally {
      this.busy.delete(id);
    }
  }

  async startLogin(id: string): Promise<AccountLogin> {
    this.assertMutable(id);
    this.busy.add(id);
    try {
      const account = await this.update(id, { authState: "authenticating", error: null });
      const abort = new AbortController();
      const view: AccountLogin = {
        id: randomUUID(),
        accountId: id,
        expiresAt: new Date(this.now() + LOGIN_TIMEOUT_MS).toISOString(),
        challenge: { kind: "starting" },
      };
      const active: ActiveLogin = { view, abort, done: Promise.resolve() };
      let stranded = false;
      this.logins.set(id, active);
      const timer = setTimeout(() => abort.abort(), LOGIN_TIMEOUT_MS);
      timer.unref();
      active.done = (async () => {
        try {
          const identity = await this.backend(account, this.store.context(id)).login({
            signal: abort.signal,
            onChallenge: (challenge) => {
              if (!abort.signal.aborted) active.view.challenge = challenge;
            },
            onSubmitCode: (submit) => {
              active.submit = submit;
            },
          });
          if (abort.signal.aborted) throw new AccountOperationError("canceled");
          if (account.identity && account.identity.key !== identity.key) {
            await this.update(id, {
              authState: "error",
              error:
                "This login belongs to a different identity. Sign in with the original account.",
            });
            return;
          }
          await this.commitIdentity(account, identity);
        } catch (error) {
          // An unconfirmed helper shutdown keeps the account locked: another login or logout
          // could otherwise mutate credentials the previous helper still has open.
          stranded = error instanceof AccountHelperShutdownError;
          const incomplete = abort.signal.aborted
            ? "Login canceled or expired. Sign in again."
            : "Login did not complete. Try again.";
          await this.update(id, {
            authState: stranded ? "error" : "signed-out",
            error: stranded
              ? "The account helper did not shut down. Check its status before changing this login."
              : incomplete,
          });
        } finally {
          clearTimeout(timer);
          this.logins.delete(id);
          if (!stranded) this.busy.delete(id);
        }
      })();
      // Persistence failure is visible on the next read; never leak provider output through logs.
      void active.done.catch(() => undefined);
      return structuredClone(view);
    } catch (error) {
      this.busy.delete(id);
      throw error;
    }
  }

  private duplicateOf(
    account: ProviderAccount,
    identity: ProviderAccountIdentity,
  ): ProviderAccount | undefined {
    if (account.ownership !== "managed") return undefined;
    return this.list().find(
      (other) =>
        other.id !== account.id &&
        other.ownership === "managed" &&
        !other.removedAt &&
        other.identity?.key === identity.key &&
        other.provider === account.provider,
    );
  }

  private async quarantineDuplicate(
    account: ProviderAccount,
    identity: ProviderAccountIdentity,
  ): Promise<void> {
    const duplicate = this.duplicateOf(account, identity);
    if (!duplicate) return;
    await this.update(account.id, {
      authState: "error",
      identity,
      enabled: false,
      error: `This identity is already registered as ${duplicate.label}.`,
    });
  }

  private commitIdentity(
    account: ProviderAccount,
    identity: ProviderAccountIdentity,
  ): Promise<ProviderAccount> {
    const commit = this.identityQueue.then(async () => {
      const duplicate = this.duplicateOf(account, identity);
      if (duplicate)
        return this.update(account.id, {
          authState: "error",
          identity,
          enabled: false,
          error: `This identity is already registered as ${duplicate.label}.`,
        });
      return this.update(account.id, {
        authState: "ready",
        identity,
        enabled: account.identity ? account.enabled : true,
        error: null,
      });
    });
    this.identityQueue = commit.catch(() => undefined);
    return commit;
  }

  async remove(id: string, credentials: "retain" | "logout"): Promise<void> {
    this.assertMutable(id);
    this.busy.add(id);
    try {
      if (credentials === "logout")
        await this.backend(this.store.get(id), this.store.context(id)).logout();
      await this.update(id, {
        removedAt: new Date(this.now()).toISOString(),
        enabled: false,
        ...(credentials === "logout" ? { authState: "signed-out" as const } : {}),
      });
    } finally {
      this.busy.delete(id);
    }
  }

  async restore(id: string): Promise<void> {
    this.assertMutable(id);
    this.busy.add(id);
    try {
      const account = await this.update(id, { removedAt: undefined, enabled: false });
      // Another account may have taken this identity while this one was removed.
      if (account.identity) await this.quarantineDuplicate(account, account.identity);
    } finally {
      this.busy.delete(id);
    }
  }

  async reportCapacity(id: string, model?: string, resetsAt?: string): Promise<void> {
    await this.update(id, {
      capacityLimit: { observedAt: new Date(this.now()).toISOString(), model, resetsAt },
    });
  }

  async cancelLogin(id: string, loginId: string): Promise<void> {
    const active = this.requireLogin(id, loginId);
    active.abort.abort();
    await active.done;
  }

  submitCode(id: string, loginId: string, code: string): void {
    const active = this.requireLogin(id, loginId);
    if (
      !active.submit ||
      !code.trim() ||
      code.length > 2048 ||
      code.includes("\n") ||
      code.includes("\r") ||
      code.includes(String.fromCharCode(0))
    ) {
      throw new AccountOperationError("This login is not accepting a valid one-time code.");
    }
    active.submit(code.trim());
  }

  async logout(id: string): Promise<void> {
    this.assertMutable(id);
    this.busy.add(id);
    try {
      await this.backend(this.store.get(id), this.store.context(id)).logout();
      await this.update(id, { authState: "signed-out", error: null });
    } finally {
      this.busy.delete(id);
    }
  }

  /** Refresh the external host CLI identities in the background after startup. */
  inspectHostAccounts(): void {
    for (const provider of AccountProviderSchema.options)
      void this.inspect(`default:${provider}`).catch(() => undefined);
  }

  usageSnapshot(id: string): { accountId: string; usage: ProviderUsage; stale: boolean } {
    const account = this.store.get(id);
    const cached = this.usageCache.get(id);
    const current = cached?.revision === account.revision;
    return {
      accountId: id,
      usage: current
        ? cached.usage
        : unavailableUsage({ providerId: account.provider, displayName: account.label }),
      stale: !current || this.now() - cached.at >= USAGE_TTL_MS,
    };
  }

  refreshUsage(): void {
    if (this.closed || this.usageRefresh) return;
    // The user can sign in to a provider CLI after the daemon started; nothing tells us.
    for (const account of this.list())
      if (account.ownership === "external" && account.authState !== "ready")
        void this.inspect(account.id).catch(() => undefined);
    const accounts = this.list().filter(
      (account) => account.authState === "ready" && !account.removedAt,
    );
    this.usageRefresh = (async () => {
      for (let offset = 0; offset < accounts.length && !this.closed; offset += 2) {
        await Promise.allSettled(
          accounts.slice(offset, offset + 2).map((account) => this.usage(account.id)),
        );
      }
    })().finally(() => {
      this.usageRefresh = null;
    });
  }

  async usage(id: string, fresh = false): Promise<ProviderUsage> {
    const account = this.store.get(id);
    const unavailable = () =>
      unavailableUsage({ providerId: account.provider, displayName: account.label });
    if (account.removedAt || account.authState !== "ready" || this.busy.has(id))
      return unavailable();
    const cached = this.usageCache.get(id);
    if (!fresh && cached?.revision === account.revision && this.now() - cached.at < USAGE_TTL_MS)
      return cached.usage;
    const key = `${id}:${account.revision}`;
    const pending = this.usageRequests.get(key);
    if (pending) return pending;
    const request = this.usageLimit(async () => {
      if (this.closed || this.store.get(id).revision !== account.revision) return unavailable();
      let usage: ProviderUsage;
      try {
        usage = await this.backend(account, this.store.context(id)).usage();
      } catch {
        usage = unavailableUsage({
          providerId: account.provider,
          displayName: account.label,
          error: "Could not read usage from the provider. Try again after the next refresh.",
        });
      }
      if (this.store.get(id).revision !== account.revision) return unavailable();
      const at = this.now();
      usage = {
        ...usage,
        providerId: account.provider,
        displayName: account.label,
        fetchedAt: new Date(at).toISOString(),
        nextRefreshAt: new Date(at + USAGE_TTL_MS).toISOString(),
      };
      this.usageCache.set(id, { revision: account.revision, at, usage });
      return usage;
    });
    this.usageRequests.set(key, request);
    try {
      return await request;
    } finally {
      this.usageRequests.delete(key);
    }
  }

  async recoveryChoice(input: {
    provider: AccountProvider;
    accountIds: string[];
    model?: string;
    exclude?: string[];
  }): Promise<RecoveryAccountChoice> {
    this.assertOpen();
    const selection = { kind: "automatic" as const, accountIds: input.accountIds };
    const configured = this.automaticCandidates(input.provider, selection);
    if (!configured.length)
      return {
        accountId: null,
        needsAttention: true,
        reason: "No permitted account is enabled and signed in. Check the profile's accounts.",
      };
    const readings = new Map<string, ProviderUsage>();
    await Promise.all(
      configured.map(async (account) => {
        // The provider owns authentication. Inspect its identity again before sending more work.
        try {
          await this.inspect(account.id);
        } catch {
          return;
        }
        // Inspection and usage both return the stored value while another operation holds the
        // account. A skipped read is not a reading, so it cannot establish capacity.
        if (this.busy.has(account.id)) return;
        const usage = await this.usage(account.id, true);
        if (usage.status === "available") readings.set(account.id, usage);
      }),
    );
    const considered = this.automaticCandidates(input.provider, selection);
    const excluded = this.identityClosure(considered, input.exclude ?? []);
    const eligible = considered.filter((account) => {
      const usage = readings.get(account.id);
      if (!usage || excluded.has(account.id)) return false;
      const windows = applicableWindows(usage, input.model);
      return (
        windows.length > 0 &&
        windows.every((window) => typeof window.usedPct === "number") &&
        this.eligibility(account, true, false, input.model).accountId !== null
      );
    });
    eligible.sort(
      (a, b) => this.score(b, input.model) - this.score(a, input.model) || a.id.localeCompare(b.id),
    );
    if (eligible[0])
      return {
        accountId: eligible[0].id,
        reason: "Confirmed capacity for automatic continuation",
        needsAttention: false,
      };
    const resets = considered
      .map((account) => this.recoveryReset(account, input.model))
      .filter((value): value is number => value !== null);
    return {
      accountId: null,
      needsAttention: considered.length === 0,
      reason: considered.length
        ? "Waiting for confirmed account capacity"
        : "The permitted accounts need attention. Check their login and enabled state.",
      ...(resets.length ? { resetsAt: new Date(Math.min(...resets)).toISOString() } : {}),
    };
  }

  /** One subscription can appear as a host login and a managed context. Exclude it once. */
  private identityClosure(candidates: ProviderAccount[], excluded: string[]): Set<string> {
    const all = this.list();
    const keys = new Set(
      excluded
        .map((id) => all.find((account) => account.id === id)?.identity?.key)
        .filter((key): key is string => Boolean(key)),
    );
    const closure = new Set(excluded);
    for (const account of candidates)
      if (account.identity?.key && keys.has(account.identity.key)) closure.add(account.id);
    return closure;
  }

  private recoveryReset(account: ProviderAccount, model?: string): number | null {
    const windows = applicableWindows(this.currentUsage(account), model);
    const deadlines = windows
      .filter(
        (window) =>
          typeof window.usedPct === "number" &&
          100 - window.usedPct <= (account.reservePercent ?? 0),
      )
      .map((window) => Date.parse(window.resetsAt ?? ""));
    if (!account.capacityLimit?.model || account.capacityLimit.model === model)
      deadlines.push(Date.parse(account.capacityLimit?.resetsAt ?? ""));
    const future = deadlines.filter((at) => Number.isFinite(at) && at > this.now());
    // Every blocking window must reset before this account can run again.
    return future.length ? Math.max(...future) : null;
  }

  choice(
    provider: AccountProvider,
    selection: AccountSelection,
    unattended: boolean,
    model?: string,
  ): AccountChoice {
    const candidates = this.list().filter((account) => account.provider === provider);
    if (selection.kind === "default")
      return this.store.get(`default:${provider}`).enabled
        ? { accountId: `default:${provider}`, reason: "Host CLI account" }
        : { accountId: null, reason: "The host CLI account is disabled for new agents." };
    if (selection.kind === "fixed") {
      const account = candidates.find((entry) => entry.id === selection.accountId);
      if (
        !account ||
        !account.enabled ||
        account.authState !== "ready" ||
        this.busy.has(account.id)
      ) {
        return {
          accountId: null,
          reason: "The selected account is unavailable. Sign in or enable it in Settings.",
        };
      }
      return this.eligibility(account, unattended, true, model);
    }
    const considered = this.automaticCandidates(provider, selection).map((account) => ({
      account,
      choice: this.eligibility(account, unattended, false, model),
    }));
    const eligible = considered.filter((entry) => entry.choice.accountId !== null);
    eligible.sort(
      (a, b) =>
        this.score(b.account, model) - this.score(a.account, model) ||
        a.account.id.localeCompare(b.account.id),
    );
    return (
      eligible[0]?.choice ?? {
        accountId: null,
        reason: considered.length
          ? `No eligible account: ${[...new Set(considered.map((entry) => entry.choice.reason))].join(" ")}`
          : "No enabled account is signed in. Check accounts in Settings.",
      }
    );
  }

  private automaticCandidates(
    provider: AccountProvider,
    selection: Extract<AccountSelection, { kind: "automatic" }>,
  ): ProviderAccount[] {
    const candidates = this.list().filter(
      (account) =>
        account.provider === provider &&
        account.enabled &&
        !account.removedAt &&
        account.authState === "ready" &&
        (!selection.accountIds || selection.accountIds.includes(account.id)),
    );
    // A host login can also have a managed context. Count its subscription once.
    return candidates.filter(
      (account) =>
        account.ownership !== "external" ||
        !candidates.some(
          (other) =>
            other.ownership === "managed" &&
            other.identity?.key &&
            other.identity.key === account.identity?.key,
        ),
    );
  }

  catalogChoice(provider: AccountProvider, selection?: AccountSelection): AccountChoice {
    if (selection?.kind === "fixed")
      return { accountId: selection.accountId, reason: "Fixed account" };
    const available = this.preview(provider, selection);
    if (available.accountId || selection?.kind === "default") return available;
    // Reading model names does not consume a subscription's generation quota.
    const account = this.automaticCandidates(provider, selection ?? { kind: "automatic" }).find(
      (candidate) => !this.busy.has(candidate.id),
    );
    return account ? { accountId: account.id, reason: "Account model catalog" } : available;
  }

  preview(provider: string, selection?: AccountSelection, model?: string): AccountChoice {
    if (provider !== "claude" && provider !== "codex")
      return { accountId: null, reason: "This provider uses its configured login." };
    const managed = this.list().some(
      (account) =>
        account.provider === provider &&
        account.ownership === "managed" &&
        account.enabled &&
        !account.removedAt,
    );
    return this.choice(
      provider,
      selection ?? { kind: managed ? "automatic" : "default" },
      false,
      model,
    );
  }

  async reserve(input: {
    provider: string;
    selection?: AccountSelection;
    pinnedAccountId?: string;
    unattended: boolean;
    model?: string;
  }): Promise<AccountLease | null> {
    this.assertOpen();
    if (input.provider !== "claude" && input.provider !== "codex") {
      if (input.pinnedAccountId || (input.selection && input.selection.kind !== "default"))
        throw new AccountOperationError("This provider does not support native accounts.");
      return null;
    }
    const provider = input.provider;
    if (input.pinnedAccountId) {
      const account = this.store.get(input.pinnedAccountId);
      if (account.removedAt)
        throw new AccountOperationError(
          "Restore the pinned account in Settings before resuming this agent.",
        );
      if (account.provider !== provider)
        throw new AccountOperationError("The pinned account belongs to a different provider.");
      if (this.busy.has(account.id))
        throw new AccountOperationError("An account operation is still in progress.");
      if (account.ownership === "managed" && account.authState !== "ready")
        throw new AccountOperationError(
          "Sign in to the pinned account before resuming this agent.",
        );
      return this.lease(account.id, "Pinned account");
    }
    const managed = this.list().filter(
      (account) =>
        account.provider === provider &&
        account.ownership === "managed" &&
        account.enabled &&
        !account.removedAt,
    );
    const selection =
      input.selection ?? (managed.length ? { kind: "automatic" } : { kind: "default" });
    if (selection.kind !== "default") {
      // Fetch before admission; the synchronous decision and reservation below cannot interleave.
      const ids =
        selection.kind === "fixed"
          ? [selection.accountId]
          : this.automaticCandidates(provider, selection).map((account) => account.id);
      for (let offset = 0; offset < ids.length; offset += 2) {
        await Promise.all(ids.slice(offset, offset + 2).map((id) => this.usage(id)));
      }
    }
    this.assertOpen();
    const chosen = this.choice(provider, selection, input.unattended, input.model);
    if (!chosen.accountId) throw new AccountOperationError(chosen.reason);
    return this.lease(chosen.accountId, chosen.reason);
  }

  hasRuntime(id: string): boolean {
    return (this.leases.get(id) ?? 0) > 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.logins.values()) active.abort.abort();
    await Promise.allSettled([...this.logins.values()].map((login) => login.done));
    await Promise.allSettled(this.usageRequests.values());
    await Promise.allSettled(this.inspections.values());
    await Promise.allSettled(this.updates.values());
  }

  private eligibility(
    account: ProviderAccount,
    unattended: boolean,
    fixed: boolean,
    model?: string,
  ): AccountChoice {
    const no = (reason: string): AccountChoice => ({ accountId: null, reason });
    if (
      account.removedAt ||
      !account.enabled ||
      account.authState !== "ready" ||
      this.busy.has(account.id)
    )
      return no("Account is unavailable.");
    if (unattended && account.interactiveOnly)
      return no("This account is reserved for interactive work.");
    const usage = this.currentUsage(account);
    const windows = applicableWindows(usage, model);
    const capacityError = capacityRejection(
      account.capacityLimit,
      usage,
      windows.length,
      model,
      this.now(),
    );
    if (capacityError) return no(capacityError);
    const blocked = windows.find(
      (window) => typeof window.usedPct === "number" && window.usedPct >= 100,
    );
    if (blocked)
      return no(
        blocked.resetsAt
          ? `Account capacity resets at ${blocked.resetsAt}.`
          : "Account capacity is exhausted.",
      );
    if (
      unattended &&
      windows.some(
        (window) =>
          typeof window.usedPct === "number" &&
          100 - window.usedPct <= (account.reservePercent ?? 0),
      )
    )
      return no("The account's interactive reserve is protected.");
    const unknown =
      windows.length === 0 || windows.some((window) => typeof window.usedPct !== "number");
    if (unknown && unattended) {
      const policy = this.store.getPolicy();
      if (!policy)
        return no(
          "In account settings, choose whether scheduled and background agents may start when remaining usage cannot be checked.",
        );
      if (policy.unknownQuota === "pause-unattended")
        return no("Scheduled and background agents wait until remaining usage can be checked.");
    }
    let reason = fixed ? "Fixed account" : "Available capacity balanced with active agents";
    if (unknown)
      reason =
        "The provider has not reported remaining usage. You can still start an agent manually.";
    return { accountId: account.id, reason };
  }

  private currentUsage(account: ProviderAccount): ProviderUsage | null {
    const cached = this.usageCache.get(account.id);
    if (cached?.revision !== account.revision || this.now() - cached.at >= USAGE_TTL_MS)
      return null;
    return cached.usage;
  }

  private score(account: ProviderAccount, model?: string): number {
    const usage = this.currentUsage(account);
    const percentages = applicableWindows(usage, model)
      .map((window) => window.usedPct)
      .filter((value): value is number => typeof value === "number");
    const remaining = percentages.length ? Math.max(0, 100 - Math.max(...percentages)) : 0;
    return remaining / (1 + (this.leases.get(account.id) ?? 0));
  }

  private lease(id: string, reason: string): AccountLease {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return {
      accountId: id,
      context: this.store.context(id),
      reason,
      release: () => {
        if (released) return;
        released = true;
        const count = (this.leases.get(id) ?? 1) - 1;
        if (count) this.leases.set(id, count);
        else this.leases.delete(id);
      },
    };
  }

  private update(
    id: string,
    changes: Partial<ProviderAccount>,
    preserveUsage = false,
  ): Promise<ProviderAccount> {
    const next = (this.updates.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.applyUpdate(id, changes, preserveUsage));
    this.updates.set(id, next);
    void next
      .finally(() => {
        if (this.updates.get(id) === next) this.updates.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  private async applyUpdate(
    id: string,
    changes: Partial<ProviderAccount>,
    preserveUsage: boolean,
  ): Promise<ProviderAccount> {
    const account = this.store.get(id);
    const next = {
      ...account,
      ...changes,
      revision: account.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.store.save(next);
    const cached = this.usageCache.get(id);
    if (preserveUsage && cached?.revision === account.revision) {
      this.usageCache.set(id, {
        ...cached,
        revision: next.revision,
        usage: { ...cached.usage, displayName: next.label },
      });
    } else {
      this.usageCache.delete(id);
    }
    const saved = this.store.get(id);
    for (const listener of this.listeners) listener(saved);
    return saved;
  }

  private assertMutable(id: string): void {
    this.assertOpen();
    if (this.store.get(id).ownership === "external")
      throw new AccountOperationError(
        "Manage the host CLI login in its own terminal. Add an account for a separate Paseo login.",
      );
    if (this.busy.has(id))
      throw new AccountOperationError("An account operation is still in progress.");
    if (this.hasRuntime(id))
      throw new AccountOperationError("Close this account's agents before changing its login.");
    if ([...this.usageRequests.keys()].some((key) => key.startsWith(`${id}:`)))
      throw new AccountOperationError(
        "Wait for the account usage refresh before changing its login.",
      );
  }

  private assertOpen(): void {
    if (this.closed) throw new AccountOperationError("Account management is shutting down.");
  }

  private requireLogin(id: string, loginId: string): ActiveLogin {
    const active = this.logins.get(id);
    if (!active || active.view.id !== loginId)
      throw new AccountOperationError("This login has expired. Start a new login.");
    return active;
  }
}

// The provider supplies model bucket labels, not a mapping to model IDs. Unknown
// buckets remain visible but cannot reject a different model's admission.
/** Provider bucket labels and model IDs differ in spacing and punctuation, not in words. */
function modelKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function applicableWindows(usage: ProviderUsage | null, model?: string): ProviderUsage["windows"] {
  if (usage?.status !== "available") return [];
  const selected = model ? modelKey(model) : undefined;
  return usage.windows.filter((window) => {
    if (window.id === "seven_day_opus") return Boolean(selected?.includes("opus"));
    if (window.id === "seven_day_sonnet") return Boolean(selected?.includes("sonnet"));
    if (window.id.startsWith("model:"))
      return Boolean(selected?.includes(modelKey(window.id.split(":").slice(2).join(":"))));
    return true;
  });
}

function capacityRejection(
  capacity: ProviderAccount["capacityLimit"],
  usage: ProviderUsage | null,
  windowCount: number,
  model: string | undefined,
  now: number,
): string | null {
  if (
    !capacity ||
    (capacity.model && capacity.model !== model) ||
    (capacity.resetsAt && Date.parse(capacity.resetsAt) <= now)
  )
    return null;
  // A newer reading alone cannot show the limit has lifted when the provider named no reset:
  // recovery reads usage immediately before deciding, so the reading is always newer and the
  // same account would be re-prompted on every wake. Hold the rejection for a bounded cooldown
  // instead, which stops the loop without stranding an account nothing else would clear.
  const clearsAt = capacity.resetsAt
    ? Date.parse(capacity.resetsAt)
    : Date.parse(capacity.observedAt) + UNDATED_CAPACITY_COOLDOWN_MS;
  if (
    usage?.status === "available" &&
    windowCount > 0 &&
    usage.fetchedAt &&
    Date.parse(usage.fetchedAt) > clearsAt
  )
    return null;
  return capacity.resetsAt
    ? `Account capacity resets at ${capacity.resetsAt}.`
    : "The provider reported exhausted capacity. Refresh usage before starting another agent.";
}
