import { ALL_HANDS, combosOf, rankOf, suitOf, type Card, type HandClass } from "../poker/cards";
import { evaluate } from "../poker/evaluator";

/** Every two-card combo once, grouped by hand class (1326 total). */
export const COMBOS: { cards: [Card, Card]; hand: HandClass }[] = ALL_HANDS.flatMap((h) =>
  combosOf(h).map((cards) => ({ cards, hand: h })),
);

/**
 * Rough postflop hand strength used by the bots (and to explain spots):
 * 0 air · 1 weak (bottom pair, ace high) · 1.5 draw · 2 medium pair
 * 2.5 combo draw · 3 strong (top pair good kicker, overpair) · 4 monster (two pair+)
 */
export type Tier = 0 | 1 | 1.5 | 2 | 2.5 | 3 | 4;

export interface HandFeatures {
  tier: Tier;
  label: string;
  flushDraw: boolean;
  straightDraw: "oesd" | "gutshot" | null;
}

const TIER_LABEL: Record<Tier, string> = {
  0: "노페어",
  1: "약한 메이드(바텀페어·A하이)",
  1.5: "드로우",
  2: "미들 페어급",
  2.5: "콤보 드로우",
  3: "강한 원페어(탑페어 굿키커·오버페어)",
  4: "투페어 이상",
};

function straightDraw(hole: Card[], board: Card[]): "oesd" | "gutshot" | null {
  const all = [...hole, ...board];
  const mask = (cards: Card[]) => {
    let m = 0;
    for (const c of cards) {
      const r = rankOf(c);
      m |= 1 << (r + 1); // bit 1..13 = 2..A
      if (r === 12) m |= 1; // ace also low
    }
    return m;
  };
  const m = mask(all);
  const holeMask = mask(hole);
  // already a straight? then no draw
  for (let lo = 0; lo <= 9; lo++) if (((m >> lo) & 0x1f) === 0x1f) return null;
  let oesd = false, gut = false;
  for (let lo = 0; lo <= 9; lo++) {
    const w = (m >> lo) & 0x1f;
    const bits = [0, 1, 2, 3, 4].filter((i) => w & (1 << i)).length;
    if (bits !== 4) continue;
    const usesHole = ((holeMask >> lo) & 0x1f & w) !== 0;
    if (!usesHole) continue;
    // missing card at an end of a 4-run with room on both sides = open-ended
    const missing = [0, 1, 2, 3, 4].find((i) => !(w & (1 << i)))!;
    if ((missing === 0 && lo + 5 <= 13) || (missing === 4 && lo >= 1)) oesd = true;
    else gut = true;
  }
  return oesd ? "oesd" : gut ? "gutshot" : null;
}

function hasFlushDraw(hole: Card[], board: Card[]): boolean {
  if (board.length >= 5) return false;
  for (let s = 0; s < 4; s++) {
    const n = [...hole, ...board].filter((c) => suitOf(c) === s).length;
    if (n === 4 && hole.some((c) => suitOf(c) === s)) return true;
  }
  return false;
}

export function handFeatures(hole: Card[], board: Card[]): HandFeatures {
  const score = evaluate([...hole, ...board]);
  const cat = score >> 20;
  const boardRanks = board.map(rankOf).sort((a, b) => b - a);
  const top = boardRanks[0];
  const boardCat = evaluate(board) >> 20;
  const [h1, h2] = hole.map(rankOf).sort((a, b) => b - a);
  const pocket = h1 === h2;
  const fd = hasFlushDraw(hole, board);
  const sd = board.length < 5 ? straightDraw(hole, board) : null;

  let tier: Tier = 0;
  if (cat >= 4 && cat > boardCat) tier = 4; // straight, flush, full house... using my cards
  else if (cat === 3 && (pocket || boardRanks.includes(h1) || boardRanks.includes(h2)) && boardCat < 3) tier = 4; // set / trips
  else if (cat === 2 && boardRanks.includes(h1) && boardRanks.includes(h2) && !pocket) tier = 4; // two pair with both cards
  else {
    // one effective pair (pocket pair, or a hole card pairing the board)
    if (pocket && !boardRanks.includes(h1)) {
      if (h1 > top) tier = h1 >= 8 ? 3 : 2; // overpair (TT+ strong)
      else if (h1 > (boardRanks[1] ?? -1)) tier = 2;
      else tier = 1;
    } else {
      const paired = [h1, h2].filter((r) => boardRanks.includes(r));
      if (paired.length) {
        const r = Math.max(...paired);
        const kicker = r === h1 ? h2 : h1;
        if (r === top) tier = kicker >= 8 || r === 12 ? 3 : 2;
        else if (r > boardRanks[boardRanks.length - 1]) tier = 2;
        else tier = 1;
      } else if (h1 === 12) tier = 1; // ace high
    }
  }

  if (tier < 2 && (fd || sd === "oesd")) tier = 1.5;
  if (tier <= 2 && fd && sd) tier = 2.5;
  return { tier, label: TIER_LABEL[tier], flushDraw: fd, straightDraw: sd };
}
