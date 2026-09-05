import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderAccount,
  ProviderAccountIdentity,
} from "@getpaseo/protocol/provider-accounts";
import type { ProviderUsage } from "../messages.js";
import type { AccountBackend } from "./account-service.js";
import type { ProviderAccountContext } from "../agent/provider-account-context.js";
import {
  createProviderEnv,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../agent/provider-launch-config.js";
import { execCommand, spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { claudeQuery } from "../agent/providers/claude/query.js";
import { CodexAppServerClient } from "../agent/providers/codex/app-server-transport.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import { normalizeClaudeAccountUsage, normalizeCodexAccountUsage } from "./quota-normalization.js";

const CONTROL_TIMEOUT_MS = 20_000;

const ClaudeAuthSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  email: z.string().nullish(),
  orgId: z.string().nullish(),
  orgName: z.string().nullish(),
  subscriptionType: z.string().nullish(),
});
const CodexAccountSchema = z.object({
  account: z
    .object({ type: z.string(), email: z.string().nullish(), planType: z.string().optional() })
    .nullable(),
});
const CodexLoginSchema = z.object({
  type: z.literal("chatgptDeviceCode"),
  loginId: z.string(),
  verificationUrl: z.url(),
  userCode: z.string(),
});

function identity(
  provider: string,
  email: string,
  organization?: string | null,
  plan?: string | null,
): ProviderAccountIdentity {
  return {
    key: `${provider}:${email.trim().toLowerCase()}:${organization ?? ""}`,
    email,
    ...(organization ? { organization } : {}),
    ...(plan ? { plan } : {}),
  };
}

function validateLoginUrl(value: string, provider: "claude" | "codex"): string {
  const url = new URL(value);
  const hosts =
    provider === "claude"
      ? [
          "claude.ai",
          "claude.com",
          "platform.claude.com",
          "console.anthropic.com",
          "auth.anthropic.com",
        ]
      : ["auth.openai.com", "chatgpt.com"];
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password)
    throw new Error("Provider returned an unsupported login URL.");
  return url.href;
}

interface BackendOptions {
  account: ProviderAccount;
  context?: ProviderAccountContext;
  runtimeSettings?: ProviderRuntimeSettings;
  logger: Logger;
  managedProcesses?: ManagedProcessRegistry;
}

export function createAccountBackend(options: BackendOptions): AccountBackend {
  return options.account.provider === "claude"
    ? new ClaudeAccountBackend(options)
    : new CodexAccountBackend(options);
}

class ProviderAccountBackend {
  protected readonly settings: ProviderRuntimeSettings;
  constructor(protected readonly options: BackendOptions) {
    this.settings = { ...options.runtimeSettings, accountContext: options.context };
  }

