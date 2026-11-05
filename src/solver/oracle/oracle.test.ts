import { describe, expect, it } from "vitest";
import { cardFromString, combosOf, parseCards, type Card } from "../../poker/cards";
import { COMBOS } from "../../play/handInfo";
import type { PathStep, SolverInput } from "../types";
import { oracleBestResponse, oracleNodeInfo, oracleValue, type StrategyFn } from "./bestResponse";
import { createOracleCfr, oracleSolve } from "./cfr";
import { chanceProbability, OracleGame, oracleHands, terminalNet0 } from "./game";
import { forEachNode, oracleNodeAt, oracleTree, oracleTreeStats, type OracleNode } from "./tree";

// ---------- helpers ----------

const comboIndex = (s: string): number => {
  const [a, b] = parseCards(s);
  const i = COMBOS.findIndex((c) => (c.cards[0] === a && c.cards[1] === b) || (c.cards[0] === b && c.cards[1] === a));
  if (i < 0) throw new Error(`no combo ${s}`);
  return i;
};

/** Weights for explicit combos, e.g. {"KhKd": 1, "5h4h": 0.5}. */
function rangeOfCombos(weights: Record<string, number>): Float64Array {
  const r = new Float64Array(COMBOS.length);
  for (const [s, w] of Object.entries(weights)) r[comboIndex(s)] = w;
  return r;
}

/** Weight 1 for every combo of the given hand classes ("AA", "KQs", "AKo"). */
function rangeOfClasses(classes: string[]): Float64Array {
  const r = new Float64Array(COMBOS.length);
  for (const h of classes) {
    for (const [a, b] of combosOf(h)) {
      r[COMBOS.findIndex((c) => (c.cards[0] === a && c.cards[1] === b) || (c.cards[0] === b && c.cards[1] === a))] = 1;
    }
  }
  return r;
}

const actionsOf = (node: OracleNode) => node.actions!.map((a) => [a.kind, a.to] as const);

function expectActions(node: OracleNode, expected: [string, number][]) {
  expect(node.kind).toBe("action");
  const got = actionsOf(node);
  expect(got.map((g) => g[0])).toEqual(expected.map((e) => e[0]));
  got.forEach((g, k) => expect(g[1]).toBeCloseTo(expected[k][1], 9));
}

const A = (i: number): PathStep => ({ action: i });
const C = (s: string): PathStep => ({ card: cardFromString(s) });

/** Uniform over the actions at the node, for the tree rooted at `root`. */
const uniformOn =
  (root: OracleNode): StrategyFn =>
  (path) => {
    const n = oracleNodeAt(root, path).actions!.length;
    return new Array(n).fill(1 / n);
  };

// ---------- (d) tree rules ----------

