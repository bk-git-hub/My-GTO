import { describe, expect, it } from "vitest";
import { parseCards, SUITS } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import { bestResponseValue, exploitability } from "./bestResponse";
import { Engine } from "./cfr";
import { buildTree } from "./index";
import { comboOf, comboPerm, composePerms, IDENTITY, PERM_INV, permCard, SUIT_PERMS, symmetryGroup } from "./iso";
import { SolverSolution } from "./solution";
import { comboIndex, rangeWeights } from "./testHelpers";
import { estimateMemory, NODE_ACTION, NODE_CHANCE } from "./tree";
import type { PathStep, SolverInput, StreetSizes } from "./types";

// Suit isomorphism (docs/solver.md "Suit isomorphism"). The oracle cross-check covers it on random
// symmetric spots; these tests compare the solver with isomorphism on and off on the same spot.

const sizes = (bet: number[], raise: number[]): [StreetSizes, StreetSizes] => [{ bet, raise }, { bet, raise }];
const none = sizes([], []);
const suit = (p: number) => Array.from(SUIT_PERMS[p]).map((s) => SUITS[s]).join("");
/** The group as images of the suits s, h, d, c ("shdc" = identity), sorted. */
const show = (g: readonly number[]) => g.map(suit).sort();

const OOP = "99, 55, AK, KQs, QJs, JTs, T8s, 76s, A4s";
const IP = "KK, AA, KJs, KTs, QTs, 87s, 66, 44, A2s";
// A turn whose four cards share a suit: the other three suits can be permuted in all 6 ways.
const monoTurn: SolverInput = {
  board: parseCards("Ks9s5s3s"),
  ranges: [rangeWeights(OOP), rangeWeights(IP)],
  pot: 10,
  stack: 60,
  sizes: { turn: sizes([0.5], [1]), river: sizes([0.5], [1]) },
  raiseLimit: 1,
};
// Two free suits (c, h): one swap.
const twoToneTurn: SolverInput = { ...monoTurn, board: parseCards("Ks9s5d3d") };
// A monotone flop, check or all-in on every street: 6 permutations at the root, fewer once cards come.
const monoFlop: SolverInput = {
  board: parseCards("Ks7s2s"),
  ranges: [rangeWeights("88, 76s, 65s, A5s, KQo, T9s"), rangeWeights("AA, KQs, AKo, QJs, 98s")],
  pot: 6,
  stack: 6,
  sizes: { flop: none, turn: none, river: none },
};

describe("symmetry detection", () => {
  const chartRanges: SolverInput["ranges"] = [rangeWeights("22+, A2s+, K9s+, 76s, A2o+, KTo+"), rangeWeights("33+, A5s+, KQs, QJo")];

  it("finds the suit permutations that map the board onto itself and leave both ranges unchanged", () => {
    const g = (board: string, ranges = chartRanges) => show(symmetryGroup(parseCards(board), ranges));
    expect(g("Ks7d2c")).toEqual(["shdc"]); // rainbow: the free suit (h) has nothing to swap with
    expect(g("Ks7s2d")).toEqual(["scdh", "shdc"]); // two-tone: h and c swap
    expect(g("Ks7s2s")).toEqual(["scdh", "schd", "sdch", "sdhc", "shcd", "shdc"]); // monotone: h, d, c in any order
    expect(g("KsKd2c")).toEqual(["dhsc", "shdc"]); // paired: s and d swap, which swaps the two kings
    expect(g("Ks9s5s3s")).toEqual(g("Ks7s2s")); // a monotone turn as well
    expect(g("Ks9h5c3d2s")).toEqual(["shdc"]);
  });

  it("compares the actual weights exactly, ignoring combos on the board", () => {
    const board = parseCards("Ks7s2s");
    const [r0, r1] = chartRanges.map((r) => Float64Array.from(r));
    expect(symmetryGroup(board, [r0, r1])).toHaveLength(6);
    // Weights on combos that touch the board don't count: the solve ignores them.
    const onBoard = Float64Array.from(r0);
    onBoard[comboIndex("KsKh")] = 0.37;
    expect(symmetryGroup(board, [onBoard, r1])).toHaveLength(6);
    // One weight off by one bit keeps only the permutations that map its combo onto itself (AhAd: swap h, d).
    const ulp = Float64Array.from(r0);
    ulp[comboIndex("AhAd")] = 1 - 2 ** -53;
    expect(show(symmetryGroup(board, [ulp, r1]))).toEqual(["sdhc", "shdc"]);
    // Ranges symmetric under one swap only (AdKc and AdKh lighter: h and c still swap): just that swap.
    const partial = Float64Array.from(r0);
    for (const c of ["AdKc", "AdKh"]) partial[comboIndex(c)] = 0.5;
    expect(show(symmetryGroup(board, [partial, r1]))).toEqual(["scdh", "shdc"]);
    // Asymmetric ranges: the identity alone.
    const lopsided = Float64Array.from(r0);
    lopsided[comboIndex("QhJh")] = 0.5;
    lopsided[comboIndex("QdJd")] = 0.25;
    expect(symmetryGroup(board, [r1, lopsided])).toEqual([IDENTITY]);
  });
});

