import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import { Engine } from "./cfr";
import { createSolver, estimateMemory, solve } from "./index";
import { comboIndex, rangeWeights, rng } from "./testHelpers";
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

  it("rejects ranges in which no pair of hands can be dealt together, however the weights add up", () => {
    // OOP holds one combo, IP only combos sharing a card with it, at random weights. The sum over compatible
    // pairs was inclusion–exclusion, which left rounding noise (about ±1e-14) instead of 0 and let about half
    // of these through; exploitability then came out around -77%.
    const r = rng(11);
    const live = COMBOS.flatMap((_, i) => (touches(i, input.board) ? [] : [i]));
    for (let t = 0; t < 40; t++) {
      const h = live[Math.floor(r() * live.length)];
      const [a, b] = COMBOS[h].cards;
      const r0 = new Float64Array(1326);
      r0[h] = 0.1 + 0.9 * r();
      const r1 = new Float64Array(1326);
      // 0.05 + 0.9 × r() has a full mantissa like real weights (0.33, 0.7); r() alone has 32 bits, and sums of
      // those are exact, so they hide the noise.
      for (const i of live) if (COMBOS[i].cards.includes(a) || COMBOS[i].cards.includes(b)) r1[i] = 0.05 + 0.9 * r();
      expect(() => createSolver({ ...input, ranges: [r0, r1] }), `trial ${t}`).toThrow(/no compatible combos/);
      // estimateMemory only sizes the tree; it accepts ranges that give no game (docs/solver.md "API").
      expect(estimateMemory({ ...input, ranges: [r0, r1] }).actionNodes).toBeGreaterThan(0);
      // One compatible IP combo, however light, is a game.
      const other = live.find((i) => !COMBOS[i].cards.includes(a) && !COMBOS[i].cards.includes(b))!;
      r1[other] = 1e-6;
      expect(() => createSolver({ ...input, ranges: [r0, r1] }), `trial ${t} with a compatible combo`).not.toThrow();
    }
  });
});

describe("exploitability is never below 0", () => {
  const base: SolverInput = {
    board: parseCards("Ks9h5c3d2s"),
    ranges: [rangeWeights("AA,KK,99,AK,AQ,QJs,T8s"), rangeWeights("QQ,JJ,AK,AJ,KQ,JTs,76s")],
    pot: 10,
    stack: 50,
  };

  it("is exactly 0 on spots with nothing to decide (float noise gave -9e-15 on the flop, -4e-14 on the turn)", () => {
    for (const board of ["Ks9h5c", "Ks9h5c3d", "Ks9h5c3d2s"]) {
      const s = createSolver({ ...base, board: parseCards(board), stack: 0 });
      s.iterate(1);
      // toBe compares with Object.is, so -0 fails too ("-0.00%" in a UI).
      expect(s.exploitability(), board).toBe(0);
      expect(s.solution().exploitability, board).toBe(0);
    }
    expect(solve({ ...base, board: parseCards("Ks9h5c3d"), stack: 0 }, { iterations: 3 }).exploitability).toBe(0);
  });

  it("is still positive away from equilibrium", () => {
    const s = createSolver(base);
    s.iterate(1);
    expect(s.exploitability()).toBeGreaterThan(1);
  });
});