describe("oracle tree rules", () => {
  const river = parseCards("2c3d7h8sKs");

  it("default sizes, deep stacks: bets, raises, min-raise, threshold and the raise cap", () => {
    const root = oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 100 });
    // OOP: check, 0.33 × 10, 0.75 × 10, all-in.
    expectActions(root, [["check", 0], ["bet", 3.3], ["bet", 7.5], ["allin", 100]]);
    expect(root.actions!.map((a) => a.label)).toEqual(["체크", "벳 33%", "벳 75%", "올인"]);

    // OOP bets 7.5: pot 17.5, IP raise to 7.5 + 0.75 × (17.5 + 7.5) = 26.25 (min raise 15).
    const ip = oracleNodeAt(root, [A(2)]);
    expect(ip.player).toBe(1);
    expect(ip.pot).toBeCloseTo(17.5, 12);
    expectActions(ip, [["fold", 0], ["call", 7.5], ["raise", 26.25], ["allin", 100]]);
    expect(ip.actions![2].label).toBe("레이즈 26.3");

    // OOP re-raise: to = 7.5 + 18.75 + 0.75 × (43.75 + 18.75) = 73.125; adds 65.625 ≥ 0.67 × 92.5 → all-in,
    // merged with the plain all-in.
    const oop = oracleNodeAt(root, [A(2), A(2)]);
    expect(oop.pot).toBeCloseTo(43.75, 12);
    expect(oop.bets).toEqual([7.5, 26.25]);
    expect(oop.stacks).toEqual([92.5, 73.75]);
    expectActions(oop, [["fold", 0], ["call", 26.25], ["allin", 100]]);

    // Call on the river: showdown.
    const sd = oracleNodeAt(root, [A(2), A(2), A(1)]);
    expect(sd.kind).toBe("terminal");
    expect(sd.terminal).toBe("showdown");
    expect(sd.pot).toBeCloseTo(62.5, 12);
    expect(sd.contributions).toEqual([26.25, 26.25]);

    // IP facing the all-in: n = 3 > raiseLimit and no chips behind for the opponent.
    const last = oracleNodeAt(root, [A(2), A(2), A(2)]);
    expectActions(last, [["fold", 0], ["call", 100]]);
    const fold = oracleNodeAt(root, [A(2), A(2), A(2), A(0)]);
    expect(fold.terminal).toBe("fold");
    expect(fold.folder).toBe(1);
    expect(fold.contributions).toEqual([100, 26.25]);
  });

  it("raise cap: bet, raise, re-raise, then only fold or call", () => {
    const root = oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 100 });
    // OOP bets 3.3 (pot 13.3). IP raises to 3.3 + 0.75 × 16.6 = 15.75.
    expectActions(oracleNodeAt(root, [A(1)]), [["fold", 0], ["call", 3.3], ["raise", 15.75], ["allin", 100]]);
    // OOP: pot 29.05, toCall 12.45, inc 12.45. to = 15.75 + 0.75 × 41.5 = 46.875 (adds 43.575 < 0.67 × 96.7).
    expectActions(oracleNodeAt(root, [A(1), A(2)]), [["fold", 0], ["call", 15.75], ["raise", 46.875], ["allin", 100]]);
    // IP: n = 3 > 2, so no raise and no all-in even with 84.25 behind.
    const capped = oracleNodeAt(root, [A(1), A(2), A(2)]);
    expect(capped.stacks[1]).toBeCloseTo(84.25, 12);
    expectActions(capped, [["fold", 0], ["call", 46.875]]);

    // raiseLimit 1: the re-raise is gone.
    const root1 = oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 100, raiseLimit: 1 });
    expectActions(oracleNodeAt(root1, [A(1)]), [["fold", 0], ["call", 3.3], ["raise", 15.75], ["allin", 100]]);
    expectActions(oracleNodeAt(root1, [A(1), A(2)]), [["fold", 0], ["call", 15.75]]);
  });

  it("min-bet clamp with merging, min-raise clamp", () => {
    const root = oracleTree({
      board: river,
      ranges: [[], []],
      pot: 2,
      stack: 50,
      sizes: { river: [{ bet: [0.2, 0.1, 0.75], raise: [] }, { bet: [], raise: [0.1] }] },
    });
    // 0.1 × 2 and 0.2 × 2 both clamp to minBet 1 and merge (first label kept); 0.75 × 2 = 1.5.
    expectActions(root, [["check", 0], ["bet", 1], ["bet", 1.5], ["allin", 50]]);
    expect(root.actions!.map((a) => a.label)).toEqual(["체크", "벳 1", "벳 75%", "올인"]);
    // IP raise 0.1: 1 + 0.1 × (3 + 1) = 1.4, clamped to the min raise 1 + 1 = 2.
    const ip = oracleNodeAt(root, [A(1)]);
    expectActions(ip, [["fold", 0], ["call", 1], ["raise", 2], ["allin", 50]]);
    expect(ip.actions![2].label).toBe("레이즈 2");
    // OOP has no raise sizes but still gets the all-in.
    expectActions(oracleNodeAt(root, [A(1), A(2)]), [["fold", 0], ["call", 2], ["allin", 50]]);
  });

  it("all-in threshold, addAllIn off, short stacks", () => {
    // 7.5 ≥ 0.67 × 11 = 7.37 → the 75% bet is the all-in.
    expectActions(oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 11 }), [
      ["check", 0],
      ["bet", 3.3],
      ["allin", 11],
    ]);
    // addAllIn false: a bet that became an all-in is still offered as the all-in action...
    expectActions(oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 11, addAllIn: false }), [
      ["check", 0],
      ["bet", 3.3],
      ["allin", 11],
    ]);
    // ...but there is no extra all-in when no bet reaches it.
    expectActions(oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 100, addAllIn: false }), [
      ["check", 0],
      ["bet", 3.3],
      ["bet", 7.5],
    ]);

    // Stack 8: every raise is an all-in.
    const root = oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 8 });
    expectActions(root, [["check", 0], ["bet", 3.3], ["allin", 8]]);
    expectActions(oracleNodeAt(root, [A(1)]), [["fold", 0], ["call", 3.3], ["allin", 8]]);
    // OOP has exactly the call behind: no raise.
    expectActions(oracleNodeAt(root, [A(1), A(2)]), [["fold", 0], ["call", 8]]);
    const sd = oracleNodeAt(root, [A(1), A(2), A(1)]);
    expect(sd.terminal).toBe("showdown");
    expect(sd.stacks).toEqual([0, 0]);
    expect(sd.pot).toBeCloseTo(26, 12);

    // An all-in for less than a min raise is still offered: bet 6 of 10, the min raise would be to 12.
    const r2 = oracleTree({
      board: river,
      ranges: [[], []],
      pot: 10,
      stack: 10,
      sizes: { river: [{ bet: [0.6], raise: [] }, { bet: [], raise: [] }] },
    });
    expectActions(r2, [["check", 0], ["bet", 6], ["allin", 10]]);
    expectActions(oracleNodeAt(r2, [A(1)]), [["fold", 0], ["call", 6], ["allin", 10]]);
  });

  it("stack 0: river showdown, flop double runout", () => {
    const r = oracleTree({ board: river, ranges: [[], []], pot: 10, stack: 0 });
    expect(r.kind).toBe("terminal");
    expect(r.terminal).toBe("showdown");

    const flop = parseCards("2c3d7h");
    const f = oracleTree({ board: flop, ranges: [[], []], pot: 10, stack: 0 });
    expect(f.kind).toBe("chance");
    expect(f.street).toBe("flop");
    expect(f.cards!.length).toBe(49);
    const turn = oracleNodeAt(f, [C("Ks")]);
    expect(turn.kind).toBe("chance");
    expect(turn.street).toBe("turn");
    expect(turn.cards!.length).toBe(48);
    const end = oracleNodeAt(f, [C("Ks"), C("2s")]);
    expect(end.terminal).toBe("showdown");
    expect(end.board).toEqual([...flop, cardFromString("Ks"), cardFromString("2s")]);
    expect(oracleTreeStats(f)).toEqual({ actionNodes: 0, chanceNodes: 50, terminalNodes: 49 * 48 });
  });

  it("turn -> chance node -> river, and a turn all-in runout", () => {
    const turnBoard = parseCards("2c3d7h8s");
    const input: SolverInput = {
      board: turnBoard,
      ranges: [[], []],
      pot: 10,
      stack: 100,
      addAllIn: false,
      sizes: {
        turn: [{ bet: [0.5], raise: [] }, { bet: [0.5], raise: [] }],
        river: [{ bet: [], raise: [] }, { bet: [], raise: [] }],
      },
    };
    const root = oracleTree(input);
    expect(root.street).toBe("turn");
    expectActions(root, [["check", 0], ["bet", 5]]);
    expectActions(oracleNodeAt(root, [A(0)]), [["check", 0], ["bet", 5]]);

    // Check-check: chance node with the 48 unseen cards, ascending.
    const ch = oracleNodeAt(root, [A(0), A(0)]);
    expect(ch.kind).toBe("chance");
    expect(ch.street).toBe("turn");
    expect(ch.cards!.length).toBe(48);
    expect([...ch.cards!].sort((a, b) => a - b)).toEqual(ch.cards);
    expect(ch.cards!.some((c) => turnBoard.includes(c))).toBe(false);
    expect(() => oracleNodeAt(root, [A(0), A(0), C("8s")])).toThrow();
    expect(() => oracleNodeAt(root, [A(0), A(0), A(0)])).toThrow();

    // River: OOP acts first, bets reset, only check (no sizes, no all-in).
    const rv = oracleNodeAt(root, [A(0), A(0), C("Ks")]);
    expect(rv.street).toBe("river");
    expect(rv.player).toBe(0);
    expect(rv.bets).toEqual([0, 0]);
    expect(rv.pot).toBe(10);
    expectActions(rv, [["check", 0]]);
    expect(oracleNodeAt(root, [A(0), A(0), C("Ks"), A(0), A(0)]).terminal).toBe("showdown");

    // Bet-call on the turn: the chance node keeps the turn bets, the river starts at [0, 0].
    expectActions(oracleNodeAt(root, [A(1)]), [["fold", 0], ["call", 5]]);
    const ch2 = oracleNodeAt(root, [A(1), A(1)]);
    expect(ch2.kind).toBe("chance");
    expect(ch2.pot).toBe(20);
    expect(ch2.bets).toEqual([5, 5]);
    const rv2 = oracleNodeAt(root, [A(1), A(1), C("Kd")]);
    expect(rv2.bets).toEqual([0, 0]);
    expect(rv2.stacks).toEqual([95, 95]);
    expect(rv2.contributions).toEqual([5, 5]);

    // Turn all-in and call: one chance node, then showdown terminals on the river.
    const short = oracleTree({ board: turnBoard, ranges: [[], []], pot: 10, stack: 10 });
    const allinIdx = short.actions!.findIndex((a) => a.kind === "allin");
    const run = oracleNodeAt(short, [A(allinIdx), A(1)]);
    expect(run.kind).toBe("chance");
    expect(run.pot).toBe(30);
    expect(run.children.every((c) => c.kind === "terminal" && c.terminal === "showdown")).toBe(true);

    // Illegal paths throw.
    expect(() => oracleNodeAt(root, [A(5)])).toThrow();
    expect(() => oracleNodeAt(root, [C("Ks")])).toThrow();
    expect(() => oracleNodeAt(root, [A(1), A(0), A(0)])).toThrow();
  });

  it("tree invariants on a default turn tree", () => {
    const root = oracleTree({ board: parseCards("2c3d7h8s"), ranges: [[], []], pot: 6, stack: 20 });
    forEachNode(root, (n) => {
      expect(n.pot).toBeCloseTo(6 + n.contributions[0] + n.contributions[1], 9);
      expect(n.stacks[0]).toBeCloseTo(20 - n.contributions[0], 9);
      if (n.kind === "terminal" && n.terminal === "showdown") {
        expect(n.contributions[0]).toBe(n.contributions[1]);
        expect(n.board.length).toBe(5);
      }
      if (n.kind === "action") {
        for (const a of n.actions!) if (a.kind === "allin") expect(a.to).toBeCloseTo(n.bets[n.player!] + n.stacks[n.player!], 9);
      }
    });
  });
});

