import { ALL_HANDS } from "../cards";
import { ACT, POT_TYPES, TERM, type PreflopTree } from "./tree";
import {
  FEATURE_COUNT,
  MASS_EPS,
  affineSideI,
  affineSideO,
  allinSide,
  equityVectors,
  kernelMatrices,
  kernelScratch,
  massAndEquity,
  matVecK,
  modelBMultiway,
  modelBVectors,
  multiwayKernel,
  multiwayNorm,
  oneSidedVectors,
  prepareModelB,
  zeroModelB,
  type KernelMatrices,
  type ModelB,
  type ModelBParams,
  type MultiwayNorm,
  type MultiwayTerm,
  type PairwiseVectors,
} from "./value";

/**
 * The preflop solver's engine (§ numbers refer to the solver design, which docs/preflop-solver.md will carry):
 * vectorized, simultaneous DCFR over the 169 hand classes on a tree from ./tree, with the terminal payoffs of
 * ./value. Generic over the class count N (169, or 3 in the toy test) and the seat count n (2..9).
 *
 * Model (§4.2, §4.3). Every seat t has a reach vector r_t (the product of its own action probabilities along the
 * line) and a mass vector m_t(h) = Σ_x K[h,x]·r_t(x): the chance that t holds a hand consistent with its actions,
 * seen by an observer holding h. Card removal is pairwise between the observer and each other seat, folded seats
 * enter through their fold mass, live opponents are independent given the observer's hand (pushfold.ts's own
 * approximation, so the reductions are exact). A walk returns, per seat t and class h, V_t(h): t's expected net
 * given that it holds h and the node is reached. At a node of seat s:
 *   V_s = Σ_a σ_a·V_s^a,  V_t = Σ_a (m_s^a / m_s)·V_t^a (0 where m_s ≤ 1e-300),
 *   R_a ← d(R_a) + w·(V_s^a − V_s), w(h) = Π_{t≠s} m_t(h),   S_a ← S_a·g + r_s·σ_a,
 * with the DCFR discounts α = 1.5, β = 0, γ = 2 applied before adding (t^1.5 as t·√t, g = q·q: no Math.pow, so the
 * result is bit-reproducible). Fold masses come by subtraction, m_s^F = max(0, m_s − Σ_{a≠F} m_s^a), so a node
 * costs one K·r product per non-fold action. With 3+ seats each seat sees a slightly different joint
 * distribution, so the seats' root EVs do not sum to 0 (§4.3); every best response and gain is computed in that
 * seat's own world.
 *
 * Exported API
 * ------------
 *  - `createSolver(tree, table, options)`: a `PreflopSolver` holding regrets and strategy sums
 *    (Float64Array(edgeCount·N), node i's action a at (actStart[i] + a)·N) and every scratch buffer.
 *    `options.valuation` picks the terminal payoffs: model B (the shipped one), plain equity, openjam's one-sided
 *    kernel, or model B with a caller-supplied heads-up kernel (sensitivity solves). `options.mode: "fp"` runs the
 *    fictitious play of solvePushFold / solveOpenJam instead (tests only, §4.8).
 *  - `solver.iterate(k)`: k DCFR (or FP) iterations. Z and ū of the multiway terminals are refreshed from the
 *    average profile σ̄ at iterations 1, 26, 51, … and frozen in between (§3.6).
 *  - `solver.average(out?)`: σ̄ as a strategy array (uniform where a strategy sum is 0).
 *  - `solver.evaluate(strategy, options?)`: per-seat EV, best-response value and gain (each in that seat's own
 *    world), NashConv, reach-weighted local regret, own reach and occ per node, occ per terminal, and the §4.5
 *    diagnostics (PF-FROZEN, negative shares, Σ EV). It first refreshes Z and ū from `strategy` (and restores the
 *    solver's own afterwards, so metrics never change the training run). Optionally, per edge (index
 *    (actStart[i] + a)·N + h, bb net from the start of the hand, given that the actor holds h and the node is
 *    reached): `{ actionValues: true }` gives the actor's value of every action when it follows `strategy` below,
 *    V^a(h); `{ brActionValues: true }` gives it when the actor best-responds below and every other seat plays
 *    `strategy`, B^a(h) ≥ V^a(h) (the close-call marker of the charts, docs §6.9). Each is a Float64Array(edgeCount·N),
 *    15 MB at 100bb: callers keep it only as long as they need it.
 *  - `solver.polish(nodes, k)`: the §4.6 polish pass on those nodes' subtrees.
 *  - `solver.restart()`: strategy sums to 0 and the discount counter back to t = 0, keeping the regrets.
 *  - `twoStartInit(solver, warmup?)`: PF-TWOSTART's second start (§5.4), steps 1–3.
 *  - `checkGates(solver, options?)` and `runSchedule(solver, options?)`: the §5.3 gates and the §4.6 schedule
 *    (1,500 iterations, then +250 until the gates pass or 4,000, then a polish pass if only exported local regret
 *    fails); `runSchedule(solver, { twoStart: 50 })` runs it from PF-TWOSTART's start. The per-stage failure rules
 *    (cold4 fallback, dropping an optional stage) are the generator's.
 *  - Export helpers: `ownReach` (ρ, §4.4), `actionShares` (reach-weighted action frequencies), `snapTenths` /
 *    `snapStrategy` (the §6.5 0.1 grid, for the snapped-profile gate), `defaultExported` (§6.4's node filter),
 *    `comboWeights`.
 */

// ───────────── options and results ─────────────

export type Valuation =
  /** Model B (§3.4, §3.6). `hu`, when given, replaces the heads-up flop kernel of terminal t (Product's form in
   *  sensitivity solve (d)); the multiway terminals stay model B's. */
  | { kind: "modelB"; params: ModelBParams; features: Float64Array; hu?: (tree: PreflopTree, t: number) => PairwiseVectors }
  /** Showdown equity at every flop; multiway flops get the κ-corrected product of pairwise equities (κ = 1 if omitted). */
  | { kind: "equity"; kappa3?: ArrayLike<number>; kappa4?: ArrayLike<number> }
  /** openjam.ts's flat-call terminal: the BB realizes R(h) of its equity (heads-up flops only). */
  | { kind: "oneSided"; R: ArrayLike<number> };

export interface SolverOptions {
  valuation: Valuation;
  /** Class weights for metrics (combos per class). Default: 6/4/12 for the 169 classes; required for other N. */
  cw?: ArrayLike<number>;
  /** "dcfr" (default) or "fp", the fictitious play of the reference solvers (tests, §4.8). */
  mode?: "dcfr" | "fp";
  /** FP's starting strategy (edgeCount·N); uniform if omitted. */
  fpInit?: Float64Array;
  /** Z and ū refresh period in iterations (default 25: iterations 1, 26, 51, …). */
  normEvery?: number;
}

