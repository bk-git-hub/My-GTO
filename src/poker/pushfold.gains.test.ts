import { describe, expect, it } from "vitest";
import { ALL_HANDS } from "./cards";
import { buildEquityTable, mulberry32, N, pushFoldGains, solvePushFold } from "./pushfold";

const COMBO_W = ALL_HANDS.map((h) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12));
const sum = (a: Float64Array) => a.reduce((s, v) => s + v, 0);
/** Σ_k (k+1)·v_k over every entry in order, so a permutation or a single moved value shows up too. */
const fingerprint = (arrs: Float64Array[]) => {
  let s = 0, k = 0;
  for (const a of arrs) for (const v of a) s += ++k * v;
  return s;
};
const expectSame = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(want)));

describe("pushFoldGains", () => {
  const table = buildEquityTable(150, mulberry32(3));
  const setup = { players: 9, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 };
  const sol = solvePushFold(table, setup, 150);

  it("leaves solvePushFold's output unchanged", () => {
    // Captured from solvePushFold before pushFoldGains was split out of it (same table, setup and iterations).
    expectSame(sol.exploitability, 0.05515627424209654);
    const pushSums = [43.70529801324499, 45.20860927152314, 47.40066225165559, 49.34768211920526, 55.45364238410591, 63.268211920529765, 80.0761589403973, 132.8046357615895];
    sol.push.forEach((p, i) => expectSame(sum(p), pushSums[i]));
    expectSame(fingerprint(sol.push), 407273.9536423838);
    expectSame(fingerprint(sol.call.flat().filter((a) => a.length)), 5830037.258278139);
  });

  // The gain values themselves are pinned by the fingerprints above (solvePushFold scores with pushFoldGains, so
  // this test cannot catch a wrong gain) and by PF-RED-1 against the preflop engine. This one checks the shape,
  // that the exploitability is the worst regret of these gains, and that `out` is reused.
  it("has the documented shape, scores the exploitability and reuses `out`", () => {
    const g = pushFoldGains(table, setup, sol.push, sol.call);
    const regret = (gain: Float64Array, s: Float64Array) => {
      let d = 0;
      for (let h = 0; h < N; h++) d += COMBO_W[h] * (Math.max(0, gain[h]) - s[h] * gain[h]);
      return d / 1326;
    };
    let worst = 0;
    for (let i = 0; i < setup.players - 1; i++) {
      worst = Math.max(worst, regret(g.pushGain[i], sol.push[i]));
      for (let j = i + 1; j < setup.players; j++) worst = Math.max(worst, regret(g.callGain[i][j], sol.call[i][j]));
      for (let j = 0; j <= i; j++) expect(g.callGain[i][j].length).toBe(0);
    }
    expect(worst).toBe(sol.exploitability);
    // Reusing the arrays gives the same numbers.
    const again = pushFoldGains(table, setup, sol.push, sol.call, g);
    expect(again).toBe(g);
    expect(fingerprint(again.pushGain)).toBe(fingerprint(pushFoldGains(table, setup, sol.push, sol.call).pushGain));
  });
});
