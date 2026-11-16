import { ALL_HANDS, comboCount, RANKS } from "../cards";

/**
 * Hand features of the postflop realization model (model B, docs: design §3.4). One definition for the fit
 * (scripts/fit-realization.mjs, which writes eqrFit.ts) and the preflop engine, so the fitted weights are always
 * applied to the same numbers they were fitted on.
 *
 * r = RANKS.indexOf(card) (2 = 0 … A = 12), with hi the first card of the class string and lo the second.
 * - pair: 1 for a pocket pair;
 * - suited: 1 for a suited hand;
 * - hi2f5: (max(hi, 3) / 12)² for a non-pair (rank index 3 is the 5), 0 for a pair: the top card, flat at and below
 *   5-high (no IP pack row is 3-high and 43s is the only 4-high one, so the term is not continued below the lowest
 *   top card the data cover);
 * - lo2: (lo / 12)² for a non-pair, 0 for a pair (the kicker);
 * - gap: min(hi − lo − 1, 4) / 4 for a non-pair, 0 for a pair (0 connected … 1 at four gaps or more);
 * - pairRank2: (r / 12)² for a pair, 0 otherwise;
 * - aceTop: 1 for an unpaired ace-high hand (the ace's own top-card step, the same for every kicker);
 * - wheel: 1 for A2–A5, suited or offsuit (the wheel aces);
 * - suitConn: suited × (1 − gap) for a non-pair: how much of the connectivity a suited hand carries.
 *
 * Top card and kicker enter additively, so Ax and Kx with the same kicker differ by the same top-card step whatever
 * the kicker (wheel aside). u = θ·F is monotone in the kicker within every row when θ_lo2 ≥ 0, θ_gap ≤ 0 and
 * θ_gap − θ_suitConn ≤ 0 (the suited rows' gap slope), except A6 against A5 in the ace row, where wheel steps; and
 * monotone in the pair rank when θ_pairRank2 ≥ 0 (features.test.ts checks these signs on the shipped fit).
 *
 * Centering: every column is the raw value minus its combo-weighted mean over the 1,326 combos (FEATURE_MEANS), so
 * u has mean 0 over all combos on each side. A constant added to u is exactly collinear with c, so only the sum of
 * c and the mean u is identified; centering fixes the convention that the derived contexts read (the ⅔ / ⅓ split of
 * c, u by role), with the whole position level in c. In the fitted context it is an exact reparametrization.
 *
 * The 3-feature alternative fit (sensitivity solve (c)) uses the first three: pair, suited, hi2f5.
 */
export const FEATURE_NAMES = ["pair", "suited", "hi2f5", "lo2", "gap", "pairRank2", "aceTop", "wheel", "suitConn"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const rank = (c: string) => RANKS.indexOf(c);
/** Rank index of the 5: the floor of the top-card term. */
const FIVE = 3;
const ACE = 12;

/** Raw (uncentered) feature values per class, ALL_HANDS order. */
const RAW: readonly (readonly number[])[] = ALL_HANDS.map((h) => {
  const hi = rank(h[0]), lo = rank(h[1]);
  if (h.length === 2) return [1, 0, 0, 0, 0, (hi / 12) ** 2, 0, 0, 0];
  const suited = h[2] === "s" ? 1 : 0;
  const gap = Math.min(hi - lo - 1, 4) / 4;
  return [
    0,
    suited,
    (Math.max(hi, FIVE) / 12) ** 2,
    (lo / 12) ** 2,
    gap,
    0,
    hi === ACE ? 1 : 0,
    hi === ACE && lo <= FIVE ? 1 : 0,
    suited ? 1 - gap : 0,
  ];
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

/** The nine centered features of hand class h (index into ALL_HANDS), in FEATURE_NAMES order. */
export function handFeatures(h: number): number[] {
  const f = TABLE[h];
  if (!f) throw new Error(`hand class index out of range: ${h}`);
  return [...f];
}