export interface NegativeShare {
  term: number;
  seat: number;
  hand: number;
  /** The hand's range-averaged flop share, (V + T) / P. */
  share: number;
  /** occ of the terminal. */
  occ: number;
  /** The seat's own reach of the hand at the terminal. */
  reach: number;
}

export interface Evaluation {
  /** Per seat, bb per hand: own-world EV under the strategy (§4.3). Their sum is not 0 with card removal and 3+ seats. */
  ev: number[];
  /** Per seat, bb per hand: a best response's value against everyone else's strategy, in that seat's own world. */
  brEv: number[];
  /** Per seat: brEv − ev in mbb/hand. */
  gainMbb: number[];
  maxGainMbb: number;
  /** Σ_s gain_s, mbb/hand. */
  nashConvMbb: number;
  /** Σ_s ev_s: the "model inconsistency" diagnostic (§4.5). */
  evSum: number;
  /** Per node: Σ_h cw·ρ·(max_a V^a − Σ_a σ_a·V^a) / Σ_h cw·ρ, bb per reaching combo (ρ = raw own reach). */
  localRegret: Float64Array;
  /** Per node: the actor's own reach as a share of all combos, Σ cw·ρ / Σ cw. */
  reach: Float64Array;
  /** Per node: the chance its public line occurs in a dealt hand, Π_t Σ_h cw·r_t / Σ cw (§4.5). */
  occ: Float64Array;
  /** Per terminal, the same. */
  termOcc: Float64Array;
  /** PF-FROZEN (§4.5): Σ occ over terminals where R1 folded out a seat with voluntary chips; split by whether a
   *  raiser was among them. Shares of dealt hands. */
  frozen: { occ: number; raiserOcc: number; callerOcc: number };
  /** (terminal, seat, hand) triples where a reaching hand's range-averaged flop share is below 0 (model B is linear,
   *  so a weak hand against a strong range can get one). `occ` is Σ over them of the terminal's occ times the hand's
   *  share of the seat's reaching combos; `worst` lists the 25 with the largest such weight. */
  negativeShares: { count: number; occ: number; worst: NegativeShare[] };
  /** V^a(h) of the actor per edge, (actStart[i] + a)·N + h, when asked for. */
  actionValues: Float64Array | null;
  /** B^a(h) of the actor per edge, the same layout, when asked for: the actor best-responds below the node and every
   *  other seat plays the evaluated strategy. Equal to V^a(h) on an edge into a terminal and on the fold. */
  brActionValues: Float64Array | null;
}

export interface PreflopSolver {
  readonly tree: PreflopTree;
  readonly N: number;
  readonly km: KernelMatrices;
  /** Class weights (combos per class) and their sum. */
  readonly cw: Float64Array;
  readonly cwSum: number;
  /** Regrets and strategy sums, (actStart[i] + a)·N + h. */
  readonly regret: Float64Array;
  readonly ssum: Float64Array;
  /** The FP strategy (mode "fp"), else null. */
  readonly fpStrategy: Float64Array | null;
  /** The discount counter: iterations since the start or the last restart. */
  readonly t: number;
  /** Every DCFR or FP iteration run on the full tree, restarts included (polish iterations not counted). */
  readonly iterations: number;
  iterate(count?: number): void;
  average(out?: Float64Array): Float64Array;
  evaluate(strategy: Float64Array, options?: { actionValues?: boolean; brActionValues?: boolean }): Evaluation;
  polish(nodes: readonly number[], iterations: number): void;
  restart(): void;
}

// ───────────── helpers ─────────────

/** Combos per class for the 169 classes (pairs 6, suited 4, offsuit 12). */
export function comboWeights(): Float64Array {
  return Float64Array.from(ALL_HANDS, (h) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12));
}

const bit = (s: number) => 1 << s;

/** FP's tie order among non-fold actions, the reference solvers' (open beats jam, a re-jam beats the BB's flat). */
const FP_PRIORITY: Record<number, number> = { [ACT.R]: 0, [ACT.J]: 1, [ACT.C]: 2, [ACT.X]: 3, [ACT.L]: 4, [ACT.F]: 5 };

// ───────────── the solver ─────────────

