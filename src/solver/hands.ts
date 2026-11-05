import type { Card } from "../poker/cards";
import { COMBOS } from "../play/handInfo";

/** Number of two-card combos (COMBOS.length). */
export const NUM_COMBOS = 1326;

/**
 * One player's hand list: the COMBOS with weight > 0 that don't touch the starting board.
 * Every per-hand array in the solver is indexed by position in this list.
 */
export interface HandList {
  n: number;
  /** COMBOS index of each hand. */
  combo: Int32Array;
  /** The hand's two cards. */
  c1: Uint8Array;
  c2: Uint8Array;
  /** Initial range weight. */
  weight: Float64Array;
  /** Index of the same combo in the other player's list, or -1. */
  same: Int32Array;
  /** For each of the 52 cards, the hands that hold it. */
  withCard: Int32Array[];
  /** COMBOS index -> position in this list, or -1. */
  indexOfCombo: Int32Array;
}

/** 52 flags, 1 where the card is in `cards`. */
export function cardMask(cards: ArrayLike<Card>): Uint8Array {
  const m = new Uint8Array(52);
  for (let i = 0; i < cards.length; i++) m[cards[i]] = 1;
  return m;
}

/** The weight a combo gets in the solve: 0 if it touches the board or the weight isn't a positive number. */
function weightOf(range: ArrayLike<number>, i: number, dead: Uint8Array): number {
  const w = range[i];
  if (!(w > 0) || !Number.isFinite(w)) return 0;
  const [a, b] = COMBOS[i].cards;
  return dead[a] || dead[b] ? 0 : w;
}

/** How many hands a player's list will have, without building it. */
export function countHands(board: ArrayLike<Card>, range: ArrayLike<number>): number {
  const dead = cardMask(board);
  let n = 0;
  for (let i = 0; i < NUM_COMBOS; i++) if (weightOf(range, i, dead) > 0) n++;
  return n;
}

function buildOne(range: ArrayLike<number>, dead: Uint8Array): HandList {
  const idx: number[] = [];
  for (let i = 0; i < NUM_COMBOS; i++) if (weightOf(range, i, dead) > 0) idx.push(i);
  const n = idx.length;
  const list: HandList = {
    n,
    combo: Int32Array.from(idx),
    c1: new Uint8Array(n),
    c2: new Uint8Array(n),
    weight: new Float64Array(n),
    same: new Int32Array(n).fill(-1),
    withCard: [],
    indexOfCombo: new Int32Array(NUM_COMBOS).fill(-1),
  };
  const byCard: number[][] = Array.from({ length: 52 }, () => []);
  for (let h = 0; h < n; h++) {
    const i = idx[h];
    const [a, b] = COMBOS[i].cards;
    list.c1[h] = a;
    list.c2[h] = b;
    list.weight[h] = range[i];
    list.indexOfCombo[i] = h;
    byCard[a].push(h);
    byCard[b].push(h);
  }
  list.withCard = byCard.map((xs) => Int32Array.from(xs));
  return list;
}

/** Both players' hand lists, with the same-combo maps filled in. */
export function buildHands(board: ArrayLike<Card>, ranges: [ArrayLike<number>, ArrayLike<number>]): [HandList, HandList] {
  const dead = cardMask(board);
  const h0 = buildOne(ranges[0], dead);
  const h1 = buildOne(ranges[1], dead);
  for (let h = 0; h < h0.n; h++) h0.same[h] = h1.indexOfCombo[h0.combo[h]];
  for (let h = 0; h < h1.n; h++) h1.same[h] = h0.indexOfCombo[h1.combo[h]];
  return [h0, h1];
}

const sumByCard = new Float64Array(52);

/**
 * out[h] = total opponent reach that doesn't share a card with hand h, by inclusion-exclusion:
 * all reach - reach holding card1(h) - reach holding card2(h) + reach of the same combo (subtracted twice).
 * Returns the total opponent reach.
 */
export function compatibleSums(me: HandList, opp: HandList, ro: ArrayLike<number>, out: Float64Array): number {
  sumByCard.fill(0);
  let total = 0;
  const oc1 = opp.c1, oc2 = opp.c2;
  for (let o = 0; o < opp.n; o++) {
    const r = ro[o];
    if (r !== 0) {
      total += r;
      sumByCard[oc1[o]] += r;
      sumByCard[oc2[o]] += r;
    }
  }
  const c1 = me.c1, c2 = me.c2, same = me.same;
  for (let h = 0; h < me.n; h++) {
    const s = same[h];
    out[h] = total - sumByCard[c1[h]] - sumByCard[c2[h]] + (s >= 0 ? ro[s] : 0);
  }
  return total;
}

/** Σ over compatible pairs (h, o) of w0(h) × w1(o), with the initial weights. */
export function pairWeight(hands: [HandList, HandList]): number {
  const [h0, h1] = hands;
  const cs = new Float64Array(h0.n);
  compatibleSums(h0, h1, h1.weight, cs);
  let s = 0;
  for (let h = 0; h < h0.n; h++) s += h0.weight[h] * cs[h];
  return s;
}
