// Solves the 9-handed BB-ante preflop stages with our own DCFR engine (src/poker/preflop) and writes the solver
// chart data: src/data/sets/preflopIndex.ts (every shipped stage's metadata) and src/data/sets/preflopStages/<id>.ts (one
// stage per file, loaded by the app on first use). Design: docs/preflop-solver.md (§ numbers below are its sections).
//
// Usage: node scripts/make-preflop.mjs [flags]
//   --stages a,b,...    stages to solve (default: every preset of tree.ts, the check-only ones included)
//   --iterations N      cap the schedule at N iterations (start min(1500, N), max N) and the sensitivity solves at
//                       min(1000, N): quick tests. Gates still apply, but any N other than §4.6's 4,000 is a DRAFT.
//   --check             print every check, run the determinism check (35bb-2 twice at 300 iterations) and compare
//                       every output file with the committed one; exit 1 if any would change, be added or be removed.
//                       Writes no data file.
//   --no-sensitivity    skip the five sensitivity solves per stage (§6.6)  } a DRAFT: move 0, confidence from the
//   --no-twostart       skip PF-TWOSTART (§5.4) and PF-TWOSTART-RFI        } checks that ran, PREFLOP_DRAFT_STAGES
//   --ignore-gates      export stages that fail their gates, as drafts (development only; no cold4 fallback); also
//                       lets a PF-SANITY-1/2/3 failure or an equity table the fit was not made with through
//   --dump DIR          write per stage DIR/<stage>/{config.json, sigma.f32, nodes.json} for reviewers
//   --summary-dir DIR   where summary-<stage>.txt goes (default node_modules/.cache/preflop)
//   --workers N         solves at once (default min(4, CPUs)); the output does not depend on it
//   --ladder MODE       "per-group" (default) or "shared": how the §6.5 size ladder raises its groups
//   --out DIR           directory the data files go to (default src/data/sets: preflopIndex.ts, preflopStages/*.ts;
//                       a write removes stage files no longer produced and the old single preflopData.ts). A run whose
//                       --stages leave out a stage that ships needs an explicit --out, so a subset never replaces the
//                       committed files.
//   --check-stage-out DIR  also write each check-only stage's export as DIR/<id>.json (never into the app's data)
//
// Every solve runs in its own worker thread; at most --workers run at once. Per stage (§4.6, §5.3): the main solve
// on the §4.6 schedule with the §5.3 gates; if a gate fails, or the gates pass but PF-DATA-1's counts cannot be met
// on its reach (§2.8), or PF-DEGEN-1 finds a seat that never min-raises, one re-solve with cold4 "none" (none when the
// preset is already on "none"); if that fails too, an optional or check-only stage is dropped and a required one fails
// the run (exit 1, nothing written). Then PF-TWOSTART (with PF-TWOSTART-RFI, which has the same consequence) and, for
// a shipped stage with flops, the five 1,000-iteration sensitivity solves; the PF-* checks, the size ladder, the
// close-call marks, model-sensitive cells and artifact flags (§6.6, §6.9, §6.10: one best-response evaluation of σ̄
// per stage, after the ladder, so they never change which spots ship) and the data files. Check-only stages (status
// "check": 25bb-2, 20bb-2, 15bb-2 until the low-SPR calibration) go through the same export in memory for their
// numbers, PF-OVERLAP and data checks, and are never written. A push/fold stage has no flop, so no sensitivity solves.
// Every output is a pure function of the inputs: no timestamps, fixed ordering, independent of the worker count.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { equityTableSha256, load, loadEquityTable } from "./equity-cache.mjs";
import { compareFiles, fileSizes, INDEX_FILE, preflopFiles, STAGE_GZIP_LIMIT, stageFile, TOTAL_GZIP_LIMIT, writeFiles } from "./preflop-files.mjs";

const root = new URL("..", import.meta.url).pathname;
const DEFAULT_OUT = root + "src/data/sets";
const N = 169;
const SENS_ITERATIONS = 1000;
/** §4.6's last iteration (runSchedule's default max): --iterations N with any other N is not the release schedule. */
const SCHEDULE_MAX = 4000;
const TWOSTART_WARMUP = 50;
const DET_STAGE = "35bb-2";
const DET_ITERATIONS = 300;
/** PF-OVERLAP: open + jam totals per seat within this many pp of shortNash at the same stack. */
const OVERLAP_PP = 5;
/** PF-OVERLAP: a seat from UTG to CO this many pp off shortNash counts as a failure (hold the stage; printed). */
const OVERLAP_FAIL_PP = 8;
/** The push/fold stage's pointers (§1.2): shorter stacks, and 12–25bb until the short stages ship. */
const PUSHFOLD_SHORTER_TEXT = "더 짧은 스택은 '푸시/폴드 내쉬' 세트를 보세요.";
const PUSHFOLD_SHORTNASH_TEXT = "12~25bb는 숏스택 단계를 보정하는 동안 '숏스택 내쉬' 세트를 보세요.";

// ───────────────────────── worker ─────────────────────────

if (!isMainThread && workerData?.preflopWorker) {
  const treeM = await load("src/poker/preflop/tree.ts");
  const solveM = await load("src/poker/preflop/solve.ts");
  const valueM = await load("src/poker/preflop/value.ts");
  const ex = await load("src/poker/preflop/export.ts");
  const { EQR_FIT } = await load("src/poker/preflop/eqrFit.ts");
  const { handFeatures } = await load("src/poker/preflop/features.ts");
  const { ALL_HANDS } = await load("src/poker/cards.ts");
  const table = { eq: workerData.eq, cnt: workerData.cnt };
  const features = valueM.featureMatrix(N, handFeatures);

  const runJob = (job) => {
    const t0 = Date.now();
    const tr = treeM.buildTree(treeM.stageConfig(job.stage, job.overrides));
    const solver = solveM.createSolver(tr, table, { valuation: ex.valuationForStage(tr.cfg, EQR_FIT, features, job.variant) });
    let iterMs = 0, iterCount = 0;
    // The schedule reads t and iterations through the object it is given, so the timing wrapper forwards them.
    const timed = {
      ...solver,
      get t() {
        return solver.t;
      },
      get iterations() {
        return solver.iterations;
      },
      iterate(k = 1) {
        const s = performance.now();
        solver.iterate(k);
        iterMs += performance.now() - s;
        iterCount += k;
      },
    };
    const log = (text) => parentPort.postMessage({ type: "log", text: `[${job.label}] ${text}` });
    const timing = () => ({ seconds: (Date.now() - t0) / 1000, msPerIteration: iterCount ? iterMs / iterCount : 0 });

    if (job.kind === "sens") {
      timed.iterate(job.iterations);
      const avg = solver.average();
      const ev = solver.evaluate(avg);
      return { result: { iterations: solver.t, maxGainMbb: ev.maxGainMbb, nashConvMbb: ev.nashConvMbb, ...timing() }, avg };
    }

    // main / twostart / fixed: the exported set at each gate check is the §6.5 count ladder on that check's occ.
    const classes = ex.classifyTree(tr);
    let lastEv = null, lastSet = null;
    const exported = (p, ev) => {
      if (ev !== lastEv) {
        lastEv = ev;
        lastSet = ex.chooseLadder(tr, classes, ev.occ, { shared: job.shared }).set.exported;
      }
      return lastSet[p] === 1;
    };
    const onCheck = (r) =>
      log(
        `check at ${r.iterations}: max gain ${r.maxGainMbb.toFixed(3)}, NashConv ${r.nashConvMbb.toFixed(3)}, snapped ${r.snappedMaxGainMbb.toFixed(3)} mbb; ` +
          `worst exported regret ${r.worstExportedRegret.toFixed(4)} bb, ${r.exportedCount} exported; ${r.failures.join(",") || "PASS"} ` +
          `(${((Date.now() - t0) / 1000).toFixed(0)} s, ${(iterMs / Math.max(1, iterCount)).toFixed(0)} ms/it)`,
      );
    let sched;
    if (job.kind === "fixed") {
      timed.iterate(job.iterations);
      const r = solveM.checkGates(timed, { exported });
      onCheck(r);
      sched = { pass: r.pass, iterations: solver.t, polished: false, report: r, history: [r] };
    } else {
      sched = solveM.runSchedule(timed, {
        ...job.schedule,
        twoStart: job.kind === "twostart" ? TWOSTART_WARMUP : undefined,
        exported,
        onCheck,
      });
    }
    const avg = solver.average();
    const r = sched.report, ev = r.evaluation;
    const names = treeM.seatNames(tr.n);
    return {
      result: {
        pass: sched.pass,
        polished: sched.polished,
        iterations: sched.iterations,
        failures: r.failures,
        warnings: r.warnings,
        maxGainMbb: ev.maxGainMbb,
        nashConvMbb: ev.nashConvMbb,
        gainMbb: ev.gainMbb,
        ev: ev.ev,
        evSum: ev.evSum,
        snappedMaxGainMbb: r.snappedMaxGainMbb,
        worstExportedRegret: r.worstExportedRegret,
        regretFailures: r.regretFailures.length,
        exportedCount: r.exportedCount,
        frozen: ev.frozen,
        negativeShares: {
          count: ev.negativeShares.count,
          occ: ev.negativeShares.occ,
          worst: ev.negativeShares.worst.slice(0, 5).map((x) => `${names[x.seat]} ${ALL_HANDS[x.hand]} share ${x.share.toFixed(3)} at ${treeM.lineText(tr.terms[x.term].line, tr.n)}`),
        },
        history: sched.history.map((h) => ({
          iterations: h.iterations,
          maxGainMbb: h.maxGainMbb,
          nashConvMbb: h.nashConvMbb,
          snappedMaxGainMbb: h.snappedMaxGainMbb,
          worstExportedRegret: h.worstExportedRegret,
          failures: h.failures,
        })),
        occ: ev.occ,
        reach: ev.reach,
        localRegret: ev.localRegret,
        ...timing(),
      },
      avg,
    };
  };

  // One job per worker thread: a thread that ran one solve ran the next ones up to twice as slowly (measured: 35bb
  // 78 ms/iteration in a fresh thread, 25bb 129 and the sensitivity solves about 150 after it in the same thread).
  const job = workerData.job;
  try {
    const { result, avg } = runJob(job);
    const transfer = [avg.buffer];
    for (const k of ["occ", "reach", "localRegret"]) if (result[k]) transfer.push(result[k].buffer);
    parentPort.postMessage({ type: "done", result, avg }, transfer);
  } catch (e) {
    parentPort.postMessage({ type: "error", message: e?.stack ?? String(e) });
  }
}

