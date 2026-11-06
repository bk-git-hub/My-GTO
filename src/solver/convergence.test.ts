import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { createSolver } from "./index";
import { liveCombos, now, rangeWeights } from "./testHelpers";
import type { SolverInput } from "./types";

/** Iterate in chunks, recording exploitability, until `target` or `maxIter`. */
function run(input: SolverInput, target: number, every: number, maxIter: number) {
  const s = createSolver(input);
  const trace: number[] = [];
  const t0 = now();
  while (s.iteration < maxIter) {
    s.iterate(every);
    trace.push(s.exploitability());
    if (trace[trace.length - 1] <= target) break;
  }
  const ms = now() - t0;
  if ((globalThis as any).process?.env?.SOLVER_VERBOSE) console.log(`${s.iteration} iterations, ${ms.toFixed(0)} ms:`, trace.map((x) => x.toFixed(3)).join(" "));
  return { trace, iterations: s.iteration, ms };
}

/** Falls "monotonically-ish": never jumps up by more than 50% between checks, and ends far below the start. */
function expectFalling(trace: number[]) {
  for (let i = 1; i < trace.length; i++) expect(trace[i]).toBeLessThan(trace[i - 1] * 1.5 + 0.05);
  expect(trace[trace.length - 1]).toBeLessThan(trace[0] / 4);
}

const river: SolverInput = {
  board: parseCards("Ks9h5c3d2s"),
  ranges: [
    rangeWeights("22+, A2s+, K9s+, QTs+, JTs, T9s, 98s, ATo+, KTo+, QJo"),
    rangeWeights("22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 98s, 87s, 76s, A9o+, KTo+, QTo+, JTo"),
  ],
  pot: 10,
  stack: 50,
};
const turn: SolverInput = {
  board: parseCards("Qh8d4c2s"),
  ranges: [rangeWeights("QQ, 88, 44, AQ, KQs, JTs, T9s, 97s, 76s, A5s"), rangeWeights("AA, KK, JJ, AQs, KQ, QJs, J9s, 65s, A3s")],
  pot: 10,
  stack: 40,
};

// Each solve here takes a few seconds; under parallel test workers that can pass vitest's default 5 s timeout,
// so the tests carry their own. The ms assertions inside are the actual speed check.
describe("convergence", () => {
  it("realistic river spot reaches 0.5% of the pot", () => {
    const input = river;
    const n0 = liveCombos(input.ranges[0], input.board), n1 = liveCombos(input.ranges[1], input.board);
    expect(n0).toBeGreaterThanOrEqual(150);
    expect(n1).toBeGreaterThanOrEqual(150);
    expect(Math.max(n0, n1)).toBeLessThanOrEqual(300);
    const r = run(input, 0.5, 20, 2000);
    expectFalling(r.trace);
    expect(r.trace[r.trace.length - 1]).toBeLessThanOrEqual(0.5);
    expect(r.ms).toBeLessThan(5000);
  }, 60_000);

  it("small turn spot reaches 1% of the pot", () => {
    const r = run(turn, 1, 10, 500);
    expectFalling(r.trace);
    expect(r.trace[r.trace.length - 1]).toBeLessThanOrEqual(1);
    expect(r.ms).toBeLessThan(15000);
  }, 60_000);
});

// Compressed storage (docs/solver.md "Compressed storage") reaches the same targets on the same spots, in about
// as many iterations as Float32 storage (and goes on converging: 0.2% on the river).
describe("convergence with compressed storage", () => {
  /** Iterations to reach `target` with Float32 storage and with compressed storage. */
  function both(input: SolverInput, target: number, every: number, maxIter: number) {
    const plain = run(input, target, every, maxIter);
    const packed = run({ ...input, compress: true }, target, every, maxIter);
    expectFalling(packed.trace);
    expect(packed.trace[packed.trace.length - 1]).toBeLessThanOrEqual(target);
    expect(packed.iterations).toBeLessThanOrEqual(plain.iterations + every);
    return packed;
  }

  it("realistic river spot reaches 0.5% of the pot, and 0.2%", () => {
    expect(both(river, 0.5, 20, 2000).ms).toBeLessThan(5000);
    expect(both(river, 0.2, 20, 2000).ms).toBeLessThan(10000);
  }, 60_000);

  it("small turn spot reaches 1% of the pot", () => {
    expect(both(turn, 1, 10, 500).ms).toBeLessThan(15000);
  }, 60_000);
});
