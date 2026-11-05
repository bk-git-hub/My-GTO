import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { buildTree, estimateMemory } from "./index";
import { buildGameTree, type GameNode } from "./tree";
import type { GameTreeNode, SolverInput, StreetSizes } from "./types";

const RIVER = parseCards("2c3d7h8sKs");
const TURN = parseCards("2c3d7h8s");
const FLOP = parseCards("2c3d7h");
const noRanges: [Float64Array, Float64Array] = [new Float64Array(1326), new Float64Array(1326)];

const spot = (over: Partial<SolverInput>): SolverInput => ({ board: RIVER, ranges: noRanges, pot: 10, stack: 100, ...over });

/** Round to 1e-6 to hide float noise like 3.3000000000000003. */
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** [kind, to] pairs. */
const acts = (n: GameTreeNode) => n.actions!.map((a) => [a.kind, r6(a.to)]);

/** Follow action indices from a node. */
const go = (n: GameTreeNode, ...path: number[]) => path.reduce((m, i) => m.children[i], n);

function count(n: GameTreeNode, c = { action: 0, chance: 0, terminal: 0 }) {
  if (n.kind === "action") c.action++;
  else if (n.kind === "chance") c.chance++;
  else c.terminal++;
  for (const k of n.children) count(k, c);
  return c;
}

describe("tree: not facing a bet", () => {
  it("river pot 10 stack 100, default sizes", () => {
    const root = buildTree(spot({}));
    expect(root.kind).toBe("action");
    expect(root.street).toBe("river");
    expect(root.player).toBe(0);
    // 0.33 × 10 = 3.3, 0.75 × 10 = 7.5, both under 0.67 × 100.
    expect(acts(root)).toEqual([["check", 0], ["bet", 3.3], ["bet", 7.5], ["allin", 100]]);
    expect(root.actions!.map((a) => a.label)).toEqual(["체크", "벳 33%", "벳 75%", "올인"]);
    // OOP checks: IP has the same menu.
    const ip = go(root, 0);
    expect(ip.player).toBe(1);
    expect(acts(ip)).toEqual([["check", 0], ["bet", 3.3], ["bet", 7.5], ["allin", 100]]);
    // Check-check on the river is a showdown.
    expect(go(root, 0, 0).terminal).toBe("showdown");
  });

  it("min bet clamp: pot 2 makes a 33% bet 0.66, raised to minBet 1", () => {
    const root = buildTree(spot({ pot: 2 }));
    expect(acts(root)).toEqual([["check", 0], ["bet", 1], ["bet", 1.5], ["allin", 100]]);
    expect(root.actions![1].label).toBe("벳 1");
    expect(root.actions![2].label).toBe("벳 75%");
    // Two sizes clamped to the same amount merge into one (keeping the first).
    const merged = buildTree(spot({ pot: 2, sizes: { river: [{ bet: [0.1, 0.2, 0.75], raise: [] }, { bet: [], raise: [] }] } }));
    expect(acts(merged)).toEqual([["check", 0], ["bet", 1], ["bet", 1.5], ["allin", 100]]);
  });

  it("all-in threshold turns a bet into the all-in, even without addAllIn", () => {
    // Stack 10: 7.5 >= 0.67 × 10 = 6.7, so the 75% bet is the all-in.
    expect(acts(buildTree(spot({ stack: 10 })))).toEqual([["check", 0], ["bet", 3.3], ["allin", 10]]);
    expect(acts(buildTree(spot({ stack: 10, addAllIn: false })))).toEqual([["check", 0], ["bet", 3.3], ["allin", 10]]);
    // Stack 12: 7.5 < 8.04 stays a bet.
    expect(acts(buildTree(spot({ stack: 12 })))).toEqual([["check", 0], ["bet", 3.3], ["bet", 7.5], ["allin", 12]]);
    // No addAllIn and no conversion: no all-in at all.
    expect(acts(buildTree(spot({ addAllIn: false })))).toEqual([["check", 0], ["bet", 3.3], ["bet", 7.5]]);
    // A bet of at least the whole stack is the all-in too (threshold above 1).
    expect(acts(buildTree(spot({ stack: 5, allInThreshold: 2, addAllIn: false, sizes: { river: [{ bet: [0.33, 0.75], raise: [] }, { bet: [], raise: [] }] } }))))
      .toEqual([["check", 0], ["bet", 3.3], ["allin", 5]]);
  });
});