// ---------- inputs (docs/solver.md "Inputs") ----------

describe("oracle input rules", () => {
  const river = parseCards("2c3d7h8sKs");
  const base: SolverInput = { board: river, ranges: [[], []], pot: 10, stack: 100 };

  it("a stack of at most 1e-9 counts as 0: the root is the runout", () => {
    for (const stack of [1e-12, 1e-9]) {
      const root = oracleTree({ ...base, stack });
      expect(root.terminal).toBe("showdown");
      expect(root.stacks).toEqual([0, 0]);
      expect(root.contributions).toEqual([0, 0]);
    }
    const tiny = oracleTree({ ...base, stack: 2e-9 });
    expect(tiny.actions!.map((a) => [a.kind, a.to])).toEqual([["check", 0], ["allin", 2e-9]]);
  });

  it("rejects invalid settings and sizes", () => {
    const sizes = (bet: unknown[]) => ({ river: [{ bet, raise: [] }, { bet: [], raise: [] }] }) as unknown as SolverInput["sizes"];
    const bad: Partial<SolverInput>[] = [
      { pot: 0 }, { pot: NaN }, { pot: Infinity }, { stack: -1 }, { stack: NaN }, { stack: Infinity },
      { minBet: 0 }, { minBet: 1e-9 }, { minBet: NaN }, { minBet: Infinity },
      { raiseLimit: -1 }, { raiseLimit: 0.5 }, { raiseLimit: Infinity }, { addAllIn: 1 as never },
      { compress: 1 as never }, { compress: "true" as never },
      { allInThreshold: 0 }, { allInThreshold: NaN }, { allInThreshold: Infinity },
      { sizes: sizes([NaN]) }, { sizes: sizes([-0.25]) }, { sizes: sizes([Infinity]) }, { sizes: sizes(["0.5"]) },
      { sizes: { turn: [{ bet: [-1], raise: [] }, { bet: [], raise: [] }] } },
      { sizes: { river: [{ bet: [], raise: [] }] } as never },
    ];
    for (const over of bad) expect(() => oracleTree({ ...base, ...over }), JSON.stringify(over)).toThrow(/oracle/);
    // Size 0 and thresholds above 1 are fine.
    expectActions(oracleTree({ ...base, sizes: sizes([0]), allInThreshold: 1.5 }), [["check", 0], ["bet", 1], ["allin", 100]]);
  });

  it("labels a bet raised to minBet with the amount to 0.01", () => {
    const label = (minBet: number) => oracleTree({ ...base, pot: 1, minBet }).actions![1].label;
    expect(label(1.25)).toBe("벳 1.25");
    expect(label(1.5)).toBe("벳 1.5");
    expect(label(2)).toBe("벳 2");
  });

  it("a path step has exactly one of action and card, with an integer value", () => {
    const root = oracleTree(base);
    expect(oracleNodeAt(root, [A(1)]).player).toBe(1);
    for (const step of [{ action: "1" }, { action: 1, card: 5 }, {}, null, { action: 1.5 }])
      expect(() => oracleNodeAt(root, [step as PathStep]), JSON.stringify(step)).toThrow(/oracle/);
  });

  it("range weights must be numbers in [0, 1], at most 1326 of them", () => {
    const ok = rangeOfCombos({ AhAd: 1, QhQd: 0.5 });
    for (const w of [NaN, -0.1, 1.5, 100]) {
      const r = Float64Array.from(ok);
      r[comboIndex("KsKh")] = w; // on the board, still checked
      expect(() => oracleHands({ ...base, ranges: [ok, r] }, 1), String(w)).toThrow(/oracle/);
    }
    expect(() => oracleHands({ ...base, ranges: [[...ok, 0], ok] }, 0)).toThrow(/oracle/);
    expect(oracleHands({ ...base, ranges: [Array.from(ok).slice(0, 200), ok] }, 0).map((h) => h.combo)).toEqual(
      oracleHands({ ...base, ranges: [Float64Array.from(ok).fill(0, 200), ok] }, 0).map((h) => h.combo),
    );
  });

  it("a game needs a hand for each player and a pair of them that can be dealt together", () => {
    const qq = rangeOfCombos({ QhQd: 1 });
    // KsKh touches the board: nothing left for OOP. An empty range: nothing for IP.
    expect(() => new OracleGame({ ...base, ranges: [rangeOfCombos({ KsKh: 1 }), qq] })).toThrow(/oracle/);
    expect(() => new OracleGame({ ...base, ranges: [qq, []] })).toThrow(/oracle/);
    // Every IP hand shares a card with OOP's only hand.
    expect(() => new OracleGame({ ...base, ranges: [rangeOfCombos({ AhAd: 1 }), rangeOfCombos({ AhQd: 0.3, AdJc: 0.7 })] })).toThrow(
      /oracle/,
    );
    expect(new OracleGame({ ...base, ranges: [rangeOfCombos({ AhAd: 1 }), rangeOfCombos({ AhQd: 0.3, AsJc: 0.7 })] }).pairWeightSum()).toBe(0.7);
  });
});

