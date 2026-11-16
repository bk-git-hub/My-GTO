import { describe, expect, it } from "vitest";
import { ALL_HANDS } from "../cards";
import { openJamGains, solveOpenJam, type OpenJamSetup, type OpenJamSolution } from "../openjam";
import { buildEquityTable, mulberry32, N, pushFoldGains, solvePushFold, type PushFoldSolution, type TableSetup } from "../pushfold";
import { realizationAt } from "../realization";
import { EQR_FIT } from "./eqrFit";
import { handFeatures } from "./features";
import {
  actionShares,
  comboWeights,
  createSolver,
  ownReach,
  runSchedule,
  snapTenths,
  twoStartInit,
  type PreflopSolver,
  type SolverOptions,
} from "./solve";
import { buildTree, openJamConfig, openOr3BetConfig, pushFoldConfig, stageConfig, type NodeInfo, type PreflopTree } from "./tree";
import { featureMatrix, zeroModelB } from "./value";

// The coarse table the other solver tests use; the shipped charts use the 12000-sample one.
const table = buildEquityTable(150, mulberry32(3));
const CW = comboWeights();
const FEATURES = featureMatrix(N, handFeatures);
const modelB: SolverOptions["valuation"] = { kind: "modelB", params: EQR_FIT, features: FEATURES };
const pct = (f: ArrayLike<number>) => {
  let s = 0;
  for (let h = 0; h < N; h++) s += f[h] * CW[h];
  return (s / 1326) * 100;
};

/** A strategy array filled per (node, action) from `probs`, which returns that action's per-class probabilities. */
function strategyOf(tree: PreflopTree, probs: (info: NodeInfo, a: number) => ArrayLike<number> | number, classes = N): Float64Array {
  const out = new Float64Array(tree.edgeCount * classes);
  for (let p = 0; p < tree.nodeCount; p++) {
    const info = tree.nodes[p];
    for (let a = 0; a < info.actions.length; a++) {
      const v = probs(info, a);
      const o = (tree.actStart[p] + a) * classes;
      if (typeof v === "number") out.fill(v, o, o + classes);
      else out.set(v, o);
    }
  }
  return out;
}

/** The fold takes whatever the other actions leave. */
const withFoldRest = (info: NodeInfo, a: number, nonFold: (key: string) => ArrayLike<number> | number) => {
  if (info.actions[a].key !== "F") return nonFold(info.actions[a].key);
  const rest = new Float64Array(N).fill(1);
  info.actions.forEach((x) => {
    if (x.key === "F") return;
    const v = nonFold(x.key);
    for (let h = 0; h < N; h++) rest[h] -= typeof v === "number" ? v : v[h];
  });
  return rest;
};

// ───────────── reference mappings: tree nodes ↔ the FP solvers' arrays ─────────────

const pushFoldProbs = (sol: Pick<PushFoldSolution, "push" | "call">) => (info: NodeInfo, a: number) =>
  withFoldRest(info, a, () => (info.facingJam ? sol.call[info.jammer][info.seat] : sol.push[info.seat]));

/** The solveOpenJam array behind a non-fold action of an openjam-mode node. */
function openJamArray(sol: Pick<OpenJamSolution, "open" | "jam" | "callJam" | "reJam" | "bbCall" | "callReJam">, info: NodeInfo, key: string): Float64Array {
  if (info.facingJam && info.jamFirstIn) return sol.callJam[info.jammer][info.seat];
  if (info.facingJam) return sol.callReJam[info.opener][info.jammer];
  if (info.raises === 0) return key === "R" ? sol.open[info.seat] : sol.jam[info.seat];
  return key === "J" ? sol.reJam[info.opener][info.seat] : sol.bbCall[info.opener];
}

/** solveOpenJam's starting strategy for the same action. */
function openJamStart(info: NodeInfo, key: string): number {
  if (info.facingJam) return info.jamFirstIn ? 0.2 : 0.3;
  if (info.raises === 0) return key === "R" ? 0.3 : 0.2;
  return key === "J" ? 0.1 : 0.3;
}

const openJamSetup = (players: number): OpenJamSetup => ({
  players,
  stack: 20,
  sb: 0.5,
  bb: 1,
  bbAnte: 1,
  open: 2,
  bbRealization: ALL_HANDS.map((h) => realizationAt(h, 20, 2)),
});

