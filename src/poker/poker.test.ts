import { describe, expect, it } from "vitest";
import { ALL_HANDS, combosOf, gridHand, handClassOf, parseCards } from "./cards";
import { categoryName, evaluate } from "./evaluator";
import { countOuts, equityVsHand, equityVsRange } from "./equity";
import { bluffBreakEven, callEV, hitChance, mdf, requiredEquity } from "./odds";
import { FULL_RANGE, parseRange, rangeCombos } from "./range";

const ev = (s: string) => evaluate(parseCards(s));

describe("cards", () => {
  it("builds the 169-hand grid", () => {
    expect(ALL_HANDS).toHaveLength(169);
    expect(gridHand(0, 0)).toBe("AA");
    expect(gridHand(0, 1)).toBe("AKs");
    expect(gridHand(1, 0)).toBe("AKo");
    expect(gridHand(12, 11)).toBe("32o");
  });
  it("counts combos", () => {
    const total = ALL_HANDS.reduce((n, h) => n + combosOf(h).length, 0);
    expect(total).toBe(1326);
  });
  it("classifies two cards", () => {
    const [a, b] = parseCards("Kd As");
    expect(handClassOf(a, b)).toBe("AKo");
    const [c, d] = parseCards("5h6h");
    expect(handClassOf(c, d)).toBe("65s");
  });
});

describe("range parser", () => {
  it("expands plus, dash and frequency tokens", () => {
    const r = parseRange("77+, A2s+, KTo+, 22-44:0.5, KJs-K9s, QJ, A6s:0.25");
    expect(r["AA"]).toBe(1);
    expect(r["77"]).toBe(1);
    expect(r["66"]).toBeUndefined();
    expect(r["33"]).toBe(0.5);
    expect(r["AKs"]).toBe(1);
    expect(r["A2s"]).toBe(1);
    expect(r["A6s"]).toBe(0.25);
    expect(r["KQo"]).toBe(1);
    expect(r["KTo"]).toBe(1);
    expect(r["K9o"]).toBeUndefined();
    expect(r["KTs"]).toBe(1);
    expect(r["QJs"]).toBe(1);
    expect(r["QJo"]).toBe(1);
  });
  it("accepts descending dash ranges", () => {
    expect(parseRange("TT-22")["55"]).toBe(1);
    expect(parseRange("AJs-A6s")["A8s"]).toBe(1);
  });
  it("counts combos", () => {
    expect(rangeCombos(FULL_RANGE)).toBe(1326);
    expect(rangeCombos(parseRange("AA, AKs"))).toBe(10);
  });
});

describe("evaluator", () => {
  it("ranks categories", () => {
    expect(categoryName(ev("AsKsQsJsTs2d3c"))).toBe("스트레이트 플러시");
    expect(categoryName(ev("AsAhAdAc2d3c4h"))).toBe("포카드");
    expect(categoryName(ev("AsAhAdKcKd3c4h"))).toBe("풀하우스");
    expect(categoryName(ev("As9s7s5s2s3c4h"))).toBe("플러시");
    expect(categoryName(ev("As2d3c4h5s9c9d"))).toBe("스트레이트");
    expect(categoryName(ev("AsAhAd9c7d3c4h"))).toBe("트리플");
    expect(categoryName(ev("AsAhKdKc7d3c4h"))).toBe("투페어");
    expect(categoryName(ev("AsAh9dKc7d3c4h"))).toBe("원페어");
    expect(categoryName(ev("As8h9dKc7d3c4h"))).toBe("하이카드");
  });
  it("compares kickers and edge cases", () => {
    expect(ev("AsAhKd7c5d3c2h")).toBeGreaterThan(ev("AsAhQd7c5d3c2h"));
    expect(ev("6s2d3c4h5s9cKd")).toBeGreaterThan(ev("As2d3c4h5s9cKd")); // 6-high beats wheel
    expect(ev("AsAhAdKcKdKh2c")).toBe(ev("AsAhAdKcKd2h2c")); // AAA KK either way
    expect(ev("KsKhQdQc2d2c9h")).toBe(ev("KsKhQdQc3d3c9h")); // third pair doesn't play
  });
});

