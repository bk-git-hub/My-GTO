import { ALL_HANDS } from "./cards";
import { N, type EquityTable } from "./pushfold";

/**
 * Short-stack preflop equilibrium with a small open, in chip EV, for a full table with a BB ante.
 *
 * Tree:
 *  - First in: fold, open to `open` bb, or jam.
 *  - Facing a jam: each player behind calls or folds; once someone calls, the rest fold.
 *  - Facing an open: each player behind folds or re-jams; the BB may also flat call.
 *    After a re-jam the others fold and the opener calls or folds.
 *  - After the BB flats, nobody bets again (check down) and the BB, out of position, realizes
 *    `bbRealization` of its equity (per hand class, or one number for all); the opener gets the rest.
 * Everyone starts with the same stack. Card removal between the two players in a pot is counted
 * through combo counts; folded players' cards are not. Solved by fictitious play over hand classes.
 *
 * The charts (src/data/sets/shortNashData.ts) no longer come from this solver: scripts/make-shortnash.mjs
 * solves the same game (openJamConfig in src/poker/preflop/tree.ts, the "oneSided" valuation) with the
 * preflop solver's DCFR engine. This file is the reference solver the engine's reduction tests compare against.
 */

export interface OpenJamSetup {
  players: number; // last two seats are SB and BB
  stack: number;
  sb: number;
  bb: number;
  bbAnte: number;
  /** Open size (total bb). */
  open: number;
  /** Share of its equity the BB realizes after flatting an open: one value, or one per hand class. */
  bbRealization: number | ArrayLike<number>;
}

export interface OpenJamSolution {
  setup: OpenJamSetup;
  /** First in, per seat: open and jam frequencies (fold is the rest). */
  open: Float64Array[];
  jam: Float64Array[];
  /** callJam[i][j]: seat j calls seat i's first-in jam. */
  callJam: Float64Array[][];
  /** reJam[i][j]: seat j re-jams over seat i's open. */
  reJam: Float64Array[][];
  /** bbCall[i]: the BB flats seat i's open. */
  bbCall: Float64Array[];
  /** callReJam[i][j]: opener i calls seat j's re-jam. */
  callReJam: Float64Array[][];
  exploitability: number;
  iterations: number;
}

const COMBO_W = ALL_HANDS.map((h) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12));
const COMPAT = 1225; // combos one opponent can hold once my two cards are out

/** The strategies the gains are evaluated against (the arrays of an OpenJamSolution). */
export type OpenJamStrategies = Pick<OpenJamSolution, "open" | "jam" | "callJam" | "reJam" | "bbCall" | "callReJam">;

/** What every open/jam decision gains over folding, per hand class, under fixed strategies (bb). */
export interface OpenJamGains {
  /** gainOpen[i][h]: seat i opening h first in. */
  gainOpen: Float64Array[];
  /** gainJam[i][h]: seat i jamming h first in. */
  gainJam: Float64Array[];
  /**
   * Facing seat i's open, holding x: reJam[i][j][x] is seat j's re-jam (j > i; empty for j <= i), flat[i][x] the
   * BB's flat call. Both are -1 where seat i's opening range, seen from x, is empty (below 1e-12).
   */
  vsOpenGains: { reJam: Float64Array[][]; flat: Float64Array[] };
  /** callReJamGain[i][j][h]: opener i calling seat j's re-jam with h; -1 where j never re-jams (below 1e-12). */
  callReJamGain: Float64Array[][];
  /** callJamGain[i][j][x]: seat j calling seat i's first-in jam with x; -1 where i never jams (below 1e-12). */
  callJamGain: Float64Array[][];
}

/**
 * The gains solveOpenJam plays its best responses against, for the strategies `sol`. solveOpenJam calls this
 * every iteration, so other code (the preflop engine's reduction tests) can check its own values against exactly
 * what the reference solver uses. `out` reuses arrays from an earlier call.
 */