// ---------- game: payoffs and chance ----------

describe("oracle game", () => {
  it("terminal nets follow the spec", () => {
    const board = parseCards("2c3d7h8sKs");
    const input: SolverInput = {
      board,
      ranges: [rangeOfCombos({ KhKd: 1, "5h4h": 1 }), rangeOfCombos({ QcQd: 1 })],
      pot: 10,
      stack: 100,
    };
    const game = new OracleGame(input);
    const kk = game.hands[0].find((h) => h.combo === comboIndex("KhKd"))!;
    const air = game.hands[0].find((h) => h.combo === comboIndex("5h4h"))!;
    const qq = game.hands[1][0];
    // Path: OOP bets 7.5, IP raises to 26.25, OOP folds -> OOP net −7.5, IP net 10 + 7.5.
    const fold = oracleNodeAt(game.root, [A(2), A(2), A(0)]);
    expect(terminalNet0(fold, 10, kk, qq)).toBeCloseTo(-7.5, 12);
    // Call there: showdown with x = 26.25.
    const sd = oracleNodeAt(game.root, [A(2), A(2), A(1)]);
    expect(terminalNet0(sd, 10, kk, qq)).toBeCloseTo(36.25, 12);
    expect(terminalNet0(sd, 10, air, qq)).toBeCloseTo(-26.25, 12);
    expect(chanceProbability(parseCards("2c3d7h8s"))).toBeCloseTo(1 / 44, 15);
  });
});

