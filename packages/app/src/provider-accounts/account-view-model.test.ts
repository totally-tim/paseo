import { expect, test } from "vitest";
import { applicableAccountUsage, continuationAccountChoices } from "./account-view-model";

test("saved accounts become unavailable only after catalog resolution", () => {
  expect(continuationAccountChoices(undefined, "claude", ["saved"])).toEqual({
    accounts: [],
    unavailable: [],
  });
  expect(continuationAccountChoices([], "claude", ["saved"])).toEqual({
    accounts: [],
    unavailable: ["saved"],
  });
});
test("quota for a different model cannot produce an empty available card", () => {
  expect(
    applicableAccountUsage(
      {
        providerId: "codex",
        displayName: "Codex",
        planLabel: null,
        status: "available",
        windows: [
          {
            id: "gpt-5.3-codex-spark:secondary",
            label: "Weekly · GPT-5.3-Codex-Spark",
            usedPct: 10,
          },
        ],
      },
      "gpt-6-astra",
    ),
  ).toBeNull();
});