describe("solve and iterate: iteration counts are checked and rounded down", () => {
  const input: SolverInput = { ...turnInput, board: parseCards("Ks9h5c3d2s") };
  /** onProgress that fails the test instead of letting a solve that makes no progress spin forever. */
  const guard = (max: number) => {
    let calls = 0;
    return () => {
      if (++calls > max) throw new Error("solve made no progress");
    };
  };

  it("a fractional iteration cap terminates (iterate(0.5) used to spin forever)", () => {
    expect(solve(input, { iterations: 0.5, targetExploitability: -1, onProgress: guard(5) }).iterations).toBe(0);
    expect(solve(input, { iterations: 2.7, targetExploitability: -1, checkEvery: 1, onProgress: guard(5) }).iterations).toBe(2);
    const seen: number[] = [];
    const sol = solve(input, { iterations: 7, targetExploitability: -1, checkEvery: 2.5, onProgress: (p) => void seen.push(p.iteration) });
    expect(seen).toEqual([2, 4, 6, 7]);
    expect(sol.iterations).toBe(7);
    // checkEvery below 1 rounds up to every iteration.
    expect(solve(input, { iterations: 3, targetExploitability: -1, checkEvery: 0.5, onProgress: guard(3) }).iterations).toBe(3);
  });

  /**
   * Runs f with the engine refusing a non-finite iteration count, so a missing check fails the test
   * with that message instead of looping forever.
   */
  const noEndlessEngine = (f: () => void) => {
    const orig = Engine.prototype.iterate;
    Engine.prototype.iterate = function (this: Engine, n: number) {
      if (!Number.isFinite(n)) throw new Error("the engine was asked for endless iterations");
      orig.call(this, n);
    };
    try {
      f();
    } finally {
      Engine.prototype.iterate = orig;
    }
  };

  it("Infinity runs until the target or onProgress stops it", () => {
    let calls = 0;
    const sol = solve(input, { iterations: Infinity, targetExploitability: -1, checkEvery: 4, onProgress: () => ++calls < 2 });
    expect(sol.iterations).toBe(8);
    noEndlessEngine(() => expect(() => solve(input, { iterations: Infinity, checkEvery: Infinity })).toThrow(/checkEvery must be finite/));
  });

  it("rejects counts that aren't numbers >= 0 (> 0 for checkEvery)", () => {
    for (const iterations of [NaN, -1, "10" as unknown as number]) expect(() => solve(input, { iterations })).toThrow(/iterations/);
    for (const checkEvery of [0, -1, NaN]) expect(() => solve(input, { checkEvery })).toThrow(/checkEvery/);
    expect(() => solve(input, { targetExploitability: NaN })).toThrow(/targetExploitability/);
    const s = createSolver(input);
    noEndlessEngine(() => {
      for (const n of [NaN, -1, Infinity]) expect(() => s.iterate(n)).toThrow(/iterate\(n\)/);
    });
    s.iterate(1.9);
    expect(s.iteration).toBe(1);
  });
});

describe("range weights are checked", () => {
  const input: SolverInput = { ...turnInput, board: parseCards("Ks9h5c3d2s") };
  const withWeight = (p: 0 | 1, i: number, w: number): SolverInput => {
    const r = Float64Array.from(input.ranges[p]);
    r[i] = w;
    return { ...input, ranges: p === 0 ? [r, input.ranges[1]] : [input.ranges[0], r] };
  };

  it("NaN, negative and > 1 weights throw, also on combos the board blocks", () => {
    const aa = comboIndex("AsAh"), onBoard = comboIndex("KsKh");
    for (const w of [NaN, -0.1, 1.5, 100, Infinity]) {
      for (const p of [0, 1] as const) {
        expect(() => createSolver(withWeight(p, aa, w)), `${p} ${w}`).toThrow(new RegExp(`ranges\\[${p}\\]\\[${aa}\\]`));
        expect(() => estimateMemory(withWeight(p, aa, w))).toThrow(/ranges/);
      }
      expect(() => solve(withWeight(0, onBoard, w), { iterations: 1 })).toThrow(/ranges\[0\]/);
    }
    expect(() => createSolver({ ...input, ranges: [[...Array.from(input.ranges[0]), 0], input.ranges[1]] })).toThrow(/at most 1326/);
    expect(() => createSolver({ ...input, ranges: [input.ranges[0], ["1" as unknown as number]] })).toThrow(/ranges\[1\]\[0\]/);
    expect(() => createSolver({ ...input, ranges: [input.ranges[0]] as never })).toThrow(/ranges/);
  });

  it("0 and 1 are fine, and a short array means 0 for the rest", () => {
    expect(() => createSolver(withWeight(0, comboIndex("AsAh"), 1))).not.toThrow();
    expect(() => createSolver(withWeight(0, comboIndex("AsAh"), 0))).not.toThrow();
    const short = Array.from(input.ranges[1]).slice(0, 1000);
    const a = estimateMemory({ ...input, ranges: [input.ranges[0], short] });
    const zeros = Float64Array.from(input.ranges[1]).fill(0, 1000);
    expect(a).toEqual(estimateMemory({ ...input, ranges: [input.ranges[0], zeros] }));
  });
});

