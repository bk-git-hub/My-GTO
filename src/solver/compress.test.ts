import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { bestResponseValue, exploitability } from "./bestResponse";
import { Engine, MODE_CFR } from "./cfr";
import { buildTree, createSolver, estimateMemory, solve } from "./index";
import { rangeWeights } from "./testHelpers";
import type { SolverInput, StreetSizes } from "./types";

// Compressed storage (docs/solver.md "Compressed storage"): 16-bit regrets and strategy sums with per-node scales.
// The oracle cross-check runs compressed spots too (it checks the strategy the core stores, whatever its
// precision); convergence.test.ts checks that compressed solves still reach the targets.

const sizes = (bet: number[], raise: number[]): [StreetSizes, StreetSizes] => [{ bet, raise }, { bet, raise }];
const turn: SolverInput = {
  board: parseCards("Qh8d4c2s"),
  ranges: [rangeWeights("QQ, 88, 44, AQ, KQs, JTs, T9s, 97s, 76s, A5s"), rangeWeights("AA, KK, JJ, AQs, KQ, QJs, J9s, 65s, A3s")],
  pot: 10,
  stack: 40,
  sizes: { turn: sizes([0.5, 1], [1]), river: sizes([0.5, 1], [1]) },
  raiseLimit: 1,
  compress: true,
};
// Two-tone turn with suit-symmetric ranges: the solver also reads its strategies symmetrically.
const symmetric: SolverInput = {
  ...turn,
  board: parseCards("Ks9s5d3d"),
  ranges: [rangeWeights("99, 55, AK, KQs, QJs, JTs, T8s, 76s, A4s"), rangeWeights("KK, AA, KJs, KTs, QTs, 87s, 66, 44, A2s")],
};

describe("the compress input", () => {
  it("is a boolean, default false (Float32 storage); true stores Int16 regrets and Uint16 strategy sums", () => {
    for (const compress of [1, "true", 0] as never[]) {
      const input = { ...turn, compress };
      expect(() => buildTree(input)).toThrow(/compress/);
      expect(() => estimateMemory(input)).toThrow(/compress/);
      expect(() => createSolver(input)).toThrow(/compress/);
    }
    const plain = new Engine({ ...turn, compress: undefined });
    expect(plain.compressed).toBe(false);
    expect(plain.regret).toBeInstanceOf(Float32Array);
    expect(plain.stratSum).toBeInstanceOf(Float32Array);
    expect(plain.scale).toHaveLength(0);
    const e = new Engine(turn);
    expect(e.compressed).toBe(true);
    expect(e.regret).toBeInstanceOf(Int16Array);
    expect(e.stratSum).toBeInstanceOf(Uint16Array);
    expect(e.scale).toHaveLength(3 * e.tree.size);
    expect(e.regret.length).toBe(plain.regret.length);
  });

  it("halves the storage in estimateMemory, and changes nothing about the tree", () => {
    const big: SolverInput = { ...turn, ranges: [rangeWeights("22+, A2s+, K2s+, Q8s+, A2o+, K9o+"), rangeWeights("22+, A2s+, K5s+, QTs+, A8o+, KTo+")] };
    const a = estimateMemory({ ...big, compress: false }), b = estimateMemory(big);
    expect({ ...b, bytes: 0 }).toEqual({ ...a, bytes: 0 });
    expect(b.bytes / a.bytes).toBeGreaterThan(0.5);
    expect(b.bytes / a.bytes).toBeLessThan(0.56);
    expect(buildTree(big)).toEqual(buildTree({ ...big, compress: false }));
  });

  it("is deterministic: the same input gives the same numbers", () => {
    const a = new Engine(turn), b = new Engine(turn);
    a.iterate(12);
    b.iterate(12);
    expect(a.regret).toEqual(b.regret);
    expect(a.stratSum).toEqual(b.stratSum);
    expect(a.scale).toEqual(b.scale);
    expect(exploitability(a)).toBe(exploitability(b));
  }, 60_000);
});

/**
 * Gives the Float32 engine `f` the compressed engine's state: first every scale of `c` is rounded down to a power
 * of two, then `f` gets the same values (q × scale, exact in Float32), the same pending discounts and iteration.
 * With power-of-two scales both read bit-identical strategies (the scale cancels exactly), so a traversal
 * computes the same values in both, and the compressed engine's stored result differs from the Float32 one only
 * by its own rounding.
 */
function mirror(c: Engine, f: Engine): void {
  for (let i = 0; i < c.scale.length; i++) if (c.scale[i] > 0) c.scale[i] = 2 ** Math.floor(Math.log2(c.scale[i]));
  f.t = c.t;
  for (const node of c.actionNodes) {
    const v = c.storedValues(node);
    f.regret.set(v.regret, f.off[node]);
    f.stratSum.set(v.stratSum, f.off[node]);
    f.lastT[node] = c.lastT[node];
  }
}