// Shared FP references for PF-RED-3 and PF-RED-4, computed once. The design's 3,000 / 2,000 iterations at 9 seats
// would take about 2.5 minutes in the reference solvers alone, so push/fold runs 1,000 iterations at 9 seats and
// open/jam 250 at 6 seats; the pass criteria are unchanged.
const RED3_PF: TableSetup = { players: 9, stack: 8, sb: 0.5, bb: 1, bbAnte: 1 };
const RED3_PF_ITERS = 1000;
const RED3_OJ = openJamSetup(6);
const RED3_OJ_ITERS = 250;
let pfRef: PushFoldSolution | undefined;
let ojRef: OpenJamSolution | undefined;
const pushFoldRef = () => (pfRef ??= solvePushFold(table, RED3_PF, RED3_PF_ITERS));
const openJamRef = () => (ojRef ??= solveOpenJam(table, RED3_OJ, RED3_OJ_ITERS));

// ───────────── PF-RED-1/2: exact value equivalence ─────────────

describe("preflop solver: reductions to the reference solvers (§5.1)", { timeout: 60_000 }, () => {
  it("PF-RED-1: push/fold values equal pushFoldGains for fixed strategies", () => {
    const setup: TableSetup = { players: 9, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 };
    // Value equivalence holds for any fixed strategy; 200 FP iterations give a realistic one quickly.
    const ref = solvePushFold(table, setup, 200);
    const tree = buildTree(pushFoldConfig(setup));
    const solver = createSolver(tree, table, { valuation: { kind: "equity" } });
    const ev = solver.evaluate(strategyOf(tree, pushFoldProbs(ref)), { actionValues: true });
    const V = ev.actionValues!;
    const g = pushFoldGains(table, setup, ref.push, ref.call);
    let worst = 0, compared = 0;
    for (let p = 0; p < tree.nodeCount; p++) {
      const info = tree.nodes[p], e0 = tree.actStart[p], f = tree.foldIdx[p];
      const gain = info.facingJam ? g.callGain[info.jammer][info.seat] : g.pushGain[info.seat];
      for (let h = 0; h < N; h++) {
        worst = Math.max(worst, Math.abs(V[(e0 + 1 - f) * N + h] - V[(e0 + f) * N + h] - gain[h]));
        compared++;
      }
    }
    expect(compared).toBe(tree.nodeCount * N);
    expect(worst).toBeLessThan(1e-9);
  });

  it("PF-RED-2: open/jam values equal openJamGains for fixed strategies", () => {
    const setup = openJamSetup(9);
    const ref = solveOpenJam(table, setup, 30);
    const R = Float64Array.from(setup.bbRealization as number[]);
    const tree = buildTree(openJamConfig(setup));
    const solver = createSolver(tree, table, { valuation: { kind: "oneSided", R } });
    const ev = solver.evaluate(strategyOf(tree, (info, a) => withFoldRest(info, a, (key) => openJamArray(ref, info, key))), { actionValues: true });
    const V = ev.actionValues!;
    const g = openJamGains(table, setup, ref);
    const { K } = solver.km;
    /** The facing opponent's mass seen from h: openjam returns -1 below W = 1e-12, the engine 0 below 1e-300. */
    const massOf = (r: Float64Array, h: number) => {
      let m = 0;
      for (let x = 0; x < N; x++) m += K[h * N + x] * r[x];
      return m;
    };
    let worst = 0, compared = 0, skipped = 0;
    for (let p = 0; p < tree.nodeCount; p++) {
      const info = tree.nodes[p], e0 = tree.actStart[p], f = tree.foldIdx[p];
      for (let a = 0; a < info.actions.length; a++) {
        if (a === f) continue;
        const key = info.actions[a].key;
        let gain: Float64Array, facing: Float64Array | null;
        if (info.facingJam && info.jamFirstIn) [gain, facing] = [g.callJamGain[info.jammer][info.seat], ref.jam[info.jammer]];
        else if (info.facingJam) [gain, facing] = [g.callReJamGain[info.opener][info.jammer], ref.reJam[info.opener][info.jammer]];
        else if (info.raises === 0) [gain, facing] = [key === "R" ? g.gainOpen[info.seat] : g.gainJam[info.seat], null];
        else [gain, facing] = [key === "J" ? g.vsOpenGains.reJam[info.opener][info.seat] : g.vsOpenGains.flat[info.opener], ref.open[info.opener]];
        for (let h = 0; h < N; h++) {
          if (facing && !(massOf(facing, h) > 1e-9)) {
            skipped++;
            continue;
          }
          worst = Math.max(worst, Math.abs(V[(e0 + a) * N + h] - V[(e0 + f) * N + h] - gain[h]));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(20000);
    expect(skipped).toBe(0); // FP keeps every frequency positive, so nothing is cut off at this point
    expect(worst).toBeLessThan(1e-9);
  });

  it(
    "PF-RED-3 (report only): FP mode follows solvePushFold and solveOpenJam",
    () => {
      const report: string[] = [];
      // push/fold
      const ref = pushFoldRef();
      const tree = buildTree(pushFoldConfig(RED3_PF));
      const init = strategyOf(tree, (info, a) => withFoldRest(info, a, () => (info.facingJam ? 0.3 : 0.5)));
      const fp = createSolver(tree, table, { valuation: { kind: "equity" }, mode: "fp", fpInit: init });
      fp.iterate(RED3_PF_ITERS);
      let maxDiff = 0, flips = 0, aggWorst = 0;
      for (let p = 0; p < tree.nodeCount; p++) {
        const info = tree.nodes[p], e0 = tree.actStart[p], a = 1 - tree.foldIdx[p];
        const r = info.facingJam ? ref.call[info.jammer][info.seat] : ref.push[info.seat];
        const e = fp.fpStrategy!.subarray((e0 + a) * N, (e0 + a + 1) * N);
        for (let h = 0; h < N; h++) {
          const d = Math.abs(e[h] - r[h]);
          maxDiff = Math.max(maxDiff, d);
          if (d > 1e-9) flips++;
        }
        aggWorst = Math.max(aggWorst, Math.abs(pct(e) - pct(r)));
      }
      report.push(`push/fold ${RED3_PF.players}x${RED3_PF.stack}bb, ${RED3_PF_ITERS} it: max |Δfreq| ${maxDiff.toExponential(2)}, entries > 1e-9: ${flips}, worst aggregate ${aggWorst.toFixed(4)}pp`);
      expect(aggWorst).toBeLessThanOrEqual(0.5);

      // open/jam
      const oref = openJamRef();
      const R = Float64Array.from(RED3_OJ.bbRealization as number[]);
      const otree = buildTree(openJamConfig(RED3_OJ));
      const oinit = strategyOf(otree, (info, a) => withFoldRest(info, a, (key) => openJamStart(info, key)));
      const ofp = createSolver(otree, table, { valuation: { kind: "oneSided", R }, mode: "fp", fpInit: oinit });
      ofp.iterate(RED3_OJ_ITERS);
      maxDiff = 0;
      flips = 0;
      aggWorst = 0;
      for (let p = 0; p < otree.nodeCount; p++) {
        const info = otree.nodes[p], e0 = otree.actStart[p];
        info.actions.forEach((x, a) => {
          if (x.key === "F") return;
          const r = openJamArray(oref, info, x.key);
          const e = ofp.fpStrategy!.subarray((e0 + a) * N, (e0 + a + 1) * N);
          for (let h = 0; h < N; h++) {
            const d = Math.abs(e[h] - r[h]);
            maxDiff = Math.max(maxDiff, d);
            if (d > 1e-9) flips++;
          }
          aggWorst = Math.max(aggWorst, Math.abs(pct(e) - pct(r)));
        });
      }
      report.push(`open/jam ${RED3_OJ.players}x20bb, ${RED3_OJ_ITERS} it: max |Δfreq| ${maxDiff.toExponential(2)}, entries > 1e-9: ${flips}, worst aggregate ${aggWorst.toFixed(4)}pp`);
      console.log(`PF-RED-3\n  ${report.join("\n  ")}`);
      expect(aggWorst).toBeLessThanOrEqual(0.5);
    },
    60_000,
  );

  it(
    "PF-RED-4: DCFR beats FP on the same reduced trees",
    () => {
      const tree = buildTree(pushFoldConfig(RED3_PF));
      const dcfr = createSolver(tree, table, { valuation: { kind: "equity" } });
      dcfr.iterate(1000);
      const nc = dcfr.evaluate(dcfr.average()).nashConvMbb;
      const ncFp = dcfr.evaluate(strategyOf(tree, pushFoldProbs(pushFoldRef()))).nashConvMbb;

      const R = Float64Array.from(RED3_OJ.bbRealization as number[]);
      const otree = buildTree(openJamConfig(RED3_OJ));
      const odcfr = createSolver(otree, table, { valuation: { kind: "oneSided", R } });
      odcfr.iterate(1000);
      const onc = odcfr.evaluate(odcfr.average()).nashConvMbb;
      const oref = openJamRef();
      const oncFp = odcfr.evaluate(strategyOf(otree, (info, a) => withFoldRest(info, a, (key) => openJamArray(oref, info, key)))).nashConvMbb;
      console.log(
        `PF-RED-4 NashConv (mbb/hand): push/fold DCFR ${nc.toFixed(4)} vs FP ${ncFp.toFixed(2)}; open/jam DCFR ${onc.toFixed(4)} vs FP ${oncFp.toFixed(2)}`,
      );
      expect(nc).toBeLessThanOrEqual(0.1);
      expect(nc).toBeLessThan(ncFp);
      expect(onc).toBeLessThanOrEqual(1);
      expect(onc).toBeLessThan(oncFp);
    },
    60_000,
  );
});

// ───────────── conservation, toy games, zero realization, determinism ─────────────

/** A random profile with some exact zeros (regret matching makes them, and the kernels skip them). */
function randomProfile(tree: PreflopTree, rand: () => number, classes = N): Float64Array {
  const out = new Float64Array(tree.edgeCount * classes);
  for (let p = 0; p < tree.nodeCount; p++) {
    const e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
    for (let h = 0; h < classes; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) {
        const x = rand() < 0.2 ? 0 : rand();
        out[(e0 + a) * classes + h] = x;
        sum += x;
      }
      if (sum === 0) {
        out[e0 * classes + h] = 1;
        sum = 1;
      }
      for (let a = 0; a < A; a++) out[(e0 + a) * classes + h] /= sum;
    }
  }
  return out;
}

describe("preflop solver: conservation, toys, zero realization, determinism (§5.1)", { timeout: 60_000 }, () => {
  it(
    "PF-CONS-1 (a): Σ root EV = 0 without card removal, 9 seats with 3- and 4-way flops",
    () => {
      const tree = buildTree(openOr3BetConfig({ coldCall: true, overcall: true, squeeze: true }));
      // K[h,x] = CW(x)/1326 for every h: every seat sees the same joint distribution, so the sum is exact.
      const cnt = new Float64Array(N * N);
      for (let h = 0; h < N; h++) for (let x = 0; x < N; x++) cnt[h * N + x] = (1225 * CW[x]) / 1326;
      const solver = createSolver(tree, { eq: table.eq, cnt }, { valuation: modelB });
      const fixed = solver.evaluate(randomProfile(tree, mulberry32(21)));
      solver.iterate(50);
      const avg = solver.evaluate(solver.average());
      console.log(`PF-CONS-1 (a): Σ EV random ${fixed.evSum.toExponential(2)}, σ̄@50 ${avg.evSum.toExponential(2)}; multiway terminals ${tree.terms.filter((t) => t.seats.length > 2 && t.kind === "flop").length}`);
      expect(Math.abs(fixed.evSum)).toBeLessThan(1e-9);
      expect(Math.abs(avg.evSum)).toBeLessThan(1e-9);
    },
    60_000,
  );

  it("PF-CONS-1 (b): Σ root EV = 0 heads-up at 100bb with pairwise card removal", () => {
    const tree = buildTree(stageConfig("100bb-2.2", { players: 2 }));
    expect(tree.terms.some((t) => t.kind === "flop") && tree.terms.some((t) => t.kind === "allin")).toBe(true);
    const solver = createSolver(tree, table, { valuation: modelB });
    const fixed = solver.evaluate(randomProfile(tree, mulberry32(22)));
    solver.iterate(50);
    const avg = solver.evaluate(solver.average());
    expect(Math.abs(fixed.evSum)).toBeLessThan(1e-9);
    expect(Math.abs(avg.evSum)).toBeLessThan(1e-9);
  });

  it("PF-TOY-1: heads-up push/fold matches solvePushFold", () => {
    const setup: TableSetup = { players: 2, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 };
    const ref = solvePushFold(table, setup, 3000);
    const tree = buildTree(pushFoldConfig(setup));
    const solver = createSolver(tree, table, { valuation: { kind: "equity" } });
    solver.iterate(2000);
    const avg = solver.average();
    const ev = solver.evaluate(avg);
    const jamNode = tree.nodes.findIndex((x) => !x.facingJam);
    const callNode = tree.nodes.findIndex((x) => x.facingJam);
    const jamA = 1 - tree.foldIdx[jamNode], callA = 1 - tree.foldIdx[callNode];
    const push = actionShares(tree, avg, jamNode, CW)[jamA] * 100;
    const call = actionShares(tree, avg, callNode, CW)[callA] * 100;
    expect(Math.abs(push - pct(ref.push[0]))).toBeLessThanOrEqual(1);
    expect(Math.abs(call - pct(ref.call[0][1]))).toBeLessThanOrEqual(1);
    expect(ev.nashConvMbb).toBeLessThanOrEqual(0.1);
  });

  it("PF-TOY-2: the 3-class closed form (P1 jams L 25%, P2 calls M 50%, EV +5/12)", () => {
    // Classes H, M, L, independent and uniform (no card removal): H beats M and L, M beats L, ties split.
    const eq = Float64Array.from([0.5, 1, 1, 0, 0.5, 1, 0, 0, 0.5]);
    const cnt = new Float64Array(9).fill(1225 / 3);
    const tree = buildTree(pushFoldConfig({ players: 2, stack: 2, sb: 0, bb: 0, bbAnte: 1 }));
    const solver = createSolver(tree, { eq, cnt }, { valuation: { kind: "equity" }, cw: [1, 1, 1] });
    solver.iterate(2000);
    const avg = solver.average();
    const ev = solver.evaluate(avg);
    const freq = (facingJam: boolean) => {
      const p = tree.nodes.findIndex((x) => x.facingJam === facingJam);
      const a = 1 - tree.foldIdx[p];
      return [0, 1, 2].map((h) => avg[(tree.actStart[p] + a) * 3 + h]);
    };
    const [jH, jM, jL] = freq(false), [cH, cM, cL] = freq(true);
    expect(jH).toBeGreaterThanOrEqual(0.99);
    expect(jM).toBeGreaterThanOrEqual(0.99);
    expect(Math.abs(jL - 0.25)).toBeLessThanOrEqual(0.02);
    expect(cH).toBeGreaterThanOrEqual(0.99);
    expect(Math.abs(cM - 0.5)).toBeLessThanOrEqual(0.02);
    expect(cL).toBeLessThanOrEqual(0.01);
    expect(Math.abs(ev.ev[0] - 5 / 12)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(ev.ev[1] + 5 / 12)).toBeLessThanOrEqual(0.002);
  });

  it(
    "PF-ZERO-1: with zero realization the BB defends at least 90% against the SB",
    () => {
      const tree = buildTree(openOr3BetConfig());
      expect(tree.nodeCount).toBe(188);
      const solver = createSolver(tree, table, { valuation: { kind: "modelB", params: zeroModelB(EQR_FIT.kappa3, EQR_FIT.kappa4), features: FEATURES } });
      solver.iterate(300);
      const avg = solver.average();
      const p = tree.nodes.findIndex((x) => x.seat === tree.bbSeat && x.raises === 1 && x.opener === tree.sbSeat && !x.facingJam);
      const defend = 1 - actionShares(tree, avg, p, CW)[tree.foldIdx[p]];
      console.log(`PF-ZERO-1: BB defends ${(defend * 100).toFixed(1)}% vs the SB's raise`);
      expect(defend).toBeGreaterThanOrEqual(0.9);
    },
    30_000,
  );

  it("PF-DET-1: two runs give bit-identical regrets and strategy sums", async () => {
    const run = async () => {
      const solver = createSolver(buildTree(openOr3BetConfig()), table, { valuation: modelB });
      solver.iterate(50);
      const bytes = new Uint8Array(solver.regret.byteLength + solver.ssum.byteLength);
      bytes.set(new Uint8Array(solver.regret.buffer, solver.regret.byteOffset, solver.regret.byteLength), 0);
      bytes.set(new Uint8Array(solver.ssum.buffer, solver.ssum.byteOffset, solver.ssum.byteLength), solver.regret.byteLength);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    };
    const [a, b] = [await run(), await run()];
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });
});

// ───────────── the solver's own helpers ─────────────

describe("preflop solver: metrics, schedule, polish, two-start, snapping", { timeout: 60_000 }, () => {
  const tree = buildTree(pushFoldConfig({ players: 9, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 }));
  const fresh = (): PreflopSolver => createSolver(tree, table, { valuation: { kind: "equity" } });

  it("evaluation metrics: gains ≥ 0, occ and reach are probabilities, no fold-outs in push/fold", () => {
    const solver = fresh();
    solver.iterate(100);
    const avg = solver.average();
    const ev = solver.evaluate(avg);
    for (const g of ev.gainMbb) expect(g).toBeGreaterThanOrEqual(-1e-9);
    expect(ev.occ[0]).toBe(1);
    expect(ev.reach[0]).toBeCloseTo(1, 12);
    for (let p = 0; p < tree.nodeCount; p++) {
      expect(ev.occ[p]).toBeGreaterThanOrEqual(0);
      expect(ev.occ[p]).toBeLessThanOrEqual(1 + 1e-12);
      expect(ev.localRegret[p]).toBeGreaterThanOrEqual(-1e-12);
    }
    // Terminal occ sums to 1 under the (card-removal-free) occ measure.
    expect(ev.termOcc.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(ev.frozen.occ).toBe(0);
    // ρ at a call node is the caller's own reach: 1 for a seat that has not acted.
    const callNode = tree.nodes.findIndex((x) => x.facingJam);
    expect(ownReach(tree, avg, callNode, N).every((x) => x === 1)).toBe(true);
  });

  it("runSchedule stops at the first passing check and otherwise runs to max", () => {
    const solver = fresh();
    const ok = runSchedule(solver, { start: 200, step: 100, max: 400 });
    expect(ok.pass).toBe(true);
    expect(ok.history.length).toBe(1);
    expect(ok.iterations).toBe(200);
    const strict = runSchedule(fresh(), { start: 200, step: 100, max: 400, gates: { maxGainMbb: 0 } });
    expect(strict.pass).toBe(false);
    expect(strict.history.map((r) => r.iterations)).toEqual([200, 300, 400]);
    expect(strict.polished).toBe(false);
    expect(strict.report.failures).toContain("maxGain");
  });

  it("polish re-solves a subtree and leaves σ̄ outside it unchanged", () => {
    const solver = fresh();
    solver.iterate(60);
    const before = solver.average();
    const root = tree.nodes.findIndex((x) => x.facingJam && x.jammer === 5 && x.seat === 6); // BTN facing the CO's jam
    const end = tree.actStart[tree.nodes.findIndex((_, i) => i > root && tree.depth[i] <= tree.depth[root])];
    const regretBefore = solver.evaluate(before).localRegret[root];
    solver.polish([root], 200);
    const after = solver.average();
    for (let i = 0; i < before.length; i++) if (i < tree.actStart[root] * N || i >= end * N) expect(after[i]).toBe(before[i]);
    const regretAfter = solver.evaluate(after).localRegret[root];
    expect(regretAfter).toBeLessThan(Math.max(regretBefore, 1e-4));
  });

  it("PF-TWOSTART's start: fold-first regrets, then the same equilibrium", () => {
    const a = fresh();
    a.iterate(400);
    const b = fresh();
    twoStartInit(b);
    expect(b.t).toBe(0);
    expect(b.ssum.every((x) => x === 0)).toBe(true);
    b.iterate(400);
    const sa = a.average(), sb = b.average();
    for (let p = 0; p < tree.nodeCount; p++) {
      const f = tree.foldIdx[p];
      const da = actionShares(tree, sa, p, CW)[f], db = actionShares(tree, sb, p, CW)[f];
      expect(Math.abs(da - db)).toBeLessThan(0.02);
    }
  });

  it("snapTenths: multiples of 0.1 summing to 1, largest remainder, fold last on ties", () => {
    const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
    expect(snapTenths([0.34, 0.33, 0.33], 0)).toEqual([0.4, 0.3, 0.3]);
    expect(snapTenths([0.25, 0.25, 0.5], 0)).toEqual([0.2, 0.3, 0.5]); // tie between F and C: C gets the tenth
    expect(snapTenths([0.05, 0.95], 0)).toEqual([0, 1]); // tie: the non-fold action
    expect(snapTenths([0.3, 0.7], -1)).toEqual([0.3, 0.7]);
    const rand = mulberry32(5);
    for (let k = 0; k < 200; k++) {
      const p = [rand(), rand(), rand(), rand()];
      const s = sum(p);
      const out = snapTenths(p.map((x) => x / s), 0);
      expect(sum(out)).toBeCloseTo(1, 12);
      for (const x of out) expect(Math.abs(x * 10 - Math.round(x * 10))).toBeLessThan(1e-9);
    }
  });
});
