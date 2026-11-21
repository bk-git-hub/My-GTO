// End-to-end check of the solver packs on the data branch (docs/solver-packs.md "Data branch", "Offline"): a production
// build of the app, the would-be packs-data branch served by a local static server standing in for the CDN, and
// Chromium at phone size with service workers allowed.
//
//   1. the spot picker lists the catalog's packs and planned packs;
//   2. several spots open (55bb SRP, 35bb 3-bet pot, 100bb, an earlier pack), every data file coming from
//      https://cdn.jsdelivr.net/gh/<repo>@<commit>/... (routed to the stand-in), one pack's files through the
//      raw.githubusercontent.com fallback (jsDelivr refuses them);
//   3. the browser goes offline and the page reloads: the service worker serves the app, the pack cache the last
//      pointer, catalog, index and the flop viewed; a flop never viewed says it can't be loaded;
//   4. a fresh device with both CDNs down lists the packs bundled with the app, flagged, and opens one from our origin.
//
// Usage (Playwright is not a project dependency; use a global install):
//   NODE_PATH=$(npm root -g) node tests/e2e/solver-packs.e2e.cjs --dist <vite build dir> --data <branch dir> --shots <dir>
// (PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS is set below: once the service worker controls the page, Chromium
// sends the page's fetches through it, and Playwright routes them only with that flag.)
//   <branch dir> holds packs/manifest.json, the indexes and the flop files (the data branch's content, e.g. the output
//   of scripts/packs-migrate.mjs plus a scratch presolve run, merged with presolve.mjs --rebuild-manifest).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";
const { chromium } = require("playwright");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), [])
    .map(([k, v]) => [k, v]),
);
for (const k of ["dist", "data", "shots"]) if (!args[k]) throw new Error(`--${k} is required`);
const DIST = path.resolve(args.dist);
const DATA = path.resolve(args.data);
const SHOTS = path.resolve(args.shots);
const COMMIT = args.commit ?? "0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e";
const REPO = "bk-git-hub/My-GTO";
fs.mkdirSync(SHOTS, { recursive: true });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

/** A static file server; `extra(urlPath)` may answer first. Every path asked is recorded in `seen`. */
function serve(root, extra, seen = []) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    seen.push(urlPath);
    const hit = extra?.(urlPath);
    if (hit) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      return res.end(hit);
    }
    let file = path.join(root, urlPath);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

