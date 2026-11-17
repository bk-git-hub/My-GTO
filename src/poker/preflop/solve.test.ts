import { describe, expect, it } from "vitest";
import { buildEquityTable, mulberry32, N, pushFoldGains, solvePushFold, type TableSetup } from "../pushfold";
import { handFeatures } from "./features";
import { comboWeights, createSolver, ownReach, twoStartInit, type PreflopSolver, type SolverOptions } from "./solve";
import { buildTree, openOr3BetConfig, pushFoldConfig, stageConfig, type PreflopTree } from "./tree";
import { featureMatrix, type ModelBParams } from "./value";

// The engine's gate metrics (§4.5, §5.3) and its training update (§4.2), checked against the definitions written
// out here, independently of the engine's walks. The §5.1 tests in preflop.test.ts score DCFR and FP with the same
// evaluator and look at aggregates, so a bug in the best response, the local regret or the update weights could
// pass them while make-preflop shipped an unconverged chart.

// The coarse table the other solver tests use.
const table = buildEquityTable(150, mulberry32(3));
const CW = comboWeights();
const K = Float64Array.from(table.cnt, (c) => c / 1225);

// Model B with fixed parameters of the shipped fit's size rather than EQR_FIT, so regenerating the fit never moves
// these numbers. κ = 1: a constant κ cancels in the multiway normalization Z anyway.
const PARAMS: ModelBParams = {
  alpha: 0.553,
  cFit: -0.079,
  thetaO: [-0.071, 0.064, -0.139, 0.061, -0.02, 0.204],
  thetaI: [-0.184, 0.056, -0.245, 0.054, -0.02, 0.308],
  kappa3: new Float64Array(N).fill(1),
  kappa4: new Float64Array(N).fill(1),
};
const modelB: SolverOptions["valuation"] = { kind: "modelB", params: PARAMS, features: featureMatrix(N, handFeatures) };

/** The full 100bb tree cut to 4 players: seats act twice, and there are 3- and 4-way flops. */
const fourHanded = () => buildTree(stageConfig("100bb-2.2", { players: 4 }));

/** (K·r)(h): the chance a seat with reach r holds a hand compatible with h. */
function massAt(r: ArrayLike<number>, h: number): number {
  let m = 0;
  for (let x = 0; x < N; x++) m += K[h * N + x] * r[x];
  return m;
}

/** Every seat's own reach at node p under S: the product of its action probabilities on the line to p. */
function lineReaches(tree: PreflopTree, S: Float64Array, p: number): Float64Array[] {
  const r = Array.from({ length: tree.n }, () => new Float64Array(N).fill(1));
  for (let x = p; x > 0; x = tree.parent[x]) {
    const e = tree.parentEdge[x], s = tree.seat[tree.parent[x]];
    for (let h = 0; h < N; h++) r[s][h] *= S[e * N + h];
  }
  return r;
}

/** Regret matching (§4.2 step 1): R⁺ normalized, uniform where no regret is positive. */
function regretMatch(tree: PreflopTree, R: Float64Array): Float64Array {
  const out = new Float64Array(R.length);
  for (let p = 0; p < tree.nodeCount; p++) {
    const e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
    for (let h = 0; h < N; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) sum += Math.max(0, R[(e0 + a) * N + h]);
      for (let a = 0; a < A; a++) out[(e0 + a) * N + h] = sum > 0 ? Math.max(0, R[(e0 + a) * N + h]) / sum : 1 / A;
    }
  }
  return out;
}

const countDiffs = (a: Float64Array, b: Float64Array) => a.reduce((n, v, i) => (v === b[i] ? n : n + 1), 0);