// ---------- (b) best response to a hand-specified strategy ----------

describe("oracle best response", () => {
  /*
   * River 2c3d7h8sKs, P0 = 10, S = 10. OOP may check or bet pot (= all-in); IP may only
   * check behind, or fold / call. Tree: root [check, allin]; after check IP [check];
   * after all-in IP [fold, call].
   *
   * OOP: KhKd (trips) and 5h4h (5-high). IP: QcQd (pair of queens) and Kh5c (pair of kings).
   * Kh5c can't be dealt with KhKd. Compatible pairs: KK-QQ, 54-QQ, 54-K5 → normalizer 3.
   *
   * Strategy: KK checks 0.25 / jams 0.75; 54 checks 0.6 / jams 0.4.
   *           Facing the jam QQ folds 0.5 / calls 0.5; K5 always calls.
   *
   * BR_0 (OOP best-responds):
   *   KK vs QQ: check → 10; jam → 0.5 × 10 + 0.5 × 20 = 15. Take 15.
   *   54 vs {QQ, K5}: check → 0 + 0 = 0; jam → (0.5 × 10 − 0.5 × 10) + (−10) = −10. Take 0.
   *   BR_0 = (15 + 0) / 3 = 5.
   * BR_1 (IP best-responds):
   *   QQ: after check, reach KK 0.25, 54 0.6: 0.25 × 0 + 0.6 × 10 = 6.
   *       after jam, reach KK 0.75, 54 0.4: fold 0; call 0.75 × (−10) + 0.4 × 20 = 0.5. Take 0.5. Total 6.5.
   *   K5 (only vs 54): after check 0.6 × 10 = 6; after jam call 0.4 × 20 = 8 > fold 0. Total 14.
   *   BR_1 = 20.5 / 3.
   * Exploitability = (5 + 20.5/3 − 10) / 2 / 10 × 100 = 9.1666…%.
   * Values on the strategy: KK-QQ 0.25 × 10 + 0.75 × 15 = 13.75; 54-QQ 0; 54-K5 0.4 × (−10) = −4.
   *   v0 = 9.75 / 3 = 3.25, v1 = 10 − 3.25 = 6.75.
   */
  const board = parseCards("2c3d7h8sKs");
  const input: SolverInput = {
    board,
    ranges: [rangeOfCombos({ KhKd: 1, "5h4h": 1 }), rangeOfCombos({ QcQd: 1, Kh5c: 1 })],
    pot: 10,
    stack: 10,
    raiseLimit: 0,
    addAllIn: false,
    sizes: { river: [{ bet: [1], raise: [] }, { bet: [], raise: [] }] },
  };
  const KK = comboIndex("KhKd");
  const AIR = comboIndex("5h4h");
  const QQ = comboIndex("QcQd");
  const K5 = comboIndex("Kh5c");
  const strategy: StrategyFn = (path, combo) => {
    if (path.length === 0) {
      if (combo === KK) return [0.25, 0.75];
      if (combo === AIR) return [0.6, 0.4];
    } else if (path.length === 1 && "action" in path[0]) {
      if (path[0].action === 0) return [1];
      if (combo === QQ) return [0.5, 0.5];
      if (combo === K5) return [0, 1];
    }
    throw new Error(`unexpected query ${JSON.stringify(path)} ${combo}`);
  };

  it("tree is the one described", () => {
    const root = oracleTree(input);
    expectActions(root, [["check", 0], ["allin", 10]]);
    expectActions(oracleNodeAt(root, [A(0)]), [["check", 0]]);
    expectActions(oracleNodeAt(root, [A(1)]), [["fold", 0], ["call", 10]]);
  });

  it("matches the hand-computed BR values and exploitability", () => {
    const br = oracleBestResponse(input, strategy);
    expect(br.br0).toBeCloseTo(5, 12);
    expect(br.br1).toBeCloseTo(20.5 / 3, 12);
    expect(br.exploitability).toBeCloseTo(((5 + 20.5 / 3 - 10) / 2 / 10) * 100, 10);
    const v = oracleValue(input, strategy);
    expect(v[0]).toBeCloseTo(3.25, 12);
    expect(v[1]).toBeCloseTo(6.75, 12);
  });

  it("node ranges and per-combo EVs", () => {
    // After the jam: OOP reach KK 0.75, 54 0.4. IP QQ: (0.75 × (0.5 × 0 − 0.5 × 10) + 0.4 × (0.5 × 20)) / 1.15.
    const info = oracleNodeInfo(input, strategy, [A(1)]);
    expect(info.ranges[0][KK]).toBeCloseTo(0.75, 12);
    expect(info.ranges[0][AIR]).toBeCloseTo(0.4, 12);
    expect(info.ranges[1][QQ]).toBe(1);
    expect(info.ev[1][QQ]).toBeCloseTo(0.25 / 1.15, 12);
    expect(info.ev[1][K5]).toBeCloseTo(20, 12);
    expect(info.ev[0][KK]).toBeCloseTo(15, 12);
    expect(info.ev[0][AIR]).toBeCloseTo(-5, 12);
    expect(Number.isNaN(info.ev[0][QQ])).toBe(true);
    expect(info.ranges[0][comboIndex("AsAh")]).toBe(0);
    // Root: KK 0.25 × 10 + 0.75 × 15 = 13.75; 54: (0 + 0.4 × (−10)) / 2 = −2.
    const root = oracleNodeInfo(input, strategy, []);
    expect(root.ev[0][KK]).toBeCloseTo(13.75, 12);
    expect(root.ev[0][AIR]).toBeCloseTo(-2, 12);
  });

  it("rejects strategies that are not distributions", () => {
    expect(() => oracleBestResponse(input, () => [0.5, 0.2])).toThrow();
  });
});

