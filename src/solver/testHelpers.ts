// Small helpers shared by the solver tests (not used by the solver itself).
import { parseCards, type Card } from "../poker/cards";
import { parseRange } from "../poker/range";
import { COMBOS } from "../play/handInfo";

/** COMBOS-indexed weights from range text, e.g. "TT+, AKs, KQo:0.5". */
export function rangeWeights(text: string): Float64Array {
  const r = parseRange(text);
  const w = new Float64Array(1326);
  for (let i = 0; i < 1326; i++) w[i] = r[COMBOS[i].hand] ?? 0;
  return w;
}

/** COMBOS index of a concrete combo such as "KhKd". */
export function comboIndex(text: string): number {
  const [a, b] = parseCards(text);
  const i = COMBOS.findIndex((c) => (c.cards[0] === a && c.cards[1] === b) || (c.cards[0] === b && c.cards[1] === a));
  if (i < 0) throw new Error(`no combo ${text}`);
  return i;
}

/** Number of combos with weight > 0 that don't touch the board. */
export function liveCombos(w: ArrayLike<number>, board: Card[]): number {
  let n = 0;
  for (let i = 0; i < 1326; i++) {
    const [a, b] = COMBOS[i].cards;
    if (w[i] > 0 && !board.includes(a) && !board.includes(b)) n++;
  }
  return n;
}

/** Deterministic PRNG (mulberry32) so random tests are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Elapsed milliseconds (performance.now exists in browsers and Node). */
export const now = () => performance.now();