// These tests solve and evaluate real trees: a few seconds each alone, more under the full suite's load, so the
// groups get a 60 s timeout instead of vitest's 5 s default.
describe("solver metrics against their definitions (§4.5)", { timeout: 60_000 }, () => {
  it("per-seat best-response gain equals the push/fold decomposition built from pushFoldGains", () => {
    const setup: TableSetup = { players: 9, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 };
    const ref = solvePushFold(table, setup, 200);
    const tree = buildTree(pushFoldConfig(setup));
    const S = new Float64Array(tree.edgeCount * N);
    for (let p = 0; p < tree.nodeCount; p++) {
      const info = tree.nodes[p], f = tree.foldIdx[p], e0 = tree.actStart[p];
      const go = info.facingJam ? ref.call[info.jammer][info.seat] : ref.push[info.seat];
      for (let h = 0; h < N; h++) {
        S[(e0 + 1 - f) * N + h] = go[h];
        S[(e0 + f) * N + h] = 1 - go[h];
      }
    }
    const ev = createSolver(tree, table, { valuation: { kind: "equity" } }).evaluate(S);
    // Seat i's gain is Σ over its decisions of W(h)·(max(0, g) − σ·g): g is the reference's gain of shoving (or
    // calling seat j's shove) over folding, and W(h) = Π_{t≠i} m_t(h) the chance the line reaches i holding h.
    const g = pushFoldGains(table, setup, ref.push, ref.call);
    const n = setup.players;
    for (let i = 0; i < n; i++) {
      let gain = 0;
      for (let h = 0; h < N; h++) {
        let total = 0;
        if (i < n - 1) {
          let W = 1;
          for (let j = 0; j < i; j++) W *= 1 - massAt(ref.push[j], h);
          total += W * (Math.max(0, g.pushGain[i][h]) - ref.push[i][h] * g.pushGain[i][h]);
        }
        for (let j = 0; j < i; j++) {
          let W = massAt(ref.push[j], h);
          for (let k = 0; k < j; k++) W *= 1 - massAt(ref.push[k], h);
          for (let k = j + 1; k < i; k++) W *= 1 - massAt(ref.call[j][k], h);
          const gc = g.callGain[j][i][h];
          total += W * (Math.max(0, gc) - ref.call[j][i][h] * gc);
        }
        gain += (CW[h] * total) / 1326;
      }
      expect(gain).toBeGreaterThan(1e-4); // 200 FP iterations leave every seat something to gain
      expect(Math.abs(ev.gainMbb[i] / 1000 - gain)).toBeLessThan(1e-9);
    }
  });

  it("brEv is the value of a pure best response built bottom-up from the action values", () => {
    // Trees without multiway flops: there every payoff is fixed per hand pair, so a pure strategy evaluated on its
    // own gives exactly the best response's value. (With multiway flops Z would be refreshed from the new profile.)
    for (const cfg of [openOr3BetConfig(), stageConfig("100bb-2.2", { players: 2 })]) {
      const tree = buildTree(cfg);
      expect(tree.terms.some((t) => t.kind === "flop" && t.seats.length > 2)).toBe(false);
      const solver = createSolver(tree, table, { valuation: modelB });
      solver.iterate(150);
      const S = solver.average();
      const base = solver.evaluate(S);
      const maxDepth = Math.max(...tree.depth);
      for (let t = 0; t < tree.n; t++) {
        const B = Float64Array.from(S);
        // Deepest decisions first, so every action value already assumes the best response below it.
        for (let d = maxDepth; d >= 0; d--) {
          const nodes: number[] = [];
          for (let p = 0; p < tree.nodeCount; p++) if (tree.seat[p] === t && tree.depth[p] === d) nodes.push(p);
          if (!nodes.length) continue;
          const V = solver.evaluate(B, { actionValues: true }).actionValues!;
          for (const p of nodes) {
            const e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
            for (let h = 0; h < N; h++) {
              let best = 0;
              for (let a = 1; a < A; a++) if (V[(e0 + a) * N + h] > V[(e0 + best) * N + h]) best = a;
              for (let a = 0; a < A; a++) B[(e0 + a) * N + h] = a === best ? 1 : 0;
            }
          }
        }
        const pure = solver.evaluate(B).ev[t];
        expect(Math.abs(pure - base.brEv[t])).toBeLessThan(1e-9);
        expect(base.gainMbb[t]).toBeCloseTo((pure - base.ev[t]) * 1000, 6);
      }
      expect(base.maxGainMbb).toBeGreaterThan(0.01); // not converged, so the check has something to find
    }
  });

  it("local regret, own reach and occ follow their definitions", () => {
    const tree = buildTree(openOr3BetConfig());
    const solver = createSolver(tree, table, { valuation: modelB });
    solver.iterate(150);
    const S = solver.average();
    const ev = solver.evaluate(S, { actionValues: true });
    const V = ev.actionValues!;
    let worstRegret = 0, worstReach = 0, worstOcc = 0, below1 = 0;
    for (let p = 0; p < tree.nodeCount; p++) {
      const e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
      const r = lineReaches(tree, S, p), rho = r[tree.seat[p]];
      // Σ_h CW·ρ·(max_a V^a − Σ_a σ_a·V^a) / Σ_h CW·ρ, with ρ the actor's raw own reach.
      let num = 0, den = 0;
      for (let h = 0; h < N; h++) {
        const wt = CW[h] * rho[h];
        if (!(wt > 0)) continue;
        let mx = -Infinity, avg = 0;
        for (let a = 0; a < A; a++) {
          const v = V[(e0 + a) * N + h];
          mx = Math.max(mx, v);
          avg += S[(e0 + a) * N + h] * v;
        }
        num += wt * (mx - avg);
        den += wt;
      }
      if (den < 1326 - 1e-9) below1++;
      worstRegret = Math.max(worstRegret, Math.abs((den > 0 ? num / den : 0) - ev.localRegret[p]));
      worstReach = Math.max(worstReach, Math.abs(den / 1326 - ev.reach[p]));
      // occ: Π_t Σ_h CW·r_t / 1326.
      let occ = 1;
      for (let t = 0; t < tree.n; t++) {
        let m = 0;
        for (let h = 0; h < N; h++) m += CW[h] * r[t][h];
        occ *= m / 1326;
      }
      worstOcc = Math.max(worstOcc, Math.abs(occ - ev.occ[p]));
      expect(ownReach(tree, S, p, N)).toEqual(rho);
    }
    expect(below1).toBeGreaterThan(50); // plenty of nodes where the actor has acted before
    expect(worstRegret).toBeLessThan(1e-12);
    expect(worstReach).toBeLessThan(1e-12);
    expect(worstOcc).toBeLessThan(1e-12);
  });
});

