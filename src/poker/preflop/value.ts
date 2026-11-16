/**
 * Terminal valuation of the preflop solver (§ numbers refer to the solver design, which docs/preflop-solver.md
 * will carry): chip accounting, all-in equity, the heads-up flop payoff (model B and the one-sided and equity
 * reductions, all through one affine pairwise kernel) and the multiway flop payoff.
 *
 * Everything here is a pure function over Float64Arrays of length N, the hand-class count (169 normally, 3 in the
 * toy test). The equity and compatibility matrices, the hand features and the fitted parameters are inputs, never
 * imports (§4.9), so the same code runs the shipped stages, the reductions and the toy games. The hot kernels skip
 * zero entries of the opponent's reach vector (regret matching gives exact zeros, §4.7) and allocate nothing:
 * every buffer is passed in.
 *
 * Exported API
 * ------------
 * Named priors (§3.4, §3.6)
 *  - `SPR_ALPHA` = 1.5: below this SPR the equity-edge term α shrinks, s_α = min(1, SPR / SPR_ALPHA).
 *  - `SPR_SURPLUS` = 6: below this SPR the position and playability terms c and u shrink, s = min(1, SPR / 6).
 *  - `MW_C_POS` = 0.02: multiway c_pos of the last seat to act (the first gets −0.02, the middles 0).
 *  - `Z_FLOOR` = 0.2: a multiway normalizer Z at or below this is replaced by 1.
 *  - `alphaShrink(spr, sprAlpha?)`, `surplusShrink(spr, sprSurplus?)`: s_α and s.
 *  - `FEATURE_COUNT` = 5, `COMPAT` = 1225, `MASS_EPS` = 1e-300 (V = CFV / M only where M > MASS_EPS, else 0).
 *
 * Matrices and buffers (built once per solve)
 *  - `kernelMatrices(eq, cnt, N?)`: K[h,x] = cnt[h,x] / 1225 and KE[h,x] = K[h,x]·eq[h,x], row-major N×N. K is not
 *    symmetric: every kernel reads the row of the hand being valued.
 *  - `kernelScratch(N)`: the gather buffers one kernel call uses (reusable across calls, not across threads).
 *  - `featureMatrix(N, f)`: the N×FEATURE_COUNT feature matrix, row-major, e.g.
 *    `featureMatrix(169, handFeatures)` with handFeatures from ./features.
 *
 * Kernels (§3.3–3.6). Arguments: `rOpp` is the opponent's reach vector (indexed by its class). `pot` and `paid`
 * are the pot and the valued seat's total investment: P and T_s (termPot, termCommit) at a flop; P' and
 * T_s − refund_s (termAllinPot, termCommit minus termRefund for termRefundSeat) at an all-in. Each writes, for every
 * class h of the valued seat, `mass[h]` = M(h) = Σ_x K[h,x]·rOpp(x) (the opponent's mass seen from h: the solver's
 * m_opp(h) in exact arithmetic, though not bit for bit, since the solver gets fold masses by subtraction) and
 * `out[h]`: the counterfactual value CFV(h) if `normalize` is false, else V(h) = CFV(h) / M(h) (0 where
 * M ≤ MASS_EPS), the expected net given h and the terminal reached (§4.2). At a flop, (V(h) + paid) / pot is h's
 * range-averaged pot share, which the negative-share diagnostic of §4.5 reads.
 *  - `matVecK(km, r, out, sc)`: out = K·r, the solver's mass update m_s^a = K·r_s^a (§4.2 step 2).
 *  - `massAndEquity(km, r, mass, eqMass, sc)`: M = K·r and A1 = KE·r, the 2-accumulator pass.
 *  - `allinSide(km, rOpp, pot, paid, out, mass, sc, normalize)`: an all-in, net = e·P' + refund − T (§3.3).
 *    The 2-accumulator kernel of §4.7; the same function serves both seats.
 *  - `affineSideO(km, v, rI, pot, paid, out, mass, sc, normalize)` and `affineSideI(km, v, rO, …)`: the affine
 *    pairwise kernel Φ_O(h,x) = (p_O(h) + p_I(x))·e + q_O(h) − q_I(x), Φ_I = 1 − Φ_O, net = Φ·P − T, for the seat
 *    acting first postflop (O, holding h) and the other (I, holding x). The §3.5 formulas, one fused loop per side:
 *    4 accumulators for O, 5 for I, or 3 each when `v.uniformP` (p_O constant, p_I zero: model B and equity).
 *  - `multiwayKernel(km, term, reach, M, A1, norm, out, sc, normalize)`: a 3- or 4-way flop (§3.6). It runs one
 *    `massAndEquity` pass per live seat into M[j], A1[j] (k passes, not k(k−1): ē_o(h) depends only on o and h),
 *    then `multiwayValues`. `reach`, `M`, `A1`, `out` are indexed by live seat in postflop order.
 *  - `multiwayNorm(term, reach, M, A1, cw, norm)`: Z and ū from reach vectors and their M, A1 passes. The solver
 *    calls it with the average profile σ̄ at its refresh iterations and freezes `norm` in between (§3.6).
 *  - `multiwayValues(term, M, A1, norm, out, normalize)`: the values from precomputed M, A1.
 *
 * Kernel vectors (built once per terminal; `out` reuses a PairwiseVectors)
 *  - `PairwiseVectors` {pO, pI, qO, qI, uniformP}; `pairwiseVectors(N)` allocates zeros (uniformP false).
 *  - `equityVectors(N, out?)`: showdown equity, Φ_O = e (valuation "equity", and every all-in).
 *  - `oneSidedVectors(R, bbActsFirst, out?)`: openjam.ts's flat-call terminal (valuation "oneSided"): the BB realizes
 *    R of its equity and the opener gets the rest. bbActsFirst is true unless the opener is the SB at n ≥ 3.
 *  - `equityScaledSurplusVectors(rO, rI, out?)`: the §3.4 table row of Product's form, as is (no SPR or role rule).
 *  - `shareO(v, h, x, e)`: Φ_O of one pair (tests, the negative-share diagnostic of §4.5).
 *
 * Model B (§3.4, §3.6)
 *  - `ModelBParams`: α, c_fit, θ_O, θ_I, κ_3, κ_4 and optional overrides of the priors (the sensitivity solves of §6.6).
 *    EQR_FIT from ./eqrFit has exactly these field names, so it can be passed as is.
 *  - `zeroModelB(kappa3, kappa4)`: α = c = θ = 0 and multiway c_pos = 0 (PF-ZERO-1, and the multiway part of the
 *    "equity" valuation: the κ-corrected product of pairwise equities).
 *  - `prepareModelB(params, features)`: validates and precomputes u_call = θ_O·F and u_aggr = θ_I·F per class.
 *  - `contextC(cFit, potType, aggressor, cDerivedScale?)`: c of a heads-up context by the ⅔ position / ⅓ initiative
 *    split: c_fit with an IP aggressor, ⅓·c_fit with an OOP aggressor, ⅔·c_fit in a limped pot.
 *  - `modelBVectors(model, ctx, out?)`: the kernel vectors of a heads-up flop. ctx = {potType, aggressor, spr} with
 *    aggressor "O" or "I" (the last raiser, by postflop order) or null in a limped pot. The aggressor uses u_aggr,
 *    the other player u_call, both u_call in a limped pot.
 *  - `modelBMultiway(model, k, aggressor, spr, pot, paid, out?)`: the `MultiwayTerm` of a k-way flop; aggressor is
 *    the raiser's index in postflop order (-1 for none); paid[j] = T of live seat j.
 *  - `uncontestedValue(pot, paid)`, `foldedValue(paid)`: the constant nets of §3.1–3.2.
 *
 * With a tree from ./tree: O = termSeats[4t], I = termSeats[4t + 1], aggressor = termAggressor[t] compared with them,
 * potType = POT_TYPES[termPotType[t]], spr = termSpr[t].
 */

