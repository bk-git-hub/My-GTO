import { describe, expect, it } from "vitest";
import { parseCards, type Card } from "../poker/cards";
import { evaluate } from "../poker/evaluator";
import { buildHands, compatibleSums, type HandList } from "./hands";
import { foldValues, makeRiverBoard, RiverCache, showdownValues } from "./showdown";
import { rng } from "./testHelpers";

/** Random range: each combo in with probability `density`, random weight in (0, 1]. */
function randomRange(rand: () => number, density: number): Float64Array {
  const w = new Float64Array(1326);
  for (let i = 0; i < 1326; i++) if (rand() < density) w[i] = 0.05 + 0.95 * rand();
  return w;
}

/** Random reach over a hand list, about a quarter exactly zero. */
function randomReach(rand: () => number, n: number): Float64Array {
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = rand() < 0.25 ? 0 : rand();
  return r;
}

const touches = (hl: HandList, h: number, board: Card[]) => board.includes(hl.c1[h]) || board.includes(hl.c2[h]);
const conflict = (a: HandList, h: number, b: HandList, o: number) =>
  a.c1[h] === b.c1[o] || a.c1[h] === b.c2[o] || a.c2[h] === b.c1[o] || a.c2[h] === b.c2[o];
const strength = (hl: HandList, h: number, board: Card[]) => evaluate([hl.c1[h], hl.c2[h], ...board], 7);

