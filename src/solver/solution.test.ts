import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import { createSolver, solve } from "./index";
import { comboIndex, rangeWeights } from "./testHelpers";
import type { PathStep, SolutionNode, SolverInput, StreetSizes } from "./types";

const TURN = parseCards("Ks9h5c3d");
const small: [StreetSizes, StreetSizes] = [{ bet: [0.5], raise: [1] }, { bet: [0.5], raise: [1] }];
const turnInput: SolverInput = {
  board: TURN,
  ranges: [rangeWeights("99, 55, AK, KQs, QJs, JTs, T8s, 76s, A4s"), rangeWeights("KK, AA, KJs, KTs, QTs, 87s, 66, 44, A2s")],
  pot: 10,
  stack: 60,
  sizes: { turn: small, river: small },
  raiseLimit: 1,
};

const touches = (i: number, board: number[]) => board.includes(COMBOS[i].cards[0]) || board.includes(COMBOS[i].cards[1]);

/** Initial weight that the solver uses: 0 when the combo touches the starting board. */
const initial = (p: 0 | 1, i: number) => (touches(i, TURN) ? 0 : turnInput.ranges[p][i]);

describe("Solution.node", () => {
  const solver = createSolver(turnInput);
  solver.iterate(60);
  const sol = solver.solution();

  it("walks action and chance steps", () => {
    const root = sol.node([]);
    expect(root.kind).toBe("action");
    expect(root.street).toBe("turn");
    expect(root.player).toBe(0);
    expect(root.actions!.map((a) => a.kind)).toEqual(["check", "bet", "allin"]);
    expect(root.strategy).toHaveLength(3);
    expect(root.ev[0]).toHaveLength(1326);

    const chance = sol.node([{ action: 0 }, { action: 0 }]);
    expect(chance.kind).toBe("chance");
    expect(chance.cards).toHaveLength(48);
    expect(chance.strategy).toBeUndefined();

    const river = sol.node([{ action: 0 }, { action: 0 }, { card: parseCards("2s")[0] }]);
    expect(river.kind).toBe("action");
    expect(river.street).toBe("river");
    expect(river.board).toEqual([...TURN, parseCards("2s")[0]]);
    expect(river.player).toBe(0);

    const fold = sol.node([{ action: 1 }, { action: 0 }]);
    expect(fold.kind).toBe("terminal");
    expect(fold.terminal).toBe("fold");

    // Cached: the same path gives the same object.
    expect(sol.node([{ action: 0 }, { action: 0 }])).toBe(chance);
  });

  it("throws on illegal paths", () => {
    const bad: PathStep[][] = [
      [{ action: 3 }],
      [{ action: -1 }],
      [{ action: 0.5 }],
      [{ card: 0 }],
      [{ action: 0 }, { action: 0 }, { action: 0 }],
      [{ action: 0 }, { action: 0 }, { card: TURN[0] }],
      [{ action: 1 }, { action: 0 }, { action: 0 }],
    ];
    for (const path of bad) expect(() => sol.node(path)).toThrow(/illegal path/);
  });

  it("ranges are the initial weight times each player's own action probabilities", () => {
    // OOP bets, IP raises, OOP calls -> chance -> 7c, then OOP checks.
    const c7 = parseCards("7c")[0];
    const path: PathStep[] = [{ action: 1 }, { action: 2 }, { action: 1 }, { card: c7 }, { action: 0 }];
    const expected = [new Float64Array(1326), new Float64Array(1326)];
    for (const p of [0, 1] as const) for (let i = 0; i < 1326; i++) expected[p][i] = initial(p, i);
    for (let k = 0; k < path.length; k++) {
      const node = sol.node(path.slice(0, k));
      const step = path[k];
      if ("action" in step) {
        const q = node.player!;
        for (let i = 0; i < 1326; i++) expected[q][i] *= node.strategy![step.action][i];
      } else {
        for (const p of [0, 1]) for (let i = 0; i < 1326; i++) if (touches(i, [step.card])) expected[p][i] = 0;
      }
    }
    const end = sol.node(path);
    expect(end.board).toContain(c7);
    for (const p of [0, 1]) for (let i = 0; i < 1326; i++) expect(end.ranges[p][i]).toBeCloseTo(expected[p][i], 6);
    // Something is actually left in both ranges.
    expect(end.ranges[0].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(end.ranges[1].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  /** Check strategy sums and blocked-card zeros at a node. */
  function checkStrategy(node: SolutionNode) {
    const q = node.player!;
    for (let i = 0; i < 1326; i++) {
      let sum = 0;
      for (const s of node.strategy!) {
        expect(s[i]).toBeGreaterThanOrEqual(0);
        sum += s[i];
      }
      const live = initial(q, i) > 0 && !touches(i, node.board);
      if (live) expect(sum).toBeCloseTo(1, 5);
      else expect(sum).toBe(0);
    }
  }

  it("strategies sum to 1 for in-range unblocked combos and are 0 elsewhere", () => {
    checkStrategy(sol.node([]));
    checkStrategy(sol.node([{ action: 1 }]));
    checkStrategy(sol.node([{ action: 0 }, { action: 0 }, { card: parseCards("Ah")[0] }]));
    checkStrategy(sol.node([{ action: 0 }, { action: 1 }, { action: 1 }, { card: parseCards("9d")[0] }, { action: 0 }]));
  });

  it("a dealt card blocks combos: zero range, zero strategy, NaN ev", () => {
    const ah = parseCards("Ah")[0];
    const node = sol.node([{ action: 0 }, { action: 0 }, { card: ah }]);
    const aKo = comboIndex("AhKd"); // in OOP's range (AK), blocked by the Ah
    const aKo2 = comboIndex("AcKd"); // in OOP's range, not blocked
    expect(initial(0, aKo)).toBe(1);
    expect(node.ranges[0][aKo]).toBe(0);
    expect(node.strategy!.every((s) => s[aKo] === 0)).toBe(true);
    expect(node.ev[0][aKo]).toBeNaN();
    expect(node.ranges[0][aKo2]).toBeGreaterThan(0);
    expect(Number.isFinite(node.ev[0][aKo2])).toBe(true);
    // IP's AA with the Ah is blocked too.
    expect(node.ev[1][comboIndex("AhAd")]).toBeNaN();
    expect(Number.isFinite(node.ev[1][comboIndex("AsAd")])).toBe(true);
  });

  it("ev is NaN outside the hand list and on the starting board, finite in range", () => {
    const root = sol.node([]);
    expect(root.ev[0][comboIndex("2h2d")]).toBeNaN(); // not in OOP's range
    expect(root.ev[0][comboIndex("9s9h")]).toBeNaN(); // touches the board (9h)
    expect(Number.isFinite(root.ev[0][comboIndex("9s9d")])).toBe(true);
    expect(root.ev[1][comboIndex("AsKd")]).toBeNaN(); // AK is OOP's, not IP's
    expect(Number.isFinite(root.ev[1][comboIndex("AsAd")])).toBe(true);
  });

  it("ev at the acting player's node is the strategy-weighted ev of the children", () => {
    for (const path of [[], [{ action: 1 }, { action: 2 }]] as PathStep[][]) {
      const node = sol.node(path);
      const p = node.player!;
      const kids = node.actions!.map((_, a) => sol.node([...path, { action: a }]));
      for (let i = 0; i < 1326; i++) {
        if (Number.isNaN(node.ev[p][i])) continue;
        let v = 0;
        kids.forEach((k, a) => (v += node.strategy![a][i] * k.ev[p][i]));
        expect(node.ev[p][i]).toBeCloseTo(v, 3);
      }
    }
  });

  it("a fold terminal's ev is the net", () => {
    // OOP bets 5 into 10, IP folds: OOP nets 10, IP nets 0.
    const fold = sol.node([{ action: 1 }, { action: 0 }]);
    const i = comboIndex("AcKd");
    expect(fold.ev[0][i]).toBeCloseTo(10, 5);
    expect(fold.ev[1][comboIndex("AsAd")]).toBeCloseTo(0, 5);
  });

  it("becomes stale after more iterations", () => {
    const s = createSolver(turnInput);
    s.iterate(2);
    const old = s.solution();
    old.node([]);
    expect(old.iterations).toBe(2);
    s.iterate(1);
    expect(() => old.node([])).toThrow(/stale/);
    expect(() => old.node([{ action: 0 }])).toThrow(/stale/);
    expect(() => old.exploitability).toThrow(/stale/);
    const fresh = s.solution();
    expect(fresh.iterations).toBe(3);
    expect(fresh.node([]).kind).toBe("action");
  });
});

describe("ev NaN when the opponent has no compatible reach", () => {
  it("blocked by a one-combo range", () => {
    const board = parseCards("2c3d7h8sKs");
    const r0 = new Float64Array(1326);
    r0[comboIndex("AhQd")] = 1; // shares the Ah with IP's only combo
    r0[comboIndex("QhJh")] = 1;
    const r1 = new Float64Array(1326);
    r1[comboIndex("AhAd")] = 1;
    const sol = solve({ board, ranges: [r0, r1], pot: 10, stack: 10 }, { iterations: 50 });
    const root = sol.node([]);
    expect(root.ev[0][comboIndex("AhQd")]).toBeNaN();
    expect(root.ev[0][comboIndex("QhJh")]).toBeCloseTo(0, 1); // loses to AA at showdown, can't win
    expect(root.ranges[0][comboIndex("AhQd")]).toBe(1); // still in range, just no opponent to face
    expect(root.ev[1][comboIndex("AhAd")]).toBeGreaterThan(9);
  });
});

describe("solve options", () => {
  const input: SolverInput = { ...turnInput, board: parseCards("Ks9h5c3d2s") };

  it("stops at the iteration cap", () => {
    const sol = solve(input, { iterations: 30, targetExploitability: 0, checkEvery: 7 });
    expect(sol.iterations).toBe(30);
    expect(sol.exploitability).toBeGreaterThan(0);
  });

  it("stops at the target, checking every checkEvery iterations", () => {
    const seen: number[] = [];
    const sol = solve(input, { iterations: 5000, targetExploitability: 1, checkEvery: 10, onProgress: (p) => void seen.push(p.iteration) });
    expect(sol.exploitability).toBeLessThanOrEqual(1);
    expect(sol.iterations % 10).toBe(0);
    expect(seen[seen.length - 1]).toBe(sol.iterations);
  });

  it("stops when onProgress returns false", () => {
    let calls = 0;
    const sol = solve(input, { iterations: 1000, targetExploitability: 0, checkEvery: 5, onProgress: () => ++calls < 3 });
    expect(calls).toBe(3);
    expect(sol.iterations).toBe(15);
  });

  it("rejects ranges with nothing to play", () => {
    expect(() => createSolver({ ...input, ranges: [new Float64Array(1326), input.ranges[1]] })).toThrow();
  });
});
