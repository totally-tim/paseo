#!/usr/bin/env node
// Generates every Forkeo icon asset from one master glyph.
//
// The mark keeps the Paseo brand tile (black rounded square, white hand-drawn
// stroke) but the stroke forks: a looped trunk splits into two prongs. Run:
//
//   node scripts/fork/generate-icons.mjs
//
// Requires sharp (repo dependency) and, for icon.icns, macOS iconutil.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The glyph on the 700x700 viewBox shared by the logo component and SVG assets.
const GLYPH = `
  <g stroke="white" stroke-width="58" stroke-linecap="round" stroke-linejoin="round" fill="none"
     transform="translate(350 355) rotate(-13) scale(1.28) translate(-350 -350)">
    <path d="M 330 600 C 268 582, 236 528, 250 474 C 262 432, 302 414, 334 430 C 360 443, 370 474, 360 504"/>
    <path d="M 355 505 C 350 470, 346 440, 342 405 C 300 380, 250 330, 238 268 C 228 215, 244 168, 285 142"/>
    <path d="M 342 405 C 395 378, 462 328, 492 262 C 515 212, 540 175, 522 142"/>
  </g>`;

const CORNER = 0.223; // matches the existing tile: rx 156 on 700, ~228 on 1024

function glyphSvg(size, { color = "white", scale = 1 } = {}) {
  const inner = size * scale;
  const offset = (size - inner) / 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(${offset} ${offset}) scale(${inner / 700})">${GLYPH.replaceAll('stroke="white"', `stroke="${color}"`)}</g></svg>`;
}

async function rasterize(svg, size, out) {
  await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toFile(out);
  console.log("wrote", out);
}

function tileFullSvg(size, scale = 0.86) {
  const r = Math.round(size * CORNER);
  const offset = (size * (1 - scale)) / 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="${r}" fill="black"/><g transform="translate(${offset} ${offset}) scale(${(size * scale) / 700})">${GLYPH}</g></svg>`;
}

async function tileIcon(size, out) {
  await rasterize(tileFullSvg(size), size, out);
}

// Favicon variants: black tile, white glyph, optional status badge bottom-right.
function faviconSvg(badge) {
  return `<svg width="48" height="48" viewBox="0 0 700 700" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="700" height="700" rx="156" fill="black"/>
<g transform="translate(350,350) scale(1.05) translate(-350,-350)">${GLYPH}</g>
${badge ? `<circle cx="570" cy="570" r="130" fill="${badge}"/>` : ""}
</svg>`;
}

// Dev icon: blueprint tile — blue gradient, construction grid, inscribed circle.
function devTileSvg(size) {
  const r = Math.round(size * CORNER);
  const step = size / 8;
  let grid = "";
  for (let i = 1; i < 8; i++) {
    const p = Math.round(i * step);
    grid += `<line x1="${p}" y1="0" x2="${p}" y2="${size}" stroke="white" stroke-opacity="0.14" stroke-width="2"/>`;
    grid += `<line x1="0" y1="${p}" x2="${size}" y2="${p}" stroke="white" stroke-opacity="0.14" stroke-width="2"/>`;
  }
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#35A5FF"/><stop offset="1" stop-color="#1C6BF0"/></linearGradient></defs>
<rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
<g>${grid}<circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.38}" fill="none" stroke="white" stroke-opacity="0.3" stroke-width="3"/></g>
<g transform="translate(${size * 0.07} ${size * 0.07}) scale(${(size * 0.86) / 700})">${GLYPH}</g>
</svg>`;
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
await tileIcon(1024, join(appImages, "icon.png"));
await tileIcon(200, join(appImages, "splash-icon.png"));
// Android adaptive foreground: glyph must live inside the center 66% safe zone.
await rasterize(
  glyphSvg(1024, { scale: 0.58 }),
  1024,
  join(appImages, "android-icon-foreground.png"),
);
await rasterize(glyphSvg(96, { scale: 0.82 }), 96, join(appImages, "notification-icon.png"));
await tileIcon(48, join(appImages, "favicon.png"));

for (const [name, badge] of [
  ["favicon-dark", null],
  ["favicon-dark-running", "#3b82f6"],
  ["favicon-dark-attention", "#22c55e"],
  ["favicon-light", null],
  ["favicon-light-running", "#3b82f6"],
  ["favicon-light-attention", "#22c55e"],
]) {
  const svg = faviconSvg(badge);
  writeFileSync(join(appImages, `${name}.svg`), svg + "\n");
  await rasterize(svg, 48, join(appImages, `${name}.png`));
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
await tileIcon(180, join(appPublic, "apple-touch-icon.png"));
await tileIcon(192, join(appPublic, "pwa-icon-192.png"));
await tileIcon(512, join(appPublic, "pwa-icon-512.png"));

// --- Desktop package ---
await tileIcon(512, join(desktopAssets, "icon.png"));
await tileIcon(128, join(desktopAssets, "128x128.png"));
await tileIcon(256, join(desktopAssets, "128x128@2x.png"));
await tileIcon(64, join(desktopAssets, "64x64.png"));
await tileIcon(32, join(desktopAssets, "32x32.png"));
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
  await rasterize(tileFullSvg(px), px, join(iconset, file));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(desktopAssets, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });
console.log("wrote", join(desktopAssets, "icon.icns"));

const icoPngs = {};
for (const size of [16, 32, 48, 256]) {
  icoPngs[size] = await sharp(Buffer.from(tileFullSvg(size), { density: 384 }))
    .png()
    .toBuffer();
}
await writeIco(icoPngs, join(desktopAssets, "icon.ico"));
