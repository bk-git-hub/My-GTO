import { ALL_HANDS, RANKS } from "../cards";

/**
 * Hand features of the postflop realization model (model B, docs: design §3.4). One definition for the fit
 * (scripts/fit-realization.mjs, which writes eqrFit.ts) and the preflop engine, so the fitted weights are always
 * applied to the same indicators they were fitted on.
 *
 * - pair: a pocket pair;
 * - suited;
 * - bway: not a pair, second card T or higher;
 * - conn: not a pair, gap of at most one rank (connected or one-gapped; A2 is not connected);
 * - weakAce: not a pair, ace high with a second card of 9 or lower.
 *
 * The 3-feature alternative fit uses the first three, the set the first prototype fitted.
 */
export const FEATURE_NAMES = ["pair", "suited", "bway", "conn", "weakAce"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const rank = (c: string) => RANKS.indexOf(c);

const TABLE: readonly (readonly number[])[] = ALL_HANDS.map((h) => {
  const pair = h.length === 2;
  const hi = rank(h[0]), lo = rank(h[1]);
  return [
    pair ? 1 : 0,
    h[2] === "s" ? 1 : 0,
    !pair && lo >= rank("T") ? 1 : 0,
    !pair && hi - lo - 1 <= 1 ? 1 : 0,
    !pair && hi === rank("A") && lo <= rank("9") ? 1 : 0,
  ];
});

/** The five feature indicators (0 or 1) of hand class h (index into ALL_HANDS), in FEATURE_NAMES order. */
export function handFeatures(h: number): number[] {
  const f = TABLE[h];
  if (!f) throw new Error(`hand class index out of range: ${h}`);
  return [...f];
}