/**
 * Every action node of the full tree (isomorphism off) with its node in the reduced tree and the suit
 * permutation `frame` that maps the full node's cards onto the reduced node's (as Solution.node walks).
 */
function* pairs(full: Engine, iso: Engine): Generator<[number, number, number]> {
  const ft = full.tree, it = iso.tree;
  const stack: [number, number, number][] = [[0, 0, IDENTITY]];
  while (stack.length > 0) {
    const [f, i, frame] = stack.pop()!;
    const type = ft.type(f);
    if (type === NODE_ACTION) {
      yield [f, i, frame];
      for (let a = 0; a < ft.numChildren(f); a++) stack.push([ft.child[f] + a, it.child[i] + a, frame]);
    } else if (type === NODE_CHANCE) {
      const cards = ft.cards[ft.board[f]]!, b = it.board[i];
      for (let k = 0; k < cards.length; k++) {
        const c = permCard(frame, cards[k]);
        let j = it.cards[b]!.indexOf(c), next = frame;
        if (j < 0) {
          const m = it.members[b]!, x = m.card.indexOf(c);
          for (j = 0; m.start[j + 1] <= x; ) j++;
          next = composePerms(PERM_INV[m.perm[x]], frame);
        }
        stack.push([ft.child[f] + k, it.child[i] + j, next]);
      }
    }
  }
}

/** Player p's hand h of the full engine as a hand index of the reduced engine's frame. */
const handIn = (e: Engine, p: number, frame: number) => {
  const hl = e.hands[p];
  return Int32Array.from({ length: hl.n }, (_, h) => hl.indexOfCombo[comboOf(permCard(frame, hl.c1[h]), permCard(frame, hl.c2[h]))]);
};

/**
 * The reduced engine's average strategy written into the full engine: every full node gets the strategy sums
 * of its reduced node, each hand those of its canonical hand (as the reduced engine reads them).
 */
function copyStrategy(iso: Engine, full: Engine): void {
  for (const [f, i, frame] of pairs(full, iso)) {
    const p = full.player(f), n = full.hands[p].n, A = full.numActions(f);
    const at = handIn(full, p, frame);
    const canon = Int32Array.from({ length: n }, (_, h) => h);
    const c = iso.canon[p][iso.tree.board[i]];
    if (c) for (let j = 0; j < c.dst.length; j++) canon[c.dst[j]] = c.src[j];
    for (let a = 0; a < A; a++)
      for (let h = 0; h < n; h++) full.stratSum[full.off[f] + a * n + h] = iso.stratSum[iso.off[i] + a * n + canon[at[h]]];
  }
}

