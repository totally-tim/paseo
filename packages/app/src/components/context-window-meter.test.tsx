/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ContextWindowMeter } from "./context-window-meter";

vi.mock("@/provider-usage/use-provider-usage", () => ({
  useProviderUsage: () => ({ view: null, refresh: async () => {} }),
}));
vi.mock("@/provider-usage/tooltip-section", () => ({ ProviderUsageTooltipSection: () => null }));
vi.mock("react-native-reanimated", async () => {
  const { View } = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    default: { View },
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
  };
});
beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
});

const measuredRequest = {
  inputTokens: 8000,
  cachedInputTokens: 6000,
  outputTokens: 501,
  reasoningTokens: 400,
  firstTokenMs: 800,
  durationMs: 10800,
};
const inputOnlyRequest = { inputTokens: 300 };

describe("context cache reporting", () => {
  it.each([
    [{ cachedInputTokens: 6080 }, "Cached: 6,080 tokens"],
    [{ cachedInputTokens: 0 }, "Cached: 0 tokens"],
    [{}, "Cached: not reported"],
  ])("shows reported, zero, and missing cache counts (%s)", async (lastRequest, text) => {
    const view = render(
      <ContextWindowMeter maxTokens={131072} usedTokens={6500} lastRequest={lastRequest} />,
    );
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(view.getByTestId("context-window-meter"));
    expect((await view.findByText(text)).textContent).toBe(text);
    view.unmount();
  });
  it("derives cache hit and observed speed from one request, including reasoning", async () => {
    const view = render(
      <ContextWindowMeter maxTokens={131072} usedTokens={50000} lastRequest={measuredRequest} />,
    );
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(view.getByTestId("context-window-meter"));
    for (const text of [
      "Cached: 6,000 tokens (75%)",
      "Uncached: 2,000 tokens",
      "Output: 501 tokens",
      "Of which thinking: 400 tokens",
      "First token: 0.8 s",
      "Observed output: ~50 tokens/s",
    ]) {
      expect((await view.findByText(text)).textContent).toBe(text);
    }
    view.unmount();
  });
  it("omits the request section when the provider has not reported a request", () => {
    const view = render(<ContextWindowMeter maxTokens={131072} usedTokens={6500} />);
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(view.getByTestId("context-window-meter"));
    expect(view.queryByText("Last model request")).toBeNull();
    expect(view.queryByText("Cached: not reported")).toBeNull();
    view.unmount();
  });
  it("replaces old measurements when the next request reports only input", async () => {
    const view = render(
      <ContextWindowMeter maxTokens={131072} usedTokens={6500} lastRequest={measuredRequest} />,
    );
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(view.getByTestId("context-window-meter"));
    expect((await view.findByText("Cached: 6,000 tokens (75%)")).textContent).toBe(
      "Cached: 6,000 tokens (75%)",
    );
    view.rerender(
      <ContextWindowMeter maxTokens={131072} usedTokens={6500} lastRequest={inputOnlyRequest} />,
    );
    expect((await view.findByText("Cached: not reported")).textContent).toBe(
      "Cached: not reported",
    );
    expect(view.queryByText("Cached: 6,000 tokens (75%)")).toBeNull();
    expect(view.queryByText("Output: 501 tokens")).toBeNull();
    expect(view.queryByText(/Observed output:/)).toBeNull();
    view.unmount();
  });
  it.each([
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1, firstTokenMs: 0, durationMs: 0 },
    { inputTokens: 10, cachedInputTokens: 20, outputTokens: 5, firstTokenMs: 10, durationMs: 5 },
    { inputTokens: 10, outputTokens: 5, firstTokenMs: Number.NaN, durationMs: 10 },
  ])("does not invent ratios or rates from incomplete or invalid data", (lastRequest) => {
    const view = render(
      <ContextWindowMeter maxTokens={131072} usedTokens={6500} lastRequest={lastRequest} />,
    );
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.focus(view.getByTestId("context-window-meter"));
    expect(view.queryByText(/Cached:.*\([\d.]+%\)/)).toBeNull();
    expect(view.queryByText(/Observed output:/)).toBeNull();
    view.unmount();
  });
});