export function openJamGains(t: EquityTable, setup: OpenJamSetup, sol: OpenJamStrategies, out?: OpenJamGains): OpenJamGains {
  const { players: n, stack, sb, bb, bbAnte, open: r } = setup;
  const { open, jam, callJam, reJam, bbCall, callReJam } = sol;
  const R = Float64Array.from({ length: N }, (_, x) => (typeof setup.bbRealization === "number" ? setup.bbRealization : setup.bbRealization[x]));
  const SB = n - 2, BB = n - 1;
  const { eq, cnt } = t;
  const blind = (k: number) => (k === SB ? sb : k === BB ? bb : 0);
  const live = (k: number) => stack - (k === BB ? bbAnte : 0);
  const effOf = (i: number, j: number) => Math.min(live(i), live(j));
  const deadOf = (i: number, j: number) => bbAnte + (i !== SB && j !== SB ? sb : 0) + (i !== BB && j !== BB ? bb : 0);
  const allFoldWin = bbAnte + sb + bb;
  const flatPot = (i: number) => 2 * r + bbAnte + (i !== SB ? sb : 0);
  const seats = () => Array.from({ length: n - 1 }, () => new Float64Array(N));
  const grid = () => Array.from({ length: n - 1 }, (_, i) => Array.from({ length: n }, (_, j) => new Float64Array(j > i ? N : 0)));
  const g = out ?? {
    gainOpen: seats(),
    gainJam: seats(),
    vsOpenGains: { reJam: grid(), flat: seats() },
    callReJamGain: grid(),
    callJamGain: grid(),
  };

  // Results of mass(): kept in variables rather than returned, to keep the hot loop allocation-free.
  let mP = 0, mE = 0;
  /** mP = Σ_x cnt[h,x]·w[x] / COMPAT (chance the opponent holds w); mE = the same weighted by my equity. */
  function mass(h: number, w: Float64Array) {
    let p = 0, e = 0;
    const row = h * N;
    for (let x = 0; x < N; x++) {
      const m = cnt[row + x] * w[x];
      p += m;
      e += m * eq[row + x];
    }
    mP = p / COMPAT;
    mE = e / COMPAT;
  }
  /** The BB's flat range weighted by its realization, per opener. */
  const bbCallR = Array.from({ length: n - 1 }, (_, i) => Float64Array.from({ length: N }, (_, x) => bbCall[i][x] * R[x]));

  /** Gain over folding of jamming first in from seat i. */
  function gainJam(i: number, h: number): number {
    let reach = 1, ev = 0;
    for (let j = i + 1; j < n; j++) {
      mass(h, callJam[i][j]);
      const eff = effOf(i, j);
      ev += reach * (mE * (2 * eff + deadOf(i, j)) - mP * eff);
      reach *= 1 - mP;
    }
    return ev + reach * (allFoldWin - blind(i)) + blind(i);
  }

  /** Gain over folding of opening from seat i, given my own current calling of re-jams. */
  function gainOpen(i: number, h: number): number {
    let reach = 1, ev = 0;
    for (let j = i + 1; j < n; j++) {
      mass(h, reJam[i][j]);
      const pj = mP, cej = mE;
      const eff = effOf(i, j);
      const pot = 2 * eff + deadOf(i, j);
      const o = callReJam[i][j][h];
      ev += reach * (o * (cej * pot - pj * eff) - (1 - o) * pj * r);
      if (j === BB) {
        // My share after a flat: 1 - R_x·(1 - eq) summed over the BB's flatting hands x.
        mass(h, bbCall[i]);
        const pc = mP;
        mass(h, bbCallR[i]);
        ev += reach * ((pc - mP + mE) * flatPot(i) - pc * r);
        reach *= 1 - pj - pc;
      } else reach *= 1 - pj;
    }
    return ev + reach * (allFoldWin - blind(i)) + blind(i);
  }

  /** Seat j's gains over folding, holding x, facing seat i's open: re-jam, and flat (BB only). */
  function vsOpenGains(i: number, j: number, x: number) {
    const p = open[i];
    const oc = callReJam[i][j];
    const eff = effOf(i, j);
    const pot = 2 * eff + deadOf(i, j);
    let W = 0, S1 = 0, S2 = 0, E = 0;
    const row = x * N;
    for (let h = 0; h < N; h++) {
      const w = cnt[row + h] * p[h];
      if (!w) continue;
      W += w;
      S1 += w * oc[h] * eq[row + h];
      S2 += w * oc[h];
      E += w * eq[row + h];
    }
    if (W < 1e-12) {
      g.vsOpenGains.reJam[i][j][x] = -1;
      if (j === BB) g.vsOpenGains.flat[i][x] = -1;
      return;
    }
    g.vsOpenGains.reJam[i][j][x] = (S1 * pot - S2 * eff + (W - S2) * (r + deadOf(i, j))) / W + blind(j);
    if (j === BB) g.vsOpenGains.flat[i][x] = R[x] * (E / W) * flatPot(i) - r + bb;
  }

  /** Opener i's gain over folding, holding h, when seat j re-jams. */
  function callReJamGain(i: number, j: number, h: number): number {
    mass(h, reJam[i][j]);
    if (mP < 1e-12) return -1;
    const eff = effOf(i, j);
    return (mE / mP) * (2 * eff + deadOf(i, j)) - eff + r;
  }

  /** Seat j's gain over folding, holding x, calling seat i's first-in jam. */
  function callJamGain(i: number, j: number, x: number): number {
    mass(x, jam[i]);
    if (mP < 1e-12) return -1;
    const eff = effOf(i, j);
    return (mE / mP) * (2 * eff + deadOf(i, j)) - eff + blind(j);
  }

  for (let i = 0; i < n - 1; i++) {
    for (let h = 0; h < N; h++) {
      g.gainOpen[i][h] = gainOpen(i, h);
      g.gainJam[i][h] = gainJam(i, h);
    }
    for (let j = i + 1; j < n; j++) {
      for (let x = 0; x < N; x++) {
        g.callJamGain[i][j][x] = callJamGain(i, j, x);
        g.callReJamGain[i][j][x] = callReJamGain(i, j, x);
        vsOpenGains(i, j, x);
      }
    }
  }
  return g;
}

