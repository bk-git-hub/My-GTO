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

  it("has the cash and pub BTN vs BB packs and the pub UTG vs BB pack", () => {
    const cash = getScenario("srp-btn-bb-100");
    expect(cash.meta).toMatchObject({ format: "cash", positions: ["BB", "BTN"], pot: 5.5, stack: 97.5 });
    expect(cash.meta.rangeSources).toEqual(["cash6/100bb/bb-vs-btn:call", "cash6/100bb/rfi-btn:raise"]);
    const pub = getScenario("pub-srp-btn-bb-55");
    expect(pub.meta).toMatchObject({ format: "pub", positions: ["BB", "BTN"], pot: 6.5, stack: 51.5 });
    expect(pub.meta.rangeSources).toEqual(["pub/mid/bb-vs-btn:call", "pub/mid/rfi-btn:open"]);
    const utg = getScenario("pub-srp-utg-bb-55");
    expect(utg.meta).toMatchObject({ format: "pub", positions: ["BB", "UTG"], pot: 6.5, stack: 51.5 });
    expect(utg.meta.rangeSources).toEqual(["pub/mid/bb-vs-utg:call", "pub/mid/rfi-utg:open"]);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const sc of SCENARIOS) {
      expect(() => packFilePath(sc.id, sc.version, "AsKh7d")).not.toThrow();
      expect(Object.keys(sc.meta.sizes).sort()).toEqual(["flop", "river", "turn"]);
      expect(sc.meta.pot).toBeGreaterThan(0);
      expect(sc.meta.stack).toBeGreaterThan(sc.meta.pot);
    }
  });

  it("builds plausible ranges from the charts' effective frequencies", () => {
    // BB flats a BTN open with 25–60% of hands (the charts: cash 53%, pub 55%); the BTN opens 35–55% (49%, 38%).
    // The pub chart's UTG opens 12% and its BB calls that with 46%.
    const bounds: Record<string, { oop: [number, number]; ip: [number, number] }> = {
      "srp-btn-bb-100": { oop: [0.25, 0.6], ip: [0.35, 0.55] },
      "pub-srp-btn-bb-55": { oop: [0.25, 0.6], ip: [0.35, 0.55] },
      "pub-srp-utg-bb-55": { oop: [0.3, 0.55], ip: [0.08, 0.18] },
    };
    for (const sc of SCENARIOS) {
      const [oop, ip] = sc.ranges.map((r) => weightedCombos(r) / 1326);
      expect(sc.ranges[0].length).toBe(1326);
      const b = bounds[sc.id];
      expect(b, sc.id).toBeDefined();
      expect(oop).toBeGreaterThan(b.oop[0]);
      expect(oop).toBeLessThan(b.oop[1]);
      expect(ip).toBeGreaterThan(b.ip[0]);
      expect(ip).toBeLessThan(b.ip[1]);
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