describe("tree: facing a bet", () => {
  it("raise formula and the default raise chain, then the cap", () => {
    const root = buildTree(spot({}));
    // OOP bets 3.3 into 10: pot 13.3, toCall 3.3. Raise to 3.3 + 0.75 × (13.3 + 3.3) = 15.75.
    const ip = go(root, 1);
    expect(ip.pot).toBeCloseTo(13.3, 9);
    expect(acts(ip)).toEqual([["fold", 0], ["call", 3.3], ["raise", 15.75], ["allin", 100]]);
    expect(ip.actions!.map((a) => a.label)).toEqual(["폴드", "콜", "레이즈 15.8", "올인"]);
    // OOP faces 15.75: pot 29.05, toCall 12.45. Re-raise to 15.75 + 0.75 × (29.05 + 12.45) = 46.875.
    const oop = go(ip, 2);
    expect(oop.bets[0]).toBeCloseTo(3.3, 9);
    expect(oop.bets[1]).toBeCloseTo(15.75, 9);
    expect(acts(oop)).toEqual([["fold", 0], ["call", 15.75], ["raise", 46.875], ["allin", 100]]);
    // Bet, raise, re-raise = n 3 > raiseLimit 2: only fold or call.
    expect(acts(go(oop, 2))).toEqual([["fold", 0], ["call", 46.875]]);
    expect(acts(go(oop, 3))).toEqual([["fold", 0], ["call", 100]]);
    // A call ends the river: showdown with both bets equal.
    const sd = go(oop, 1);
    expect(sd.terminal).toBe("showdown");
    expect(sd.bets.map(r6)).toEqual([15.75, 15.75]);
    expect(sd.pot).toBeCloseTo(10 + 2 * 15.75, 9);
    // A fold is a fold terminal.
    expect(go(oop, 0).terminal).toBe("fold");
    expect(go(oop, 0).folder).toBe(0);
  });

  it("min-raise clamp: a raise smaller than the last increment goes up to max bet + inc", () => {
    const sizes: [StreetSizes, StreetSizes] = [{ bet: [0.75], raise: [] }, { bet: [], raise: [0.1, 0.75] }];
    const ip = go(buildTree(spot({ sizes: { river: sizes } })), 1);
    // Facing 7.5 into 10 (pot 17.5): 0.1 → 7.5 + 0.1 × 25 = 10 < 7.5 + 7.5 → 15; 0.75 → 26.25.
    expect(acts(ip)).toEqual([["fold", 0], ["call", 7.5], ["raise", 15], ["raise", 26.25], ["allin", 100]]);
    // Two raise sizes both clamped to the minimum merge.
    const ip2 = go(buildTree(spot({ sizes: { river: [{ bet: [0.75], raise: [] }, { bet: [], raise: [0.05, 0.1] }] } })), 1);
    expect(acts(ip2)).toEqual([["fold", 0], ["call", 7.5], ["raise", 15], ["allin", 100]]);
  });

  it("raise cap: raiseLimit 1 allows one raise, 0 allows none", () => {
    const one = buildTree(spot({ raiseLimit: 1 }));
    expect(acts(go(one, 1))).toEqual([["fold", 0], ["call", 3.3], ["raise", 15.75], ["allin", 100]]);
    expect(acts(go(one, 1, 2))).toEqual([["fold", 0], ["call", 15.75]]);
    const none = buildTree(spot({ raiseLimit: 0 }));
    expect(acts(go(none, 1))).toEqual([["fold", 0], ["call", 3.3]]);
    expect(acts(go(none, 3))).toEqual([["fold", 0], ["call", 100]]);
  });

  it("short stack: every raise is the all-in", () => {
    // Stack 12: OOP bets 3.3; a 0.75 raise would be to 15.75 > 12, so only the all-in remains.
    const root = buildTree(spot({ stack: 12 }));
    expect(acts(go(root, 1))).toEqual([["fold", 0], ["call", 3.3], ["allin", 12]]);
    expect(acts(go(root, 2))).toEqual([["fold", 0], ["call", 7.5], ["allin", 12]]);
    // Facing an all-in: the opponent has no chips behind, so fold or call.
    expect(acts(go(root, 3))).toEqual([["fold", 0], ["call", 12]]);
    expect(go(root, 3, 1).terminal).toBe("showdown");
  });

  it("an all-in for less than a minimum raise is still offered and leaves inc unchanged", () => {
    // Stack 5: OOP bets 3.3 (< 0.67 × 5 = 3.35). The min raise would be to 6.6 but IP only has 5.
    const root = buildTree(spot({ stack: 5 }));
    expect(acts(root)).toEqual([["check", 0], ["bet", 3.3], ["allin", 5]]);
    const ip = go(root, 1);
    expect(acts(ip)).toEqual([["fold", 0], ["call", 3.3], ["allin", 5]]);
    const oop = go(ip, 2);
    expect(oop.stacks[0]).toBeCloseTo(1.7, 9);
    expect(oop.stacks[1]).toBe(0);
    expect(acts(oop)).toEqual([["fold", 0], ["call", 5]]);
  });

  it("without addAllIn there is no all-in raise unless a size converts", () => {
    const ip = go(buildTree(spot({ addAllIn: false })), 1);
    expect(acts(ip)).toEqual([["fold", 0], ["call", 3.3], ["raise", 15.75]]);
  });
});

