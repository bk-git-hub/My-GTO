import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { createSolver, estimateMemory } from "./index";
import { liveCombos, now, rangeWeights } from "./testHelpers";
import type { SolverInput } from "./types";

/**
 * Performance benchmark (docs/solver.md, Performance). Skipped unless SOLVER_BENCH is set:
 *   SOLVER_BENCH=1 npx vitest run src/solver/bench.test.ts --disable-console-intercept
 */
const enabled = !!(globalThis as any).process?.env?.SOLVER_BENCH;

// About 500 combos each on these boards.
const OOP = "22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o";
const IP = "22+, A2s+, K2s+, Q2s+, J5s+, T6s+, 96s+, 85s+, 74s+, 64s+, 53s+, A2o+, K8o+, Q9o+, J9o+, T9o";

function bench(name: string, input: SolverInput, target: number, every: number, maxIter: number) {
  const mem = estimateMemory(input);
  const t0 = now();
  const s = createSolver(input);
  const build = now() - t0;
  let expl = Infinity, explMs = 0;
  while (s.iteration < maxIter && expl > target) {
    s.iterate(every);
    const t = now();
    expl = s.exploitability();
    explMs += now() - t;
  }
  const total = now() - t0;
  console.log(
    `[bench] ${name}: combos ${liveCombos(input.ranges[0], input.board)}/${liveCombos(input.ranges[1], input.board)}, ` +
      `${s.iteration} iterations to ${expl.toFixed(3)}% in ${(total / 1000).toFixed(2)} s ` +
      `(build ${build.toFixed(0)} ms, exploitability checks ${explMs.toFixed(0)} ms, ${((total - build - explMs) / s.iteration).toFixed(1)} ms/iteration); ` +
      `estimateMemory ${(mem.bytes / 1e6).toFixed(1)} MB, ${mem.actionNodes} action / ${mem.chanceNodes} chance / ${mem.terminalNodes} terminal nodes`,
  );
  return { expl, total };
}

describe.skipIf(!enabled)("solver benchmark", () => {
  it("river, ~500 combos each, default sizes, pot 10 stack 50: 0.5% of pot", () => {
    const r = bench("river", { board: parseCards("Ks9h5c3d2s"), ranges: [rangeWeights(OOP), rangeWeights(IP)], pot: 10, stack: 50 }, 0.5, 10, 3000);
    expect(r.expl).toBeLessThanOrEqual(0.5);
  }, 120_000);

  const turn: SolverInput = { board: parseCards("Ks9h5c3d"), ranges: [rangeWeights(OOP), rangeWeights(IP)], pot: 20, stack: 80 };

  it("turn, ~500 combos each, default sizes, pot 20 stack 80: 1% of pot", () => {
    const r = bench("turn", turn, 1, 10, 1000);
    expect(r.expl).toBeLessThanOrEqual(1);
    expect(estimateMemory(turn).bytes).toBeLessThan(300e6);
  }, 600_000);

  it("the same turn with compressed storage: 1% of pot in about half the memory", () => {
    const input: SolverInput = { ...turn, compress: true };
    const r = bench("turn, compressed", input, 1, 10, 1000);
    expect(r.expl).toBeLessThanOrEqual(1);
    expect(estimateMemory(input).bytes).toBeLessThan(0.55 * estimateMemory(turn).bytes);
  }, 600_000);
});
