import { makeCard, suitOf, type Card } from "../../poker/cards";

/**
 * Suit guessing: the player remembers ranks ("A K suited", "Q 7 2 rainbow", "turn 9, no flush")
 * but not the exact suits. These helpers turn ranks plus a rough suit description into concrete
 * cards that never clash with cards already known (`taken`).
 *
 * Every choice is deterministic. When several suits fit, the guess prefers suits that do not invent
 * flush draws, and after that the fixed order spades, hearts, diamonds, clubs (cards.ts suits 0..3).
 */

export type HoleKind = "suited" | "offsuit" | "unknown";
export type FlopTexture = "rainbow" | "twotone" | "monotone" | "unknown";
export type NextSuitMode = "newSuit" | "flushSuit" | "unknown";

/** Fixed suit preference when nothing else decides: s, h, d, c. */
const SUIT_ORDER = [0, 1, 2, 3] as const;

const isRank = (r: unknown): r is number => typeof r === "number" && Number.isInteger(r) && r >= 0 && r <= 12;

function suitCounts(cards: Card[]): number[] {
  const n = [0, 0, 0, 0];
  for (const c of cards) n[suitOf(c)]++;
  return n;
}

/** Lexicographic "a is better than b" for cost keys (lower wins). */
function better(a: number[], b: number[] | null): boolean {
  if (!b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * Cost of a hole card's suit given how many board cards share it. Sharing with two or more board
 * cards (a flush draw or a made flush) costs far more than sharing with one (only a backdoor).
 */
const holeSuitCost = (boardCount: number) => (boardCount >= 2 ? 10 * boardCount : boardCount);

/**
 * Two concrete hole cards with ranks r1 and r2 (returned in that order).
 * - "suited": same suit, "offsuit": different suits. Pairs are always offsuit.
 * - "unknown": offsuit, unless only a suited combo is still free.
 * Never uses a card in `taken` (or on `board`). `board` steers suits away from flush draws: a hole card
 * avoids a suit that two or more board cards share when the kind allows. It defaults to `taken`.
 * Returns null when no combo fits.
 */
export function holeFromRanks(r1: number, r2: number, kind: HoleKind, taken: Card[], board: Card[] = taken): Card[] | null {
  if (!isRank(r1) || !isRank(r2)) return null;
  const used = new Set<Card>([...taken, ...board]);
  const counts = suitCounts(board);
  // The higher rank takes the preferred suit, so (A, K) and (K, A) give the same two cards.
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const pair = hi === lo;

  const pick = (suited: boolean): [Card, Card] | null => {
    let best: [Card, Card] | null = null;
    let bestKey: number[] | null = null;
    for (const s1 of SUIT_ORDER) {
      for (const s2 of SUIT_ORDER) {
        if (suited ? s1 !== s2 : s1 === s2) continue;
        if (pair && s2 < s1) continue; // each pair of suits once, lower suit first
        const a = makeCard(hi, s1);
        const b = makeCard(lo, s2);
        if (used.has(a) || used.has(b)) continue;
        const key = [holeSuitCost(counts[s1]) + holeSuitCost(counts[s2])];
        if (better(key, bestKey)) {
          bestKey = key;
          best = [a, b];
        }
      }
    }
    return best;
  };

  let got: [Card, Card] | null;
  if (pair || kind === "offsuit") got = pick(false);
  else if (kind === "suited") got = pick(true);
  else got = pick(false) ?? pick(true);
  if (!got) return null;
  return r1 >= r2 ? [got[0], got[1]] : [got[1], got[0]];
}

/**
 * Three concrete flop cards with the given ranks (returned in the same order).
 * - "rainbow": three suits. "monotone": one suit (null for a paired or trips flop).
 * - "twotone": exactly two cards share a suit. Which two: `suitedPair` (indexes into `ranks`) when given,
 *   else the two highest ranks, then the highest with the lowest, then the two lowest (a pair can't share).
 * - "unknown": rainbow, else two-tone, else monotone (whatever `taken` still allows).
 * Never uses a card in `taken`. Among fitting flops it prefers suits that `taken` holds least (so known
 * hole cards don't get invented flush draws), then the fixed suit order with the highest rank first.
 * Returns null when impossible.
 */
export function flopFromRanks(
  ranks: [number, number, number],
  texture: FlopTexture,
  taken: Card[],
  suitedPair?: [number, number],
): Card[] | null {
  if (!Array.isArray(ranks) || ranks.length !== 3 || !ranks.every(isRank)) return null;
  if (suitedPair) {
    const [i, j] = suitedPair;
    if (![i, j].every((x) => Number.isInteger(x) && x >= 0 && x <= 2) || i === j) return null;
  }
  const used = new Set<Card>(taken);
  const held = suitCounts(taken);
  // Input indexes from the highest rank down (ties keep input order).
  const order = [0, 1, 2].sort((i, j) => ranks[j] - ranks[i] || i - j);
  const pairings: [number, number][] = [
    [order[0], order[1]],
    [order[0], order[2]],
    [order[1], order[2]],
  ];
  const samePair = (p: [number, number], i: number, j: number) => (p[0] === i && p[1] === j) || (p[0] === j && p[1] === i);

  const tryTexture = (tex: "rainbow" | "twotone" | "monotone"): Card[] | null => {
    let best: Card[] | null = null;
    let bestKey: number[] | null = null;
    for (const a of SUIT_ORDER) {
      for (const b of SUIT_ORDER) {
        for (const c of SUIT_ORDER) {
          const suits = [0, 0, 0];
          suits[order[0]] = a;
          suits[order[1]] = b;
          suits[order[2]] = c;
          const cards = ranks.map((r, i) => makeCard(r, suits[i]));
          if (new Set(cards).size < 3 || cards.some((x) => used.has(x))) continue;
          const distinct = new Set(suits).size;
          let pairRank = 0;
          if (tex === "rainbow" && distinct !== 3) continue;
          if (tex === "monotone" && distinct !== 1) continue;
          if (tex === "twotone") {
            if (distinct !== 2) continue;
            const [i, j] = suits[0] === suits[1] ? [0, 1] : suits[0] === suits[2] ? [0, 2] : [1, 2];
            if (suitedPair && !samePair(suitedPair, i, j)) continue;
            pairRank = pairings.findIndex((p) => samePair(p, i, j));
          }
          const key = [pairRank, held[suits[0]] + held[suits[1]] + held[suits[2]]];
          if (better(key, bestKey)) {
            bestKey = key;
            best = cards;
          }
        }
      }
    }
    return best;
  };

  if (texture === "rainbow") return tryTexture("rainbow");
  if (texture === "twotone") return tryTexture("twotone");
  if (texture === "monotone") return tryTexture("monotone");
  return tryTexture("rainbow") ?? tryTexture("twotone") ?? tryTexture("monotone");
}

/**
 * The next board card (turn or river) of the given rank.
 * - "newSuit": a suit that keeps every suit on the board below three cards when possible (no flush
 *   possible from it), and among those the suit the board and `taken` hold least.
 * - "flushSuit": the suit most present on the board (ties: fixed suit order). Null when that rank is
 *   already used in every such suit.
 * - "unknown": same as "newSuit".
 * Never uses a card on `board` or in `taken`. Returns null when impossible.
 */
export function nextBoardCard(rank: number, board: Card[], mode: NextSuitMode, taken: Card[]): Card | null {
  if (!isRank(rank)) return null;
  const used = new Set<Card>([...board, ...taken]);
  const onBoard = suitCounts(board);
  const boardSet = new Set<Card>(board);
  const held = suitCounts(taken.filter((c) => !boardSet.has(c)));
  const open = SUIT_ORDER.filter((s) => !used.has(makeCard(rank, s)));
  if (!open.length) return null;

  if (mode === "flushSuit") {
    const most = Math.max(...onBoard);
    const s = open.find((x) => onBoard[x] === most);
    return s === undefined ? null : makeCard(rank, s);
  }

  let best: number | null = null;
  let bestKey: number[] | null = null;
  for (const s of open) {
    const key = [onBoard[s] + 1 >= 3 ? 1 : 0, onBoard[s] + held[s]];
    if (better(key, bestKey)) {
      bestKey = key;
      best = s;
    }
  }
  return best === null ? null : makeCard(rank, best);
}

// ───────────── marking guessed suits on a hand ─────────────

/** Which suits of a logged hand were guessed: my hole cards, and board cards by index (0-2 flop, 3 turn, 4 river). */
export type SuitGuess = { hole?: true; board?: number[] };

/** A stored guess marker with only valid fields (board indexes unique, sorted, 0..4), or undefined when empty. */
export function cleanGuess(x: unknown): SuitGuess | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const out: SuitGuess = {};
  if (o.hole === true) out.hole = true;
  if (Array.isArray(o.board)) {
    const idx = [...new Set(o.board.filter((i): i is number => Number.isInteger(i) && i >= 0 && i <= 4))].sort((a, b) => a - b);
    if (idx.length) out.board = idx;
  }
  return out.hole || out.board ? out : undefined;
}

/** Marks (on = true) or unmarks board card indexes as guessed. */
export function setBoardGuess(g: SuitGuess | undefined, indexes: number[], on: boolean): SuitGuess | undefined {
  const now = new Set(g?.board ?? []);
  for (const i of indexes) {
    if (on) now.add(i);
    else now.delete(i);
  }
  return cleanGuess({ ...g, board: [...now] });
}

/** Marks or unmarks my hole cards as guessed. */
export function setHoleGuess(g: SuitGuess | undefined, on: boolean): SuitGuess | undefined {
  return cleanGuess({ ...g, hole: on ? true : undefined });
}

/** Short Korean label for the UI, e.g. "핸드 무늬 추정", "핸드·플랍·턴 무늬 추정"; "" when nothing was guessed. */
export function describeGuess(g: SuitGuess | undefined | null): string {
  const clean = cleanGuess(g);
  if (!clean) return "";
  const parts: string[] = [];
  if (clean.hole) parts.push("핸드");
  const idx = clean.board ?? [];
  if (idx.some((i) => i <= 2)) parts.push("플랍");
  if (idx.includes(3)) parts.push("턴");
  if (idx.includes(4)) parts.push("리버");
  return `${parts.join("·")} 무늬 추정`;
}