describe("tree: streets and all-ins", () => {
  it("stack 0: the root is the runout", () => {
    const river = buildTree(spot({ stack: 0 }));
    expect(river.kind).toBe("terminal");
    expect(river.terminal).toBe("showdown");

    const turn = buildTree(spot({ board: TURN, stack: 0 }));
    expect(turn.kind).toBe("chance");
    expect(turn.cards).toHaveLength(48);
    for (const c of turn.children) {
      expect(c.terminal).toBe("showdown");
      expect(c.board).toHaveLength(5);
    }

    const flop = buildTree(spot({ board: FLOP, stack: 0 }));
    expect(flop.kind).toBe("chance");
    expect(flop.cards).toHaveLength(49);
    expect(flop.children[0].kind).toBe("chance");
    expect(flop.children[0].cards).toHaveLength(48);
    expect(flop.children[0].children[0].terminal).toBe("showdown");
    expect(count(flop)).toEqual({ action: 0, chance: 50, terminal: 49 * 48 });
  });

  it("turn: check-check deals 48 river cards, each a fresh river subtree", () => {
    const root = buildTree(spot({ board: TURN }));
    expect(root.street).toBe("turn");
    const chance = go(root, 0, 0);
    expect(chance.kind).toBe("chance");
    expect(chance.street).toBe("turn");
    expect(chance.cards).toHaveLength(48);
    expect(chance.cards!.some((c) => TURN.includes(c))).toBe(false);
    chance.children.forEach((river, i) => {
      expect(river.kind).toBe("action");
      expect(river.street).toBe("river");
      expect(river.board).toEqual([...TURN, chance.cards![i]]);
      expect(river.player).toBe(0);
      expect(river.pot).toBe(10);
      expect(river.bets).toEqual([0, 0]);
      expect(acts(river)).toEqual([["check", 0], ["bet", 3.3], ["bet", 7.5], ["allin", 100]]);
    });
    // Bet-call on the turn: new street starts with the bigger pot, n and inc reset.
    const afterCall = go(root, 1, 1);
    expect(afterCall.kind).toBe("chance");
    const river = afterCall.children[0];
    expect(river.pot).toBeCloseTo(16.6, 9);
    expect(river.stacks[0]).toBeCloseTo(96.7, 9);
    expect(acts(river)).toEqual([["check", 0], ["bet", r6(0.33 * 16.6)], ["bet", r6(0.75 * 16.6)], ["allin", 96.7]]);
    // On the river after a turn bet: a raise uses inc from the river bet only.
    const ipRiver = go(river, 1);
    const bet = 0.33 * 16.6;
    const to = bet + 0.75 * (16.6 + 2 * bet);
    expect(acts(ipRiver)).toEqual([["fold", 0], ["call", r6(bet)], ["raise", r6(to)], ["allin", 96.7]]);
  });

  it("turn all-in and call: chance then showdown, no more actions", () => {
    const root = buildTree(spot({ board: TURN }));
    const ip = go(root, 3);
    expect(acts(ip)).toEqual([["fold", 0], ["call", 100]]);
    const chance = go(ip, 1);
    expect(chance.kind).toBe("chance");
    expect(chance.stacks).toEqual([0, 0]);
    expect(chance.pot).toBe(210);
    expect(chance.cards).toHaveLength(48);
    for (const sd of chance.children) {
      expect(sd.terminal).toBe("showdown");
      expect(sd.street).toBe("river");
      expect(sd.pot).toBe(210);
    }
  });

  it("flop all-in deals turn then river with no actions in between", () => {
    const root = buildTree(spot({ board: FLOP, stack: 20 }));
    const call = go(root, root.actions!.length - 1, 1);
    expect(call.kind).toBe("chance");
    expect(call.children[0].kind).toBe("chance");
    expect(call.children[0].street).toBe("turn");
    expect(call.children[0].children[0].terminal).toBe("showdown");
  });

  it("fold and showdown terminals carry the right chip counts", () => {
    const root = buildGameTree(spot({ stack: 20 })).root;
    // OOP bets 3.3, IP folds: IP put in nothing, OOP nets the pot.
    const fold = go(root, 1, 0) as GameNode;
    expect(fold.folder).toBe(1);
    expect(fold.invested).toBe(0);
    expect(fold.foldNet(0, 10)).toBe(10);
    expect(fold.foldNet(1, 10)).toBe(0);
    // OOP bets 3.3, IP raises to 15.75 (an all-in at stack 20? 15.75 >= 13.4 → yes), OOP folds.
    const ip = go(root, 1);
    expect(acts(ip)).toEqual([["fold", 0], ["call", 3.3], ["allin", 20]]);
    const oopFolds = go(ip, 2, 0) as GameNode;
    expect(oopFolds.foldNet(0, 10)).toBeCloseTo(-3.3, 9);
    expect(oopFolds.foldNet(1, 10)).toBeCloseTo(13.3, 9);
    const sd = go(ip, 2, 1) as GameNode;
    expect(sd.terminal).toBe("showdown");
    expect(sd.invested).toBe(20);
  });
});