export function createSolver(tree: PreflopTree, table: { eq: ArrayLike<number>; cnt: ArrayLike<number> }, options: SolverOptions): PreflopSolver {
  const km = kernelMatrices(table.eq, table.cnt);
  const N = km.N;
  const { n, nodeCount, edgeCount, termCount, seat, actStart, foldIdx, child, termKind, termNLive, termSeats, termPot, termAllinPot, termCommit, termRefund, termRefundSeat } = tree;
  if (n > 30) throw new Error("seat masks are 32-bit");
  const cwIn = options.cw ? Float64Array.from(options.cw) : N === 169 ? comboWeights() : null;
  if (!cwIn || cwIn.length !== N) throw new Error(`class weights must have ${N} entries`);
  const cw: Float64Array = cwIn;
  let cwSum = 0;
  for (let h = 0; h < N; h++) cwSum += cw[h];
  const normEvery = options.normEvery ?? 25;
  const mode = options.mode ?? "dcfr";
  const sc = kernelScratch(N);

  // ── static per-node data ──
  // Seats still in at a node, and the seats whose values a node must return: during training only seats that act
  // at some ancestor ever read a value (their regrets live above), so a node computes V_t only for active t that
  // acted earlier. A child's requirement is then exactly its own (needMask(c) = needMask(p) ∪ {s_p}, restricted to
  // the seats active at c); seats active at the parent but folded at the child get the constant −T.
  const nodeActive = new Int32Array(nodeCount);
  const needMask = new Int32Array(nodeCount);
  const nodeCommit = new Float64Array(nodeCount * n);
  const edgeNode = new Int32Array(edgeCount);
  const subtreeEnd = new Int32Array(nodeCount);
  let maxA = 0;
  {
    const anc = new Int32Array(nodeCount);
    for (let p = 0; p < nodeCount; p++) {
      const info = tree.nodes[p];
      let m = 0;
      for (const s of info.active) m |= bit(s);
      nodeActive[p] = m;
      if (p > 0) anc[p] = anc[tree.parent[p]] | bit(seat[tree.parent[p]]);
      needMask[p] = m & anc[p];
      for (let s = 0; s < n; s++) nodeCommit[p * n + s] = info.bet[s] + (s === tree.bbSeat ? tree.cfg.ante : 0);
      const A = actStart[p + 1] - actStart[p];
      maxA = Math.max(maxA, A);
      for (let e = actStart[p]; e < actStart[p + 1]; e++) edgeNode[e] = p;
    }
    // Pre-order numbering: a subtree is the contiguous range [p, subtreeEnd[p]).
    for (let p = nodeCount - 1; p >= 0; p--) {
      let end = p + 1;
      for (let e = actStart[p]; e < actStart[p + 1]; e++) if (child[e] >= 0) end = Math.max(end, subtreeEnd[child[e]]);
      subtreeEnd[p] = end;
    }
  }
  const termLive = new Int32Array(termCount);
  for (let t = 0; t < termCount; t++) for (let k = 0; k < termNLive[t]; k++) termLive[t] |= bit(termSeats[t * 4 + k]);

  // ── terminal payoffs (§3.3–3.6) ──
  const huVec: (PairwiseVectors | null)[] = new Array<PairwiseVectors | null>(termCount).fill(null);
  const mwTerm: (MultiwayTerm | null)[] = new Array<MultiwayTerm | null>(termCount).fill(null);
  const mwNorm: MultiwayNorm[] = Array.from({ length: termCount }, () => ({ Z: 1, ubar: 0 }));
  const val = options.valuation;
  let mwModel: ModelB | null = null;
  if (val.kind === "modelB") mwModel = prepareModelB(val.params, val.features);
  else if (val.kind === "equity") {
    const ones = new Float64Array(N).fill(1);
    mwModel = prepareModelB(zeroModelB(val.kappa3 ?? ones, val.kappa4 ?? ones), new Float64Array(N * FEATURE_COUNT));
  }
  const sharedEquity = val.kind === "equity" ? equityVectors(N) : null;
  const hasMw = new Uint8Array(nodeCount);
  let mwCount = 0;
  for (let t = 0; t < termCount; t++) {
    if (termKind[t] !== TERM.FLOP) continue;
    const k = termNLive[t];
    const live = Array.from({ length: k }, (_, j) => termSeats[t * 4 + j]);
    const agg = tree.termAggressor[t];
    const spr = tree.termSpr[t];
    if (k === 2) {
      const [O, I] = live;
      if (val.kind === "modelB") {
        if (val.hu) huVec[t] = val.hu(tree, t);
        else {
          const potType = POT_TYPES[tree.termPotType[t]];
          huVec[t] = modelBVectors(mwModel!, { potType, aggressor: potType === "limp" ? null : agg === O ? "O" : agg === I ? "I" : null, spr });
        }
      } else if (val.kind === "equity") huVec[t] = sharedEquity;
      else {
        if (O !== tree.bbSeat && I !== tree.bbSeat) throw new Error(`one-sided valuation: terminal ${t} has no BB`);
        huVec[t] = oneSidedVectors(val.R, O === tree.bbSeat);
      }
    } else {
      if (!mwModel) throw new Error(`the ${val.kind} valuation has no multiway payoff (terminal ${t})`);
      const paid = live.map((s) => termCommit[t * n + s]);
      mwTerm[t] = modelBMultiway(mwModel, k, live.indexOf(agg), spr, termPot[t], paid);
      mwCount++;
      for (let p = tree.terms[t].parent; p >= 0; p = tree.parent[p]) hasMw[p] = 1;
    }
  }

  // ── state ──
  const regret = new Float64Array(edgeCount * N);
  const ssum = new Float64Array(edgeCount * N);
  const fpStrategy = mode === "fp" ? new Float64Array(edgeCount * N) : null;
  if (fpStrategy) {
    if (options.fpInit) {
      if (options.fpInit.length !== edgeCount * N) throw new Error("fpInit must be edgeCount·N");
      fpStrategy.set(options.fpInit);
    } else
      for (let p = 0; p < nodeCount; p++) {
        const A = actStart[p + 1] - actStart[p];
        fpStrategy.fill(1 / A, actStart[p] * N, actStart[p + 1] * N);
      }
  }
  let tCounter = 0;
  let totalIterations = 0;

  // ── scratch: per depth, so a node's buffers survive its children's walks ──
  const D = tree.maxDepth + 2;
  const vecs = (count: number) => Array.from({ length: D }, () => new Float64Array(count * N));
  const views = (bufs: Float64Array[], count: number) => bufs.map((b) => Array.from({ length: count }, (_, k) => b.subarray(k * N, (k + 1) * N)));
  const sigB = vecs(maxA);
  const crB = vecs(maxA), cmB = vecs(maxA), actB = vecs(maxA), brAB = vecs(maxA);
  const crV = views(crB, maxA), cmV = views(cmB, maxA), actV = views(actB, maxA), brAV = views(brAB, maxA);
  const invB = vecs(1);
  const outB = vecs(n), brB = vecs(n);
  const outRow = views(outB, n), brRow = views(brB, n);
  const ones = new Float64Array(N).fill(1);
  const reach: Float64Array[] = Array.from({ length: n }, () => ones);
  const mass: Float64Array[] = Array.from({ length: n }, () => ones);
  const mbar = new Float64Array(n);
  const sumBuf = new Float64Array(N), w = new Float64Array(N), rat = new Float64Array(N), vs = new Float64Array(N), bs = new Float64Array(N);
  const tmpMass = new Float64Array(N);
  const mwReach: Float64Array[] = [ones, ones, ones, ones];
  const mwOut: Float64Array[] = [ones, ones, ones, ones];
  const mwM = Array.from({ length: 4 }, () => new Float64Array(N));
  const mwA1 = Array.from({ length: 4 }, () => new Float64Array(N));
  let fpValues: Float64Array | null = null;
  let dPos = 0, dG = 0;

  const resetRoot = () => {
    for (let s = 0; s < n; s++) {
      reach[s] = ones;
      mass[s] = ones;
      mbar[s] = 1;
    }
  };

  /** Child reaches r_s·σ_a and masses K·(r_s·σ_a), fold mass by subtraction (§4.2 steps 2–3), and 1/m_s. */
  function childVectors(p: number, d: number, sig: Float64Array, sigOff: number) {
    const s = seat[p], A = actStart[p + 1] - actStart[p], f = foldIdx[p];
    const rs = reach[s], ms = mass[s], crs = crV[d], cms = cmV[d];
    for (let a = 0; a < A; a++) {
      const cr = crs[a], o = sigOff + a * N;
      for (let h = 0; h < N; h++) cr[h] = rs[h] * sig[o + h];
      if (a !== f) matVecK(km, cr, cms[a], sc);
    }
    if (f >= 0) {
      const cf = cms[f];
      for (let h = 0; h < N; h++) {
        let m = ms[h];
        for (let a = 0; a < A; a++) if (a !== f) m -= cms[a][h];
        cf[h] = m > 0 ? m : 0;
      }
    }
    const inv = invB[d];
    for (let h = 0; h < N; h++) inv[h] = ms[h] > MASS_EPS ? 1 / ms[h] : 0;
  }

  // ── terminals ──

  function allinPaid(t: number, s: number) {
    return termCommit[t * n + s] - (termRefundSeat[t] === s ? termRefund[t] : 0);
  }

  /** Values V_t for the seats in `req` that are live at terminal t, written to out[t] (normalized, §4.2). */
  function terminalValues(t: number, req: number, out: Float64Array[]) {
    const kind = termKind[t], o4 = t * 4;
    if (kind === TERM.WIN) {
      const win = termSeats[o4];
      if (req & bit(win)) out[win].fill(termPot[t] - termCommit[t * n + win]);
      return;
    }
    if (kind === TERM.ALLIN) {
      const a = termSeats[o4], b = termSeats[o4 + 1], P = termAllinPot[t];
      if (req & bit(a)) allinSide(km, reach[b], P, allinPaid(t, a), out[a], tmpMass, sc, true);
      if (req & bit(b)) allinSide(km, reach[a], P, allinPaid(t, b), out[b], tmpMass, sc, true);
      return;
    }
    const k = termNLive[t];
    if (k === 2) {
      const O = termSeats[o4], I = termSeats[o4 + 1], v = huVec[t]!;
      if (req & bit(O)) affineSideO(km, v, reach[I], termPot[t], termCommit[t * n + O], out[O], tmpMass, sc, true);
      if (req & bit(I)) affineSideI(km, v, reach[O], termPot[t], termCommit[t * n + I], out[I], tmpMass, sc, true);
      return;
    }
    for (let j = 0; j < k; j++) {
      const s = termSeats[o4 + j];
      mwReach[j] = reach[s];
      mwOut[j] = out[s];
    }
    multiwayKernel(km, mwTerm[t]!, mwReach, mwM, mwA1, mwNorm[t], mwOut, sc, true);
  }

  // ── the training walk (§4.2) ──

  function walkTrain(p: number, d: number): void {
    const s = seat[p], e0 = actStart[p], A = actStart[p + 1] - e0, base = e0 * N;
    const sig = sigB[d];
    // 1. Regret matching: σ_a = R⁺_a / Σ R⁺, uniform when no regret is positive.
    sumBuf.fill(0);
    for (let a = 0; a < A; a++) {
      const o = base + a * N;
      for (let h = 0; h < N; h++) {
        const r = regret[o + h];
        if (r > 0) sumBuf[h] += r;
      }
    }
    for (let a = 0; a < A; a++) {
      const o = base + a * N, so = a * N;
      for (let h = 0; h < N; h++) {
        const sum = sumBuf[h], r = regret[o + h];
        sig[so + h] = sum > 0 ? (r > 0 ? r / sum : 0) : 1 / A;
      }
    }
    childVectors(p, d, sig, 0);
    const rs = reach[s], ms = mass[s];
    const inv = invB[d], crs = crV[d], cms = cmV[d], acts = actV[d];
    const need = needMask[p], others = need & ~bit(s);
    const out = outRow[d], cOut = outRow[d + 1];
    for (let t = 0; t < n; t++) if (others & bit(t)) out[t].fill(0);
    const req = need | bit(s);
    for (let a = 0; a < A; a++) {
      reach[s] = crs[a];
      mass[s] = cms[a];
      const c = child[e0 + a];
      let cAct: number;
      if (c >= 0) {
        walkTrain(c, d + 1);
        cAct = nodeActive[c];
      } else {
        terminalValues(~c, req, cOut);
        cAct = termLive[~c];
      }
      if (cAct & bit(s)) acts[a].set(cOut[s]);
      else acts[a].fill(-nodeCommit[p * n + s]);
      if (others) {
        const cm = cms[a];
        for (let h = 0; h < N; h++) rat[h] = cm[h] * inv[h];
        for (let t = 0; t < n; t++) {
          if (!(others & bit(t))) continue;
          const o = out[t];
          if (cAct & bit(t)) {
            const cv = cOut[t];
            for (let h = 0; h < N; h++) o[h] += rat[h] * cv[h];
          } else {
            const k = -nodeCommit[p * n + t];
            for (let h = 0; h < N; h++) o[h] += rat[h] * k;
          }
        }
      }
    }
    reach[s] = rs;
    mass[s] = ms;
    // 5. The actor's value, 6. regret and strategy-sum update.
    vs.fill(0);
    for (let a = 0; a < A; a++) {
      const va = acts[a], so = a * N;
      for (let h = 0; h < N; h++) vs[h] += sig[so + h] * va[h];
    }
    w.fill(1);
    for (let t = 0; t < n; t++) {
      if (t === s) continue;
      const mt = mass[t];
      if (mt === ones) continue;
      for (let h = 0; h < N; h++) w[h] *= mt[h];
    }
    for (let a = 0; a < A; a++) {
      const va = acts[a], o = base + a * N, so = a * N;
      for (let h = 0; h < N; h++) {
        const r = regret[o + h];
        regret[o + h] = (r > 0 ? r * dPos : r * 0.5) + w[h] * (va[h] - vs[h]);
        ssum[o + h] = ssum[o + h] * dG + rs[h] * sig[so + h];
      }
    }
    if (need & bit(s)) out[s].set(vs);
  }

  // ── Z and ū from a profile (§3.6) ──

  /** S = null: σ̄ from the strategy sums, computed per visited node exactly as average() does, so the training run
   *  needs no σ̄ buffer of its own (edgeCount·N doubles, 15 MB at 100bb; §4.7's memory budget). */
  function normWalk(p: number, d: number, S: Float64Array | null): void {
    const s = seat[p], e0 = actStart[p], A = actStart[p + 1] - e0;
    const rs = reach[s], crs = crV[d];
    let src: Float64Array, off: number;
    if (S) {
      src = S;
      off = e0 * N;
    } else {
      // sigB[d] is free here: walkTrain recomputes its σ at every node before reading it.
      src = sigB[d];
      off = 0;
      const base = e0 * N;
      for (let h = 0; h < N; h++) {
        let sum = 0;
        for (let a = 0; a < A; a++) sum += ssum[base + a * N + h];
        for (let a = 0; a < A; a++) src[a * N + h] = sum > 0 ? ssum[base + a * N + h] / sum : 1 / A;
      }
    }
    for (let a = 0; a < A; a++) {
      const c = child[e0 + a];
      if (c >= 0 ? !hasMw[c] : !mwTerm[~c]) continue;
      const cr = crs[a], o = off + a * N;
      for (let h = 0; h < N; h++) cr[h] = rs[h] * src[o + h];
      reach[s] = cr;
      if (c >= 0) normWalk(c, d + 1, S);
      else {
        const t = ~c, term = mwTerm[t]!;
        for (let j = 0; j < term.k; j++) {
          mwReach[j] = reach[termSeats[t * 4 + j]];
          massAndEquity(km, mwReach[j], mwM[j], mwA1[j], sc);
        }
        multiwayNorm(term, mwReach, mwM, mwA1, cw, mwNorm[t]);
      }
      reach[s] = rs;
    }
  }

  /** Z and ū of every multiway terminal from profile S, or from σ̄ (the strategy sums) when S is null. */
  function refreshNorms(S: Float64Array | null) {
    if (!mwCount) return;
    resetRoot();
    normWalk(0, 0, S);
  }

  function average(out: Float64Array = new Float64Array(edgeCount * N)): Float64Array {
    if (fpStrategy) {
      out.set(fpStrategy);
      return out;
    }
    for (let p = 0; p < nodeCount; p++) {
      const e0 = actStart[p], A = actStart[p + 1] - e0, base = e0 * N;
      for (let h = 0; h < N; h++) {
        let sum = 0;
        for (let a = 0; a < A; a++) sum += ssum[base + a * N + h];
        for (let a = 0; a < A; a++) out[base + a * N + h] = sum > 0 ? ssum[base + a * N + h] / sum : 1 / A;
      }
    }
    return out;
  }

  // ── the evaluation walk: σ values, best responses and metrics under a fixed strategy (§4.5) ──

  let evBr = false;
  let evRec = false;
  let evAct: Float64Array | null = null;
  let evBrAct: Float64Array | null = null;
  let evLocal = new Float64Array(0), evReach = new Float64Array(0), evOcc = new Float64Array(0), evTermOcc = new Float64Array(0);
  let negCount = 0, negOcc = 0;
  let negList: NegativeShare[] = [];

  const occNow = () => {
    let o = 1;
    for (let t = 0; t < n; t++) o *= mbar[t];
    return o;
  };

  function recordNegatives(t: number, s: number, v: Float64Array, okMass: (h: number) => boolean, occ: number) {
    const r = reach[s], P = termPot[t], T = termCommit[t * n + s];
    let den = 0;
    for (let h = 0; h < N; h++) den += cw[h] * r[h];
    if (!(den > 0)) return;
    for (let h = 0; h < N; h++) {
      if (!(r[h] > 0) || !okMass(h)) continue;
      const share = (v[h] + T) / P;
      if (share >= 0) continue;
      const wgt = (occ * cw[h] * r[h]) / den;
      negCount++;
      negOcc += wgt;
      negList.push({ term: t, seat: s, hand: h, share, occ, reach: r[h] });
    }
  }

  function terminalEval(t: number, d: number) {
    const out = outRow[d], br = brRow[d];
    const live = termLive[t];
    terminalValues(t, live, out);
    for (let s = 0; s < n; s++) if (live & bit(s)) br[s].set(out[s]);
    if (!evRec) return;
    const occ = occNow();
    evTermOcc[t] = occ;
    if (termKind[t] !== TERM.FLOP) return;
    const k = termNLive[t], o4 = t * 4;
    if (k === 2) {
      // The kernels' own masses: recompute them per side (a K·r product each, metrics only).
      for (let j = 0; j < 2; j++) {
        const s = termSeats[o4 + j], opp = termSeats[o4 + 1 - j];
        matVecK(km, reach[opp], tmpMass, sc);
        recordNegatives(t, s, out[s], (h) => tmpMass[h] > MASS_EPS, occ);
      }
    } else {
      // multiwayKernel left M of every live seat in mwM (postflop order).
      for (let j = 0; j < k; j++) {
        recordNegatives(t, termSeats[o4 + j], out[termSeats[o4 + j]], (h) => {
          for (let o = 0; o < k; o++) if (o !== j && !(mwM[o][h] > MASS_EPS)) return false;
          return true;
        }, occ);
      }
    }
  }

  function walkEval(p: number, d: number, S: Float64Array): void {
    const s = seat[p], e0 = actStart[p], A = actStart[p + 1] - e0, base = e0 * N;
    if (evRec) evOcc[p] = occNow();
    childVectors(p, d, S, base);
    const rs = reach[s], ms = mass[s], mbs = mbar[s];
    const inv = invB[d], crs = crV[d], cms = cmV[d], acts = actV[d], brs = brAV[d];
    const act = nodeActive[p], others = act & ~bit(s);
    const out = outRow[d], br = brRow[d], cOut = outRow[d + 1], cBr = brRow[d + 1];
    for (let t = 0; t < n; t++) {
      if (!(others & bit(t))) continue;
      out[t].fill(0);
      if (evBr) br[t].fill(0);
    }
    for (let a = 0; a < A; a++) {
      const cr = crs[a];
      reach[s] = cr;
      mass[s] = cms[a];
      if (evRec) {
        let m = 0;
        for (let h = 0; h < N; h++) m += cw[h] * cr[h];
        mbar[s] = m / cwSum;
      }
      const c = child[e0 + a];
      let cAct: number;
      if (c >= 0) {
        walkEval(c, d + 1, S);
        cAct = nodeActive[c];
      } else {
        terminalEval(~c, d + 1);
        cAct = termLive[~c];
      }
      if (cAct & bit(s)) {
        acts[a].set(cOut[s]);
        if (evBr) brs[a].set(cBr[s]);
      } else {
        acts[a].fill(-nodeCommit[p * n + s]);
        if (evBr) brs[a].fill(-nodeCommit[p * n + s]);
      }
      if (others) {
        const cm = cms[a];
        for (let h = 0; h < N; h++) rat[h] = cm[h] * inv[h];
        for (let t = 0; t < n; t++) {
          if (!(others & bit(t))) continue;
          const o = out[t], b = br[t];
          if (cAct & bit(t)) {
            const cv = cOut[t], cb = cBr[t];
            for (let h = 0; h < N; h++) o[h] += rat[h] * cv[h];
            if (evBr) for (let h = 0; h < N; h++) b[h] += rat[h] * cb[h];
          } else {
            const k = -nodeCommit[p * n + t];
            for (let h = 0; h < N; h++) o[h] += rat[h] * k;
            if (evBr) for (let h = 0; h < N; h++) b[h] += rat[h] * k;
          }
        }
      }
    }
    reach[s] = rs;
    mass[s] = ms;
    mbar[s] = mbs;
    vs.fill(0);
    for (let a = 0; a < A; a++) {
      const va = acts[a], o = base + a * N;
      for (let h = 0; h < N; h++) vs[h] += S[o + h] * va[h];
    }
    out[s].set(vs);
    if (evBr) {
      bs.set(brs[0]);
      for (let a = 1; a < A; a++) {
        const ba = brs[a];
        for (let h = 0; h < N; h++) if (ba[h] > bs[h]) bs[h] = ba[h];
      }
      br[s].set(bs);
    }
    if (evAct) for (let a = 0; a < A; a++) evAct.set(acts[a], base + a * N);
    if (evBrAct) for (let a = 0; a < A; a++) evBrAct.set(brs[a], base + a * N);
    if (evRec) {
      let num = 0, den = 0;
      for (let h = 0; h < N; h++) {
        const wt = cw[h] * rs[h];
        if (!(wt > 0)) continue;
        let mx = acts[0][h];
        for (let a = 1; a < A; a++) if (acts[a][h] > mx) mx = acts[a][h];
        num += wt * (mx - vs[h]);
        den += wt;
      }
      evLocal[p] = den > 0 ? num / den : 0;
      evReach[p] = den / cwSum;
    }
  }

  function evaluate(strategy: Float64Array, opts: { actionValues?: boolean; brActionValues?: boolean } = {}): Evaluation {
    if (strategy.length !== edgeCount * N) throw new Error("strategy must be edgeCount·N");
    // Metrics use the evaluated profile's own multiway normalization; the training run keeps its frozen one.
    const saved = mwNorm.map((x) => ({ Z: x.Z, ubar: x.ubar }));
    refreshNorms(strategy);
    evBr = true;
    evRec = true;
    evAct = opts.actionValues ? new Float64Array(edgeCount * N) : null;
    evBrAct = opts.brActionValues ? new Float64Array(edgeCount * N) : null;
    evLocal = new Float64Array(nodeCount);
    evReach = new Float64Array(nodeCount);
    evOcc = new Float64Array(nodeCount);
    evTermOcc = new Float64Array(termCount);
    negCount = 0;
    negOcc = 0;
    negList = [];
    resetRoot();
    walkEval(0, 0, strategy);
    const ev: number[] = [], brEv: number[] = [];
    for (let t = 0; t < n; t++) {
      let a = 0, b = 0;
      const v = outRow[0][t], bv = brRow[0][t];
      for (let h = 0; h < N; h++) {
        a += cw[h] * v[h];
        b += cw[h] * bv[h];
      }
      ev.push(a / cwSum);
      brEv.push(b / cwSum);
    }
    const gainMbb = ev.map((e, t) => (brEv[t] - e) * 1000);
    let fz = 0, fzR = 0, fzC = 0;
    for (let t = 0; t < termCount; t++) {
      if (!tree.termFrozen[t]) continue;
      fz += evTermOcc[t];
      if (tree.termFrozenRaisers[t]) fzR += evTermOcc[t];
      else fzC += evTermOcc[t];
    }
    const wOf = (x: NegativeShare) => x.occ * x.reach;
    negList.sort((x, y) => wOf(y) - wOf(x) || x.term - y.term || x.seat - y.seat || x.hand - y.hand);
    for (let i = 0; i < mwNorm.length; i++) {
      mwNorm[i].Z = saved[i].Z;
      mwNorm[i].ubar = saved[i].ubar;
    }
    const result: Evaluation = {
      ev,
      brEv,
      gainMbb,
      maxGainMbb: Math.max(...gainMbb),
      nashConvMbb: gainMbb.reduce((x, y) => x + y, 0),
      evSum: ev.reduce((x, y) => x + y, 0),
      localRegret: evLocal,
      reach: evReach,
      occ: evOcc,
      termOcc: evTermOcc,
      frozen: { occ: fz, raiserOcc: fzR, callerOcc: fzC },
      negativeShares: { count: negCount, occ: negOcc, worst: negList.slice(0, 25) },
      actionValues: evAct,
      brActionValues: evBrAct,
    };
    evAct = null;
    evBrAct = null;
    negList = [];
    return result;
  }

  // ── iterations ──

  function setDiscount(t: number) {
    const ts = t * Math.sqrt(t);
    dPos = ts / (ts + 1);
    const q = t / (t + 1);
    dG = q * q;
  }

  function refreshFromAverage() {
    refreshNorms(null);
  }

  function dcfrOnce() {
    const t = ++tCounter;
    if ((t - 1) % normEvery === 0) refreshFromAverage();
    setDiscount(t);
    resetRoot();
    walkTrain(0, 0);
    totalIterations++;
  }

  /** One FP step (§4.8): best responses to the current average by the reference's tie rules, then σ̄ += (BR − σ̄)/(t + 2). */
  function fpOnce() {
    const S = fpStrategy!;
    const t = tCounter;
    if (t % normEvery === 0) refreshNorms(S);
    evBr = false;
    evRec = false;
    fpValues ??= new Float64Array(edgeCount * N);
    evAct = fpValues;
    resetRoot();
    walkEval(0, 0, S);
    evAct = null;
    const V = fpValues;
    const step = 1 / (t + 2);
    for (let p = 0; p < nodeCount; p++) {
      const e0 = actStart[p], A = actStart[p + 1] - e0, f = foldIdx[p], base = e0 * N;
      for (let h = 0; h < N; h++) {
        let best = -1, bestV = -Infinity, bestPri = 99;
        for (let a = 0; a < A; a++) {
          if (a === f) continue;
          const v = V[base + a * N + h], pri = FP_PRIORITY[tree.actKey[e0 + a]];
          if (v > bestV || (v === bestV && pri < bestPri)) {
            best = a;
            bestV = v;
            bestPri = pri;
          }
        }
        // Fold unless something gains strictly over it (the reference's `gain > 0`).
        if (f >= 0 && !(bestV - V[base + f * N + h] > 0)) best = f;
        for (let a = 0; a < A; a++) {
          const i = base + a * N + h;
          S[i] += ((a === best ? 1 : 0) - S[i]) * step;
        }
      }
    }
    tCounter++;
    totalIterations++;
  }

  function iterate(count = 1) {
    for (let k = 0; k < count; k++) {
      if (mode === "fp") fpOnce();
      else dcfrOnce();
    }
  }

  /** Frozen reaches and masses at node r under strategy S, exactly as the walks compute them along the path. */
  function frozenVectorsAt(r: number, S: Float64Array): { reach: Float64Array[]; mass: Float64Array[] } {
    const path: number[] = [];
    for (let x = r; x > 0; x = tree.parent[x]) path.push(tree.parentEdge[x]);
    path.reverse();
    const fr = Array.from({ length: n }, () => new Float64Array(N).fill(1));
    const fm = Array.from({ length: n }, () => new Float64Array(N).fill(1));
    const tmp = new Float64Array(N);
    for (const e of path) {
      const p = edgeNode[e], s = seat[p], e0 = actStart[p], A = actStart[p + 1] - e0, f = foldIdx[p], a = e - e0;
      const nr = new Float64Array(N);
      for (let h = 0; h < N; h++) nr[h] = fr[s][h] * S[e * N + h];
      const nm = new Float64Array(N);
      if (a !== f) matVecK(km, nr, nm, sc);
      else {
        nm.set(fm[s]);
        for (let b = 0; b < A; b++) {
          if (b === f) continue;
          for (let h = 0; h < N; h++) tmp[h] = fr[s][h] * S[(e0 + b) * N + h];
          const mb = new Float64Array(N);
          matVecK(km, tmp, mb, sc);
          for (let h = 0; h < N; h++) nm[h] -= mb[h];
        }
        for (let h = 0; h < N; h++) if (!(nm[h] > 0)) nm[h] = 0;
      }
      fr[s] = nr;
      fm[s] = nm;
    }
    return { reach: fr, mass: fm };
  }

  /**
   * §4.6 polish pass: σ̄ stays frozen outside the given nodes' subtrees; inside each, the regrets are kept, the
   * strategy sums are reset and the discount counter restarts at 1, and `iterations` DCFR iterations re-solve the
   * subtree for the frozen incoming reaches (the regret weight at its root stays at its frozen value).
   */
  function polish(nodes: readonly number[], iterations: number) {
    if (mode !== "dcfr") throw new Error("polish is a DCFR pass");
    const roots = [...new Set(nodes)].sort((a, b) => a - b).filter((r, i, arr) => !arr.slice(0, i).some((q) => r > q && r < subtreeEnd[q]));
    const S = average();
    for (const r of roots) {
      const frozen = frozenVectorsAt(r, S);
      ssum.fill(0, actStart[r] * N, actStart[subtreeEnd[r]] * N);
      for (let tp = 1; tp <= iterations; tp++) {
        if ((tp - 1) % normEvery === 0) refreshFromAverage();
        setDiscount(tp);
        for (let s = 0; s < n; s++) {
          reach[s] = frozen.reach[s];
          mass[s] = frozen.mass[s];
        }
        walkTrain(r, tree.depth[r]);
      }
    }
    resetRoot();
  }

  function restart() {
    ssum.fill(0);
    tCounter = 0;
  }

  return {
    tree,
    N,
    km,
    cw,
    cwSum,
    regret,
    ssum,
    fpStrategy,
    get t() {
      return tCounter;
    },
    get iterations() {
      return totalIterations;
    },
    iterate,
    average,
    evaluate,
    polish,
    restart,
  };
}