// ───────────── named priors and constants (§3.4, §3.6) ─────────────

/** Below this SPR the equity-edge term α shrinks linearly to 0 (§3.4: the stacks behind keep it at full size above). */
export const SPR_ALPHA = 1.5;
/** Below this SPR the position and playability terms c and u shrink linearly to 0 (both packs sit above SPR 6). */
export const SPR_SURPLUS = 6;
/** Multiway c_pos (§3.6): the last seat to act gets +MW_C_POS, the first −MW_C_POS, the middles 0. Sums to 0. */
export const MW_C_POS = 0.02;
/** A multiway normalizer at or below this means the live seats have almost no reach; Z = 1 is used instead. */
export const Z_FLOOR = 0.2;
/** Model B's hand features: pair, suited, bway, conn, weakAce (./features). */
export const FEATURE_COUNT = 5;
/** Combos one opponent can hold once my two cards are out: K = cnt / COMPAT is a conditional probability. */
export const COMPAT = 1225;
/** Values are normalized by the opponent's mass only above this; below it V = 0 (§4.2). */
export const MASS_EPS = 1e-300;

/** s_α = min(1, SPR / sprAlpha), the shrink of the equity-edge term α. */
export function alphaShrink(spr: number, sprAlpha = SPR_ALPHA): number {
  return Math.min(1, Math.max(0, spr) / sprAlpha);
}

/** s = min(1, SPR / sprSurplus), the shrink of c and u. */
export function surplusShrink(spr: number, sprSurplus = SPR_SURPLUS): number {
  return Math.min(1, Math.max(0, spr) / sprSurplus);
}

// ───────────── chip accounting (§3.1–3.2) ─────────────

/** Net of the seat that wins uncontested: the whole pot minus what it put in. */
export const uncontestedValue = (pot: number, paid: number) => pot - paid;
/** Net of a folded seat: what it put in, whatever its hand. */
export const foldedValue = (paid: number) => -paid;