// ---------- (a) toy polarized river game ----------

describe("oracle CFR on the toy river game", () => {
  it("KK always bets, bluffs are 1/3 of bets, QQ calls half", () => {
    const board = parseCards("2c3d7h8sKs");
    const kk = combosOf("KK").filter(([a, b]) => !board.includes(a) && !board.includes(b));
    expect(kk.length).toBe(3);
    const oop = rangeOfClasses(["KK", "54s", "54o"]);
    const ip = rangeOfClasses(["QQ"]);
    const input: SolverInput = {
      board,
      ranges: [oop, ip],
      pot: 10,
      stack: 10,
      raiseLimit: 0,
      addAllIn: false,
      sizes: { river: [{ bet: [1], raise: [] }, { bet: [], raise: [] }] },
    };
    const game = new OracleGame(input);
    expect(game.hands[0].length).toBe(3 + 16);
    expect(game.hands[1].length).toBe(6);

    const res = oracleSolve(input, 3000);
    expect(res.exploitability).toBeLessThan(0.3);

    let kkBet = 0;
    let airBet = 0;
    for (const h of game.hands[0]) {
      const pBet = res.strategyAt([], h.combo)[1];
      if (COMBOS[h.combo].hand === "KK") kkBet += pBet;
      else airBet += pBet;
    }
    expect(kkBet / 3).toBeGreaterThan(0.99);
    expect(airBet / (airBet + kkBet)).toBeCloseTo(1 / 3, 1.5);

    let call = 0;
    for (const h of game.hands[1]) call += res.strategyAt([A(1)], h.combo)[1];
    expect(call / 6).toBeCloseTo(0.5, 1.5);

    // Game value: KK earns 15 against QQ (18 pairs), air earns 0; 19 × 6 pairs in all.
    expect(res.value0).toBeCloseTo(270 / 114, 1.5);
  });
});