describe("estimateMemory", () => {
  it("counts the same nodes as the built tree without building it", () => {
    for (const s of [
      spot({}),
      spot({ stack: 7 }),
      spot({ board: TURN, pot: 20, stack: 80 }),
      spot({ board: TURN, stack: 0 }),
      spot({ board: FLOP, stack: 0 }),
      spot({ board: FLOP, stack: 4, sizes: { flop: [{ bet: [0.5], raise: [] }, { bet: [0.5], raise: [] }], turn: [{ bet: [], raise: [] }, { bet: [], raise: [] }], river: [{ bet: [], raise: [] }, { bet: [], raise: [] }] } }),
    ]) {
      const est = estimateMemory(s);
      const c = count(buildTree(s));
      expect({ action: est.actionNodes, chance: est.chanceNodes, terminal: est.terminalNodes }).toEqual(c);
      expect(est.bytes).toBeGreaterThan(0);
    }
  });

  it("charges 8 bytes per action per hand of the acting player", () => {
    const one = new Float64Array(1326).fill(1);
    const empty = estimateMemory(spot({}));
    const full = estimateMemory(spot({ ranges: [one, one] }));
    // River board removes 5 cards: C(47, 2) = 1081 hands each.
    const t = buildGameTree(spot({}));
    let slots = 0;
    for (const n of t.actionNodes) slots += n.children.length;
    expect(full.bytes - empty.bytes).toBeGreaterThanOrEqual(8 * slots * 1081);
  });
});