/**
 * Runs one DCFR iteration on `solver` and checks every regret and strategy sum against §4.2 written out:
 * σ = regret matching, R_a ← d(R_a) + w·(V^a − Σ_b σ_b·V^b) with w(h) = Π_{t≠s} (K·r_t)(h), S_a ← S_a·g + ρ·σ_a,
 * d(R) = R·t^1.5/(t^1.5 + 1) for R > 0 and R/2 otherwise, g = (t/(t + 1))². The action values come from evaluate(σ),
 * which refreshes Z and ū from σ, so on trees with multiway flops this is valid only for the first iteration (σ̄ and
 * σ are both uniform then, and the training run refreshes Z and ū at t = 1).
 */
function expectNextIteration(solver: PreflopSolver) {
  const { tree } = solver;
  const R0 = Float64Array.from(solver.regret), S0 = Float64Array.from(solver.ssum);
  const t = solver.t + 1;
  const sigma = regretMatch(tree, R0);
  const V = solver.evaluate(sigma, { actionValues: true }).actionValues!;
  solver.iterate(1);
  const ts = t * Math.sqrt(t), dPos = ts / (ts + 1), q = t / (t + 1), g = q * q;
  let worstR = 0, worstS = 0, weighted = 0;
  for (let p = 0; p < tree.nodeCount; p++) {
    const s = tree.seat[p], e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
    const r = lineReaches(tree, sigma, p);
    const m = r.map((ru) => Float64Array.from({ length: N }, (_, h) => massAt(ru, h)));
    for (let h = 0; h < N; h++) {
      let w = 1;
      for (let u = 0; u < tree.n; u++) if (u !== s) w *= m[u][h];
      if (w < 0.999) weighted++;
      let vbar = 0;
      for (let a = 0; a < A; a++) vbar += sigma[(e0 + a) * N + h] * V[(e0 + a) * N + h];
      for (let a = 0; a < A; a++) {
        const i = (e0 + a) * N + h;
        const wantR = (R0[i] > 0 ? R0[i] * dPos : R0[i] * 0.5) + w * (V[i] - vbar);
        const wantS = S0[i] * g + r[s][h] * sigma[i];
        worstR = Math.max(worstR, Math.abs(solver.regret[i] - wantR) / Math.max(1, Math.abs(wantR)));
        worstS = Math.max(worstS, Math.abs(solver.ssum[i] - wantS));
      }
    }
  }
  expect(weighted).toBeGreaterThan(0);
  expect(worstR).toBeLessThan(1e-9);
  expect(worstS).toBeLessThan(1e-12);
}

describe("DCFR training update (§4.2) against its definition", { timeout: 60_000 }, () => {
  it("first iteration on a tree with multiway flops and seats acting twice", () => {
    const tree = fourHanded();
    expect(tree.terms.some((t) => t.kind === "flop" && t.seats.length === 4)).toBe(true);
    expectNextIteration(createSolver(tree, table, { valuation: modelB }));
  });

  it("later iterations: discounts, counterfactual weights and own-reach averaging", () => {
    const solver = createSolver(buildTree(openOr3BetConfig()), table, { valuation: modelB });
    expectNextIteration(solver); // t = 1
    expectNextIteration(solver); // t = 2: both discounts act on non-zero regrets
    solver.iterate(5);
    expectNextIteration(solver); // t = 8
  });

  it("checking metrics never changes the training run (Z and ū restored after evaluate)", () => {
    const a = createSolver(fourHanded(), table, { valuation: modelB });
    a.iterate(30);
    a.evaluate(a.average());
    a.iterate(30);
    const b = createSolver(fourHanded(), table, { valuation: modelB });
    b.iterate(60);
    expect(countDiffs(a.regret, b.regret)).toBe(0);
    expect(countDiffs(a.ssum, b.ssum)).toBe(0);
  });

  it("converges on a full tree with multiway flops", () => {
    const solver = createSolver(fourHanded(), table, { valuation: modelB });
    solver.iterate(300);
    const ev = solver.evaluate(solver.average());
    expect(ev.maxGainMbb).toBeLessThan(10);
  });
});

