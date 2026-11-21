import { getSet, reachOf, type Scenario } from "../data/charts";
import { quizCloseActions } from "../data/sets/preflop";
import { solverSpot } from "../data/sets/solverSpot";
import { ALL_HANDS, comboCount, RANKS, type HandClass } from "../poker/cards";
import { CHART_POS, seatId } from "./chartSeat";
import { COMBOS } from "./handInfo";
import type { ChartPick } from "./computedChart";
import type { MoveOption, PreflopDecision } from "./policy";
import { badgeOf, isGto, type SeatProfile, type Step2, type Sticky } from "./profile";

/**
 * How an AI seat's profile (profile.ts) moves its play away from our computed charts. A tendency model built on the
 * charts, not measured pub data: the UI calls it "성향 조절 (근사 모델)".
 *
 * Preflop (adjustPreflop): one decision's chart strategy (or its fallback rules) is changed class by class in three
 * steps, each moving combo-weighted mass (the seat's own range at this decision) until a target is met; the last class
 * moved takes a partial amount.
 *  - loose: the share of the range that continues times LOOSE_MULT, widening by at most (LOOSE_MULT − 1) of the folding
 *    share so a wide range doesn't saturate (only where folding is an option). Widening walks
 *    the classes by k (below) from the top and turns folds into the class's own continue split, or into a call facing
 *    a raise, else into the spot's main raise (never an open-limp); tightening walks from the bottom.
 *  - aggro: the raise share of what continues times AGGRO_MULT (only where the spot has both a call or free check and a
 *    raise, so first-in from UTG to the BTN and every facing-all-in spot are left alone). More aggressive: classes
 *    already mixing a raise go first, then the strongest callers; more passive: the weakest raisers call instead.
 *  - sticky: STICKY_ADD of the folding mass calls instead (only facing a raise, a jam included, where calling is on the
 *    tree).
 * Order key k(h) = (1 − fold) + 0.5·closeIn − 0.5·closeOut + 0.01·stageOrder: a close-call cell (EV within the stage's
 * ε of the other action) moves first, because that deviation costs almost nothing. A class the chart never brings here
 * (reach 0) starts as a fold for any non-GTO profile.
 *
 * Postflop (adjustPostflop): the bet share of an unbet pot times BET_MULT (BLUFF_MULT for air and draws), capped at
 * 95% or at the base share when that is higher; the raise share facing a bet times RAISE_MULT, then folds turn into
 * calls by STICKY_CALL + LOOSE_CALL.
 * Pure.
 */

export const LOOSE_MULT: Record<Step2, number> = { [-2]: 0.6, [-1]: 0.8, 0: 1, 1: 1.25, 2: 1.6 };
export const AGGRO_MULT: Record<Step2, number> = { [-2]: 0.4, [-1]: 0.7, 0: 1, 1: 1.4, 2: 2 };
export const STICKY_ADD: Record<Sticky, number> = { 0: 0, 1: 0.15, 2: 0.3 };

export const BET_MULT: Record<Step2, number> = { [-2]: 0.55, [-1]: 0.75, 0: 1, 1: 1.25, 2: 1.5 };
export const BLUFF_MULT: Record<Step2, number> = { [-2]: 0.3, [-1]: 0.6, 0: 1, 1: 1.5, 2: 2.2 };
export const RAISE_MULT: Record<Step2, number> = { [-2]: 0.3, [-1]: 0.6, 0: 1, 1: 1.6, 2: 2.4 };
export const LOOSE_CALL: Record<Step2, number> = { [-2]: -0.3, [-1]: -0.15, 0: 0, 1: 0.1, 2: 0.2 };
export const STICKY_CALL: Record<Sticky, number> = { 0: 0, 1: 0.3, 2: 0.55 };

const EPS = 1e-9;
const N = ALL_HANDS.length;
export const CLASS_INDEX: ReadonlyMap<HandClass, number> = new Map(ALL_HANDS.map((h, i) => [h, i]));
const COMBO_CLASS_IDX = Int16Array.from(COMBOS, (c) => CLASS_INDEX.get(c.hand)!);

// ───────────── stage order ─────────────