// Independent naive evaluator: best of all 5-card subsets, scored as [category, ...tiebreak ranks].
function naive5(cards: number[]): number[] {
  const ranks = cards.map((c) => c >> 2).sort((a, b) => b - a);
  const flush = cards.every((c) => (c & 3) === (cards[0] & 3));
  const uniq = [...new Set(ranks)];
  let straight = -1;
  if (uniq.length === 5 && ranks[0] - ranks[4] === 4) straight = ranks[0];
  if (uniq.length === 5 && ranks[0] === 12 && ranks[1] === 3) straight = 3;
  const counts = new Map<number, number>();
  ranks.forEach((r) => counts.set(r, (counts.get(r) ?? 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join("");
  const order = groups.map((g) => g[0]);
  if (straight >= 0 && flush) return [8, straight];
  if (shape === "41") return [7, ...order];
  if (shape === "32") return [6, ...order];
  if (flush) return [5, ...ranks];
  if (straight >= 0) return [4, straight];
  if (shape === "311") return [3, ...order];
  if (shape === "221") return [2, ...order];
  if (shape === "2111") return [1, ...order];
  return [0, ...ranks];
}
function cmp(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}
function naive7(cards: number[]): number[] {
  let best: number[] = [-1];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    const five = cards.filter((_, i) => i !== a && i !== b);
    const s = naive5(five);
    if (cmp(s, best) > 0) best = s;
  }
  return best;
}

describe("evaluator cross-check", () => {
  it("agrees with a brute-force evaluator on random deals", () => {
    for (let t = 0; t < 3000; t++) {
      const deck = Array.from({ length: 52 }, (_, i) => i).sort(() => Math.random() - 0.5);
      const board = deck.slice(0, 5);
      const h1 = [deck[5], deck[6], ...board];
      const h2 = [deck[7], deck[8], ...board];
      const fast = Math.sign(evaluate(h1) - evaluate(h2));
      const slow = Math.sign(cmp(naive7(h1), naive7(h2)));
      expect(fast).toBe(slow);
    }
  });
});

describe("equity", () => {
  it("AA vs KK preflop ≈ 82%", () => {
    const r = equityVsHand(parseCards("AsAh"), parseCards("KdKc"), [], 40000);
    expect(r.equity).toBeGreaterThan(0.80);
    expect(r.equity).toBeLessThan(0.84);
  });
  it("AKo vs 22 is close to a coin flip", () => {
    const r = equityVsHand(parseCards("AsKd"), parseCards("2h2c"), [], 40000);
    expect(r.equity).toBeGreaterThan(0.45);
    expect(r.equity).toBeLessThan(0.50);
  });
  it("flush draw vs top pair on the flop is exact", () => {
    // Hero Ah5h on Kh 8h 2c vs villain KsQd: nut flush draw, villain top pair
    const r = equityVsHand(parseCards("Ah5h"), parseCards("KsQd"), parseCards("Kh8h2c"));
    expect(r.exact).toBe(true);
    expect(r.samples).toBe(990);
    expect(r.equity).toBeGreaterThan(0.42);
    expect(r.equity).toBeLessThan(0.50);
  });
  it("counts flush outs", () => {
    const { outs } = countOuts(parseCards("Ah5h"), parseCards("KsQd"), parseCards("Kh8h2c"));
    expect(outs.length).toBe(12); // 9 hearts + 3 aces
  });
  it("AA vs random hand ≈ 85%", () => {
    const r = equityVsRange(parseCards("AsAh"), FULL_RANGE, [], 30000);
    expect(r.equity).toBeGreaterThan(0.83);
    expect(r.equity).toBeLessThan(0.87);
  });
});

describe("odds", () => {
  it("pot odds math", () => {
    expect(requiredEquity(100, 50)).toBeCloseTo(0.25);
    expect(requiredEquity(100, 100)).toBeCloseTo(1 / 3);
    expect(mdf(100, 50)).toBeCloseTo(2 / 3);
    expect(bluffBreakEven(100, 100)).toBeCloseTo(0.5);
    expect(callEV(0.25, 100, 50)).toBeCloseTo(0);
    expect(hitChance(9, 2)).toBeCloseTo(0.3497, 3);
    expect(hitChance(9, 1)).toBeCloseTo(9 / 46);
  });
});