  protected async launch(
    args: string[],
  ): Promise<{ child: ChildProcessWithoutNullStreams; dispose: () => Promise<void> }> {
    const launch = await resolveProviderLaunch({
      commandConfig: this.settings.command,
      defaultBinary: this.options.account.provider,
    });
    const command = (await findExecutable(launch.command)) ?? launch.command;
    const allArgs = [...launch.args, ...args];
    const child = spawnProcess(command, allArgs, {
      cwd: this.options.context?.configDir,
      ...createProviderEnvSpec({ runtimeSettings: this.settings, overlays: [{ BROWSER: "echo" }] }),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let recordId: string | undefined;
    let exited = false;
    // Own the process before readiness, including spawn and ledger-write failure.
    child.once("error", () => {
      exited = true;
    });
    child.once("exit", () => {
      exited = true;
    });
    const dispose = async () => {
      const result = await terminateWithTreeKill(child, {
        gracefulTimeoutMs: 2_000,
        forceTimeoutMs: 1_000,
      });
      if (result === "kill-timeout")
        throw new Error("Account helper shutdown was not acknowledged.");
      if (recordId) await this.options.managedProcesses?.remove(recordId);
    };
    try {
      if (!child.stdin || !child.stdout || !child.stderr)
        throw new Error("Provider login has no standard streams.");
      if (child.pid && this.options.managedProcesses) {
        const record = await this.options.managedProcesses.record({
          owner: { provider: this.options.account.provider, kind: "account-helper" },
          pid: child.pid,
          command,
          args: allArgs,
          metadata: { accountId: this.options.account.id },
        });
        recordId = record.id;
      }
      if (exited) throw new Error("Provider helper exited during startup.");
      return { child: child as ChildProcessWithoutNullStreams, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}

class ClaudeAccountBackend extends ProviderAccountBackend implements AccountBackend {
  async inspect(): Promise<ProviderAccountIdentity | null> {
    const launch = await resolveProviderLaunch({
      commandConfig: this.settings.command,
      defaultBinary: "claude",
    });
    let stdout: string;
    try {
      ({ stdout } = await execCommand(
        launch.command,
        [...launch.args, "auth", "status", "--json"],
        {
          ...createProviderEnvSpec({ runtimeSettings: this.settings }),
          timeout: CONTROL_TIMEOUT_MS,
          maxBuffer: 32_768,
        },
      ));
    } catch (error) {
      // `auth status` exits 1 when signed out; only parse its documented JSON result.
      const result = z.object({ stdout: z.string() }).safeParse(error);
      if (!result.success) {
        // Provider process errors may contain credentials in stdout/stderr. Keep them out of error causes.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Could not inspect Claude authentication.");
      }
      stdout = result.data.stdout;
    }
    const auth = ClaudeAuthSchema.parse(JSON.parse(stdout));
    return auth.loggedIn && auth.authMethod === "claude.ai" && auth.email
      ? identity("claude", auth.email, auth.orgId, auth.subscriptionType)
      : null;
  }

  async login(input: Parameters<AccountBackend["login"]>[0]): Promise<ProviderAccountIdentity> {
    const { child, dispose } = await this.launch(["auth", "login", "--claudeai"]);
    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        const abort = () => reject(new Error("Login canceled."));
        input.signal.addEventListener("abort", abort, { once: true });
        if (input.signal.aborted) abort();
        const onData = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString("utf8")).slice(-32_768);
          const match = buffer
            .replaceAll(String.fromCharCode(27), " ")
            .match(/https:\/\/[^\s]+(?=\s)/);
          if (!match) return;
          try {
            const url = validateLoginUrl(match[0], "claude");
            input.onChallenge({ kind: "browser", url, acceptsCode: true });
          } catch {
            reject(new Error("Claude returned an unsupported login URL."));
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        input.onSubmitCode((code) => {
          child.stdin.write(`${code}\n`);
        });
        child.once("error", () => reject(new Error("Claude login could not start.")));
        child.once("exit", (code) => {
          input.signal.removeEventListener("abort", abort);
          if (code === 0) resolve();
          else reject(new Error("Claude login did not complete."));
        });
      });
      input.signal.throwIfAborted();
      const account = await this.inspect();
      if (!account)
        throw new Error("Claude did not report an authenticated subscription identity.");
      return account;
    } finally {
      await dispose();
    }
  }

  async logout(): Promise<void> {
    const launch = await resolveProviderLaunch({
      commandConfig: this.settings.command,
      defaultBinary: "claude",
    });
    try {
      await execCommand(launch.command, [...launch.args, "auth", "logout"], {
        ...createProviderEnvSpec({ runtimeSettings: this.settings }),
        timeout: CONTROL_TIMEOUT_MS,
      });
    } catch {
      throw new Error("Claude sign-out failed.");
    }
  }

  async usage(): Promise<ProviderUsage> {
    const binary = await findExecutable("claude");
    if (!binary) throw new Error("Claude Code is not installed.");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CONTROL_TIMEOUT_MS);
    let child: ChildProcess | undefined;
    let processRecord: Promise<string | undefined> = Promise.resolve(undefined);
    const query = claudeQuery(
      {
        prompt: {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<never>>((resolve) => {
                  if (abort.signal.aborted) resolve({ done: true, value: undefined });
                  else
                    abort.signal.addEventListener(
                      "abort",
                      () => resolve({ done: true, value: undefined }),
                      { once: true },
                    );
                }),
            };
          },
        },
        options: {
          pathToClaudeCodeExecutable: binary,
          cwd: this.options.context?.configDir,
          env: createProviderEnv({ runtimeSettings: this.settings }),
          abortController: abort,
          persistSession: false,
          settingSources: ["user"],
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
        },
      },
      {
        runtimeSettings: this.settings,
        onChildProcess: (spawned) => {
          child = spawned;
          if (spawned.pid && this.options.managedProcesses) {
            processRecord = this.options.managedProcesses
              .record({
                owner: { provider: "claude", kind: "account-helper" },
                pid: spawned.pid,
                command: binary,
                args: [],
                metadata: { accountId: this.options.account.id },
              })
              .then((record) => record.id);
            void processRecord.catch(() => abort.abort());
          }
        },
      },
    );
    try {
      // This provider control is experimental in SDK 0.3.246. Unsupported binaries return
      // unavailable through the account service; never fall back to another identity's token.
      const result = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      return normalizeClaudeAccountUsage(this.options.account.label, result);
    } finally {
      clearTimeout(timer);
      abort.abort();
      query.close();
      if (child) {
        const result = await terminateWithTreeKill(child, {
          gracefulTimeoutMs: 2_000,
          forceTimeoutMs: 1_000,
        });
        const recordId = await processRecord;
        if (result !== "kill-timeout" && recordId)
          await this.options.managedProcesses?.remove(recordId);
      }
    }
  }
}

