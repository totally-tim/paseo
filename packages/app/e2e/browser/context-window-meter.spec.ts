import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

for (const width of [390, 1280]) {
  test(`context ring paints before hover at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-window-meter-",
      title: "Context ring visibility",
      initialPrompt: "emit 1 coalesced agent stream update for context ring visibility.",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const meter = page.getByTestId("context-window-meter");
      await expect(meter).toBeVisible();
      const circles = meter.locator("circle");
      await expect(circles).toHaveCount(2);
      // A computed stroke alone passes even when an HTML wrapper inside the SVG
      // prevents the circles from participating in the browser's SVG layout.
      for (const circle of await circles.all()) {
        await expect(circle).toBeVisible();
        const bounds = await circle.boundingBox();
        expect(bounds!.width).toBeGreaterThan(0);
        expect(bounds!.height).toBeGreaterThan(0);
        await expect(circle).not.toHaveCSS("stroke", "none");
      }
      await testInfo.attach("Context ring before hover", {
        body: await meter.screenshot(),
        contentType: "image/png",
      });
      await meter.hover();
      await expect(page.getByText("Context window", { exact: true })).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
}