/** One player's half of an iteration (Engine.iterate runs t++, then OOP's traversal, then IP's). */
const traverse = (e: Engine, p: 0 | 1) => e.walk(e.root, p, MODE_CFR, e.w[p], e.w[1 - p], e.out, 0);

describe("a traversal with compressed storage is the Float32 traversal up to the 16-bit rounding", () => {
  // Warm-ups: an early state whose next iteration leaves some nodes unreached (lazy discounts), and a later one.
  for (const [name, input, warmups] of [["turn", turn, [1, 7]], ["symmetric turn", symmetric, [2, 7]]] as const) {
    it(`${name}: regrets within half a step, strategy sums within one step and rounded without bias`, () => {
      let regrets = 0, nonzero = 0, below = 0, bias = 0, stale = 0;
      for (const warm of warmups) {
        const c = new Engine(input), f = new Engine({ ...input, compress: false });
        if (name === "symmetric turn") expect(c.group.length).toBeGreaterThan(1);
        c.iterate(warm);
        /** p's nodes of both engines; `lazy`: after syncDiscounts applied the pending discounts to both. */
        const check = (p: number, lazy: boolean) => {
          // Relative Float32 roundings: of the reference value, and of the scale a stored q is multiplied by
          // (each moves q × scale by up to 2^-24 of it); two more once the discount was applied to both.
          const f32 = (lazy ? 4 : 2) * 2 ** -24;
          for (const node of c.actionNodes) {
            if (c.player(node) !== p) continue;
            const cv = c.storedValues(node), fv = f.storedValues(node);
            const k = 3 * node, pos = c.scale[k], neg = c.scale[k + 1], s = c.scale[k + 2];
            for (let i = 0; i < cv.regret.length; i++) {
              const x = fv.regret[i];
              const tol = 0.5 * (x > 0 ? pos : neg) * (1 + 1e-9) + f32 * Math.abs(x);
              if (!(Math.abs(cv.regret[i] - x) <= tol)) expect.fail(`regret ${node}/${i}: ${cv.regret[i]} vs ${x} (tol ${tol})`);
              regrets++;
              const y = fv.stratSum[i];
              const tolS = s * (1 + 1e-9) + f32 * y;
              if (!(Math.abs(cv.stratSum[i] - y) <= tolS)) expect.fail(`strategy sum ${node}/${i}: ${cv.stratSum[i]} vs ${y} (tol ${tolS})`);
              // Stochastic rounding: a value less than half a step above a stored level is still rounded up
              // with probability (its fraction of a step), so the error averages 0 (rounding to nearest would
              // always round it down: an average of about -0.25 steps).
              if (!lazy && s > 0 && y > 0) {
                nonzero++;
                const steps = y / s, frac = steps - Math.floor(steps);
                if (frac > 0.05 && frac < 0.45) {
                  below++;
                  bias += cv.stratSum[i] / s - steps;
                }
              }
            }
          }
        };
        c.t++;
        for (const p of [0, 1] as const) {
          mirror(c, f);
          // The same strategies: the same best responses, bit for bit.
          for (const q of [0, 1] as const) expect(bestResponseValue(c, q)).toBe(bestResponseValue(f, q));
          traverse(c, p);
          traverse(f, p);
          check(p, false);
          // Nodes the traversal skipped (unreached) still hold their pending discount; applying it, by the
          // scales alone in the compressed engine, gives the same values again.
          stale += c.actionNodes.filter((node) => c.player(node) === p && c.lastT[node] < c.t).length;
          c.syncDiscounts();
          f.syncDiscounts();
          check(p, true);
        }
      }
      expect(stale).toBeGreaterThan(0);
      expect(regrets).toBeGreaterThan(20_000);
      expect(nonzero).toBeGreaterThan(5_000);
      expect(below).toBeGreaterThan(1_000);
      expect(Math.abs(bias / below)).toBeLessThan(0.03);
    });
  }
});

describe("compressed solutions", () => {
  it("a strategy read ignores the scales (they cancel): the solution of a compressed solve sums to 1", () => {
    const sol = solve(turn, { iterations: 30, checkEvery: 30 });
    const root = sol.node([]);
    const e = new Engine(turn);
    e.iterate(30);
    for (const h of e.hands[0].combo) {
      const sum = root.strategy!.reduce((acc, a) => acc + a[h], 0);
      expect(sum).toBeCloseTo(1, 6);
    }
    expect(sol.exploitability).toBe(exploitability(e));
  });
});