export function solveOpenJam(t: EquityTable, setup: OpenJamSetup, iterations = 2000): OpenJamSolution {
  const n = setup.players;
  const BB = n - 1;
  const arr = (v: number) => new Float64Array(N).fill(v);
  const grid = (v: number) => Array.from({ length: n - 1 }, (_, i) => Array.from({ length: n }, (_, j) => (j > i ? arr(v) : new Float64Array(0))));
  const open = Array.from({ length: n - 1 }, () => arr(0.3));
  const jam = Array.from({ length: n - 1 }, () => arr(0.2));
  const callJam = grid(0.2);
  const reJam = grid(0.1);
  const bbCall = Array.from({ length: n - 1 }, () => arr(0.3));
  const callReJam = grid(0.3);
  const strategies: OpenJamStrategies = { open, jam, callJam, reJam, bbCall, callReJam };

  const brOpen = open.map(() => new Float64Array(N));
  const brJam = jam.map(() => new Float64Array(N));
  const brCallJam = callJam.map((row) => row.map((a) => new Float64Array(a.length)));
  const brReJam = reJam.map((row) => row.map((a) => new Float64Array(a.length)));
  const brBbCall = bbCall.map(() => new Float64Array(N));
  const brCallReJam = callReJam.map((row) => row.map((a) => new Float64Array(a.length)));

  // Every gain depends only on the current averages, which change after the loop, so computing them all first
  // and then the best responses is the same as interleaving the two.
  let g: OpenJamGains | undefined;
  let it = 0;
  for (; it < iterations; it++) {
    g = openJamGains(t, setup, strategies, g);
    for (let i = 0; i < n - 1; i++) {
      for (let h = 0; h < N; h++) {
        const go = g.gainOpen[i][h], gj = g.gainJam[i][h];
        const best = Math.max(0, go, gj);
        brOpen[i][h] = best > 0 && go === best ? 1 : 0;
        brJam[i][h] = best > 0 && go !== best && gj === best ? 1 : 0;
      }
      for (let j = i + 1; j < n; j++) {
        for (let x = 0; x < N; x++) {
          brCallJam[i][j][x] = g.callJamGain[i][j][x] > 0 ? 1 : 0;
          brCallReJam[i][j][x] = g.callReJamGain[i][j][x] > 0 ? 1 : 0;
          const gj = g.vsOpenGains.reJam[i][j][x], gc = j === BB ? g.vsOpenGains.flat[i][x] : -Infinity;
          const best = Math.max(0, gj, gc);
          brReJam[i][j][x] = best > 0 && gj === best ? 1 : 0;
          if (j === BB) brBbCall[i][x] = best > 0 && gj !== best && gc === best ? 1 : 0;
        }
      }
    }
    const step = 1 / (it + 2);
    const mix = (a: Float64Array, b: Float64Array) => {
      for (let h = 0; h < a.length; h++) a[h] += (b[h] - a[h]) * step;
    };
    for (let i = 0; i < n - 1; i++) {
      mix(open[i], brOpen[i]);
      mix(jam[i], brJam[i]);
      mix(bbCall[i], brBbCall[i]);
      for (let j = i + 1; j < n; j++) {
        mix(callJam[i][j], brCallJam[i][j]);
        mix(reJam[i][j], brReJam[i][j]);
        mix(callReJam[i][j], brCallReJam[i][j]);
      }
    }
  }

  // Exploitability: for each decision, what the best option gains over the averaged mix (combo-weighted bb/hand).
  const fin = openJamGains(t, setup, strategies, g);
  let worst = 0;
  const regret = (gains: (h: number) => number[], probs: (h: number) => number[]) => {
    let d = 0;
    for (let h = 0; h < N; h++) {
      const gh = gains(h), p = probs(h);
      d += COMBO_W[h] * (Math.max(0, ...gh) - gh.reduce((s, x, k) => s + x * p[k], 0));
    }
    worst = Math.max(worst, d / 1326);
  };
  for (let i = 0; i < n - 1; i++) {
    regret((h) => [fin.gainOpen[i][h], fin.gainJam[i][h]], (h) => [open[i][h], jam[i][h]]);
    for (let j = i + 1; j < n; j++) {
      regret((x) => [fin.callJamGain[i][j][x]], (x) => [callJam[i][j][x]]);
      regret((h) => [fin.callReJamGain[i][j][h]], (h) => [callReJam[i][j][h]]);
      regret(
        (x) => (j === BB ? [fin.vsOpenGains.reJam[i][j][x], fin.vsOpenGains.flat[i][x]] : [fin.vsOpenGains.reJam[i][j][x]]),
        (x) => (j === BB ? [reJam[i][j][x], bbCall[i][x]] : [reJam[i][j][x]]),
      );
    }
  }
  return { setup, open, jam, callJam, reJam, bbCall, callReJam, exploitability: worst, iterations: it };
}