// ───────────── matrices and buffers ─────────────

export interface KernelMatrices {
  N: number;
  /** K[h*N + x] = cnt[h,x] / COMPAT: the chance a given opponent combo of class x fits with my class-h combo. */
  K: Float64Array;
  /** KE[h*N + x] = K[h,x]·eq[h,x]. */
  KE: Float64Array;
}

export function kernelMatrices(eq: ArrayLike<number>, cnt: ArrayLike<number>, N = Math.round(Math.sqrt(eq.length))): KernelMatrices {
  if (eq.length !== N * N || cnt.length !== N * N) throw new Error(`eq and cnt must be ${N}×${N}`);
  const K = new Float64Array(N * N), KE = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) {
    K[i] = cnt[i] / COMPAT;
    KE[i] = K[i] * eq[i];
  }
  return { N, K, KE };
}

/** Gather buffers: the opponent's non-zero classes and their weights, packed contiguously. */
export interface KernelScratch {
  idx: Int32Array;
  g0: Float64Array;
  g1: Float64Array;
  g2: Float64Array;
}

export function kernelScratch(N: number): KernelScratch {
  return { idx: new Int32Array(N), g0: new Float64Array(N), g1: new Float64Array(N), g2: new Float64Array(N) };
}

/** The N×FEATURE_COUNT feature matrix, row-major: F[h*FEATURE_COUNT + k]. */
export function featureMatrix(N: number, f: (h: number) => ArrayLike<number>): Float64Array {
  const F = new Float64Array(N * FEATURE_COUNT);
  for (let h = 0; h < N; h++) {
    const row = f(h);
    if (row.length !== FEATURE_COUNT) throw new Error(`class ${h}: ${row.length} features, expected ${FEATURE_COUNT}`);
    for (let k = 0; k < FEATURE_COUNT; k++) F[h * FEATURE_COUNT + k] = row[k];
  }
  return F;
}

// The gathers below pack the non-zero entries of a reach vector (and its products with per-class kernel vectors)
// into the first nz slots of the scratch buffers, so the N×nz inner loops touch only classes that can occur. A
// dense reach costs one extra index load per element; a sparse one (most of the tree, after regret matching)
// saves the work on every zero.

function gather1(r: Float64Array, N: number, sc: KernelScratch): number {
  const { idx, g0 } = sc;
  let nz = 0;
  for (let x = 0; x < N; x++) {
    const w = r[x];
    if (w !== 0) {
      idx[nz] = x;
      g0[nz] = w;
      nz++;
    }
  }
  return nz;
}

function gather3(r: Float64Array, N: number, a: Float64Array, b: Float64Array, sc: KernelScratch): number {
  const { idx, g0, g1, g2 } = sc;
  let nz = 0;
  for (let x = 0; x < N; x++) {
    const w = r[x];
    if (w !== 0) {
      idx[nz] = x;
      g0[nz] = w;
      g1[nz] = w * a[x];
      g2[nz] = w * b[x];
      nz++;
    }
  }
  return nz;
}

// ───────────── kernels (§3.3–3.5, §4.7) ─────────────

/** out[h] = Σ_x K[h,x]·r[x], skipping zero entries of r. */
export function matVecK(km: KernelMatrices, r: Float64Array, out: Float64Array, sc: KernelScratch): void {
  const { N, K } = km;
  const { idx, g0 } = sc;
  const nz = gather1(r, N, sc);
  for (let h = 0; h < N; h++) {
    const row = h * N;
    let m = 0;
    for (let j = 0; j < nz; j++) m += K[row + idx[j]] * g0[j];
    out[h] = m;
  }
}

/** mass[h] = Σ_x K[h,x]·r[x] and eqMass[h] = Σ_x KE[h,x]·r[x] (M and A1 of §3.5). */
export function massAndEquity(km: KernelMatrices, r: Float64Array, mass: Float64Array, eqMass: Float64Array, sc: KernelScratch): void {
  const { N, K, KE } = km;
  const { idx, g0 } = sc;
  const nz = gather1(r, N, sc);
  for (let h = 0; h < N; h++) {
    const row = h * N;
    let m = 0, a1 = 0;
    for (let j = 0; j < nz; j++) {
      const i = row + idx[j], w = g0[j];
      m += K[i] * w;
      a1 += KE[i] * w;
    }
    mass[h] = m;
    eqMass[h] = a1;
  }
}

/**
 * Heads-up all-in (§3.3), for either seat: net(h, x) = eq[h,x]·P' + refund − T, so with paid = T − refund,
 * CFV(h) = P'·A1(h) − paid·M(h). Only M and A1 are needed (§3.5: the all-in is the affine kernel with p_O = 1 and
 * zeros elsewhere, and on the I side C1 − C2 collapses to M' − D1).
 */