// ───────────── PF-TWOSTART (§5.4) ─────────────

/**
 * PF-TWOSTART's second start, steps 1–3: at every node with a fold, fold regret +1 and every other regret 0;
 * `warmup` DCFR iterations from t = 1; then every strategy sum to 0 and the discount counter back to the start,
 * keeping the regrets. The caller then runs the normal schedule (step 4).
 */
export function twoStartInit(solver: PreflopSolver, warmup = 50): void {
  const { tree, N, regret } = solver;
  regret.fill(0);
  solver.restart();
  for (let p = 0; p < tree.nodeCount; p++) {
    const f = tree.foldIdx[p];
    if (f >= 0) regret.fill(1, (tree.actStart[p] + f) * N, (tree.actStart[p] + f + 1) * N);
  }
  solver.iterate(warmup);
  solver.restart();
}

// ───────────── export helpers (§4.4, §6.5) ─────────────

/** ρ(h) at node p: the product of the actor's own earlier action probabilities along the line (§4.4). */
export function ownReach(tree: PreflopTree, strategy: Float64Array, p: number, N: number, out = new Float64Array(N)): Float64Array {
  out.fill(1);
  const s = tree.seat[p];
  for (let x = p; x > 0; x = tree.parent[x]) {
    const q = tree.parent[x];
    if (tree.seat[q] !== s) continue;
    const o = tree.parentEdge[x] * N;
    for (let h = 0; h < N; h++) out[h] *= strategy[o + h];
  }
  return out;
}

