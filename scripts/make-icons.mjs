// Renders public/icons/icon.svg to the PNG icons the PWA manifest and iOS need.
// Usage: node scripts/make-icons.mjs  (uses the preinstalled Playwright Chromium)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Playwright is not a project dependency; resolve the globally installed copy.
const { chromium } = createRequire(import.meta.url)("playwright");

const svg = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8");

const VARIANTS = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  // Android masks this to a circle or squircle: fill the square, keep the art inside the 80% safe zone.
  { file: "icon-maskable-512.png", size: 512, fullBleed: true, artScale: 0.76 },
  // iOS rounds the corners itself and turns transparent pixels black.
  { file: "apple-touch-icon.png", size: 180, fullBleed: true, artScale: 0.9 },
];

const browser = await chromium.launch();
for (const v of VARIANTS) {
  const page = await browser.newPage({ viewport: { width: v.size, height: v.size } });
  await page.setContent(`<html><body style="margin:0">${svg.replace("<svg ", `<svg width="${v.size}" height="${v.size}" `)}</body></html>`);
  if (v.fullBleed) {
    await page.evaluate((scale) => {
      const bg = document.getElementById("bg");
      const art = document.getElementById("art");
      if (!bg || !art) throw new Error("icon.svg needs #bg and #art");
      bg.setAttribute("rx", "0");
      // The two cards sit slightly below centre; recentre them while scaling.
      art.setAttribute("transform", `translate(256 256) scale(${scale}) translate(-254 -266)`);
    }, v.artScale);
  }
  await page.screenshot({ path: new URL(`../public/icons/${v.file}`, import.meta.url).pathname, omitBackground: true });
  await page.close();
}
await browser.close();
console.log("icons written:", VARIANTS.map((v) => v.file).join(", "));