describe("the solver's tree with suit isomorphism", () => {
  it("holds one subtree per orbit of cards; the counts of estimateMemory and buildTree stay the game's", () => {
    const iso = new Engine(monoTurn), full = new Engine(monoTurn, { isomorphism: false });
    expect(iso.group).toHaveLength(6);
    expect(full.group).toEqual([IDENTITY]);
    // Check-check deals the river: the 48 cards fall into 22 orbits (9 spades alone, 13 ranks × {h, d, c}).
    const cc = iso.tree.child[iso.tree.child[0]];
    expect(iso.tree.type(cc)).toBe(NODE_CHANCE);
    expect(iso.tree.numChildren(cc)).toBe(9 + 13);
    expect(full.tree.numChildren(full.tree.child[full.tree.child[0]])).toBe(48);
    expect(iso.tree.size).toBeLessThan(0.5 * full.tree.size);
    const est = estimateMemory(monoTurn), off = estimateMemory(monoTurn, { isomorphism: false });
    expect(est.actionNodes).toBe(off.actionNodes);
    expect(est.chanceNodes + est.terminalNodes).toBe(off.chanceNodes + off.terminalNodes);
    expect(full.tree.size).toBe(off.actionNodes + off.chanceNodes + off.terminalNodes);
    expect(est.bytes).toBeLessThan(0.6 * off.bytes);
    // buildTree doesn't read the ranges: it is the full game tree.
    expect(buildTree(monoTurn).children[0].children[0].cards).toHaveLength(48);
  });

  it("asymmetric ranges on the same board: no isomorphism, the same solve bit for bit", () => {
    const r0 = Float64Array.from(monoTurn.ranges[0]);
    r0[comboIndex("AhKd")] = 0.5; // AK no longer looks the same in every suit
    const input: SolverInput = { ...monoTurn, ranges: [r0, monoTurn.ranges[1]] };
    const a = new Engine(input), b = new Engine(input, { isomorphism: false });
    expect(a.group).toEqual([IDENTITY]);
    expect(a.tree.size).toBe(b.tree.size);
    a.iterate(8);
    b.iterate(8);
    expect(a.regret).toEqual(b.regret);
    expect(a.stratSum).toEqual(b.stratSum);
    expect(exploitability(a)).toBe(exploitability(b));
    expect(estimateMemory(input)).toEqual(estimateMemory(input, { isomorphism: false }));
  });
});

describe("suit isomorphism is exact", () => {
  for (const [name, input] of [["monotone turn", monoTurn], ["two-tone turn", twoToneTurn], ["monotone flop", monoFlop]] as const) {
    it(`${name}: one iteration gives every node of the full tree its regrets and strategy sums, permuted`, () => {
      const iso = new Engine(input), full = new Engine(input, { isomorphism: false });
      expect(iso.group.length).toBeGreaterThan(1);
      iso.iterate(1);
      full.iterate(1);
      let nodes = 0, worst = 0;
      for (const [f, i, frame] of pairs(full, iso)) {
        const p = full.player(f), n = full.hands[p].n, A = full.numActions(f);
        const at = handIn(full, p, frame);
        for (const [x, y] of [[full.regret, iso.regret], [full.stratSum, iso.stratSum]]) {
          let scale = 1e-30;
          for (let k = 0; k < A * n; k++) scale = Math.max(scale, Math.abs(x[full.off[f] + k]));
          for (let a = 0; a < A; a++)
            for (let h = 0; h < n; h++) worst = Math.max(worst, Math.abs(x[full.off[f] + a * n + h] - y[iso.off[i] + a * n + at[h]]) / scale);
        }
        nodes++;
      }
      expect(nodes).toBe(full.actionNodes.length);
      // Only the order of the chance sums differs: float64 rounding, before the Float32 storage.
      expect(worst).toBeLessThan(1e-12);
      expect(exploitability(iso)).toBeCloseTo(exploitability(full), 10);
    });

    it(`${name}: best responses and Solution nodes against the same strategy are the full tree's`, () => {
      const iso = new Engine(input), full = new Engine(input, { isomorphism: false });
      iso.iterate(25);
      copyStrategy(iso, full);
      for (const p of [0, 1] as const) expect(bestResponseValue(iso, p)).toBeCloseTo(bestResponseValue(full, p), 11);
      // Paths through every kind of card: representatives and the cards mapped onto them.
      const a = new SolverSolution(iso, () => NaN), b = new SolverSolution(full, () => NaN);
      let compared = 0;
      const visit = (path: PathStep[], depth: number) => {
        const x = a.node(path), y = b.node(path);
        expect(x.board).toEqual(y.board);
        expect(x.cards).toEqual(y.cards);
        for (const [u, v] of [...x.ranges.map((r, p) => [r, y.ranges[p]]), ...x.ev.map((r, p) => [r, y.ev[p]]), ...(x.strategy ?? []).map((r, k) => [r, y.strategy![k]])]) {
          for (let c = 0; c < COMBOS.length; c++) {
            const same = Number.isNaN(u[c]) || Number.isNaN(v[c]) ? Number.isNaN(u[c]) && Number.isNaN(v[c]) : Math.abs(u[c] - v[c]) <= 1e-6 * Math.max(1, Math.abs(v[c]));
            if (!same) expect.fail(`${JSON.stringify(path)} combo ${c}: ${u[c]} vs ${v[c]}`);
          }
          compared++;
        }
        if (depth === 0 || y.kind === "terminal") return;
        if (y.kind === "chance") for (const c of y.cards!.filter((_, k) => k % 4 === 1)) visit([...path, { card: c }], depth - 1);
        else for (let k = 0; k < y.actions!.length; k++) visit([...path, { action: k }], depth - 1);
      };
      visit([], input.board.length === 3 ? 4 : 5);
      expect(compared).toBeGreaterThan(50);
    });
  }

  it("the solves with and without isomorphism bracket the same game value", () => {
    // Solved apart, the two runs drift (near-zero regrets round differently, as with pruning in cfr.test),
    // so compare at the game level: each run's [P0 - BR1, BR0] contains the equilibrium value.
    const input: SolverInput = {
      ...twoToneTurn,
      ranges: [rangeWeights("AA, KK, 99, 76s, A5s, QJs"), rangeWeights("QQ, JTs, AK, KQs, 88")],
      sizes: { turn: sizes([0.5], []), river: sizes([0.75], []) },
      raiseLimit: 0,
    };
    const runs = [new Engine(input), new Engine(input, { isomorphism: false })].map((e) => {
      for (let k = 0; k < 40 && exploitability(e) > 0.02; k++) e.iterate(25);
      expect(exploitability(e)).toBeLessThanOrEqual(0.02);
      return [input.pot - bestResponseValue(e, 1), bestResponseValue(e, 0)];
    });
    expect(Math.max(runs[0][0], runs[1][0])).toBeLessThanOrEqual(Math.min(runs[0][1], runs[1][1]) + 1e-9);
  });
});