/** Per action of node p, Σ cw·ρ·σ_a / Σ cw·ρ: the action's share of the reaching range (ρ = 1 when omitted). */
export function actionShares(tree: PreflopTree, strategy: Float64Array, p: number, cw: Float64Array, rho?: Float64Array): number[] {
  const N = cw.length, e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
  let den = 0;
  const num = new Array<number>(A).fill(0);
  for (let h = 0; h < N; h++) {
    const wt = cw[h] * (rho ? rho[h] : 1);
    den += wt;
    for (let a = 0; a < A; a++) num[a] += wt * strategy[(e0 + a) * N + h];
  }
  return num.map((x) => (den > 0 ? x / den : 0));
}

/**
 * §6.5: floor each probability to tenths, then hand out the remaining tenths by largest remainder; ties go to the
 * earlier action in display order, the fold last. `probs` is in display order, foldIdx the fold's index or −1.
 */
export function snapTenths(probs: ArrayLike<number>, foldIdx: number, out: number[] = []): number[] {
  const A = probs.length;
  const tenths: number[] = [], rem: number[] = [];
  let used = 0;
  for (let a = 0; a < A; a++) {
    const x = Math.max(0, probs[a]) * 10;
    const f = Math.min(10, Math.floor(x + 1e-9));
    tenths.push(f);
    rem.push(x - f);
    used += f;
  }
  const order = Array.from({ length: A }, (_, a) => a).sort((a, b) => rem[b] - rem[a] || (a === foldIdx ? 1 : 0) - (b === foldIdx ? 1 : 0) || a - b);
  for (let k = 0; used < 10 && k < A; k++, used++) tenths[order[k]]++;
  for (let a = 0; a < A; a++) out[a] = tenths[a] / 10;
  out.length = A;
  return out;
}

