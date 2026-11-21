// Copies the flop files of the presolve workflow's shards into the two pack directories: the app's packs into the data
// branch's checkout (packs-data/packs, sparse in the workflow: catalog and indexes, no flop files) and the calibration
// packs into calibration/packs on master. It replaces the merge job's copy step (.github/workflows/presolve.yml).
//
// Usage: node scripts/packs-ingest.mjs --shards <dir> [--app packs-data/packs] [--cal calibration/packs]
//   <dir>/<shard>/files/<pack>/v<k>/flop-<board>.json       app packs
//   <dir>/<shard>/cal-files/<pack>/v<k>/flop-<board>.json   calibration packs
//
// A file is never replaced (the files of a version never change). For the app's packs a file "exists" when the index
// lists it (it was published) or when it is on disk: an identical file is skipped, a different one is reported and the
// existing one kept. Prints the number of files copied; with GITHUB_OUTPUT also writes new_flops=<n> there.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { load } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const { values: opt } = parseArgs({
  options: { shards: { type: "string" }, app: { type: "string" }, cal: { type: "string" } },
});
if (!opt.shards) {
  console.error("usage: node scripts/packs-ingest.mjs --shards <dir> [--app packs-data/packs] [--cal calibration/packs]");
  process.exit(2);
}
const { PACK_SET_DIRS } = await load("src/presolve/scenarios.ts");
const { readSetManifest, nodeStoreFs } = await load("src/presolve/store.ts");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fsx = nodeStoreFs({ existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync }, process.pid);
const dirs = { app: resolve(root, opt.app ?? PACK_SET_DIRS.app), calibration: resolve(root, opt.cal ?? PACK_SET_DIRS.calibration) };
const FLOP = /^[a-z0-9-]+\/v[0-9]+\/flop-[2-9TJQKAshdc]{6}\.json$/;

/** Every file under a directory, as paths relative to it. */
function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

// The app's published files: what the index lists (the sparse checkout has no flop files to compare with). Without the
// catalog (no packs-data checkout: a calibration-only run) nothing tells a published file from a new one, so app files
// are skipped, never copied into a directory that is not the data branch's checkout.
let listed = new Map();
const appCatalog = existsSync(`${dirs.app}/manifest.json`);
let appSkipped = 0;
if (appCatalog) {
  const st = readSetManifest(fsx, dirs.app, "app", sha256);
  for (const p of st.manifest.packs) for (const f of p.files) listed.set(f.path, f.sha256);
}

let added = 0;
const shardsDir = resolve(opt.shards);
for (const shard of existsSync(shardsDir) ? readdirSync(shardsDir).sort() : []) {
  for (const [sub, set] of [
    ["files", "app"],
    ["cal-files", "calibration"],
  ]) {
    const base = `${shardsDir}/${shard}/${sub}`;
    for (const rel of walk(base)) {
      const src = `${base}/${rel}`;
      if (!FLOP.test(rel)) {
        console.log(`::warning::Skipping unexpected artifact file ${src}`);
        continue;
      }
      if (set === "app" && !appCatalog) {
        appSkipped++;
        continue;
      }
      const buf = readFileSync(src);
      const dest = `${dirs[set]}/${rel}`;
      if (set === "app" && listed.has(rel)) {
        if (listed.get(rel) !== sha256(buf)) console.log(`::warning::${src} differs from the published ${rel}; keeping the published file`);
        continue;
      }
      if (existsSync(dest)) {
        if (!readFileSync(dest).equals(buf)) console.log(`::warning::${src} differs from ${dest}; keeping the existing file`);
        continue;
      }
      mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
      copyFileSync(src, dest);
      added++;
    }
  }
}
if (appSkipped) console.log(`::warning::${appSkipped} app flop file(s) skipped: ${dirs.app}/manifest.json is missing (no packs-data checkout)`);
console.log(`${added} new flop file(s) copied into ${dirs.app} and ${dirs.calibration}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `new_flops=${added}\n`);