/** A static strength for the last ties of stageOrder: pairs, then high cards, suited a little higher. */
function staticScore(h: HandClass): number {
  const a = RANKS.indexOf(h[0]), b = RANKS.indexOf(h[1]);
  if (h.length === 2) return 1000 + a;
  return a * 20 + b + (h[2] === "s" ? 5 : 0);
}

const OPEN_KEYS_SKIP = new Set(["limp", "call", "overcall", "check"]);
const openSum = (scs: (Scenario | null | undefined)[], h: HandClass) =>
  scs.reduce((x, sc) => {
    if (!sc) return x;
    const st = sc.strategy[h];
    return x + sc.actions.filter((a) => !OPEN_KEYS_SKIP.has(a.key)).reduce((y, a) => y + (st?.[a.key] ?? 0), 0);
  }, 0);

let nashTie: Float64Array | null = null;
/** The 10bb push/fold chart's push frequency over the eight first-in seats: the first tie-break of every stage order. */
function nashPushSum(): Float64Array {
  if (nashTie) return nashTie;
  const st = getSet("nash").stages.find((s) => s.id === "10bb") ?? getSet("nash").stages[0];
  const pushes = st.scenarios.filter((s) => s.id.includes("/push-"));
  const out = new Float64Array(N);
  ALL_HANDS.forEach((h, i) => (out[i] = openSum(pushes, h)));
  return (nashTie = out);
}

const orderCache = new Map<string, Float64Array>();

/** Rank 0..168 of each class by (open sum, nash push sum, static score), as a share in [0, 1). */
function rankOf(primary: Float64Array): Float64Array {
  const tie = nashPushSum();
  const idx = ALL_HANDS.map((_, i) => i);
  idx.sort((x, y) => primary[x] - primary[y] || tie[x] - tie[y] || staticScore(ALL_HANDS[x]) - staticScore(ALL_HANDS[y]));
  const out = new Float64Array(N);
  idx.forEach((c, r) => (out[c] = r / N));
  return out;
}

/** The first-in spots of a chart, read through `read(spotId)`. */
type SpotReader = (spotId: string) => Scenario | null;

/**
 * How openable each class is in one stage of our charts (ALL_HANDS order, in [0, 1)): the sum over the stage's
 * first-in spots of the class's open frequency (any raise or shove, not a limp); for push/fold the push frequency;
 * ties broken by the 10bb push/fold chart, then by plain card strength. Computed once per stage. `key` "cash" is the
 * 6-max cash chart.
 */
export function stageOrder(pick: ChartPick | "cash", read?: SpotReader): Float64Array {
  const key = pick === "cash" ? "cash" : `${pick.source}/${pick.stageId}`;
  const had = orderCache.get(key);
  if (had) return had;
  let scs: (Scenario | null)[];
  if (pick === "cash") scs = getSet("cash6").stages[0].scenarios.filter((s) => s.kind === "rfi");
  else {
    const seats = CHART_POS.slice(0, 8);
    const spotIds = seats.map((s) => (pick.source === "nash" ? `push-${seatId(s)}` : `rfi-${seatId(s)}`));
    const reader: SpotReader =
      read ??
      ((id) => {
        if (pick.source === "solver") return solverSpot(pick.stageId, id)?.scenario ?? null;
        const st = getSet(pick.source).stages.find((s) => s.id === pick.stageId);
        return st?.scenarios.find((s) => s.id === `${pick.source}/${pick.stageId}/${id}`) ?? null;
      });
    scs = spotIds.map(reader);
  }
  const prim = new Float64Array(N);
  ALL_HANDS.forEach((h, i) => (prim[i] = openSum(scs, h)));
  const out = rankOf(prim);
  orderCache.set(key, out);
  return out;
}

// ───────────── preflop ─────────────

export interface PreflopAdjustCtx {
  /** The seat's current mass per class (ALL_HANDS order): its range at this decision, summed over each class's combos. */
  w: ArrayLike<number>;
  /** The chart scenario behind the decision (close calls, reach); none for the fallback rules. */
  scenario?: Scenario;
  /** The seat faces a raise (an all-in included). */
  facingRaise: boolean;
  /** The seat's whole stack as a street total. */
  allInTo: number;
  /** stageOrder of the chart of these stacks. */
  order: ArrayLike<number>;
}

interface Cell {
  f: number;
  c: number;
  /** Per raise option (`tos`). */
  r: number[];
}

