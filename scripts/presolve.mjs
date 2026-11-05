// Presolve pipeline: solves flops of the scenarios in src/presolve/scenarios.ts with our solver (src/solver)
// and writes solver chart packs to public/packs/ (format: docs/solver-packs.md, src/presolve/format.ts).
//
// Usage: node scripts/presolve.mjs [options]
//   --scenario <id|all>     which pack(s) (default all; ids in src/presolve/scenarios.ts)
//   --count <n>             cover the first n flops of FLOPS_BY_PRIORITY per pack (default 100)
//   --budget-minutes <m>    wall-clock budget for the whole run (default 50); never starts or keeps a solve past it
//   --iterations <n>        iteration cap per flop (default: the scenario's; not allowed with the default --out)
//   --target <pct>          exploitability target, % of pot (default: the scenario's; not allowed with the default --out)
//   --workers <n>           flops solved in parallel, one per worker thread (default: CPU count)
//   --max-mb <mb>           skip a flop whose estimateMemory is above this (default 2000)
//   --check-every <n>       iterations between exploitability checks (default 10)
//   --out <dir>             output directory (default public/packs)
//   --accept-above-target   write a flop even when its exploitability is above the scenario's target × TARGET_TOLERANCE
//   --allow-dirty           write to the default --out although src/solver has uncommitted changes
//   --dry-run               print the plan (flops, memory estimates) and write nothing
//
// It skips flops whose file already exists for the pack's current version, solves the next ones in priority
// order, writes each file as soon as it is done and updates manifest.json after every flop (both atomically,
// via a temp file and rename), so stopping at any point leaves a consistent pack. A solve that would run past
// the budget is abandoned and nothing is written for it. A finished solve is only written when its
// exploitability is within TARGET_TOLERANCE × the scenario's target and its summary nodes match the pack's
// (the files of a version never change, so a bad or mismatched file would stay forever). The manifest is only
// rewritten when something other than `generatedAt` changes, so a run that adds nothing leaves no diff.
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
    const res = extractFlop(input, solver.solution(), { scenario: sc.id, version: sc.version });
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
      "budget-minutes": { type: "string", default: "50" },
      iterations: { type: "string" },
      target: { type: "string" },
      workers: { type: "string" },
      "max-mb": { type: "string", default: "2000" },
      "check-every": { type: "string", default: "10" },
      out: { type: "string", default: "public/packs" },
      "accept-above-target": { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
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
  const outDir = resolve(root, opt.out);
  // The committed packs: every file written here stays for good (paths are immutable), so no experiments.
  const isPublicOut = outDir === resolve(root, "public/packs");
  if (isPublicOut && !opt["dry-run"] && (opt.iterations !== undefined || opt.target !== undefined)) {
    console.error(
      "--iterations and --target change the numbers but are not recorded in the pack, so they are only allowed with --out <scratch dir>. " +
        "To change a pack's solve targets, edit src/presolve/scenarios.ts and bump its version.",
    );
    process.exit(1);
  }
  const t0 = Date.now();
  const budgetEnd = t0 + budgetMs;
  const mins = (ms) => (ms / 60_000).toFixed(1);
  const log = (msg) => console.log(`[${mins(Date.now() - t0).padStart(5)} min] ${msg}`);

  const { SCENARIOS, getScenario, solverInput } = await load("src/presolve/scenarios.ts");
  const { FLOPS_BY_PRIORITY, describeTexture, representativeWeightsFor } = await load("src/presolve/flops.ts");
  const { estimateMemory } = await load("src/solver/index.ts");
  const { PACK_FORMAT, packFilePath, validateManifest, validateFlopFile } = await load("src/presolve/format.ts");
  const { summarizeFile } = await load("src/presolve/extract.ts");

  const scenarios = opt.scenario === "all" ? SCENARIOS : opt.scenario.split(",").map((id) => getScenario(id.trim()));
  const manifestFile = `${outDir}/manifest.json`;
  const oldManifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : { v: PACK_FORMAT, packs: [] };
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

  const packDir = (sc) => `${outDir}/${sc.id}/v${sc.version}`;
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
    const old = oldManifest.packs.find((p) => p.id === sc.id);
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

  // Jobs: the next missing flops of each pack in priority order, interleaved across packs.
  const perPack = scenarios.map((sc) => {
    const have = new Set(existingBoards(sc));
    const todo = FLOPS_BY_PRIORITY.slice(0, count).filter((f) => !have.has(f.key));
    log(`${sc.id} v${sc.version}: ${have.size} flops on disk, ${todo.length} of the first ${count} to solve`);
    return todo.map((f) => ({ sc, flop: f }));
  });
  const queue = [];
  for (let i = 0; perPack.some((l) => i < l.length); i++) for (const l of perPack) if (i < l.length) queue.push(l[i]);

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
    console.log(`dry run: ${queue.length} flops planned, ${workers} workers, budget ${mins(budgetMs)} min; nothing written`);
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
  let current = oldManifest; // the manifest as it is on disk now

  // The summary template of a pack's current version: what every new file of the version must match.
  const templates = new Map(); // scenario id → summaryNodes
  function packTemplate(sc) {
    if (templates.has(sc.id)) return templates.get(sc.id);
    let tpl;
    const old = current.packs.find((p) => p.id === sc.id);
    if (old && old.version === sc.version) tpl = old.summaryNodes;
    else {
      const board = existingBoards(sc)[0];
      if (board) tpl = summarizeFile(JSON.parse(readFileSync(`${outDir}/${packFilePath(sc.id, sc.version, board)}`, "utf8"))).summaryNodes;
    }
    if (tpl) templates.set(sc.id, tpl);
    return tpl;
  }

  function packEntry(sc) {
    const boards = existingBoards(sc).sort((a, b) => priorityIndex.get(a) - priorityIndex.get(b));
    const old = oldManifest.packs.find((p) => p.id === sc.id);
    if (!boards.length) return old ?? null;
    const oldFiles = new Map((old?.files ?? []).map((f) => [f.path, f]));
    const weights = representativeWeightsFor(boards);
    let summaryNodes = old && old.version === sc.version ? old.summaryNodes : undefined;
    const files = boards.map((board) => {
      const path = packFilePath(sc.id, sc.version, board);
      const buf = readFileSync(`${outDir}/${path}`);
      const hash = sha256(buf);
      const text = buf.toString("utf8");
      const file = JSON.parse(text);
      let info = fresh.get(`${sc.id}/${board}`);
      const prev = oldFiles.get(path);
      if (!info && prev && prev.sha256 === hash) info = { summary: prev.summary };
      if (!info) {
        const errs = validateFlopFile(file);
        if (errs.length) throw new Error(`${path}: ${errs.slice(0, 3).join("; ")}`);
        info = summarizeFile(file);
        log(`${path}: no manifest entry, summary rebuilt from the file`);
      }
      if (info.summaryNodes) {
        if (summaryNodes && !sameJson(summaryNodes, info.summaryNodes)) throw new Error(`${path}: its summary nodes differ from the pack's (tree changed without a version bump?)`);
        summaryNodes ??= info.summaryNodes;
      }
      return { path, sha256: hash, bytes: buf.length, board, weight: weights.get(board), exploitability: file.exploitability, summary: info.summary };
    });
    if (!summaryNodes) summaryNodes = summarizeFile(JSON.parse(readFileSync(`${outDir}/${files[0].path}`, "utf8"))).summaryNodes;
    const entry = { id: sc.id, title: sc.title, version: sc.version, tier: sc.tier, scenario: sc.meta, summaryNodes, files };
    // The solver commit that started this version stays; a later solver change is logged above (bump the version).
    const commit = old?.version === sc.version && old.solverCommit ? old.solverCommit : solverCommit;
    if (commit) entry.solverCommit = commit;
    return entry;
  }

  const packErrors = new Map(); // scenario id → message, counted as one failure per pack and run

  /** Rebuilds the manifest from the files on disk; writes it only when more than `generatedAt` changed. */
  function writeManifest() {
    const ids = new Set(scenarios.map((s) => s.id));
    const packs = [];
    for (const p of current.packs) if (!ids.has(p.id)) packs.push(p);
    for (const sc of scenarios) {
      let e;
      try {
        e = packEntry(sc);
      } catch (err) {
        // One broken pack must not stop the others: keep its last good entry.
        e = current.packs.find((p) => p.id === sc.id) ?? null;
        if (!packErrors.has(sc.id)) {
          packErrors.set(sc.id, err.message);
          stats.failed++;
          log(`${sc.id}: manifest entry kept as it was: ${err.message}`);
        }
      }
      if (e) packs.push(e);
    }
    const order = new Map(SCENARIOS.map((s, i) => [s.id, i]));
    packs.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.id.localeCompare(b.id));
    const m = { v: PACK_FORMAT, generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"), packs };
    const errs = validateManifest(m);
    if (errs.length) throw new Error(`manifest invalid: ${errs.slice(0, 5).join("; ")}`);
    if (canon({ ...m, generatedAt: undefined }) === canon({ ...current, generatedAt: undefined })) return { manifest: current, written: false };
    writeAtomic(manifestFile, JSON.stringify(m));
    current = m;
    return { manifest: m, written: true };
  }

  // ───── solving ─────

  const stats = { done: 0, skipped: 0, stopped: 0, failed: 0, tooBig: 0, rejected: 0 };
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
        writeAtomic(`${outDir}/${path}`, msg.json);
        if (!tpl) templates.set(sc.id, msg.summaryNodes);
        fresh.set(`${sc.id}/${flop.key}`, { summary: msg.summary, summaryNodes: msg.summaryNodes });
        (seconds.get(sc.id) ?? seconds.set(sc.id, []).get(sc.id)).push(msg.solveSeconds);
        stats.done++;
        log(
          `${tag}: done in ${mins(msg.solveSeconds * 1000)} min + ${msg.extractSeconds.toFixed(0)} s extract, ${msg.iterations} it, ` +
            `exploitability ${msg.exploitability}%, ${msg.memMb} MB in the worker, ${(msg.bytes / 1024).toFixed(1)} KB (${msg.nodes} nodes, ${msg.leftOut} left out) → ${path}`,
        );
        try {
          const { manifest: m } = writeManifest();
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
  log(`${queue.length} flops queued, ${workers} workers, budget ${mins(budgetMs)} min, memory ${(totalmem() / 1e9).toFixed(1)} GB`);
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
    const { manifest: m, written } = writeManifest();
    total = m.packs.reduce((s, p) => s + p.files.length, 0);
    if (!written) log("manifest unchanged, not rewritten");
  } catch (e) {
    stats.failed++;
    log(`manifest not written: ${e.message}`);
  }
  log(
    `finished: ${stats.done} new flops, ${stats.stopped} stopped by the budget, ${stats.skipped} skipped (memory), ` +
      `${stats.tooBig} too big, ${stats.rejected} above the exploitability limit, ${stats.failed} failed; ${total} flops in the manifest`,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `new_flops=${stats.done}\nfailed=${stats.failed}\nrejected=${stats.rejected}\n`);
  process.exit(0);
}