// ---------- (c) convergence ----------

describe("oracle CFR convergence", () => {
  it("river spot with default sizes: exploitability goes down", () => {
    const board = parseCards("Ks9h5c2d7s");
    const input: SolverInput = {
      board,
      ranges: [rangeOfClasses(["AA", "KQs", "T9s", "65s", "A4s"]), rangeOfClasses(["QQ", "JJ", "K9s", "86s"])],
      pot: 10,
      stack: 40,
    };
    const solver = createOracleCfr(input);
    const expl: number[] = [];
    for (const target of [5, 40, 300]) {
      solver.iterate(target - solver.iteration);
      expl.push(solver.exploitability());
    }
    expect(expl[1]).toBeLessThan(expl[0]);
    expect(expl[2]).toBeLessThan(expl[1]);
    expect(expl[2]).toBeLessThan(0.5);
    for (const e of expl) expect(e).toBeGreaterThanOrEqual(-1e-9);

    const v = oracleValue(input, solver.strategyAt);
    const br = oracleBestResponse(input, solver.strategyAt);
    expect(v[0] + v[1]).toBeCloseTo(10, 9);
    expect(br.br0).toBeGreaterThanOrEqual(v[0] - 1e-9);
    expect(br.br1).toBeGreaterThanOrEqual(v[1] - 1e-9);
  });

  it("turn spot: chance nodes, exploitability goes down", () => {
    const board = parseCards("Ks9h5c2d");
    const input: SolverInput = {
      board,
      ranges: [rangeOfClasses(["AA", "T9s", "65s"]), rangeOfClasses(["QQ", "K9s", "87s"])],
      pot: 10,
      stack: 20,
      raiseLimit: 1,
      sizes: {
        turn: [{ bet: [0.5], raise: [] }, { bet: [0.5], raise: [] }],
        river: [{ bet: [0.75], raise: [] }, { bet: [0.75], raise: [] }],
      },
    };
    const solver = createOracleCfr(input);
    solver.iterate(3);
    const e3 = solver.exploitability();
    solver.iterate(57);
    const e60 = solver.exploitability();
    expect(e60).toBeLessThan(e3);
    expect(e60).toBeGreaterThanOrEqual(-1e-9);
  });
});

