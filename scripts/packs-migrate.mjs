// Moves the app's packs from public/packs (v1 manifest, deployed with the app) to the data branch's layout (a v2 catalog
// plus one index per pack, docs/solver-packs.md "Data branch"), byte for byte: every flop file the v1 manifest lists is
// copied after its size and sha256 are checked (files no manifest lists are left behind), the catalog is rebuilt from the
// v1 entries with their exact summaries and solverCommit (presolve.mjs --rebuild-manifest --seed), and the result is
// checked: a second rebuild changes nothing and the catalog joined with its indexes equals the v1 manifest apart from
// generatedAt. It also writes the branch's README.md and vercel.json one level above --to. It commits nothing.
//
// Usage: node scripts/packs-migrate.mjs [--from public/packs] [--to packs-data/packs]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { load } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const { values: opt } = parseArgs({ options: { from: { type: "string", default: "public/packs" }, to: { type: "string", default: "packs-data/packs" } } });
const from = resolve(root, opt.from);
const to = resolve(root, opt.to);
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const { validateManifest } = await load("src/presolve/format.ts");
const { readSetManifest, nodeStoreFs, canon } = await load("src/presolve/store.ts");

const v1 = JSON.parse(readFileSync(`${from}/manifest.json`, "utf8"));
const errs = v1.v === 1 ? validateManifest(v1) : ["not a v1 manifest"];
if (errs.length) fail(`${opt.from}/manifest.json: ${errs.slice(0, 3).join("; ")}`);
if (existsSync(`${to}/manifest.json`)) fail(`${opt.to}/manifest.json exists: the migration starts an empty data branch.`);

let copied = 0,
  bytes = 0;
for (const p of v1.packs)
  for (const f of p.files) {
    const buf = readFileSync(`${from}/${f.path}`);
    if (buf.length !== f.bytes || sha256(buf) !== f.sha256) fail(`${f.path}: size or sha256 differs from the manifest`);
    const dest = `${to}/${f.path}`;
    if (existsSync(dest)) {
      if (!readFileSync(dest).equals(buf)) fail(`${dest} exists with other bytes`);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(`${from}/${f.path}`, dest);
    }
    copied++;
    bytes += buf.length;
  }
console.log(`copied ${copied} flop files (${(bytes / 1e6).toFixed(1)} MB) of ${v1.packs.map((p) => `${p.id} v${p.version}`).join(", ")}`);

const ids = v1.packs.map((p) => p.id).join(",");
const presolve = (extra) =>
  execFileSync(process.execPath, [`${root}scripts/presolve.mjs`, "--rebuild-manifest", "--scenario", ids, "--out", to, ...extra], { cwd: root, encoding: "utf8" });
process.stdout.write(presolve(["--seed", `${from}/manifest.json`]));
const second = presolve([]);
process.stdout.write(second);
if (!/unchanged, not rewritten/.test(second)) fail("the second rebuild changed the catalog: not byte-identical");

const fsx = nodeStoreFs({ existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync }, process.pid);
const joined = readSetManifest(fsx, to, "app", sha256).manifest;
if (canon({ ...joined, generatedAt: undefined }) !== canon({ ...v1, generatedAt: undefined })) fail("the joined catalog differs from the v1 manifest");
for (const p of v1.packs) {
  const j = joined.packs.find((x) => x.id === p.id);
  if (JSON.stringify(j) !== JSON.stringify(p)) fail(`${p.id}: the joined entry is not byte-identical to the v1 entry`);
}
console.log("check: a second rebuild changes nothing; catalog + indexes = the v1 manifest (every entry byte-identical) apart from generatedAt");

const branch = dirname(to);
writeFileSync(
  `${branch}/README.md`,
  `# packs-data

Data only: the solver chart packs of [PubAJ](https://github.com/bk-git-hub/My-GTO) (AGPL-3.0-or-later), solved by the
project's own postflop solver (\`src/solver\` on master). Never merged into master. The app reads it through jsDelivr
pinned to a full commit SHA (raw.githubusercontent.com as the fallback); \`public/packs/data.json\` on master names the
commit and the catalog's sha256.

- \`packs/manifest.json\`: the catalog (v2): one entry per pack, with the sha256 of its file list.
- \`packs/<pack>/v<k>/index-<sha16>.json\`: a pack's file list (content-addressed).
- \`packs/<pack>/v<k>/flop-<board>.json\`: one flop's strategies; a file at a path never changes.

Written by the presolve workflow (\`.github/workflows/presolve.yml\` on master, \`scripts/packs-ingest.mjs\` and
\`scripts/presolve.mjs --rebuild-manifest\`). Format: \`docs/solver-packs.md\` on master. Do not edit by hand.
`,
);
writeFileSync(`${branch}/vercel.json`, `${JSON.stringify({ $schema: "https://openapi.vercel.sh/vercel.json", git: { deploymentEnabled: false } }, null, 2)}\n`);
console.log(`wrote ${branch}/README.md and ${branch}/vercel.json`);