describe("tree: input checks and degenerate inputs", () => {
  const riverSizes = (bet: unknown[], raise: unknown[] = []) =>
    ({ river: [{ bet, raise }, { bet: [], raise: [0.75] }] }) as unknown as SolverInput["sizes"];

  it("a stack of at most 1e-9 is 0: straight to the runout instead of endless 0-chip all-ins", () => {
    for (const stack of [1e-12, 1e-10, 1e-9]) {
      const river = buildTree(spot({ stack }));
      expect(river.kind).toBe("terminal");
      expect(river.terminal).toBe("showdown");
      expect(river.stacks).toEqual([0, 0]);
      expect((river as GameNode).invested).toBe(0);
      const turn = buildTree(spot({ board: TURN, stack }));
      expect(turn.kind).toBe("chance");
      expect(turn.children.every((c) => c.terminal === "showdown")).toBe(true);
      expect(estimateMemory(spot({ board: TURN, stack }))).toMatchObject({ actionNodes: 0, chanceNodes: 1, terminalNodes: 48 });
    }
    // Just above the tolerance it is a real (tiny) stack: every bet is the all-in.
    const tiny = buildTree(spot({ stack: 2e-9 }));
    const exact = (n: GameTreeNode) => n.actions!.map((a) => [a.kind, a.to]);
    expect(exact(tiny)).toEqual([["check", 0], ["allin", 2e-9]]);
    expect(exact(go(tiny, 1))).toEqual([["fold", 0], ["call", 2e-9]]);
  });

  it("minBet must be more than 1e-9, so a bet below the tolerance can't be left uncalled", () => {
    for (const minBet of [0, -1, 1e-9, 1e-12, NaN, Infinity])
      expect(() => buildTree(spot({ minBet, sizes: riverSizes([1e-12]) }))).toThrow(/minBet/);
    // Just above: the opponent faces the tiny bet (fold / call / raise), it can't check it through.
    const root = buildTree(spot({ minBet: 2e-9, sizes: riverSizes([1e-12]) }));
    expect(root.actions!.map((a) => a.kind)).toEqual(["check", "bet", "allin"]);
    expect(root.children[1].actions!.map((a) => a.kind)).toEqual(["fold", "call", "raise", "allin"]);
  });

  it("sizes must be finite numbers >= 0; 0 means the smallest bet or raise", () => {
    for (const bad of [NaN, -0.5, Infinity, -Infinity, "0.5", null])
      expect(() => buildTree(spot({ sizes: riverSizes([0.5, bad]) }))).toThrow(/sizes\.river\[0\]\.bet/);
    expect(() => buildTree(spot({ sizes: riverSizes([0.5], [NaN]) }))).toThrow(/sizes\.river\[0\]\.raise/);
    expect(() => buildTree(spot({ sizes: { river: [{ bet: [0.5] }, { bet: [], raise: [] }] } as never }))).toThrow(/sizes\.river\[0\]\.raise/);
    expect(() => buildTree(spot({ sizes: { river: [{ bet: [], raise: [] }] } as never }))).toThrow(/sizes\.river/);
    // An entry for a street the board never reaches is checked too.
    expect(() => buildTree(spot({ sizes: { flop: [{ bet: [-1], raise: [] }, { bet: [], raise: [] }] } }))).toThrow(/sizes\.flop/);
    // 0: the min bet, then the min raise (to the bet plus its increment).
    const root = buildTree(spot({ pot: 2, minBet: 1.5, sizes: { river: [{ bet: [0], raise: [] }, { bet: [], raise: [0] }] } }));
    expect(acts(root)).toEqual([["check", 0], ["bet", 1.5], ["allin", 100]]);
    expect(root.actions![1].label).toBe("벳 1.5");
    expect(acts(go(root, 1))).toEqual([["fold", 0], ["call", 1.5], ["raise", 3], ["allin", 100]]);
  });

  it("pot, stack, raiseLimit, addAllIn and allInThreshold are checked", () => {
    const bad: [Partial<SolverInput>, RegExp][] = [
      [{ pot: 0 }, /pot/], [{ pot: -1 }, /pot/], [{ pot: NaN }, /pot/], [{ pot: Infinity }, /pot/],
      [{ stack: -1 }, /stack/], [{ stack: NaN }, /stack/], [{ stack: Infinity }, /stack/],
      [{ raiseLimit: -1 }, /raiseLimit/], [{ raiseLimit: 1.5 }, /raiseLimit/], [{ raiseLimit: NaN }, /raiseLimit/],
      [{ raiseLimit: Infinity }, /raiseLimit/],
      [{ addAllIn: "yes" as never }, /addAllIn/],
      [{ allInThreshold: 0 }, /allInThreshold/], [{ allInThreshold: -0.5 }, /allInThreshold/],
      [{ allInThreshold: NaN }, /allInThreshold/], [{ allInThreshold: Infinity }, /allInThreshold/],
      [{ board: [0, 1] }, /board/], [{ board: [0, 1, 1] }, /duplicate/], [{ board: [0, 1, 52] }, /card/],
    ];
    for (const [over, re] of bad) {
      expect(() => buildTree(spot(over)), JSON.stringify(over)).toThrow(re);
      expect(() => estimateMemory(spot(over)), JSON.stringify(over)).toThrow(re);
    }
    // Thresholds above 1 are allowed: only a bet of the whole stack converts.
    expect(acts(buildTree(spot({ allInThreshold: 1.5, stack: 10 })))).toEqual([["check", 0], ["bet", 3.3], ["bet", 7.5], ["allin", 10]]);
  });

  it("a bet raised to minBet is labelled with the amount to 0.01, no trailing zeros", () => {
    const label = (minBet: number) => buildTree(spot({ pot: 1, minBet })).actions![1].label;
    expect(label(1.25)).toBe("벳 1.25");
    expect(label(1.5)).toBe("벳 1.5");
    expect(label(2)).toBe("벳 2");
    expect(label(0.333)).toBe("벳 0.33");
    expect(label(0.336)).toBe("벳 0.34");
    // Raises keep 0.1.
    expect(go(buildTree(spot({})), 1).actions![2].label).toBe("레이즈 15.8");
  });

  it("action lists are shared between nodes with the same betting state, so they are frozen", () => {
    const root = buildTree(spot({ board: TURN }));
    const chance = go(root, 0, 0);
    const a = chance.children[0].actions!, b = chance.children[1].actions!;
    expect(a).toBe(b); // the same river menu under two different cards
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.every((x) => Object.isFrozen(x))).toBe(true);
    expect(() => {
      a[1].to = 999;
    }).toThrow(TypeError);
    expect(() => a.push(a[0])).toThrow(TypeError);
    expect(b[1].to).toBeCloseTo(3.3, 9);
  });
});