/** Random distinct cards. */
function randomCards(rand: () => number, k: number): Card[] {
  const out: Card[] = [];
  while (out.length < k) {
    const c = Math.floor(rand() * 52);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

describe("card removal sums", () => {
  it("compatibleSums matches a double loop", () => {
    const rand = rng(7);
    for (let trial = 0; trial < 5; trial++) {
      const board = randomCards(rand, 3 + (trial % 3));
      const hands = buildHands(board, [randomRange(rand, 0.3), randomRange(rand, 0.3)]);
      const [me, opp] = hands;
      const ro = randomReach(rand, opp.n);
      const out = new Float64Array(me.n);
      compatibleSums(me, opp, ro, out);
      for (let h = 0; h < me.n; h++) {
        let s = 0;
        for (let o = 0; o < opp.n; o++) if (!conflict(me, h, opp, o)) s += ro[o];
        expect(out[h]).toBeCloseTo(s, 9);
      }
    }
  });
});

describe("fold values", () => {
  it("net × compatible opponent reach, with same combos in both lists", () => {
    const rand = rng(11);
    for (let trial = 0; trial < 6; trial++) {
      const board = randomCards(rand, 3 + (trial % 3));
      const hands = buildHands(board, [randomRange(rand, 0.5), randomRange(rand, 0.5)]);
      let shared = 0;
      for (let h = 0; h < hands[0].n; h++) if (hands[0].same[h] >= 0) shared++;
      expect(shared).toBeGreaterThan(50);
      for (const p of [0, 1]) {
        const me = hands[p], opp = hands[1 - p];
        const ro = randomReach(rand, opp.n);
        const net = (rand() - 0.5) * 40;
        const out = new Float64Array(me.n);
        foldValues(me, opp, ro, net, out);
        for (let h = 0; h < me.n; h++) {
          let s = 0;
          for (let o = 0; o < opp.n; o++) if (!conflict(me, h, opp, o)) s += net * ro[o];
          expect(out[h]).toBeCloseTo(s, 8);
        }
      }
    }
  });
});

describe("showdown values", () => {
  /**
   * Compare against a brute-force double loop over explicit hand pairs on `river`, with hand lists built
   * from `start` (so cards dealt after the start block some hands). Blocked hands must get 0, and the
   * opponent's blocked hands must be ignored even if they carry reach.
   */
  function check(start: Card[], river: Card[], rand: () => number, density: number) {
    const hands = buildHands(start, [randomRange(rand, density), randomRange(rand, density)]);
    const rb = makeRiverBoard(river, hands);
    const pot0 = 1 + rand() * 20;
    const x = rand() * 50;
    let ties = 0;
    for (const p of [0, 1]) {
      const me = hands[p], opp = hands[1 - p];
      const ro = randomReach(rand, opp.n);
      const out = new Float64Array(me.n).fill(123); // garbage that must be overwritten
      showdownValues(rb, p, ro, pot0, x, out);
      const sOpp = Array.from({ length: opp.n }, (_, o) => (touches(opp, o, river) ? 0 : strength(opp, o, river)));
      for (let h = 0; h < me.n; h++) {
        if (touches(me, h, river)) {
          expect(out[h]).toBe(0);
          continue;
        }
        const s = strength(me, h, river);
        let v = 0;
        for (let o = 0; o < opp.n; o++) {
          if (touches(opp, o, river) || conflict(me, h, opp, o)) continue;
          if (s > sOpp[o]) v += (pot0 + x) * ro[o];
          else if (s < sOpp[o]) v -= x * ro[o];
          else {
            v += (pot0 / 2) * ro[o];
            ties++;
          }
        }
        expect(out[h]).toBeCloseTo(v, 8);
      }
    }
    return ties;
  }

  it("matches brute force on random river boards", () => {
    const rand = rng(3);
    let ties = 0;
    for (let trial = 0; trial < 6; trial++) {
      const board = randomCards(rand, 5);
      ties += check(board, board, rand, 0.4);
    }
    expect(ties).toBeGreaterThan(0);
  });

  it("matches brute force when later cards block hands (turn and flop starts)", () => {
    const rand = rng(5);
    for (let trial = 0; trial < 6; trial++) {
      const board = randomCards(rand, 5);
      check(board.slice(0, 3 + (trial % 2)), board, rand, 0.4);
    }
  });

  it("handles boards full of ties", () => {
    const rand = rng(9);
    // Royal flush on board: every hand ties. Quads with an ace kicker: every hand ties too.
    expect(check(parseCards("AhKhQhJhTh"), parseCards("AhKhQhJhTh"), rand, 0.5)).toBeGreaterThan(1000);
    expect(check(parseCards("2c2d2h2sAs"), parseCards("2c2d2h2sAs"), rand, 0.5)).toBeGreaterThan(1000);
    // Paired boards and straights on board: many partial ties.
    check(parseCards("9c9d5h5s5c"), parseCards("9c9d5h5s5c"), rand, 0.5);
    check(parseCards("6c7d8h9sTc"), parseCards("6c7d8h9sTc"), rand, 0.5);
  });

  it("works with full ranges (every combo, same combo in both lists)", () => {
    const rand = rng(13);
    const board = parseCards("Kd8s8c4h2d");
    const one = new Float64Array(1326).fill(1);
    const hands = buildHands(board, [one, one]);
    const rb = makeRiverBoard(board, hands);
    const ro = randomReach(rand, hands[1].n);
    const out = new Float64Array(hands[0].n);
    showdownValues(rb, 0, ro, 10, 5, out);
    // Spot-check a few hands with the double loop.
    for (const h of [0, 17, 300, 777, hands[0].n - 1]) {
      const s = strength(hands[0], h, board);
      let v = 0;
      for (let o = 0; o < hands[1].n; o++) {
        if (conflict(hands[0], h, hands[1], o)) continue;
        const so = strength(hands[1], o, board);
        v += s > so ? 15 * ro[o] : s < so ? -5 * ro[o] : 5 * ro[o];
      }
      expect(out[h]).toBeCloseTo(v, 7);
    }
  });

  it("caches one entry per river card set", () => {
    const hands = buildHands(parseCards("2c3d7h"), [new Float64Array(1326).fill(1), new Float64Array(1326).fill(1)]);
    const cache = new RiverCache(hands);
    const a = cache.get(parseCards("2c3d7hAsKs"));
    const b = cache.get(parseCards("2c3d7hKsAs"));
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
    expect(a.order[0].length + a.blocked[0].length).toBe(hands[0].n);
  });
});
