/**
 * Flop classes for the presolve pipeline: the 1755 suit-isomorphism classes of the 22100 flops, their texture,
 * and a priority order whose every prefix is a well-spread representative subset.
 *
 * The enumeration and canonicalization live in format.ts (`flopClasses`, `canonicalBoard`), so the pipeline and
 * the app agree on board keys; this module adds textures, a distance between textures, the priority order and
 * the weights that map every class onto its nearest solved representative.
 */
import { RANKS, parseCards, rankOf, suitOf, type Card } from "../poker/cards";
import { RAW_FLOPS, canonicalBoard, flopClasses } from "./format";

export type Height = "high" | "middle" | "low";
export type Pairing = "unpaired" | "paired" | "trips";
export type Suitedness = "rainbow" | "twotone" | "monotone";
export type Connectedness = "connected" | "gapped" | "dry";

export interface FlopTexture {
  /** Ranks high to low (0 = deuce … 12 = ace). */
  ranks: [number, number, number];
  /** Top card: high = T or better, middle = 8–9, low = 7 or lower. */
  height: Height;
  pairing: Pairing;
  suits: Suitedness;
  /** connected: three ranks within 3 (987, JT8); gapped: a straight is still possible (span ≤ 4); dry: no straight. */
  connect: Connectedness;
  /** Board cards T or higher. */
  broadways: number;
  /** A straight can be made with two hole cards (three distinct ranks within a span of 4, ace low or high). */
  straightPossible: boolean;
  /** A flush draw or better is possible (at least two cards share a suit). */
  flushPossible: boolean;
}

export interface FlopInfo {
  /** Canonical board key, e.g. "AsKh7d". */
  key: string;
  cards: Card[];
  /** Raw flops in this suit-isomorphism class (4, 12 or 24). */
  weight: number;
  texture: FlopTexture;
}

// ───────────────────────── texture ─────────────────────────

/** Smallest span (max − min) covering the distinct ranks, the ace also counting as a one. */
function rankSpan(distinct: number[]): number {
  const spans = (rs: number[]) => Math.max(...rs) - Math.min(...rs);
  let best = spans(distinct);
  if (distinct.includes(12)) best = Math.min(best, spans(distinct.map((r) => (r === 12 ? -1 : r))));
  return best;
}

export function flopTexture(cards: Card[]): FlopTexture {
  if (cards.length !== 3) throw new Error("a flop has three cards");
  const ranks = cards.map(rankOf).sort((a, b) => b - a) as [number, number, number];
  const distinct = [...new Set(ranks)];
  const pairing: Pairing = distinct.length === 3 ? "unpaired" : distinct.length === 2 ? "paired" : "trips";
  const suitCounts = [0, 0, 0, 0];
  for (const c of cards) suitCounts[suitOf(c)]++;
  const maxSuit = Math.max(...suitCounts);
  const suits: Suitedness = maxSuit === 3 ? "monotone" : maxSuit === 2 ? "twotone" : "rainbow";
  const span = distinct.length === 3 ? rankSpan(distinct) : 99;
  const connect: Connectedness = span <= 3 ? "connected" : span <= 4 ? "gapped" : "dry";
  const top = ranks[0];
  return {
    ranks,
    height: top >= 8 ? "high" : top >= 6 ? "middle" : "low",
    pairing,
    suits,
    connect,
    broadways: ranks.filter((r) => r >= 8).length,
    straightPossible: span <= 4,
    flushPossible: maxSuit >= 2,
  };
}

/** "A K 7 레인보우" style one-line Korean description (for logs and the viewer). */
export function describeTexture(t: FlopTexture): string {
  const ranks = t.ranks.map((r) => RANKS[r]).join("");
  const suits = { rainbow: "레인보우", twotone: "투톤", monotone: "모노톤" }[t.suits];
  const pair = { unpaired: "", paired: " 페어", trips: " 트립스" }[t.pairing];
  const conn = t.pairing !== "unpaired" ? "" : { connected: " 커넥티드", gapped: " 갭", dry: "" }[t.connect];
  return `${ranks} ${suits}${pair}${conn}`;
}

// ───────────────────────── feature space ─────────────────────────

/**
 * Texture features used for distances. Units are chosen so that one "step" of each texture dimension is worth
 * about the same: the top card's rank matters most, then flush texture, pairing and straight texture.
 */
const DIM = 9;

function features(cards: Card[], t: FlopTexture): number[] {
  const [r1, r2, r3] = t.ranks.map((r) => r / 12);
  const suitCounts = [0, 0, 0, 0];
  for (const c of cards) suitCounts[suitOf(c)]++;
  // Height of the suited cards (flush draws on high cards hit the opener's suited broadways more).
  let suitedHigh = 0;
  if (t.suits === "twotone") {
    const s = suitCounts.indexOf(2);
    suitedHigh = Math.max(...cards.filter((c) => suitOf(c) === s).map(rankOf)) / 12;
  } else if (t.suits === "monotone") suitedHigh = 1;
  const distinct = [...new Set(t.ranks)];
  const span = distinct.length === 3 ? rankSpan(distinct) : distinct.length === 2 ? rankSpan(distinct) + 4 : 12;
  const straightness = Math.max(0, 1 - Math.max(0, span - 2) / 6); // 1 for three in a row, 0 for very dry
  return [
    1.6 * r1,
    1.0 * r2,
    0.7 * r3,
    t.pairing === "unpaired" ? 0 : t.pairing === "paired" ? 0.7 : 1.0,
    t.suits === "rainbow" ? 0 : t.suits === "twotone" ? 0.45 : 0.9,
    0.15 * suitedHigh,
    0.45 * straightness,
    0.1 * (t.broadways / 3),
    t.straightPossible ? 0.15 : 0,
  ];
}

