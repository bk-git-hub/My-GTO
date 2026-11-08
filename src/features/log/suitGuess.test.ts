import { describe, expect, it } from "vitest";
import { makeCard, parseCards, rankOf, suitOf, type Card } from "../../poker/cards";
import {
  cleanGuess,
  describeGuess,
  flopFromRanks,
  holeFromRanks,
  nextBoardCard,
  setBoardGuess,
  setHoleGuess,
  type FlopTexture,
  type HoleKind,
  type NextSuitMode,
} from "./suitGuess";

/** Small seeded PRNG so the random cases are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DECK: Card[] = Array.from({ length: 52 }, (_, i) => i);
const cards = (s: string) => parseCards(s);
const str = (cs: Card[] | null) => (cs ? cs.map((c) => "23456789TJQKA"[rankOf(c)] + "shdc"[suitOf(c)]).join("") : null);
const suitCount = (cs: Card[], s: number) => cs.filter((c) => suitOf(c) === s).length;
const textureOf = (cs: Card[]): Exclude<FlopTexture, "unknown"> => {
  const n = new Set(cs.map(suitOf)).size;
  return n === 3 ? "rainbow" : n === 2 ? "twotone" : "monotone";
};

/** Every hole combo with ranks (r1, r2) that a kind allows, ignoring `taken`'s board preference. */
function holeOptions(r1: number, r2: number, kind: HoleKind, taken: Set<Card>): Card[][] {
  const out = (suited: boolean) => {
    const res: Card[][] = [];
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = 0; s2 < 4; s2++) {
        if (suited ? s1 !== s2 : s1 === s2) continue;
        const a = makeCard(r1, s1);
        const b = makeCard(r2, s2);
        if (a === b || taken.has(a) || taken.has(b)) continue;
        res.push([a, b]);
      }
    return res;
  };
  if (r1 === r2 || kind === "offsuit") return out(false);
  if (kind === "suited") return out(true);
  const off = out(false);
  return off.length ? off : out(true);
}

