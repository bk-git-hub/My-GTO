// Presolve pipeline: solves flops of the scenarios in src/presolve/scenarios.ts with our solver (src/solver)
// and writes the app's solver chart packs to packs-data/packs/, a checkout of the `packs-data` branch the app reads
// through a CDN (format: docs/solver-packs.md, src/presolve/format.ts; a v2 catalog with one index per pack,
// src/presolve/store.ts), and the calibration packs (CAL_SCENARIOS) in the same flop format to calibration/packs/, a
// separate v1 manifest on master the app never reads.
//
// Usage: node scripts/presolve.mjs [options]
//   --scenario <id|all>     which pack(s), comma-separated (default all: the app's and the calibration packs; ids in
//                           src/presolve/scenarios.ts)
//   --set <app|calibration> only the packs of --scenario in this set (e.g. --scenario all --set calibration)
//   --count <n>             cover the first n flops of FLOPS_BY_PRIORITY per pack (default 100)
//   --shard <i>/<n>         solve only shard i of n (0 ≤ i < n; default 0/1, everything): flop k of FLOPS_BY_PRIORITY
//                           (its index in the full order) belongs to shard k % n, so parallel jobs started from the
//                           same commit solve disjoint flops; each shard still covers only the first --count flops,
//                           in priority order, and skips files already on disk (src/presolve/shard.ts)
//   --order <priority|reverse>  which end of the queue to start from (default priority, front to back). reverse takes
//                           the same jobs back to front: the presolve worker (scripts/presolve-worker.mjs) solves the
//                           workflow's queue from the other end, so the two never need to claim a flop
//   --skip-from <file>      (repeatable) pack paths solved elsewhere, one per line (<pack>/v<k>/flop-<board>.json: the
//                           flops waiting in the packs-inbox branch, src/presolve/inbox.ts); they are skipped like files
//                           on disk but not listed in the manifest. Re-read whenever the file changes, before each flop
//                           is started, so a long run drops flops another machine finished in the meantime
//   --budget-minutes <m>    wall-clock budget for the whole run (default 50); never starts or keeps a solve past it
//   --iterations <n>        iteration cap per flop (default: the scenario's; not allowed with the default --out)
//   --target <pct>          exploitability target, % of pot (default: the scenario's; not allowed with the default --out)
//   --workers <n>           flops solved in parallel, one per worker thread (default: CPU count)
//   --max-mb <mb>           skip a flop whose estimateMemory is above this (default 2000)
//   --reserve-mb <mb>       RAM left to the rest of the machine: a solve starts only while the running ones' estimates
//                           (× 1.25) fit in the total minus this (default: in 85% of the total)
//   --check-every <n>       iterations between exploitability checks (default 10)
//   --out <dir>             output directory of the app's packs (default packs-data/packs, the data branch's checkout;
//                           the script refuses to run there while it has no manifest.json, so a missing checkout can
//                           never make it solve every pack again)
//   --cal-out <dir>         output directory of the calibration packs (default calibration/packs with the default
//                           --out, else <out>/calibration, so an experiment never writes into the committed packs)
//   --accept-above-target   write a flop even when its exploitability is above the scenario's target × TARGET_TOLERANCE
//   --allow-dirty           write to the default --out although src/solver has uncommitted changes
//   --publish               the files are meant for the published packs although --out is a scratch directory (the
//                           presolve worker's, which pushes them to the packs-inbox branch): the committed directories'
//                           rules apply (no --iterations / --target, a named solver commit, no uncommitted solver code)
//   --dry-run               print the plan (flops, memory estimates) and write nothing
//   --rebuild-manifest      solve nothing: rebuild manifest.json from the current-version files on disk (e.g. after
//                           copying in the files of several --shard runs), with the checks a run applies before
//                           writing a file, and write it as a run would; exits 1 when a pack's files fail them
//   --summaries-from <file> with --rebuild-manifest (repeatable): a --summaries-out file or a v1 manifest written by
//                           another run (e.g. a shard's); a file listed there with the same path and sha256 takes its
//                           summary from it, the exact one the solve produced, instead of one rebuilt from the file
//   --summaries-out <file>  write the exact summaries of the files this run wrote (path, sha256, summary), updated
//                           after every flop, for the merge's --summaries-from
//   --seed <manifest>       with --rebuild-manifest, once: a v1 manifest to start the app's set from when its
//                           directory has no manifest yet (the move of public/packs to the data branch keeps every
//                           entry, summary and solverCommit exactly; scripts/packs-migrate.mjs)
//
// Environment: PRESOLVE_SOLVER_COMMIT names the solver commit instead of `git log` (the workflow reads it once from a
// full history and checks the code out shallow); without it a shallow clone is refused when writing committed packs.
//
// It skips flops whose file already exists for the pack's current version, solves the next ones in priority
// order, writes each file as soon as it is done and updates manifest.json after every flop (both atomically,
// via a temp file and rename), so stopping at any point leaves a consistent pack. A solve that would run past
// the budget is abandoned and nothing is written for it. A finished solve is only written when its
// exploitability is within TARGET_TOLERANCE × the scenario's target and its summary nodes match the pack's
// (the files of a version never change, so a bad or mismatched file would stay forever). The manifest is only
// rewritten when something other than `generatedAt` changes, so a run that adds nothing leaves no diff.
// Each set of packs (scenario.set: "app" or "calibration") has its own directory and manifest.json; a run touches
// only the manifests of the sets it solves, and a calibration pack never enters the app's catalog.
// The presolve workflow runs n shards in parallel, copies their new files into one checkout and runs
// --rebuild-manifest there (.github/workflows/presolve.yml). Its merge also takes in the flops that presolve workers
// (scripts/presolve-worker.mjs, on machines outside the workflow) leave on the packs-inbox branch: they come from this
// script too (--order reverse --publish --skip-from) and pass the same checks as a shard's files.
//
// Started with an IPC channel (child_process.fork or spawn with "ipc", as the worker does), it also reports each flop to
// its parent ({ type: "done" | "not-written" | "dropped" | ... }) and stops cleanly on { type: "stop" } or when the
// parent goes away, like on SIGINT. Paths: everything is built from fileURLToPath and path.resolve, so a Windows
// checkout (drive letters, backslashes) works as well as Linux.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { load } from "./equity-cache.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const RESERVE_MS = 90_000; // kept free at the end of the budget for extraction, writing and the manifest
const MIN_START_MS = 4 * 60_000; // don't start a flop with less time left than this before any timing is known
const TARGET_TOLERANCE = 1.5; // a finished flop above target × this is not written (the iteration cap was too low)