const ALL: readonly FlopInfo[] = flopClasses().map((c) => ({ key: c.key, cards: c.cards.slice(), weight: c.weight, texture: flopTexture(c.cards) }));
const INDEX = new Map(ALL.map((f, i) => [f.key, i] as const));
const FEAT = (() => {
  const f = new Float64Array(ALL.length * DIM);
  ALL.forEach((c, i) => f.set(features(c.cards, c.texture), i * DIM));
  return f;
})();

function dist(i: number, j: number): number {
  let s = 0;
  const a = i * DIM, b = j * DIM;
  for (let k = 0; k < DIM; k++) {
    const d = FEAT[a + k] - FEAT[b + k];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Texture distance between two flops (any suits; both are canonicalized first). */
export function flopDistance(a: Card[] | string, b: Card[] | string): number {
  return dist(classIndex(a), classIndex(b));
}

function classIndex(board: Card[] | string): number {
  if (typeof board === "string") {
    const hit = INDEX.get(board);
    if (hit !== undefined) return hit;
  }
  const cards = typeof board === "string" ? parseCards(board) : board;
  const i = cards.length === 3 && new Set(cards).size === 3 ? INDEX.get(canonicalBoard(cards).key) : undefined;
  if (i === undefined) throw new Error(`not a flop: ${String(board)}`);
  return i;
}

// ───────────────────────── priority order ─────────────────────────

/**
 * Greedy weighted k-median: start from the weighted medoid, then repeatedly add the class that most reduces
 * Σ weight × distance to the nearest chosen class (lazy evaluation; the gain only shrinks as classes are
 * added). Every prefix is therefore a representative subset for its size. Deterministic: ties go to the
 * earlier class in flopClasses() order (high boards first).
 */
function priorityOrder(): number[] {
  const N = ALL.length;
  const w = ALL.map((c) => c.weight);
  const order: number[] = [];
  const chosen = new Uint8Array(N);
  // Weighted medoid.
  let best = 0, bestCost = Infinity;
  for (let c = 0; c < N; c++) {
    let cost = 0;
    for (let i = 0; i < N; i++) cost += w[i] * dist(i, c);
    if (cost < bestCost - 1e-12) (best = c), (bestCost = cost);
  }
  const cur = new Float64Array(N);
  for (let i = 0; i < N; i++) cur[i] = dist(i, best);
  order.push(best);
  chosen[best] = 1;
  const gain = (c: number): number => {
    let g = 0;
    for (let i = 0; i < N; i++) {
      const d = cur[i] - dist(i, c);
      if (d > 0) g += w[i] * d;
    }
    return g;
  };
  const ub = new Float64Array(N);
  for (let c = 0; c < N; c++) ub[c] = chosen[c] ? -1 : gain(c);
  const fresh = new Int32Array(N).fill(1); // ub[c] was computed at step fresh[c]
  for (let step = 1; step < N; step++) {
    for (;;) {
      let top = -1;
      for (let c = 0; c < N; c++) if (!chosen[c] && (top < 0 || ub[c] > ub[top] + 1e-12)) top = c;
      if (fresh[top] === step) {
        order.push(top);
        chosen[top] = 1;
        for (let i = 0; i < N; i++) {
          const d = dist(i, top);
          if (d < cur[i]) cur[i] = d;
        }
        break;
      }
      ub[top] = gain(top);
      fresh[top] = step;
    }
  }
  return order;
}

/** All 1755 flop classes, most representative first: every prefix is a well-spread subset of textures. */
export const FLOPS_BY_PRIORITY: readonly FlopInfo[] = priorityOrder().map((i) => ALL[i]);

/** All 1755 flop classes in flopClasses() order (high boards first), with textures. */
export const FLOP_INFOS: readonly FlopInfo[] = ALL;

export function flopInfo(board: Card[] | string): FlopInfo {
  return ALL[classIndex(board)];
}

/**
 * Weights for a set of representatives: every one of the 1755 classes is assigned to its nearest representative
 * (by texture distance; a representative always stands for itself; ties go to the earlier one in `keys`), and a
 * representative's weight is the raw flop count of the classes assigned to it. The weights sum to 22100.
 */
export function representativeWeightsFor(keys: readonly string[]): Map<string, number> {
  const reps = keys.map((k) => {
    const i = INDEX.get(k);
    if (i === undefined) throw new Error(`not a canonical flop key: ${k}`);
    return i;
  });
  if (!reps.length) throw new Error("no representatives");
  if (new Set(reps).size !== reps.length) throw new Error("duplicate representatives");
  const out = new Map<string, number>(keys.map((k) => [k, 0]));
  const isRep = new Map(reps.map((r, k) => [r, k] as const));
  for (let i = 0; i < ALL.length; i++) {
    let k = isRep.get(i) ?? -1;
    if (k < 0) {
      let bd = Infinity;
      reps.forEach((r, j) => {
        const d = dist(i, r);
        if (d < bd - 1e-12) (bd = d), (k = j);
      });
    }
    out.set(keys[k], out.get(keys[k])! + ALL[i].weight);
  }
  return out;
}

/** representativeWeightsFor the first n classes of FLOPS_BY_PRIORITY, in that order. Sums to 22100. */
export function representativeWeights(n: number): { key: string; weight: number }[] {
  if (!Number.isInteger(n) || n < 1 || n > ALL.length) throw new Error(`n must be 1..${ALL.length}`);
  const keys = FLOPS_BY_PRIORITY.slice(0, n).map((f) => f.key);
  const m = representativeWeightsFor(keys);
  return keys.map((key) => ({ key, weight: m.get(key)! }));
}

export { RAW_FLOPS };