describe("holeFromRanks", () => {
  it("picks the fixed suit order when nothing else decides", () => {
    expect(str(holeFromRanks(12, 11, "offsuit", []))).toBe("AsKh");
    expect(str(holeFromRanks(12, 11, "suited", []))).toBe("AsKs");
    expect(str(holeFromRanks(12, 11, "unknown", []))).toBe("AsKh");
    expect(str(holeFromRanks(12, 12, "offsuit", []))).toBe("AsAh");
    // ranks come back in the order asked, with the same suits either way round
    expect(str(holeFromRanks(11, 12, "offsuit", []))).toBe("KhAs");
    expect(str(holeFromRanks(0, 5, "suited", []))).toBe("2s7s");
  });

  it("treats pairs as offsuit whatever the kind", () => {
    for (const kind of ["suited", "offsuit", "unknown"] as HoleKind[]) {
      const got = holeFromRanks(8, 8, kind, [])!;
      expect(rankOf(got[0])).toBe(8);
      expect(rankOf(got[1])).toBe(8);
      expect(suitOf(got[0])).not.toBe(suitOf(got[1]));
    }
  });

  it("stays off flush draws on the board when the kind allows", () => {
    // two spades on the board: neither hole card takes a spade, and the backdoor hearts are skipped too
    expect(str(holeFromRanks(12, 11, "offsuit", cards("QsJs2h")))).toBe("AdKc");
    expect(str(holeFromRanks(12, 11, "suited", cards("QsJs2h")))).toBe("AdKd");
    expect(str(holeFromRanks(12, 11, "unknown", cards("QsJs2h")))).toBe("AdKc");
    // when only the flush suit is left, it is still used
    const taken = cards("Ts9s2sAhAdAc");
    expect(str(holeFromRanks(12, 11, "suited", taken))).toBe("AsKs");
    // the board can be passed apart from other known cards: villain's suits don't steer the guess
    expect(str(holeFromRanks(12, 11, "offsuit", cards("7d7c"), []))).toBe("AsKh");
    expect(str(holeFromRanks(12, 11, "offsuit", cards("QsJs2h7c"), cards("QsJs2h")))).toBe("AdKc");
    expect(str(holeFromRanks(12, 11, "offsuit", cards("QsJs2h7c")))).toBe("AhKd"); // 7c counted as board
  });

  it("returns null when impossible", () => {
    expect(holeFromRanks(12, 12, "offsuit", cards("AsAhAd"))).toBeNull();
    expect(holeFromRanks(12, 11, "suited", cards("AsKhAdKc"))).toBeNull();
    expect(str(holeFromRanks(12, 11, "offsuit", cards("AsAhAd")))).toBe("AcKs");
    expect(holeFromRanks(12, 11, "suited", cards("AsAhAdKc"))).toBeNull(); // only Ac left, and Kc is taken
    // unknown falls back to suited when no offsuit combo is left
    expect(str(holeFromRanks(12, 11, "unknown", cards("AsAhAdKsKhKd")))).toBe("AcKc");
    expect(holeFromRanks(13, 1, "offsuit", [])).toBeNull();
    expect(holeFromRanks(-1, 1, "offsuit", [])).toBeNull();
    expect(holeFromRanks(1.5, 1, "offsuit", [])).toBeNull();
  });

  it("every rank pair and kind, with random boards and taken cards: valid, right shape, deterministic", () => {
    const rnd = mulberry32(7);
    let checked = 0;
    let nulls = 0;
    for (let r1 = 0; r1 < 13; r1++) {
      for (let r2 = 0; r2 < 13; r2++) {
        for (const kind of ["suited", "offsuit", "unknown"] as HoleKind[]) {
          for (let trial = 0; trial < 14; trial++) {
            const deck = shuffled(DECK, rnd);
            const board = deck.slice(0, Math.floor(rnd() * 6));
            const extra = deck.slice(5, 5 + Math.floor(rnd() * 5));
            // sometimes block several cards of the asked ranks, to reach the impossible cases
            const blocked = trial % 3 === 0 ? shuffled([0, 1, 2, 3], rnd).slice(0, 1 + Math.floor(rnd() * 3)).map((s) => makeCard(trial % 2 ? r1 : r2, s)) : [];
            const taken = [...new Set([...board, ...extra, ...blocked])];
            const takenSet = new Set(taken);
            const got = holeFromRanks(r1, r2, kind, taken, board);
            const options = holeOptions(r1, r2, kind, takenSet);
            checked++;
            if (!options.length) {
              expect(got).toBeNull();
              nulls++;
              continue;
            }
            expect(got).not.toBeNull();
            const [a, b] = got!;
            expect(a).not.toBe(b);
            expect(rankOf(a)).toBe(r1);
            expect(rankOf(b)).toBe(r2);
            expect(takenSet.has(a) || takenSet.has(b)).toBe(false);
            const suited = suitOf(a) === suitOf(b);
            if (r1 === r2 || kind === "offsuit") expect(suited).toBe(false);
            else if (kind === "suited") expect(suited).toBe(true);
            else expect(suited).toBe(options.every(([x, y]) => suitOf(x) === suitOf(y)));
            expect(options.some(([x, y]) => x === a && y === b)).toBe(true);
            // no flush draw invented when some allowed combo avoids it
            const draws = (c: Card) => suitCount(board, suitOf(c)) >= 2;
            if (options.some(([x, y]) => !draws(x) && !draws(y))) expect(draws(a) || draws(b)).toBe(false);
            // deterministic: same answer again, for any order of the taken cards, and for swapped ranks
            expect(holeFromRanks(r1, r2, kind, taken, board)).toEqual(got);
            expect(holeFromRanks(r1, r2, kind, shuffled(taken, rnd), shuffled(board, rnd))).toEqual(got);
            expect(holeFromRanks(r2, r1, kind, taken, board)).toEqual(r1 === r2 ? got : [b, a]);
          }
        }
      }
    }
    expect(checked).toBe(169 * 3 * 14);
    expect(nulls).toBeGreaterThan(50); // the impossible branch really ran
  });
});

/** Every concrete flop with these ranks (in order) that a texture allows and `taken` leaves free. */
function flopOptions(ranks: number[], texture: Exclude<FlopTexture, "unknown">, taken: Set<Card>): Card[][] {
  const out: Card[][] = [];
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 4; b++)
      for (let c = 0; c < 4; c++) {
        const cs = [makeCard(ranks[0], a), makeCard(ranks[1], b), makeCard(ranks[2], c)];
        if (new Set(cs).size < 3 || cs.some((x) => taken.has(x))) continue;
        if (textureOf(cs) === texture) out.push(cs);
      }
  return out;
}

