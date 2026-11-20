// Computes the push/fold Nash charts in src/data/sets/nashData.ts with the preflop solver's own DCFR engine
// (src/poker/preflop, docs/preflop-solver.md): the push/fold tree (`pushFoldConfig`, the game of src/poker/pushfold.ts:
// first in jam or fold, then call or fold in table order, the first call closes), showdown equity at every all-in, the
// §4.6 schedule and gates (1,500 iterations, then +250 until the gates pass, at most 4,000) and the chart's 0.1 grid
// (`snapStrategy`, §6.5). The solver set's `10bb-pf` stage is the same game on the same engine and schedule, so nash
// 10bb equals it cell for cell (src/data/nashData.test.ts).
//
// Usage: node scripts/make-nash.mjs [--check] [--compare FILE]
//   --check          solve again and compare with the committed nashData.ts; exit 1 if it would change. Writes nothing.
//   --compare FILE   the chart to report the changes against (default: the committed nashData.ts before the write).
// About two minutes on one core; the equity table is cached in node_modules/.cache (scripts/equity-cache.mjs).
// Per stack it prints the gates, a second solve from PF-TWOSTART's start (§5.4, print only), the NashConv of the old
// and the new chart in this engine, and how the chart moved. The output is a pure function of the code and the table.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runnerImport } from "vite";
import { equityTableSha256, load, loadEquityTable } from "./equity-cache.mjs";

const root = new URL("..", import.meta.url).pathname;
const OUT = root + "src/data/sets/nashData.ts";
const STACKS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 20];
const SEATS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const N = 169;
const TWOSTART_WARMUP = 50;

const args = { check: false, compare: null };
for (let i = 2; i < process.argv.length; i++) {
  const f = process.argv[i];
  if (f === "--check") args.check = true;
  else if (f === "--compare") args.compare = process.argv[++i];
  else throw new Error(`unknown flag ${f}`);
}

const treeM = await load("src/poker/preflop/tree.ts");
const solveM = await load("src/poker/preflop/solve.ts");
const { rangeText, TWOSTART_MIN_REACH } = await load("src/poker/preflop/export.ts");
const { ALL_HANDS } = await load("src/poker/cards.ts");
const { parseRange } = await load("src/poker/range.ts");
const table = await loadEquityTable();
const cw = solveM.comboWeights();
const t0 = Date.now();

// The chart the changes are reported against: --compare FILE, else the committed file.
const comparePath = args.compare ? resolve(args.compare) : existsSync(OUT) ? OUT : null;
const OLD = comparePath ? (await runnerImport(comparePath)).module.NASH_STAGES : [];
const vec = (text) => {
  const r = parseRange(text ?? "");
  return Float64Array.from(ALL_HANDS, (h) => r[h] ?? 0);
};
const pct = (f) => {
  let s = 0;
  for (let h = 0; h < N; h++) s += f[h] * cw[h];
  return (s / 1326) * 100;
};
/** Every push/fold node is fold or one other action (jam first in, call facing a jam). */
const otherAction = (tree, p) => {
  if (tree.actStart[p + 1] - tree.actStart[p] !== 2 || tree.foldIdx[p] < 0) throw new Error(`node ${p} is not fold-or-one-action`);
  return tree.foldIdx[p] === 0 ? 1 : 0;
};
/** A strategy array from per-node vectors of the non-fold action; the fold takes the rest. */
function strategyOf(tree, get) {
  const out = new Float64Array(tree.edgeCount * N);
  for (let p = 0; p < tree.nodeCount; p++) {
    const e0 = tree.actStart[p], a = otherAction(tree, p), v = get(tree.nodes[p]);
    for (let h = 0; h < N; h++) {
      out[(e0 + a) * N + h] = Math.min(1, v[h]);
      out[(e0 + tree.foldIdx[p]) * N + h] = 1 - Math.min(1, v[h]);
    }
  }
  return out;
}
const column = (tree, strategy, p) => {
  const a = otherAction(tree, p);
  return strategy.subarray((tree.actStart[p] + a) * N, (tree.actStart[p] + a + 1) * N);
};
const allNodes = (tree) => Array.from({ length: tree.nodeCount }, (_, p) => p);

