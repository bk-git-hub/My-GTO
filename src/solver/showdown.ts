import type { Card } from "../poker/cards";
import { evaluate } from "../poker/evaluator";
import { cardMask, type HandList } from "./hands";

/**
 * Hand strengths for one river board, computed once and shared by every showdown on that board.
 * Only hands that don't touch the board are in `order`; the other per-hand arrays are aligned with
 * `order` so the showdown sweeps read memory sequentially.
 */
export interface RiverBoard {
  board: Card[];
  /** Per player: hand indices sorted by strength, weakest first. */
  order: [Int32Array, Int32Array];
  /** Per player: the strength of order[i] (evaluator score, higher is better). */
  strength: [Int32Array, Int32Array];
  /** Per player: the two cards of order[i]. */
  card1: [Uint8Array, Uint8Array];
  card2: [Uint8Array, Uint8Array];
  /** Per player: index of order[i]'s combo in the other player's list, or -1. */
  same: [Int32Array, Int32Array];
  /** Per player: hands that share a card with this board. */
  blocked: [Int32Array, Int32Array];
}

const seven: number[] = [0, 0, 0, 0, 0, 0, 0];

function sortPlayer(board: Card[], hands: HandList, dead: Uint8Array) {
  const valid: number[] = [];
  const blocked: number[] = [];
  const score = new Int32Array(hands.n);
  for (let i = 0; i < 5; i++) seven[2 + i] = board[i];
  for (let h = 0; h < hands.n; h++) {
    const a = hands.c1[h], b = hands.c2[h];
    if (dead[a] || dead[b]) {
      blocked.push(h);
      continue;
    }
    seven[0] = a;
    seven[1] = b;
    score[h] = evaluate(seven, 7);
    valid.push(h);
  }
  valid.sort((x, y) => score[x] - score[y]);
  return {
    order: Int32Array.from(valid),
    strength: Int32Array.from(valid, (h) => score[h]),
    card1: Uint8Array.from(valid, (h) => hands.c1[h]),
    card2: Uint8Array.from(valid, (h) => hands.c2[h]),
    same: Int32Array.from(valid, (h) => hands.same[h]),
    blocked: Int32Array.from(blocked),
  };
}

export function makeRiverBoard(board: Card[], hands: [HandList, HandList]): RiverBoard {
  if (board.length !== 5) throw new Error("river board needs 5 cards");
  const dead = cardMask(board);
  const p0 = sortPlayer(board, hands[0], dead);
  const p1 = sortPlayer(board, hands[1], dead);
  return {
    board,
    order: [p0.order, p1.order],
    strength: [p0.strength, p1.strength],
    card1: [p0.card1, p1.card1],
    card2: [p0.card2, p1.card2],
    same: [p0.same, p1.same],
    blocked: [p0.blocked, p1.blocked],
  };
}

/** River boards keyed by their card set, so the same 5 cards dealt in any order share one entry. */
export class RiverCache {
  private map = new Map<number, RiverBoard>();
  constructor(private hands: [HandList, HandList]) {}

  get(board: Card[]): RiverBoard {
    let key = 0;
    for (const c of board) key += 2 ** c; // a 52-bit set fits exactly in a double
    let rb = this.map.get(key);
    if (!rb) {
      rb = makeRiverBoard(board, this.hands);
      this.map.set(key, rb);
    }
    return rb;
  }

  get size(): number {
    return this.map.size;
  }
}

// Per-card reach accumulators (single-threaded, not re-entrant).
const accA = new Float64Array(52);
const accB = new Float64Array(52);
// Opponent reach and W in sorted order, for one showdown call.
const gathered = new Float64Array(1326);
const weaker = new Float64Array(1326);

/**
 * Fold terminal: out[h] = net × (opponent reach compatible with h), by inclusion-exclusion.
 * Hands that are blocked by the current board get a meaningless value; the chance node above zeroes it.
 */
export function foldValues(me: HandList, opp: HandList, ro: Float64Array, net: number, out: Float64Array): void {
  accA.fill(0);
  let total = 0;
  const oc1 = opp.c1, oc2 = opp.c2, nO = opp.n;
  for (let o = 0; o < nO; o++) {
    const r = ro[o];
    if (r !== 0) {
      total += r;
      accA[oc1[o]] += r;
      accA[oc2[o]] += r;
    }
  }
  const c1 = me.c1, c2 = me.c2, same = me.same, nP = me.n;
  for (let h = 0; h < nP; h++) {
    const s = same[h];
    out[h] = net * (total - accA[c1[h]] - accA[c2[h]] + (s >= 0 ? ro[s] : 0));
  }
}

/**
 * Showdown terminal for player p, both players having put in `x` on top of the starting pot `pot0`.
 *
 * With both lists sorted by strength we sweep upward adding opponent reach that is strictly weaker,
 * in total and per card, so W(h) = weaker - weakerByCard[c1] - weakerByCard[c2] (a hand sharing
 * both cards is the same combo, which ties, so it is never in "weaker"). A downward sweep gives the
 * strictly stronger reach L(h). Ties are T = compatible - W - L, and
 *   value = (P0 + x) W - x L + (P0 / 2) T = (x + P0/2)(W - L) + (P0/2) compatible.
 */
export function showdownValues(rb: RiverBoard, p: number, ro: Float64Array, pot0: number, x: number, out: Float64Array): void {
  const q = 1 - p;
  const oP = rb.order[p], sP = rb.strength[p], pc1 = rb.card1[p], pc2 = rb.card2[p], pSame = rb.same[p];
  const oO = rb.order[q], sO = rb.strength[q], oc1 = rb.card1[q], oc2 = rb.card2[q];
  const mP = oP.length, mO = oO.length;
  const g = gathered, wS = weaker;

  // Upward sweep: W per hand (in sorted order), gathering the opponent's reach in sorted order.
  accA.fill(0);
  let total = 0;
  let j = 0;
  for (let i = 0; i < mP; i++) {
    const s = sP[i];
    while (j < mO && sO[j] < s) {
      const r = ro[oO[j]];
      g[j] = r;
      total += r;
      accA[oc1[j]] += r;
      accA[oc2[j]] += r;
      j++;
    }
    wS[i] = total - accA[pc1[i]] - accA[pc2[i]];
  }
  // Finish the sweep so total / accA cover every opponent hand on this board (for the compatible sum).
  while (j < mO) {
    const r = ro[oO[j]];
    g[j] = r;
    total += r;
    accA[oc1[j]] += r;
    accA[oc2[j]] += r;
    j++;
  }

  // Downward sweep: strictly stronger reach L, then combine.
  accB.fill(0);
  let stronger = 0;
  j = mO - 1;
  const k1 = x + pot0 / 2, k2 = pot0 / 2;
  for (let i = mP - 1; i >= 0; i--) {
    const s = sP[i];
    while (j >= 0 && sO[j] > s) {
      const r = g[j];
      stronger += r;
      accB[oc1[j]] += r;
      accB[oc2[j]] += r;
      j--;
    }
    const a = pc1[i], b = pc2[i];
    const lose = stronger - accB[a] - accB[b];
    const sm = pSame[i];
    const compatible = total - accA[a] - accA[b] + (sm >= 0 ? ro[sm] : 0);
    out[oP[i]] = k1 * (wS[i] - lose) + k2 * compatible;
  }

  // Hands that touch this board can't be here.
  const bl = rb.blocked[p];
  for (let k = 0; k < bl.length; k++) out[bl[k]] = 0;
}
