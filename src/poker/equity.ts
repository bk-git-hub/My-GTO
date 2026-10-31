import { ALL_HANDS, combosOf, type Card } from "./cards";
import { evaluate } from "./evaluator";
import type { Range } from "./range";

export interface EquityResult {
  win: number;
  tie: number;
  lose: number;
  /** win + tie / 2, 0..1 */
  equity: number;
  samples: number;
  exact: boolean;
}

const hero7 = new Array<Card>(7);
const vill7 = new Array<Card>(7);

function remainingDeck(dead: Card[]): Card[] {
  const used = new Set(dead);
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) out.push(c);
  return out;
}

function finish(win: number, tie: number, lose: number, exact: boolean): EquityResult {
  const n = win + tie + lose;
  return {
    win: win / n,
    tie: tie / n,
    lose: lose / n,
    equity: (win + tie / 2) / n,
    samples: n,
    exact,
  };
}

/** Compare hero vs villain on a full 5-card board. 1 = hero wins, 0 = tie, -1 = lose. */
function showdown(hero: Card[], villain: Card[], board: Card[]): number {
  hero7[0] = hero[0]; hero7[1] = hero[1];
  vill7[0] = villain[0]; vill7[1] = villain[1];
  for (let i = 0; i < 5; i++) { hero7[i + 2] = board[i]; vill7[i + 2] = board[i]; }
  const h = evaluate(hero7, 7);
  const v = evaluate(vill7, 7);
  return h > v ? 1 : h < v ? -1 : 0;
}

/**
 * Hand vs hand. Exact enumeration when the board has 3+ cards,
 * Monte Carlo preflop.
 */
export function equityVsHand(
  hero: Card[],
  villain: Card[],
  board: Card[] = [],
  iterations = 30000,
): EquityResult {
  const deck = remainingDeck([...hero, ...villain, ...board]);
  const need = 5 - board.length;
  let win = 0, tie = 0, lose = 0;
  const full = board.slice();
  const tally = (r: number) => (r > 0 ? win++ : r < 0 ? lose++ : tie++);

  if (need === 0) {
    tally(showdown(hero, villain, board));
    return finish(win, tie, lose, true);
  }
  if (need === 1) {
    for (const c of deck) { full[4] = c; tally(showdown(hero, villain, full)); }
    return finish(win, tie, lose, true);
  }
  if (need === 2) {
    for (let i = 0; i < deck.length; i++)
      for (let j = i + 1; j < deck.length; j++) {
        full[3] = deck[i]; full[4] = deck[j];
        tally(showdown(hero, villain, full));
      }
    return finish(win, tie, lose, true);
  }

  for (let it = 0; it < iterations; it++) {
    dealRandom(deck, board, need, full);
    tally(showdown(hero, villain, full));
  }
  return finish(win, tie, lose, false);
}

/** Fill `out` with `board` plus `need` random distinct cards from `deck` (partial Fisher-Yates). */
function dealRandom(deck: Card[], board: Card[], need: number, out: Card[]) {
  for (let i = 0; i < board.length; i++) out[i] = board[i];
  const n = deck.length;
  for (let k = 0; k < need; k++) {
    const j = k + Math.floor(Math.random() * (n - k));
    const tmp = deck[k]; deck[k] = deck[j]; deck[j] = tmp;
    out[board.length + k] = deck[k];
  }
}

interface WeightedCombo { cards: [Card, Card]; cum: number }

/** Hero vs a weighted range (Monte Carlo; exact on the river). */
export function equityVsRange(
  hero: Card[],
  range: Range,
  board: Card[] = [],
  iterations = 20000,
): EquityResult {
  const dead = new Set([...hero, ...board]);
  const combos: WeightedCombo[] = [];
  let total = 0;
  for (const h of ALL_HANDS) {
    const w = range[h] ?? 0;
    if (w <= 0) continue;
    for (const combo of combosOf(h)) {
      if (dead.has(combo[0]) || dead.has(combo[1])) continue;
      total += w;
      combos.push({ cards: combo, cum: total });
    }
  }
  if (combos.length === 0) throw new Error("상대 레인지에 가능한 조합이 없어요.");

  let win = 0, tie = 0, lose = 0;
  const tally = (r: number, w = 1) => (r > 0 ? (win += w) : r < 0 ? (lose += w) : (tie += w));

  if (board.length === 5) {
    let prev = 0;
    for (const c of combos) {
      tally(showdown(hero, c.cards, board), c.cum - prev);
      prev = c.cum;
    }
    return finish(win, tie, lose, true);
  }

  const need = 5 - board.length;
  const full = board.slice();
  const baseDeck = remainingDeck([...hero, ...board]);
  for (let it = 0; it < iterations; it++) {
    const villain = pickWeighted(combos, Math.random() * total);
    const deck = baseDeck.filter((c) => c !== villain[0] && c !== villain[1]);
    dealRandom(deck, board, need, full);
    tally(showdown(hero, villain, full));
  }
  return finish(win, tie, lose, false);
}

function pickWeighted(combos: WeightedCombo[], x: number): [Card, Card] {
  let lo = 0, hi = combos.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (combos[mid].cum < x) lo = mid + 1;
    else hi = mid;
  }
  return combos[lo].cards;
}

/**
 * Cards on the next street that put hero ahead (by current made hand),
 * for teaching "outs". Only meaningful on the flop or turn.
 */
export function countOuts(hero: Card[], villain: Card[], board: Card[]): { outs: Card[]; total: number } {
  const deck = remainingDeck([...hero, ...villain, ...board]);
  const outs: Card[] = [];
  const n = board.length + 3;
  const h = new Array<Card>(n);
  const v = new Array<Card>(n);
  for (const c of deck) {
    h[0] = hero[0]; h[1] = hero[1]; v[0] = villain[0]; v[1] = villain[1];
    for (let i = 0; i < board.length; i++) { h[i + 2] = board[i]; v[i + 2] = board[i]; }
    h[n - 1] = c; v[n - 1] = c;
    if (evaluate(h, n) > evaluate(v, n)) outs.push(c);
  }
  return { outs, total: deck.length };
}
