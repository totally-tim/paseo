import { describe, expect, it, vi } from "vitest";
import { NativeAccountUsageFetcher } from "./native-account.js";
import type { ProviderUsage } from "../../../server/messages.js";

const usage: ProviderUsage = {
  providerId: "claude",
  displayName: "A",
  status: "available",
  planLabel: null,
  windows: [
    { id: "five_hour", label: "Session", usedPct: 0, resetsAt: null },
    { id: "model:Fable", label: "Weekly · Fable", usedPct: null, resetsAt: null },
  ],
};

describe("native account usage adapter", () => {
  it("reads the exact requested account and preserves zero and unknown windows", async () => {
    const source = { usage: vi.fn(async () => usage) };
    const result = await new NativeAccountUsageFetcher("claude", source, "account-b").fetchUsage();
    expect(source.usage).toHaveBeenCalledExactlyOnceWith("account-b");
    expect(result.windows).toEqual(usage.windows);
  });
  it("never retries a failed account with host credentials", async () => {
    const source = {
      usage: vi.fn(async () => {
        throw new Error("Expired account B");
      }),
    };
    await expect(
      new NativeAccountUsageFetcher("codex", source, "account-b").fetchUsage(),
    ).rejects.toThrow("Expired account B");
    expect(source.usage).toHaveBeenCalledExactlyOnceWith("account-b");
  });
  it("keeps the default account identity explicit for existing clients", async () => {
    const source = { usage: vi.fn(async () => usage) };
    await new NativeAccountUsageFetcher("codex", source).fetchUsage();
    expect(source.usage).toHaveBeenCalledExactlyOnceWith("default:codex");
  });
  it("reports unavailable usage when there is no native account service", async () => {
    const result = await new NativeAccountUsageFetcher("claude").fetchUsage();
    expect(result.status).toBe("unavailable");
    expect(result.windows).toEqual([]);
  });
});