/**
 * `strategy` with the nodes in `nodes` snapped to the 0.1 grid (§6.5); every other node unchanged. Written to a copy,
 * or to `out` (which may be `strategy` itself: each (node, hand) is read in full before it is written).
 */
export function snapStrategy(tree: PreflopTree, strategy: Float64Array, nodes: Iterable<number>, N: number, out?: Float64Array): Float64Array {
  if (!out) out = Float64Array.from(strategy);
  else if (out !== strategy) out.set(strategy);
  const probs: number[] = [], snapped: number[] = [];
  for (const p of nodes) {
    const e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
    for (let h = 0; h < N; h++) {
      probs.length = A;
      for (let a = 0; a < A; a++) probs[a] = strategy[(e0 + a) * N + h];
      snapTenths(probs, tree.foldIdx[p], snapped);
      for (let a = 0; a < A; a++) out[(e0 + a) * N + h] = snapped[a];
    }
  }
  return out;
}

/** §6.4's export filter: every first-in node (UTG–SB, unopened, no limp), and every node whose line occurs in at
 *  least `occThreshold` of dealt hands (0.1% by default). */
export function defaultExported(tree: PreflopTree, ev: Evaluation, p: number, occThreshold = 0.001): boolean {
  const info = tree.nodes[p];
  if (info.raises === 0 && !info.limped && info.seat !== tree.bbSeat) return true;
  return ev.occ[p] >= occThreshold;
}