// ───────────────────────── worker: solve one flop ─────────────────────────

if (!isMainThread && workerData?.presolveJob) {
  const job = workerData.presolveJob;
  const { getScenario, solverInput } = await load("src/presolve/scenarios.ts");
  const { createSolver } = await load("src/solver/index.ts");
  const { parseBoardKey } = await load("src/presolve/format.ts");
  const { extractFlop } = await load("src/presolve/extract.ts");
  const sc = getScenario(job.scenario);
  const input = solverInput(sc, parseBoardKey(job.board));
  const t0 = Date.now();
  const solver = createSolver(input);
  let expl = Infinity;
  let nextCheck = Math.min(job.firstCheck, job.iterations);
  let stopped = false;
  while (solver.iteration < job.iterations) {
    solver.iterate(Math.min(5, nextCheck - solver.iteration));
    if (Date.now() > job.deadline) {
      stopped = true;
      break;
    }
    if (solver.iteration >= nextCheck) {
      expl = solver.exploitability();
      parentPort.postMessage({ type: "progress", iteration: solver.iteration, exploitability: expl, seconds: (Date.now() - t0) / 1000 });
      if (expl <= job.target) break;
      nextCheck = Math.min(job.iterations, nextCheck + job.checkEvery);
    }
  }
  if (stopped) {
    parentPort.postMessage({ type: "deadline", iteration: solver.iteration, exploitability: expl, seconds: (Date.now() - t0) / 1000 });
  } else {
    const solveSeconds = (Date.now() - t0) / 1000;
    const mem = process.memoryUsage();
    const t1 = Date.now();
    // Slim files for the packs that ask for them (ScenarioMeta.storage); every other pack is extracted as it always was.
    const res = extractFlop(input, solver.solution(), { scenario: sc.id, version: sc.version }, ...(sc.meta.storage ? [{ storage: sc.meta.storage }] : []));
    parentPort.postMessage({
      type: "done",
      json: res.json,
      bytes: res.bytes,
      tooBig: res.tooBig,
      summary: res.summary,
      summaryNodes: res.summaryNodes,
      exploitability: res.exploitability,
      iterations: res.file.iterations,
      nodes: res.stats.stored,
      leftOut: res.stats.leftOut,
      solveSeconds,
      extractSeconds: (Date.now() - t1) / 1000,
      memMb: Math.round((mem.heapUsed + mem.external) / 1e6),
    });
  }
}

// ───────────────────────── main ─────────────────────────