(async () => {
  const catalogBytes = fs.readFileSync(path.join(DATA, "packs/manifest.json"));
  const pointer = {
    v: 2,
    repo: REPO,
    commit: COMMIT,
    dir: "packs/",
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    catalog: { path: "manifest.json", sha256: crypto.createHash("sha256").update(catalogBytes).digest("hex"), bytes: catalogBytes.length },
  };
  const app = await serve(DIST, (p) => (p === "/packs/data.json" ? JSON.stringify(pointer) : null));
  const cdn = await serve(DATA);
  const origin = `http://127.0.0.1:${app.port}`;
  console.log(`app ${origin}, stand-in CDN http://127.0.0.1:${cdn.port}, pointer ${COMMIT.slice(0, 12)}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, serviceWorkers: "allow", locale: "ko-KR" });
  const hits = { jsdelivr: [], raw: [], refused: [] };
  let offline = false; // the device has no network: every CDN request fails
  const standIn = async (route, rest, list) => {
    if (offline) return route.abort("internetdisconnected");
    list.push(rest);
    const res = await fetch(`http://127.0.0.1:${cdn.port}/${rest}`);
    await route.fulfill({ status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
  };
  const jsd = new RegExp(`^https://cdn\\.jsdelivr\\.net/gh/${REPO}@${COMMIT}/(.+)$`);
  const raw = new RegExp(`^https://raw\\.githubusercontent\\.com/${REPO}/${COMMIT}/(.+)$`);
  // jsDelivr stands in for every file but the 35bb blind 3-bet pot's, which only raw.githubusercontent.com serves.
  await context.route(jsd, (route) => {
    const rest = jsd.exec(route.request().url())[1];
    if (offline) return route.abort("internetdisconnected");
    if (rest.startsWith("packs/sv-3bp-bb-btn-35/")) {
      hits.refused.push(rest);
      return route.fulfill({ status: 503, body: "unavailable" });
    }
    return standIn(route, rest, hits.jsdelivr);
  });
  await context.route(raw, (route) => standIn(route, raw.exec(route.request().url())[1], hits.raw));

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const go = async (hash) => {
    await page.evaluate((h) => (location.hash = h), hash);
  };

  await page.goto(`${origin}/#solver`);
  await page.waitForSelector("text=계산된 헤즈업 플랍 전략이에요", { timeout: 30000 });
  await page.waitForSelector("#splash", { state: "detached", timeout: 15000 }).catch(() => undefined); // the launch splash
  await page.waitForTimeout(600);
  await shot("01-picker-55-srp");
  const rows = await page.locator(".sv-spot").count();
  check("picker shows five single-raised-pot rows at 55bb", rows === 5, `${rows} rows`);
  check("each row shows its flop count", (await page.locator("text=플랍 1/1,755").count()) === 5);

  // 55bb SRP: the BTN opens, the BB calls.
  await page.click("text=BTN 오픈 · BB 콜");
  await page.waitForSelector("text=전체 평균", { timeout: 20000 });
  await shot("02-report-sv-srp-btn-bb-55");
  await page.click(".sv-open >> nth=0");
  await page.waitForSelector(".sv-cell", { timeout: 20000 });
  await page.waitForTimeout(300);
  await shot("03-flop-sv-srp-btn-bb-55");
  const viewedHash = await page.evaluate(() => location.hash);
  check("55bb BTN vs BB flop opens", /^#solver\/sv-srp-btn-bb-55\/[2-9TJQKAshdc]{6}/.test(viewedHash), viewedHash);

  // 35bb, 3-bet pot: the BB 3-bets the BTN (through the raw.githubusercontent.com fallback).
  await go("#solver");
  await page.waitForSelector(".sv-spot");
  await page.click("button:has-text('35bb')");
  await page.click("button:has-text('3벳 팟')");
  await page.waitForTimeout(200);
  await shot("04-picker-35-3bp");
  await page.click("text=BB 3벳 · BTN 콜");
  await page.waitForSelector("text=전체 평균", { timeout: 20000 });
  await page.click(".sv-open >> nth=0");
  await page.waitForSelector(".sv-cell", { timeout: 20000 });
  await page.waitForTimeout(300);
  await shot("05-flop-sv-3bp-bb-btn-35-via-raw");
  check("the 35bb blind 3-bet pot came through raw.githubusercontent.com", hits.refused.length > 0 && hits.raw.some((r) => r.startsWith("packs/sv-3bp-bb-btn-35/")), `${hits.raw.length} raw files`);

  // 100bb: a planned pack is 준비 중; the SB's 3-bet is not solved in the stand-in.
  await go("#solver");
  await page.waitForSelector(".sv-spot");
  await page.click("button:has-text('100bb')");
  await page.waitForTimeout(200);
  await shot("06-picker-100-3bp-planned");
  check("a planned pack shows 준비 중", (await page.locator(".sv-spot.off >> text=준비 중").count()) >= 1);
  await page.click("text=BTN 3벳 · CO 콜");
  await page.waitForSelector("text=전체 평균", { timeout: 20000 });
  await shot("07-report-sv-3bp-btn-co-100");

  // An earlier pack (folded under 다른 팩), its index and a flop from the data branch.
  await go("#solver");
  await page.waitForSelector(".sv-others");
  await page.click("summary:has-text('다른 팩')");
  await page.waitForTimeout(200);
  await shot("08-picker-other-packs");
  await page.click("text=UTG vs BB 싱글 레이즈드 팟");
  await page.waitForSelector("text=전체 평균", { timeout: 30000 });
  await shot("09-report-pub-srp-utg-bb-55");
  // From either CDN: after jsDelivr refused two files it is tried last for the rest of the session.
  check("an earlier pack's index came from the data branch", [...hits.jsdelivr, ...hits.raw].some((r) => /^packs\/pub-srp-utg-bb-55\/v1\/index-[0-9a-f]{16}\.json$/.test(r)));

  const bundled = app.seen.filter((p) => p.startsWith("/packs/") && p !== "/packs/data.json");
  check("every data file came from the CDN pinned to the commit, none from the bundled copy", hits.jsdelivr.length + hits.raw.length > 0 && bundled.length === 0, bundled.slice(0, 3).join(", "));
  const swReady = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active && !!navigator.serviceWorker.controller;
  });
  check("a service worker controls the page", swReady);

  // Offline: no network at all (the app's own server is gone too, and the CDN refuses). The page reloads: the worker
  // serves the app from its precache, the pack cache the last pointer, catalog, index and the flop viewed.
  offline = true;
  await new Promise((r) => app.server.close(r));
  app.server.closeAllConnections?.();
  await context.setOffline(true);
  await page.goto("about:blank"); // a real reload: going to the same document with another hash would not reload it
  await page.goto(`${origin}/${viewedHash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sv-cell", { timeout: 30000 });
  await page.waitForTimeout(500);
  await shot("10-offline-viewed-flop");
  check("offline: the viewed flop reopens", (await page.locator(".sv-cell").count()) >= 169);
  check("offline: the banner says so", (await page.locator("text=오프라인 · 열어 본 플랍만 볼 수 있어요").count()) === 1);
  await go("#solver/sv-srp-btn-bb-55");
  await page.waitForSelector("text=전체 평균", { timeout: 20000 });
  await go("#solver/sv-srp-hj-bb-55");
  await page.waitForSelector(".sv-msg", { timeout: 20000 });
  await page.waitForTimeout(300);
  await shot("11-offline-pack-never-opened");
  check("offline: a pack never opened can't be loaded", (await page.locator("text=팩을 불러오지 못했어요").count()) === 1);
  await context.setOffline(false);

  // A fresh device while both CDNs are down (our origin up): the packs bundled with the app are listed instead, flagged,
  // and one opens from our origin.
  const app2 = await serve(DIST, (p) => (p === "/packs/data.json" ? JSON.stringify(pointer) : null));
  const fresh = await browser.newContext({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, serviceWorkers: "block", locale: "ko-KR" });
  await fresh.route(/^https:\/\/(cdn\.jsdelivr\.net|raw\.githubusercontent\.com)\//, (route) => route.abort("failed"));
  const p2 = await fresh.newPage();
  p2.on("pageerror", (e) => errors.push(String(e)));
  await p2.goto(`http://127.0.0.1:${app2.port}/#solver`);
  await p2.waitForSelector(".sv-pack", { timeout: 30000 });
  await p2.waitForSelector("#splash", { state: "detached", timeout: 15000 }).catch(() => undefined);
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: path.join(SHOTS, "12-fresh-device-cdns-down.png") });
  check("fresh device, both CDNs down: the bundled packs are listed, flagged", (await p2.locator(".sv-pack").count()) === 3 && (await p2.locator("text=팩 서버에 연결하지 못했어요 · 열어 본 플랍은 볼 수 있어요").count()) === 1);
  await p2.click("text=UTG vs BB 싱글 레이즈드 팟");
  await p2.waitForSelector("text=전체 평균", { timeout: 30000 });
  await p2.click(".sv-open >> nth=0");
  await p2.waitForSelector(".sv-cell", { timeout: 30000 });
  check("fresh device, both CDNs down: a bundled pack's flop opens from our origin", app2.seen.some((p) => /^\/packs\/pub-srp-utg-bb-55\/v1\/flop-/.test(p)));
  await fresh.close();
  app2.server.close();

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`CDN requests: jsDelivr ${hits.jsdelivr.length}, raw ${hits.raw.length}, refused ${hits.refused.length}`);
  await browser.close();
  cdn.server.close();
  const failed = checks.filter((c) => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
