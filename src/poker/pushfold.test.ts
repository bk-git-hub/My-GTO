import { describe, expect, it } from "vitest";
import { ALL_HANDS, comboCount } from "./cards";
import { buildEquityTable, mulberry32, N, solvePushFold } from "./pushfold";
import { parseRange, rangeToString, type Range } from "./range";

const pct = (f: Float64Array) => (ALL_HANDS.reduce((s, h, i) => s + f[i] * comboCount(h), 0) / 1326) * 100;

describe("rangeToString", () => {
  it("round-trips through parseRange", () => {
    for (const text of ["22+, A2s+, K9s+, QTs+, JTs, ATo+, KJo+", "TT-66, 33, AQs-A9s, A5s:0.5, K7s, 98o:0.3", "AKo"]) {
      const r = parseRange(text);
      expect(parseRange(rangeToString(r))).toEqual(r);
    }
    const random: Range = {};
    const rand = mulberry32(7);
    for (const h of ALL_HANDS) {
      const x = rand();
      if (x > 0.3) random[h] = x > 0.7 ? 1 : Math.round(x * 100) / 100;
    }
    expect(parseRange(rangeToString(random))).toEqual(random);
  });

  it("writes compact runs", () => {
    expect(rangeToString(parseRange("77+, A2s+, KTs+, Q9s-Q6s, ATo+"))).toBe("77+, A2s+, KTs+, Q9s-Q6s, ATo+");
  });
});

describe("push/fold solver", () => {
  // A coarse table keeps the test fast; the shipped charts use a much finer one.
  const table = buildEquityTable(150, mulberry32(3));

  it("builds a sane equity table", () => {
    const i = (h: string) => ALL_HANDS.indexOf(h);
    expect(table.eq[i("AA") * N + i("KK")]).toBeGreaterThan(0.75);
    expect(table.eq[i("AA") * N + i("KK")]).toBeLessThan(0.88);
    expect(table.eq[i("22") * N + i("AKo")]).toBeGreaterThan(0.45);
    expect(table.eq[i("22") * N + i("AKo")]).toBeLessThan(0.6);
    expect(table.cnt[i("AA") * N + i("AKs")]).toBeCloseTo(2, 5); // two of the four AKs combos avoid a given AA combo's aces
  });

  it("heads-up 10bb without ante: SB shoves wide, BB calls narrower", () => {
    const sol = solvePushFold(table, { players: 2, stack: 10, sb: 0.5, bb: 1, bbAnte: 0 }, 600);
    const push = pct(sol.push[0]);
    const call = pct(sol.call[0][1]);
    // Published HU Nash at 10bb: about 58% shove, 37% call.
    expect(push).toBeGreaterThan(50);
    expect(push).toBeLessThan(66);
    expect(call).toBeGreaterThan(30);
    expect(call).toBeLessThan(45);
    expect(sol.exploitability).toBeLessThan(0.05);
  });

  it("9-handed: later seats shove wider and the ante widens everything", () => {
    const setup = { players: 9, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 };
    const sol = solvePushFold(table, setup, 400);
    const ranges = sol.push.map(pct);
    expect(ranges[0]).toBeLessThan(ranges[6]); // UTG < BTN
    expect(ranges[6]).toBeLessThan(ranges[7]); // BTN < SB
    const noAnte = solvePushFold(table, { ...setup, bbAnte: 0 }, 400).push.map(pct);
    expect(ranges[6]).toBeGreaterThan(noAnte[6]);
  }, 30000);
});
