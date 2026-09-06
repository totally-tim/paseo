import { expect, it } from "vitest";
import type { ProviderUsage } from "@/provider-usage/types";
import { accountUsageSummary } from "./selection-summary";

const usage: ProviderUsage = {
  providerId: "claude",
  displayName: "Account",
  status: "available",
  planLabel: null,
  windows: [
    { id: "five_hour", label: "Session", usedPct: 49, resetsAt: null },
    { id: "seven_day", label: "Weekly", usedPct: 23, resetsAt: null },
  ],
};

it("shows both reported windows as usage rather than remaining capacity", () => {
  expect(accountUsageSummary(usage)).toBe("5h 49% used · Weekly 23% used");
});

it("keeps a missing reading distinct from zero usage", () => {
  expect(accountUsageSummary(undefined)).toBeNull();
  expect(accountUsageSummary({ ...usage, windows: [] })).toBeNull();
  expect(
    accountUsageSummary({ ...usage, windows: [{ ...usage.windows[0], usedPct: null }] }),
  ).toBeNull();
  expect(accountUsageSummary({ ...usage, windows: [{ ...usage.windows[0], usedPct: 0 }] })).toBe(
    "5h 0% used",
  );
});

it("uses the Codex window duration and preserves model-specific limits", () => {
  expect(
    accountUsageSummary({
      ...usage,
      providerId: "codex",
      windows: [{ id: "primary", label: "5-hour window", usedPct: 20, resetsAt: null }],
    }),
  ).toBe("5h 20% used");
  expect(
    accountUsageSummary({
      ...usage,
      windows: [
        ...usage.windows,
        { id: "seven_day_opus", label: "Weekly · Opus", usedPct: 100, resetsAt: null },
      ],
    }),
  ).toContain("Weekly · Opus 100% used");
});