describe("Solution.node: step checks, frozen results", () => {
  const solver = createSolver(turnInput);
  solver.iterate(10);
  const sol = solver.solution();

  it("checks a step's shape before the cache, so {action: '1'} can't hit the entry of {action: 1}", () => {
    const one = sol.node([{ action: 1 }]);
    expect(sol.node([{ action: 1 }])).toBe(one);
    const bad: unknown[][] = [
      [{ action: "1" }],
      [{ action: 1, card: 5 }],
      [{}],
      [null],
      [1],
      [{ action: 1 }, { action: "0" }],
      [{ action: 0 }, { action: 0 }, { card: String(parseCards("2s")[0]) }],
    ];
    for (const path of bad) expect(() => sol.node(path as PathStep[]), JSON.stringify(path)).toThrow(/illegal path/);
    expect(() => sol.node("a1" as never)).toThrow(/illegal path/);
    // {card} at an action node and {action} at a chance node stay illegal after the legal forms were cached.
    sol.node([{ action: 0 }, { action: 0 }, { card: parseCards("2s")[0] }]);
    expect(() => sol.node([{ action: 0 }, { action: 0 }, { action: parseCards("2s")[0] }])).toThrow(/illegal path/);
  });

  it("every card that can come is a legal step, not only one per suit pattern", () => {
    const chance = sol.node([{ action: 0 }, { action: 0 }]);
    for (const c of chance.cards!) {
      const river = sol.node([{ action: 0 }, { action: 0 }, { card: c }]);
      expect(river.board).toEqual([...TURN, c]);
    }
  });

  it("a node whose buffers were transferred away (postMessage) is built afresh, not handed back empty", () => {
    // Its own solver, so the cache entries the other tests look at stay as they are.
    const solver = createSolver(turnInput);
    solver.iterate(10);
    const sol = solver.solution();
    const arrays = (n: SolutionNode) => [...(n.strategy ?? []), ...n.ranges, ...n.ev];
    const buffers = (xs: Float32Array[]) => xs.map((a) => a.buffer as ArrayBuffer);
    // An action node and a chance node (no strategy).
    for (const path of [[{ action: 1 }], [{ action: 0 }, { action: 0 }]] as PathStep[][]) {
      const n = sol.node(path);
      const before = arrays(n).map((a) => a.slice());
      // What a Web Worker does to post a node without copying it: every typed array's buffer in the
      // transfer list (structuredClone detaches them the same way postMessage does).
      const posted = structuredClone(n, { transfer: buffers(arrays(n)) });
      expect(arrays(posted)).toEqual(before);
      expect(n.ranges[0].length).toBe(0); // the transfer emptied the cached arrays in place
      const again = sol.node(path);
      // (Not .not.toBe: on a mismatch vitest deep-compares, which can't read the detached arrays.)
      expect(again === n).toBe(false);
      expect(arrays(again)).toEqual(before);
      expect(Object.isFrozen(again)).toBe(true);
      expect(sol.node(path)).toBe(again); // cached again
      // One transferred buffer is enough.
      structuredClone(again.ev[1], { transfer: buffers([again.ev[1]]) });
      const third = sol.node(path);
      expect(third === again).toBe(false);
      expect(arrays(third)).toEqual(before);
    }
  });

  it("the cached node and its plain arrays are frozen", () => {
    const root = sol.node([]);
    expect(sol.node([])).toBe(root);
    for (const x of [root, root.board, root.bets, root.stacks, root.actions, root.strategy, root.ranges, root.ev])
      expect(Object.isFrozen(x)).toBe(true);
    expect(root.actions!.every((a) => Object.isFrozen(a))).toBe(true);
    expect(() => {
      root.actions![0].to = 5;
    }).toThrow(TypeError);
    expect(() => {
      (root as { pot: number }).pot = 1;
    }).toThrow(TypeError);
    expect(() => root.board.push(0)).toThrow(TypeError);
    const chance = sol.node([{ action: 0 }, { action: 0 }]);
    expect(Object.isFrozen(chance.cards)).toBe(true);
    expect(sol.node([]).actions![0].to).toBe(0);
  });
});