export function allinSide(
  km: KernelMatrices,
  rOpp: Float64Array,
  pot: number,
  paid: number,
  out: Float64Array,
  mass: Float64Array,
  sc: KernelScratch,
  normalize: boolean,
): void {
  const { N, K, KE } = km;
  const { idx, g0 } = sc;
  const nz = gather1(rOpp, N, sc);
  for (let h = 0; h < N; h++) {
    const row = h * N;
    let m = 0, a1 = 0;
    for (let j = 0; j < nz; j++) {
      const i = row + idx[j], w = g0[j];
      m += K[i] * w;
      a1 += KE[i] * w;
    }
    const cfv = pot * a1 - paid * m;
    mass[h] = m;
    out[h] = normalize ? (m > MASS_EPS ? cfv / m : 0) : cfv;
  }
}

/**
 * Per-class vectors of the affine pairwise kernel (§3.4): Φ_O(h,x) = (pO[h] + pI[x])·e + qO[h] − qI[x], where O
 * acts first postflop holding h, I holds x and e = eq[h,x]. Φ_I = 1 − Φ_O, so every pair is zero-sum.
 */
export interface PairwiseVectors {
  pO: Float64Array;
  pI: Float64Array;
  qO: Float64Array;
  qI: Float64Array;
  /**
   * pO is the same for every class and pI is zero (model B, equity). The kernels then need 3 accumulators per side
   * instead of 4 and 5. The builders set it; vectors filled by hand must leave it false.
   */
  uniformP: boolean;
}

export function pairwiseVectors(N: number): PairwiseVectors {
  return { pO: new Float64Array(N), pI: new Float64Array(N), qO: new Float64Array(N), qI: new Float64Array(N), uniformP: false };
}

/** Φ_O of one class pair, e = eq[h,x]. */
export function shareO(v: PairwiseVectors, h: number, x: number, e: number): number {
  return (v.pO[h] + v.pI[x]) * e + v.qO[h] - v.qI[x];
}

/**
 * The seat acting first postflop (O) holding h, against I's reach rI (§3.5):
 *   M = Σ K·rI, A1 = Σ KE·rI, A2 = Σ KE·rI·pI, B = Σ K·rI·qI,
 *   CFV_O(h) = P·[pO(h)·A1 + A2 + qO(h)·M − B] − T_O·M.
 */
export function affineSideO(
  km: KernelMatrices,
  v: PairwiseVectors,
  rI: Float64Array,
  pot: number,
  paid: number,
  out: Float64Array,
  mass: Float64Array,
  sc: KernelScratch,
  normalize: boolean,
): void {
  const { N, K, KE } = km;
  const { pO, pI, qO, qI } = v;
  const { idx, g0, g1, g2 } = sc;
  const nz = gather3(rI, N, pI, qI, sc);
  if (v.uniformP) {
    // pI = 0, so A2 = 0.
    const p = pO[0];
    for (let h = 0; h < N; h++) {
      const row = h * N;
      let m = 0, a1 = 0, b = 0;
      for (let j = 0; j < nz; j++) {
        const i = row + idx[j], k = K[i], w = g0[j];
        m += k * w;
        a1 += KE[i] * w;
        b += k * g2[j];
      }
      const cfv = pot * (p * a1 + qO[h] * m - b) - paid * m;
      mass[h] = m;
      out[h] = normalize ? (m > MASS_EPS ? cfv / m : 0) : cfv;
    }
    return;
  }
  for (let h = 0; h < N; h++) {
    const row = h * N;
    let m = 0, a1 = 0, a2 = 0, b = 0;
    for (let j = 0; j < nz; j++) {
      const i = row + idx[j], k = K[i], ke = KE[i], w = g0[j];
      m += k * w;
      a1 += ke * w;
      a2 += ke * g1[j];
      b += k * g2[j];
    }
    const cfv = pot * (pO[h] * a1 + a2 + qO[h] * m - b) - paid * m;
    mass[h] = m;
    out[h] = normalize ? (m > MASS_EPS ? cfv / m : 0) : cfv;
  }
}

/**
 * The seat acting last postflop (I) holding x, against O's reach rO (§3.5). With e' = eq[x,h] = 1 − e, I's share
 * is 1 − Φ_O = 1 − (pO(h) + pI(x))·(1 − e') − qO(h) + qI(x), so over O's hands h:
 *   M' = Σ K·rO, C1 = Σ K·rO·pO, C2 = Σ KE·rO·pO, D1 = Σ KE·rO, Q = Σ K·rO·qO,
 *   CFV_I(x) = P·[M' − (C1 − C2) − pI(x)·(M' − D1) − Q + qI(x)·M'] − T_I·M'.
 * K and KE are read on row x: K is not symmetric (cnt[x,h] ≠ cnt[h,x] when the classes have different combo counts).
 */