if (isMainThread) {
  const { values: opt } = parseArgs({
    options: {
      scenario: { type: "string", default: "all" },
      set: { type: "string" },
      count: { type: "string", default: "100" },
      shard: { type: "string" },
      order: { type: "string", default: "priority" },
      "skip-from": { type: "string", multiple: true, default: [] },
      "budget-minutes": { type: "string", default: "50" },
      iterations: { type: "string" },
      target: { type: "string" },
      workers: { type: "string" },
      "max-mb": { type: "string", default: "2000" },
      "reserve-mb": { type: "string" },
      "check-every": { type: "string", default: "10" },
      out: { type: "string" },
      "cal-out": { type: "string" },
      "accept-above-target": { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
      publish: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "rebuild-manifest": { type: "boolean", default: false },
      "summaries-from": { type: "string", multiple: true, default: [] },
      "summaries-out": { type: "string" },
      seed: { type: "string" },
    },
  });
  const rebuild = opt["rebuild-manifest"];
  const usage = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  if (rebuild && opt["dry-run"]) usage("--rebuild-manifest writes the manifest; it has no --dry-run.");
  if (rebuild && opt.shard !== undefined) usage("--rebuild-manifest covers every file on disk; it takes no --shard.");
  if (!rebuild && opt["summaries-from"].length) usage("--summaries-from only works with --rebuild-manifest.");
  if (!rebuild && opt.seed !== undefined) usage("--seed only works with --rebuild-manifest.");
  if (rebuild && opt["skip-from"].length) usage("--rebuild-manifest covers the files on disk; it takes no --skip-from.");
  const num = (name, v, min) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < min) throw new Error(`--${name} must be a number ≥ ${min}`);
    return x;
  };
  const count = Math.floor(num("count", opt.count, 1));
  const budgetMs = num("budget-minutes", opt["budget-minutes"], 1) * 60_000;
  const workers = Math.floor(num("workers", opt.workers ?? cpus().length, 1));
  const maxMb = num("max-mb", opt["max-mb"], 1);
  const reserveMb = opt["reserve-mb"] !== undefined ? num("reserve-mb", opt["reserve-mb"], 0) : undefined;
  const checkEvery = Math.floor(num("check-every", opt["check-every"], 1));
  const { ALL_SCENARIOS, PACK_SET_DIRS, getScenario, solverInput, plannedPacks } = await load("src/presolve/scenarios.ts");
  const { misplacedPacks, setDirs: dirsOf, writesCommitted } = await load("src/presolve/sets.ts");
  const committed = { app: resolve(root, PACK_SET_DIRS.app), calibration: resolve(root, PACK_SET_DIRS.calibration) };
  let setDirs;
  try {
    setDirs = dirsOf({ out: resolve(root, opt.out ?? PACK_SET_DIRS.app), calOut: opt["cal-out"] !== undefined ? resolve(root, opt["cal-out"]) : undefined, committed });
  } catch (e) {
    usage(e.message);
  }
  if (opt.set !== undefined && opt.set !== "app" && opt.set !== "calibration") usage(`--set must be app or calibration, got "${opt.set}"`);
  const scenarios = (opt.scenario === "all" ? ALL_SCENARIOS : opt.scenario.split(",").map((id) => getScenario(id.trim()))).filter((sc) => opt.set === undefined || sc.set === opt.set);
  if (!scenarios.length) usage(`no pack of --scenario ${opt.scenario} is in the ${opt.set} set`);
  const sets = [...new Set(scenarios.map((sc) => sc.set))];
  // The committed packs: every file written there stays for good (paths are immutable), so no experiments. --publish
  // says the same of a scratch --out whose files are headed for them (the worker's, via the packs-inbox branch).
  const isPublicOut = opt.publish || writesCommitted(setDirs, sets, committed);
  if (isPublicOut && !opt["dry-run"] && (opt.iterations !== undefined || opt.target !== undefined)) {
    console.error(
      "--iterations and --target change the numbers but are not recorded in the pack, so they are only allowed with --out <scratch dir> (and --cal-out, if given, also a scratch dir). " +
        "To change a pack's solve targets, edit src/presolve/scenarios.ts and bump its version.",
    );
    process.exit(1);
  }
  const t0 = Date.now();
  const budgetEnd = t0 + budgetMs;
  const mins = (ms) => (ms / 60_000).toFixed(1);
  const log = (msg) => console.log(`[${mins(Date.now() - t0).padStart(5)} min] ${msg}`);

  const { FLOPS_BY_PRIORITY, describeTexture, representativeWeightsFor } = await load("src/presolve/flops.ts");
  const { estimateMemory } = await load("src/solver/index.ts");
  const { packFilePath, validateManifest, validateFlopFile, decodeFlopFile, summaryNodeDefs } = await load("src/presolve/format.ts");
  const { readSetManifest, writeSetManifest, listedBoards, nodeStoreFs, canon } = await load("src/presolve/store.ts");
  const { summarizeFile, MAX_BYTES } = await load("src/presolve/extract.ts");
  const { jobQueue, parseOrder, parseShard, shardFlops } = await load("src/presolve/shard.ts");
  const { parseSkipList } = await load("src/presolve/inbox.ts");
  let shard, order;
  try {
    shard = parseShard(opt.shard ?? "0/1");
    order = parseOrder(opt.order);
  } catch (e) {
    usage(e.message);
  }
  const shardTag = (shard.count > 1 ? ` (shard ${shard.index}/${shard.count})` : "") + (order === "reverse" ? " (back to front)" : "");

  // A parent with an IPC channel (the presolve worker) gets each flop as an event; without one this does nothing.
  const send = (msg) => {
    if (!process.send || !process.connected) return;
    try {
      process.send(msg);
    } catch {
      // The parent is gone: the "disconnect" handler below stops the run.
    }
  };

  // --skip-from: the pack paths solved elsewhere. Re-read when a file's size or mtime changes; a file that can't be read
  // later (being replaced) keeps the last list, but one that can't be read at the start is an error.
  const skipFiles = opt["skip-from"].map((f) => resolve(f));
  let skipStamp = null;
  let skipped = new Set();
  const readSkips = () => {
    if (!skipFiles.length) return false;
    try {
      const stamp = skipFiles.map((f) => `${statSync(f).mtimeMs}:${statSync(f).size}`).join(",");
      if (stamp === skipStamp) return false;
      const next = new Set();
      for (const f of skipFiles) for (const p of parseSkipList(readFileSync(f, "utf8"))) next.add(p);
      skipStamp = stamp;
      skipped = next;
      return true;
    } catch (e) {
      if (skipStamp === null) usage(`--skip-from: ${e.message}`);
      return false;
    }
  };
  readSkips();

  const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
  const fsx = nodeStoreFs({ existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync }, process.pid);
  // The data branch's checkout must be there: without its catalog every app pack would look empty and be solved again.
  if (sets.includes("app") && setDirs.app === committed.app.replace(/\/+$/, "") && !existsSync(`${setDirs.app}/manifest.json`) && opt.seed === undefined)
    usage(
      `${PACK_SET_DIRS.app}/manifest.json is missing: check out the packs-data branch there first (git worktree add packs-data packs-data, ` +
        "or git fetch origin packs-data && git worktree add packs-data origin/packs-data), or pass --out <scratch dir>.",
    );
  // One store per set the run touches: its directory, its manifest as the run found it (`old`) and as it is on disk now
  // (`current`: the v1-shaped manifest, joined from the catalog for the app's set, and the catalog itself).
  const stores = new Map();
  for (const set of sets) {
    let st;
    try {
      st = readSetManifest(fsx, setDirs[set], set, sha256);
    } catch (e) {
      usage(`cannot read the ${set} manifest: ${e.message}`);
    }
    if (set === "app" && opt.seed !== undefined) {
      if (existsSync(st.file)) usage(`--seed: ${st.file} exists; the seed only starts a set that has no manifest yet.`);
      const seed = JSON.parse(readFileSync(resolve(opt.seed), "utf8"));
      const errs = seed.v === 1 ? validateManifest(seed) : ["not a v1 manifest"];
      if (errs.length) usage(`--seed ${opt.seed}: ${errs.slice(0, 3).join("; ")}`);
      st = { ...st, manifest: seed };
    }
    stores.set(set, { set, dir: st.dir, manifestFile: st.file, old: st.manifest, current: st.manifest, state: st });
  }
  if (opt.seed !== undefined && !stores.has("app")) usage("--seed starts the app's set; the run covers no app pack.");
  const storeOf = (sc) => stores.get(sc.set);
  // A pack lives in its own set's manifest only: a calibration pack in the app's manifest would be listed by the app.
  for (const store of stores.values()) {
    const wrong = misplacedPacks(store.old.packs.map((p) => p.id), store.set, ALL_SCENARIOS);
    if (wrong.length) usage(`${store.manifestFile} lists ${wrong.join(", ")}, of the other set of packs; remove them there.`);
  }
  const priorityIndex = new Map(FLOPS_BY_PRIORITY.map((f, i) => [f.key, i]));

  // The last commit that changed the solver's code (test files don't change the numbers), "-dirty" with local edits.
  // The workflow reads it once from a full history (PRESOLVE_SOLVER_COMMIT) and checks the code out shallow, where
  // `git log` would name the checked-out commit instead.
  let solverCommit;
  const envCommit = process.env.PRESOLVE_SOLVER_COMMIT?.trim();
  if (envCommit) {
    if (!/^[0-9a-f]{7,40}$/.test(envCommit)) usage(`PRESOLVE_SOLVER_COMMIT must be a commit SHA, got "${envCommit}"`);
    solverCommit = envCommit;
  } else {
    let shallow = false;
    try {
      // Arguments as an array, no shell: the same on Windows (where cmd.exe would read %h) and Linux.
      const spec = ["--", "src/solver", ":!*.test.ts"];
      const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      shallow = git("rev-parse", "--is-shallow-repository") === "true";
      const head = git("log", "-1", "--format=%h", ...spec);
      const dirty = git("status", "--porcelain", ...spec);
      solverCommit = head ? head + (dirty ? "-dirty" : "") : undefined;
    } catch {
      solverCommit = undefined;
    }
    if (shallow && isPublicOut && !opt["dry-run"])
      usage("This clone is shallow, so `git log` can't name the solver's last commit: set PRESOLVE_SOLVER_COMMIT, or fetch the full history.");
  }
  if (isPublicOut && !opt["dry-run"] && solverCommit?.endsWith("-dirty") && !opt["allow-dirty"]) {
    console.error(
      `src/solver has uncommitted changes (${solverCommit}). Commit the solver first so the packs record the code that made them, ` +
        "use --out <scratch dir>, or pass --allow-dirty.",
    );
    process.exit(1);
  }

  const packDir = (sc) => `${storeOf(sc).dir}/${sc.id}/v${sc.version}`;
  /** The boards of the pack's current version whose file is on disk. */
  const diskBoards = (sc) => {
    const dir = packDir(sc);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^flop-([2-9TJQKAshdc]{6})\.json$/.exec(f)?.[1])
      .filter((k) => k && priorityIndex.has(k));
  };
  /**
   * The boards a pack's version has: on disk, or listed in the manifest the run started from (the data branch's index:
   * the workflow's checkout of it is sparse, with the indexes but none of the flop files).
   */
  const existingBoards = (sc) => {
    const out = new Set(diskBoards(sc));
    for (const b of listedBoards(storeOf(sc).old, sc.id, sc.version).keys()) if (priorityIndex.has(b)) out.add(b);
    return [...out];
  };

  // A pack's settings may not change within a version: the files of one version must come from one tree.
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const sc of scenarios) {
    const old = storeOf(sc).old.packs.find((p) => p.id === sc.id);
    if (old && old.version === sc.version && !sameJson(old.scenario, sc.meta)) {
      console.error(`${sc.id}: the scenario settings differ from the manifest's v${sc.version}. Bump its version in src/presolve/scenarios.ts.`);
      process.exit(1);
    }
    if (old && old.version > sc.version) {
      console.error(`${sc.id}: the manifest has v${old.version}, newer than the code's v${sc.version}.`);
      process.exit(1);
    }
    if (old && old.version === sc.version && old.solverCommit && solverCommit && old.solverCommit !== solverCommit)
      log(`${sc.id}: solver changed since v${sc.version} (${old.solverCommit} → ${solverCommit}); bump the version to re-solve with it`);
    if (old && old.version === sc.version && old.solverCommit?.endsWith("-dirty"))
      log(`${sc.id}: v${sc.version} was solved with uncommitted solver code (${old.solverCommit}); its provenance is unknown`);
  }

  // Jobs: the next missing flops of each pack (of this shard) in priority order, interleaved across the packs of the same
  // `queue` value, the lower values first (jobQueue: the calibration queue is solved one pack after the other); with
  // --order reverse the same jobs back to front.
  const isSkipped = (sc, key) => skipped.has(packFilePath(sc.id, sc.version, key));
  let queue = [];
  if (!rebuild) {
    const mine = shardFlops(FLOPS_BY_PRIORITY, count, shard); // by index in the full order, before skipping files on disk
    const of = shard.count > 1 ? `of shard ${shard.index}/${shard.count}'s ${mine.length} among the first ${count}` : `of the first ${count}`;
    const perPack = scenarios.map((sc) => {
      const have = new Set(existingBoards(sc));
      const elsewhere = mine.filter((f) => !have.has(f.key) && isSkipped(sc, f.key)).length;
      const todo = mine.filter((f) => !have.has(f.key) && !isSkipped(sc, f.key));
      log(
        `${sc.id} v${sc.version}: ${have.size} flops on disk, ${todo.length} ${of} to solve${elsewhere ? ` (${elsewhere} more solved elsewhere, --skip-from)` : ""}` +
          `${sc.queue ? ` (queue ${sc.queue})` : ""}`,
      );
      return { queue: sc.queue ?? 0, jobs: todo.map((f) => ({ sc, flop: f })) };
    });
    queue = jobQueue(perPack, order);
  }

  const estimate = (job) => {
    job.est ??= estimateMemory(solverInput(job.sc, job.flop.cards));
    return job.est;
  };

  if (opt["dry-run"]) {
    for (const job of queue) {
      const m = estimate(job);
      const mb = Math.round(m.bytes / 1e6);
      console.log(
        `  ${job.sc.id} ${job.flop.key.padEnd(7)} ${describeTexture(job.flop.texture).padEnd(18)} est ${String(mb).padStart(5)} MB, ${m.actionNodes} action nodes${mb > maxMb ? `  (over --max-mb ${maxMb}: would skip)` : ""}`,
      );
    }
    console.log(`dry run${shardTag}: ${queue.length} flops planned, ${workers} workers, budget ${mins(budgetMs)} min; nothing written`);
    process.exit(0);
  }

  // ───── writing ─────

  const writeAtomic = (file, text) => fsx.write(file, text);
  const fresh = new Map(); // `${id}/${board}` → { summary, summaryNodes }
  const written = []; // { path, sha256, set, summary } of every file this run wrote, for --summaries-out
  const writeSummaries = () => {
    if (opt["summaries-out"] === undefined) return;
    writeAtomic(resolve(opt["summaries-out"]), JSON.stringify({ summaries: 1, files: written.map(({ path, sha256: h, set, summary }) => ({ set, path, sha256: h, summary })) }));
  };
  const hints = new Map(); // `${path} ${sha256}` → summary, from --summaries-from manifests
  let hinted = 0;
  const stats = { done: 0, skipped: 0, stopped: 0, failed: 0, tooBig: 0, rejected: 0 };

  // The summary template of a pack's current version: what every new file of the version must match.
  const templates = new Map(); // scenario id → summaryNodes
  function packTemplate(sc) {
    if (templates.has(sc.id)) return templates.get(sc.id);
    let tpl;
    const old = storeOf(sc).current.packs.find((p) => p.id === sc.id);
    if (old && old.version === sc.version) tpl = old.summaryNodes;
    else {
      const board = diskBoards(sc)[0];
      if (board) tpl = summarizeFile(JSON.parse(readFileSync(`${storeOf(sc).dir}/${packFilePath(sc.id, sc.version, board)}`, "utf8"))).summaryNodes;
    }
    if (tpl) templates.set(sc.id, tpl);
    return tpl;
  }

  function packEntry(sc) {
    const boards = existingBoards(sc).sort((a, b) => priorityIndex.get(a) - priorityIndex.get(b));
    const { dir, old: oldManifest } = storeOf(sc);
    const old = oldManifest.packs.find((p) => p.id === sc.id);
    if (!boards.length) return old ?? null;
    const oldFiles = new Map((old?.files ?? []).map((f) => [f.path, f]));
    const weights = representativeWeightsFor(boards);
    let summaryNodes = old && old.version === sc.version ? old.summaryNodes : undefined;
    const files = boards.map((board) => {
      const path = packFilePath(sc.id, sc.version, board);
      const prevListed = old && old.version === sc.version ? oldFiles.get(path) : undefined;
      // Published (listed in the index the run started from) but not on disk: the data branch's sparse checkout. Its
      // entry stays exactly as published; only the weight follows the pack's current boards.
      if (prevListed && !existsSync(`${dir}/${path}`)) return { ...prevListed, weight: weights.get(board) };
      const buf = readFileSync(`${dir}/${path}`);
      const hash = sha256(buf);
      // A published file is never replaced: a different file at its path is an error (the published entry is kept).
      if (prevListed && prevListed.sha256 !== hash) throw new Error(`${path}: the file on disk differs from the published one (sha256 ${hash.slice(0, 12)}…, index ${prevListed.sha256.slice(0, 12)}…)`);
      let file;
      try {
        file = JSON.parse(buf.toString("utf8"));
      } catch (e) {
        throw new Error(`${path}: not JSON (${e.message})`);
      }
      let info = fresh.get(`${sc.id}/${board}`);
      const prev = oldFiles.get(path);
      if (!info && prev && prev.sha256 === hash) info = { summary: prev.summary };
      if (!info) {
        // A file the manifest doesn't list yet (written by a run that stopped before its manifest, or copied in
        // from shard runs): the checks a run applies before writing a solved flop, then its summary.
        let errs;
        try {
          errs = validateFlopFile(file);
        } catch (e) {
          errs = [`malformed file (${e.message})`];
        }
        if (errs.length) throw new Error(`${path}: ${errs.slice(0, 3).join("; ")}`);
        if (file.scenario !== sc.id || file.version !== sc.version || file.board !== board)
          throw new Error(`${path}: the file says ${file.scenario} v${file.version} ${file.board}, not ${sc.id} v${sc.version} ${board}`);
        // A pack's storage is fixed per version: a slim file in a full pack (or the reverse) was written by other settings.
        if ((file.rootClasses !== undefined) !== (sc.meta.storage === "rootClasses"))
          throw new Error(`${path}: ${file.rootClasses !== undefined ? "a slim (rootClasses) file" : "a file with nodes"}, but the pack's storage is ${sc.meta.storage ?? "full"}`);
        if (buf.length > MAX_BYTES) throw new Error(`${path}: ${buf.length} bytes, over the ${MAX_BYTES}-byte hard cap`);
        const limit = sc.meta.targetExploitability * TARGET_TOLERANCE;
        if (!(file.exploitability <= limit) && !opt["accept-above-target"])
          throw new Error(`${path}: exploitability ${file.exploitability}% is above ${+limit.toFixed(3)}% (target × ${TARGET_TOLERANCE}); pass --accept-above-target to keep it`);
        const hint = hints.get(`${path} ${hash}`);
        if (hint) {
          info = { summary: hint, summaryNodes: summaryNodeDefs(decodeFlopFile(file), 2) };
          hinted++;
        } else {
          info = summarizeFile(file);
          log(`${path}: no manifest entry, summary rebuilt from the file`);
        }
        fresh.set(`${sc.id}/${board}`, info); // checked once per run, not again at the next manifest write
      }
      if (info.summaryNodes) {
        if (summaryNodes && !sameJson(summaryNodes, info.summaryNodes)) throw new Error(`${path}: its summary nodes differ from the pack's (tree changed without a version bump?)`);
        summaryNodes ??= info.summaryNodes;
      }
      return { path, sha256: hash, bytes: buf.length, board, weight: weights.get(board), exploitability: file.exploitability, summary: info.summary };
    });
    if (!summaryNodes) {
      const onDisk = files.find((f) => existsSync(`${dir}/${f.path}`));
      if (!onDisk) throw new Error("no summary nodes: no manifest entry for this version and no file on disk");
      summaryNodes = summarizeFile(JSON.parse(readFileSync(`${dir}/${onDisk.path}`, "utf8"))).summaryNodes;
    }
    const entry = { id: sc.id, title: sc.title, version: sc.version, tier: sc.tier, scenario: sc.meta, summaryNodes, files };
    // The solver commit that started this version stays; a later solver change is logged above (bump the version).
    const commit = old?.version === sc.version && old.solverCommit ? old.solverCommit : solverCommit;
    if (commit) entry.solverCommit = commit;
    return entry;
  }

  const packErrors = new Map(); // scenario id → message, counted as one failure per pack and run

  /**
   * Rebuilds one set's manifest from the files on disk; writes it only when more than `generatedAt` changed. Packs of
   * the set that this run doesn't cover keep their entries; packs of the other set never enter it.
   */
  function writeManifest(set) {
    const store = stores.get(set);
    const mine = scenarios.filter((s) => s.set === set);
    const ids = new Set(mine.map((s) => s.id));
    const packs = [];
    for (const p of store.current.packs) if (!ids.has(p.id)) packs.push(p);
    for (const sc of mine) {
      let e;
      try {
        e = packEntry(sc);
      } catch (err) {
        // One broken pack must not stop the others: keep its last good entry.
        e = store.current.packs.find((p) => p.id === sc.id) ?? null;
        if (!packErrors.has(sc.id)) {
          packErrors.set(sc.id, err.message);
          stats.failed++;
          log(`${sc.id}: manifest entry kept as it was: ${err.message}`);
        }
      }
      if (e) packs.push(e);
    }
    const order = new Map(ALL_SCENARIOS.map((s, i) => [s.id, i]));
    packs.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999) || a.id.localeCompare(b.id));
    const m = { v: 1, generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), packs };
    const errs = validateManifest(m);
    if (errs.length) throw new Error(`${set} manifest invalid: ${errs.slice(0, 5).join("; ")}`);
    // The catalog's spot tags: the code's for its packs, the catalog's own for a pack the code no longer defines.
    const oldSpots = new Map((store.state.catalog?.packs ?? []).map((p) => [p.id, p.spot]));
    const scById = new Map(ALL_SCENARIOS.map((s) => [s.id, s]));
    const spot = (id) => (scById.has(id) ? scById.get(id).spot : oldSpots.get(id));
    const res = writeSetManifest(fsx, { ...store.state, manifest: store.current }, m, { hash: sha256, spot, planned: set === "app" ? plannedPacks(new Set(packs.map((p) => p.id))) : undefined });
    store.state = res.store;
    if (!res.written) return { manifest: store.current, written: false, file: store.manifestFile };
    store.current = m;
    return { manifest: m, written: true, file: store.manifestFile };
  }
  /** writeManifest for every set the run covers; the first error stops it, as one manifest did before. */
  const writeManifests = () => sets.map((set) => writeManifest(set));

  // ───── --rebuild-manifest: no solving ─────

  if (rebuild) {
    for (const file of opt["summaries-from"]) {
      let m;
      try {
        m = JSON.parse(readFileSync(resolve(file), "utf8"));
        if (m?.summaries === 1) {
          if (!Array.isArray(m.files)) throw new Error("a summaries file needs files[]");
        } else {
          const errs = validateManifest(m);
          if (errs.length) throw new Error(errs.slice(0, 3).join("; "));
        }
      } catch (e) {
        log(`${file}: not used for summaries: ${e.message}`);
        continue;
      }
      if (m.summaries === 1) {
        for (const f of m.files) if (typeof f?.path === "string" && /^[0-9a-f]{64}$/.test(f.sha256 ?? "") && f.summary) hints.set(`${f.path} ${f.sha256}`, f.summary);
      } else for (const p of m.packs) for (const f of p.files) hints.set(`${f.path} ${f.sha256}`, f.summary);
    }
    if (opt["summaries-from"].length) log(`${hints.size} file summaries read from ${opt["summaries-from"].length} manifest(s)`);
    let results;
    try {
      results = new Map(sets.map((set) => [set, writeManifest(set)]));
    } catch (e) {
      log(`manifest not written: ${e.message}`);
      process.exit(1);
    }
    for (const sc of scenarios) {
      const before = storeOf(sc).old.packs.find((p) => p.id === sc.id);
      const after = results.get(sc.set).manifest.packs.find((p) => p.id === sc.id);
      const known = new Set((before?.files ?? []).map((f) => f.path));
      const added = (after?.files ?? []).filter((f) => !known.has(f.path)).length;
      const state = packErrors.has(sc.id) ? "kept as it was" : after ? `v${after.version}, ${after.files.length} flops (${added} new)` : "no files";
      log(`${sc.id}: ${state}${after && after.version !== sc.version && !packErrors.has(sc.id) ? ` (no v${sc.version} files yet)` : ""}`);
    }
    if (hinted) log(`${hinted} summaries taken from --summaries-from, the rest rebuilt from the files`);
    for (const r of results.values()) log(r.written ? `manifest written → ${r.file}` : `${r.file}: ${existsSync(r.file) ? "unchanged, not rewritten" : "no files yet, not written"}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `failed=${stats.failed}\n`);
    process.exit(packErrors.size ? 1 : 0);
  }

  // ───── solving ─────

  const seconds = new Map(); // scenario id → solve seconds of finished flops
  const running = new Set();
  let stopping = false;
  const memLimit = reserveMb !== undefined ? totalmem() - reserveMb * 1e6 : totalmem() * 0.85;
  const runningBytes = () => [...running].reduce((s, r) => s + r.est.bytes * 1.25, 0);
  const expectedMs = (sc) => {
    const l = seconds.get(sc.id);
    return l?.length ? (l.reduce((a, b) => a + b, 0) / l.length) * 1000 * 1.1 : MIN_START_MS;
  };

  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping, abandoning ${running.size} running solve(s); files already written stay`);
    for (const r of running) r.worker.terminate();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // The worker asks over IPC (a signal on Windows would kill at once, not stop cleanly), and a run whose parent died
  // stops instead of solving on unseen.
  if (process.send) {
    process.on("message", (m) => {
      if (m?.type === "stop") onSignal("stop");
    });
    process.on("disconnect", () => onSignal("parent gone"));
  }

  function startJob(job) {
    const { sc, flop } = job;
    const iterations = Math.floor(opt.iterations !== undefined ? num("iterations", opt.iterations, 1) : sc.meta.iterations);
    const target = opt.target !== undefined ? num("target", opt.target, 0) : sc.meta.targetExploitability;
    const tag = `${sc.id} ${flop.key} (${describeTexture(flop.texture)})`;
    const est = estimate(job);
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        presolveJob: { scenario: sc.id, board: flop.key, iterations, target, checkEvery, firstCheck: Math.max(checkEvery, 20), deadline: budgetEnd - RESERVE_MS },
      },
      resourceLimits: { maxOldGenerationSizeMb: 4096 },
    });
    const r = { worker, job, est };
    running.add(r);
    log(`${tag}: start, est ${Math.round(est.bytes / 1e6)} MB, ${est.actionNodes} action nodes, up to ${iterations} it or ${target}%`);
    return new Promise((resolve) => {
      let finished = false;
      worker.on("message", (msg) => {
        if (msg.type === "progress") {
          log(`${tag}: it ${msg.iteration}, ${msg.exploitability.toFixed(3)}% (${mins(msg.seconds * 1000)} min)`);
          return;
        }
        finished = true;
        const notWritten = (reason) => send({ type: "not-written", scenario: sc.id, board: flop.key, reason });
        if (msg.type === "deadline") {
          stats.stopped++;
          log(`${tag}: budget reached at it ${msg.iteration} (${Number.isFinite(msg.exploitability) ? msg.exploitability.toFixed(3) + "%" : "not measured"}); nothing written`);
          notWritten("budget");
          return;
        }
        if (msg.tooBig) {
          stats.tooBig++;
          log(`${tag}: file would be ${(msg.bytes / 1024).toFixed(1)} KB, over the hard cap; not written`);
          notWritten("too big");
          return;
        }
        // Checks before writing: a file under v<version>/ is never replaced, so a bad one would stay for good.
        const limit = sc.meta.targetExploitability * TARGET_TOLERANCE;
        if (!(msg.exploitability <= limit) && !opt["accept-above-target"]) {
          stats.rejected++;
          log(
            `${tag}: exploitability ${msg.exploitability}% after ${msg.iterations} it is above ${+limit.toFixed(3)}% (target × ${TARGET_TOLERANCE}); not written. ` +
              "Raise the scenario's iterations and bump its version, or pass --accept-above-target.",
          );
          notWritten("above the exploitability limit");
          return;
        }
        let tpl;
        try {
          tpl = packTemplate(sc);
        } catch (e) {
          stats.failed++;
          log(`${tag}: not written, the pack's summary template could not be read: ${e.message}`);
          notWritten("summary template unreadable");
          return;
        }
        if (tpl && canon(tpl) !== canon(msg.summaryNodes)) {
          stats.failed++;
          log(`${tag}: not written, its summary nodes differ from v${sc.version}'s (the tree or its labels changed); bump the version in src/presolve/scenarios.ts`);
          notWritten("summary nodes differ from the pack's");
          return;
        }
        const path = packFilePath(sc.id, sc.version, flop.key);
        writeAtomic(`${storeOf(sc).dir}/${path}`, msg.json);
        if (!tpl) templates.set(sc.id, msg.summaryNodes);
        fresh.set(`${sc.id}/${flop.key}`, { summary: msg.summary, summaryNodes: msg.summaryNodes });
        written.push({ set: sc.set, path, sha256: sha256(Buffer.from(msg.json, "utf8")), summary: msg.summary });
        try {
          writeSummaries();
        } catch (e) {
          stats.failed++;
          log(`summaries not written: ${e.message}`);
        }
        (seconds.get(sc.id) ?? seconds.set(sc.id, []).get(sc.id)).push(msg.solveSeconds);
        stats.done++;
        send({ type: "done", scenario: sc.id, set: sc.set, board: flop.key, path, seconds: msg.solveSeconds + msg.extractSeconds, left: queue.length + running.size - 1 });
        log(
          `${tag}: done in ${mins(msg.solveSeconds * 1000)} min + ${msg.extractSeconds.toFixed(0)} s extract, ${msg.iterations} it, ` +
            `exploitability ${msg.exploitability}%, ${msg.memMb} MB in the worker, ${(msg.bytes / 1024).toFixed(1)} KB (${msg.nodes} nodes, ${msg.leftOut} left out) → ${path}`,
        );
        try {
          const { manifest: m } = writeManifest(sc.set);
          const p = m.packs.find((x) => x.id === sc.id);
          log(`manifest: ${p ? p.files.length : 0} flops in ${sc.id}`);
        } catch (e) {
          stats.failed++;
          log(`manifest not written: ${e.message}`);
        }
      });
      worker.on("error", (e) => {
        finished = true;
        stats.failed++;
        log(`${tag}: failed: ${e?.stack ?? e}`);
        send({ type: "not-written", scenario: sc.id, board: flop.key, reason: `failed: ${e?.message ?? e}` });
      });
      worker.on("exit", (code) => {
        running.delete(r);
        if (!finished && !stopping) {
          stats.failed++;
          log(`${tag}: worker exited with code ${code} before finishing`);
          send({ type: "not-written", scenario: sc.id, board: flop.key, reason: `worker exited with code ${code}` });
        }
        resolve();
      });
    });
  }

  const pending = [];
  log(
    `${queue.length} flops queued${shardTag}, ${workers} workers, budget ${mins(budgetMs)} min, memory ${(totalmem() / 1e9).toFixed(1)} GB` +
      `${reserveMb !== undefined ? ` (${(reserveMb / 1e3).toFixed(1)} GB kept free)` : ""}; ${sets.map((set) => `${set} packs → ${setDirs[set]}`).join(", ")}`,
  );
  send({ type: "queued", jobs: queue.length, workers });
  while (queue.length && !stopping) {
    if (readSkips()) {
      const before = queue.length;
      queue = queue.filter((j) => !isSkipped(j.sc, j.flop.key));
      if (queue.length < before) {
        log(`--skip-from changed: ${before - queue.length} queued flop(s) were solved elsewhere, dropped; ${queue.length} left`);
        send({ type: "dropped", count: before - queue.length, left: queue.length + running.size });
      }
      if (!queue.length) break;
    }
    const job = queue[0];
    const est = estimate(job);
    if (est.bytes / 1e6 > maxMb) {
      queue.shift();
      stats.skipped++;
      log(`${job.sc.id} ${job.flop.key}: skipped, estimateMemory ${Math.round(est.bytes / 1e6)} MB > --max-mb ${maxMb}`);
      continue;
    }
    if (Date.now() + expectedMs(job.sc) > budgetEnd - RESERVE_MS) {
      log(`not starting ${job.sc.id} ${job.flop.key}: ${mins(budgetEnd - Date.now())} min left, a flop takes ~${mins(expectedMs(job.sc))} min`);
      break;
    }
    const fits = running.size === 0 || runningBytes() + est.bytes * 1.25 <= memLimit;
    if (running.size < workers && fits) {
      queue.shift();
      pending.push(startJob(job));
      continue;
    }
    await Promise.race([...running].map((r) => new Promise((res) => r.worker.once("exit", res))));
  }
  await Promise.all(pending);

  // Keep the manifest in sync even when nothing new was solved (e.g. files added by hand); unchanged → not rewritten.
  let total = 0;
  try {
    for (const { manifest: m, written, file } of writeManifests()) {
      total += m.packs.reduce((s, p) => s + p.files.length, 0);
      if (!written) log(`${file}: ${existsSync(file) ? "unchanged, not rewritten" : "no files yet, not written"}`);
    }
  } catch (e) {
    stats.failed++;
    log(`manifest not written: ${e.message}`);
  }
  try {
    writeSummaries();
  } catch (e) {
    stats.failed++;
    log(`summaries not written: ${e.message}`);
  }
  log(
    `finished: ${stats.done} new flops, ${stats.stopped} stopped by the budget, ${stats.skipped} skipped (memory), ` +
      `${stats.tooBig} too big, ${stats.rejected} above the exploitability limit, ${stats.failed} failed; ${total} flops in the manifest(s)`,
  );
  send({ type: "finished", ...stats });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `new_flops=${stats.done}\nfailed=${stats.failed}\nrejected=${stats.rejected}\n`);
  process.exit(0);
}
