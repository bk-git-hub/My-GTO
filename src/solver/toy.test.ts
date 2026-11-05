import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import { buildTree, createSolver } from "./index";
import { rangeWeights } from "./testHelpers";
import type { SolverInput } from "./types";

/**
 * Polarized river toy game with a known answer (docs/solver.md, test 2).
 * Board 2c3d7h8sKs: no straight or flush. OOP has the 3 KK combos (nuts) and the 16 combos of 54
 * (air, no card on the board); IP has the 6 QQ combos, which beat air and lose to KK. Pot 10, stacks 10.
 * OOP can check or bet the pot (= all-in); IP can only check behind, or fold / call.
 *
 * Equilibrium: KK always bets; OOP bluffs so that bluffs / bets = bet / (pot + 2 bet) = 1/3
 * (1.5 bluff combos, so 3/32 of the air); IP calls pot / (pot + bet) = 1/2 of the time.
 * Game value per hand pair: KK pairs 10 + 10 q = 15, air pairs 0 -> v* = 18 × 15 / 114.
 */
const board = parseCards("2c3d7h8sKs");
const input: SolverInput = {
  board,
  ranges: [rangeWeights("KK, 54"), rangeWeights("QQ")],
  pot: 10,
  stack: 10,
  sizes: {
    river: [
      { bet: [1.0], raise: [] },
      { bet: [], raise: [] },
    ],
  },
  raiseLimit: 0,
  addAllIn: false,
};

const isKK = (i: number) => COMBOS[i].hand === "KK";
const is54 = (i: number) => COMBOS[i].hand === "54o" || COMBOS[i].hand === "54s";

describe("toy river game", () => {
  it("has exactly check / all-in for OOP and check or fold / call for IP", () => {
    const root = buildTree(input);
    expect(root.actions!.map((a) => [a.kind, a.to])).toEqual([["check", 0], ["allin", 10]]);
    expect(root.children[0].actions!.map((a) => a.kind)).toEqual(["check"]);
    expect(root.children[1].actions!.map((a) => [a.kind, a.to])).toEqual([["fold", 0], ["call", 10]]);
  });

  it("converges to the known equilibrium", () => {
    const s = createSolver(input);
    s.iterate(1000);
    const expl = s.exploitability();
    expect(expl).toBeLessThan(0.1);

    // How far from the equilibrium the exploitability e lets each quantity be. Both best responses
    // are at least the game value, so either player gains at most g = BR_0 + BR_1 - P0 = 2 e% × P0
    // (per hand pair, 114 pairs: 3 KK × 6 + 16 air × 6) by deviating:
    //  - KK checking a share k costs OOP 5 bb on 18 pairs: k <= g × 114 / 90.
    //  - IP calling q = 1/2 + d: if d > 0 OOP gains 10 d on the 18 KK pairs, if d < 0 bluffing
    //    every air gains 20 |d| on 96 pairs minus 10 |d| on the KK pairs.
    //  - Air bluffing 3/32 + b: IP gains 160 |b| × 6 / 114 by always calling or always folding.
    const g = (2 * expl * input.pot) / 100;
    const slack = 1e-3;
    const kMax = (g * 114) / 90 + slack;
    const dUp = (g * 114) / 180 + slack;
    const dDown = (g * 114) / 1740 + slack;
    const bMax = (g * 114) / 960 + slack;

    const sol = s.solution();
    const root = sol.node([]);
    const bet = root.strategy![1];
    let kk = 0, kkBet = 0, airBet = 0;
    for (let i = 0; i < 1326; i++) {
      if (isKK(i) && root.ranges[0][i] > 0) {
        kk += root.ranges[0][i];
        kkBet += root.ranges[0][i] * bet[i];
      }
      if (is54(i)) airBet += root.ranges[0][i] * bet[i];
    }
    expect(kk).toBe(3);
    expect(kkBet / kk).toBeGreaterThan(1 - kMax);
    const bluffs = airBet / 16; // share of the air that bluffs
    expect(Math.abs(bluffs - 3 / 32)).toBeLessThan(bMax);
    const share = airBet / (airBet + kkBet);
    expect(Math.abs(share - 1 / 3)).toBeLessThan(0.01);

    // IP's call frequency facing the all-in.
    const facing = sol.node([{ action: 1 }]);
    const call = facing.strategy![1];
    let qq = 0, called = 0;
    for (let i = 0; i < 1326; i++) {
      if (COMBOS[i].hand === "QQ") {
        qq++;
        called += call[i];
      }
    }
    expect(qq).toBe(6);
    const q = called / qq;
    expect(q).toBeLessThan(0.5 + dUp);
    expect(q).toBeGreaterThan(0.5 - dDown);

    // EVs: KK nets 10 + 10 q, air is indifferent between check (0) and bluff (10 - 20 q).
    const ev = root.ev[0];
    for (let i = 0; i < 1326; i++) {
      if (isKK(i) && root.ranges[0][i] > 0) expect(Math.abs(ev[i] - 15)).toBeLessThan(10 * dUp + 0.01);
      if (is54(i)) expect(Math.abs(ev[i])).toBeLessThan(0.05);
    }
  });
});