/** 0 when the two highest ranks share the suit, 1 for the highest with the lowest, 2 for the two lowest. */
function pairRank(ranks: number[], flop: Card[]): number {
  const order = [0, 1, 2].sort((i, j) => ranks[j] - ranks[i] || i - j);
  const same = (i: number, j: number) => suitOf(flop[order[i]]) === suitOf(flop[order[j]]);
  return same(0, 1) ? 0 : same(0, 2) ? 1 : 2;
}

describe("flopFromRanks", () => {
  it("builds each texture in the fixed suit order", () => {
    expect(str(flopFromRanks([10, 5, 0], "rainbow", []))).toBe("Qs7h2d");
    expect(str(flopFromRanks([10, 5, 0], "unknown", []))).toBe("Qs7h2d");
    expect(str(flopFromRanks([10, 5, 0], "monotone", []))).toBe("Qs7s2s");
    // two-tone: the two highest share the suit by default, wherever they sit in the input
    expect(str(flopFromRanks([10, 5, 0], "twotone", []))).toBe("Qs7s2h");
    expect(str(flopFromRanks([0, 10, 5], "twotone", []))).toBe("2hQs7s");
    // ... or the pair named
    expect(str(flopFromRanks([10, 5, 0], "twotone", [], [1, 2]))).toBe("Qs7h2h");
    expect(str(flopFromRanks([10, 5, 0], "twotone", [], [2, 0]))).toBe("Qs7h2s");
    // a paired flop can't share the pair's suit: the high card and the odd card do
    expect(str(flopFromRanks([11, 11, 5], "twotone", []))).toBe("KsKh7s");
    expect(str(flopFromRanks([12, 5, 5], "twotone", []))).toBe("As7s7h");
  });

  it("keeps known hole cards off invented flush draws", () => {
    // I hold two spades: the flop leaves spades out
    expect(str(flopFromRanks([10, 5, 0], "rainbow", cards("AsKs")))).toBe("Qh7d2c");
    expect(str(flopFromRanks([10, 5, 0], "twotone", cards("AsKs")))).toBe("Qh7h2d");
    expect(str(flopFromRanks([10, 5, 0], "monotone", cards("AsKs")))).toBe("Qh7h2h");
  });

  it("returns null when impossible", () => {
    expect(flopFromRanks([11, 11, 5], "monotone", [])).toBeNull();
    expect(flopFromRanks([11, 11, 11], "monotone", [])).toBeNull();
    expect(flopFromRanks([11, 11, 11], "twotone", [])).toBeNull();
    expect(str(flopFromRanks([11, 11, 11], "rainbow", []))).toBe("KsKhKd");
    expect(str(flopFromRanks([12, 12, 12], "rainbow", cards("As")))).toBe("AhAdAc");
    expect(flopFromRanks([12, 12, 12], "rainbow", cards("AsAh"))).toBeNull();
    expect(flopFromRanks([12, 12, 12], "unknown", cards("AsAh"))).toBeNull();
    expect(flopFromRanks([11, 11, 5], "twotone", [], [0, 1])).toBeNull(); // the pair can't share a suit
    expect(flopFromRanks([10, 5, 0], "twotone", [], [1, 1])).toBeNull();
    expect(flopFromRanks([10, 5, 13], "rainbow", [])).toBeNull();
    // unknown falls back to two-tone, then monotone, as taken cards close the other shapes
    expect(str(flopFromRanks([10, 5, 0], "unknown", cards("QhQdQc")))).toBe("Qs7h2d");
    expect(str(flopFromRanks([10, 5, 0], "unknown", cards("QhQdQc7h7d7c")))).toBe("Qs7s2h");
    const onlyMono = flopFromRanks([10, 5, 0], "unknown", cards("QhQdQc7h7d7c2h2d2c"));
    expect(str(onlyMono)).toBe("Qs7s2s");
  });

  it("every one of the 22100 flops can be rebuilt from its ranks and texture", () => {
    let n = 0;
    for (let a = 0; a < 52; a++)
      for (let b = a + 1; b < 52; b++)
        for (let c = b + 1; c < 52; c++) {
          const flop = [a, b, c];
          const ranks = flop.map(rankOf) as [number, number, number];
          const tex = textureOf(flop);
          const got = flopFromRanks(ranks, tex, []);
          expect(got).not.toBeNull();
          expect(got!.map(rankOf)).toEqual(ranks);
          expect(new Set(got).size).toBe(3);
          expect(textureOf(got!)).toBe(tex);
          if (tex === "twotone") {
            // the two highest ranks share the suit unless they're a pair
            const order = [0, 1, 2].sort((i, j) => ranks[j] - ranks[i] || i - j);
            if (ranks[order[0]] !== ranks[order[1]]) expect(suitOf(got![order[0]])).toBe(suitOf(got![order[1]]));
          }
          n++;
        }
    expect(n).toBe(22100);
    // with nothing taken, unknown is always rainbow
    for (let r1 = 0; r1 < 13; r1++)
      for (let r2 = 0; r2 < 13; r2++)
        for (let r3 = 0; r3 < 13; r3++) expect(textureOf(flopFromRanks([r1, r2, r3], "unknown", [])!)).toBe("rainbow");
  });

  it("every rank triple and texture with random taken cards: null exactly when impossible, else valid", () => {
    const rnd = mulberry32(11);
    let nulls = 0;
    for (let r1 = 0; r1 < 13; r1++)
      for (let r2 = 0; r2 < 13; r2++)
        for (let r3 = 0; r3 < 13; r3++) {
          const ranks: [number, number, number] = [r1, r2, r3];
          const deck = shuffled(DECK, rnd);
          const taken = deck.slice(0, Math.floor(rnd() * 9));
          if (rnd() < 0.3) taken.push(...shuffled([0, 1, 2, 3], rnd).slice(0, 2).map((s) => makeCard(r1, s)));
          const takenSet = new Set(taken);
          for (const tex of ["rainbow", "twotone", "monotone", "unknown"] as FlopTexture[]) {
            const got = flopFromRanks(ranks, tex, taken);
            const want: Exclude<FlopTexture, "unknown">[] = tex === "unknown" ? ["rainbow", "twotone", "monotone"] : [tex];
            const firstShape = want.find((t) => flopOptions(ranks, t, takenSet).length);
            if (!firstShape) {
              expect(got).toBeNull();
              nulls++;
              continue;
            }
            expect(got).not.toBeNull();
            expect(got!.map(rankOf)).toEqual(ranks);
            expect(new Set(got).size).toBe(3);
            expect(got!.some((x) => takenSet.has(x))).toBe(false);
            expect(textureOf(got!)).toBe(firstShape);
            if (firstShape === "twotone" && tex === "twotone") {
              // the preferred pair of cards shares the suit whenever taken cards allow it
              const best = Math.min(...flopOptions(ranks, "twotone", takenSet).map((o) => pairRank(ranks, o)));
              expect(pairRank(ranks, got!)).toBe(best);
            }
            expect(flopFromRanks(ranks, tex, shuffled(taken, rnd))).toEqual(got);
          }
        }
    expect(nulls).toBeGreaterThan(100);
  });
});

