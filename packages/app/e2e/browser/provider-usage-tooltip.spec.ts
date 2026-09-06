import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgent(page: Page) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

test.describe("provider usage tooltip", () => {
  test("fetches usage when the context tooltip opens and renders the active provider", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: 42,
                remainingPct: 58,
                resetsAt: "2026-06-19T05:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      expect(usageFixture.requestCount()).toBe(0);

      await page.getByTestId("context-window-meter").hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Mock provider", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Test plan")).toBeVisible();
      await expect(page.getByText("Session", { exact: true })).toBeVisible();
      await expect(page.getByText("42%")).toBeVisible();
      await expect(page.getByText("Last model request", { exact: true })).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });

  test("renders request metrics and a themed context ring at phone width", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await installProviderUsageFixture(
      page,
      [{ fetchedAt: "2026-06-19T00:00:00.000Z", providers: [] }],
      {
        inputTokens: 8000,
        cachedInputTokens: 6000,
        outputTokens: 501,
        reasoningTokens: 400,
        firstTokenMs: 800,
        durationMs: 10800,
      },
    );
    const session = await openMockAgent(page);
    try {
      const meter = page.getByTestId("context-window-meter");
      await meter.hover();
      for (const text of [
        "Last model request",
        "Input: 8,000 tokens",
        "Cached: 6,000 tokens (75%)",
        "Uncached: 2,000 tokens",
        "Output: 501 tokens",
        "Of which thinking: 400 tokens",
        "First token: 0.8 s",
        "Observed output: ~50 tokens/s",
      ]) {
        await expect(page.getByText(text, { exact: true })).toBeVisible();
      }
      const strokes = await meter.locator("circle").evaluateAll((circles) => {
        const values = [];
        for (const circle of circles) values.push(getComputedStyle(circle).stroke);
        return values;
      });
      expect(strokes).toHaveLength(2);
      expect(strokes.every((stroke) => stroke !== "none" && stroke !== "")).toBe(true);
      expect(strokes[0]).not.toBe(strokes[1]);
      const bounds = await page
        .getByText("Cached: 6,000 tokens (75%)", { exact: true })
        .boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    } finally {
      const screenshot = testInfo.outputPath("request-metrics-phone.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("Request metrics at phone width", {
        path: screenshot,
        contentType: "image/png",
      });
      await session.cleanup();
    }
  });

  test("refreshes usage again each time the tooltip is shown", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 64 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const meter = page.getByTestId("context-window-meter");

      await meter.hover();
      await usageFixture.waitForRequestCount(1);
      await expect(page.getByText("41%")).toBeVisible({ timeout: 10_000 });

      await page.mouse.move(0, 0);
      await expect(page.getByText("Mock provider", { exact: true })).toHaveCount(0);

      await meter.hover();
      await usageFixture.waitForRequestCount(2);
      expect(usageFixture.requestCount()).toBe(2);
      await expect(page.getByText("64%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
