import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { Engine } from "./cfr";
import { estimateMemory } from "./index";
import { rangeWeights } from "./testHelpers";
import { buildGameTree, NODE_ACTION } from "./tree";
import type { SolverInput, StreetSizes } from "./types";

// estimateMemory against the real heap (docs/solver.md "API" and "Performance"). Measuring needs gc():
// exposed by node --expose-gc, or switched on here through node:v8 (imported by a computed name so
// the solver's types don't need Node's). Outside Node the measurement is skipped.
async function exposeGc(): Promise<(() => void) | undefined> {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g === "function") return g;
  try {
    const [v8, vm] = ["node:v8", "node:vm"];
    const { setFlagsFromString } = await import(/* @vite-ignore */ v8);
    const { runInNewContext } = await import(/* @vite-ignore */ vm);
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc");
    return typeof gc === "function" ? gc : undefined;
  } catch {
    return undefined;
  }
}
const gc = await exposeGc();
const memoryUsage = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number; arrayBuffers: number } } }).process?.memoryUsage;

/** Heap plus ArrayBuffer bytes after a full collection. */
function heldBytes(): number {
  for (let i = 0; i < 4; i++) gc!();
  const m = memoryUsage!();
  return m.heapUsed + m.arrayBuffers;
}

/** Bytes an Engine for `input` holds: the heap growth while one is alive (after a warm-up build of the same spot). */
function measuredEngineBytes(input: SolverInput): number {
  new Engine(input); // compiles the code paths first, so the measured build holds data only
  const before = heldBytes();
  const e = new Engine(input);
  const bytes = heldBytes() - before;
  expect(e.t).toBe(0); // keeps e alive until after the measurement
  return bytes;
}

const OOP = "22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o";
const IP = "22+, A2s+, K2s+, Q2s+, J5s+, T6s+, 96s+, 85s+, 74s+, 64s+, 53s+, A2o+, K8o+, Q9o+, J9o+, T9o";
const sizes = (bet: number[], raise: number[]): [StreetSizes, StreetSizes] => [{ bet, raise }, { bet, raise }];

describe.skipIf(!gc || !memoryUsage)("estimateMemory matches the measured heap", () => {
  it("within 10% on river, turn and flop solvers, with and without suit isomorphism and compressed storage", () => {
    const spots: [string, SolverInput][] = [
      // About 500 combos each: storage dominates.
      ["river", { board: parseCards("Ks9h5c3d2s"), ranges: [rangeWeights(OOP), rangeWeights(IP)], pot: 10, stack: 100,
        sizes: { river: sizes([0.33, 0.66, 1], [0.5, 1]) }, raiseLimit: 3 }],
      ["turn", { board: parseCards("Ks9h5c3d"), ranges: [rangeWeights(OOP), rangeWeights(IP)], pot: 20, stack: 80 }],
      // A few combos each on a flop: the tree (300k nodes) and the showdown cache dominate.
      ["flop", { board: parseCards("Ks7d2c"), ranges: [rangeWeights("AA, 76s"), rangeWeights("KQs, QJs, 98s")], pot: 5.5, stack: 20,
        sizes: { flop: [{ bet: [], raise: [0.6] }, { bet: [0.33], raise: [] }], turn: sizes([0.66], []), river: sizes([0.75], []) }, raiseLimit: 1 }],
      // Suit isomorphism: the solver keeps one subtree per orbit of cards (docs/solver.md "Suit isomorphism").
      ["two-tone turn", { board: parseCards("Ks9s5d3d"), ranges: [rangeWeights(OOP), rangeWeights(IP)], pot: 20, stack: 80 }],
      ["monotone flop", { board: parseCards("Ks7s2s"), ranges: [rangeWeights("AA, 76s"), rangeWeights("KQs, QJs, 98s")], pot: 5.5, stack: 20,
        sizes: { flop: [{ bet: [], raise: [0.6] }, { bet: [0.33], raise: [] }], turn: sizes([0.66], []), river: sizes([0.75], []) }, raiseLimit: 1 }],
    ];
    // Compressed storage (docs/solver.md "Compressed storage"): 16-bit regrets and strategy sums, per-node scales.
    // Each right after its Float32 twin (so the small river comes before the big spots: memory a bigger spot
    // is still releasing would blur its measurement).
    const all = spots.flatMap(([name, input]): [string, SolverInput][] =>
      name === "two-tone turn" ? [[name, input]] : [[name, input], [`${name}, compressed`, { ...input, compress: true }]],
    );
    for (const [name, input] of all) {
      if (name.includes("two-tone") || name.includes("monotone")) expect(new Engine(input).group.length, name).toBeGreaterThan(1);
      const est = estimateMemory(input).bytes;
      const measured = measuredEngineBytes(input);
      expect(est / measured, `${name}: estimate ${est} vs measured ${measured}`).toBeGreaterThan(0.9);
      expect(est / measured, `${name}: estimate ${est} vs measured ${measured}`).toBeLessThan(1.1);
    }
  });
});

describe("the packed tree", () => {
  it("takes 10 bytes per node, terminals included, and shares descriptors across cards", () => {
    // The reference flop menu of docs/solver.md "Performance" at raiseLimit 1: about 1.14 million nodes.
    const input: SolverInput = {
      board: parseCards("Ks7d2c"), ranges: [[], []], pot: 5.5, stack: 97.5, raiseLimit: 1,
      sizes: { flop: [{ bet: [], raise: [0.6] }, { bet: [0.33, 0.75], raise: [0.6] }], turn: sizes([0.66], [0.6]), river: sizes([0.75], [0.6]) },
    };
    const t = buildGameTree(input);
    const est = estimateMemory(input);
    expect(t.size).toBe(est.actionNodes + est.chanceNodes + est.terminalNodes);
    expect(t.size).toBeGreaterThan(1_000_000);
    expect(t.nodeBytes).toBe(10 * t.size);
    // One descriptor per node of the betting skeleton (chance nodes collapsed to one child), not per node.
    expect(t.dType.length).toBeLessThan(2000);
    // The action nodes reach every descriptor of their kind; the action count matches.
    let actions = 0;
    for (let id = 0; id < t.size; id++) if (t.type(id) === NODE_ACTION) actions++;
    expect(actions).toBe(est.actionNodes);
  });
});