describe("nextBoardCard", () => {
  it("newSuit keeps flushes out, flushSuit follows the board's main suit", () => {
    const board = cards("Ks7s2h");
    expect(str([nextBoardCard(7, board, "newSuit", board)!])).toBe("9d");
    expect(str([nextBoardCard(7, board, "unknown", board)!])).toBe("9d");
    expect(str([nextBoardCard(7, board, "flushSuit", board)!])).toBe("9s");
    const mono = cards("Ks7s2s");
    expect(str([nextBoardCard(7, mono, "newSuit", [])!])).toBe("9h");
    expect(str([nextBoardCard(7, mono, "flushSuit", [])!])).toBe("9s");
    // river on a two-tone turn: the new suit avoids both two-card suits
    const turn = cards("Ks7s2h3h");
    expect(str([nextBoardCard(7, turn, "newSuit", [])!])).toBe("9d");
    expect(str([nextBoardCard(7, turn, "flushSuit", [])!])).toBe("9s");
    expect(str([nextBoardCard(7, turn, "flushSuit", cards("9s"))!])).toBe("9h");
  });

  it("keeps known hole cards off invented draws", () => {
    // I hold two spades on a rainbow flop without spades: the turn isn't a spade
    const flop = cards("Qh7d2c");
    expect(str([nextBoardCard(7, flop, "newSuit", cards("AsKs"))!])).toBe("9h");
    // the board itself may also sit in `taken`
    expect(str([nextBoardCard(7, flop, "newSuit", [...flop, ...cards("AsKs")])!])).toBe("9h");
  });

  it("returns null when impossible", () => {
    expect(nextBoardCard(7, cards("9s9hKd"), "newSuit", cards("9d9c"))).toBeNull();
    expect(nextBoardCard(11, cards("Ks7s2h"), "flushSuit", [])).toBeNull(); // Ks is already out
    expect(nextBoardCard(13, cards("Ks7s2h"), "newSuit", [])).toBeNull();
    // newSuit still answers when every free suit makes three of a suit
    expect(str([nextBoardCard(7, cards("KsQs7h6h"), "newSuit", cards("9d9c"))!])).toBe("9s");
  });

  it("random turns and rivers: valid card, mode respected", () => {
    const rnd = mulberry32(23);
    for (let trial = 0; trial < 3000; trial++) {
      const deck = shuffled(DECK, rnd);
      const board = deck.slice(0, 3 + (trial % 2));
      const extra = deck.slice(5, 5 + Math.floor(rnd() * 6));
      const rank = Math.floor(rnd() * 13);
      const used = new Set([...board, ...extra]);
      const open = [0, 1, 2, 3].filter((s) => !used.has(makeCard(rank, s)));
      for (const mode of ["newSuit", "flushSuit", "unknown"] as NextSuitMode[]) {
        const got = nextBoardCard(rank, board, mode, extra);
        const counts = [0, 1, 2, 3].map((s) => suitCount(board, s));
        const most = Math.max(...counts);
        if (!open.length || (mode === "flushSuit" && !open.some((s) => counts[s] === most))) {
          expect(got).toBeNull();
          continue;
        }
        expect(got).not.toBeNull();
        expect(rankOf(got!)).toBe(rank);
        expect(used.has(got!)).toBe(false);
        if (mode === "flushSuit") expect(counts[suitOf(got!)]).toBe(most);
        else if (open.some((s) => counts[s] < 2)) expect(counts[suitOf(got!)]).toBeLessThan(2);
        expect(nextBoardCard(rank, shuffled(board, rnd), mode, shuffled(extra, rnd))).toBe(got);
      }
    }
  });
});

