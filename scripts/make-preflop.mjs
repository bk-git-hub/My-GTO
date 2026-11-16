// Solves the 9-handed BB-ante preflop stages with our own DCFR engine (src/poker/preflop) and writes the solver
// chart data, src/data/sets/preflopData.ts. Design: docs/preflop-solver.md (§ numbers below are its sections).
//
// Usage: node scripts/make-preflop.mjs [flags]
//   --stages a,b,...    stages to solve (default: 100bb-2.2,100bb-3,55bb-2.2,35bb-2,25bb-2)
//   --iterations N      cap the schedule at N iterations (start min(1500, N), max N) and the sensitivity solves at
//                       min(1000, N): quick tests. Gates still apply, but any N other than §4.6's 4,000 is a DRAFT.
//   --check             print every check, run the determinism check (35bb-2 twice at 300 iterations) and compare
//                       the output with the committed data file; exit 1 if it would change. Writes no data file.
//   --no-sensitivity    skip the five sensitivity solves per stage (§6.6)  } a DRAFT: move 0, confidence from the
//   --no-twostart       skip PF-TWOSTART (§5.4)                            } checks that ran, PREFLOP_DRAFT_STAGES
//   --ignore-gates      export stages that fail their gates, as drafts (development only; no cold4 fallback); also
//                       lets a PF-SANITY-1/2/3 failure or an equity table the fit was not made with through
//   --dump DIR          write per stage DIR/<stage>/{config.json, sigma.f32, nodes.json} for reviewers
//   --summary-dir DIR   where summary-<stage>.txt goes (default node_modules/.cache/preflop)
//   --workers N         solves at once (default min(4, CPUs)); the output does not depend on it
//   --ladder MODE       "per-group" (default) or "shared": how the §6.5 size ladder raises its groups
//   --out FILE          data file to write (default src/data/sets/preflopData.ts; a run whose --stages leave out a
//                       stage that ships needs an explicit --out, so a subset never replaces the committed file)
//
// Every solve runs in its own worker thread; at most --workers run at once. Per stage (§4.6, §5.3): the main solve
// on the §4.6 schedule with the §5.3 gates; if a gate fails, or the gates pass but PF-DATA-1's counts cannot be met
// on its reach (§2.8), one re-solve with cold4 "none"; if that fails too, an optional stage (35bb-2) is dropped and a
// required one fails the run (exit 1, nothing written). 25bb-2 is solved
// only for PF-OVERLAP against shortNash 25bb and never exported. Then PF-TWOSTART and the five 1,000-iteration
// sensitivity solves, the PF-* checks, the size ladder, the close-call marks and artifact flags (§6.9, §6.10: one
// best-response evaluation of σ̄ per stage, after the ladder, so they never change which spots ship) and the data file.
// Every output is a pure function of the inputs: no timestamps, fixed ordering, independent of the worker count.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { equityTableSha256, load, loadEquityTable } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const DEFAULT_OUT = root + "src/data/sets/preflopData.ts";
const N = 169;
/** PF-SIZE-1: gzip (Node's default level) of the data file, bytes. 80,000 rather than 80 KiB, to stay on the safe side. */
const GZIP_LIMIT = 80_000;
const SENS_ITERATIONS = 1000;
/** §4.6's last iteration (runSchedule's default max): --iterations N with any other N is not the release schedule. */
const SCHEDULE_MAX = 4000;
const TWOSTART_WARMUP = 50;
const DET_STAGE = "35bb-2";
const DET_ITERATIONS = 300;
/** PF-OVERLAP: open + jam totals per seat within this many pp of shortNash 25bb. */
const OVERLAP_PP = 5;

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
    const solver = solveM.createSolver(tr, table, { valuation: ex.stageValuation(EQR_FIT, features, job.variant) });
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
    else if (f === "--out") a.out = next();
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
  // The committed file is the full set: a subset run may compare (--check) but writes only to an explicit --out.
  const leftOut = presets.filter((p) => p.status !== "check" && !stageIds.includes(p.id)).map((p) => p.id);
  if (leftOut.length && args.out === DEFAULT_OUT && !args.check)
    throw new Error(`--stages leaves out ${leftOut.join(", ")}: pass --out FILE so the committed ${DEFAULT_OUT.replace(root, "")} is not replaced by a subset`);
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

  async function runStage(id) {
    const preset = presets.find((p) => p.id === id);
    const st = { id, preset, status: preset.status, overrides: {}, fallback: false, dropped: null, failed: null, main: null, tree: null, classes: null, moves: null, sens: [], twoStart: null, notes: [] };
    states.set(id, st);
    const solveMain = (overrides, tag) =>
      pool.run({ kind: "main", stage: id, overrides, schedule, shared, label: `${id} ${tag}` }).then((r) => {
        console.log(
          `  ${elapsed()} [${id} ${tag}] ${r.pass ? "PASS" : `FAIL (${r.failures.join(", ")})`} at ${r.iterations} iterations${r.polished ? " (polished)" : ""}, ${r.seconds.toFixed(0)} s, ${r.msPerIteration.toFixed(0)} ms/it`,
        );
        return r;
      });
    let r = await solveMain({}, "main");
    if (!r.pass && st.status !== "check" && !args.ignoreGates) {
      // §2.8 / §4.6: one re-solve without cold jams behind a 3-bet.
      const failed = r;
      st.notes.push(`main solve failed (${failed.failures.join(", ")}) at ${failed.iterations}; re-solved with cold4 "none"`);
      r = await solveMain({ cold4: "none" }, "cold4 none");
      st.overrides = { cold4: "none" };
      st.fallback = true;
    } else if (r.pass && st.status !== "check" && !args.ignoreGates) {
      // §2.8: a cold-jam solve can pass its gates in a degenerate equilibrium (35bb: UTG opens only by jamming), whose
      // reach leaves too few spots for PF-DATA-1's counts. That is the same equilibrium the gate failure signals, so
      // it gets the same single re-solve without cold jams. No gate or count threshold changes.
      const tree0 = treeM.buildTree(treeM.stageConfig(id, st.overrides));
      const ch = ex.chooseLadder(tree0, ex.classifyTree(tree0), r.occ, { shared });
      if (!ch.ok && tree0.cfg.cold4 !== "none") {
        st.notes.push(`main solve passed its gates at ${r.iterations} but PF-DATA-1 counts cannot be met (${ch.problems.join("; ")}); re-solved with cold4 "none"`);
        r = await solveMain({ cold4: "none" }, "cold4 none");
        st.overrides = { cold4: "none" };
        st.fallback = true;
      }
    }
    st.main = r;
    st.tree = treeM.buildTree(treeM.stageConfig(id, st.overrides));
    st.classes = ex.classifyTree(st.tree);
    if (!r.pass) {
      const why = `gates failed: ${r.failures.join(", ")} (max gain ${r.maxGainMbb.toFixed(3)}, NashConv ${r.nashConvMbb.toFixed(3)}, snapped ${r.snappedMaxGainMbb.toFixed(3)} mbb, worst exported regret ${r.worstExportedRegret.toFixed(4)} bb)`;
      if (st.status === "check") st.notes.push(`validation stage did not pass its gates: ${why}`);
      else if (args.ignoreGates) st.notes.push(`gates ignored: ${why}`);
      else if (st.status === "optional") {
        st.dropped = why;
        return;
      } else {
        st.failed = why;
        return;
      }
    }
    if (st.status === "check") return;

    // Candidates: every node any ladder step could export (rfi, or occ ≥ 0.1%), with the main solve's own raw reach.
    const tr = st.tree;
    st.candidates = [];
    st.rho = new Map();
    for (let p = 0; p < tr.nodeCount; p++) {
      if (st.classes[p].kind !== "rfi" && !(r.occ[p] >= ex.BASE_THRESHOLD)) continue;
      st.candidates.push(p);
      st.rho.set(p, solveM.ownReach(tr, r.avg, p, N));
    }
    const jobs = [];
    if (args.twostart) {
      jobs.push(
        pool.run({ kind: "twostart", stage: id, overrides: st.overrides, schedule, shared, label: `${id} two-start` }).then((t) => {
          // PF-TWOSTART (§5.4): action shares of each solve's own reaching range, at nodes with reach ≥ 1%.
          const flags = new Set(), diffs = [];
          for (const p of st.candidates) {
            if (!(r.reach[p] >= ex.TWOSTART_MIN_REACH)) continue;
            const a = solveM.actionShares(tr, r.avg, p, cw, st.rho.get(p));
            const b = solveM.actionShares(tr, t.avg, p, cw, solveM.ownReach(tr, t.avg, p, N));
            let d = 0;
            for (let k = 0; k < a.length; k++) d = Math.max(d, Math.abs(a[k] - b[k]));
            if (d > ex.TWOSTART_TOLERANCE) flags.add(p);
            diffs.push({ p, d });
          }
          diffs.sort((x, y) => y.d - x.d || x.p - y.p);
          st.twoStart = { flags, worst: diffs.slice(0, 8), result: { ...t, avg: null } };
          console.log(`  ${elapsed()} [${id} two-start] ${t.pass ? "PASS" : `FAIL (${t.failures.join(", ")})`} at ${t.iterations}; ${flags.size} scenario(s) differ by more than 2pp`);
        }),
      );
    }
    if (args.sensitivity) {
      st.moves = new Float64Array(tr.nodeCount);
      for (const v of ex.SENSITIVITY_VARIANTS) {
        jobs.push(
          pool.run({ kind: "sens", stage: id, overrides: st.overrides, variant: v.id, iterations: sensIterations, label: `${id} sens ${v.id}` }).then((s) => {
            // §6.6: move = max over the variants of the ρ-weighted mean total variation.
            const perNode = new Map();
            for (const p of st.candidates) {
              const m = ex.moveAt(tr, r.avg, s.avg, p, st.rho.get(p), cw);
              perNode.set(p, m);
              if (m > st.moves[p]) st.moves[p] = m;
            }
            st.sens.push({ variant: v.id, label: v.label, maxGainMbb: s.maxGainMbb, iterations: s.iterations, seconds: s.seconds, perNode });
            console.log(`  ${elapsed()} [${id} sens ${v.id}] ${s.iterations} iterations, max gain ${s.maxGainMbb.toFixed(2)} mbb, ${s.seconds.toFixed(0)} s`);
          }),
        );
      }
    }
    await Promise.all(jobs);
    st.sens.sort((a, b) => a.variant.localeCompare(b.variant));
  }

  function finish(det) {
    let exitCode = 0;
    const all = stageIds.map((id) => states.get(id));
    for (const s of all.filter((x) => x.dropped)) console.log(`\n${s.id}: DROPPED (optional stage) — ${s.dropped}`);
    for (const s of all.filter((x) => x.failed)) console.log(`\n${s.id}: FAILED (required stage) — ${s.failed}`);
    const shippable = all.filter((s) => s.status !== "check" && !s.dropped && !s.failed);

    // ── size ladder (§6.5): per stage the count ladder, then gzip steps over all stages together ──
    const evalSolvers = new Map();
    const snappedCache = new Map();
    const snappedGain = (st, set) => {
      const nodes = [];
      for (let p = 0; p < st.tree.nodeCount; p++) if (set[p]) nodes.push(p);
      const key = `${st.id}|${nodes.join(",")}`;
      if (!snappedCache.has(key)) {
        if (!evalSolvers.has(st.id)) evalSolvers.set(st.id, solveM.createSolver(st.tree, table, { valuation: ex.stageValuation(EQR_FIT, features) }));
        const ev = evalSolvers.get(st.id).evaluate(solveM.snapStrategy(st.tree, st.main.avg, nodes, N));
        snappedCache.set(key, ev.maxGainMbb);
      }
      return snappedCache.get(key);
    };
    const steps = new Map();
    for (const st of shippable) {
      const ch = ex.chooseLadder(st.tree, st.classes, st.main.occ, { shared });
      st.countLadder = ch;
      if (!ch.ok) {
        const why = `PF-DATA-1 counts cannot be met: ${ch.problems.join("; ")}`;
        if (st.status === "optional") st.dropped = why;
        else st.failed = why;
        console.log(`\n${st.id}: ${st.status === "optional" ? "DROPPED" : "FAILED"} — ${why}`);
      } else steps.set(st.id, ch.steps);
    }
    let shipped = shippable.filter((s) => !s.dropped && !s.failed);
    let exports = null, text = null, gz = 0, draftIds = [];
    const build = () => {
      exports = shipped.map((st) => {
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
        });
        out.set = set;
        out.ladder = steps.get(st.id);
        return out;
      });
      draftIds = exports.filter((e) => e.draft.length).map((e) => e.stage.id);
      text = dataFileText(exports.map((e) => e.stage), draftIds);
      gz = gzipSync(text).length;
    };
    /** The gzip ladder: every group of every stage one step up until the file fits; false if it never does. */
    const fitGzip = () => {
      build();
      while (gz > GZIP_LIMIT) {
        const next = shipped.map((st) => ex.raiseAll(steps.get(st.id)));
        if (next.every((x) => x === null)) {
          console.log(`\nPF-SIZE-1 FAILED: gzip ${gz} bytes > ${GZIP_LIMIT} with every ladder group at ${ex.LADDER_STEPS.at(-1) * 100}%`);
          return false;
        }
        console.log(`gzip ${gz} bytes > ${GZIP_LIMIT}: raising every ladder group one step`);
        shipped.forEach((st, i) => next[i] && steps.set(st.id, next[i]));
        build();
      }
      return true;
    };
    // The snapped-gain gate again on the final export sets (a gzip step changes them), with §4.6's per-stage rule: an
    // optional stage over it is dropped and the others start again from their count ladders (their gzip steps were
    // for a bigger file); a required one fails the run. There is no cold4 re-solve at this point.
    for (;;) {
      if (!shipped.length) {
        exports = null;
        break;
      }
      if (!fitGzip()) {
        exitCode = 1;
        break;
      }
      const over = args.ignoreGates ? [] : exports.filter((e) => e.stage.snappedGainMbb > solveM.DEFAULT_GATES.snappedGainMbb);
      if (!over.length) break;
      for (const e of over) {
        const st = states.get(e.stage.id);
        const why = `snapped gain ${e.stage.snappedGainMbb} mbb on the final export set (gate ${solveM.DEFAULT_GATES.snappedGainMbb})`;
        if (st.status === "optional") st.dropped = why;
        else st.failed = why;
        console.log(`\n${st.id}: ${st.status === "optional" ? "DROPPED" : "FAILED"} — ${why}`);
      }
      if (all.some((x) => x.failed)) break; // nothing is written; the summaries still show the last export
      shipped = shipped.filter((x) => !x.dropped);
      for (const st of shipped) steps.set(st.id, st.countLadder.steps);
    }

    // ── close calls and artifact flags (§6.9, §6.10) on the final export sets ──
    // The ladder above ran on annotation-free text, so the annotations never change which spots ship. Per stage one
    // evaluation of σ̄ (the unsnapped average the chart rounds) with the best-response action values, about 0.8 s.
    const plainGz = gz;
    if (exports) {
      for (const e of exports) {
        const st = states.get(e.stage.id);
        if (!evalSolvers.has(st.id)) evalSolvers.set(st.id, solveM.createSolver(st.tree, table, { valuation: ex.stageValuation(EQR_FIT, features) }));
        // brActionValues is 15 MB at 100bb: it lives only for this call.
        const { brActionValues } = evalSolvers.get(st.id).evaluate(st.main.avg, { brActionValues: true });
        e.stage = ex.annotateStage(e.stage, { tree: st.tree, classes: st.classes, nodes: e.nodes, brActionValues, eps: ex.CLOSE_EPS });
      }
      text = dataFileText(exports.map((e) => e.stage), draftIds);
      gz = gzipSync(text).length;
      // PF-SIZE-1 after the annotations: close strings come off the rarest spots first (the ladder of CLOSE_LADDER),
      // rather than failing a run that may have taken hours over a feature that is not a gate. dropClose recomputes
      // the flags of a stage that loses a string (a cell whose mark is gone is clear again); a step that drops
      // nothing is skipped.
      if (gz > GZIP_LIMIT) {
        const full = exports.map((e) => e.stage);
        let fits = false;
        for (const t of ex.CLOSE_LADDER) {
          const dropped = ex.dropClose(full, t);
          const lost = full.reduce((n, s, i) => n + s.scenarios.filter((sc, j) => sc.close !== undefined && dropped[i].scenarios[j].close === undefined).length, 0);
          if (!lost) continue;
          console.log(`PF-SIZE-1: annotated gzip ${gz} > ${GZIP_LIMIT}; close strings kept only on spots with occ ≥ ${t}% (${lost} spots lost theirs)`);
          exports.forEach((e, i) => (e.stage = dropped[i]));
          text = dataFileText(exports.map((e) => e.stage), draftIds);
          gz = gzipSync(text).length;
          if (gz <= GZIP_LIMIT) {
            fits = true;
            break;
          }
        }
        if (!fits) {
          console.log(`\nPF-SIZE-1 FAILED after annotations: gzip ${gz} bytes > ${GZIP_LIMIT} with close strings only on spots with occ ≥ ${ex.CLOSE_LADDER.at(-1)}%`);
          exitCode = 1;
        }
      }
    }

    // ── the self-checks of the written data ──
    for (const e of exports ?? []) {
      const st = states.get(e.stage.id);
      // PF-SANITY-1/2/3 failures fail the data tests, so they stop the run too (unless the gates are ignored).
      // flagProblems: the flags must be the ones the stored close strings give (the data test re-derives them).
      const problems = [...ex.dataChecks(e.stage), ...ex.flagProblems(e.stage), ...reproductionProblems(e, st), ...(args.ignoreGates ? [] : e.sanity.fails)];
      if (problems.length) {
        console.log(`${st.id}: DATA SELF-CHECK FAILED:\n  ${problems.slice(0, 20).join("\n  ")}`);
        exitCode = 1;
      }
    }

    // ── summaries ──
    mkdirSync(args.summaryDir, { recursive: true });
    const overlap = states.get("25bb-2")?.main ? overlapReport(states.get("25bb-2")) : null;
    for (const st of all) {
      const e = exports?.find((x) => x.stage.id === st.id) ?? null;
      const lines = summaryLines(st, e, st.id === "25bb-2" ? overlap : null);
      console.log("\n" + lines.join("\n"));
      writeFileSync(`${args.summaryDir}/summary-${st.id}.txt`, lines.join("\n") + "\n");
    }
    if (shipped.length && exports) console.log(`\ndata file: ${exports.length} stage(s), ${exports.reduce((a, e) => a + e.stage.scenarios.length, 0)} scenarios, ${Buffer.byteLength(text)} bytes, gzip ${gz} bytes (limit ${GZIP_LIMIT}; ${plainGz} without close calls and flags)${draftIds.length ? `; DRAFT stages: ${draftIds.join(", ")}` : ""}`);

    // ── dumps ──
    if (args.dump) for (const st of all) if (st.main) writeDump(st, exports?.find((x) => x.stage.id === st.id) ?? null);

    // ── determinism (--check) ──
    if (det) {
      const [a, b] = det;
      const sha = (x) => createHash("sha256").update(Buffer.from(x.avg.buffer)).digest("hex");
      const tr = treeM.buildTree(treeM.stageConfig(DET_STAGE));
      const classes = ex.classifyTree(tr);
      const detEval = solveM.createSolver(tr, table, { valuation: ex.stageValuation(EQR_FIT, features) });
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
    if (!shipped.length) {
      console.log("\nNo shippable stage was solved: nothing written.");
      return exitCode;
    }
    if (exitCode) {
      console.log("\nChecks failed: nothing written.");
      return exitCode;
    }
    if (args.check) {
      const committed = existsSync(args.out) ? readFileSync(args.out, "utf8") : "";
      const same = committed === text;
      console.log(`\n--check: ${args.out.replace(root, "")} ${same ? "is up to date" : "WOULD CHANGE"} (sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 12)})`);
      return same ? 0 : 1;
    }
    writeFileSync(args.out, text);
    console.log(`\nwrote ${args.out.replace(root, "")} (sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 12)})`);
    return 0;
  }

  // ── the data file ──
  function dataFileText(stages, draftIds) {
    return `// Generated by scripts/make-preflop.mjs. Do not edit by hand; rerun the script instead.
// Solver preflop charts: 9-handed, BB ante 1bb, equal stacks, chip EV. Every number comes from our own DCFR preflop
// solver (src/poker/preflop) with the postflop realization model fitted to our own solver packs
// (src/poker/preflop/eqrFit.ts); no commercial or third-party chart or solver output is used.
// Shape: src/data/sets/preflopTypes.ts. Design and validation: docs/preflop-solver.md.
import type { PreflopStage } from "./preflopTypes";

/**
 * Stages written by a development run (--no-sensitivity, --no-twostart or --ignore-gates): their confidence comes
 * only from the checks that ran and their \`move\` is 0. Empty in a release run.
 */
export const PREFLOP_DRAFT_STAGES: string[] = ${JSON.stringify(draftIds)};

export const PREFLOP_STAGES: PreflopStage[] = ${JSON.stringify(stages, null, 1)};
`;
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

  // ── PF-OVERLAP (§5.4): the 25bb solve against shortNash 25bb (a loose check: the trees are not the same game) ──
  function overlapReport(st) {
    const sn = SHORT_NASH_STAGES.find((x) => x.stack === 25);
    if (!sn) return ["PF-OVERLAP: shortNashData has no 25bb stage"];
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
    const L = [`PF-OVERLAP vs shortNash 25bb (open ${SHORT_NASH_OPEN}bb; within ${OVERLAP_PP}pp is ok, a warning only):`];
    const rfi = [];
    let off = 0;
    for (let s = 0; s < tr.n - 1; s++) {
      const a = ours(`rfi-${sid(names[s])}`), b = theirs([sn.open[names[s]], sn.jam[names[s]]]);
      const bad = a !== null && Math.abs(a - b) > OVERLAP_PP;
      if (bad) off++;
      rfi.push(`${names[s]} ${a?.toFixed(1)} vs ${b.toFixed(1)}${bad ? " WARN" : ""}`);
    }
    L.push(`  open + jam total (ours vs shortNash; our SB includes limps): ${rfi.join(" / ")}`);
    const def = [];
    for (let o = 0; o < tr.n - 1; o++) {
      const a = ours(`bb-vs-${sid(names[o])}-open`), b = theirs([sn.reJam.BB?.[names[o]], sn.bbCall[names[o]]]);
      def.push(`${names[o]} ${a?.toFixed(1)} vs ${b.toFixed(1)} (${a === null ? "?" : (a - b >= 0 ? "+" : "") + (a - b).toFixed(1)})`);
    }
    L.push(`  BB defense vs an open (ours vs shortNash, difference): ${def.join(" / ")}`);
    L.push(`  ${off ? `WARN: ${off} seat(s) outside ${OVERLAP_PP}pp` : `every seat within ${OVERLAP_PP}pp`}`);
    return L;
  }

  // ── summaries ──
  function summaryLines(st, e, overlap) {
    const L = [];
    const names = treeM.seatNames(9);
    const r = st.main;
    const tag = st.failed ? "FAILED" : st.dropped ? "DROPPED" : st.status === "check" ? "CHECK ONLY" : r?.pass ? "PASS" : "GATES IGNORED";
    L.push(`=== ${st.id} (${ex.STAGE_LABELS[st.id] ?? "validation only"}): ${tag}${r ? ` at ${r.iterations} iterations${r.polished ? " (polished)" : ""}, ${r.seconds.toFixed(0)} s, ${r.msPerIteration.toFixed(0)} ms/iteration` : ""} ===`);
    for (const n of st.notes) L.push(`note: ${n}`);
    if (st.failed) L.push(`failure: ${st.failed}`);
    if (st.dropped) L.push(`dropped: ${st.dropped}`);
    if (!r) return L;
    L.push(`tree: ${st.tree.nodeCount} nodes, ${st.tree.edgeCount} edges, ${st.tree.termCount} terminals; cold4 ${st.tree.cfg.cold4}${st.fallback ? " (fallback)" : ""}`);
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
      const stageText = JSON.stringify(e.stage, null, 1);
      L.push(`stage size: ${Buffer.byteLength(stageText)} bytes, gzip ${gzipSync(stageText).length} bytes on its own`);
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
