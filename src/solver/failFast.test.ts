import { describe, expect, it, vi } from "vitest";
import { parseCards } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import { createSolver, estimateMemory } from "./index";
import { comboIndex, rangeWeights } from "./testHelpers";
import { buildGameTree } from "./tree";
import type { SolverInput } from "./types";

// buildGameTree wrapped in a spy that behaves the same, to see whether createSolver got as far as
// building the tree. (A module mock applies to the whole file, which is why this test has its own.)
vi.mock("./tree", async (importOriginal) => {
  const m = await importOriginal<typeof import("./tree")>();
  return { ...m, buildGameTree: vi.fn(m.buildGameTree) };
});

describe("createSolver rejects ranges that give no game before it builds the tree", () => {
  const board = parseCards("AsKh7d");
  const ip = rangeWeights("22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o");
  const one = (combo: string, w = 1) => {
    const r = new Float64Array(1326);
    r[comboIndex(combo)] = w;
    return r;
  };
  const input: SolverInput = { board, ranges: [rangeWeights("QQ+"), ip], pot: 6, stack: 20 };

  it("nothing off the board, no compatible pair, or bad weights: it throws without building anything", () => {
    const spy = vi.mocked(buildGameTree);
    const onBoard = Float64Array.from(COMBOS, (c) => (c.cards.some((x) => board.includes(x)) ? 1 : 0));
    // Every IP combo shares a card with OOP's QhQd.
    const blocked = Float64Array.from(COMBOS, (c) => (c.cards.some((x) => parseCards("QhQd").includes(x)) ? 0.5 : 0));
    const cases: [SolverInput["ranges"], RegExp][] = [
      [[onBoard, ip], /off the board/],
      [[ip, []], /off the board/],
      [[one("QhQd"), blocked], /no compatible combos/],
      [[[NaN], ip], /ranges\[0\]/],
    ];
    for (const [ranges, re] of cases) {
      // estimateMemory sizes the spot (it accepts ranges that give no game; docs/solver.md "API") ...
      if (!Number.isNaN(ranges[0][0])) expect(estimateMemory({ ...input, ranges }).actionNodes).toBeGreaterThan(1000);
      spy.mockClear();
      // ... and createSolver turns it down before paying for the tree.
      expect(() => createSolver({ ...input, ranges }), String(re)).toThrow(re);
      expect(spy, String(re)).not.toHaveBeenCalled();
    }
    // Control: a playable spot does build its tree (once).
    spy.mockClear();
    createSolver({ ...input, board: parseCards("AsKh7d2c9s"), stack: 10 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
