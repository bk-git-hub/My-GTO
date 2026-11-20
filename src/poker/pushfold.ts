import { ALL_HANDS, combosOf } from "./cards";
import { evaluate } from "./evaluator";

/**
 * Push/fold Nash equilibrium for a full table with a BB ante, in chip EV.
 *
 * Model: everyone starts with the same stack. The first player in either folds
 * or shoves. Facing a shove, each player behind (in order) calls or folds;
 * once someone calls, the rest fold (no overcalls, which are rare and tight in
 * practice). Card removal between the shover and the caller is counted; the
 * folded players' cards are not. Solved by fictitious play over the 169 hand
 * classes.
 *
 * The charts (src/data/sets/nashData.ts) no longer come from this solver: scripts/make-nash.mjs solves the
 * same game (pushFoldConfig in src/poker/preflop/tree.ts) with the preflop solver's DCFR engine, which
 * converges where this fictitious play does not (docs/preflop-solver.md, PF-RED-4). This file keeps the
 * equity table builder and the reference solver the engine's reduction tests compare against.
 */

export const N = ALL_HANDS.length; // 169

/** Heads-up all-in equity between hand classes, plus how many b-combos fit with an a-combo. */
export interface EquityTable {
  /** eq[a * N + b]: equity of class a against class b (ties count half). */
  eq: Float64Array;
  /** cnt[a * N + b]: average number of class-b combos that don't share a card with a class-a combo. */
  cnt: Float64Array;
}

/** Small seeded PRNG so the table, and the charts built from it, are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Monte Carlo equity table: about `samples` boards per class pair, spread over its combo pairs.
 * With `onlyRows`, equities are filled for those rows (b >= a) only, so the work can be split
 * across workers and merged with mergeEquityRows.
 */
export function buildEquityTable(samples = 12000, rand = mulberry32(1), onlyRows?: (a: number) => boolean): EquityTable {
  const combos = ALL_HANDS.map(combosOf);
  const eq = new Float64Array(N * N);
  const cnt = new Float64Array(N * N);
  const cards = new Int32Array(7);
  const used = new Uint8Array(52);
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      const pairs: number[][] = [];
      for (const [a1, a2] of combos[a]) for (const [b1, b2] of combos[b]) if (a1 !== b1 && a1 !== b2 && a2 !== b1 && a2 !== b2) pairs.push([a1, a2, b1, b2]);
      cnt[a * N + b] = pairs.length / combos[a].length;
      if (a === b) {
        eq[a * N + b] = 0.5;
        continue;
      }
      // Each unordered pair once; the mirror is 1 - equity.
      if (b < a || (onlyRows && !onlyRows(a))) continue;
      const per = Math.max(1, Math.ceil(samples / pairs.length));
      let win = 0;
      let total = 0;
      for (const [a1, a2, b1, b2] of pairs) {
        for (let k = 0; k < per; k++) {
          used.fill(0);
          used[a1] = used[a2] = used[b1] = used[b2] = 1;
          for (let n = 2; n < 7; n++) {
            let c: number;
            do c = (rand() * 52) | 0;
            while (used[c]);
            used[c] = 1;
            cards[n] = c;
          }
          cards[0] = a1;
          cards[1] = a2;
          const sa = evaluate(cards, 7);
          cards[0] = b1;
          cards[1] = b2;
          const sb = evaluate(cards, 7);
          win += sa > sb ? 1 : sa === sb ? 0.5 : 0;
          total++;
        }
      }
      eq[a * N + b] = win / total;
      eq[b * N + a] = 1 - win / total;
    }
  }
  return { eq, cnt };
}

/** Combine partial tables built with disjoint `onlyRows` filters. */
export function mergeEquityRows(parts: { eq: Float64Array; rows: (a: number) => boolean }[], cnt: Float64Array): EquityTable {
  const eq = new Float64Array(N * N);
  for (let a = 0; a < N; a++) eq[a * N + a] = 0.5;
  for (const { eq: part, rows } of parts) {
    for (let a = 0; a < N; a++) {
      if (!rows(a)) continue;
      for (let b = a + 1; b < N; b++) {
        eq[a * N + b] = part[a * N + b];
        eq[b * N + a] = 1 - part[a * N + b];
      }
    }
  }
  return { eq, cnt };
}

export interface TableSetup {
  players: number; // seats in preflop order; the last two are SB and BB
  stack: number; // bb, everyone
  sb: number;
  bb: number;
  /** BB ante (dead money paid by the BB). */
  bbAnte: number;
}

export interface PushFoldSolution {
  setup: TableSetup;
  /** push[i][h]: how often seat i shoves hand class h when folded to. */
  push: Float64Array[];
  /** call[i][j][h]: how often seat j calls seat i's shove with h (everyone between folded). */
  call: Float64Array[][];
  /** Largest gain (bb per hand, combo-weighted) any single decision could get by deviating. */
  exploitability: number;
  iterations: number;
}

const COMBO_W = ALL_HANDS.map((h) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12));
const COMPAT = 1225; // combos left for one opponent once my two cards are out

/** What every push/fold decision gains over folding, per hand class, under fixed strategies (bb). */
export interface PushFoldGains {
  /** pushGain[i][h]: seat i shoving h when folded to, over folding. */
  pushGain: Float64Array[];
  /**
   * callGain[i][j][h]: seat j calling seat i's shove with h (everyone between folded), over folding; empty for
   * j <= i. -1 where seat i's shoving range, seen from h, is empty (below 1e-12).
   */
  callGain: Float64Array[][];
}