const stages = [];
const report = [];
let failed = false;
for (const stack of STACKS) {
  const s0 = Date.now();
  const tree = treeM.buildTree(treeM.pushFoldConfig({ players: 9, stack, sb: 0.5, bb: 1, bbAnte: 1 }));
  if (tree.nodeCount !== 44) throw new Error(`push/fold tree at ${stack}bb has ${tree.nodeCount} nodes, expected 44`);
  const solver = solveM.createSolver(tree, table, { valuation: { kind: "equity" } });
  const sched = solveM.runSchedule(solver);
  const avg = solver.average();
  const snapped = solveM.snapStrategy(tree, avg, allNodes(tree), N);
  const evS = solver.evaluate(snapped);
  const r = sched.report;
  if (!sched.pass) {
    failed = true;
    console.log(`${stack}bb FAILS its gates at ${sched.iterations} (${r.failures.join(", ")})`);
  }

  // PF-TWOSTART (§5.4, print only): the largest action-share difference of each solve's own reaching range at a node
  // the solver would export (occ ≥ 0.1%) whose reach is at least 1% (every push/fold node, in practice).
  const two = solveM.createSolver(tree, table, { valuation: { kind: "equity" } });
  solveM.runSchedule(two, { twoStart: TWOSTART_WARMUP });
  const avg2 = two.average();
  let twoWorst = 0;
  for (let p = 0; p < tree.nodeCount; p++) {
    if (!solveM.defaultExported(tree, r.evaluation, p) || !(r.evaluation.reach[p] >= TWOSTART_MIN_REACH)) continue;
    const a = solveM.actionShares(tree, avg, p, cw, solveM.ownReach(tree, avg, p, N));
    const b = solveM.actionShares(tree, avg2, p, cw, solveM.ownReach(tree, avg2, p, N));
    for (let k = 0; k < a.length; k++) twoWorst = Math.max(twoWorst, Math.abs(a[k] - b[k]));
  }

  const push = {}, call = {};
  const nodeOf = new Map();
  for (let p = 0; p < tree.nodeCount; p++) {
    const info = tree.nodes[p];
    const v = Array.from(column(tree, snapped, p));
    if (info.facingJam) {
      (call[SEATS[info.seat]] ??= {})[SEATS[info.jammer]] = rangeText(v);
      nodeOf.set(`call ${SEATS[info.seat]} ${SEATS[info.jammer]}`, p);
    } else {
      push[SEATS[info.seat]] = rangeText(v);
      nodeOf.set(`push ${SEATS[info.seat]}`, p);
    }
  }
  // Fixed key order (seat order), so the file does not depend on the tree's node order.
  const pushOut = Object.fromEntries(SEATS.slice(0, 8).map((s) => [s, push[s]]));
  const callOut = {};
  for (let j = 1; j < 9; j++) for (let i = 0; i < j; i++) (callOut[SEATS[j]] ??= {})[SEATS[i]] = call[SEATS[j]][SEATS[i]];
  stages.push({
    stack,
    exploitability: Math.round(evS.maxGainMbb * 10) / 10000,
    nashConvMbb: Math.round(evS.nashConvMbb * 1000) / 1000,
    iterations: sched.iterations,
    push: pushOut,
    call: callOut,
  });

  // Against the old chart: its NashConv in this engine, aggregates, and cells that moved by 0.3 or more.
  const old = OLD.find((x) => x.stack === stack);
  let line = `${String(stack).padStart(2)}bb ${sched.pass ? "PASS" : "FAIL"} at ${sched.iterations} it (${((Date.now() - s0) / 1000).toFixed(1)} s): σ̄ gain ${r.maxGainMbb.toFixed(4)} NC ${r.nashConvMbb.toFixed(4)}, snapped gain ${evS.maxGainMbb.toFixed(4)} NC ${evS.nashConvMbb.toFixed(4)} mbb/hand; two-start worst ${(twoWorst * 100).toFixed(2)}pp`;
  if (old) {
    const oldStrat = strategyOf(tree, (info) => vec(info.facingJam ? old.call[SEATS[info.seat]]?.[SEATS[info.jammer]] : old.push[SEATS[info.seat]]));
    const evO = solver.evaluate(oldStrat);
    let moved = 0, worst = { d: 0, at: "" };
    for (let p = 0; p < tree.nodeCount; p++) {
      const info = tree.nodes[p], o = column(tree, oldStrat, p), n = column(tree, snapped, p);
      for (let h = 0; h < N; h++) {
        const d = Math.abs(o[h] - n[h]);
        if (d >= 0.3 - 1e-9) moved++;
        if (d > worst.d) worst = { d, at: `${info.facingJam ? `${SEATS[info.seat]} call vs ${SEATS[info.jammer]}` : `${SEATS[info.seat]} push`} ${ALL_HANDS[h]} ${o[h].toFixed(1)}→${n[h].toFixed(1)}` };
      }
    }
    const agg = (key) => {
      const p = nodeOf.get(key);
      return `${pct(column(tree, oldStrat, p)).toFixed(1)}/${pct(column(tree, snapped, p)).toFixed(1)}`;
    };
    line += `\n     old chart NC ${evO.nashConvMbb.toFixed(2)} (gain ${evO.maxGainMbb.toFixed(2)}) → new ${evS.nashConvMbb.toFixed(2)} mbb/hand; cells moved ≥ 0.3: ${moved} of ${tree.nodeCount * N}${worst.d ? `, worst ${worst.at}` : ""}`;
    line += `\n     push% old/new: ${SEATS.slice(0, 8).map((s) => `${s} ${agg(`push ${s}`)}`).join(" | ")}`;
    line += `\n     BB call% old/new: ${["UTG", "LJ", "CO", "BTN", "SB"].map((s) => `vs ${s} ${agg(`call BB ${s}`)}`).join(" | ")}`;
    report.push({ stack, oldNc: evO.nashConvMbb, newNc: evS.nashConvMbb, moved });
  }
  console.log(line);
}
if (failed) {
  console.log("a stack failed its gates: nothing written");
  process.exit(1);
}