export function affineSideI(
  km: KernelMatrices,
  v: PairwiseVectors,
  rO: Float64Array,
  pot: number,
  paid: number,
  out: Float64Array,
  mass: Float64Array,
  sc: KernelScratch,
  normalize: boolean,
): void {
  const { N, K, KE } = km;
  const { pO, pI, qO, qI } = v;
  const { idx, g0, g1, g2 } = sc;
  const nz = gather3(rO, N, pO, qO, sc);
  if (v.uniformP) {
    // pO(h) = p and pI = 0: C1 = p·M', C2 = p·D1.
    const p = pO[0];
    for (let x = 0; x < N; x++) {
      const row = x * N;
      let m = 0, d1 = 0, q = 0;
      for (let j = 0; j < nz; j++) {
        const i = row + idx[j], k = K[i], w = g0[j];
        m += k * w;
        d1 += KE[i] * w;
        q += k * g2[j];
      }
      const cfv = pot * (m - p * (m - d1) - q + qI[x] * m) - paid * m;
      mass[x] = m;
      out[x] = normalize ? (m > MASS_EPS ? cfv / m : 0) : cfv;
    }
    return;
  }
  for (let x = 0; x < N; x++) {
    const row = x * N;
    let m = 0, c1 = 0, c2 = 0, d1 = 0, q = 0;
    for (let j = 0; j < nz; j++) {
      const i = row + idx[j], k = K[i], ke = KE[i], w = g0[j], wp = g1[j];
      m += k * w;
      c1 += k * wp;
      c2 += ke * wp;
      d1 += ke * w;
      q += k * g2[j];
    }
    const cfv = pot * (m - (c1 - c2) - pI[x] * (m - d1) - q + qI[x] * m) - paid * m;
    mass[x] = m;
    out[x] = normalize ? (m > MASS_EPS ? cfv / m : 0) : cfv;
  }
}

// ───────────── kernel vectors: equity, one-sided, Product's form ─────────────

/** Showdown equity: Φ_O = e (pO = 1, the rest 0). */
export function equityVectors(N: number, out: PairwiseVectors = pairwiseVectors(N)): PairwiseVectors {
  out.pO.fill(1);
  out.pI.fill(0);
  out.qO.fill(0);
  out.qI.fill(0);
  out.uniformP = true;
  return out;
}

/**
 * openjam.ts's flat-call terminal (§3.4 table, valuation "oneSided"): the BB realizes R of its equity whether it acts
 * first or last, and the opener gets the rest.
 *  - BB acts first (O = BB, h is the BB's class): Φ_O = R(h)·e, so pO = R and the rest 0.
 *  - BB acts last (I = BB, the opener is the SB at n ≥ 3): Φ_I = R(x)·(1 − e), so Φ_O = R(x)·e + 1 − R(x):
 *    pI = R, qI = R − 1 and the rest 0.
 */
export function oneSidedVectors(R: ArrayLike<number>, bbActsFirst: boolean, out: PairwiseVectors = pairwiseVectors(R.length)): PairwiseVectors {
  const N = R.length;
  for (let h = 0; h < N; h++) {
    out.pO[h] = bbActsFirst ? R[h] : 0;
    out.pI[h] = bbActsFirst ? 0 : R[h];
    out.qO[h] = 0;
    out.qI[h] = bbActsFirst ? 0 : R[h] - 1;
  }
  out.uniformP = false;
  return out;
}

/**
 * Product's equity-scaled surplus (§3.4 table, kept for model selection and sensitivity solve (d)):
 * Φ_O = R_O(h)·e − (R_I(x) − 1)·(1 − e), i.e. pO = R_O, pI = R_I − 1, qO = 0, qI = R_I − 1. The design fits it only
 * in (SRP, IP aggressor) and gives it no SPR or role rule, so this is the table row as is; the caller decides how it
 * carries to other contexts.
 */
export function equityScaledSurplusVectors(rO: ArrayLike<number>, rI: ArrayLike<number>, out: PairwiseVectors = pairwiseVectors(rO.length)): PairwiseVectors {
  const N = rO.length;
  if (rI.length !== N) throw new Error("rO and rI must have the same length");
  for (let h = 0; h < N; h++) {
    out.pO[h] = rO[h];
    out.pI[h] = rI[h] - 1;
    out.qO[h] = 0;
    out.qI[h] = rI[h] - 1;
  }
  out.uniformP = false;
  return out;
}

// ───────────── model B (§3.4) ─────────────

/**
 * The fitted realization model and the priors that carry it to other contexts. The six required fields are
 * EQR_FIT's (./eqrFit, generated by scripts/fit-realization.mjs), so EQR_FIT can be passed directly; the alternative
 * 3-feature fit needs κ added. The optional fields default to the design's priors and exist for the sensitivity
 * solves of §6.6 (scale the uncalibrated parameters ×0.5 / ×1.5; SPR_ALPHA = 6 for the old low-SPR rule).
 */