describe("polish and two-start against §4.6 / §5.4", { timeout: 60_000 }, () => {
  it("twoStartInit discards everything a solver has already done", () => {
    const tree = buildTree(openOr3BetConfig());
    const used = createSolver(tree, table, { valuation: modelB });
    used.iterate(20);
    twoStartInit(used, 0);
    expect(used.t).toBe(0);
    expect(used.ssum.every((x) => x === 0)).toBe(true);
    for (let p = 0; p < tree.nodeCount; p++) {
      const f = tree.foldIdx[p];
      for (let e = tree.actStart[p]; e < tree.actStart[p + 1]; e++) {
        const want = e - tree.actStart[p] === f ? 1 : 0;
        expect(used.regret.subarray(e * N, (e + 1) * N).every((x) => x === want)).toBe(true);
      }
    }
    // The warm-up then runs exactly as from a fresh solver.
    used.iterate(20);
    twoStartInit(used, 10);
    const fresh = createSolver(tree, table, { valuation: modelB });
    twoStartInit(fresh, 10);
    expect(countDiffs(used.regret, fresh.regret)).toBe(0);
  });

  it("polish restarts the subtree's strategy sums from the frozen incoming reach", () => {
    const tree = buildTree(openOr3BetConfig());
    const solver = createSolver(tree, table, { valuation: modelB });
    solver.iterate(60);
    // The UTG opener facing the BTN's 3-bet: its own reach there is its opening range, not 1.
    const root = tree.nodes.findIndex((x) => x.seat === 0 && x.raises === 2 && x.threeBettor === 6 && !x.facingJam);
    expect(root).toBeGreaterThan(0);
    const avg = solver.average();
    const reaches = lineReaches(tree, avg, root);
    const rho = reaches[0];
    const sigma = regretMatch(tree, solver.regret);
    const R0 = Float64Array.from(solver.regret), before = Float64Array.from(solver.ssum);
    // The profile the polish iteration plays: σ̄ on the line to the root, the current regret-matched σ inside.
    const end = tree.nodes.findIndex((_, i) => i > root && tree.depth[i] <= tree.depth[root]);
    const profile = Float64Array.from(avg);
    profile.set(sigma.subarray(tree.actStart[root] * N, tree.actStart[end < 0 ? tree.nodeCount : end] * N), tree.actStart[root] * N);
    const V = solver.evaluate(profile, { actionValues: true }).actionValues!;
    solver.polish([root], 1);
    // One iteration at t = 1 on zeroed sums: S_a = ρ·σ_a (no trace of the sums before the polish), and the regrets
    // move by the frozen counterfactual weight w(h) = Π_{t≠UTG} (K·r_t)(h) of the line under σ̄.
    const e0 = tree.actStart[root], A = tree.actStart[root + 1] - e0;
    let worstS = 0, worstR = 0, moved = 0;
    for (let h = 0; h < N; h++) {
      let w = 1, vbar = 0;
      for (let t = 1; t < tree.n; t++) w *= massAt(reaches[t], h);
      for (let a = 0; a < A; a++) vbar += sigma[(e0 + a) * N + h] * V[(e0 + a) * N + h];
      for (let a = 0; a < A; a++) {
        const i = (e0 + a) * N + h;
        worstS = Math.max(worstS, Math.abs(solver.ssum[i] - rho[h] * sigma[i]));
        const wantR = R0[i] * 0.5 + w * (V[i] - vbar); // d(R) at t = 1 halves both signs
        worstR = Math.max(worstR, Math.abs(solver.regret[i] - wantR) / Math.max(1, Math.abs(wantR)));
        if (before[i] !== 0) moved++;
      }
    }
    expect(moved).toBeGreaterThan(0);
    expect(rho.some((x) => x < 0.5)).toBe(true);
    expect(worstS).toBeLessThan(1e-15);
    expect(worstR).toBeLessThan(1e-9);
  });
});
