import { ALL_HANDS, comboCount, RANKS } from "../cards";

/**
 * Hand features of the postflop realization model (model B, docs: design §3.4). One definition for the fit
 * (scripts/fit-realization.mjs, which writes eqrFit.ts) and the preflop engine, so the fitted weights are always
 * applied to the same numbers they were fitted on.
 *
 * Rank-continuous: each feature is a monotone function of one rank, r = RANKS.indexOf(card) (2 = 0 … A = 12), with
 * hi the first card of the class string and lo the second.
 * - pair: 1 for a pocket pair;
 * - suited: 1 for a suited hand;
 * - hi2: (hi / 12)² for a non-pair, 0 for a pair (the top card);
 * - lo2: (lo / 12)² for a non-pair, 0 for a pair (the kicker);
 * - gap: min(hi − lo − 1, 4) / 4 for a non-pair, 0 for a pair (0 connected … 1 at four gaps or more);
 * - pairRank2: (r / 12)² for a pair, 0 otherwise.
 *
 * Top card and kicker enter additively, so Ax and Kx with the same kicker differ by the same top-card step whatever
 * the kicker. u = θ·F is monotone in the kicker within every row when θ_lo2 ≥ 0 and θ_gap ≤ 0, and monotone in the
 * pair rank when θ_pairRank2 ≥ 0 (features.test.ts checks these signs on the shipped fit).
 *
 * Centering: every column is the raw value minus its combo-weighted mean over the 1,326 combos (FEATURE_MEANS), so
 * u has mean 0 over all combos on each side. A constant added to u is exactly collinear with c, so only the sum of
 * c and the mean u is identified; centering fixes the convention that the derived contexts read (the ⅔ / ⅓ split of
 * c, u by role), with the whole position level in c. In the fitted context it is an exact reparametrization.
 *
 * The 3-feature alternative fit (sensitivity solve (c)) uses the first three: pair, suited, hi2.
 */
export const FEATURE_NAMES = ["pair", "suited", "hi2", "lo2", "gap", "pairRank2"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const rank = (c: string) => RANKS.indexOf(c);

/** Raw (uncentered) feature values per class, ALL_HANDS order. */
const RAW: readonly (readonly number[])[] = ALL_HANDS.map((h) => {
  const hi = rank(h[0]), lo = rank(h[1]);
  if (h.length === 2) return [1, 0, 0, 0, 0, (hi / 12) ** 2];
  return [0, h[2] === "s" ? 1 : 0, (hi / 12) ** 2, (lo / 12) ** 2, Math.min(hi - lo - 1, 4) / 4, 0];
});

/**
 * Combo-weighted mean of each raw feature over the 1,326 combos: Σ comboCount·raw summed in ALL_HANDS order from 0,
 * divided once by 1326 (the fit and the shipped charts depend on this exact operation order).
 */
export const FEATURE_MEANS: readonly number[] = FEATURE_NAMES.map((_, j) => {
  let s = 0;
  ALL_HANDS.forEach((h, i) => (s += comboCount(h) * RAW[i][j]));
  return s / 1326;
});

const TABLE: readonly (readonly number[])[] = RAW.map((row) => row.map((v, j) => v - FEATURE_MEANS[j]));

/** The six centered features of hand class h (index into ALL_HANDS), in FEATURE_NAMES order. */
export function handFeatures(h: number): number[] {
  const f = TABLE[h];
  if (!f) throw new Error(`hand class index out of range: ${h}`);
  return [...f];
}
