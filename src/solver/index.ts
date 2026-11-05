import { exploitability } from "./bestResponse";
import { Engine } from "./cfr";
import { SolverSolution } from "./solution";
import { estimateMemory as estimateSolver } from "./tree";
import type { IncrementalSolver, MemoryEstimate, Solution, SolveOptions, SolverInput } from "./types";

export * from "./types";
export { buildTree } from "./tree";

/**
 * Node counts and the bytes a solver for this spot will hold, without building it (docs/solver.md "API").
 * The counts are the game tree's; the bytes account for suit isomorphism when the spot is symmetric.
 */
export function estimateMemory(input: SolverInput): MemoryEstimate {
  return estimateSolver(input);
}

class Solver implements IncrementalSolver {
  private readonly e: Engine;
  private explAt = -1;
  private expl = NaN;

  constructor(input: SolverInput) {
    this.e = new Engine(input);
  }

  /** Runs floor(n) iterations; n must be a finite number >= 0. */
  iterate(n: number): void {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`iterate(n) needs a finite number n >= 0 (got ${String(n)})`);
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
 * The solve options checked and with defaults filled in (docs/solver.md "API"): `iterations` and
 * `checkEvery` are rounded down, so every pass of solve()'s loop runs at least one iteration.
 */
function solveOptions(opts: SolveOptions): { iterations: number; target: number; checkEvery: number } {
  if (opts === null || typeof opts !== "object") throw new Error("solve options must be an object");
  const num = (x: unknown): x is number => typeof x === "number" && !Number.isNaN(x);
  const iterations = opts.iterations ?? 1000;
  if (!num(iterations) || iterations < 0) throw new Error(`iterations must be a number >= 0 (got ${String(iterations)})`);
  const target = opts.targetExploitability ?? 0.5;
  if (!num(target)) throw new Error(`targetExploitability must be a number (got ${String(target)})`);
  const checkEvery = opts.checkEvery ?? 25;
  if (!num(checkEvery) || !(checkEvery > 0)) throw new Error(`checkEvery must be a number > 0 (got ${String(checkEvery)})`);
  if (iterations === Infinity && checkEvery === Infinity) throw new Error("checkEvery must be finite when iterations is Infinity");
  if (opts.onProgress !== undefined && typeof opts.onProgress !== "function") throw new Error("onProgress must be a function");
  return { iterations: Math.floor(iterations), target, checkEvery: Math.max(1, Math.floor(checkEvery)) };
}

/**
 * Solve a spot, blocking. Stops at `iterations`, once exploitability (checked every `checkEvery`
 * iterations and at the end) is at or below `targetExploitability`, or when onProgress returns false.
 */
export function solve(input: SolverInput, opts: SolveOptions = {}): Solution {
  const { iterations, target, checkEvery } = solveOptions(opts);
  const s = new Solver(input);
  while (s.iteration < iterations) {
    // Both are integers here, so the chunk is at least 1 and the loop always gets closer to the cap.
    s.iterate(Math.min(checkEvery, iterations - s.iteration));
    const expl = s.exploitability();
    const keepGoing = opts.onProgress?.({ iteration: s.iteration, exploitability: expl });
    if (expl <= target || keepGoing === false) break;
  }
  s.exploitability();
  return s.solution();
}
