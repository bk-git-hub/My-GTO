// Writes public/packs/data.json on master: the commit of the `packs-data` branch the app reads its packs from, and the
// sha256 of that commit's catalog (docs/solver-packs.md "Data branch"). The app fetches data.json from its own origin,
// then the catalog from a CDN pinned to the commit, checking each file against the hash the step before gave.
//
// Usage: node scripts/packs-pointer.mjs --commit <40-hex sha> [--repo owner/name] [--catalog packs-data/packs/manifest.json]
//                                       [--dir packs/] [--out public/packs/data.json]
//   --repo     default: the repository of package.json ("bk-git-hub/My-GTO")
//   --catalog  the catalog file of that commit (the data branch's checkout at the commit)
// Writes only when the commit or the catalog changed; prints "unchanged" otherwise (and changed=<bool> to GITHUB_OUTPUT).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { load } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const { values: opt } = parseArgs({
  options: {
    commit: { type: "string" },
    repo: { type: "string" },
    catalog: { type: "string", default: "packs-data/packs/manifest.json" },
    dir: { type: "string", default: "packs/" },
    out: { type: "string", default: "public/packs/data.json" },
  },
});
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!opt.commit || !/^[0-9a-f]{40}$/.test(opt.commit)) fail("--commit must be the full 40-hex SHA of the packs-data commit (jsDelivr caches a short SHA as a branch).");
const repoUrl = JSON.parse(readFileSync(`${root}package.json`, "utf8")).repository?.url ?? "";
const repo = opt.repo ?? /github\.com\/([^/]+\/[^/.]+)/.exec(repoUrl)?.[1];
if (!repo) fail("--repo is required (package.json names no GitHub repository)");
const { validatePointer, validateCatalog } = await load("src/presolve/format.ts");
const text = readFileSync(resolve(root, opt.catalog));
const catalog = JSON.parse(text.toString("utf8"));
const cerrs = validateCatalog(catalog);
if (cerrs.length) fail(`${opt.catalog}: ${cerrs.slice(0, 3).join("; ")}`);
const pointer = {
  v: 2,
  repo,
  commit: opt.commit,
  dir: opt.dir,
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  catalog: { path: "manifest.json", sha256: createHash("sha256").update(text).digest("hex"), bytes: text.length },
};
const errs = validatePointer(pointer);
if (errs.length) fail(`pointer invalid: ${errs.join("; ")}`);
const out = resolve(root, opt.out);
const old = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
const same = old && old.repo === pointer.repo && old.commit === pointer.commit && old.dir === pointer.dir && old.catalog?.sha256 === pointer.catalog.sha256;
if (same) console.log(`${opt.out}: unchanged (${pointer.commit.slice(0, 12)})`);
else {
  writeFileSync(out, `${JSON.stringify(pointer, null, 2)}\n`);
  console.log(`${opt.out} → ${repo}@${pointer.commit.slice(0, 12)}, catalog ${pointer.catalog.bytes} bytes, ${catalog.packs.length} packs`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${same ? "false" : "true"}\n`);
