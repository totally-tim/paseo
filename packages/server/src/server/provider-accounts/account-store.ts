import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  AccountPolicySchema,
  ProviderAccountSchema,
  type AccountPolicy,
  type ProviderAccount,
  type AccountProvider,
} from "@getpaseo/protocol/provider-accounts";
import type { ProviderAccountContext } from "../agent/provider-account-context.js";

const StoreSchema = z.object({
  accounts: z.array(ProviderAccountSchema),
  policy: AccountPolicySchema.nullable(),
});

export class ProviderAccountStore {
  private accounts: ProviderAccount[] = [];
  private policy: AccountPolicy | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();
  readonly directory: string;

  constructor(paseoHome: string) {
    this.directory = path.join(paseoHome, "provider-accounts");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    try {
      const data = StoreSchema.parse(JSON.parse(await fs.readFile(this.metadataPath(), "utf8")));
      this.accounts = data.accounts;
      this.policy = data.policy;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Truncated bytes, or a file a newer daemon wrote, must not stop this one from starting.
      // Keep them for inspection; the accounts are re-added rather than silently overwritten.
      await fs.rename(this.metadataPath(), `${this.metadataPath()}.corrupt-${Date.now()}`);
    }
  }

  list(): ProviderAccount[] {
    return structuredClone(this.accounts);
  }

  get(id: string): ProviderAccount {
    const account = this.accounts.find((entry) => entry.id === id);
    if (!account) throw new Error("Account not found");
    return structuredClone(account);
  }

  getPolicy(): AccountPolicy | null {
    return this.policy ? { ...this.policy } : null;
  }

  context(id: string): ProviderAccountContext | undefined {
    const account = this.get(id);
    if (account.ownership === "external") return undefined;
    // IDs originate here, never from paths supplied by a client.
    if (!/^[a-f0-9-]{36}$/.test(account.id)) throw new Error("Invalid managed account ID");
    return { accountId: id, provider: account.provider, configDir: path.join(this.directory, id) };
  }

  async create(provider: AccountProvider, label: string): Promise<ProviderAccount> {
    const now = new Date().toISOString();
    const account = ProviderAccountSchema.parse({
      id: randomUUID(),
      provider,
      label: label.trim(),
      ownership: "managed",
      enabled: false,
      authState: "signed-out",
      identity: null,
      error: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    await fs.mkdir(path.join(this.directory, account.id), { mode: 0o700 });
    await this.save(account);
    return account;
  }

  async ensureExternal(provider: AccountProvider): Promise<void> {
    if (this.accounts.some((entry) => entry.id === `default:${provider}`)) return;
    const now = new Date().toISOString();
    await this.save({
      id: `default:${provider}`,
      provider,
      label: "Host CLI account",
      ownership: "external",
      enabled: true,
      authState: "unknown",
      identity: null,
      error: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  async save(account: ProviderAccount): Promise<void> {
    const validated = ProviderAccountSchema.parse(account);
    await this.serialize(async () => {
      const next = [...this.accounts.filter((entry) => entry.id !== account.id), validated];
      await this.write({ accounts: next, policy: this.policy });
      this.accounts = next;
    });
  }

  async setPolicy(policy: AccountPolicy): Promise<void> {
    const validated = AccountPolicySchema.parse(policy);
    await this.serialize(async () => {
      await this.write({ accounts: this.accounts, policy: validated });
      this.policy = validated;
    });
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(work, work);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private metadataPath(): string {
    return path.join(this.directory, "accounts.json");
  }

  private async write(data: z.infer<typeof StoreSchema>): Promise<void> {
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.metadataPath());
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