// ───────────────────────── main ─────────────────────────

function parseArgs(argv) {
  const a = {
    stages: null,
    iterations: null,
    check: false,
    sensitivity: true,
    twostart: true,
    ignoreGates: false,
    dump: null,
    summaryDir: root + "node_modules/.cache/preflop",
    workers: Math.max(1, Math.min(4, cpus().length)),
    ladder: "per-group",
    out: DEFAULT_OUT,
    checkStageOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${f} needs a value`);
      return argv[++i];
    };
    if (f === "--stages") a.stages = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (f === "--iterations") a.iterations = Number(next());
    else if (f === "--check") a.check = true;
    else if (f === "--no-sensitivity") a.sensitivity = false;
    else if (f === "--no-twostart") a.twostart = false;
    else if (f === "--ignore-gates") a.ignoreGates = true;
    else if (f === "--dump") a.dump = next();
    else if (f === "--summary-dir") a.summaryDir = next();
    else if (f === "--workers") a.workers = Number(next());
    else if (f === "--ladder") a.ladder = next();
    else if (f === "--out") a.out = next().replace(/\/+$/, "");
    else if (f === "--check-stage-out") a.checkStageOut = next();
    else throw new Error(`unknown flag ${f}`);
  }
  if (a.iterations !== null && !(Number.isInteger(a.iterations) && a.iterations > 0)) throw new Error("--iterations must be a positive integer");
  if (!(Number.isInteger(a.workers) && a.workers > 0)) throw new Error("--workers must be a positive integer");
  if (a.ladder !== "per-group" && a.ladder !== "shared") throw new Error('--ladder is "per-group" or "shared"');
  return a;
}

/** Runs each job in its own worker thread, at most `size` at once, first in first out. */
class Pool {
  constructor(size, table, onLog) {
    this.size = size;
    this.table = table;
    this.onLog = onLog;
    this.queue = [];
    this.running = new Set();
  }
  run(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.dispatch();
    });
  }
  dispatch() {
    while (this.running.size < this.size && this.queue.length) {
      const { job, resolve, reject } = this.queue.shift();
      const w = new Worker(new URL(import.meta.url), { workerData: { preflopWorker: true, eq: this.table.eq, cnt: this.table.cnt, job } });
      let settled = false;
      const settle = (f, x) => {
        if (settled) return;
        settled = true;
        f(x);
      };
      this.running.add(w);
      w.on("message", (m) => {
        if (m.type === "log") this.onLog(m.text);
        else {
          if (m.type === "done") settle(resolve, { ...m.result, avg: m.avg });
          else settle(reject, new Error(`${job.label}: ${m.message}`));
          w.terminate();
        }
      });
      w.on("error", (e) => settle(reject, new Error(`${job.label}: ${e?.stack ?? e}`)));
      w.on("exit", () => {
        this.running.delete(w);
        settle(reject, new Error(`${job.label}: the worker exited without a result`));
        this.dispatch();
      });
    }
  }
  async close() {
    this.queue.length = 0;
    await Promise.all([...this.running].map((w) => w.terminate()));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const treeM = await load("src/poker/preflop/tree.ts");
  const solveM = await load("src/poker/preflop/solve.ts");
  const valueM = await load("src/poker/preflop/value.ts");
  const ex = await load("src/poker/preflop/export.ts");
  const { EQR_FIT } = await load("src/poker/preflop/eqrFit.ts");
  const { handFeatures } = await load("src/poker/preflop/features.ts");
  const { ALL_HANDS } = await load("src/poker/cards.ts");
  const { parseRange } = await load("src/poker/range.ts");
  const { SHORT_NASH_OPEN, SHORT_NASH_STAGES } = await load("src/data/sets/shortNashData.ts");
  const { NASH_STAGES } = await load("src/data/sets/nashData.ts");
  const table = await loadEquityTable();
  const tableSha = equityTableSha256(table);
  if (tableSha !== EQR_FIT.equityTable) {
    // The fit's coefficients were measured with that table's equities; charts from another table mix two models.
    const msg = `the equity table (${tableSha.slice(0, 12)}) is not the one eqrFit.ts was fitted on (${EQR_FIT.equityTable.slice(0, 12)})`;
    if (!args.ignoreGates) throw new Error(`${msg}; refit (scripts/fit-realization.mjs) or pass --ignore-gates for a development run`);
    console.log(`WARNING: ${msg}`);
  }
  const features = valueM.featureMatrix(N, handFeatures);
  const cw = solveM.comboWeights();

  const presets = treeM.STAGE_PRESETS;
  const wanted = args.stages ?? presets.map((p) => p.id);
  for (const id of wanted) if (!presets.some((p) => p.id === id)) throw new Error(`unknown stage ${id}`);
  const stageIds = presets.map((p) => p.id).filter((id) => wanted.includes(id));
  // The committed files are the full set: a subset run may compare (--check) but writes only to an explicit --out.
  const leftOut = presets.filter((p) => p.status !== "check" && !stageIds.includes(p.id)).map((p) => p.id);
  if (leftOut.length && args.out === DEFAULT_OUT && !args.check)
    throw new Error(`--stages leaves out ${leftOut.join(", ")}: pass --out DIR so the committed ${DEFAULT_OUT.replace(root, "")} files are not replaced by a subset`);
  // §4.6's schedule is start 1,500, step 250, max 4,000 and 1,000-iteration sensitivity solves; anything else is a draft.
  const iterationsCapped = args.iterations !== null && args.iterations !== SCHEDULE_MAX;
  const schedule = args.iterations ? { start: Math.min(1500, args.iterations), step: 250, max: args.iterations } : {};
  const sensIterations = Math.min(SENS_ITERATIONS, args.iterations ?? SENS_ITERATIONS);
  const shared = args.ladder === "shared";
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
  console.log(
    `make-preflop: stages ${stageIds.join(", ")}; ${args.workers} worker(s); table ${tableSha.slice(0, 12)}; fit ${EQR_FIT.sha256.slice(0, 12)}` +
      `${args.iterations ? `; iterations capped at ${args.iterations}` : ""}${args.sensitivity ? "" : "; no sensitivity"}${args.twostart ? "" : "; no two-start"}` +
      `${args.ignoreGates ? "; gates ignored" : ""}; ladder ${args.ladder}`,
  );

  const pool = new Pool(args.workers, table, (text) => console.log(`  ${elapsed()} ${text}`));
  const states = new Map();
  try {
    // ── solves ──
    await Promise.all(stageIds.map((id) => runStage(id)));
    let det = null;
    if (args.check) {
      const runs = await Promise.all([1, 2].map((k) => pool.run({ kind: "fixed", stage: DET_STAGE, overrides: {}, iterations: DET_ITERATIONS, shared, label: `${DET_STAGE} det ${k}` })));
      det = runs;
    }
    await pool.close();
    return finish(det);
  } catch (e) {
    await pool.close();
    throw e;
  }

  /**
   * One stage: the main solve and its fallback (§2.8, §4.6), PF-DEGEN-1, then PF-TWOSTART with PF-TWOSTART-RFI and the
   * sensitivity solves. A failure of PF-DEGEN-1 or PF-TWOSTART-RFI on a cold-jam solve gets the same single cold4 "none"
   * re-solve as a gate failure (and the two-start and sensitivity solves are redone for it); on a stage already on
   * "none" the optional/required rule applies (a check-only stage is treated like an optional one).
   */
  async function runStage(id) {
    const preset = presets.find((p) => p.id === id);
    const st = { id, preset, status: preset.status, overrides: {}, fallback: false, dropped: null, failed: null, main: null, tree: null, classes: null, moves: null, sens: [], sensAvgs: null, twoStart: null, notes: [] };
    states.set(id, st);
    const gates = ex.degenGates(treeM.stageConfig(id));
    const solveMain = (overrides, tag) =>
      pool.run({ kind: "main", stage: id, overrides, schedule, shared, label: `${id} ${tag}` }).then((r) => {
        console.log(
          `  ${elapsed()} [${id} ${tag}] ${r.pass ? "PASS" : `FAIL (${r.failures.join(", ")})`} at ${r.iterations} iterations${r.polished ? " (polished)" : ""}, ${r.seconds.toFixed(0)} s, ${r.msPerIteration.toFixed(0)} ms/it`,
        );
        return r;
      });
    /** The rule for a stage that cannot ship: dropped (optional, check) or failed (required); a note with --ignore-gates. */
    const reject = (why) => {
      if (args.ignoreGates) {
        st.notes.push(`gates ignored: ${why}`);
        return false;
      }
      if (st.status === "required") st.failed = why;
      else st.dropped = why;
      return true;
    };
    for (;;) {
      const cfg = treeM.stageConfig(id, st.overrides);
      // One cold4 "none" re-solve per stage, and none for a stage that is already on "none" (preset or fallback).
      const canFallback = !args.ignoreGates && !st.fallback && cfg.cold4 === "jam";
      const fallback = (why) => {
        st.notes.push(`${why}; re-solved with cold4 "none"`);
        st.overrides = { cold4: "none" };
        st.fallback = true;
      };
      const tag = st.fallback ? "cold4 none" : "main";
      const r = await solveMain(st.overrides, tag);
      const tree = treeM.buildTree(cfg);
      const classes = ex.classifyTree(tree);
      if (!r.pass && canFallback) {
        fallback(`main solve failed (${r.failures.join(", ")}) at ${r.iterations}`);
        continue;
      }
      if (r.pass && canFallback) {
        // §2.8: a cold-jam solve can pass its gates in a degenerate equilibrium (35bb: UTG opens only by jamming), whose
        // reach leaves too few spots for PF-DATA-1's counts. That is the same equilibrium the gate failure signals, so
        // it gets the same single re-solve without cold jams. No gate or count threshold changes.
        const ch = ex.chooseLadder(tree, classes, r.occ, { shared });
        if (!ch.ok) {
          fallback(`main solve passed its gates at ${r.iterations} but PF-DATA-1 counts cannot be met (${ch.problems.join("; ")})`);
          continue;
        }
      }
      // PF-DEGEN-1 (§5.3): every seat UTG..BTN min-raises at least 1% first in.
      const degen = gates.degen ? ex.degenerateOpeners(tree, r.avg, cw) : [];
      st.degen = gates.degen ? degen : null;
      if (degen.length) {
        const why = `PF-DEGEN-1: ${degen.map((x) => `${x.seat} opens ${(x.open * 100).toFixed(2)}%`).join(", ")} (a jam-only first-in profile)`;
        if (canFallback) {
          fallback(`${why} at ${r.iterations}`);
          continue;
        }
        if (reject(why)) {
          st.main = r;
          st.tree = tree;
          st.classes = classes;
          return;
        }
      }
      st.main = r;
      st.tree = tree;
      st.classes = classes;
      if (!r.pass) {
        const why = `gates failed: ${r.failures.join(", ")} (max gain ${r.maxGainMbb.toFixed(3)}, NashConv ${r.nashConvMbb.toFixed(3)}, snapped ${r.snappedMaxGainMbb.toFixed(3)} mbb, worst exported regret ${r.worstExportedRegret.toFixed(4)} bb)`;
        if (reject(why)) return;
      }

      // Candidates: every node any ladder step could export (rfi, or occ ≥ 0.1%), with the main solve's own raw reach.
      st.candidates = [];
      st.rho = new Map();
      for (let p = 0; p < tree.nodeCount; p++) {
        if (classes[p].kind !== "rfi" && !(r.occ[p] >= ex.BASE_THRESHOLD)) continue;
        st.candidates.push(p);
        st.rho.set(p, solveM.ownReach(tree, r.avg, p, N));
      }
      const jobs = [];
      let rfiProblems = null;
      st.twoStart = null;
      if (args.twostart) {
        jobs.push(
          pool.run({ kind: "twostart", stage: id, overrides: st.overrides, schedule, shared, label: `${id} two-start${st.fallback ? " (cold4 none)" : ""}` }).then((t) => {
            // PF-TWOSTART (§5.4): action shares of each solve's own reaching range, at nodes with reach ≥ 1%.
            const flags = new Set(), diffs = [];
            for (const p of st.candidates) {
              if (!(r.reach[p] >= ex.TWOSTART_MIN_REACH)) continue;
              const a = solveM.actionShares(tree, r.avg, p, cw, st.rho.get(p));
              const b = solveM.actionShares(tree, t.avg, p, cw, solveM.ownReach(tree, t.avg, p, N));
              let d = 0;
              for (let k = 0; k < a.length; k++) d = Math.max(d, Math.abs(a[k] - b[k]));
              if (d > ex.TWOSTART_TOLERANCE) flags.add(p);
              diffs.push({ p, d });
            }
            diffs.sort((x, y) => y.d - x.d || x.p - y.p);
            // PF-TWOSTART-RFI (§5.3): every first-in node within 2pp.
            rfiProblems = gates.twoStartRfi ? ex.twoStartRfiProblems(tree, classes, r.avg, t.avg, cw) : null;
            st.twoStart = { flags, worst: diffs.slice(0, 8), rfi: rfiProblems, rfiMax: maxRfiDiff(tree, classes, r.avg, t.avg), result: { ...t, avg: null } };
            console.log(
              `  ${elapsed()} [${id} two-start] ${t.pass ? "PASS" : `FAIL (${t.failures.join(", ")})`} at ${t.iterations}; ${flags.size} scenario(s) differ by more than 2pp` +
                `${rfiProblems?.length ? `; PF-TWOSTART-RFI FAIL (${rfiProblems.map((x) => `${x.id} ${(x.d * 100).toFixed(1)}pp`).join(", ")})` : ""}`,
            );
          }),
        );
      }
      // The sensitivity solves vary the realization model, so only a shipped stage with flops runs them.
      const sensOn = args.sensitivity && st.status !== "check" && ex.hasFlop(tree);
      st.moves = null;
      st.sens = [];
      st.sensAvgs = null;
      if (sensOn) {
        st.moves = new Float64Array(tree.nodeCount);
        st.sensAvgs = [];
        for (const v of ex.SENSITIVITY_VARIANTS) {
          jobs.push(
            pool.run({ kind: "sens", stage: id, overrides: st.overrides, variant: v.id, iterations: sensIterations, label: `${id} sens ${v.id}` }).then((s) => {
              // §6.6: move = max over the variants of the ρ-weighted mean total variation.
              const perNode = new Map();
              for (const p of st.candidates) {
                const m = ex.moveAt(tree, r.avg, s.avg, p, st.rho.get(p), cw);
                perNode.set(p, m);
                if (m > st.moves[p]) st.moves[p] = m;
              }
              st.sens.push({ variant: v.id, label: v.label, maxGainMbb: s.maxGainMbb, iterations: s.iterations, seconds: s.seconds, perNode });
              // σ̄ of the variant for the model-sensitive cells (§6.6), single precision: only shares against 0.5 and
              // the top action are read.
              st.sensAvgs.push({ variant: v.id, avg: Float32Array.from(s.avg) });
              console.log(`  ${elapsed()} [${id} sens ${v.id}] ${s.iterations} iterations, max gain ${s.maxGainMbb.toFixed(2)} mbb, ${s.seconds.toFixed(0)} s`);
            }),
          );
        }
      }
      await Promise.all(jobs);
      st.sens.sort((a, b) => a.variant.localeCompare(b.variant));
      st.sensAvgs?.sort((a, b) => a.variant.localeCompare(b.variant));
      if (rfiProblems?.length) {
        const why = `PF-TWOSTART-RFI: ${rfiProblems.map((x) => `${x.id} ${(x.d * 100).toFixed(1)}pp`).join(", ")} between the two solves`;
        if (canFallback) {
          fallback(why);
          continue;
        }
        if (reject(why)) return;
      }
      return;
    }
  }

  /** The largest first-in difference between two solves, pp, and its spot. */
  function maxRfiDiff(tree, classes, a, b) {
    let best = { id: null, d: 0 };
    for (let p = 0; p < tree.nodeCount; p++) {
      if (classes[p].kind !== "rfi") continue;
      const x = solveM.actionShares(tree, a, p, cw), y = solveM.actionShares(tree, b, p, cw);
      for (let k = 0; k < x.length; k++) if (Math.abs(x[k] - y[k]) > best.d) best = { id: classes[p].id, d: Math.abs(x[k] - y[k]) };
    }
    return best;
  }

  function finish(det) {
    let exitCode = 0;
    const all = stageIds.map((id) => states.get(id));
    const isShip = (st) => st.status !== "check";
    for (const s of all.filter((x) => x.dropped)) console.log(`\n${s.id}: DROPPED (${isShip(s) ? "optional" : "check-only"} stage) — ${s.dropped}`);
    for (const s of all.filter((x) => x.failed)) console.log(`\n${s.id}: FAILED (required stage) — ${s.failed}`);
    /** A stage that cannot ship from here on: a required one fails the run, an optional or check-only one is dropped. */
    const drop = (st, why) => {
      if (st.status === "required") st.failed = why;
      else st.dropped = why;
      console.log(`\n${st.id}: ${st.status === "required" ? "FAILED" : "DROPPED"} — ${why}`);
    };
    // Check-only stages go through the same export, in memory, for their numbers and checks; they are never written.
    const exportable = all.filter((s) => s.main && !s.dropped && !s.failed);

    // ── size ladder (§6.5): per stage the count ladder, then gzip steps per stage file (PF-SIZE-1) ──
    const evalSolvers = new Map();
    const evalSolver = (st) => {
      if (!evalSolvers.has(st.id)) evalSolvers.set(st.id, solveM.createSolver(st.tree, table, { valuation: ex.valuationForStage(st.tree.cfg, EQR_FIT, features) }));
      return evalSolvers.get(st.id);
    };
    const snappedCache = new Map();
    const snappedGain = (st, set) => {
      const nodes = [];
      for (let p = 0; p < st.tree.nodeCount; p++) if (set[p]) nodes.push(p);
      const key = `${st.id}|${nodes.join(",")}`;
      if (!snappedCache.has(key)) snappedCache.set(key, evalSolver(st).evaluate(solveM.snapStrategy(st.tree, st.main.avg, nodes, N)).maxGainMbb);
      return snappedCache.get(key);
    };
    const steps = new Map();
    for (const st of exportable) {
      const ch = ex.chooseLadder(st.tree, st.classes, st.main.occ, { shared });
      st.countLadder = ch;
      if (!ch.ok) drop(st, `PF-DATA-1 counts cannot be met: ${ch.problems.join("; ")}`);
      else steps.set(st.id, ch.steps);
    }
    let live = exportable.filter((s) => !s.dropped && !s.failed);
    let exports = null, draftIds = [];
    /** The push/fold stage's pointer to the sets for shorter stacks and, until the short stages ship, for 12–25bb. */
    const pushFoldNote = () => {
      const parts = [PUSHFOLD_SHORTER_TEXT];
      if (!live.some((x) => isShip(x) && x.tree.cfg.mode === "full" && x.tree.cfg.S < 35)) parts.push(PUSHFOLD_SHORTNASH_TEXT);
      return parts.join(" ");
    };
    const exportOf = (st) => {
      const set = ex.exportSet(st.tree, st.classes, st.main.occ, steps.get(st.id));
      const out = ex.exportStage({
        id: st.id,
        label: ex.STAGE_LABELS[st.id] ?? st.preset.label,
        tree: st.tree,
        strategy: st.main.avg,
        classes: st.classes,
        exported: set.exported,
        ladder: steps.get(st.id),
        iterations: st.main.iterations,
        metrics: {
          occ: st.main.occ,
          localRegret: st.main.localRegret,
          gainMbb: st.main.gainMbb,
          nashConvMbb: st.main.nashConvMbb,
          snappedGainMbb: snappedGain(st, set.exported),
          ev: st.main.ev,
          evSum: st.main.evSum,
          frozenOcc: st.main.frozen.occ,
          negativeShares: st.main.negativeShares.count,
        },
        moves: st.moves,
        twoStartFlags: st.twoStart ? st.twoStart.flags : null,
        gatesIgnored: !st.main.pass,
        iterationsCapped,
        twoStartFailed: st.twoStart ? !st.twoStart.result.pass : false,
        fit: EQR_FIT,
        equityTable: tableSha,
        ...(st.tree.cfg.mode === "pushfold" ? { note: pushFoldNote() } : {}),
      });
      out.set = set;
      out.ladder = steps.get(st.id);
      out.ship = isShip(st);
      return out;
    };
    const build = () => {
      exports = live.map(exportOf);
      draftIds = exports.filter((e) => e.ship && e.draft.length).map((e) => e.stage.id);
    };
    const shipFiles = () => preflopFiles(exports.filter((e) => e.ship).map((e) => e.stage), draftIds);
    const fileGz = (e) => gzipSync(stageTextOf(e.stage)).length;
    /**
     * The gzip ladder: a stage whose file is over PF-SIZE-1's per-file limit raises every ladder group one step, and if
     * the shipped files together are over the total limit every shipped stage does, until they fit. A check-only stage
     * that cannot fit is dropped; a shipped one fails the run (false).
     */
    const fitGzip = () => {
      build();
      for (;;) {
        const raise = new Set(exports.filter((e) => fileGz(e) > STAGE_GZIP_LIMIT).map((e) => e.stage.id));
        const total = fileSizes(shipFiles()).total;
        if (total > TOTAL_GZIP_LIMIT) for (const e of exports) if (e.ship) raise.add(e.stage.id);
        if (!raise.size) return true;
        const stuck = [...raise].filter((id) => ex.raiseAll(steps.get(id)) === null);
        if (stuck.length) {
          for (const id of stuck) {
            const st = states.get(id);
            if (isShip(st)) {
              console.log(`\nPF-SIZE-1 FAILED: ${stageFile(id)} (or the total ${total} > ${TOTAL_GZIP_LIMIT}) does not fit with every ladder group at ${ex.LADDER_STEPS.at(-1) * 100}%`);
              return false;
            }
            drop(st, `PF-SIZE-1: its file does not fit ${STAGE_GZIP_LIMIT} gzip bytes at the top ladder step`);
          }
          live = live.filter((x) => !x.dropped);
          build();
          continue;
        }
        console.log(`PF-SIZE-1: raising every ladder group of ${[...raise].join(", ")} one step (per-file limit ${STAGE_GZIP_LIMIT}, total ${total} of ${TOTAL_GZIP_LIMIT})`);
        for (const id of raise) steps.set(id, ex.raiseAll(steps.get(id)));
        build();
      }
    };
    // The snapped-gain gate again on the final export sets (a gzip step changes them), with §4.6's per-stage rule: an
    // optional or check-only stage over it is dropped and the others start again from their count ladders (their gzip
    // steps were for bigger files); a required one fails the run. There is no cold4 re-solve at this point.
    for (;;) {
      if (!live.length) {
        exports = null;
        break;
      }
      if (!fitGzip()) {
        exitCode = 1;
        break;
      }
      const over = args.ignoreGates ? [] : exports.filter((e) => e.stage.snappedGainMbb > solveM.DEFAULT_GATES.snappedGainMbb);
      if (!over.length) break;
      for (const e of over) drop(states.get(e.stage.id), `snapped gain ${e.stage.snappedGainMbb} mbb on the final export set (gate ${solveM.DEFAULT_GATES.snappedGainMbb})`);
      if (all.some((x) => x.failed)) break; // nothing is written; the summaries still show the last export
      live = live.filter((x) => !x.dropped);
      for (const st of live) steps.set(st.id, st.countLadder.steps);
    }

    // ── close calls, model-sensitive cells and artifact flags (§6.6, §6.9, §6.10) on the final export sets ──
    // The ladder above ran on annotation-free text, so the annotations never change which spots ship. Per stage one
    // evaluation of σ̄ (the unsnapped average the chart rounds) with the best-response action values, about 0.8 s.
    const plainSizes = exports ? fileSizes(shipFiles()) : null;
    if (exports) {
      for (const e of exports) {
        const st = states.get(e.stage.id);
        // brActionValues is 15 MB at 100bb: it lives only for this call.
        const { brActionValues } = evalSolver(st).evaluate(st.main.avg, { brActionValues: true });
        const base = { tree: st.tree, classes: st.classes, nodes: e.nodes, brActionValues, eps: ex.CLOSE_EPS };
        const variants = st.sensAvgs?.length === ex.SENSITIVITY_VARIANTS.length ? st.sensAvgs.map((x) => x.avg) : null;
        e.stage = ex.annotateStage(e.stage, { ...base, ...(variants ? { sensitivity: { strategy: st.main.avg, variants } } : {}) });
        if (variants) {
          // `sens` on every spot unless it adds more than SENS_MAX_GZIP to the file; then only rfi, vsOpen, vsShove (§6.6).
          const without = gzipSync(stageTextOf({ ...e.stage, scenarios: e.stage.scenarios.map(({ sens: _s, ...sc }) => sc) })).length;
          e.sensGain = fileGz(e) - without;
          if (e.sensGain > ex.SENS_MAX_GZIP) {
            e.stage = ex.annotateStage(e.stage, { ...base, sensitivity: { strategy: st.main.avg, variants, kinds: ex.SENS_FALLBACK_KINDS } });
            e.sensKinds = ex.SENS_FALLBACK_KINDS;
            console.log(`${st.id}: sens adds ${e.sensGain} gzip bytes (> ${ex.SENS_MAX_GZIP}); kept only on ${ex.SENS_FALLBACK_KINDS.join(", ")} spots (${fileGz(e) - without} bytes)`);
          }
        }
      }
      // PF-SIZE-1 after the annotations: close strings come off the rarest spots first (CLOSE_LADDER), per file over its
      // limit, then on every shipped file if the total is over, rather than failing a run that may have taken hours over
      // a feature that is not a gate. dropClose recomputes the flags of a stage that loses a string; a step that drops
      // nothing is skipped.
      const closeFallback = (targets, why) => {
        for (const t of ex.CLOSE_LADDER) {
          if (!why()) return true;
          for (const e of targets) {
            const [dropped] = ex.dropClose([e.stage], t);
            const lost = e.stage.scenarios.filter((sc, j) => sc.close !== undefined && dropped.scenarios[j].close === undefined).length;
            if (!lost) continue;
            console.log(`PF-SIZE-1: ${stageFile(e.stage.id)} close strings kept only on spots with occ ≥ ${t}% (${lost} spots lost theirs)`);
            e.stage = dropped;
          }
        }
        return !why();
      };
      for (const e of exports) {
        if (fileGz(e) <= STAGE_GZIP_LIMIT) continue;
        if (!closeFallback([e], () => fileGz(e) > STAGE_GZIP_LIMIT)) {
          if (e.ship) {
            console.log(`\nPF-SIZE-1 FAILED after annotations: ${stageFile(e.stage.id)} gzip ${fileGz(e)} > ${STAGE_GZIP_LIMIT} with close strings only on spots with occ ≥ ${ex.CLOSE_LADDER.at(-1)}%`);
            exitCode = 1;
          } else console.log(`${e.stage.id} (check-only): its file stays over ${STAGE_GZIP_LIMIT} gzip bytes after the close fallback`);
        }
      }
      const totalOver = () => fileSizes(shipFiles()).total > TOTAL_GZIP_LIMIT;
      if (totalOver() && !closeFallback(exports.filter((e) => e.ship), totalOver)) {
        console.log(`\nPF-SIZE-1 FAILED after annotations: all files gzip ${fileSizes(shipFiles()).total} > ${TOTAL_GZIP_LIMIT}`);
        exitCode = 1;
      }
    }

    // ── the self-checks of the written data ──
    for (const e of exports ?? []) {
      const st = states.get(e.stage.id);
      // PF-SANITY-1/2/3 failures fail the data tests, so they stop the run too (unless the gates are ignored).
      // flagProblems: the flags must be the ones the stored close strings give (the data test re-derives them).
      const problems = [...ex.dataChecks(e.stage), ...ex.flagProblems(e.stage), ...reproductionProblems(e, st), ...(args.ignoreGates ? [] : e.sanity.fails)];
      if (!problems.length) continue;
      if (e.ship) {
        console.log(`${st.id}: DATA SELF-CHECK FAILED:\n  ${problems.slice(0, 20).join("\n  ")}`);
        exitCode = 1;
      } else {
        st.notes.push(`data self-check would fail if it shipped: ${problems.slice(0, 5).join("; ")}`);
        console.log(`${st.id} (check-only, not written): DATA SELF-CHECK would fail:\n  ${problems.slice(0, 20).join("\n  ")}`);
      }
    }

    // ── summaries ──
    mkdirSync(args.summaryDir, { recursive: true });
    for (const st of all) {
      const e = exports?.find((x) => x.stage.id === st.id) ?? null;
      const overlap = st.main && st.tree.cfg.mode === "full" && SHORT_NASH_STAGES.some((x) => x.stack === st.tree.cfg.S) ? overlapReport(st) : null;
      const pf = st.main && st.tree.cfg.mode === "pushfold" ? pushFoldOverlap(st, e) : null;
      const lines = summaryLines(st, e, [...(overlap ?? []), ...(pf ?? [])]);
      console.log("\n" + lines.join("\n"));
      writeFileSync(`${args.summaryDir}/summary-${st.id}.txt`, lines.join("\n") + "\n");
    }
    const files = exports ? shipFiles() : null;
    if (files && files.size > 1) {
      const sz = fileSizes(files);
      const per = [...sz.per].map(([path, gz]) => `${path.replace(/^preflopStages\//, "")} ${gz}`).join(", ");
      const nShip = exports.filter((e) => e.ship);
      console.log(
        `\ndata files: ${nShip.length} stage(s), ${nShip.reduce((a, e) => a + e.stage.scenarios.length, 0)} scenarios, ${sz.raw} bytes, gzip ${sz.total} bytes in all (limit ${TOTAL_GZIP_LIMIT}; ` +
          `${plainSizes.total} without close calls, sens and flags); per file (limit ${STAGE_GZIP_LIMIT}): ${per}${draftIds.length ? `; DRAFT stages: ${draftIds.join(", ")}` : ""}`,
      );
    }
    const checkOnly = (exports ?? []).filter((e) => !e.ship);
    if (checkOnly.length) console.log(`check-only stages (never written): ${checkOnly.map((e) => `${e.stage.id} ${e.stage.scenarios.length} spots, gzip ${fileGz(e)}`).join("; ")}`);
    if (args.checkStageOut && checkOnly.length) {
      mkdirSync(args.checkStageOut, { recursive: true });
      for (const e of checkOnly) writeFileSync(`${args.checkStageOut}/${e.stage.id}.json`, JSON.stringify(e.stage, null, 1) + "\n");
      console.log(`wrote ${checkOnly.map((e) => `${e.stage.id}.json`).join(", ")} to ${args.checkStageOut}`);
    }

    // ── dumps ──
    if (args.dump) for (const st of all) if (st.main) writeDump(st, exports?.find((x) => x.stage.id === st.id) ?? null);

    // ── determinism (--check) ──
    if (det) {
      const [a, b] = det;
      const sha = (x) => createHash("sha256").update(Buffer.from(x.avg.buffer)).digest("hex");
      const tr = treeM.buildTree(treeM.stageConfig(DET_STAGE));
      const classes = ex.classifyTree(tr);
      const detEval = solveM.createSolver(tr, table, { valuation: ex.valuationForStage(tr.cfg, EQR_FIT, features) });
      // The export with its close calls and flags (§6.9, §6.10), so the determinism check covers them too.
      const stageJson = (r) => {
        const ch = ex.chooseLadder(tr, classes, r.occ, { shared });
        const out = ex.exportStage({
          id: DET_STAGE, label: "det", tree: tr, strategy: r.avg, classes, exported: ch.set.exported, ladder: ch.steps, iterations: r.iterations,
          metrics: { occ: r.occ, localRegret: r.localRegret, gainMbb: r.gainMbb, nashConvMbb: r.nashConvMbb, snappedGainMbb: r.snappedMaxGainMbb, ev: r.ev, evSum: r.evSum, frozenOcc: r.frozen.occ, negativeShares: r.negativeShares.count },
          moves: null, twoStartFlags: null, fit: EQR_FIT, equityTable: tableSha,
        });
        const { brActionValues } = detEval.evaluate(r.avg, { brActionValues: true });
        return JSON.stringify(ex.annotateStage(out.stage, { tree: tr, classes, nodes: out.nodes, brActionValues, eps: ex.CLOSE_EPS }));
      };
      const same = sha(a) === sha(b) && stageJson(a) === stageJson(b);
      console.log(`\nPF-DET (${DET_STAGE}, ${DET_ITERATIONS} iterations, twice): ${same ? "identical" : "DIFFERENT"} (σ̄ sha256 ${sha(a).slice(0, 12)} / ${sha(b).slice(0, 12)})`);
      if (!same) exitCode = 1;
    }

    // ── write or compare ──
    if (all.some((s) => s.failed)) {
      console.log("\nA required stage failed: nothing written.");
      return 1;
    }
    if (!files || !exports.some((e) => e.ship)) {
      console.log("\nNo shippable stage was solved: nothing written.");
      return exitCode;
    }
    if (exitCode) {
      console.log("\nChecks failed: nothing written.");
      return exitCode;
    }
    const digest = createHash("sha256");
    for (const [path, text] of files) digest.update(`${path}\0${text}\0`);
    const sha12 = digest.digest("hex").slice(0, 12);
    const outName = args.out.replace(root, "");
    if (args.check) {
      const { changed, removed } = compareFiles(args.out, files);
      const same = !changed.length && !removed.length;
      console.log(
        `\n--check: ${outName} ${same ? "is up to date" : `WOULD CHANGE (${[...changed.map((p) => `${p} changed or added`), ...removed.map((p) => `${p} removed`)].join("; ")})`} (sha256 ${sha12})`,
      );
      return same ? 0 : 1;
    }
    const removed = writeFiles(args.out, files);
    console.log(`\nwrote ${outName}/${INDEX_FILE} and ${files.size - 1} stage file(s)${removed.length ? `; removed ${removed.join(", ")}` : ""} (sha256 ${sha12})`);
    return 0;
  }

  /** One stage file's text, as written. */
  function stageTextOf(stage) {
    return preflopFiles([stage], []).get(stageFile(stage.id));
  }

  /**
   * The written data reproduces the snapped strategy: per scenario, the reach decoded from reachFrom equals ρ of the
   * snapped profile, and buildScenario's fill gives the snapped frequencies for hands in reach (0 elsewhere).
   */
  function reproductionProblems(e, st) {
    const out = [];
    const decoded = ex.decodeStage(e.stage);
    e.stage.scenarios.forEach((sc, i) => {
      const p = e.nodes[i];
      const d = decoded.get(sc.id);
      const rho = solveM.ownReach(st.tree, e.snapped, p, N);
      const cls = st.classes[p];
      for (let h = 0; h < N; h++) {
        if (Math.abs(d.rho[h] - rho[h]) > 1e-12) {
          out.push(`${sc.id} ${ALL_HANDS[h]}: decoded reach ${d.rho[h]} ≠ snapped ${rho[h]}`);
          return;
        }
        for (const a of cls.order) {
          const key = cls.actions[a].key;
          const want = rho[h] > 0 ? e.snapped[(st.tree.actStart[p] + a) * N + h] : 0;
          if (Math.abs(d.freq[key][h] - want) > 1e-12) {
            out.push(`${sc.id} ${ALL_HANDS[h]} ${key}: decoded ${d.freq[key][h]} ≠ snapped ${want}`);
            return;
          }
        }
      }
    });
    return out;
  }

  // ── PF-OVERLAP (§5.4): a full-tree stage against shortNash at the same stack (a loose check: not the same game) ──
  function overlapReport(st) {
    const sn = SHORT_NASH_STAGES.find((x) => x.stack === st.tree.cfg.S);
    if (!sn) return [`PF-OVERLAP: shortNashData has no ${st.tree.cfg.S}bb stage`];
    const tr = st.tree, avg = st.main.avg, names = treeM.seatNames(tr.n);
    const byId = new Map(st.classes.map((c) => [c.id, c.node]));
    const sid = (name) => name.toLowerCase().replace("+", "p");
    // Ours: 1 − fold of the node's own reaching range. Theirs: buildScenario's fill of the listed ranges, in order.
    const ours = (id) => {
      const p = byId.get(id);
      if (p === undefined) return null;
      const sh = solveM.actionShares(tr, avg, p, cw, solveM.ownReach(tr, avg, p, N));
      return (1 - sh[tr.foldIdx[p]]) * 100;
    };
    const theirs = (texts) => {
      const rs = texts.map((t) => parseRange(t ?? ""));
      let x = 0;
      ALL_HANDS.forEach((hand, h) => {
        let left = 1;
        for (const r of rs) left -= Math.min(r[hand] ?? 0, left);
        x += cw[h] * (1 - left);
      });
      return (x / 1326) * 100;
    };
    /** Per verb, the share of the node's own reaching range, %. */
    const sharesOf = (id) => {
      const p = byId.get(id);
      if (p === undefined) return null;
      const sh = solveM.actionShares(tr, avg, p, cw, solveM.ownReach(tr, avg, p, N));
      const o = {};
      tr.nodes[p].actions.forEach((a, k) => (o[a.verb] = (o[a.verb] ?? 0) + sh[k] * 100));
      return o;
    };
    const f1 = (x) => (x === undefined || x === null ? "-" : x.toFixed(1));
    const L = [`PF-OVERLAP vs shortNash ${sn.stack}bb (open ${SHORT_NASH_OPEN}bb; open + jam within ${OVERLAP_PP}pp is ok, a warning only; UTG–CO more than ${OVERLAP_FAIL_PP}pp off would hold the stage):`];
    const rfi = [];
    let off = 0, hold = 0;
    for (let s = 0; s < tr.n - 1; s++) {
      const a = ours(`rfi-${sid(names[s])}`), b = theirs([sn.open[names[s]], sn.jam[names[s]]]);
      const gap = a === null ? 0 : Math.abs(a - b);
      const bad = gap > OVERLAP_PP;
      const holds = s <= 5 && gap > OVERLAP_FAIL_PP;
      if (bad) off++;
      if (holds) hold++;
      rfi.push(`${names[s]} ${a?.toFixed(1)} vs ${b.toFixed(1)}${holds ? " HOLD" : bad ? " WARN" : ""}`);
    }
    L.push(`  open + jam total (ours vs shortNash; our SB includes limps): ${rfi.join(" / ")}`);
    const def = [];
    for (let o = 0; o < tr.n - 1; o++) {
      const a = ours(`bb-vs-${sid(names[o])}-open`), b = theirs([sn.reJam.BB?.[names[o]], sn.bbCall[names[o]]]);
      def.push(`${names[o]} ${a?.toFixed(1)} vs ${b.toFixed(1)} (${a === null ? "?" : (a - b >= 0 ? "+" : "") + (a - b).toFixed(1)})`);
    }
    L.push(`  BB defense vs an open (ours vs shortNash, difference): ${def.join(" / ")}`);
    const oj = [];
    for (let s = 0; s < tr.n - 1; s++) {
      const o = sharesOf(`rfi-${sid(names[s])}`);
      oj.push(`${names[s]} ${f1(o?.open ?? 0)}/${f1(o?.jam ?? 0)}${s === tr.sbSeat ? `/limp ${f1(o?.limp ?? 0)}` : ""} vs ${theirs([sn.open[names[s]]]).toFixed(1)}/${theirs([sn.jam[names[s]]]).toFixed(1)}`);
    }
    L.push(`  open/jam split (ours vs shortNash): ${oj.join(" | ")}`);
    const bb = [];
    for (let o = 0; o < tr.n - 1; o++) {
      const x = sharesOf(`bb-vs-${sid(names[o])}-open`);
      bb.push(`${names[o]} ${f1(x?.call ?? 0)}/${f1(x?.jam ?? 0)}${x?.["3bet"] ? `/3bet ${f1(x["3bet"])}` : ""} vs ${theirs([sn.bbCall[names[o]]]).toFixed(1)}/${theirs([sn.reJam.BB?.[names[o]]]).toFixed(1)}`);
    }
    L.push(`  BB call/jam vs an open (ours vs shortNash): ${bb.join(" | ")}`);
    const pairs = [["SB", "BTN"], ["BTN", "CO"], ["CO", "HJ"], ["BTN", "UTG"], ["SB", "CO"], ["HJ", "UTG"]];
    const rj = pairs.map(([h, o]) => {
      const x = sharesOf(`${sid(h)}-vs-${sid(o)}-open`);
      return `${h} vs ${o} call ${f1(x?.call ?? 0)} jam ${f1(x?.jam ?? 0)}${x?.["3bet"] ? ` 3bet ${f1(x["3bet"])}` : ""} vs jam ${theirs([sn.reJam[h]?.[o]]).toFixed(1)}`;
    });
    L.push(`  re-jam over an open (ours vs shortNash): ${rj.join(" | ")}`);
    const cj = [["BB", "BTN"], ["BB", "SB"], ["BB", "CO"], ["BB", "UTG"], ["SB", "BTN"], ["BTN", "CO"]].map(([h, j]) => {
      const x = sharesOf(`${sid(h)}-vs-${sid(j)}-jam`);
      return `${h} vs ${j} ${f1(x?.call)} vs ${theirs([sn.callJam[h]?.[j]]).toFixed(1)}`;
    });
    L.push(`  call a first-in jam (ours vs shortNash; "-": no such spot in ours): ${cj.join(" | ")}`);
    const cr = [["CO", "BTN"], ["BTN", "SB"], ["BTN", "BB"], ["UTG", "BB"], ["SB", "BB"], ["HJ", "CO"]].map(([o, j]) => {
      const x = sharesOf(`${sid(o)}-open-vs-${sid(j)}-jam`);
      const op = parseRange(sn.open[o] ?? ""), ca = parseRange(sn.callReJam[o]?.[j] ?? "");
      let num = 0, den = 0;
      ALL_HANDS.forEach((hand, h) => {
        const w = cw[h] * (op[hand] ?? 0);
        den += w;
        num += w * (ca[hand] ?? 0);
      });
      return `${o} vs ${j} ${f1(x?.call)} vs ${den ? ((num / den) * 100).toFixed(1) : "-"}`;
    });
    L.push(`  opener calls a re-jam (ours vs shortNash, of the opener's ${SHORT_NASH_OPEN}bb-open range): ${cr.join(" | ")}`);
    L.push(`  ${off ? `WARN: ${off} seat(s) outside ${OVERLAP_PP}pp` : `every seat within ${OVERLAP_PP}pp`}${hold ? `; HOLD: ${hold} seat(s) from UTG to CO more than ${OVERLAP_FAIL_PP}pp off` : ""}`);
    return L;
  }

  // ── PF-OVERLAP-PF (§5.4): a push/fold stage against the nash set at the same stack: the same game and engine ──
  function pushFoldOverlap(st, e) {
    const S = st.tree.cfg.S;
    const nash = NASH_STAGES.find((x) => x.stack === S);
    if (!nash) return [`PF-OVERLAP-PF: nashData has no ${S}bb stage`];
    if (!e) return [`PF-OVERLAP-PF: ${st.id} was not exported`];
    const names = treeM.seatNames(st.tree.n);
    const sid = (name) => name.toLowerCase().replace("+", "p");
    const byId = new Map(e.stage.scenarios.map((sc) => [sc.id, sc]));
    const ours = (id, key) => {
      const r = byId.get(id)?.actions.find((a) => a.key === key)?.range;
      return r === undefined ? null : parseRange(r);
    };
    let cells = 0, diff = 0, ranges = 0, missing = 0;
    const worst = [];
    const cmp = (label, mine, theirsText) => {
      ranges++;
      if (!mine) {
        missing++;
        return;
      }
      const t = parseRange(theirsText ?? "");
      for (const hand of ALL_HANDS) {
        cells++;
        const a = mine[hand] ?? 0, b = t[hand] ?? 0;
        if (Math.abs(a - b) > 1e-9) {
          diff++;
          worst.push({ label, hand, a, b });
        }
      }
    };
    for (let s = 0; s < st.tree.n - 1; s++) cmp(`push ${names[s]}`, ours(`rfi-${sid(names[s])}`, "shove"), nash.push[names[s]]);
    for (let j = 0; j < st.tree.n - 1; j++)
      for (let c = j + 1; c < st.tree.n; c++) cmp(`${names[c]} calls ${names[j]}`, ours(`${sid(names[c])}-vs-${sid(names[j])}-jam`, "call"), nash.call[names[c]]?.[names[j]]);
    worst.sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
    const ok = !diff && !missing;
    return [
      `PF-OVERLAP-PF vs nash ${S}bb (the same push/fold game and engine: every cell must be equal, a data test): ${ok ? `identical (${ranges} ranges, ${cells} cells)` : `${diff} of ${cells} cells differ, ${missing} range(s) missing; worst ${worst.slice(0, 6).map((x) => `${x.label} ${x.hand} ${x.a} vs ${x.b}`).join(", ")} (rerun scripts/make-nash.mjs with the same engine before shipping)`}`,
    ];
  }

  // ── summaries ──
  function summaryLines(st, e, overlap) {
    const L = [];
    const names = treeM.seatNames(9);
    const r = st.main;
    const verdict = st.failed ? "FAILED" : st.dropped ? "DROPPED" : r?.pass ? "PASS" : "GATES IGNORED";
    const tag = st.status === "check" ? `CHECK ONLY (not written): ${verdict}` : verdict;
    L.push(`=== ${st.id} (${ex.STAGE_LABELS[st.id] ?? st.preset.label}): ${tag}${r ? ` at ${r.iterations} iterations${r.polished ? " (polished)" : ""}, ${r.seconds.toFixed(0)} s, ${r.msPerIteration.toFixed(0)} ms/iteration` : ""} ===`);
    for (const n of st.notes) L.push(`note: ${n}`);
    if (st.failed) L.push(`failure: ${st.failed}`);
    if (st.dropped) L.push(`dropped: ${st.dropped}`);
    if (!r) return L;
    const cfg = st.tree.cfg;
    L.push(
      `tree: ${st.tree.nodeCount} nodes, ${st.tree.edgeCount} edges, ${st.tree.termCount} terminals; ${cfg.mode === "pushfold" ? "push/fold (showdown equity)" : `cold4 ${cfg.cold4}${st.fallback ? " (fallback)" : treeM.stageConfig(st.id).cold4 === "none" ? " (preset)" : ""}`}`,
    );
    const g = ex.degenGates(cfg);
    if (st.degen) L.push(`PF-DEGEN-1 (every seat UTG..BTN min-raises ≥ ${ex.DEGEN_MIN_OPEN * 100}% first in): ${st.degen.length ? `FAIL ${st.degen.map((x) => `${x.seat} ${(x.open * 100).toFixed(2)}%`).join(", ")}` : "pass"}`);
    else L.push(`PF-DEGEN-1: not applicable (${cfg.mode !== "full" ? "no opens" : `no first-in jams above ${cfg.jamMax}bb`})`);
    if (st.twoStart?.rfi) L.push(`PF-TWOSTART-RFI (every first-in node within 2pp of the two-start solve): ${st.twoStart.rfi.length ? `FAIL ${st.twoStart.rfi.map((x) => `${x.id} ${(x.d * 100).toFixed(1)}pp`).join(", ")}` : `pass (largest ${st.twoStart.rfiMax.id} ${(st.twoStart.rfiMax.d * 100).toFixed(2)}pp)`}`);
    else if (!g.twoStartRfi) L.push(`PF-TWOSTART-RFI: not applicable (no first-in jams above ${cfg.jamMax}bb)${st.twoStart ? `; largest first-in difference ${st.twoStart.rfiMax.id} ${(st.twoStart.rfiMax.d * 100).toFixed(2)}pp` : ""}`);
    L.push(
      `gates: ${r.history.map((h) => `${h.iterations}: gain ${h.maxGainMbb.toFixed(3)} NC ${h.nashConvMbb.toFixed(2)} snap ${h.snappedMaxGainMbb.toFixed(2)} regret ${h.worstExportedRegret.toFixed(4)} ${h.failures.join(",") || "ok"}`).join(" | ")}`,
    );
    L.push(`per-seat gain (mbb/hand): ${r.gainMbb.map((g, s) => `${names[s]} ${g.toFixed(3)}`).join(", ")}; NashConv ${r.nashConvMbb.toFixed(3)}`);
    if (e) L.push(`snapped max gain on the export set ${e.stage.snappedGainMbb.toFixed(3)} mbb/hand${e.stage.snappedGainMbb > solveM.DEFAULT_GATES.snappedWarnMbb ? " (WARN: above 2)" : ""}; worst exported regret ${Math.max(...e.stage.scenarios.map((s) => s.regret)).toFixed(4)} bb`);
    L.push(`EV (own world, bb/hand): ${r.ev.map((v, s) => `${names[s]} ${v.toFixed(4)}`).join(", ")}; Σ EV ${r.evSum.toFixed(4)}`);
    L.push(`PF-FROZEN ${(r.frozen.occ * 100).toFixed(3)}% of hands (raiser ${(r.frozen.raiserOcc * 100).toFixed(3)}, caller ${(r.frozen.callerOcc * 100).toFixed(3)})${r.frozen.occ > 0.005 ? " WARN: above 0.5%" : ""}; negative shares ${r.negativeShares.count} (occ-weighted ${(r.negativeShares.occ * 100).toFixed(4)}%)`);
    for (const w of r.negativeShares.worst.slice(0, 3)) L.push(`  negative share: ${w}`);
    L.push(...aggregateLines(st));
    if (e) {
      const c = ex.countKinds(st.classes, e.set.exported);
      const th = ex.ladderThresholds(e.ladder);
      L.push(`exported ${c.total}: rfi ${c.rfi}, vsOpen ${c.vsOpen}, vs3bet ${c.vs3bet} (cold ${c.cold}), vs4bet ${c.vs4bet}, squeeze ${c.squeeze}, vsLimp ${c.vsLimp}, vsShove ${c.vsShove}`);
      L.push(`thresholds (% of hands): base 0.1; squeeze ${th.squeeze}, vs4bet ${th.vs4bet}, vsShove ${th.vsShove}, cold vs3bet ${th.cold}${e.set.omitted.length ? `; ${e.set.omitted.length} node(s) omitted for an unexported hero ancestor` : ""}`);
      const stageText = stageTextOf(e.stage);
      L.push(
        `stage file: ${Buffer.byteLength(stageText)} bytes, gzip ${gzipSync(stageText).length} bytes (PF-SIZE-1 limit ${STAGE_GZIP_LIMIT})${e.sensGain !== undefined ? `; sens adds ${e.sensGain} gzip bytes${e.sensKinds ? ` (kept only on ${e.sensKinds.join(", ")})` : ""}` : ""}${e.ship ? "" : "; check-only, not written"}`,
      );
      const conf = { high: 0, mid: 0, low: 0 };
      for (const s of e.stage.scenarios) conf[s.confidence]++;
      const draftWhy = { sensitivity: "no sensitivity solves", twostart: "no two-start solve", gates: "gates ignored", iterations: "not the §4.6 schedule (--iterations)", twostartGates: "the two-start solve failed its gates" };
      L.push(`confidence: high ${conf.high}, mid ${conf.mid}, low ${conf.low}${e.draft.length ? ` (DRAFT: ${e.draft.map((d) => draftWhy[d] ?? d).join(", ")})` : ""}`);
      L.push(...annotationLines(e.stage));
      for (const b of ex.stageBands(e.stage)) L.push(`PF-BANDS ${b.ok ? "ok  " : "WARN"} ${b.name}: ${b.value} (band ${b.lo}–${b.hi}; a warning only, never a target)`);
      for (const f of e.sanity.fails) L.push(`SANITY FAIL (the data test fails): ${f}`);
      for (const w of e.sanity.warns) L.push(`sanity warning: ${w}`);
    }
    if (st.sens.length) {
      const ids = e ? e.nodes : st.candidates;
      for (const s of st.sens) {
        const ms = ids.map((p) => s.perNode.get(p) ?? 0).sort((a, b) => a - b);
        L.push(`sensitivity (${s.variant}) ${s.label}: max gain ${s.maxGainMbb.toFixed(2)} mbb at ${s.iterations}; move median ${ms[ms.length >> 1].toFixed(1)}pp, max ${ms.at(-1).toFixed(1)}pp`);
      }
      if (e) {
        const top = e.nodes.map((p, i) => ({ id: e.stage.scenarios[i].id, m: st.moves[p] })).sort((a, b) => b.m - a.m || a.id.localeCompare(b.id)).slice(0, 5);
        L.push(`largest moves: ${top.map((x) => `${x.id} ${x.m.toFixed(1)}`).join(", ")}`);
      }
    }
    if (st.twoStart) {
      const t = st.twoStart;
      L.push(`PF-TWOSTART: ${t.result.pass ? "converged" : `gates ${t.result.failures.join(",")}`} at ${t.result.iterations}; ${t.flags.size} node(s) above 2pp; worst ${t.worst.slice(0, 5).map((x) => `${st.classes[x.p].id} ${(x.d * 100).toFixed(1)}pp`).join(", ")}`);
    }
    if (overlap) L.push(...overlap);
    return L;
  }

  /** §6.9, §6.10: the close-call marks (cells, spots, per-spot spread) and the artifact flags per code of a stage. */
  function annotationLines(stage) {
    const decoded = ex.decodeStage(stage);
    let cells = 0, marked = 0, three = 0, spots = 0;
    const perSpot = [];
    for (const sc of stage.scenarios) {
      const d = decoded.get(sc.id);
      for (let h = 0; h < N; h++) if (d.rho[h] > 0) cells++;
      let n = 0;
      for (const ch of sc.close ?? "") {
        if (ch === ".") continue;
        n++;
        let m = parseInt(ch, 16), bits = 0;
        for (; m; m &= m - 1) bits++;
        if (bits >= 3) three++;
      }
      if (sc.close) spots++;
      marked += n;
      perSpot.push(n);
    }
    perSpot.sort((a, b) => a - b);
    const L = [
      `close calls (ε ${stage.closeEps} bb per arrival): ${marked} of ${cells} in-reach cells marked (${((marked / Math.max(1, cells)) * 100).toFixed(1)}%), ${three} with 3+ near actions; ${spots} of ${stage.scenarios.length} spots carry a string; per spot p50 ${perSpot[perSpot.length >> 1]} p90 ${perSpot[Math.floor(perSpot.length * 0.9)]} max ${perSpot.at(-1)}` +
        (stage.closeMinOcc !== undefined ? `; closeMinOcc ${stage.closeMinOcc}% (PF-SIZE-1 fallback: spots below it carry none)` : ""),
    ];
    const byCode = new Map();
    let flagged = 0, two = 0;
    for (const sc of stage.scenarios) {
      if (!sc.flags) continue;
      flagged++;
      if (sc.flags.length > 1) two++;
      for (const f of sc.flags) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
    }
    const codes = [...byCode.keys()].sort((a, b) => Number(a.slice(10)) - Number(b.slice(10)));
    L.push(`flags (§6.10): ${flagged} spot(s), ${two} with 2+${codes.length ? `; ${codes.map((c) => `${c} ${byCode.get(c)}`).join(", ")}` : ""}`);
    let sensCells = 0, sensSpots = 0;
    for (const sc of stage.scenarios) {
      if (!sc.sens) continue;
      sensSpots++;
      for (const ch of sc.sens) if (ch !== ".") sensCells++;
    }
    if (sensSpots) L.push(`model-sensitive cells (§6.6, sens): ${sensCells} of ${cells} in-reach cells (${((sensCells / Math.max(1, cells)) * 100).toFixed(1)}%) on ${sensSpots} spots`);
    return L;
  }

  /** Raw σ̄ aggregates of the main solve (shares of each node's own reaching range, %). */
  function aggregateLines(st) {
    const tr = st.tree, avg = st.main.avg, names = treeM.seatNames(tr.n);
    const byId = new Map(st.classes.map((c) => [c.id, c.node]));
    const shares = (p) => {
      const sh = solveM.actionShares(tr, avg, p, cw, solveM.ownReach(tr, avg, p, N));
      return Object.fromEntries(tr.nodes[p].actions.map((a, k) => [a.verb, sh[k] * 100]));
    };
    const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(" / ");
    const L = [];
    const rfi = [];
    for (let s = 0; s < tr.n - 1; s++) {
      const p = byId.get(`rfi-${names[s].toLowerCase().replace("+", "p")}`);
      const o = shares(p);
      rfi.push(`${names[s]} ${(100 - o.fold).toFixed(1)}`);
      if (s === tr.sbSeat) L.push(`SB first in: ${fmt(o)}`);
    }
    L.unshift(`RFI: ${rfi.join(" / ")}`);
    const limp = byId.get("bb-vs-sb-limp");
    if (limp !== undefined) L.push(`BB vs SB limp: ${fmt(shares(limp))}`);
    const def = [];
    for (let o = 0; o < tr.n - 1; o++) {
      const p = byId.get(`bb-vs-${names[o].toLowerCase().replace("+", "p")}-open`);
      if (p !== undefined) def.push(`${names[o]} ${(100 - shares(p).fold).toFixed(1)}`);
    }
    L.push(`BB defense vs: ${def.join(" / ")}`);
    const btn = byId.get("bb-vs-btn-open");
    if (btn !== undefined) L.push(`BB vs BTN: ${fmt(shares(btn))}`);
    const tb = [];
    for (let s = 1; s < tr.n; s++) {
      const p = byId.get(`${names[s].toLowerCase().replace("+", "p")}-vs-utg-open`);
      if (p !== undefined) {
        const o = shares(p);
        tb.push(`${names[s]} ${((o["3bet"] ?? 0) + (o.jam ?? 0)).toFixed(1)}`);
      }
    }
    L.push(`3-bet vs UTG: ${tb.join(" / ")}`);
    for (const id of ["co-open-vs-btn-3bet", "btn-open-vs-bb-3bet", "utg-open-vs-btn-3bet", "btn-3bet-vs-co-4bet", "bb-at-co-open-btn-call"]) {
      const p = byId.get(id);
      if (p !== undefined) L.push(`${id} (reach ${(st.main.reach[p] * 100).toFixed(1)}%): ${fmt(shares(p))}`);
    }
    return L;
  }

  function writeDump(st, e) {
    const dir = `${args.dump}/${st.id}`;
    mkdirSync(dir, { recursive: true });
    const tr = st.tree, r = st.main, avg = r.avg;
    writeFileSync(
      `${dir}/config.json`,
      JSON.stringify(
        {
          stage: st.id,
          label: ex.STAGE_LABELS[st.id] ?? "",
          status: st.status,
          cfg: tr.cfg,
          cold4Fallback: st.fallback,
          pass: r.pass,
          iterations: r.iterations,
          ladder: e ? e.ladder : null,
          equityTable: tableSha,
          fitHash: EQR_FIT.sha256,
          sigma: { file: "sigma.f32", dtype: "float32", layout: "(actStart[node] + action) * 169 + class, classes in ALL_HANDS order", edges: tr.edgeCount },
        },
        null,
        1,
      ),
    );
    writeFileSync(`${dir}/sigma.f32`, Buffer.from(new Float32Array(avg).buffer));
    const exported = e ? e.set.exported : null;
    const nodes = [];
    for (let p = 0; p < tr.nodeCount; p++) {
      const c = st.classes[p];
      const sh = solveM.actionShares(tr, avg, p, cw, solveM.ownReach(tr, avg, p, N));
      nodes.push({
        node: p,
        seat: treeM.seatNames(tr.n)[tr.seat[p]],
        parent: tr.parent[p],
        line: treeM.lineText(tr.nodes[p].line, tr.n),
        kind: c.kind,
        id: c.id,
        cold: c.cold,
        exported: exported ? exported[p] === 1 : false,
        occPct: +(r.occ[p] * 100).toFixed(5),
        reachPct: +(r.reach[p] * 100).toFixed(3),
        localRegret: +r.localRegret[p].toFixed(6),
        move: st.moves && st.rho?.has(p) ? +st.moves[p].toFixed(2) : null,
        actions: tr.nodes[p].actions.map((a, k) => ({ key: a.key, verb: a.verb, to: a.to, label: c.actions[k]?.label ?? "폴드", sharePct: +(sh[k] * 100).toFixed(3) })),
      });
    }
    writeFileSync(`${dir}/nodes.json`, JSON.stringify(nodes));
  }
}

// Last, so that the Pool class above is initialized before main runs.
if (isMainThread) {
  const code = await main().catch((e) => {
    console.error(e?.stack ?? e);
    return 1;
  });
  process.exit(code);
}
