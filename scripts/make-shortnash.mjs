// Computes the short-stack open / re-jam charts in src/data/sets/shortNashData.ts with the preflop solver's own DCFR
// engine (src/poker/preflop, docs/preflop-solver.md) on its own open/jam game (`openJamConfig`, the game of
// src/poker/openjam.ts): first in fold / 2bb open / jam; over an open re-jam or fold, the BB may also flat; the opener
// calls or folds a re-jam; a first-in jam is called or folded in table order, the first call closes. After a BB flat the
// hand is checked down and the BB realizes R(h) of its equity (src/poker/realization.ts, the "oneSided" valuation).
// The §4.6 schedule and gates (1,500 iterations, then +250 until the gates pass, at most 4,000) and the chart's 0.1
// grid (`snapStrategy`, §6.5), as for the solver set. This set is the interim chart for 12–25bb until the calibrated
// short-stack solver stages ship.
//
// Usage: node scripts/make-shortnash.mjs [--check] [--compare FILE] [--workers N]
//   --check          solve again and compare with the committed shortNashData.ts; exit 1 if it would change.
//   --compare FILE   the chart to report the changes against (default: the committed shortNashData.ts before the write).
//   --workers N      stacks solved at once (default min(4, CPUs)); the output does not depend on it.
// About a minute on 4 workers; reuses the cached equity table (scripts/equity-cache.mjs). Per stack it prints the
// gates, a second solve from PF-TWOSTART's start (§5.4, print only), the NashConv of the old and the new chart in this
// engine, and how the chart moved. The output is a pure function of the code and the table.
//
// Out-of-reach cells: the opener's call of a re-jam (callReJam) is only reached by the hands it opens. The file has
// no reach field and the chart grid shows all 169 hands, so a hand the snapped chart never opens gets the pure best
// response to the snapped chart there (call when calling is worth more than folding), as the fictitious-play file did:
// the grid reads "if you had opened it". Those cells carry no weight in any EV, so they change no metric.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { runnerImport } from "vite";
import { equityTableSha256, load, loadEquityTable } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const OUT = root + "src/data/sets/shortNashData.ts";
const STACKS = [10, 12, 15, 17, 20, 25];
const SEATS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const OPEN = 2;
const N = 169;
const TWOSTART_WARMUP = 50;
/**
 * §4.6's start (1,500), step (250) and gates, with a later cap than its 4,000: where opens are rare the open/jam game
 * converges slowly (at 10bb nobody opens, and the answers to an open that keep the openers from opening settle late).
 * An iteration costs about 5 ms on this 116-node tree, so 16,000 is under two minutes.
 */
const SCHEDULE = { max: 16000 };

/** The data field and the seats a node of the open/jam tree stands for; the action key → field map. */
function fieldOf(info) {
  const me = SEATS[info.seat];
  if (info.facingJam && info.jamFirstIn) return { C: ["callJam", me, SEATS[info.jammer]] };
  if (info.facingJam) return { C: ["callReJam", SEATS[info.opener], SEATS[info.jammer]] };
  if (info.raises === 0) return { R: ["open", me], J: ["jam", me] };
  return { J: ["reJam", me, SEATS[info.opener]], ...(me === "BB" ? { C: ["bbCall", SEATS[info.opener]] } : {}) };
}
const getField = (st, path) => (path.length === 2 ? st[path[0]][path[1]] : st[path[0]][path[1]]?.[path[2]]);

// ───────────────────────── worker: one stack ─────────────────────────

