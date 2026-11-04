import { cardLabel, fullDeck, type Card } from "../poker/cards";
import { evaluate } from "../poker/evaluator";
import { COMBOS, handFeatures, type Tier } from "./handInfo";
import { postflopMoves, type PostflopSpot } from "./policy";

export type Weights = Float64Array; // per COMBOS index

export function fullWeights(): Weights {
  return new Float64Array(COMBOS.length).fill(1);
}

function liveIndex(w: Weights, dead: Set<Card>) {
  const idx: number[] = [];
  const cum: number[] = [];
  let total = 0;
  for (let i = 0; i < COMBOS.length; i++) {
    if (w[i] <= 0) continue;
    const [a, b] = COMBOS[i].cards;
    if (dead.has(a) || dead.has(b)) continue;
    total += w[i];
    idx.push(i);
    cum.push(total);
  }
  return { idx, cum, total };
}

function pick(L: ReturnType<typeof liveIndex>): number {
  const x = Math.random() * L.total;
  let lo = 0, hi = L.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (L.cum[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return L.idx[lo];
}

/** Hero's share of the pot against several weighted ranges (Monte Carlo). */
export function equityVs(hero: Card[], board: Card[], ranges: Weights[], iters = 2500): number {
  if (!ranges.length) return 1;
  const dead = new Set([...hero, ...board]);
  const lists = ranges.map((w) => liveIndex(w, dead));
  if (lists.some((L) => L.total <= 0)) return NaN;
  const baseDeck = fullDeck().filter((c) => !dead.has(c));
  let share = 0, n = 0;
  const cards7 = new Array<Card>(7);
  for (let it = 0; it < iters; it++) {
    const used = new Set<Card>();
    const villains: [Card, Card][] = [];
    let ok = true;
    for (const L of lists) {
      let got = false;
      for (let t = 0; t < 30; t++) {
        const c = COMBOS[pick(L)].cards;
        if (!used.has(c[0]) && !used.has(c[1])) {
          used.add(c[0]); used.add(c[1]);
          villains.push(c);
          got = true;
          break;
        }
      }
      if (!got) { ok = false; break; }
    }
    if (!ok) continue;
    const deck = baseDeck.filter((c) => !used.has(c));
    const full = board.slice();
    for (let k = full.length; k < 5; k++) {
      const j = k - board.length + Math.floor(Math.random() * (deck.length - (k - board.length)));
      [deck[k - board.length], deck[j]] = [deck[j], deck[k - board.length]];
      full.push(deck[k - board.length]);
    }
    cards7[0] = hero[0]; cards7[1] = hero[1];
    for (let k = 0; k < 5; k++) cards7[k + 2] = full[k];
    const h = evaluate(cards7, 7);
    let best = true, ties = 0;
    for (const v of villains) {
      cards7[0] = v[0]; cards7[1] = v[1];
      const s = evaluate(cards7, 7);
      if (s > h) { best = false; break; }
      if (s === h) ties++;
    }
    share += best ? 1 / (ties + 1) : 0;
    n++;
  }
  return n ? share / n : NaN;
}

/** Share of the starting 1326 combos still in the weighted range (dead cards removed). */
export function rangeShare(w: Weights, dead: Card[]): number {
  const L = liveIndex(w, new Set(dead));
  return L.total / COMBOS.length;
}

const TIER_GROUPS: { label: string; test: (t: Tier) => boolean }[] = [
  { label: "투페어+", test: (t) => t === 4 },
  { label: "강한 원페어", test: (t) => t === 3 },
  { label: "미들 페어·콤보드로우", test: (t) => t === 2 || t === 2.5 },
  { label: "드로우", test: (t) => t === 1.5 },
  { label: "약한 패·노페어", test: (t) => t <= 1 },
];

/** How a weighted range breaks down by hand strength on this board. */
export function rangeBreakdown(w: Weights, board: Card[], dead: Card[]): string {
  const d = new Set([...dead, ...board]);
  const sums = TIER_GROUPS.map(() => 0);
  let total = 0;
  for (let i = 0; i < COMBOS.length; i++) {
    if (w[i] <= 0) continue;
    const c = COMBOS[i].cards;
    if (d.has(c[0]) || d.has(c[1])) continue;
    const t = handFeatures(c, board).tier;
    const g = TIER_GROUPS.findIndex((x) => x.test(t));
    sums[g] += w[i];
    total += w[i];
  }
  if (!total) return "-";
  return TIER_GROUPS.map((g, i) => `${g.label} ${Math.round((sums[i] / total) * 100)}%`).join(", ");
}

/**
 * Probability that a villain with this weighted range folds / continues to a
 * hero bet, and the continuing range. Uses the same rules the bots play by.
 */
export function responseToBet(w: Weights, board: Card[], dead: Card[], spot: PostflopSpot) {
  const d = new Set([...dead, ...board]);
  const cont = new Float64Array(COMBOS.length);
  let total = 0, fold = 0;
  for (let i = 0; i < COMBOS.length; i++) {
    if (w[i] <= 0) continue;
    const c = COMBOS[i].cards;
    if (d.has(c[0]) || d.has(c[1])) continue;
    const moves = postflopMoves(handFeatures(c, board), spot);
    const pf = moves.find((m) => m.kind === "fold")?.prob ?? 0;
    total += w[i];
    fold += w[i] * pf;
    cont[i] = w[i] * (1 - pf);
  }
  return { foldProb: total ? fold / total : 0, cont };
}

export const cardsText = (cs: Card[]) => cs.map(cardLabel).join(" ");
