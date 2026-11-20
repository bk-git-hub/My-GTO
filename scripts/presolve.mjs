// Presolve pipeline: solves flops of the scenarios in src/presolve/scenarios.ts with our solver (src/solver)
// and writes solver chart packs to public/packs/ (format: docs/solver-packs.md, src/presolve/format.ts), and the
// calibration packs (CAL_SCENARIOS) in the same format to calibration/packs/, a separate manifest the app never reads.
//
// Usage: node scripts/presolve.mjs [options]
//   --scenario <id|all>     which pack(s), comma-separated (default all: the app's and the calibration packs; ids in
//                           src/presolve/scenarios.ts)
//   --count <n>             cover the first n flops of FLOPS_BY_PRIORITY per pack (default 100)
//   --shard <i>/<n>         solve only shard i of n (0 ≤ i < n; default 0/1, everything): flop k of FLOPS_BY_PRIORITY
//                           (its index in the full order) belongs to shard k % n, so parallel jobs started from the
//                           same commit solve disjoint flops; each shard still covers only the first --count flops,
//                           in priority order, and skips files already on disk (src/presolve/shard.ts)
//   --budget-minutes <m>    wall-clock budget for the whole run (default 50); never starts or keeps a solve past it
//   --iterations <n>        iteration cap per flop (default: the scenario's; not allowed with the default --out)
//   --target <pct>          exploitability target, % of pot (default: the scenario's; not allowed with the default --out)
//   --workers <n>           flops solved in parallel, one per worker thread (default: CPU count)
//   --max-mb <mb>           skip a flop whose estimateMemory is above this (default 2000)
//   --check-every <n>       iterations between exploitability checks (default 10)
//   --out <dir>             output directory of the app's packs (default public/packs)
//   --cal-out <dir>         output directory of the calibration packs (default calibration/packs with the default
//                           --out, else <out>/calibration, so an experiment never writes into the committed packs)
//   --accept-above-target   write a flop even when its exploitability is above the scenario's target × TARGET_TOLERANCE
//   --allow-dirty           write to the default --out although src/solver has uncommitted changes
//   --dry-run               print the plan (flops, memory estimates) and write nothing
//   --rebuild-manifest      solve nothing: rebuild manifest.json from the current-version files on disk (e.g. after
//                           copying in the files of several --shard runs), with the checks a run applies before
//                           writing a file, and write it as a run would; exits 1 when a pack's files fail them
//   --summaries-from <file> with --rebuild-manifest (repeatable): a manifest written by another run (e.g. a shard's);
//                           a file listed there with the same path and sha256 takes its summary from it, the exact
//                           one the solve produced, instead of one rebuilt from the quantized file
//
// It skips flops whose file already exists for the pack's current version, solves the next ones in priority
// order, writes each file as soon as it is done and updates manifest.json after every flop (both atomically,
// via a temp file and rename), so stopping at any point leaves a consistent pack. A solve that would run past
// the budget is abandoned and nothing is written for it. A finished solve is only written when its
// exploitability is within TARGET_TOLERANCE × the scenario's target and its summary nodes match the pack's
// (the files of a version never change, so a bad or mismatched file would stay forever). The manifest is only
// rewritten when something other than `generatedAt` changes, so a run that adds nothing leaves no diff.
// Each set of packs (scenario.set: "app" or "calibration") has its own directory and manifest.json; a run touches
// only the manifests of the sets it solves, and a calibration pack never enters public/packs/manifest.json.
// The presolve workflow runs n shards in parallel, copies their new files into one checkout and runs
// --rebuild-manifest there (.github/workflows/presolve.yml).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { load } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
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
      count: { type: "string", default: "100" },
      shard: { type: "string" },
      "budget-minutes": { type: "string", default: "50" },
      iterations: { type: "string" },
      target: { type: "string" },
      workers: { type: "string" },
      "max-mb": { type: "string", default: "2000" },
      "check-every": { type: "string", default: "10" },
      out: { type: "string", default: "public/packs" },
      "cal-out": { type: "string" },
      "accept-above-target": { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "rebuild-manifest": { type: "boolean", default: false },
      "summaries-from": { type: "string", multiple: true, default: [] },
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
  const num = (name, v, min) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < min) throw new Error(`--${name} must be a number ≥ ${min}`);
    return x;
  };
  const count = Math.floor(num("count", opt.count, 1));
  const budgetMs = num("budget-minutes", opt["budget-minutes"], 1) * 60_000;
  const workers = Math.floor(num("workers", opt.workers ?? cpus().length, 1));
  const maxMb = num("max-mb", opt["max-mb"], 1);
  const checkEvery = Math.floor(num("check-every", opt["check-every"], 1));
  const { ALL_SCENARIOS, PACK_SET_DIRS, getScenario, solverInput } = await load("src/presolve/scenarios.ts");
  const { misplacedPacks, setDirs: dirsOf, writesCommitted } = await load("src/presolve/sets.ts");
  const committed = { app: resolve(root, PACK_SET_DIRS.app), calibration: resolve(root, PACK_SET_DIRS.calibration) };
  let setDirs;
  try {
    setDirs = dirsOf({ out: resolve(root, opt.out), calOut: opt["cal-out"] !== undefined ? resolve(root, opt["cal-out"]) : undefined, committed });
  } catch (e) {
    usage(e.message);
  }
  const scenarios = opt.scenario === "all" ? ALL_SCENARIOS : opt.scenario.split(",").map((id) => getScenario(id.trim()));
  const sets = [...new Set(scenarios.map((sc) => sc.set))];
  // The committed packs: every file written there stays for good (paths are immutable), so no experiments.
  const isPublicOut = writesCommitted(setDirs, sets, committed);
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
  const { PACK_FORMAT, packFilePath, validateManifest, validateFlopFile, decodeFlopFile, summaryNodeDefs } = await load("src/presolve/format.ts");
  const { summarizeFile, MAX_BYTES } = await load("src/presolve/extract.ts");
  const { jobQueue, parseShard, shardFlops } = await load("src/presolve/shard.ts");
  let shard;
  try {
    shard = parseShard(opt.shard ?? "0/1");
  } catch (e) {
    usage(e.message);
  }
  const shardTag = shard.count > 1 ? ` (shard ${shard.index}/${shard.count})` : "";

  // One store per set the run touches: its directory, its manifest as the run found it and as it is on disk now.
  const stores = new Map(
    sets.map((set) => {
      const file = `${setDirs[set]}/manifest.json`;
      const old = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { v: PACK_FORMAT, packs: [] };
      return [set, { set, dir: setDirs[set], manifestFile: file, old, current: old }];
    }),
  );
  const storeOf = (sc) => stores.get(sc.set);
  // A pack lives in its own set's manifest only: a calibration pack in the app's manifest would be listed by the app.
  for (const store of stores.values()) {
    const wrong = misplacedPacks(store.old.packs.map((p) => p.id), store.set, ALL_SCENARIOS);
    if (wrong.length) usage(`${store.manifestFile} lists ${wrong.join(", ")}, of the other set of packs; remove them there.`);
  }
  const priorityIndex = new Map(FLOPS_BY_PRIORITY.map((f, i) => [f.key, i]));

  // The last commit that changed the solver's code (test files don't change the numbers), "-dirty" with local edits.
  let solverCommit;
  try {
    const spec = `-- src/solver ":!*.test.ts"`;
    const git = (cmd) => execSync(`git ${cmd} ${spec}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const head = git("log -1 --format=%h");
    const dirty = git("status --porcelain");
    solverCommit = head ? head + (dirty ? "-dirty" : "") : undefined;
  } catch {
    solverCommit = undefined;
  }
  if (isPublicOut && !opt["dry-run"] && solverCommit?.endsWith("-dirty") && !opt["allow-dirty"]) {
    console.error(
      `src/solver has uncommitted changes (${solverCommit}). Commit the solver first so the packs record the code that made them, ` +
        "use --out <scratch dir>, or pass --allow-dirty.",
    );
    process.exit(1);
  }

  const packDir = (sc) => `${storeOf(sc).dir}/${sc.id}/v${sc.version}`;
  const existingBoards = (sc) => {
    const dir = packDir(sc);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((f) => /^flop-([2-9TJQKAshdc]{6})\.json$/.exec(f)?.[1])
      .filter((k) => k && priorityIndex.has(k));
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
  // `queue` value, the lower values first (jobQueue: the calibration queue is solved one pack after the other).
  let queue = [];
  if (!rebuild) {
    const mine = shardFlops(FLOPS_BY_PRIORITY, count, shard); // by index in the full order, before skipping files on disk
    const of = shard.count > 1 ? `of shard ${shard.index}/${shard.count}'s ${mine.length} among the first ${count}` : `of the first ${count}`;
    const perPack = scenarios.map((sc) => {
      const have = new Set(existingBoards(sc));
      const todo = mine.filter((f) => !have.has(f.key));
      log(`${sc.id} v${sc.version}: ${have.size} flops on disk, ${todo.length} ${of} to solve${sc.queue ? ` (queue ${sc.queue})` : ""}`);
      return { queue: sc.queue ?? 0, jobs: todo.map((f) => ({ sc, flop: f })) };
    });
    queue = jobQueue(perPack);
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

  const writeAtomic = (file, text) => {
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  };
  const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
  const fresh = new Map(); // `${id}/${board}` → { summary, summaryNodes }
  const hints = new Map(); // `${path} ${sha256}` → summary, from --summaries-from manifests
  let hinted = 0;
  const stats = { done: 0, skipped: 0, stopped: 0, failed: 0, tooBig: 0, rejected: 0 };
  // JSON with sorted keys, so two manifests compare equal whatever order their fields were written in.
  const canon = (x) =>
    Array.isArray(x)
      ? `[${x.map(canon).join(",")}]`
      : x && typeof x === "object"
        ? `{${Object.keys(x)
            .filter((k) => x[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canon(x[k])}`)
            .join(",")}}`
        : JSON.stringify(x);

  // The summary template of a pack's current version: what every new file of the version must match.
  const templates = new Map(); // scenario id → summaryNodes
  function packTemplate(sc) {
    if (templates.has(sc.id)) return templates.get(sc.id);
    let tpl;
    const old = storeOf(sc).current.packs.find((p) => p.id === sc.id);
    if (old && old.version === sc.version) tpl = old.summaryNodes;
    else {
      const board = existingBoards(sc)[0];
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
      const buf = readFileSync(`${dir}/${path}`);
      const hash = sha256(buf);
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
    if (!summaryNodes) summaryNodes = summarizeFile(JSON.parse(readFileSync(`${dir}/${files[0].path}`, "utf8"))).summaryNodes;
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
    packs.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.id.localeCompare(b.id));
    const m = { v: PACK_FORMAT, generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), packs };
    const errs = validateManifest(m);
    if (errs.length) throw new Error(`${set} manifest invalid: ${errs.slice(0, 5).join("; ")}`);
    if (canon({ ...m, generatedAt: undefined }) === canon({ ...store.current, generatedAt: undefined })) return { manifest: store.current, written: false, file: store.manifestFile };
    writeAtomic(store.manifestFile, JSON.stringify(m));
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
        const errs = validateManifest(m);
        if (errs.length) throw new Error(errs.slice(0, 3).join("; "));
      } catch (e) {
        log(`${file}: not used for summaries: ${e.message}`);
        continue;
      }
      for (const p of m.packs) for (const f of p.files) hints.set(`${f.path} ${f.sha256}`, f.summary);
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
  const memLimit = totalmem() * 0.85;
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
        if (msg.type === "deadline") {
          stats.stopped++;
          log(`${tag}: budget reached at it ${msg.iteration} (${Number.isFinite(msg.exploitability) ? msg.exploitability.toFixed(3) + "%" : "not measured"}); nothing written`);
          return;
        }
        if (msg.tooBig) {
          stats.tooBig++;
          log(`${tag}: file would be ${(msg.bytes / 1024).toFixed(1)} KB, over the hard cap; not written`);
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
          return;
        }
        let tpl;
        try {
          tpl = packTemplate(sc);
        } catch (e) {
          stats.failed++;
          log(`${tag}: not written, the pack's summary template could not be read: ${e.message}`);
          return;
        }
        if (tpl && canon(tpl) !== canon(msg.summaryNodes)) {
          stats.failed++;
          log(`${tag}: not written, its summary nodes differ from v${sc.version}'s (the tree or its labels changed); bump the version in src/presolve/scenarios.ts`);
          return;
        }
        const path = packFilePath(sc.id, sc.version, flop.key);
        writeAtomic(`${storeOf(sc).dir}/${path}`, msg.json);
        if (!tpl) templates.set(sc.id, msg.summaryNodes);
        fresh.set(`${sc.id}/${flop.key}`, { summary: msg.summary, summaryNodes: msg.summaryNodes });
        (seconds.get(sc.id) ?? seconds.set(sc.id, []).get(sc.id)).push(msg.solveSeconds);
        stats.done++;
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
      });
      worker.on("exit", (code) => {
        running.delete(r);
        if (!finished && !stopping) {
          stats.failed++;
          log(`${tag}: worker exited with code ${code} before finishing`);
        }
        resolve();
      });
    });
  }

  const pending = [];
  log(`${queue.length} flops queued${shardTag}, ${workers} workers, budget ${mins(budgetMs)} min, memory ${(totalmem() / 1e9).toFixed(1)} GB; ${sets.map((set) => `${set} packs → ${setDirs[set]}`).join(", ")}`);
  while (queue.length && !stopping) {
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
  log(
    `finished: ${stats.done} new flops, ${stats.stopped} stopped by the budget, ${stats.skipped} skipped (memory), ` +
      `${stats.tooBig} too big, ${stats.rejected} above the exploitability limit, ${stats.failed} failed; ${total} flops in the manifest(s)`,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `new_flops=${stats.done}\nfailed=${stats.failed}\nrejected=${stats.rejected}\n`);
  process.exit(0);
}