class CodexAccountBackend extends ProviderAccountBackend implements AccountBackend {
  private async withClient<T>(operation: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const args = ["app-server"];
    if (this.options.context) args.push("-c", 'cli_auth_credentials_store="file"');
    const { child, dispose } = await this.launch(args);
    // The ordinary transport traces RPC payloads. Auth helpers must never log those payloads.
    const client = new CodexAppServerClient(
      child,
      this.options.logger.child({}, { level: "silent" }),
    );
    try {
      await client.request(
        "initialize",
        {
          clientInfo: { name: "paseo", version: "0.7.2" },
          capabilities: { experimentalApi: true },
        },
        CONTROL_TIMEOUT_MS,
      );
      client.notify("initialized", {});
      return await operation(client);
    } finally {
      await client.dispose();
      await dispose();
    }
  }

  private async readIdentity(
    client: CodexAppServerClient,
  ): Promise<ProviderAccountIdentity | null> {
    const { account } = CodexAccountSchema.parse(
      await client.request("account/read", { refreshToken: false }, CONTROL_TIMEOUT_MS),
    );
    return account?.type === "chatgpt" && account.email
      ? identity("codex", account.email, null, account.planType)
      : null;
  }

  inspect(): Promise<ProviderAccountIdentity | null> {
    return this.withClient((client) => this.readIdentity(client));
  }

  login(input: Parameters<AccountBackend["login"]>[0]): Promise<ProviderAccountIdentity> {
    return this.withClient(async (client) => {
      let finish: (value: unknown) => void = () => undefined;
      const completed = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      client.setUnexpectedTerminationHandler(() => finish({ loginId: null, success: false }));
      client.setNotificationHandler((method, params) => {
        if (method === "account/login/completed") finish(params);
      });
      const result = CodexLoginSchema.parse(
        await client.request(
          "account/login/start",
          { type: "chatgptDeviceCode" },
          CONTROL_TIMEOUT_MS,
        ),
      );
      input.onChallenge({
        kind: "device",
        url: validateLoginUrl(result.verificationUrl, "codex"),
        userCode: result.userCode,
      });
      const abort = () => finish({ loginId: result.loginId, success: false });
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      try {
        const status = z
          .object({ loginId: z.string().nullable(), success: z.boolean() })
          .parse(await completed);
        if (input.signal.aborted)
          await client
            .request("account/login/cancel", { loginId: result.loginId }, 2_000)
            .catch(() => undefined);
        if (!status.success || status.loginId !== result.loginId || input.signal.aborted)
          throw new Error("Codex login did not complete.");
        const account = await this.readIdentity(client);
        if (!account)
          throw new Error("Codex did not report an authenticated subscription identity.");
        return account;
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    });
  }

  async logout(): Promise<void> {
    await this.withClient(async (client) => {
      await client.request("account/logout", {}, CONTROL_TIMEOUT_MS);
    });
  }

  usage(): Promise<ProviderUsage> {
    return this.withClient(async (client) => {
      const result = await client.request("account/rateLimits/read", {}, CONTROL_TIMEOUT_MS);
      return normalizeCodexAccountUsage(this.options.account.label, result);
    });
  }
}
