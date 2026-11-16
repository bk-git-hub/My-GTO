import { describe, expect, it } from "vitest";
import { ALL_HANDS } from "./cards";
import { openJamGains, solveOpenJam } from "./openjam";
import { buildEquityTable, mulberry32, N } from "./pushfold";
import { realizationAt } from "./realization";

const COMBO_W = ALL_HANDS.map((h) => (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12));
const sum = (a: Float64Array) => a.reduce((s, v) => s + v, 0);
/** Σ_k (k+1)·v_k over every entry in order, so a permutation or a single moved value shows up too. */
const fingerprint = (arrs: Float64Array[]) => {
  let s = 0, k = 0;
  for (const a of arrs) for (const v of a) s += ++k * v;
  return s;
};
const cells = (grid: Float64Array[][]) => grid.flat().filter((a) => a.length);
const expectSame = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(want)));

describe("openJamGains", () => {
  const table = buildEquityTable(150, mulberry32(3));
  const setup = { players: 6, stack: 20, sb: 0.5, bb: 1, bbAnte: 1, open: 2, bbRealization: ALL_HANDS.map((h) => realizationAt(h, 20, 2)) };
  const sol = solveOpenJam(table, setup, 60);

  it("leaves solveOpenJam's output unchanged", () => {
    // Captured from solveOpenJam before openJamGains was split out of it (same table, setup and iterations).
    expectSame(sol.exploitability, 0.3068446523752014);
    const openSums = [48.47049180327878, 50.01147540983619, 50.2081967213116, 54.24098360655754, 148.45409836065576];
    sol.open.forEach((p, i) => expectSame(sum(p), openSums[i]));
    expectSame(fingerprint(sol.open), 176261.9918032787);
    expectSame(fingerprint(sol.jam), 16762.786885245903);
    expectSame(fingerprint(cells(sol.callJam)), 1044364.1311475417);
    expectSame(fingerprint(cells(sol.reJam)), 1022854.0000000005);
    expectSame(fingerprint(sol.bbCall), 163145.22131147544);
    expectSame(fingerprint(cells(sol.callReJam)), 1358580.7704918028);
  });

  // The gain values themselves are pinned by the fingerprints above (solveOpenJam scores with openJamGains, so
  // this test cannot catch a wrong gain) and by PF-RED-2 against the preflop engine. This one checks that the
  // exploitability is the worst regret of these gains and that `out` is reused.
  it("scores the exploitability and reuses `out`", () => {
    const g = openJamGains(table, setup, sol);
    const BB = setup.players - 1;
    let worst = 0;
    const regret = (gains: (h: number) => number[], probs: (h: number) => number[]) => {
      let d = 0;
      for (let h = 0; h < N; h++) {
        const gh = gains(h), p = probs(h);
        d += COMBO_W[h] * (Math.max(0, ...gh) - gh.reduce((s, x, k) => s + x * p[k], 0));
      }
      worst = Math.max(worst, d / 1326);
    };
    for (let i = 0; i < BB; i++) {
      regret((h) => [g.gainOpen[i][h], g.gainJam[i][h]], (h) => [sol.open[i][h], sol.jam[i][h]]);
      for (let j = i + 1; j <= BB; j++) {
        regret((x) => [g.callJamGain[i][j][x]], (x) => [sol.callJam[i][j][x]]);
        regret((h) => [g.callReJamGain[i][j][h]], (h) => [sol.callReJam[i][j][h]]);
        regret(
          (x) => (j === BB ? [g.vsOpenGains.reJam[i][j][x], g.vsOpenGains.flat[i][x]] : [g.vsOpenGains.reJam[i][j][x]]),
          (x) => (j === BB ? [sol.reJam[i][j][x], sol.bbCall[i][x]] : [sol.reJam[i][j][x]]),
        );
      }
    }
    expect(worst).toBe(sol.exploitability);
    expect(openJamGains(table, setup, sol, g)).toBe(g);
  });
});
