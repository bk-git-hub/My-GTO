// Renders public/icons/icon.svg to the PNG sizes the PWA manifest needs.
// Usage: node scripts/make-icons.mjs  (uses the preinstalled Playwright Chromium)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Playwright is not a project dependency; resolve the globally installed copy.
const { chromium } = createRequire(import.meta.url)("playwright");

const svg = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`../public/icons/icon-${size}.png`, import.meta.url).pathname, omitBackground: true });
  await page.close();
}
await browser.close();
console.log("icons written");
