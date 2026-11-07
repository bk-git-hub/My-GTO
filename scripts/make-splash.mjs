// Renders the iOS launch images (apple-touch-startup-image) for the installed app into
// public/splash/ and writes their <link> tags into index.html.
// Usage: node scripts/make-splash.mjs  (uses the preinstalled Playwright Chromium)
//
// iOS shows the launch image until the page first paints. The image is the splash's FIRST frame
// (index.html #splash at t = 0: the background before the cards pop in), not its last: a launch
// image of the fanned logo would make the cards collapse back into a stack when the HTML splash
// starts, while the first frame hands over to it without a visible seam.
// iOS reads these when the app is added to the Home Screen: re-add the app to pick up new ones.
// They are not precached (vite.config.ts workbox.globIgnores).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// Playwright is not a project dependency; resolve the globally installed copy.
const { chromium } = createRequire(import.meta.url)("playwright");

// Portrait iPhone screens (CSS px and device pixel ratio).
const DEVICES = [
  { w: 440, h: 956, dpr: 3, note: "16/17 Pro Max" },
  { w: 420, h: 912, dpr: 3, note: "Air" },
  { w: 402, h: 874, dpr: 3, note: "16 Pro, 17, 17 Pro" },
  { w: 430, h: 932, dpr: 3, note: "14 Pro Max, 15 Plus/Pro Max, 16 Plus" },
  { w: 393, h: 852, dpr: 3, note: "14 Pro, 15, 15 Pro, 16" },
  { w: 428, h: 926, dpr: 3, note: "12/13 Pro Max, 14 Plus" },
  { w: 390, h: 844, dpr: 3, note: "12, 13, 14, 12/13 Pro, 16e" },
  { w: 375, h: 812, dpr: 3, note: "X, XS, 11 Pro, 12/13 mini" },
  { w: 414, h: 896, dpr: 3, note: "XS Max, 11 Pro Max" },
  { w: 414, h: 896, dpr: 2, note: "XR, 11" },
  { w: 414, h: 736, dpr: 3, note: "6/7/8 Plus" },
  { w: 375, h: 667, dpr: 2, note: "6/7/8, SE 2/3" },
  { w: 320, h: 568, dpr: 2, note: "SE 1" },
];

const BEGIN = "<!-- splash:startup-images -->";
const END = "<!-- /splash:startup-images -->";

const indexUrl = new URL("../index.html", import.meta.url);
const outDir = new URL("../public/splash/", import.meta.url);
const index = readFileSync(indexUrl, "utf8");
// The page as the browser first paints it, minus the app bundle.
const page0 = index.replace(/<script type="module"[^>]*><\/script>/, "");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const links = [];
for (const d of DEVICES) {
  const px = `${d.w * d.dpr}x${d.h * d.dpr}`;
  const file = `launch-${px}.png`;
  const ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.dpr, colorScheme: "dark", reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  await page.setContent(page0);
  await page.evaluate(() => {
    if (document.documentElement.getAttribute("data-splash") !== "show") throw new Error("splash did not show");
    document.getAnimations().forEach((a) => {
      a.pause();
      a.currentTime = 0;
    });
  });
  await page.screenshot({ path: new URL(file, outDir).pathname });
  await ctx.close();
  links.push(
    `    <link rel="apple-touch-startup-image" media="screen and (device-width: ${d.w}px) and (device-height: ${d.h}px) and (-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: portrait)" href="./splash/${file}" />`,
  );
}
await browser.close();

const a = index.indexOf(BEGIN);
const b = index.indexOf(END);
if (a < 0 || b < a) throw new Error(`index.html needs ${BEGIN} ... ${END}`);
writeFileSync(indexUrl, `${index.slice(0, a + BEGIN.length)}\n${links.join("\n")}\n    ${index.slice(b)}`);
console.log(`launch images written: ${DEVICES.length} in public/splash/, links updated in index.html`);
