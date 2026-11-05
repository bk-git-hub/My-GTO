import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { parseRange } from "../poker/range";
import { COMBOS } from "../play/handInfo";
import { estimateMemory } from "../solver/index";
import { canonicalBoard, packFilePath } from "./format";
import { SCENARIOS, chartRange, getScenario, rangeWeights, solverInput, srpPotStack, weightedCombos } from "./scenarios";

describe("presolve scenarios", () => {
  it("derives pot and stack from the table rules", () => {
    expect(srpPotStack({ start: 100, open: 2.5, bbAnte: 0 })).toEqual({ pot: 5.5, stack: 97.5 });
    // Pub: the BB's 1bb ante is dead money and comes out of the BB's stack, so the BB is the shorter stack.
    expect(srpPotStack({ start: 55, open: 2.5, bbAnte: 1 })).toEqual({ pot: 6.5, stack: 51.5 });
    expect(srpPotStack({ start: 40, open: 2.5, bbAnte: 1 })).toEqual({ pot: 6.5, stack: 36.5 });
  });

  it("has the cash and pub BTN vs BB packs", () => {
    const cash = getScenario("srp-btn-bb-100");
    expect(cash.meta).toMatchObject({ format: "cash", positions: ["BB", "BTN"], pot: 5.5, stack: 97.5 });
    expect(cash.meta.rangeSources).toEqual(["cash6/100bb/bb-vs-btn:call", "cash6/100bb/rfi-btn:raise"]);
    const pub = getScenario("pub-srp-btn-bb-55");
    expect(pub.meta).toMatchObject({ format: "pub", positions: ["BB", "BTN"], pot: 6.5, stack: 51.5 });
    expect(pub.meta.rangeSources).toEqual(["pub/mid/bb-vs-btn:call", "pub/mid/rfi-btn:open"]);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const sc of SCENARIOS) {
      expect(() => packFilePath(sc.id, sc.version, "AsKh7d")).not.toThrow();
      expect(Object.keys(sc.meta.sizes).sort()).toEqual(["flop", "river", "turn"]);
      expect(sc.meta.pot).toBeGreaterThan(0);
      expect(sc.meta.stack).toBeGreaterThan(sc.meta.pot);
    }
  });

  it("builds plausible ranges from the charts' effective frequencies", () => {
    for (const sc of SCENARIOS) {
      const [oop, ip] = sc.ranges.map((r) => weightedCombos(r) / 1326);
      expect(sc.ranges[0].length).toBe(1326);
      // BB flats a BTN open with 25–60% of hands (the charts: cash 53%, pub 48%); the BTN opens 35–55% (49%, 38%).
      expect(oop).toBeGreaterThan(0.25);
      expect(oop).toBeLessThan(0.6);
      expect(ip).toBeGreaterThan(0.35);
      expect(ip).toBeLessThan(0.55);
      for (const r of sc.ranges) for (const w of r) expect(w >= 0 && w <= 1).toBe(true);
      // The range strings written to the manifest parse back to the same hand-class weights.
      sc.meta.ranges.forEach((text, p) => {
        const back = rangeWeights(parseRange(text));
        for (let i = 0; i < 1326; i++) expect(Math.abs(back[i] - sc.ranges[p][i])).toBeLessThan(0.006);
      });
    }
    // The BB's 3-bet hands are taken out of its calling range (charts fill actions top to bottom).
    const bbCall = chartRange("cash6/100bb/bb-vs-btn:call");
    expect(bbCall.AA ?? 0).toBe(0);
    expect(bbCall.JJ).toBeCloseTo(0.4, 6);
    const aa = COMBOS.findIndex((c) => c.hand === "AA");
    expect(getScenario("srp-btn-bb-100").ranges[0][aa]).toBe(0);
    expect(() => chartRange("cash6/100bb/rfi-btn:call")).toThrow();
    expect(() => chartRange("nope")).toThrow();
  });

  it("keeps every flop solve under ~1.8 GB by the solver's estimate", () => {
    // First 200 priority flops: cash 1.58–1.78 GB, pub 1.20–1.36 GB.
    for (const sc of SCENARIOS)
      for (const raw of ["AhKd7c", "9h8h6h", "7d7c2h", "6s4h3d"]) {
        const board = canonicalBoard(parseCards(raw)).cards;
        const m = estimateMemory(solverInput(sc, board));
        expect(m.bytes).toBeLessThan(1.85e9);
        expect(m.actionNodes).toBeGreaterThan(1000);
      }
  });
});