/**
 * The gains solvePushFold plays its best responses against, for the strategies `push` and `call` (shaped as in
 * PushFoldSolution). solvePushFold calls this every iteration, so other code (the preflop engine's reduction
 * tests) can check its own values against exactly what the reference solver uses. `out` reuses arrays from an
 * earlier call.
 */
export function pushFoldGains(
  t: EquityTable,
  setup: TableSetup,
  push: Float64Array[],
  call: Float64Array[][],
  out?: PushFoldGains,
): PushFoldGains {
  const { players: n, stack, sb, bb, bbAnte } = setup;
  const SB = n - 2, BB = n - 1;
  const { eq, cnt } = t;
  const blind = (k: number) => (k === SB ? sb : k === BB ? bb : 0);
  const live = (k: number) => stack - (k === BB ? bbAnte : 0);
  const effOf = (i: number, j: number) => Math.min(live(i), live(j));
  const deadOf = (i: number, j: number) => bbAnte + (i !== SB && j !== SB ? sb : 0) + (i !== BB && j !== BB ? bb : 0);
  const allFoldWin = bbAnte + sb + bb; // pot the shover picks up uncontested (includes own blind)
  const g = out ?? {
    pushGain: Array.from({ length: n - 1 }, () => new Float64Array(N)),
    callGain: Array.from({ length: n - 1 }, (_, i) => Array.from({ length: n }, (_, j) => new Float64Array(j > i ? N : 0))),
  };

  /** EV (bb, vs. folding) of shoving each class from seat i, given the callers' current ranges. */
  function pushGain(i: number, dst: Float64Array) {
    for (let h = 0; h < N; h++) {
      let reach = 1; // nobody has called yet
      let ev = 0;
      for (let j = i + 1; j < n; j++) {
        const c = call[i][j];
        let pc = 0, ce = 0;
        const row = h * N;
        for (let x = 0; x < N; x++) {
          const w = cnt[row + x] * c[x];
          pc += w;
          ce += w * eq[row + x];
        }
        pc /= COMPAT;
        ce /= COMPAT;
        const eff = effOf(i, j);
        ev += reach * (ce * (2 * eff + deadOf(i, j)) - pc * eff);
        reach *= 1 - pc;
      }
      // Uncontested: I take the blinds and ante; my own posted blind was mine already.
      ev += reach * (allFoldWin - blind(i));
      // Folding costs my posted blind, so the gain over folding adds it back.
      dst[h] = ev + blind(i);
    }
  }

  /** EV (bb, vs. folding) of calling seat i's shove from seat j with each class. */
  function callGain(i: number, j: number, dst: Float64Array) {
    const p = push[i];
    const eff = effOf(i, j);
    const pot = 2 * eff + deadOf(i, j);
    for (let h = 0; h < N; h++) {
      let pp = 0, pe = 0;
      const row = h * N;
      for (let x = 0; x < N; x++) {
        const w = cnt[row + x] * p[x];
        pp += w;
        pe += w * eq[row + x];
      }
      dst[h] = pp > 1e-12 ? (pe / pp) * pot - eff + blind(j) : -1;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    pushGain(i, g.pushGain[i]);
    for (let j = i + 1; j < n; j++) callGain(i, j, g.callGain[i][j]);
  }
  return g;
}

export function solvePushFold(t: EquityTable, setup: TableSetup, iterations = 3000): PushFoldSolution {
  const n = setup.players;
  const push = Array.from({ length: n - 1 }, () => new Float64Array(N).fill(0.5));
  const call = Array.from({ length: n - 1 }, (_, i) => Array.from({ length: n }, (_, j) => (j > i ? new Float64Array(N).fill(0.3) : new Float64Array(0))));
  const brPush = push.map(() => new Float64Array(N));
  const brCall = call.map((row) => row.map((a) => new Float64Array(a.length)));

  // Every gain depends only on the current averages, which change after the loop, so computing them all first
  // and then the best responses is the same as interleaving the two.
  let gains: PushFoldGains | undefined;
  let it = 0;
  for (; it < iterations; it++) {
    gains = pushFoldGains(t, setup, push, call, gains);
    for (let i = 0; i < n - 1; i++) {
      for (let h = 0; h < N; h++) brPush[i][h] = gains.pushGain[i][h] > 0 ? 1 : 0;
      for (let j = i + 1; j < n; j++) for (let h = 0; h < N; h++) brCall[i][j][h] = gains.callGain[i][j][h] > 0 ? 1 : 0;
    }
    const step = 1 / (it + 2);
    for (let i = 0; i < n - 1; i++) {
      for (let h = 0; h < N; h++) push[i][h] += (brPush[i][h] - push[i][h]) * step;
      for (let j = i + 1; j < n; j++) for (let h = 0; h < N; h++) call[i][j][h] += (brCall[i][j][h] - call[i][j][h]) * step;
    }
  }

  // Exploitability: what a best response gains over the averaged strategy, per decision.
  let worst = 0;
  const gainOf = (g: Float64Array, s: Float64Array) => {
    let d = 0;
    for (let h = 0; h < N; h++) d += COMBO_W[h] * (Math.max(0, g[h]) - s[h] * g[h]);
    return d / 1326;
  };
  gains = pushFoldGains(t, setup, push, call, gains);
  for (let i = 0; i < n - 1; i++) {
    worst = Math.max(worst, gainOf(gains.pushGain[i], push[i]));
    for (let j = i + 1; j < n; j++) worst = Math.max(worst, gainOf(gains.callGain[i][j], call[i][j]));
  }
  return { setup, push, call, exploitability: worst, iterations: it };
}
