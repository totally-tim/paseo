#!/usr/bin/env node
// Generates every Forkeo icon asset from one master glyph.
//
// The mark keeps the Paseo brand tile (black rounded square, white hand-drawn
// stroke), with an open f-shaped stem and one sweeping branch. Run:
//
//   node scripts/fork/generate-icons.mjs
//
// Requires sharp (repo dependency) and, for icon.icns, macOS iconutil.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Shared directly with PaseoLogo; changes here cannot leave the in-app mark behind.
const master = JSON.parse(
  readFileSync(join(root, "packages/app/assets/images/forkeo-glyph.json"), "utf8"),
);
const GLYPH = `<g stroke="white" stroke-width="${master.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" fill="none">${master.paths.map((d) => `<path d="${d}"/>`).join("")}</g>`;
const CORNER = 0.223;

function glyphGroup(size, { color = "white", scale = 1 } = {}) {
  const inner = size * scale;
  const offset = (size - inner) / 2;
  return `<g transform="translate(${offset} ${offset}) scale(${inner / master.size})">${GLYPH.replaceAll('stroke="white"', `stroke="${color}"`)}</g>`;
}

function svg(size, content) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
}

async function rasterize(source, size, out) {
  await sharp(Buffer.from(source), { density: 384 }).resize(size, size).png().toFile(out);
  console.log("wrote", out);
}

function tileSvg(size, { padding = 0, rounded = true, glyphScale = 1.1 } = {}) {
  const inset = size * padding;
  const side = size - inset * 2;
  const radius = rounded ? side * CORNER : 0;
  return svg(
    size,
    `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${radius}" fill="black"/>${glyphGroup(size, { scale: (side / size) * glyphScale })}`,
  );
}

async function tileIcon(size, out, options) {
  await rasterize(tileSvg(size, options), size, out);
}

function faviconSvg(badge) {
  const badgeCircle = badge ? `<circle cx="570" cy="570" r="130" fill="${badge}"/>` : "";
  return tileSvg(700, { glyphScale: 1.16 }).replace("</svg>", `${badgeCircle}</svg>`);
}

function devTileSvg(size) {
  const tile = `<rect x="42" y="42" width="616" height="616" rx="${616 * CORNER}"/>`;
  let grid = "";
  for (let i = 1; i < 8; i++) {
    const p = (700 / 8) * i;
    grid += `<path d="M ${p} 0 V 700 M 0 ${p} H 700" stroke="white" stroke-opacity="0.14" stroke-width="1"/>`;
  }
  return svg(
    700,
    `<defs><linearGradient id="blueprint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#35A5FF"/><stop offset="1" stop-color="#1C6BF0"/></linearGradient><clipPath id="tile">${tile}</clipPath></defs><g clip-path="url(#tile)"><rect width="700" height="700" fill="url(#blueprint)"/>${grid}<circle cx="350" cy="350" r="266" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="2"/></g>${glyphGroup(700, { scale: 0.968 })}`,
  ).replace('width="700" height="700" viewBox', `width="${size}" height="${size}" viewBox`);
}

async function writeIco(pngBySize, out) {
  const sizes = Object.keys(pngBySize)
    .map(Number)
    .sort((a, b) => a - b);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + sizes.length * 16;
  const entries = [];
  for (const size of sizes) {
    const png = pngBySize[size];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  writeFileSync(out, Buffer.concat([header, ...entries, ...sizes.map((s) => pngBySize[s])]));
  console.log("wrote", out);
}

const appImages = join(root, "packages/app/assets/images");
const appPublic = join(root, "packages/app/public");
const desktopAssets = join(root, "packages/desktop/assets");

// --- App package ---
// iOS supplies the corner mask; transparent corners would be flattened to white.
await tileIcon(1024, join(appImages, "icon.png"), { rounded: false });
await tileIcon(200, join(appImages, "splash-icon.png"));
// Android adaptive foreground: glyph must live inside the center 66% safe zone.
await rasterize(
  svg(1024, glyphGroup(1024, { scale: 0.86 })),
  1024,
  join(appImages, "android-icon-foreground.png"),
);
await rasterize(
  svg(96, glyphGroup(96, { scale: 1.1 })),
  96,
  join(appImages, "notification-icon.png"),
);
await tileIcon(48, join(appImages, "favicon.png"));

for (const [name, badge] of [
  ["favicon-dark", null],
  ["favicon-dark-running", "#3b82f6"],
  ["favicon-dark-attention", "#22c55e"],
  ["favicon-light", null],
  ["favicon-light-running", "#3b82f6"],
  ["favicon-light-attention", "#22c55e"],
]) {
  const source = faviconSvg(badge);
  writeFileSync(join(appImages, `${name}.svg`), source + "\n");
  await rasterize(source, 48, join(appImages, `${name}.png`));
  console.log("wrote", join(appImages, `${name}.{svg,png}`));
}

// Brand glyphs (kept filenames; referenced outside the app).
writeFileSync(
  join(appImages, "butterfly-white.svg"),
  `<svg width="700" height="700" viewBox="0 0 700 700" fill="none" xmlns="http://www.w3.org/2000/svg">${GLYPH}</svg>\n`,
);
writeFileSync(
  join(appImages, "butterfly-green.svg"),
  `<svg width="700" height="700" viewBox="0 0 700 700" fill="none" xmlns="http://www.w3.org/2000/svg">${GLYPH.replaceAll('stroke="white"', 'stroke="#20744A"')}</svg>\n`,
);
console.log("wrote butterfly-{white,green}.svg");

// --- Web/PWA icons ---
await tileIcon(180, join(appPublic, "apple-touch-icon.png"), { rounded: false });
await tileIcon(192, join(appPublic, "pwa-icon-192.png"), { rounded: false });
await tileIcon(512, join(appPublic, "pwa-icon-512.png"), { rounded: false });

// --- Desktop package ---
await tileIcon(512, join(desktopAssets, "icon.png"), { padding: 0.06 });
await tileIcon(128, join(desktopAssets, "128x128.png"), { padding: 0.06 });
await tileIcon(256, join(desktopAssets, "128x128@2x.png"), { padding: 0.06 });
await tileIcon(64, join(desktopAssets, "64x64.png"), { padding: 0.06 });
await tileIcon(32, join(desktopAssets, "32x32.png"), { padding: 0.06 });
await rasterize(devTileSvg(1254), 1254, join(desktopAssets, "icon-dev.png"));

const iconset = join(desktopAssets, "icon.iconset");
mkdirSync(iconset, { recursive: true });
for (const [file, px] of [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
]) {
  await rasterize(tileSvg(px, { padding: 0.06 }), px, join(iconset, file));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(desktopAssets, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });
console.log("wrote", join(desktopAssets, "icon.icns"));

const icoPngs = {};
for (const size of [16, 32, 48, 256]) {
  icoPngs[size] = await sharp(Buffer.from(tileSvg(size)), { density: 384 })
    .resize(size, size)
    .png()
    .toBuffer();
}
await writeIco(icoPngs, join(desktopAssets, "icon.ico"));