const sumR = (x: Cell) => x.r.reduce((a, b) => a + b, 0);
const keyOf = (to: number) => Math.round(to * 1e6) / 1e6;

/**
 * The decision as a seat with profile `prof` plays it. GTO or no profile: `base` itself. Every class is computed once
 * here; `moves(h)` returns the cached list.
 */
export function adjustPreflop(base: PreflopDecision, prof: SeatProfile | null | undefined, ctx: PreflopAdjustCtx): PreflopDecision {
  if (isGto(prof)) return base;
  const p = prof!;
  const sc = ctx.scenario;
  const baseMoves = ALL_HANDS.map((h) => base.moves(h));

  // The spot's options: its raise sizes, its passive action (call or free check), whether folding is one.
  const tos: number[] = [];
  let hasCheck = !!sc?.noFold, hasCall = false;
  for (const ms of baseMoves)
    for (const m of ms) {
      if (m.kind === "raise" && m.to !== undefined && !tos.some((t) => keyOf(t) === keyOf(m.to!))) tos.push(m.to);
      if (m.kind === "check") hasCheck = true;
      if (m.kind === "call") hasCall = true;
    }
  if (sc) for (const a of sc.actions) if (a.key === "call" || a.key === "overcall" || a.key === "limp") hasCall = true;
  const cKind: "call" | "check" | null = hasCheck ? "check" : hasCall ? "call" : null;
  const canFold = cKind !== "check" && !sc?.noFold;

  const comboW = ALL_HANDS.map(comboCount);
  let wTotal = 0;
  for (let i = 0; i < N; i++) wTotal += Math.max(0, ctx.w[i] ?? 0);
  const w = (i: number) => (wTotal > EPS ? Math.max(0, ctx.w[i] ?? 0) : comboW[i]);

  const baseCells: Cell[] = baseMoves.map((ms) => {
    const cell: Cell = { f: 0, c: 0, r: tos.map(() => 0) };
    for (const m of ms) {
      if (m.kind === "fold") cell.f += m.prob;
      else if (m.kind === "call" || m.kind === "check") cell.c += m.prob;
      else cell.r[tos.findIndex((t) => keyOf(t) === keyOf(m.to ?? ctx.allInTo))] += m.prob;
    }
    return cell;
  });
  // The main raise: the non-all-in size carrying the most mass, else the all-in.
  let mainIdx = -1;
  {
    let best = -1;
    tos.forEach((t, j) => {
      const allIn = t >= ctx.allInTo - EPS;
      let m = 0;
      for (let i = 0; i < N; i++) m += (wTotal > EPS ? w(i) : comboW[i]) * baseCells[i].r[j] + comboW[i] * baseCells[i].r[j] * 1e-9;
      const score = (allIn ? 0 : 1e6) + m;
      if (score > best) [best, mainIdx] = [score, j];
    });
  }

  const cells: Cell[] = baseCells.map((x, i) => {
    // (A spot with no fold is a free check: a class it never brings here starts as a check.)
    if (sc && reachOf(sc, ALL_HANDS[i]) <= 0) return { f: canFold ? 1 : 0, c: canFold ? 0 : 1, r: tos.map(() => 0) };
    return { f: x.f, c: x.c, r: x.r.slice() };
  });
  const closeIn = new Uint8Array(N), closeOut = new Uint8Array(N);
  if (sc?.close)
    ALL_HANDS.forEach((h, i) => {
      const keys = quizCloseActions(sc, h);
      if (!keys) return;
      if (cells[i].f >= 1 - EPS && keys.some((k) => k !== "fold")) closeIn[i] = 1;
      if (cells[i].f <= EPS && keys.includes("fold")) closeOut[i] = 1;
    });
  const k = (i: number) => 1 - cells[i].f + 0.5 * closeIn[i] - 0.5 * closeOut[i] + 0.01 * (ctx.order[i] ?? 0);
  const byK = (desc: boolean) => {
    const keys = ALL_HANDS.map((_, i) => k(i));
    const idx = ALL_HANDS.map((_, i) => i);
    idx.sort((a, b) => (desc ? keys[b] - keys[a] : keys[a] - keys[b]));
    return idx;
  };
  const W = (pick: (x: Cell) => number) => {
    let s = 0;
    for (let i = 0; i < N; i++) s += w(i) * pick(cells[i]);
    return s;
  };
  /** Walk `list`, taking from each class up to `avail` of its mass until `need` (in mass) is met; zero-mass classes move fully. */
  const walk = (list: number[], need: number, avail: (x: Cell) => number, move: (x: Cell, amt: number) => void) => {
    for (const i of list) {
      if (need <= EPS) break;
      const a = avail(cells[i]);
      if (a <= EPS) continue;
      const wi = w(i);
      const amt = wi > EPS ? Math.min(a, need / wi) : a;
      if (wi > EPS) need -= amt * wi;
      move(cells[i], amt);
    }
  };
  const addContinue = (x: Cell, amt: number) => {
    const cont = x.c + sumR(x);
    if (cont > EPS) {
      x.c += (amt * x.c) / cont;
      x.r = x.r.map((v) => v + (amt * v) / cont);
    } else if (ctx.facingRaise && cKind === "call") x.c += amt;
    else if (mainIdx >= 0) x.r[mainIdx] += amt;
    else if (cKind) x.c += amt;
    else return;
    x.f -= amt;
  };

  // (a) loose
  if (canFold && p.loose !== 0 && (cKind || tos.length)) {
    const total = W(() => 1);
    const M = W((x) => 1 - x.f);
    // Widening also adds at most (mult − 1) of the folding share, so a range that already continues often doesn't
    // saturate (55bb BB vs a BTN open: 80% → 85% at +1, not 100%).
    const mult = LOOSE_MULT[p.loose];
    const target = mult > 1 ? Math.min(total, M * mult, M + (total - M) * (mult - 1)) : M * mult;
    if (target > M) walk(byK(true), target - M, (x) => x.f, addContinue);
    else
      walk(byK(false), M - target, (x) => 1 - x.f, (x, amt) => {
        const cont = x.c + sumR(x);
        const s = amt / cont;
        x.c -= x.c * s;
        x.r = x.r.map((v) => v - v * s);
        x.f += amt;
      });
  }

  // (b) aggro
  if (p.aggro !== 0 && cKind && tos.length) {
    const cr = W((x) => x.c + sumR(x));
    const R = W(sumR);
    if (cr > EPS && R > EPS) {
      const target = Math.min(cr, R * AGGRO_MULT[p.aggro]);
      const order = ctx.order;
      if (target > R) {
        const mixing = ALL_HANDS.map((_, i) => i).filter((i) => cells[i].c > EPS && sumR(cells[i]) > EPS).sort((a, b) => (order[b] ?? 0) - (order[a] ?? 0));
        const callers = ALL_HANDS.map((_, i) => i).filter((i) => cells[i].c > EPS && sumR(cells[i]) <= EPS).sort((a, b) => (order[b] ?? 0) - (order[a] ?? 0));
        walk([...mixing, ...callers], target - R, (x) => x.c, (x, amt) => {
          const r = sumR(x);
          if (r > EPS) x.r = x.r.map((v) => v + (amt * v) / r);
          else if (mainIdx >= 0) x.r[mainIdx] += amt;
          else return;
          x.c -= amt;
        });
      } else {
        const raisers = ALL_HANDS.map((_, i) => i).filter((i) => sumR(cells[i]) > EPS).sort((a, b) => (order[a] ?? 0) - (order[b] ?? 0));
        walk(raisers, R - target, sumR, (x, amt) => {
          const r = sumR(x);
          x.r = x.r.map((v) => v - (amt * v) / r);
          x.c += amt;
        });
      }
    }
  }

  // (c) sticky
  if (p.sticky > 0 && ctx.facingRaise && cKind === "call") {
    const add = STICKY_ADD[p.sticky] * W((x) => x.f);
    walk(byK(true), add, (x) => x.f, (x, amt) => {
      x.f -= amt;
      x.c += amt;
    });
  }

  const cache = new Map<HandClass, MoveOption[]>();
  ALL_HANDS.forEach((h, i) => {
    const x = cells[i];
    const parts = [Math.max(0, x.f), Math.max(0, x.c), ...x.r.map((v) => Math.max(0, v))];
    const tot = parts.reduce((a, b) => a + b, 0) || 1;
    const out: MoveOption[] = [];
    tos.forEach((to, j) => {
      const pr = parts[2 + j] / tot;
      if (pr > 1e-6) out.push({ kind: "raise", to, prob: pr });
    });
    if (parts[1] / tot > 1e-6 && cKind) out.push({ kind: cKind, prob: parts[1] / tot });
    if (parts[0] / tot > 1e-6) out.push({ kind: canFold ? "fold" : cKind ?? "fold", prob: parts[0] / tot });
    // Renormalize after the cut.
    const s = out.reduce((a, m) => a + m.prob, 0);
    if (!out.length) out.push({ kind: canFold ? "fold" : (cKind ?? "fold"), prob: 1 });
    else for (const m of out) m.prob /= s;
    cache.set(h, out);
  });
  return {
    ...(base.scenario ? { scenario: base.scenario } : {}),
    label: `${base.label} · ${badgeOf(p)}`,
    moves: (h) => cache.get(h) ?? base.moves(h),
  };
}

