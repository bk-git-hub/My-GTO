import { describe, expect, it } from "vitest";
import { ALL_HANDS } from "../poker/cards";
import { parseRange, rangePercent } from "../poker/range";
import { SCENARIOS } from "./preflop";

describe("preflop charts", () => {
  it("parse and keep raise + call <= 1 for every hand", () => {
    for (const s of SCENARIOS) {
      const raise = parseRange(s.raise);
      const call = parseRange(s.call ?? "");
      for (const h of ALL_HANDS) {
        const total = (raise[h] ?? 0) + (call[h] ?? 0);
        expect(total, `${s.id} ${h}`).toBeLessThanOrEqual(1.0001);
      }
    }
  });
  it("has plausible range widths", () => {
    const width = Object.fromEntries(
      SCENARIOS.map((s) => [s.id, [rangePercent(s.raiseRange).toFixed(1), rangePercent(s.callRange).toFixed(1)]]),
    );
    console.log(width);
    const rfi = (id: string) => rangePercent(SCENARIOS.find((s) => s.id === id)!.raiseRange);
    expect(rfi("rfi-utg")).toBeLessThan(rfi("rfi-hj"));
    expect(rfi("rfi-hj")).toBeLessThan(rfi("rfi-co"));
    expect(rfi("rfi-co")).toBeLessThan(rfi("rfi-btn"));
  });
});