describe("suit guess marker", () => {
  it("cleans stored markers", () => {
    expect(cleanGuess({ hole: true, board: [4, 1, 1, 9, -1, 2.5, "3"] })).toEqual({ hole: true, board: [1, 4] });
    expect(cleanGuess({ hole: "yes", board: [] })).toBeUndefined();
    expect(cleanGuess(null)).toBeUndefined();
    expect(cleanGuess("hole")).toBeUndefined();
    expect(cleanGuess({ board: [0, 1, 2] })).toEqual({ board: [0, 1, 2] });
  });

  it("marks and unmarks", () => {
    let g = setHoleGuess(undefined, true);
    expect(g).toEqual({ hole: true });
    g = setBoardGuess(g, [0, 1, 2], true);
    expect(g).toEqual({ hole: true, board: [0, 1, 2] });
    g = setBoardGuess(g, [3], true);
    g = setHoleGuess(g, false);
    expect(g).toEqual({ board: [0, 1, 2, 3] });
    g = setBoardGuess(g, [0, 1, 2, 3], false);
    expect(g).toBeUndefined();
  });

  it("describes what was guessed in Korean", () => {
    expect(describeGuess(undefined)).toBe("");
    expect(describeGuess({})).toBe("");
    expect(describeGuess({ hole: true })).toBe("핸드 수트 추정");
    expect(describeGuess({ board: [0, 1, 2] })).toBe("플랍 수트 추정");
    expect(describeGuess({ board: [4] })).toBe("리버 수트 추정");
    expect(describeGuess({ hole: true, board: [1, 3] })).toBe("핸드·플랍·턴 수트 추정");
    expect(describeGuess({ hole: true, board: [0, 1, 2, 3, 4] })).toBe("핸드·플랍·턴·리버 수트 추정");
  });
});
