// Card = rank * 4 + suit. rank 0..12 = 2..A, suit 0..3 = s h d c
export type Card = number;
export type HandClass = string; // "AA", "AKs", "AKo"

export const RANKS = "23456789TJQKA";
export const SUITS = "shdc";
export const SUIT_SYMBOL: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** Rank order used by the 13x13 chart, high to low. */
export const GRID_RANKS = "AKQJT98765432";

export const rankOf = (c: Card) => c >> 2;
export const suitOf = (c: Card) => c & 3;
export const makeCard = (rank: number, suit: number): Card => rank * 4 + suit;

export function cardFromString(s: string): Card {
  const r = RANKS.indexOf(s[0].toUpperCase());
  const su = SUITS.indexOf(s[1].toLowerCase());
  if (r < 0 || su < 0) throw new Error(`잘못된 카드: ${s}`);
  return makeCard(r, su);
}

export function cardToString(c: Card): string {
  return RANKS[rankOf(c)] + SUITS[suitOf(c)];
}

/** "AsKd" -> [As, Kd] */
export function parseCards(s: string): Card[] {
  const clean = s.replace(/[\s,]/g, "");
  if (clean.length % 2 !== 0) throw new Error(`잘못된 카드 문자열: ${s}`);
  const out: Card[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(cardFromString(clean.slice(i, i + 2)));
  return out;
}

export function fullDeck(): Card[] {
  return Array.from({ length: 52 }, (_, i) => i);
}

/** Hand class for the chart cell at (row, col). Upper-right = suited, lower-left = offsuit. */
export function gridHand(row: number, col: number): HandClass {
  const a = GRID_RANKS[row];
  const b = GRID_RANKS[col];
  if (row === col) return a + b;
  return row < col ? a + b + "s" : b + a + "o";
}

export const ALL_HANDS: HandClass[] = (() => {
  const out: HandClass[] = [];
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) out.push(gridHand(r, c));
  return out;
})();

export function isPair(h: HandClass) {
  return h.length === 2;
}

export function comboCount(h: HandClass): number {
  if (isPair(h)) return 6;
  return h[2] === "s" ? 4 : 12;
}

/** All concrete two-card combos of a hand class. */
export function combosOf(h: HandClass): [Card, Card][] {
  const r1 = RANKS.indexOf(h[0]);
  const r2 = RANKS.indexOf(h[1]);
  const out: [Card, Card][] = [];
  if (isPair(h)) {
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = s1 + 1; s2 < 4; s2++) out.push([makeCard(r1, s1), makeCard(r1, s2)]);
  } else if (h[2] === "s") {
    for (let s = 0; s < 4; s++) out.push([makeCard(r1, s), makeCard(r2, s)]);
  } else {
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([makeCard(r1, s1), makeCard(r2, s2)]);
  }
  return out;
}

export function handClassOf(a: Card, b: Card): HandClass {
  let hi = a, lo = b;
  if (rankOf(b) > rankOf(a)) { hi = b; lo = a; }
  const r1 = RANKS[rankOf(hi)];
  const r2 = RANKS[rankOf(lo)];
  if (r1 === r2) return r1 + r2;
  return r1 + r2 + (suitOf(hi) === suitOf(lo) ? "s" : "o");
}

/** Random concrete combo of a hand class, avoiding dead cards. */
export function randomCombo(h: HandClass, dead: Card[] = []): [Card, Card] {
  const options = combosOf(h).filter(([a, b]) => !dead.includes(a) && !dead.includes(b));
  return options[Math.floor(Math.random() * options.length)];
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Human-readable card for prompts, e.g. "A♠". */
export function cardLabel(c: Card): string {
  return RANKS[rankOf(c)] + SUIT_SYMBOL[SUITS[suitOf(c)]];
}