export interface ModelBParams {
  /** The equity-edge term α, shared by every context. */
  alpha: number;
  /** c of the one fitted context, (single raised pot, IP aggressor). ≤ 0: moves pot share from OOP to IP. */
  cFit: number;
  /** u weights of the fitted OOP side, i.e. the caller: u_call(h) = Σ_k thetaO[k]·F_k(h) over the first thetaO.length features. */
  thetaO: ArrayLike<number>;
  /** u weights of the fitted IP side, i.e. the aggressor: u_aggr(h) = Σ_k thetaI[k]·F_k(h). */
  thetaI: ArrayLike<number>;
  /** κ_3 and κ_4 per class: the k-way pot share over the product of pairwise equities (§3.6). */
  kappa3: ArrayLike<number>;
  kappa4: ArrayLike<number>;
  /** α_mw, the equity-edge term on multiway shares. Default: alpha (§3.6 prior). */
  alphaMw?: number;
  /** Default SPR_ALPHA. */
  sprAlpha?: number;
  /** Default SPR_SURPLUS. */
  sprSurplus?: number;
  /** Multiway c_pos of the last seat to act (the first gets the negative). Default MW_C_POS. */
  mwCPos?: number;
  /** Scale of the multiway u term s·(u_role − ū). Default 1. */
  mwUScale?: number;
  /** Scale of c in every heads-up context except the fitted one (SRP, IP aggressor). Default 1. */
  cDerivedScale?: number;
}

/** Model B with no realization edge at all: α = c = θ = 0 and no multiway c_pos (PF-ZERO-1). */
export function zeroModelB(kappa3: ArrayLike<number>, kappa4: ArrayLike<number>): ModelBParams {
  return { alpha: 0, cFit: 0, thetaO: [0, 0, 0, 0, 0], thetaI: [0, 0, 0, 0, 0], kappa3, kappa4, mwCPos: 0 };
}

/** ModelBParams with every default filled in and the per-class vectors precomputed. */
export interface ModelB {
  N: number;
  alpha: number;
  cFit: number;
  alphaMw: number;
  sprAlpha: number;
  sprSurplus: number;
  mwCPos: number;
  cDerivedScale: number;
  /** u_call = θ_O·F and u_aggr = θ_I·F, heads-up. */
  uCall: Float64Array;
  uAggr: Float64Array;
  /** The same × mwUScale, for multiway pots. */
  uCallMw: Float64Array;
  uAggrMw: Float64Array;
  kappa3: Float64Array;
  kappa4: Float64Array;
}

/** `features` is the N×FEATURE_COUNT matrix of featureMatrix (row-major). */
export function prepareModelB(params: ModelBParams, features: Float64Array): ModelB {
  if (features.length % FEATURE_COUNT !== 0) throw new Error(`features must be N×${FEATURE_COUNT}`);
  const N = features.length / FEATURE_COUNT;
  const { thetaO, thetaI } = params;
  if (thetaO.length > FEATURE_COUNT || thetaI.length > FEATURE_COUNT) throw new Error(`at most ${FEATURE_COUNT} feature weights`);
  if (params.kappa3.length !== N || params.kappa4.length !== N) throw new Error(`kappa3 and kappa4 must have ${N} entries`);
  const u = (theta: ArrayLike<number>, scale: number) => {
    const v = new Float64Array(N);
    for (let h = 0; h < N; h++) {
      let s = 0;
      for (let k = 0; k < theta.length; k++) s += theta[k] * features[h * FEATURE_COUNT + k];
      v[h] = s * scale;
    }
    return v;
  };
  const mwUScale = params.mwUScale ?? 1;
  const model: ModelB = {
    N,
    alpha: params.alpha,
    cFit: params.cFit,
    alphaMw: params.alphaMw ?? params.alpha,
    sprAlpha: params.sprAlpha ?? SPR_ALPHA,
    sprSurplus: params.sprSurplus ?? SPR_SURPLUS,
    mwCPos: params.mwCPos ?? MW_C_POS,
    cDerivedScale: params.cDerivedScale ?? 1,
    uCall: u(thetaO, 1),
    uAggr: u(thetaI, 1),
    uCallMw: u(thetaO, mwUScale),
    uAggrMw: u(thetaI, mwUScale),
    kappa3: Float64Array.from(params.kappa3),
    kappa4: Float64Array.from(params.kappa4),
  };
  for (const [name, x] of Object.entries(model)) {
    if (typeof x === "number" && !Number.isFinite(x)) throw new Error(`model B: ${name} is not finite`);
  }
  if (!(model.sprAlpha > 0) || !(model.sprSurplus > 0)) throw new Error("model B: SPR breakpoints must be positive");
  return model;
}

/** The flop pot types of ./tree (PotType there). */
export type FlopPotType = "limp" | "srp" | "3bp" | "4bp";

/** A heads-up flop as model B sees it. */
export interface HuContext {
  potType: FlopPotType;
  /** The last raiser by postflop order: "O" acts first, "I" last; null in a limped pot. */
  aggressor: "O" | "I" | null;
  /** Flop SPR: the smaller remaining stack over the pot. */
  spr: number;
}

