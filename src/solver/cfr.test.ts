import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { bestResponseValue, exploitability } from "./bestResponse";
import { Engine } from "./cfr";
import { rangeWeights } from "./testHelpers";
import type { SolverInput, StreetSizes } from "./types";

const toy: SolverInput = {
  board: parseCards("2c3d7h8sKs"),
  ranges: [rangeWeights("KK, 54"), rangeWeights("QQ")],
  pot: 10,
  stack: 10,
  sizes: { river: [{ bet: [1.0], raise: [] }, { bet: [], raise: [] }] },
  raiseLimit: 0,
  addAllIn: false,
};

describe("best response and exploitability", () => {
  it("match a hand computation for the uniform strategy", () => {
    // After one iteration the average strategy is uniform: OOP bets half of everything, IP calls half.
    const e = new Engine(toy);
    e.iterate(1);
    // 114 compatible pairs: 3 KK × 6 QQ and 16 air × 6 QQ.
    // OOP's best response: KK bets (0.5 × 20 + 0.5 × 10 = 15 > 10 for checking), air gets 0 either way.
    expect(bestResponseValue(e, 0)).toBeCloseTo((18 * 15) / 114, 10);
    // IP's best response per QQ: call the bet (0.5 × (3 × -10 + 16 × 20) = 145 > 0), win 10 vs checked air (0.5 × 16 × 10).
    expect(bestResponseValue(e, 1)).toBeCloseTo((6 * (145 + 80)) / 114, 10);
    expect(exploitability(e)).toBeCloseTo(((1620 / 114 - 10) / 2 / 10) * 100, 8);
  });

  it("is zero when there is nothing to decide", () => {
    const e = new Engine({ ...toy, board: parseCards("2c3d7h8s"), stack: 0 });
    expect(e.actionNodes).toHaveLength(0);
    e.iterate(3);
    expect(Math.abs(exploitability(e))).toBeLessThan(1e-9);
  });
});

describe("DCFR iterations", () => {
  it("pruning unreached subtrees gives the same regrets and strategy sums (up to float noise)", () => {
    const sizes: [StreetSizes, StreetSizes] = [{ bet: [0.5, 1], raise: [1] }, { bet: [0.5], raise: [1] }];
    const input: SolverInput = {
      board: parseCards("Ks9h5c3d"),
      ranges: [rangeWeights("99, 55, AK, KQs, QJs, JTs, 76s"), rangeWeights("KK, AA, KJs, QTs, 87s, 66, A2s")],
      pot: 10,
      stack: 60,
      sizes: { turn: sizes, river: sizes },
    };
    const a = new Engine(input);
    const b = new Engine(input);
    b.pruneUnreached = false;
    a.iterate(6);
    b.iterate(6);
    // Nodes skipped by the pruned walk discount lazily; bring both up to date before comparing.
    // What remains is Float32 rounding: one product of factors instead of one rounding per iteration.
    // (Over many iterations that noise flips the sign of near-zero regrets and the runs drift apart
    // slowly, as any two float orderings would, so compare early and then only at the game level.)
    a.syncDiscounts();
    b.syncDiscounts();
    let worst = 0;
    for (const node of a.actionNodes) {
      const len = a.numActions(node) * a.hands[a.player(node)].n;
      const off = a.off[node];
      for (const [x, y] of [[a.regret, b.regret], [a.stratSum, b.stratSum]]) {
        let scale = 1e-12, diff = 0;
        for (let i = off; i < off + len; i++) {
          scale = Math.max(scale, Math.abs(y[i]));
          diff = Math.max(diff, Math.abs(x[i] - y[i]));
        }
        worst = Math.max(worst, diff / scale);
      }
    }
    expect(worst).toBeLessThan(1e-5);
    a.iterate(30);
    b.iterate(30);
    const ea = exploitability(a), eb = exploitability(b);
    expect(Math.abs(ea - eb)).toBeLessThan(0.02 * eb);
  });
});