describe("Solution.node with suit isomorphism", () => {
  it("answers for every card: a card off the representatives reads the representative's node, suits permuted", () => {
    const e = new Engine(monoTurn);
    e.iterate(20);
    const sol = new SolverSolution(e, () => NaN);
    const chance = sol.node([{ action: 0 }, { action: 0 }]);
    expect(chance.cards).toHaveLength(48);
    const nodes = new Map(chance.cards!.map((c) => [c, sol.node([{ action: 0 }, { action: 0 }, { card: c }, { action: 1 }])]));
    for (const [c, n] of nodes) expect(n.board).toEqual([...monoTurn.board, c]);
    // The river 2h, 2d and 2c are one orbit: each node is the others' with the suits swapped, exactly.
    const [h2, d2, c2] = parseCards("2h2d2c");
    for (const [x, y] of [[h2, d2], [h2, c2], [d2, c2]]) {
      // A permutation that fixes spades and maps x to y (any of them: the node on y's board is symmetric under the rest).
      const g = SUIT_PERMS.findIndex((p, k) => p[0] === 0 && permCard(k, x) === y);
      const m = comboPerm(g);
      const nx = nodes.get(x)!, ny = nodes.get(y)!;
      for (const [u, v] of [...nx.ranges.map((r, p) => [r, ny.ranges[p]]), ...nx.ev.map((r, p) => [r, ny.ev[p]]), ...nx.strategy!.map((r, k) => [r, ny.strategy![k]])])
        for (let i = 0; i < COMBOS.length; i++) if (!Object.is(u[i], v[m[i]])) expect.fail(`combo ${i}: ${u[i]} vs ${v[m[i]]}`);
    }
    // Something real to compare: a flush draw that got there differs from one that didn't.
    expect(nodes.get(h2)!.ev[0][comboIndex("AhKh")]).not.toBe(nodes.get(h2)!.ev[0][comboIndex("AdKd")]);
  });
});
