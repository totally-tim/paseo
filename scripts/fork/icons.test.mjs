import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

async function pixels(file) {
  const source = fileURLToPath(new URL(file, root));
  return sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function whiteBounds({ data, info }) {
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let radius = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      const isWhite = data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200;
      if (data[i + 3] > 200 && isWhite) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        radius = Math.max(radius, Math.hypot(x - info.width / 2, y - info.height / 2));
      }
    }
  }
  return { minX, minY, maxX, maxY, radius: radius / info.width };
}

describe("Forkeo generated icons", () => {
  it.each(["dark", "light", "dark-running", "light-running", "dark-attention", "light-attention"])(
    "keeps the %s favicon stroke clear of every edge, including at 16px",
    async (variant) => {
      const file = `packages/app/assets/images/favicon-${variant}.png`;
      const image = await pixels(file);
      const bounds = whiteBounds(image);
      expect(bounds.minX).toBeGreaterThanOrEqual(2);
      expect(bounds.minY).toBeGreaterThanOrEqual(2);
      expect(bounds.maxX).toBeLessThan(image.info.width - 2);
      expect(bounds.maxY).toBeLessThan(image.info.height - 2);
      const small = await sharp(fileURLToPath(new URL(file, root)))
        .resize(16, 16)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const smallBounds = whiteBounds(small);
      expect(smallBounds.maxX).toBeGreaterThan(smallBounds.minX);
      expect(smallBounds.minY).toBeGreaterThan(0);
      expect(smallBounds.maxY).toBeLessThan(15);
    },
  );

  it("preserves the desktop tile's outer transparent inset", async () => {
    const { data, info } = await pixels("packages/desktop/assets/icon.png");
    const row = info.height / 2;
    const alpha = (x) => data[(row * info.width + x) * 4 + 3];
    expect(alpha(0)).toBe(0);
    expect(alpha(25)).toBe(0);
    expect(alpha(35)).toBe(255);
    expect(alpha(info.width - 26)).toBe(0);
  });

  it.each([
    ["packages/app/assets/images/icon.png", 0.4],
    ["packages/app/public/pwa-icon-192.png", 0.4],
    ["packages/app/public/pwa-icon-512.png", 0.4],
  ])("exports an opaque, mask-safe mobile tile: %s", async (file, safeRadius) => {
    const image = await pixels(file);
    const alphas = image.data.filter((_value, index) => index % 4 === 3);
    expect(alphas.every((value) => value === 255)).toBe(true);
    expect(whiteBounds(image).radius).toBeLessThan(safeRadius);
  });

  it("fits the Android foreground inside its adaptive safe circle", async () => {
    const image = await pixels("packages/app/assets/images/android-icon-foreground.png");
    expect(whiteBounds(image).radius).toBeLessThan(0.33);
  });

  it("stores each Windows icon at its declared dimensions", async () => {
    const ico = readFileSync(new URL("packages/desktop/assets/icon.ico", root));
    expect(ico.readUInt16LE(4)).toBe(4);
    for (let i = 0; i < 4; i++) {
      const entry = 6 + i * 16;
      const size = ico[entry] || 256;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      const metadata = await sharp(ico.subarray(offset, offset + length)).metadata();
      expect([metadata.width, metadata.height]).toEqual([size, size]);
    }
  });
});
