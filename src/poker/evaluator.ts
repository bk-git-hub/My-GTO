import type { Card } from "./cards";

/**
 * Hand evaluator for 5-7 cards. Returns a score where higher is better:
 * category << 20 | five 4-bit kicker ranks.
 */
export const CATEGORY_NAMES = [
  "하이카드",
  "원페어",
  "투페어",
  "트리플",
  "스트레이트",
  "플러시",
  "풀하우스",
  "포카드",
  "스트레이트 플러시",
];

const rankCounts = new Int8Array(13);
const suitCounts = new Int8Array(4);
const suitMasks = new Int32Array(4);

/** Highest straight in a 13-bit rank mask, or -1. Wheel (A-5) returns 3. */
function straightHigh(mask: number): number {
  for (let hi = 12; hi >= 4; hi--) {
    if (((mask >> (hi - 4)) & 0x1f) === 0x1f) return hi;
  }
  // A-2-3-4-5
  if ((mask & 0x100f) === 0x100f) return 3;
  return -1;
}

/** Top `n` set bits of a rank mask, high to low. */
function topBits(mask: number, n: number, out: number[]) {
  for (let r = 12; r >= 0 && out.length < n; r--) if (mask & (1 << r)) out.push(r);
}

function pack(cat: number, ks: number[]): number {
  let s = cat;
  for (let i = 0; i < 5; i++) s = (s << 4) | (ks[i] ?? 0);
  return s;
}

export function evaluate(cards: ArrayLike<Card>, n: number = cards.length): number {
  rankCounts.fill(0);
  suitCounts.fill(0);
  suitMasks.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c >> 2;
    const s = c & 3;
    rankCounts[r]++;
    suitCounts[s]++;
    suitMasks[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // In 7 cards a flush can't coexist with quads or a full house,
  // so a flush means the answer is a straight flush or a flush.
  for (let s = 0; s < 4; s++) {
    if (suitCounts[s] >= 5) {
      const sf = straightHigh(suitMasks[s]);
      if (sf >= 0) return pack(8, [sf]);
      const ks: number[] = [];
      topBits(suitMasks[s], 5, ks);
      return pack(5, ks);
    }
  }

  let quad = -1;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const k = rankCounts[r];
    if (k === 4) quad = r;
    else if (k === 3) trips.push(r);
    else if (k === 2) pairs.push(r);
  }

  if (quad >= 0) {
    const ks: number[] = [];
    topBits(rankMask & ~(1 << quad), 1, ks);
    return pack(7, [quad, ks[0]]);
  }
  if (trips.length >= 2) return pack(6, [trips[0], trips[1]]);
  if (trips.length === 1 && pairs.length >= 1) return pack(6, [trips[0], pairs[0]]);

  const st = straightHigh(rankMask);
  if (st >= 0) return pack(4, [st]);

  if (trips.length === 1) {
    const ks: number[] = [];
    topBits(rankMask & ~(1 << trips[0]), 2, ks);
    return pack(3, [trips[0], ...ks]);
  }
  if (pairs.length >= 2) {
    const ks: number[] = [];
    topBits(rankMask & ~(1 << pairs[0]) & ~(1 << pairs[1]), 1, ks);
    return pack(2, [pairs[0], pairs[1], ks[0]]);
  }
  if (pairs.length === 1) {
    const ks: number[] = [];
    topBits(rankMask & ~(1 << pairs[0]), 3, ks);
    return pack(1, [pairs[0], ...ks]);
  }
  const ks: number[] = [];
  topBits(rankMask, 5, ks);
  return pack(0, ks);
}

export function categoryOf(score: number): number {
  return score >> 20;
}

export function categoryName(score: number): string {
  return CATEGORY_NAMES[categoryOf(score)];
}
