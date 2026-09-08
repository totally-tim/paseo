import { describe, expect, it } from "vitest";
import { ProviderEventSchema } from "./provider.js";

describe("provider request usage", () => {
  it("preserves measured zero and optional per-request fields at the plugin boundary", () => {
    const event = {
      type: "session.usage",
      sessionId: "session-1",
      usage: {
        inputTokens: 20000,
        lastRequest: {
          inputTokens: 1000,
          cachedInputTokens: 0,
          outputTokens: 60,
          reasoningTokens: 40,
          firstTokenMs: 100,
          durationMs: 800,
        },
      },
    };
    expect(ProviderEventSchema.parse(event)).toEqual(event);
  });

  it("accepts older providers and an empty request without filling absent measurements", () => {
    for (const usage of [{ inputTokens: 1000 }, { lastRequest: {} }]) {
      const event = { type: "session.usage", sessionId: "session-1", usage };
      expect(ProviderEventSchema.parse(event)).toEqual(event);
    }
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid request measurements (%s)",
    (inputTokens) => {
      expect(
        ProviderEventSchema.safeParse({
          type: "session.usage",
          sessionId: "session-1",
          usage: { lastRequest: { inputTokens } },
        }).success,
      ).toBe(false);
    },
  );
});
