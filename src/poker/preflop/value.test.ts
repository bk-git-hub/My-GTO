import { describe, expect, it } from "vitest";
import { ALL_HANDS } from "../cards";
import { openJamGains, type OpenJamSetup, type OpenJamStrategies } from "../openjam";
import { buildEquityTable, mulberry32, N } from "../pushfold";
import { realizationAt } from "../realization";
import { EQR_FIT } from "./eqrFit";
import { handFeatures } from "./features";
import {
  affineSideI,
  affineSideO,
  allinSide,
  alphaShrink,
  contextC,
  equityVectors,
  featureMatrix,
  kernelMatrices,
  kernelScratch,
  massAndEquity,
  matVecK,
  modelBMultiway,
  modelBVectors,
  multiwayKernel,
  multiwayNorm,
  multiwayValues,
  oneSidedVectors,
  pairwiseVectors,
  prepareModelB,
  SPR_ALPHA,
  SPR_SURPLUS,
  surplusShrink,
  zeroModelB,
  type HuContext,
  type KernelMatrices,
  type MultiwayNorm,
  type PairwiseVectors,
} from "./value";

// ───────────── independent references ─────────────
// The brute-force loops below are written from the payoff definitions of §3.3–3.6, one (h, x) pair at a time, and
// share no code with the fast kernels (which use the accumulated §3.5 forms, gathers and the uniform-p shortcut).

const CW = Float64Array.from(ALL_HANDS, (h) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12));

interface Ref {
  N: number;
  /** K[h,x] = cnt[h,x] / 1225, built here rather than by kernelMatrices. */
  K: Float64Array;
  eq: Float64Array;
}

/** O holds h: Σ_x K[h,x]·rI(x)·(Φ_O(h,x)·P − T_O), Φ_O = (pO(h) + pI(x))·e + qO(h) − qI(x), e = eq[h,x]. */
function bruteO(ref: Ref, v: PairwiseVectors, rI: Float64Array, pot: number, paid: number): Float64Array {
  const out = new Float64Array(ref.N);
  for (let h = 0; h < ref.N; h++) {
    let s = 0;
    for (let x = 0; x < ref.N; x++) {
      const e = ref.eq[h * ref.N + x];
      const phi = (v.pO[h] + v.pI[x]) * e + v.qO[h] - v.qI[x];
      s += ref.K[h * ref.N + x] * rI[x] * (phi * pot - paid);
    }
    out[h] = s;
  }
  return out;
}

/** I holds x: Σ_h K[x,h]·rO(h)·((1 − Φ_O(h,x))·P − T_I), with Φ_O from O's equity eq[h,x]. */
function bruteI(ref: Ref, v: PairwiseVectors, rO: Float64Array, pot: number, paid: number): Float64Array {
  const out = new Float64Array(ref.N);
  for (let x = 0; x < ref.N; x++) {
    let s = 0;
    for (let h = 0; h < ref.N; h++) {
      const e = ref.eq[h * ref.N + x];
      const phi = (v.pO[h] + v.pI[x]) * e + v.qO[h] - v.qI[x];
      s += ref.K[x * ref.N + h] * rO[h] * ((1 - phi) * pot - paid);
    }
    out[x] = s;
  }
  return out;
}

/** §3.3: Σ_x K[h,x]·r(x)·(eq[h,x]·P' + refund − T). */
function bruteAllin(ref: Ref, r: Float64Array, potAfterRefund: number, refund: number, T: number): Float64Array {
  const out = new Float64Array(ref.N);
  for (let h = 0; h < ref.N; h++) {
    let s = 0;
    for (let x = 0; x < ref.N; x++) s += ref.K[h * ref.N + x] * r[x] * (ref.eq[h * ref.N + x] * potAfterRefund + refund - T);
    out[h] = s;
  }
  return out;
}

function bruteMass(ref: Ref, r: Float64Array, withEquity: boolean): Float64Array {
  const out = new Float64Array(ref.N);
  for (let h = 0; h < ref.N; h++) {
    let s = 0;
    for (let x = 0; x < ref.N; x++) s += ref.K[h * ref.N + x] * r[x] * (withEquity ? ref.eq[h * ref.N + x] : 1);
    out[h] = s;
  }
  return out;
}

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};

/** Reach with about `zeros` of its entries exactly 0, the way regret matching leaves them. */
function randomReach(rand: () => number, n: number, zeros: number): Float64Array {
  return Float64Array.from({ length: n }, () => (rand() < zeros ? 0 : rand()));
}