const out = `// Generated by scripts/make-nash.mjs. Do not edit by hand; rerun the script instead.
// Chip-EV push/fold Nash for a 9-handed table with a 1bb BB ante, everyone on the same stack, no overcalls (the game
// of src/poker/pushfold.ts). Solved with the preflop solver's DCFR engine (src/poker/preflop, docs/preflop-solver.md)
// on the §4.6 schedule and gates, snapped to the chart's 0.1 grid (§6.5); the solver set's 10bb-pf stage is the same
// game, engine and schedule, so its push and call ranges equal the 10bb stage here cell for cell.

export interface NashStage {
  /** Everyone's stack in bb at the start of the hand. */
  stack: number;
  /** The snapped chart's largest per-seat best-response gain, bb/hand (each seat in its own world, §4.3). */
  exploitability: number;
  /** The snapped chart's NashConv (Σ of the seats' gains), mbb/hand. */
  nashConvMbb: number;
  /** DCFR iterations the §4.6 schedule ran before the gates passed. */
  iterations: number;
  /** Shove range when folded to the seat. */
  push: Record<string, string>;
  /** call[caller][shover]: calling range when everyone between folded. */
  call: Record<string, Record<string, string>>;
}

/** The engine and the equity table (sha256 of scripts/equity-cache.mjs's table) the charts were solved with. */
export const NASH_SOURCE = { engine: "dcfr", equityTable: "${equityTableSha256(table)}" } as const;

export const NASH_STAGES: NashStage[] = ${JSON.stringify(stages, null, 2)};
`;

if (report.length) {
  const nc = report.map((x) => `${x.stack}bb ${x.oldNc.toFixed(2)}→${x.newNc.toFixed(2)}`).join(", ");
  console.log(`\nNashConv old → new (mbb/hand): ${nc}`);
}
if (args.check) {
  const same = existsSync(OUT) && readFileSync(OUT, "utf8") === out;
  console.log(`--check: ${same ? "nashData.ts is reproduced byte for byte" : "nashData.ts WOULD CHANGE"} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exit(same ? 0 : 1);
}
writeFileSync(OUT, out);
console.log(`wrote src/data/sets/nashData.ts (${Buffer.byteLength(out)} bytes) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
