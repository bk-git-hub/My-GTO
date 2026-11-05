import { exploitability } from "./bestResponse";
import { Engine } from "./cfr";
import { SolverSolution } from "./solution";
import type { IncrementalSolver, Solution, SolveOptions, SolverInput } from "./types";

export * from "./types";
export { buildTree, estimateMemory } from "./tree";

class Solver implements IncrementalSolver {
  private readonly e: Engine;
  private explAt = -1;
  private expl = NaN;

  constructor(input: SolverInput) {
    this.e = new Engine(input);
  }

  iterate(n: number): void {
    if (!(n >= 0)) throw new Error("iterate(n) needs n >= 0");
    this.e.iterate(Math.floor(n));
  }

  get iteration(): number {
    return this.e.t;
  }

  exploitability(): number {
    if (this.explAt !== this.e.t) {
      this.expl = exploitability(this.e);
      this.explAt = this.e.t;
    }
    return this.expl;
  }

  solution(): Solution {
    return new SolverSolution(this.e, () => this.exploitability());
  }
}

/** Incremental solver: iterate in small chunks (e.g. from a Web Worker), query in between. */
export function createSolver(input: SolverInput): IncrementalSolver {
  return new Solver(input);
}

/**
 * Solve a spot, blocking. Stops at `iterations`, once exploitability (checked every `checkEvery`
 * iterations and at the end) is at or below `targetExploitability`, or when onProgress returns false.
 */
export function solve(input: SolverInput, opts: SolveOptions = {}): Solution {
  const iterations = opts.iterations ?? 1000;
  const target = opts.targetExploitability ?? 0.5;
  const checkEvery = Math.max(1, Math.floor(opts.checkEvery ?? 25));
  const s = new Solver(input);
  while (s.iteration < iterations) {
    s.iterate(Math.min(checkEvery, iterations - s.iteration));
    const expl = s.exploitability();
    const keepGoing = opts.onProgress?.({ iteration: s.iteration, exploitability: expl });
    if (expl <= target || keepGoing === false) break;
  }
  s.exploitability();
  return s.solution();
}
