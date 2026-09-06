import type { ProviderUsageFetcher } from "../provider.js";
import type { ProviderUsage } from "../../../server/messages.js";
import { unavailableUsage } from "../usage.js";

export interface NativeAccountUsageSource {
  usage(accountId: string): Promise<ProviderUsage>;
}

/** Native account controls own credential lookup and refresh through the provider CLI. */
export class NativeAccountUsageFetcher implements ProviderUsageFetcher {
  readonly displayName: string;
  constructor(
    readonly providerId: "claude" | "codex",
    private readonly accounts?: NativeAccountUsageSource,
    private readonly accountId = `default:${providerId}`,
  ) {
    this.displayName = providerId === "claude" ? "Claude" : "Codex";
  }

  async fetchUsage(): Promise<ProviderUsage> {
    if (!this.accounts)
      return unavailableUsage({ providerId: this.providerId, displayName: this.displayName });
    const usage = await this.accounts.usage(this.accountId);
    return { ...usage, providerId: this.providerId, displayName: this.displayName };
  }
}