function randomVectors(rand: () => number, n: number): PairwiseVectors {
  const v = pairwiseVectors(n);
  for (let h = 0; h < n; h++) {
    v.pO[h] = 0.4 + rand();
    v.pI[h] = rand() - 0.5;
    v.qO[h] = 0.4 * (rand() - 0.5);
    v.qI[h] = 0.4 * (rand() - 0.5);
  }
  return v;
}

/** The model of the fit's shape, with numbers of the fit's size (not the fit itself, which is regenerated). */
const F = featureMatrix(N, handFeatures);
const THETA_O = [0.056, 0.077, -0.016, 0.062, -0.062];
const THETA_I = [0.09, 0.066, -0.07, 0.078, -0.103];
const ALPHA = 0.55;
const C_FIT = -0.076;
const u = (theta: number[], h: number) => handFeatures(h).reduce((s, f, k) => s + f * theta[k], 0);

describe("preflop terminal valuation", () => {
  // The coarse table the other solver tests use.
  const table = buildEquityTable(150, mulberry32(3));
  const km = kernelMatrices(table.eq, table.cnt);
  const ref: Ref = { N, K: Float64Array.from(table.cnt, (c) => c / 1225), eq: table.eq };
  const sc = kernelScratch(N);
  const out = new Float64Array(N), mass = new Float64Array(N);
  const kappa3 = Float64Array.from({ length: N }, (_, h) => 0.85 + 0.3 * ((h * 37) % 17) / 17);
  const kappa4 = Float64Array.from({ length: N }, (_, h) => 0.8 + 0.4 * ((h * 53) % 19) / 19);
  const model = prepareModelB({ alpha: ALPHA, cFit: C_FIT, thetaO: THETA_O, thetaI: THETA_I, kappa3, kappa4 }, F);

  describe("PF-KERNEL-1: kernels against brute force", () => {
    it("affine pairwise kernel, both sides, general vectors", () => {
      const rand = mulberry32(11);
      let worst = 0;
      for (const zeros of [0, 0.3, 0.9]) {
        for (const [pot, paidO, paidI] of [
          [5.5, 2.2, 3.2],
          [23.1, 10.5, 11.6],
          [61.3, 30.15, 30.15],
        ]) {
          const v = randomVectors(rand, N);
          const rO = randomReach(rand, N, zeros), rI = randomReach(rand, N, zeros);
          affineSideO(km, v, rI, pot, paidO, out, mass, sc, false);
          worst = Math.max(worst, maxDiff(out, bruteO(ref, v, rI, pot, paidO)));
          expect(maxDiff(mass, bruteMass(ref, rI, false))).toBeLessThan(1e-15);
          affineSideI(km, v, rO, pot, paidI, out, mass, sc, false);
          worst = Math.max(worst, maxDiff(out, bruteI(ref, v, rO, pot, paidI)));
          expect(maxDiff(mass, bruteMass(ref, rO, false))).toBeLessThan(1e-15);
        }
      }
      console.log(`PF-KERNEL-1 affine kernel: max |fast − brute| = ${worst.toExponential(2)}`);
      expect(worst).toBeLessThan(1e-12);
    });

    it("the 3-accumulator path (pO constant, pI zero) equals the double loop and the general path", () => {
      const rand = mulberry32(12);
      let worst = 0;
      for (const zeros of [0, 0.5]) {
        const v = randomVectors(rand, N);
        v.pO.fill(1.4);
        v.pI.fill(0);
        const general = { ...v, uniformP: false };
        const fast = { ...v, uniformP: true };
        const rO = randomReach(rand, N, zeros), rI = randomReach(rand, N, zeros);
        const a = new Float64Array(N);
        affineSideO(km, fast, rI, 17.5, 8.1, out, mass, sc, false);
        affineSideO(km, general, rI, 17.5, 8.1, a, mass, sc, false);
        worst = Math.max(worst, maxDiff(out, bruteO(ref, v, rI, 17.5, 8.1)), maxDiff(out, a));
        affineSideI(km, fast, rO, 17.5, 9.4, out, mass, sc, false);
        affineSideI(km, general, rO, 17.5, 9.4, a, mass, sc, false);
        worst = Math.max(worst, maxDiff(out, bruteI(ref, v, rO, 17.5, 9.4)), maxDiff(out, a));
      }
      expect(worst).toBeLessThan(1e-12);
    });

    it("normalized values are CFV / M, and 0 where the opponent cannot be there", () => {
      const rand = mulberry32(13);
      const v = randomVectors(rand, N);
      const rI = randomReach(rand, N, 0.95);
      const cfv = bruteO(ref, v, rI, 9, 4);
      affineSideO(km, v, rI, 9, 4, out, mass, sc, true);
      for (let h = 0; h < N; h++) expect(Math.abs(out[h] * mass[h] - cfv[h])).toBeLessThan(1e-12);
      // An empty opponent range: mass 0, value 0, on every kernel.
      const empty = new Float64Array(N);
      for (const normalize of [true, false]) {
        affineSideO(km, v, empty, 9, 4, out, mass, sc, normalize);
        expect(maxDiff(out, empty) + maxDiff(mass, empty)).toBe(0);
        affineSideI(km, v, empty, 9, 4, out, mass, sc, normalize);
        expect(maxDiff(out, empty) + maxDiff(mass, empty)).toBe(0);
        allinSide(km, empty, 9, 4, out, mass, sc, normalize);
        expect(maxDiff(out, empty) + maxDiff(mass, empty)).toBe(0);
      }
    });

    it("all-in with a refund: the 2-accumulator kernel equals the double loop and the affine kernel", () => {
      // UTG jams 100, the BB (live 99 after the ante) calls 99: 1bb goes back to UTG. P = 100 + 99 + 1 (ante)
      // + 0.5 (the SB's folded blind) = 200.5, P' = 199.5. UTG paid 100 and gets 1 back; the BB put in 99 + the ante.
      const P = 200.5, refund = 1, Pp = P - refund, T_utg = 100, T_bb = 100;
      const rand = mulberry32(14);
      const eqv = equityVectors(N);
      let worst = 0;
      for (const zeros of [0, 0.6]) {
        const rUtg = randomReach(rand, N, zeros), rBb = randomReach(rand, N, zeros);
        // UTG, against the BB's calling range.
        allinSide(km, rBb, Pp, T_utg - refund, out, mass, sc, false);
        worst = Math.max(worst, maxDiff(out, bruteAllin(ref, rBb, Pp, refund, T_utg)));
        const viaO = new Float64Array(N);
        affineSideO(km, eqv, rBb, Pp, T_utg - refund, viaO, mass, sc, false);
        worst = Math.max(worst, maxDiff(out, viaO));
        // The BB, against UTG's jamming range: either side of the affine kernel with equity vectors.
        allinSide(km, rUtg, Pp, T_bb, out, mass, sc, false);
        worst = Math.max(worst, maxDiff(out, bruteAllin(ref, rUtg, Pp, 0, T_bb)));
        const viaI = new Float64Array(N);
        affineSideI(km, eqv, rUtg, Pp, T_bb, viaI, mass, sc, false);
        worst = Math.max(worst, maxDiff(out, viaI));
      }
      console.log(`PF-KERNEL-1 all-in kernel: max |fast − brute| = ${worst.toExponential(2)}`);
      expect(worst).toBeLessThan(1e-12);
    });

    it("matVecK and massAndEquity", () => {
      const rand = mulberry32(15);
      const r = randomReach(rand, N, 0.4);
      const eqm = new Float64Array(N);
      matVecK(km, r, out, sc);
      expect(maxDiff(out, bruteMass(ref, r, false))).toBeLessThan(1e-15);
      massAndEquity(km, r, mass, eqm, sc);
      expect(maxDiff(mass, bruteMass(ref, r, false))).toBeLessThan(1e-15);
      expect(maxDiff(eqm, bruteMass(ref, r, true))).toBeLessThan(1e-15);
    });

    it("works for any class count (the 3-class toy)", () => {
      // H beats M and L, M beats L; no card removal (cnt = 1225/3).
      const eq3 = Float64Array.from([0.5, 1, 1, 0, 0.5, 1, 0, 0, 0.5]);
      const cnt3 = new Float64Array(9).fill(1225 / 3);
      const km3 = kernelMatrices(eq3, cnt3);
      expect(km3.N).toBe(3);
      const ref3: Ref = { N: 3, K: new Float64Array(9).fill(1 / 3), eq: eq3 };
      const sc3 = kernelScratch(3);
      const o3 = new Float64Array(3), m3 = new Float64Array(3);
      const rand = mulberry32(16);
      const v = randomVectors(rand, 3);
      const rO = Float64Array.from([1, 0.5, 0]), rI = Float64Array.from([0.25, 0, 1]);
      affineSideO(km3, v, rI, 3, 1, o3, m3, sc3, false);
      expect(maxDiff(o3, bruteO(ref3, v, rI, 3, 1))).toBeLessThan(1e-15);
      affineSideI(km3, v, rO, 3, 2, o3, m3, sc3, false);
      expect(maxDiff(o3, bruteI(ref3, v, rO, 3, 2))).toBeLessThan(1e-15);
      allinSide(km3, rI, 3, 1, o3, m3, sc3, true);
      // H against {H 0.25, L 1}: equity (0.25·0.5 + 1)/1.25 = 0.9, so V = 0.9·3 − 1.
      expect(o3[0]).toBeCloseTo(0.9 * 3 - 1, 14);
    });
  });

  describe("PF-KERNEL-2: model reductions", () => {
    const contexts: HuContext[] = [
      { potType: "srp", aggressor: "I", spr: 17.7 },
      { potType: "srp", aggressor: "O", spr: 7.9 },
      { potType: "limp", aggressor: null, spr: 33 },
      { potType: "3bp", aggressor: "I", spr: 4.6 },
      { potType: "4bp", aggressor: "O", spr: 2.3 },
      { potType: "4bp", aggressor: "I", spr: 1.1 },
    ];

    it("α = c = θ = 0 gives Φ_O = e exactly", () => {
      const zero = prepareModelB(zeroModelB(kappa3, kappa4), F);
      const rand = mulberry32(21);
      const rI = randomReach(rand, N, 0.3), rO = randomReach(rand, N, 0.3);
      const eqOut = new Float64Array(N);
      for (const ctx of contexts) {
        const v = modelBVectors(zero, ctx);
        let differ = 0;
        for (let h = 0; h < N; h++) {
          for (let x = 0; x < N; x++) {
            const e = table.eq[h * N + x];
            if ((v.pO[h] + v.pI[x]) * e + v.qO[h] - v.qI[x] !== e) differ++;
          }
        }
        expect(differ, `${ctx.potType} ${ctx.aggressor}`).toBe(0);
        // And the kernels value the flop as showdown equity.
        affineSideO(km, v, rI, 12, 5, out, mass, sc, false);
        allinSide(km, rI, 12, 5, eqOut, mass, sc, false);
        expect(maxDiff(out, eqOut)).toBeLessThan(1e-12);
        affineSideI(km, v, rO, 12, 6, out, mass, sc, false);
        allinSide(km, rO, 12, 6, eqOut, mass, sc, false);
        expect(maxDiff(out, eqOut)).toBeLessThan(1e-12);
      }
    });

    it("both one-sided rows give openjam's terminal: the BB's share is R·(BB equity)", () => {
      const R = Float64Array.from(ALL_HANDS, (h) => realizationAt(h, 20, 2));
      // BB acts first (O = BB holding h): Φ_O = R(h)·eq[h,x].
      const first = oneSidedVectors(R, true);
      // BB acts last (I = BB holding x, the SB opened): Φ_I = R(x)·eq[x,h].
      const last = oneSidedVectors(R, false);
      let differ = 0, worst = 0;
      for (let h = 0; h < N; h++) {
        for (let x = 0; x < N; x++) {
          const e = table.eq[h * N + x];
          if ((first.pO[h] + first.pI[x]) * e + first.qO[h] - first.qI[x] !== R[h] * e) differ++;
          const phiO = (last.pO[h] + last.pI[x]) * e + last.qO[h] - last.qI[x];
          worst = Math.max(worst, Math.abs(1 - phiO - R[x] * table.eq[x * N + h]));
        }
      }
      expect(differ).toBe(0);
      expect(worst).toBeLessThan(1e-15);
    });

    it("the one-sided kernel reproduces openJamGains' flat-call values", () => {
      // Every re-jam frequency is 0, so the only non-trivial part of an open's gain is the BB's flat: gainOpen =
      // CFV_flop(h) + (1 − M(h))·(blinds and ante − own blind) + own blind, M(h) being the BB's flatting mass.
      // The BB's flat gain over folding is V_flop(x) + bb + ante.
      const rand = mulberry32(22);
      for (const players of [9, 2]) {
        const SB = players - 2, BB = players - 1;
        const open = 2;
        const R = Float64Array.from(ALL_HANDS, (h) => realizationAt(h, 20, open));
        const setup: OpenJamSetup = { players, stack: 20, sb: 0.5, bb: 1, bbAnte: 1, open, bbRealization: R };
        const seats = () => Array.from({ length: players - 1 }, () => randomReach(rand, N, 0.3));
        const grid = (fill: (a: Float64Array) => Float64Array) =>
          Array.from({ length: players - 1 }, (_, i) => Array.from({ length: players }, (_, j) => (j > i ? fill(new Float64Array(N)) : new Float64Array(0))));
        const sol: OpenJamStrategies = {
          open: seats(),
          jam: seats(),
          callJam: grid((a) => a.map(() => rand())),
          reJam: grid((a) => a),
          bbCall: seats(),
          callReJam: grid((a) => a.map(() => rand())),
        };
        const g = openJamGains(table, setup, sol);
        const blind = (s: number) => (s === SB ? 0.5 : s === BB ? 1 : 0);
        const allFold = 2.5;
        for (let i = 0; i < players - 1; i++) {
          if (players === 9 && ![0, 5, 6, SB].includes(i)) continue;
          // Postflop order: the SB acts before the BB at n ≥ 3; heads-up the BB acts first.
          const bbFirst = !(i === SB && players >= 3);
          const v = oneSidedVectors(R, bbFirst);
          const pot = 2 * open + 1 + (i !== SB ? 0.5 : 0);
          const tOpen = open, tBb = open + 1;
          const bbV = new Float64Array(N), bbM = new Float64Array(N), opCfv = new Float64Array(N), opM = new Float64Array(N);
          if (bbFirst) {
            affineSideO(km, v, sol.open[i], pot, tBb, bbV, bbM, sc, true);
            affineSideI(km, v, sol.bbCall[i], pot, tOpen, opCfv, opM, sc, false);
          } else {
            affineSideO(km, v, sol.bbCall[i], pot, tOpen, opCfv, opM, sc, false);
            affineSideI(km, v, sol.open[i], pot, tBb, bbV, bbM, sc, true);
          }
          let checked = 0;
          for (let h = 0; h < N; h++) {
            const want = g.gainOpen[i][h];
            const got = opCfv[h] + (1 - opM[h]) * (allFold - blind(i)) + blind(i);
            expect(Math.abs(got - want)).toBeLessThan(1e-9);
            // openjam returns −1 below W = 1e-12 (W = M·1225); the engine's cut-off is far lower (§4.8).
            if (bbM[h] * 1225 < 1e-12) continue;
            expect(Math.abs(bbV[h] + 1 + 1 - g.vsOpenGains.flat[i][h])).toBeLessThan(1e-9);
            checked++;
          }
          expect(checked).toBeGreaterThan(100);
        }
      }
    });

    it("Φ_O + Φ_I = 1 for every pair, through both kernel sides", () => {
      const R = Float64Array.from(ALL_HANDS, (h) => realizationAt(h, 20, 2));
      const sets: [string, PairwiseVectors][] = [
        ...contexts.map((ctx) => [`model B ${ctx.potType} ${ctx.aggressor}`, modelBVectors(model, ctx)] as [string, PairwiseVectors]),
        ["one-sided, BB first", oneSidedVectors(R, true)],
        ["one-sided, BB last", oneSidedVectors(R, false)],
        ["general", randomVectors(mulberry32(23), N)],
      ];
      const pot = 23.1, tO = 7.7, tI = 10.2;
      const VO = new Float64Array(N * N), VI = new Float64Array(N * N);
      const unit = new Float64Array(N);
      for (const [name, v] of sets) {
        for (let x = 0; x < N; x++) {
          unit.fill(0);
          unit[x] = 1;
          affineSideO(km, v, unit, pot, tO, out, mass, sc, true);
          for (let h = 0; h < N; h++) VO[h * N + x] = out[h];
        }
        for (let h = 0; h < N; h++) {
          unit.fill(0);
          unit[h] = 1;
          affineSideI(km, v, unit, pot, tI, out, mass, sc, true);
          for (let x = 0; x < N; x++) VI[x * N + h] = out[x];
        }
        let worst = 0;
        for (let h = 0; h < N; h++) for (let x = 0; x < N; x++) worst = Math.max(worst, Math.abs(VO[h * N + x] + VI[x * N + h] - (pot - tO - tI)));
        expect(worst, name).toBeLessThan(1e-12);
      }
    });

    it("s_α and s follow §3.4", () => {
      expect(SPR_ALPHA).toBe(1.5);
      expect(SPR_SURPLUS).toBe(6);
      const table34: [number, number, number][] = [
        // SPR, s = min(1, SPR/6), s_α = min(1, SPR/1.5)
        [0.5, 1 / 12, 1 / 3],
        [1, 1 / 6, 2 / 3],
        [1.5, 1 / 4, 1],
        [2.3, 2.3 / 6, 1],
        [6, 1, 1],
        [18, 1, 1],
      ];
      for (const [spr, s, sa] of table34) {
        expect(surplusShrink(spr)).toBeCloseTo(s, 15);
        expect(alphaShrink(spr)).toBeCloseTo(sa, 15);
        // The vectors carry them: pO = 1 + s_α·α, qO = −s_α·α/2 + s·(c + u_O), qI = s·u_I.
        for (const ctx of [
          { potType: "4bp", aggressor: "I", spr },
          { potType: "3bp", aggressor: "O", spr },
        ] as HuContext[]) {
          const v = modelBVectors(model, ctx);
          const c = contextC(C_FIT, ctx.potType, ctx.aggressor);
          const [tO, tI] = ctx.aggressor === "I" ? [THETA_O, THETA_I] : [THETA_I, THETA_O];
          expect(v.uniformP).toBe(true);
          for (let h = 0; h < N; h++) {
            expect(v.pO[h]).toBeCloseTo(1 + sa * ALPHA, 14);
            expect(v.pI[h]).toBe(0);
            expect(v.qO[h]).toBeCloseTo((-sa * ALPHA) / 2 + s * (c + u(tO, h)), 14);
            expect(v.qI[h]).toBeCloseTo(s * u(tI, h), 14);
          }
        }
      }
      // A 100bb 4-bet pot (SPR 1.9–2.7) keeps the whole equity-edge term (critic finding 4).
      expect(modelBVectors(model, { potType: "4bp", aggressor: "I", spr: 1.9 }).pO[0]).toBe(1 + ALPHA);
      // The old rule, for sensitivity solve (e): α shrinks with c and u.
      const old = prepareModelB({ ...EQR_FIT, sprAlpha: 6 }, F);
      expect(modelBVectors(old, { potType: "4bp", aggressor: "I", spr: 2.3 }).pO[0]).toBeCloseTo(1 + (2.3 / 6) * EQR_FIT.alpha, 14);
    });

    it("derived contexts: u by role, c split ⅔ position / ⅓ initiative", () => {
      const c = -0.053; // the 3-feature prototype fit, which the design's check uses
      expect(contextC(c, "srp", "I")).toBe(c);
      expect(contextC(c, "3bp", "I")).toBe(c);
      expect(contextC(c, "srp", "O")).toBeCloseTo(c / 3, 15);
      expect(contextC(c, "srp", "O")).toBeCloseTo(-0.018, 3);
      expect(contextC(c, "limp", null)).toBeCloseTo((2 * c) / 3, 15);
      expect(contextC(c, "limp", null)).toBeCloseTo(-0.035, 3);
      expect(contextC(c, "limp", "I")).toBe(contextC(c, "limp", null));
      expect(() => contextC(c, "srp", null)).toThrow();
      // The sensitivity scale leaves the one fitted context alone.
      expect(contextC(c, "srp", "I", 0.5)).toBe(c);
      expect(contextC(c, "4bp", "I", 0.5)).toBeCloseTo(c / 2, 15);
      expect(contextC(c, "srp", "O", 1.5)).toBeCloseTo(c / 2, 15);
      // u by role at full SPR (s = s_α = 1): subtract the constant part and read u back.
      const read = (ctx: HuContext) => {
        const v = modelBVectors(model, ctx);
        const k = -ALPHA / 2 + contextC(C_FIT, ctx.potType, ctx.aggressor);
        return { uO: Array.from(v.qO, (q) => q - k), uI: Array.from(v.qI) };
      };
      const uCall = Array.from({ length: N }, (_, h) => u(THETA_O, h));
      const uAggr = Array.from({ length: N }, (_, h) => u(THETA_I, h));
      const ipAggr = read({ potType: "srp", aggressor: "I", spr: 10 });
      expect(maxDiff(ipAggr.uO, uCall)).toBeLessThan(1e-15);
      expect(maxDiff(ipAggr.uI, uAggr)).toBeLessThan(1e-15);
      const oopAggr = read({ potType: "3bp", aggressor: "O", spr: 10 });
      expect(maxDiff(oopAggr.uO, uAggr)).toBeLessThan(1e-15);
      expect(maxDiff(oopAggr.uI, uCall)).toBeLessThan(1e-15);
      const limp = read({ potType: "limp", aggressor: null, spr: 33 });
      expect(maxDiff(limp.uO, uCall)).toBeLessThan(1e-15);
      expect(maxDiff(limp.uI, uCall)).toBeLessThan(1e-15);
    });

    it("takes the generated fit as is", () => {
      const fit = prepareModelB(EQR_FIT, F);
      expect(fit.alphaMw).toBe(EQR_FIT.alpha);
      expect(fit.mwCPos).toBe(0.02);
      const v = modelBVectors(fit, { potType: "srp", aggressor: "I", spr: 17.7 });
      for (let h = 0; h < N; h++) expect(Number.isFinite(v.qO[h]) && Number.isFinite(v.qI[h])).toBe(true);
      expect(() => prepareModelB({ ...EQR_FIT, kappa3: [1, 2] }, F)).toThrow();
      expect(() => prepareModelB({ ...EQR_FIT, thetaO: [0, 0, 0, 0, 0, 0] }, F)).toThrow();
    });
  });

  describe("PF-KERNEL-3: multiway", () => {
    const pot = 13.3;
    const paid = [3.2, 4.4, 2.2, 3.5];
    const vecs = (k: number) => Array.from({ length: k }, () => new Float64Array(N));

    it("shares sum to 1 on average without card removal (k = 3 and 4)", () => {
      // No card removal: K[h,x] = CW(x)/1326 for every h, so hands are independent with weights CW·r.
      const K0 = new Float64Array(N * N), KE0 = new Float64Array(N * N);
      for (let h = 0; h < N; h++) {
        for (let x = 0; x < N; x++) {
          K0[h * N + x] = CW[x] / 1326;
          KE0[h * N + x] = K0[h * N + x] * table.eq[h * N + x];
        }
      }
      const km0: KernelMatrices = { N, K: K0, KE: KE0 };
      const rand = mulberry32(31);
      const norm: MultiwayNorm = { Z: 0, ubar: 0 };
      for (const k of [3, 4]) {
        for (const spr of [9, 4, 1.2]) {
          for (const aggressor of [0, k - 1, -1]) {
            const reach = Array.from({ length: k }, () => randomReach(rand, N, 0.4));
            const M = vecs(k), A1 = vecs(k), V = vecs(k);
            const term = modelBMultiway(model, k, aggressor, spr, pot, paid);
            expect(term.alphaMw).toBe(ALPHA);
            expect(term.cPos[0]).toBe(-0.02);
            expect(term.cPos[k - 1]).toBe(0.02);
            for (let j = 0; j < k; j++) massAndEquity(km0, reach[j], M[j], A1[j], sc);
            multiwayNorm(term, reach, M, A1, CW, norm);
            expect(norm.Z).toBeGreaterThan(0.2);
            expect(norm.ubar).not.toBe(0);
            multiwayValues(term, M, A1, norm, V, true);
            let total = 0;
            for (let j = 0; j < k; j++) {
              let s = 0, w = 0;
              for (let h = 0; h < N; h++) {
                const wh = CW[h] * reach[j][h];
                s += wh * ((V[j][h] + paid[j]) / pot);
                w += wh;
              }
              total += s / w;
            }
            expect(Math.abs(total - 1), `k ${k} spr ${spr} aggressor ${aggressor}`).toBeLessThan(1e-12);
          }
        }
      }
    });

    it("values, Z and ū equal the §3.6 formulas written out (with card removal)", () => {
      const rand = mulberry32(32);
      const norm: MultiwayNorm = { Z: 0, ubar: 0 };
      for (const k of [3, 4]) {
        const spr = k === 3 ? 5 : 1.1;
        const aggressor = 1;
        const reach = Array.from({ length: k }, () => randomReach(rand, N, 0.5));
        const term = modelBMultiway(model, k, aggressor, spr, pot, paid);
        const M = vecs(k), A1 = vecs(k), V = vecs(k), C = vecs(k);
        multiwayNorm(term, reach, reach.map((r) => bruteMass(ref, r, false)), reach.map((r) => bruteMass(ref, r, true)), CW, norm);
        multiwayKernel(km, term, reach, M, A1, norm, V, sc, true);
        multiwayValues(term, M, A1, norm, C, false);
        // Reference, from the definitions.
        const s = Math.min(1, spr / 6), sa = Math.min(1, spr / 1.5);
        const kap = k === 3 ? kappa3 : kappa4;
        const uRole = (j: number, h: number) => u(j === aggressor ? THETA_I : THETA_O, h);
        const cPos = (j: number) => (j === 0 ? -0.02 : j === k - 1 ? 0.02 : 0);
        const Mo = reach.map((r) => bruteMass(ref, r, false)), Ao = reach.map((r) => bruteMass(ref, r, true));
        let Z = 0, ubar = 0;
        for (let j = 0; j < k; j++) {
          let num = 0, den = 0, uu = 0;
          for (let h = 0; h < N; h++) {
            let pm = 1, pe = 1;
            for (let o = 0; o < k; o++) {
              if (o === j) continue;
              pm *= Mo[o][h];
              pe *= Ao[o][h] / Mo[o][h];
            }
            const w = reach[j][h] * CW[h] * pm;
            if (w === 0) continue;
            num += w * kap[h] * pe;
            den += w;
            uu += w * uRole(j, h);
          }
          Z += num / den;
          ubar += uu / den / k;
        }
        expect(Math.abs(norm.Z - Z)).toBeLessThan(1e-14);
        expect(Math.abs(norm.ubar - ubar)).toBeLessThan(1e-14);
        let worst = 0;
        for (let j = 0; j < k; j++) {
          for (let h = 0; h < N; h++) {
            let pe = kap[h], pm = 1;
            for (let o = 0; o < k; o++) {
              if (o === j) continue;
              pe *= Ao[o][h] / Mo[o][h];
              pm *= Mo[o][h];
            }
            const raw = pe / Z;
            const share = raw + sa * ALPHA * (raw - 1 / k) + s * (cPos(j) + uRole(j, h) - ubar);
            const want = share * pot - paid[j];
            worst = Math.max(worst, Math.abs(V[j][h] - want), Math.abs(C[j][h] - pm * want));
          }
        }
        expect(worst).toBeLessThan(1e-12);
      }
    });

    it("floors Z, and gives 0 where a hand cannot meet some seat's range", () => {
      const tiny = prepareModelB({ alpha: ALPHA, cFit: C_FIT, thetaO: THETA_O, thetaI: THETA_I, kappa3: new Float64Array(N).fill(0.05), kappa4 }, F);
      const term = modelBMultiway(tiny, 3, 0, 8, pot, paid);
      const rand = mulberry32(33);
      const reach = Array.from({ length: 3 }, () => randomReach(rand, N, 0.3));
      const M = vecs(3), A1 = vecs(3), V = vecs(3);
      for (let j = 0; j < 3; j++) massAndEquity(km, reach[j], M[j], A1[j], sc);
      const norm = multiwayNorm(term, reach, M, A1, CW, { Z: 0, ubar: 0 });
      expect(norm.Z).toBe(1); // κ = 0.05 puts the raw Z near 0.05, below the floor
      // Seat 2 has no reach: seats 0 and 1 can never meet it, so their values are 0 (the §4.2 convention), while
      // seat 2's own values stay defined.
      const empty = [reach[0], reach[1], new Float64Array(N)];
      for (let j = 0; j < 3; j++) massAndEquity(km, empty[j], M[j], A1[j], sc);
      multiwayValues(term, M, A1, norm, V, true);
      const zero = new Float64Array(N);
      expect(maxDiff(V[0], zero) + maxDiff(V[1], zero)).toBe(0);
      expect(maxDiff(V[2], zero)).toBeGreaterThan(0);
    });
  });

  it("micro-benchmark of one 169×169 kernel side (printed, not a gate)", () => {
    const rand = mulberry32(41);
    const gen = randomVectors(rand, N);
    const mb = modelBVectors(model, { potType: "srp", aggressor: "I", spr: 10 });
    const eqm = new Float64Array(N);
    const time = (f: () => void) => {
      for (let i = 0; i < 400; i++) f();
      const n = 2000;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) f();
      return ((performance.now() - t0) / n) * 1000;
    };
    const lines: string[] = [];
    for (const [label, zeros] of [
      ["dense reach", 0],
      ["50% zeros", 0.5],
      ["85% zeros", 0.85],
    ] as const) {
      const r = randomReach(rand, N, zeros);
      const t = {
        matVecK: time(() => matVecK(km, r, out, sc)),
        allin: time(() => allinSide(km, r, 10, 3, out, mass, sc, true)),
        oGeneral: time(() => affineSideO(km, gen, r, 10, 3, out, mass, sc, true)),
        iGeneral: time(() => affineSideI(km, gen, r, 10, 3, out, mass, sc, true)),
        oModelB: time(() => affineSideO(km, mb, r, 10, 3, out, mass, sc, true)),
        iModelB: time(() => affineSideI(km, mb, r, 10, 3, out, mass, sc, true)),
        massEq: time(() => massAndEquity(km, r, mass, eqm, sc)),
      };
      for (const x of Object.values(t)) expect(Number.isFinite(x)).toBe(true);
      lines.push(
        `${label.padEnd(12)} matVecK ${t.matVecK.toFixed(1)}  all-in side ${t.allin.toFixed(1)}  M+A1 ${t.massEq.toFixed(1)}  ` +
          `affine O/I general ${t.oGeneral.toFixed(1)}/${t.iGeneral.toFixed(1)}  model B (3-acc) ${t.oModelB.toFixed(1)}/${t.iModelB.toFixed(1)} µs`,
      );
    }
    console.log(`kernel micro-benchmark (critic/matvec-bench.mjs: 30 µs matvec, 76 µs one 4-accumulator side, dense)\n${lines.join("\n")}`);
  });
});