/**
 * c of a heads-up context (§3.4). Only (SRP, IP aggressor) is fitted; the rest follow one rule, splitting c_fit into
 * position c_pos = ⅔·c_fit and initiative c_init = ⅓·c_fit (both ≤ 0, favouring IP):
 *  - IP aggressor: c_pos + c_init = c_fit;
 *  - OOP aggressor: c_pos − c_init = ⅓·c_fit (initiative now favours OOP);
 *  - limped pot: c_pos = ⅔·c_fit.
 * 3-bet and 4-bet pots use the same rule; their lower SPR shrinks c through s. cDerivedScale scales every context
 * but the fitted one (sensitivity solves (a), (b)).
 */
export function contextC(cFit: number, potType: FlopPotType, aggressor: "O" | "I" | null, cDerivedScale = 1): number {
  if (potType === "limp") return ((2 * cFit) / 3) * cDerivedScale;
  if (aggressor === "I") return potType === "srp" ? cFit : cFit * cDerivedScale;
  if (aggressor === "O") return (cFit / 3) * cDerivedScale;
  throw new Error(`a ${potType} flop needs an aggressor`);
}

/**
 * Kernel vectors of a heads-up flop under model B (§3.4):
 *   Φ_O(h,x) = e + s_α·α·(e − ½) + s·[c + u_O(h) − u_I(x)]
 * as pO = 1 + s_α·α, pI = 0, qO = −s_α·α/2 + s·(c + u_O(h)), qI = s·u_I(x). u is by role, not position: the
 * aggressor uses u_aggr (the fitted IP vector), the other player u_call (the fitted OOP vector), both u_call in a
 * limped pot.
 */
export function modelBVectors(model: ModelB, ctx: HuContext, out: PairwiseVectors = pairwiseVectors(model.N)): PairwiseVectors {
  const { N, alpha } = model;
  const s = surplusShrink(ctx.spr, model.sprSurplus);
  const sa = alphaShrink(ctx.spr, model.sprAlpha);
  const aggressor = ctx.potType === "limp" ? null : ctx.aggressor;
  const c = contextC(model.cFit, ctx.potType, aggressor, model.cDerivedScale);
  const uO = aggressor === "O" ? model.uAggr : model.uCall;
  const uI = aggressor === "I" ? model.uAggr : model.uCall;
  const p = 1 + sa * alpha;
  const q0 = (-sa * alpha) / 2;
  for (let h = 0; h < N; h++) {
    out.pO[h] = p;
    out.pI[h] = 0;
    out.qO[h] = q0 + s * (c + uO[h]);
    out.qI[h] = s * uI[h];
  }
  out.uniformP = true;
  return out;
}

// ───────────── multiway flop (§3.6) ─────────────

/** A 3- or 4-way flop. Per-seat fields are indexed by live seat in postflop order. */
export interface MultiwayTerm {
  k: number;
  pot: number;
  /** T of each live seat. */
  paid: Float64Array;
  /** κ_k per class. */
  kappa: Float64Array;
  /** c_pos of each live seat. Must sum to 0 for the shares to sum to 1 on average. */
  cPos: Float64Array;
  /** u_role of each live seat: u_aggr for the raiser, u_call otherwise (already × mwUScale). */
  u: Float64Array[];
  /** The §3.4 shrinks at the terminal's SPR. */
  s: number;
  sAlpha: number;
  alphaMw: number;
}

/** The frozen normalizers of one multiway terminal (§3.6). */
export interface MultiwayNorm {
  Z: number;
  ubar: number;
}

/** Model B's multiway terminal: κ_k, c_pos −/0/+ by postflop position, u by role, α_mw. */
export function modelBMultiway(
  model: ModelB,
  k: number,
  aggressor: number,
  spr: number,
  pot: number,
  paid: ArrayLike<number>,
  out?: MultiwayTerm,
): MultiwayTerm {
  if (k !== 3 && k !== 4) throw new Error(`a multiway flop has 3 or 4 live seats, got ${k}`);
  if (paid.length < k) throw new Error("paid needs one entry per live seat");
  // Sized for 4 seats so a term can be reused for either k (a typed array would silently drop a 4th entry).
  const term: MultiwayTerm = out ?? {
    k,
    pot,
    paid: new Float64Array(4),
    kappa: model.kappa3,
    cPos: new Float64Array(4),
    u: [],
    s: 0,
    sAlpha: 0,
    alphaMw: 0,
  };
  if (term.paid.length < k || term.cPos.length < k) throw new Error("the reused MultiwayTerm is too small for this k");
  term.k = k;
  term.pot = pot;
  term.kappa = k === 3 ? model.kappa3 : model.kappa4;
  term.s = surplusShrink(spr, model.sprSurplus);
  term.sAlpha = alphaShrink(spr, model.sprAlpha);
  term.alphaMw = model.alphaMw;
  term.u.length = k;
  for (let j = 0; j < k; j++) {
    term.paid[j] = paid[j];
    term.cPos[j] = j === 0 ? -model.mwCPos : j === k - 1 ? model.mwCPos : 0;
    term.u[j] = j === aggressor ? model.uAggrMw : model.uCallMw;
  }
  return term;
}