if (!isMainThread && workerData?.shortNash) {
  const treeM = await load("src/poker/preflop/tree.ts");
  const solveM = await load("src/poker/preflop/solve.ts");
  const { rangeText, TWOSTART_MIN_REACH } = await load("src/poker/preflop/export.ts");
  const { ALL_HANDS } = await load("src/poker/cards.ts");
  const { parseRange } = await load("src/poker/range.ts");
  const { realizationAt } = await load("src/poker/realization.ts");
  const { eq, cnt, stack, old } = workerData;
  const table = { eq, cnt };
  const t0 = Date.now();
  const cw = solveM.comboWeights();
  const tree = treeM.buildTree(treeM.openJamConfig({ players: 9, stack, sb: 0.5, bb: 1, bbAnte: 1, open: OPEN }));
  const valuation = { kind: "oneSided", R: Float64Array.from(ALL_HANDS, (h) => realizationAt(h, stack, OPEN)) };
  const allNodes = Array.from({ length: tree.nodeCount }, (_, p) => p);

  const solver = solveM.createSolver(tree, table, { valuation });
  const sched = solveM.runSchedule(solver, SCHEDULE);
  const avg = solver.average();
  const chart = solveM.snapStrategy(tree, avg, allNodes, N);

  // Out-of-reach cells of the opener's call of a re-jam: the pure best response to the snapped chart.
  const { actionValues } = solver.evaluate(chart, { actionValues: true });
  const rho = new Float64Array(N);
  let filled = 0;
  for (let p = 0; p < tree.nodeCount; p++) {
    const info = tree.nodes[p];
    solveM.ownReach(tree, chart, p, N, rho);
    let partial = false;
    for (let h = 0; h < N; h++) if (rho[h] < 1) partial = true;
    if (!partial) continue;
    if (!(info.facingJam && !info.jamFirstIn)) throw new Error(`node ${p}: partial reach outside the opener's call of a re-jam`);
    const e0 = tree.actStart[p], f = tree.foldIdx[p], c = 1 - f;
    for (let h = 0; h < N; h++) {
      if (rho[h] > 0) continue;
      const callIt = actionValues[(e0 + c) * N + h] > actionValues[(e0 + f) * N + h] ? 1 : 0;
      chart[(e0 + c) * N + h] = callIt;
      chart[(e0 + f) * N + h] = 1 - callIt;
      filled++;
    }
  }
  const evS = solver.evaluate(chart);
  // The gates snap only the spots the solver would export (occ ≥ 0.1%); the file holds every spot on the 0.1 grid, so
  // the written chart must pass the snapped-gain gate as well.
  const chartPass = evS.maxGainMbb <= solveM.DEFAULT_GATES.snappedGainMbb;

  // PF-TWOSTART (§5.4, print only): the largest action-share difference of each solve's own reaching range at a node
  // the solver would export (occ ≥ 0.1%) whose reach is at least 1%.
  const two = solveM.createSolver(tree, table, { valuation });
  solveM.runSchedule(two, { ...SCHEDULE, twoStart: TWOSTART_WARMUP });
  const avg2 = two.average();
  let twoWorst = { d: 0, at: "" };
  for (let p = 0; p < tree.nodeCount; p++) {
    const ev = sched.report.evaluation;
    if (!solveM.defaultExported(tree, ev, p) || !(ev.reach[p] >= TWOSTART_MIN_REACH)) continue;
    const a = solveM.actionShares(tree, avg, p, cw, solveM.ownReach(tree, avg, p, N));
    const b = solveM.actionShares(tree, avg2, p, cw, solveM.ownReach(tree, avg2, p, N));
    for (let k = 0; k < a.length; k++) {
      const d = Math.abs(a[k] - b[k]);
      if (d > twoWorst.d) twoWorst = { d, at: `${Object.values(fieldOf(tree.nodes[p]))[0].join(" ")} ${tree.nodes[p].actions[k].key}` };
    }
  }

  // The data: one range text per (node, non-fold action).
  const ranges = [];
  for (let p = 0; p < tree.nodeCount; p++) {
    const fields = fieldOf(tree.nodes[p]);
    tree.nodes[p].actions.forEach((a, k) => {
      if (a.key === "F") return;
      const path = fields[a.key];
      if (!path) throw new Error(`node ${p}: no field for action ${a.key}`);
      const v = Array.from(chart.subarray((tree.actStart[p] + k) * N, (tree.actStart[p] + k + 1) * N));
      ranges.push({ path, text: rangeText(v) });
    });
  }

  // Against the old chart: its NashConv in this engine (the same game), aggregates, and cells that moved by ≥ 0.3.
  const lines = [];
  let oldNc = null, moved = null;
  if (old) {
    const vec = (text) => {
      const r = parseRange(text ?? "");
      return Float64Array.from(ALL_HANDS, (h) => r[h] ?? 0);
    };
    // Non-fold actions are filled in display order (the earlier action takes first), the fold takes the rest.
    const oldStrat = new Float64Array(tree.edgeCount * N);
    for (let p = 0; p < tree.nodeCount; p++) {
      const info = tree.nodes[p], fields = fieldOf(info), left = new Float64Array(N).fill(1);
      info.actions.forEach((a, k) => {
        if (a.key === "F") return;
        const v = vec(getField(old, fields[a.key]));
        for (let h = 0; h < N; h++) {
          const x = Math.min(v[h], left[h]);
          oldStrat[(tree.actStart[p] + k) * N + h] = x;
          left[h] -= x;
        }
      });
      const f = tree.foldIdx[p];
      for (let h = 0; h < N; h++) oldStrat[(tree.actStart[p] + f) * N + h] = left[h];
    }
    const evO = solver.evaluate(oldStrat);
    oldNc = evO.nashConvMbb;
    moved = 0;
    let movedInReach = 0, worst = { d: 0, at: "" };
    for (let p = 0; p < tree.nodeCount; p++) {
      const info = tree.nodes[p], fields = fieldOf(info), e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
      solveM.ownReach(tree, chart, p, N, rho);
      for (let h = 0; h < N; h++) {
        let d = 0, k0 = 0;
        for (let k = 0; k < A; k++) {
          const x = Math.abs(oldStrat[(e0 + k) * N + h] - chart[(e0 + k) * N + h]);
          if (x > d) [d, k0] = [x, k];
        }
        if (d >= 0.3 - 1e-9) {
          moved++;
          if (rho[h] > 0) movedInReach++;
        }
        if (d > worst.d) {
          const key = info.actions[k0].key;
          worst = { d, at: `${(fields[key] ?? ["fold", SEATS[info.seat]]).join(" ")} ${key} ${ALL_HANDS[h]} ${oldStrat[(e0 + k0) * N + h].toFixed(1)}→${chart[(e0 + k0) * N + h].toFixed(1)}` };
        }
      }
    }
    const share = (strat, p, key) => {
      const k = tree.nodes[p].actions.findIndex((a) => a.key === key);
      return k < 0 ? 0 : solveM.actionShares(tree, strat, p, cw, solveM.ownReach(tree, strat, p, N))[k] * 100;
    };
    const find = (pred) => tree.nodes.findIndex(pred);
    const two2 = (strat, p, a, b) => `${share(strat, p, a).toFixed(1)}+${share(strat, p, b).toFixed(1)}`;
    const rfi = [], bb = [], cj = [];
    for (let s = 0; s < 8; s++) {
      const p = find((i) => i.seat === s && i.raises === 0 && !i.facingJam);
      rfi.push(`${SEATS[s]} ${two2(oldStrat, p, "R", "J")} / ${two2(chart, p, "R", "J")}`);
      const q = find((i) => i.seat === 8 && i.raises === 1 && !i.facingJam && i.opener === s);
      bb.push(`${SEATS[s]} ${two2(oldStrat, q, "C", "J")} / ${two2(chart, q, "C", "J")}`);
      const j = find((i) => i.seat === 8 && i.facingJam && i.jamFirstIn && i.jammer === s);
      if ([0, 5, 6, 7].includes(s)) cj.push(`vs ${SEATS[s]} ${share(oldStrat, j, "C").toFixed(1)} / ${share(chart, j, "C").toFixed(1)}`);
    }
    lines.push(
      `     old chart NC ${evO.nashConvMbb.toFixed(2)} (gain ${evO.maxGainMbb.toFixed(2)}) → new ${evS.nashConvMbb.toFixed(2)} mbb/hand; cells moved ≥ 0.3: ${moved} of ${tree.nodeCount * N} (${movedInReach} in reach)${worst.d ? `, worst ${worst.at}` : ""}`,
      `     open+jam% old / new: ${rfi.join(" | ")}`,
      `     BB call+re-jam% vs an open, old / new: ${bb.join(" | ")}`,
      `     BB call% vs a first-in jam, old / new: ${cj.join(" | ")}`,
    );
  }
  const r = sched.report;
  lines.unshift(
    `${String(stack).padStart(2)}bb ${sched.pass && chartPass ? "PASS" : `FAIL (${[...r.failures, ...(chartPass ? [] : ["chart"])].join(", ")})`} at ${sched.iterations} it (${((Date.now() - t0) / 1000).toFixed(0)} s): σ̄ gain ${r.maxGainMbb.toFixed(3)} NC ${r.nashConvMbb.toFixed(3)}, snapped (gate) ${r.snappedMaxGainMbb.toFixed(3)}, chart gain ${evS.maxGainMbb.toFixed(3)} NC ${evS.nashConvMbb.toFixed(3)} mbb/hand, worst exported regret ${r.worstExportedRegret.toFixed(4)} bb; ${filled} out-of-reach cells filled; two-start worst ${(twoWorst.d * 100).toFixed(2)}pp (${twoWorst.at})`,
  );
  parentPort.postMessage({
    stack,
    pass: sched.pass && chartPass,
    iterations: sched.iterations,
    maxGainMbb: evS.maxGainMbb,
    nashConvMbb: evS.nashConvMbb,
    oldNc,
    moved,
    ranges,
    log: lines.join("\n"),
  });
} else if (isMainThread) {
  const args = { check: false, compare: null, workers: Math.min(4, cpus().length) };
  for (let i = 2; i < process.argv.length; i++) {
    const f = process.argv[i];
    if (f === "--check") args.check = true;
    else if (f === "--compare") args.compare = process.argv[++i];
    else if (f === "--workers") args.workers = Number(process.argv[++i]);
    else throw new Error(`unknown flag ${f}`);
  }
  if (!(Number.isInteger(args.workers) && args.workers > 0)) throw new Error("--workers must be a positive integer");
  const t0 = Date.now();
  const table = await loadEquityTable();
  const comparePath = args.compare ? resolve(args.compare) : existsSync(OUT) ? OUT : null;
  const OLD = comparePath ? (await runnerImport(comparePath)).module.SHORT_NASH_STAGES : [];

  // One worker per stack, at most --workers at once; results are put back in STACKS order.
  const queue = [...STACKS];
  const results = new Map();
  await Promise.all(
    Array.from({ length: Math.min(args.workers, STACKS.length) }, async () => {
      while (queue.length) {
        const stack = queue.shift();
        const old = OLD.find((x) => x.stack === stack) ?? null;
        const res = await new Promise((resolveJob, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { shortNash: true, eq: table.eq, cnt: table.cnt, stack, old } });
          w.once("message", resolveJob);
          w.once("error", reject);
        });
        console.log(res.log);
        results.set(stack, res);
      }
    }),
  );
  const failed = STACKS.filter((s) => !results.get(s).pass);
  if (failed.length) {
    console.log(`${failed.join(", ")}bb failed the gates: nothing written`);
    process.exit(1);
  }

  const stages = STACKS.map((stack) => {
    const r = results.get(stack);
    const st = {
      stack,
      exploitability: Math.round(r.maxGainMbb * 10) / 10000,
      nashConvMbb: Math.round(r.nashConvMbb * 1000) / 1000,
      iterations: r.iterations,
      open: {},
      jam: {},
      reJam: {},
      bbCall: {},
      callReJam: {},
      callJam: {},
    };
    const text = new Map(r.ranges.map((x) => [x.path.join(" "), x.text]));
    const get = (...path) => {
      const t = text.get(path.join(" "));
      if (t === undefined) throw new Error(`${stack}bb: no range for ${path.join(" ")}`);
      return t;
    };
    // The key order of the fictitious-play file: openers in seat order, then the seats behind them.
    for (let i = 0; i < 8; i++) {
      const op = SEATS[i];
      st.open[op] = get("open", op);
      st.jam[op] = get("jam", op);
      st.bbCall[op] = get("bbCall", op);
      for (let j = i + 1; j < 9; j++) {
        const c = SEATS[j];
        (st.reJam[c] ??= {})[op] = get("reJam", c, op);
        (st.callJam[c] ??= {})[op] = get("callJam", c, op);
        (st.callReJam[op] ??= {})[c] = get("callReJam", op, c);
      }
    }
    if (text.size !== 8 * 3 + 36 * 3) throw new Error(`${stack}bb: ${text.size} ranges, expected ${8 * 3 + 36 * 3}`);
    return st;
  });

  const out = `// Generated by scripts/make-shortnash.mjs. Do not edit by hand; rerun the script instead.
// Chip-EV equilibrium for 9-handed short stacks with a 1bb BB ante: fold / ${OPEN}bb open / jam first in,
// re-jam or fold over an open (the BB may also flat), call or fold a jam. After a BB flat the hand is
// checked down and the BB realizes part of its equity by hand type (pairs and good suited hands 90%,
// offsuit broadways 85%, weak offsuit hands 50%; closer to 100% at short stacks; src/poker/realization.ts).
// Solved with the preflop solver's DCFR engine (src/poker/preflop, docs/preflop-solver.md) on that game
// (openJamConfig, the game of src/poker/openjam.ts), the §4.6 schedule and gates, snapped to the chart's 0.1 grid
// (§6.5). callReJam cells of hands the opener never opens hold the best response to the chart.

export interface ShortNashStage {
  stack: number;
  /** The snapped chart's largest per-seat best-response gain, bb/hand (each seat in its own world). */
  exploitability: number;
  /** The snapped chart's NashConv (Σ of the seats' gains), mbb/hand. */
  nashConvMbb: number;
  /** DCFR iterations the §4.6 schedule ran before the gates passed. */
  iterations: number;
  /** First in, per seat. */
  open: Record<string, string>;
  jam: Record<string, string>;
  /** reJam[me][opener]: 3-bet all-in over an open. */
  reJam: Record<string, Record<string, string>>;
  /** bbCall[opener]: the BB flats an open. */
  bbCall: Record<string, string>;
  /** callReJam[opener][reJammer]: the opener calls a re-jam. */
  callReJam: Record<string, Record<string, string>>;
  /** callJam[me][jammer]: call a first-in jam. */
  callJam: Record<string, Record<string, string>>;
}

/** The engine and the equity table (sha256 of scripts/equity-cache.mjs's table) the charts were solved with. */
export const SHORT_NASH_SOURCE = { engine: "dcfr", equityTable: "${equityTableSha256(table)}" } as const;

export const SHORT_NASH_OPEN = ${OPEN};
export const SHORT_NASH_STAGES: ShortNashStage[] = ${JSON.stringify(stages, null, 1)};
`;
  const withOld = STACKS.filter((s) => results.get(s).oldNc !== null);
  if (withOld.length) console.log(`\nNashConv old → new (mbb/hand): ${withOld.map((s) => `${s}bb ${results.get(s).oldNc.toFixed(2)}→${results.get(s).nashConvMbb.toFixed(2)}`).join(", ")}`);
  if (args.check) {
    const same = existsSync(OUT) && readFileSync(OUT, "utf8") === out;
    console.log(`--check: ${same ? "shortNashData.ts is reproduced byte for byte" : "shortNashData.ts WOULD CHANGE"} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(OUT, out);
  console.log(`wrote src/data/sets/shortNashData.ts (${Buffer.byteLength(out)} bytes) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