// ───────────── gates and schedule (§4.6, §5.3) ─────────────

export interface GateThresholds {
  /** Max per-seat best-response gain, mbb/hand. */
  maxGainMbb: number;
  nashConvMbb: number;
  /** Reach-weighted local regret at every exported node, bb. */
  localRegret: number;
  /** Per-seat gain against the snapped profile, mbb/hand (and the level above which it only warns). */
  snappedGainMbb: number;
  snappedWarnMbb: number;
}

export const DEFAULT_GATES: GateThresholds = { maxGainMbb: 1.0, nashConvMbb: 5, localRegret: 0.05, snappedGainMbb: 3, snappedWarnMbb: 2 };

export interface GateReport {
  iterations: number;
  pass: boolean;
  /** Which gates failed: "maxGain", "nashConv", "localRegret", "snapped". */
  failures: string[];
  warnings: string[];
  maxGainMbb: number;
  nashConvMbb: number;
  snappedMaxGainMbb: number;
  /** Exported nodes above the local-regret gate, worst first. */
  regretFailures: { node: number; regret: number; occ: number }[];
  worstExportedRegret: number;
  exportedCount: number;
  evaluation: Evaluation;
  snapped: Evaluation;
  seconds: number;
}

export interface GateOptions {
  gates?: Partial<GateThresholds>;
  /** Which nodes are exported (default: defaultExported with occ ≥ 0.1%). */
  exported?: (p: number, ev: Evaluation) => boolean;
}

