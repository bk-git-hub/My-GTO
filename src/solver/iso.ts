import type { Card } from "../poker/cards";
import { COMBOS } from "../play/handInfo";

/**
 * Suit isomorphism (docs/solver.md "Suit isomorphism"): the suit permutations under which a spot is
 * symmetric, and the orbits of the cards a chance node can deal under them.
 *
 * A suit permutation is an index 0..23 into SUIT_PERMS; index 0 is the identity. Cards are rank × 4 + suit,
 * so a permutation g maps card c to (c & ~3) | SUIT_PERMS[g][c & 3].
 */

/** The 24 permutations of the four suits, in lexicographic order: SUIT_PERMS[g][s] is the image of suit s. */
export const SUIT_PERMS: readonly Uint8Array[] = (() => {
  const out: Uint8Array[] = [];
  const rec = (a: number[], used: boolean[]): void => {
    if (a.length === 4) {
      out.push(Uint8Array.from(a));
      return;
    }
    for (let s = 0; s < 4; s++) {
      if (used[s]) continue;
      used[s] = true;
      a.push(s);
      rec(a, used);
      a.pop();
      used[s] = false;
    }
  };
  rec([], [false, false, false, false]);
  return out;
})();

/** The identity permutation's index. */
export const IDENTITY = 0;

const permIndex = (p: ArrayLike<number>): number => SUIT_PERMS.findIndex((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2] && q[3] === p[3]);

/** PERM_INV[g]: the inverse permutation. */
export const PERM_INV: Uint8Array = Uint8Array.from(SUIT_PERMS, (p) => {
  const inv = [0, 0, 0, 0];
  for (let s = 0; s < 4; s++) inv[p[s]] = s;
  return permIndex(inv);
});

/** composePerms(a, b): the permutation "b, then a" (a ∘ b). */
export function composePerms(a: number, b: number): number {
  const pa = SUIT_PERMS[a], pb = SUIT_PERMS[b];
  return permIndex([pa[pb[0]], pa[pb[1]], pa[pb[2]], pa[pb[3]]]);
}

/** The image of a card under suit permutation g. */
export function permCard(g: number, c: Card): Card {
  return (c & ~3) | SUIT_PERMS[g][c & 3];
}

let comboTable: Int32Array | undefined;

/** COMBOS index of the combo made of cards a and b (either order). */
export function comboOf(a: Card, b: Card): number {
  if (!comboTable) {
    comboTable = new Int32Array(52 * 52).fill(-1);
    COMBOS.forEach((c, i) => {
      const [x, y] = c.cards;
      comboTable![x * 52 + y] = i;
      comboTable![y * 52 + x] = i;
    });
  }
  return comboTable[a * 52 + b];
}

const comboPerms: (Int32Array | undefined)[] = [];

/** COMBOS-indexed image of every combo under suit permutation g (cached). */
export function comboPerm(g: number): Int32Array {
  let m = comboPerms[g];
  if (!m) {
    m = Int32Array.from(COMBOS, (c) => comboOf(permCard(g, c.cards[0]), permCard(g, c.cards[1])));
    comboPerms[g] = m;
  }
  return m;
}

/** The weight a combo gets in the solve: w if w > 0 and it doesn't touch the board, else 0 (as hands.ts). */
function liveWeight(range: ArrayLike<number>, i: number, dead: Uint8Array): number {
  const w = i < range.length ? range[i] : 0;
  if (!(w > 0)) return 0;
  const [a, b] = COMBOS[i].cards;
  return dead[a] || dead[b] ? 0 : w;
}

/**
 * The suit permutations under which the spot is symmetric: they map the board onto itself (as a set) and give
 * every combo exactly the weight of its image, in both players' ranges (weights compared with ===, so a weight
 * that differs in the last bit breaks the symmetry). Combos on the board count as weight 0. Always contains
 * the identity (first); the result is a group. The ranges must already be checked (checkRanges).
 */
export function symmetryGroup(board: readonly Card[], ranges: readonly [ArrayLike<number>, ArrayLike<number>]): number[] {
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const w = ranges.map((r) => Float64Array.from({ length: COMBOS.length }, (_, i) => liveWeight(r, i, dead)));
  const out = [IDENTITY];
  for (let g = 1; g < SUIT_PERMS.length; g++) {
    if (!board.every((c) => dead[permCard(g, c)])) continue;
    const m = comboPerm(g);
    let ok = true;
    for (let p = 0; p < 2 && ok; p++) {
      const wp = w[p];
      for (let i = 0; i < COMBOS.length; i++) {
        if (wp[i] !== wp[m[i]]) {
          ok = false;
          break;
        }
      }
    }
    if (ok) out.push(g);
  }
  return out;
}

/** The elements of `group` that fix card c (the symmetry group left once c is dealt). */
export function stabilizer(group: readonly number[], c: Card): number[] {
  return group.filter((g) => permCard(g, c) === c);
}

/**
 * The cards that can come on `board` (those not on it), grouped into orbits under `group`. Each orbit is
 * represented by its smallest card; `reps` lists them ascending. The other cards of the orbit of reps[k] are
 * card[start[k]..start[k+1]), each with a permutation perm[j] of `group` that maps reps[k] to card[j].
 * With the identity group every card is its own representative and `card` is empty.
 */
export interface CardOrbits {
  reps: Card[];
  start: Int32Array;
  card: Uint8Array;
  perm: Uint8Array;
}

export function cardOrbits(board: readonly Card[], group: readonly number[]): CardOrbits {
  const seen = new Uint8Array(52);
  for (const c of board) seen[c] = 1;
  const reps: Card[] = [];
  const start: number[] = [];
  const card: number[] = [];
  const perm: number[] = [];
  for (let c = 0; c < 52; c++) {
    if (seen[c]) continue;
    reps.push(c);
    start.push(card.length);
    seen[c] = 1;
    for (const g of group) {
      const d = permCard(g, c);
      if (seen[d]) continue;
      seen[d] = 1;
      card.push(d);
      perm.push(g);
    }
  }
  start.push(card.length);
  return { reps, start: Int32Array.from(start), card: Uint8Array.from(card), perm: Uint8Array.from(perm) };
}

/**
 * How many copies of the betting skeleton the tree holds at each number of cards dealt after the start
 * (index 0: none, 1: one card, 2: two), dealing only one card per orbit, and how many distinct river boards
 * (as card sets) those deals reach. With the identity group: 1, 52 - L, (52 - L)(51 - L) for an L-card board.
 */
export function dealCounts(board: readonly Card[], group: readonly number[]): { copies: [number, number, number]; riverBoards: number } {
  const copies: [number, number, number] = [1, 0, 0];
  const rivers = new Set<number>();
  const key = (cards: readonly Card[]) => cards.reduce((k, c) => k + 2 ** c, 0);
  if (board.length === 5) rivers.add(key(board));
  if (board.length <= 4) {
    for (const t of cardOrbits(board, group).reps) {
      copies[1]++;
      const bt = [...board, t];
      if (bt.length === 5) {
        rivers.add(key(bt));
        continue;
      }
      for (const r of cardOrbits(bt, stabilizer(group, t)).reps) {
        copies[2]++;
        rivers.add(key([...bt, r]));
      }
    }
  }
  return { copies, riverBoards: rivers.size };
}