// ---------- values against a brute-force sum over explicit pairs ----------

describe("oracle values vs brute force over hand pairs", () => {
  it("uniform strategy on a turn spot", () => {
    const board = parseCards("Ks9h5c2d");
    const input: SolverInput = {
      board,
      ranges: [rangeOfCombos({ AhAd: 1, Th9d: 0.5, "6s5s": 1, KhQh: 0.7 }), rangeOfCombos({ QsQd: 1, Kd9c: 1, "8c7c": 0.3, AhKc: 1 })],
      pot: 8,
      stack: 12,
      sizes: {
        turn: [{ bet: [0.5], raise: [0.5] }, { bet: [0.5], raise: [0.5] }],
        river: [{ bet: [1], raise: [] }, { bet: [0.5], raise: [] }],
      },
    };
    const root = oracleTree(input);
    const uniform = uniformOn(root);

    // Brute force: expected net0 for one pair, following the tree with uniform actions and dealing cards.
    const ev0 = (node: OracleNode, h0: [Card, Card], h1: [Card, Card]): number => {
      if (node.kind === "terminal") {
        return terminalNet0(node, input.pot, { combo: 0, cards: h0, weight: 1 }, { combo: 0, cards: h1, weight: 1 });
      }
      if (node.kind === "chance") {
        let v = 0;
        let count = 0;
        node.cards!.forEach((c, k) => {
          if (h0.includes(c) || h1.includes(c)) return;
          count++;
          v += ev0(node.children[k], h0, h1) / (52 - node.board.length - 4);
        });
        expect(count).toBe(52 - node.board.length - 4);
        return v;
      }
      const n = node.children.length;
      return node.children.reduce((s, c) => s + ev0(c, h0, h1) / n, 0);
    };

    let num = 0;
    let den = 0;
    const H0 = new OracleGame(input).hands;
    for (const a of H0[0]) {
      for (const b of H0[1]) {
        if (a.cards.some((c) => b.cards.includes(c))) continue;
        const w = a.weight * b.weight;
        den += w;
        num += w * ev0(root, a.cards, b.cards);
      }
    }
    const v = oracleValue(input, uniform);
    expect(v[0]).toBeCloseTo(num / den, 9);
    expect(v[1]).toBeCloseTo(input.pot - num / den, 9);

    const br = oracleBestResponse(input, uniform);
    expect(br.br0).toBeGreaterThan(v[0]);
    expect(br.br1).toBeGreaterThan(v[1]);
    expect(br.exploitability).toBeGreaterThan(0);
  });
});
