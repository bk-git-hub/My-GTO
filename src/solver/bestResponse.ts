import { MODE_BR, type Engine } from "./cfr";

/**
 * Best-response value for player p: the traversal with the opponent on the average strategy and,
 * at p's nodes, the per-hand maximum over actions. Normalized as an expectation over the initial
 * ranges: BR_p = Σ_h w_p(h) cfv(h) / Σ_{h,o compatible} w_p(h) w_o(o).
 */
export function bestResponseValue(e: Engine, p: 0 | 1): number {
  const out = e.out;
  const o = 1 - p;
  e.walk(e.root, p, MODE_BR, e.w[p], e.w[o], out, 0);
  const w = e.w[p];
  let s = 0;
  for (let h = 0; h < w.length; h++) s += w[h] * out[h];
  return s / e.pairTotal;
}

/**
 * Exploitability in % of the starting pot: (BR_0 + BR_1 - P0) / 2 / P0 × 100, never below 0.
 * The two nets always sum to P0, so the exact value is 0 at an equilibrium and positive otherwise. In floats,
 * a spot with nothing to decide can come out a few 1e-14 below 0 (summation noise in BR_0 + BR_1 - P0); that
 * reads as 0, not as "-0.00%". The per-player bestResponseValue stays raw.
 */
export function exploitability(e: Engine): number {
  const br0 = bestResponseValue(e, 0);
  const br1 = bestResponseValue(e, 1);
  return Math.max(0, ((br0 + br1 - e.pot0) / 2 / e.pot0) * 100);
}