/** Evaluates σ̄ and the snapped profile against the §5.3 gates. */
export function checkGates(solver: PreflopSolver, options: GateOptions = {}): GateReport {
  const t0 = Date.now();
  const g = { ...DEFAULT_GATES, ...options.gates };
  const { tree, N } = solver;
  const avg = solver.average();
  const ev = solver.evaluate(avg);
  const isExported = options.exported ?? ((p: number, e: Evaluation) => defaultExported(tree, e, p));
  const exported: number[] = [];
  for (let p = 0; p < tree.nodeCount; p++) if (isExported(p, ev)) exported.push(p);
  const regretFailures = exported
    .filter((p) => ev.localRegret[p] > g.localRegret)
    .map((p) => ({ node: p, regret: ev.localRegret[p], occ: ev.occ[p] }))
    .sort((a, b) => b.regret - a.regret);
  let worst = 0;
  for (const p of exported) worst = Math.max(worst, ev.localRegret[p]);
  // σ̄ is not needed after this, so it is snapped in place rather than copied (15 MB at 100bb, §4.7).
  const snapped = solver.evaluate(snapStrategy(tree, avg, exported, N, avg));
  const failures: string[] = [], warnings: string[] = [];
  if (!(ev.maxGainMbb <= g.maxGainMbb)) failures.push("maxGain");
  if (!(ev.nashConvMbb <= g.nashConvMbb)) failures.push("nashConv");
  if (regretFailures.length) failures.push("localRegret");
  if (!(snapped.maxGainMbb <= g.snappedGainMbb)) failures.push("snapped");
  else if (snapped.maxGainMbb > g.snappedWarnMbb) warnings.push(`snapped gain ${snapped.maxGainMbb.toFixed(2)} mbb/hand is above ${g.snappedWarnMbb}`);
  return {
    iterations: solver.t,
    pass: failures.length === 0,
    failures,
    warnings,
    maxGainMbb: ev.maxGainMbb,
    nashConvMbb: ev.nashConvMbb,
    snappedMaxGainMbb: snapped.maxGainMbb,
    regretFailures,
    worstExportedRegret: worst,
    exportedCount: exported.length,
    evaluation: ev,
    snapped,
    seconds: (Date.now() - t0) / 1000,
  };
}

export interface ScheduleOptions extends GateOptions {
  /** First evaluation (default 1,500), extension step (250), last iteration (4,000), polish iterations (300). */
  start?: number;
  step?: number;
  max?: number;
  polishIterations?: number;
  /** PF-TWOSTART (§5.4): start from twoStartInit with this many warm-up iterations instead of the plain start. */
  twoStart?: number;
  /** Called after every gate check (progress logs). */
  onCheck?: (report: GateReport) => void;
}

export interface ScheduleResult {
  pass: boolean;
  iterations: number;
  polished: boolean;
  /** The final check. */
  report: GateReport;
  /** Every check, in order (the final one included). */
  history: GateReport[];
}

/**
 * §4.6: run to `start` iterations and check the gates; while one fails, run `step` more, up to `max`. The verdict
 * is the check at the end, never an earlier good reading. If at `max` only the local-regret gate fails, polish the
 * failing exported nodes' subtrees and check again.
 */
export function runSchedule(solver: PreflopSolver, options: ScheduleOptions = {}): ScheduleResult {
  const start = options.start ?? 1500, step = options.step ?? 250, max = options.max ?? 4000;
  const history: GateReport[] = [];
  const check = () => {
    const r = checkGates(solver, options);
    history.push(r);
    options.onCheck?.(r);
    return r;
  };
  if (options.twoStart !== undefined) twoStartInit(solver, options.twoStart);
  if (solver.t < start) solver.iterate(start - solver.t);
  let report = check();
  while (!report.pass && solver.t < max) {
    solver.iterate(Math.min(step, max - solver.t));
    report = check();
  }
  let polished = false;
  if (!report.pass && report.failures.length === 1 && report.failures[0] === "localRegret") {
    solver.polish(
      report.regretFailures.map((x) => x.node),
      options.polishIterations ?? 300,
    );
    polished = true;
    report = check();
  }
  return { pass: report.pass, iterations: solver.t, polished, report, history };
}
