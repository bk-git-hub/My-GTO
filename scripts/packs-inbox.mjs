// The presolve workflow's side of the packs-inbox branch, where presolve workers on machines outside the workflow
// (scripts/presolve-worker.mjs) leave the flops they solved (layout: src/presolve/inbox.ts; git: scripts/inbox.mjs).
//
// Usage (.github/workflows/presolve.yml):
//   node scripts/packs-inbox.mjs done --repo <checkout> --solver <sha> --out <file>
//       A solve job's skip list (presolve.mjs --skip-from): every flop of that solver commit on the checked-out commit of
//       the branch, so the shards leave the workers' flops alone. Reads only trees (the checkout is blobless).
//   node scripts/packs-inbox.mjs stage --repo <checkout> --solver <sha> --into <dir> --plan <file> [--scenario <ids|all>] [--set app|calibration]
//       The merge, before its rebuild: copies the flops it takes (packs the run covers, at the code's current version,
//       from the checkout, which is sparse with <solver>/ only) into <dir>/files/ and <dir>/cal-files/, and the solver
//       commit's summaries into <dir>/summaries.json: one more shard directory for packs-ingest.mjs and --summaries-from.
//       Writes what it read (the head, the taken and stale files, the older solver commits) to <file> for `clean`.
//   node scripts/packs-inbox.mjs clean --repo <checkout> --plan <file> [--rejected] [--app packs-data/packs] [--cal calibration/packs]
//       The merge, after its pushes: removes from the branch the taken flops that are published now (listed in the
//       catalog or calibration manifest as pushed; with --rejected all the taken ones, which failed the rebuild's checks
//       and must be solved again), the stale ones, everything under an older solver commit and the summaries whose flops
//       are all gone. The commit is built on the branch's current head and pushed as a fast-forward: a worker's push in
//       between makes it redo the removal on the new head, so the worker's files stay.
//
// The solver commit is the full SHA of the plan job's solver commit. An older one is a commit on the branch that is an
// ancestor of it in this checkout's history (the merge checks master out with its full history); a commit this history
// doesn't know (a newer master) is left alone.
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { load } from "./equity-cache.mjs";
import { commitToBranch, git, treePaths } from "./inbox.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const { values: opt } = parseArgs({
  args: rest,
  options: {
    repo: { type: "string" },
    solver: { type: "string" },
    out: { type: "string" },
    into: { type: "string" },
    plan: { type: "string" },
    scenario: { type: "string", default: "all" },
    set: { type: "string" },
    rejected: { type: "boolean", default: false },
    app: { type: "string" },
    cal: { type: "string" },
  },
});
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!["done", "stage", "clean"].includes(cmd)) fail("usage: node scripts/packs-inbox.mjs done|stage|clean --repo <checkout> ... (see the header)");
if (!opt.repo) fail("--repo <checkout of packs-inbox> is required");
const repo = resolve(opt.repo);
const inbox = await load("src/presolve/inbox.ts");
const output = (line) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);

if (cmd === "done" || cmd === "stage") {
  if (!inbox.isSolverCommit(opt.solver ?? "")) fail(`--solver must be a full 40-digit SHA, got "${opt.solver}"`);
}

if (cmd === "done") {
  if (!opt.out) fail("done needs --out <file>");
  const flops = inbox.inboxFlops(await treePaths(repo, "HEAD"), opt.solver);
  writeFileSync(resolve(opt.out), inbox.skipList(flops.map((f) => f.path)));
  console.log(`${flops.length} flop(s) of solver ${opt.solver.slice(0, 12)} waiting in packs-inbox; the shards skip them`);
  process.exit(0);
}