/**
 * Z and ū of a multiway terminal (§3.6), from reach vectors and their M, A1 passes (massAndEquity):
 *  - Z = Σ_s mean of κ(h)·Π_{o≠s} ē_o(h) under seat s's weights w_s(h) = r_s(h)·cw(h)·Π_{o≠s} M_o(h), where
 *    w_s·Π ē_o = r_s·cw·Π A1_o; floored: Z ≤ Z_FLOOR becomes 1;
 *  - ū = the mean over the live seats of their w_s-weighted mean u_role.
 * A seat with no weight at all counts 1/k towards Z and 0 towards ū (the prototype's choice; such a terminal has no
 * reach, so its values never matter). The solver passes the average profile σ̄ (§3.6), so the payoff is a fixed
 * function of the hand tuple between refreshes and the game stays multilinear.
 */
export function multiwayNorm(
  term: MultiwayTerm,
  reach: readonly Float64Array[],
  M: readonly Float64Array[],
  A1: readonly Float64Array[],
  cw: Float64Array,
  norm: MultiwayNorm,
): MultiwayNorm {
  const { k, kappa } = term;
  const N = kappa.length;
  let Z = 0, usum = 0;
  for (let j = 0; j < k; j++) {
    const r = reach[j], u = term.u[j];
    let num = 0, den = 0, uu = 0;
    for (let h = 0; h < N; h++) {
      const w0 = cw[h] * r[h];
      if (w0 === 0) continue;
      let pm = 1, pa = 1;
      for (let o = 0; o < k; o++) {
        if (o === j) continue;
        pm *= M[o][h];
        pa *= A1[o][h];
      }
      const w = w0 * pm;
      den += w;
      num += w0 * kappa[h] * pa;
      uu += w * u[h];
    }
    if (den > 0) {
      Z += num / den;
      usum += uu / den;
    } else Z += 1 / k;
  }
  norm.Z = Z > Z_FLOOR ? Z : 1;
  norm.ubar = usum / k;
  return norm;
}

/**
 * Values of every live seat at a multiway terminal from precomputed M[o], A1[o] (§3.6):
 *   raw_s(h) = κ(h)·Π_{o≠s} ē_o(h) / Z,   ē_o = A1_o / M_o,
 *   share_s(h) = raw_s + s_α·α_mw·(raw_s − 1/k) + s·(c_pos(s) + u_s(h) − ū),
 *   V_s(h) = share_s·P − T_s;  CFV_s(h) = Π_{o≠s} M_o(h)·V_s(h).
 * Where some M_o(h) ≤ MASS_EPS the hand cannot meet that seat's range and the output is 0.
 */
export function multiwayValues(
  term: MultiwayTerm,
  M: readonly Float64Array[],
  A1: readonly Float64Array[],
  norm: MultiwayNorm,
  out: readonly Float64Array[],
  normalize: boolean,
): void {
  const { k, kappa, pot, s, sAlpha, alphaMw } = term;
  const N = kappa.length;
  const invZ = 1 / norm.Z, fair = 1 / k, ubar = norm.ubar;
  for (let j = 0; j < k; j++) {
    const dst = out[j], u = term.u[j];
    const base = s * (term.cPos[j] - ubar);
    const paid = term.paid[j];
    for (let h = 0; h < N; h++) {
      let pe = kappa[h], pm = 1, ok = true;
      for (let o = 0; o < k; o++) {
        if (o === j) continue;
        const m = M[o][h];
        if (!(m > MASS_EPS)) {
          ok = false;
          break;
        }
        pe *= A1[o][h] / m;
        pm *= m;
      }
      if (!ok) {
        dst[h] = 0;
        continue;
      }
      const raw = pe * invZ;
      const v = (raw + sAlpha * alphaMw * (raw - fair) + base + s * u[h]) * pot - paid;
      dst[h] = normalize ? v : pm * v;
    }
  }
}

/** One massAndEquity pass per live seat into M[j], A1[j], then multiwayValues with the frozen `norm`. */
export function multiwayKernel(
  km: KernelMatrices,
  term: MultiwayTerm,
  reach: readonly Float64Array[],
  M: readonly Float64Array[],
  A1: readonly Float64Array[],
  norm: MultiwayNorm,
  out: readonly Float64Array[],
  sc: KernelScratch,
  normalize: boolean,
): void {
  for (let j = 0; j < term.k; j++) massAndEquity(km, reach[j], M[j], A1[j], sc);
  multiwayValues(term, M, A1, norm, out, normalize);
}