/** The class masses (ALL_HANDS order) of a COMBOS-indexed range, combos touching `dead` cards left out. */
export function classMass(w: ArrayLike<number>, dead?: ReadonlySet<number>): Float64Array {
  const out = new Float64Array(N);
  for (let i = 0; i < COMBOS.length; i++) {
    const x = w[i];
    if (!(x > 0)) continue;
    if (dead) {
      const [a, b] = COMBOS[i].cards;
      if (dead.has(a) || dead.has(b)) continue;
    }
    out[COMBO_CLASS_IDX[i]] += x;
  }
  return out;
}

// ───────────── postflop ─────────────

export interface PostflopAdjustCtx {
  /** handInfo.ts tier of the hand on this board. */
  tier: number;
  /** The seat faces a bet. */
  facingBet: boolean;
}

/**
 * A seat's postflop move probabilities under its profile. Works on kinds, so a solver pack node's actions (two bet
 * sizes) and the heuristic moves are adjusted alike; every other field of a move is kept. GTO: `moves` itself.
 */
export function adjustPostflop<T extends MoveOption>(moves: T[], prof: SeatProfile | null | undefined, o: PostflopAdjustCtx): T[] {
  if (isGto(prof)) return moves;
  const p = prof!;
  const out = moves.map((m) => ({ ...m }));
  const sum = (kind: MoveOption["kind"]) => out.filter((m) => m.kind === kind).reduce((a, m) => a + m.prob, 0);
  const scale = (kind: MoveOption["kind"], to: number) => {
    const now = sum(kind);
    const list = out.filter((m) => m.kind === kind);
    if (now > EPS) for (const m of list) m.prob *= to / now;
    else if (to > EPS) {
      if (list.length) list[0].prob = to;
      else out.push({ kind, prob: to } as T);
    }
  };
  if (!o.facingBet) {
    const B = sum("raise");
    if (B > EPS && B < 1 - EPS) {
      const mult = o.tier === 0 || o.tier === 1.5 ? BLUFF_MULT[p.aggro] : BET_MULT[p.aggro];
      // Capped at 95%, or at the base share when it is already above (a more aggressive seat never bets less).
      const B2 = Math.max(0, Math.min(Math.max(B, 0.95), B * mult));
      scale("raise", B2);
      scale("check", 1 - B2);
    }
  } else {
    let R = sum("raise"), C = sum("call"), F = sum("fold");
    const R2 = Math.min(R * RAISE_MULT[p.aggro], R + C + F);
    const d = R2 - R;
    if (d > 0) {
      const t = Math.min(C, d);
      C -= t;
      F -= d - t;
    } else C -= d;
    R = R2;
    const coef = STICKY_CALL[p.sticky] + LOOSE_CALL[p.loose];
    const tf = o.tier >= 1 ? 1 : 0.4;
    if (coef >= 0) {
      const x = F * coef * tf;
      F -= x;
      C += x;
    } else {
      const x = C * -coef * tf;
      C -= x;
      F += x;
    }
    scale("raise", Math.max(0, R));
    scale("call", Math.max(0, C));
    scale("fold", Math.max(0, F));
  }
  const kept = out.filter((m) => m.prob > 1e-6);
  const s = kept.reduce((a, m) => a + m.prob, 0);
  if (!kept.length || s <= EPS) return moves;
  for (const m of kept) m.prob /= s;
  return kept;
}