if (cmd === "stage") {
  if (!opt.into || !opt.plan) fail("stage needs --into <dir> and --plan <file>");
  const { ALL_SCENARIOS, getScenario } = await load("src/presolve/scenarios.ts");
  if (opt.set !== undefined && opt.set !== "" && opt.set !== "app" && opt.set !== "calibration") fail(`--set must be app or calibration, got "${opt.set}"`);
  // The packs the run covers, exactly as presolve.mjs picks them from --scenario and --set.
  const covered = new Set(
    (opt.scenario === "all" ? ALL_SCENARIOS : opt.scenario.split(",").map((id) => getScenario(id.trim())))
      .filter((sc) => !opt.set || sc.set === opt.set)
      .map((sc) => sc.id),
  );
  const head = (await git(repo, ["rev-parse", "HEAD"], { check: true })).stdout.trim();
  const paths = await treePaths(repo, head);
  const plan = inbox.planInbox(inbox.inboxFlops(paths, opt.solver), ALL_SCENARIOS, covered);
  const into = resolve(opt.into);
  rmSync(into, { recursive: true, force: true });
  let copied = 0;
  for (const f of plan.take) {
    const src = join(repo, f.inboxPath);
    // The checkout is sparse with <solver>/ in it; a file missing there is a broken checkout, not a reason to guess.
    if (!existsSync(src)) fail(`${f.inboxPath}: listed on ${head.slice(0, 12)} but not in the checkout (is it sparse with ${opt.solver}/?)`);
    const dest = join(into, inbox.INBOX_SET_DIRS[f.set], f.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied++;
  }
  // Every summaries file of the solver commit, merged: --summaries-from matches by path and sha256, so extra entries are harmless.
  const summaries = [];
  const files = [];
  for (const p of paths.filter((x) => inbox.isSummariesPath(x, opt.solver))) {
    const file = join(repo, p);
    let s;
    try {
      s = JSON.parse(readFileSync(file, "utf8"));
      if (s?.summaries !== 1 || !Array.isArray(s.files)) throw new Error("not a summaries file");
    } catch (e) {
      console.log(`::warning::${p}: ${existsSync(file) ? e.message : "not in the checkout"}; its flops get summaries rebuilt from the files`);
      continue;
    }
    summaries.push({ inboxPath: p, files: s.files.map((f) => ({ set: f?.set, path: f?.path })) });
    files.push(...s.files);
  }
  if (copied) {
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "summaries.json"), JSON.stringify({ summaries: 1, files }));
  }
  // Older solver commits: ancestors of ours in master's history (the merge's full, blobless checkout).
  const olderSolvers = [];
  for (const s of inbox.otherSolvers(paths, opt.solver)) {
    const known = await git(root, ["cat-file", "-e", `${s}^{commit}`]);
    if (known.ok && (await git(root, ["merge-base", "--is-ancestor", s, opt.solver])).ok) olderSolvers.push(s);
  }
  writeFileSync(resolve(opt.plan), JSON.stringify({ v: 1, head, solver: opt.solver, take: plan.take, stale: plan.stale, summaries, olderSolvers }));
  console.log(
    `packs-inbox at ${head.slice(0, 12)}: ${copied} flop(s) of solver ${opt.solver.slice(0, 12)} staged in ${into}; ${plan.stale.length} stale (an older ` +
      `version), ${plan.later.length} left for a later run, ${olderSolvers.length} older solver commit(s) to remove`,
  );
  output(`inbox_flops=${copied}`);
  process.exit(0);
}

// ───── clean ─────

if (!opt.plan) fail("clean needs --plan <file>");
const plan = JSON.parse(readFileSync(resolve(opt.plan), "utf8"));
if (plan?.v !== 1 || !inbox.isSolverCommit(plan.solver ?? "")) fail(`${opt.plan}: not a plan written by stage`);
const { PACK_SET_DIRS } = await load("src/presolve/scenarios.ts");
const { readSetManifest, nodeStoreFs } = await load("src/presolve/store.ts");
const fsx = nodeStoreFs({ existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync }, process.pid);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// What is published now: the catalog and the calibration manifest as this job pushed them (a set without a manifest here,
// e.g. no packs-data checkout in a calibration-only run, publishes nothing, so its files stay for a later run).
const listed = new Set();
for (const [set, dir] of [
  ["app", resolve(root, opt.app ?? PACK_SET_DIRS.app)],
  ["calibration", resolve(root, opt.cal ?? PACK_SET_DIRS.calibration)],
]) {
  if (!existsSync(join(dir, "manifest.json"))) continue;
  const st = readSetManifest(fsx, dir, set, sha256);
  for (const p of st.manifest.packs) for (const f of p.files) listed.add(`${set} ${f.path}`);
}
const headPaths = await treePaths(repo, plan.head);
const removals = inbox.inboxRemovals({
  paths: headPaths,
  solver: plan.solver,
  taken: plan.take,
  stale: plan.stale,
  published: (f) => listed.has(`${f.set} ${f.path}`),
  rejected: opt.rejected,
  olderSolvers: new Set(plan.olderSolvers),
  summaries: plan.summaries,
});
if (!removals.length) {
  console.log("packs-inbox: nothing to remove");
  process.exit(0);
}
const flops = removals.filter((p) => inbox.parseInboxFlop(p)).length;
const res = await commitToBranch({
  repo,
  branch: inbox.INBOX_BRANCH,
  change: () => ({
    remove: removals,
    message: `Inbox: ${flops} flop(s) ${opt.rejected ? "rejected by the merge's checks" : "taken in"}, ${removals.length - flops} other file(s) removed` +
      (process.env.GITHUB_RUN_ID ? ` (presolve run ${process.env.GITHUB_RUN_ID})` : ""),
  }),
  log: (m) => console.log(m),
});
console.log(res.pushed ? `packs-inbox: removed ${res.removed} file(s) at ${res.commit}` : "packs-inbox: those files were already gone");
