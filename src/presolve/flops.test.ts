import { describe, expect, it } from "vitest";
import { makeCard, parseCards, rankOf, suitOf } from "../poker/cards";
import { canonicalBoard } from "./format";
import {
  FLOPS_BY_PRIORITY,
  FLOP_INFOS,
  RAW_FLOPS,
  describeTexture,
  flopDistance,
  flopInfo,
  flopTexture,
  representativeWeights,
  representativeWeightsFor,
} from "./flops";

const PERMS: number[][] = [];
(function rec(p: number[]) {
  if (p.length === 4) return void PERMS.push(p);
  for (let s = 0; s < 4; s++) if (!p.includes(s)) rec([...p, s]);
})([]);

describe("flop classes", () => {
  it("has 1755 classes whose weights sum to 22100", () => {
    expect(FLOP_INFOS.length).toBe(1755);
    expect(new Set(FLOP_INFOS.map((f) => f.key)).size).toBe(1755);
    expect(FLOP_INFOS.reduce((s, f) => s + f.weight, 0)).toBe(RAW_FLOPS);
    const byWeight = new Map<number, number>();
    for (const f of FLOP_INFOS) byWeight.set(f.weight, (byWeight.get(f.weight) ?? 0) + 1);
    // 286 rank triples × (rainbow 24 + monotone 4 + three two-tone 12) + 156 paired × 2 × 12 + 13 trips × 4
    expect(byWeight.get(24)).toBe(286);
    expect(byWeight.get(12)).toBe(286 * 3 + 156 * 2);
    expect(byWeight.get(4)).toBe(286 + 13);
  });

  it("canonicalization is invariant under suit permutations", () => {
    for (const raw of ["AhKd7c", "7d7c2h", "9s8s6s", "JcTd2c", "2h2d2s", "Ac5c4d"]) {
      const cards = parseCards(raw);
      const key = canonicalBoard(cards).key;
      for (const p of PERMS) {
        const moved = cards.map((c) => makeCard(rankOf(c), p[suitOf(c)]));
        expect(canonicalBoard(moved).key).toBe(key);
        expect(flopInfo(moved).key).toBe(key);
        expect(flopDistance(moved, cards)).toBe(0);
      }
    }
  });

  it("every raw flop lands in a class of the right size", () => {
    const count = new Map<string, number>();
    for (let a = 0; a < 52; a++)
      for (let b = a + 1; b < 52; b++)
        for (let c = b + 1; c < 52; c++) {
          const k = canonicalBoard([a, b, c]).key;
          count.set(k, (count.get(k) ?? 0) + 1);
        }
    expect(count.size).toBe(1755);
    for (const f of FLOP_INFOS) expect(count.get(f.key)).toBe(f.weight);
  });

  it("describes textures", () => {
    const t = flopTexture(parseCards("AhKd7c"));
    expect(t).toMatchObject({ ranks: [12, 11, 5], height: "high", pairing: "unpaired", suits: "rainbow", connect: "dry", broadways: 2, straightPossible: false, flushPossible: false });
    expect(flopTexture(parseCards("9s8s7s"))).toMatchObject({ suits: "monotone", connect: "connected", straightPossible: true, height: "middle" });
    expect(flopTexture(parseCards("As4d3s"))).toMatchObject({ suits: "twotone", connect: "connected", straightPossible: true });
    expect(flopTexture(parseCards("Js9d7c")).connect).toBe("gapped");
    expect(flopTexture(parseCards("7h7d2c"))).toMatchObject({ pairing: "paired", connect: "dry", height: "low" });
    expect(flopTexture(parseCards("5h5d5c")).pairing).toBe("trips");
    expect(describeTexture(flopTexture(parseCards("QsTs9h")))).toBe("QT9 투톤 커넥티드");
  });
});

describe("priority order", () => {
  it("is a permutation of all classes", () => {
    expect(FLOPS_BY_PRIORITY.length).toBe(1755);
    expect(new Set(FLOPS_BY_PRIORITY.map((f) => f.key)).size).toBe(1755);
  });

  it("spreads the first 25 over textures", () => {
    const first = FLOPS_BY_PRIORITY.slice(0, 25).map((f) => f.texture);
    expect(first.some((t) => t.suits === "monotone")).toBe(true);
    expect(first.some((t) => t.suits === "twotone")).toBe(true);
    expect(first.some((t) => t.suits === "rainbow")).toBe(true);
    expect(first.some((t) => t.pairing === "paired")).toBe(true);
    expect(first.some((t) => t.height === "high")).toBe(true);
    expect(first.some((t) => t.height === "low")).toBe(true);
    expect(first.some((t) => t.ranks[0] === 12)).toBe(true); // an ace-high board
    expect(first.some((t) => t.connect === "connected")).toBe(true);
    // Rare textures don't crowd out common ones: trips are 0.2% of flops.
    expect(first.filter((t) => t.pairing === "trips").length).toBe(0);
  });

  it("gets closer to every flop as the prefix grows", () => {
    const meanDist = (n: number) => {
      const reps = FLOPS_BY_PRIORITY.slice(0, n).map((f) => f.key);
      let s = 0;
      for (const f of FLOP_INFOS) s += f.weight * Math.min(...reps.map((r) => flopDistance(f.key, r)));
      return s / RAW_FLOPS;
    };
    const d = [1, 10, 25, 50, 100].map(meanDist);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeLessThan(d[i - 1]);
  });
});

describe("representative weights", () => {
  it("sum to 22100 for every prefix and count each representative itself", () => {
    for (const n of [1, 3, 25, 95, 1755]) {
      const rw = representativeWeights(n);
      expect(rw.length).toBe(n);
      expect(rw.reduce((s, r) => s + r.weight, 0)).toBe(RAW_FLOPS);
      rw.forEach((r, i) => {
        expect(r.key).toBe(FLOPS_BY_PRIORITY[i].key);
        expect(r.weight).toBeGreaterThanOrEqual(FLOPS_BY_PRIORITY[i].weight);
      });
    }
    expect(representativeWeights(1755).every((r, i) => r.weight === FLOPS_BY_PRIORITY[i].weight)).toBe(true);
  });

  it("works for any set of solved flops", () => {
    const m = representativeWeightsFor(["AsKh7d", "7s4h4d", "9s8s6s"]);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(RAW_FLOPS);
    expect(m.get("AsKh7d")!).toBeGreaterThan(m.get("9s8s6s")!);
    expect(() => representativeWeightsFor(["AhKd7c"])).toThrow(); // not canonical
    expect(() => representativeWeightsFor([])).toThrow();
  });
});
