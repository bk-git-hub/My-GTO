// Cross-check of the core solver against the independent oracle (docs/solver.md, Tests 4).
//
// Everything here is driven by a seeded random generator, so a failure names a seed that
// reproduces it. The default run keeps the spots small; set SOLVER_CROSSCHECK=1 for the heavy
// version (many more seeds, bigger spots), and XC_DEBUG=1 to print the measured gaps.
import { describe, expect, it } from "vitest";
import type { Card } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import { bestResponseValue, exploitability } from "./bestResponse";
import { Engine } from "./cfr";
import { createSolver, estimateMemory } from "./index";
import {
  bestResponseOnGame,
  createOracleCfr,
  OracleGame,
  oracleNodeAt,
  oracleNodeInfo,
  oracleTree,
  oracleTreeStats,
  pathKey,
  valueOnGame,
  type OracleNode,
  type StrategyFn,
} from "./oracle";
import { SolverSolution } from "./solution";
import { rng } from "./testHelpers";
import { buildTree } from "./tree";
import type { GameTreeNode, PathStep, Solution, SolverInput, StreetSizes } from "./types";

const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
const HEAVY = !!env.SOLVER_CROSSCHECK;
const debug = (...args: unknown[]) => {
  if (env.XC_DEBUG) console.log(...args);
};
/** Per-test time limit: the default run stays well under it; the heavy run may take minutes. */
const TIMEOUT = HEAVY ? 3_600_000 : 30_000;

/** Float32 unit roundoff: storing a float64 in a Float32Array changes it by at most this relative amount. */
const F32 = 2 ** -24;

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const randInt = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** `len` distinct random cards. */
function randomBoard(r: Rand, len: number): Card[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 0; i < len; i++) {
    const j = i + Math.floor(r() * (52 - i));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, len);
}

// ---------------------------------------------------------------------------------------------
// 1. Tree equality on random configs

/** Fractions people actually use, so that sizes collide with each other and with the stack. */
const NICE = [0.1, 0.25, 0.33, 0.5, 0.6, 0.67, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * A random size list: nice fractions, odd fractions, duplicates, and "colliders" that land a bet or
 * raise exactly on the all-in threshold or on the whole stack (computed in floats, so they may come
 * out one rounding error either side).
 */
function randomFractions(r: Rand, colliders: number[]): number[] {
  const n = randInt(r, 0, 3);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.4) out.push(pick(r, NICE));
    else if (k < 0.6) out.push(Math.round((0.02 + r() * 2.5) * 100) / 100);
    else if (k < 0.75 && out.length > 0) out.push(pick(r, out));
    else if (colliders.length > 0) out.push(pick(r, colliders));
    else out.push(pick(r, NICE));
  }
  return out.filter((f) => f > 0 && Number.isFinite(f));
}

function randomTreeInput(r: Rand, boardLen: number): SolverInput {
  const board = randomBoard(r, boardLen);
  const k = r();
  const pot = k < 0.5 ? randInt(r, 1, 30) : k < 0.7 ? randInt(r, 2, 60) / 2 : 1 + r() * 29;
  const ks = r();
  const stack =
    ks < 0.08 ? 0
    : ks < 0.35 ? pot * pick(r, [0.2, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4.5])
    : ks < 0.75 ? randInt(r, 1, 200)
    : r() * 200;
  const thr = r() < 0.25 ? pick(r, [0.5, 0.67, 1]) : 0.5 + r() * 0.5;
  const minBet = r() < 0.3 ? undefined : pick(r, [0.5, 1, 2, 5, 0.5 + r() * 4.5]);
  const mb = minBet ?? 1;
  // Bets that put in exactly the threshold share or the whole stack at the root.
  const betColliders = [stack / pot, (thr * stack) / pot, mb / pot];
  // IP raises that, facing an opening bet b, raise to exactly the threshold or the whole stack.
  const raiseColliders: number[] = [];
  for (const f of NICE.slice(0, 6)) {
    const b = Math.max(mb, f * pot);
    raiseColliders.push((stack - b) / (pot + 2 * b), (thr * stack - b) / (pot + 2 * b));
  }
  const street = (): [StreetSizes, StreetSizes] => [
    { bet: randomFractions(r, betColliders), raise: randomFractions(r, raiseColliders) },
    { bet: randomFractions(r, betColliders), raise: randomFractions(r, raiseColliders) },
  ];
  const sizes: SolverInput["sizes"] = {};
  if (r() < 0.85) sizes.river = street();
  if (boardLen <= 4 && r() < 0.85) sizes.turn = street();
  if (boardLen === 3 && r() < 0.85) sizes.flop = street();
  return {
    board,
    ranges: [[], []],
    pot,
    stack,
    sizes,
    raiseLimit: r() < 0.2 ? undefined : randInt(r, 0, 3),
    addAllIn: r() < 0.2 ? undefined : r() < 0.5,
    allInThreshold: thr,
    minBet,
  };
}

const chipsClose = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Walk both trees in lock step and record every difference (up to a few). */
function compareTrees(c: GameTreeNode, o: OracleNode, errs: string[], path: string[] = []): void {
  if (errs.length >= 5) return;
  const where = path.join("/") || "root";
  const fail = (msg: string): void => {
    errs.push(`${where}: ${msg}`);
  };
  if (c.kind !== o.kind) return fail(`kind ${c.kind} vs ${o.kind}`);
  if (c.street !== o.street) fail(`street ${c.street} vs ${o.street}`);
  if (c.board.join() !== o.board.join()) fail(`board ${c.board} vs ${o.board}`);
  if (!chipsClose(c.pot, o.pot)) fail(`pot ${c.pot} vs ${o.pot}`);
  for (const i of [0, 1]) {
    if (!chipsClose(c.bets[i], o.bets[i])) fail(`bets ${c.bets} vs ${o.bets}`);
    if (!chipsClose(c.stacks[i], o.stacks[i])) fail(`stacks ${c.stacks} vs ${o.stacks}`);
  }
  if (c.kind === "action") {
    if (c.player !== o.player) fail(`player ${c.player} vs ${o.player}`);
    const ca = c.actions!, oa = o.actions!;
    const show = (as: { kind: string; to: number }[]) => as.map((a) => `${a.kind} ${a.to}`).join(", ");
    if (ca.length !== oa.length || ca.some((a, i) => a.kind !== oa[i].kind || !chipsClose(a.to, oa[i].to) || a.label !== oa[i].label))
      return fail(`actions [${show(ca)}] vs [${show(oa)}]`);
  } else if (c.kind === "chance") {
    if (c.cards!.join() !== o.cards!.join()) return fail(`cards ${c.cards} vs ${o.cards}`);
  } else {
    if (c.terminal !== o.terminal) fail(`terminal ${c.terminal} vs ${o.terminal}`);
    if (c.folder !== o.folder) fail(`folder ${c.folder} vs ${o.folder}`);
  }
  if (c.children.length !== o.children.length) return fail(`${c.children.length} vs ${o.children.length} children`);
  for (let i = 0; i < c.children.length; i++) {
    path.push(c.kind === "chance" ? `c${c.cards![i]}` : `a${i}`);
    compareTrees(c.children[i], o.children[i], errs, path);
    path.pop();
  }
}

describe("cross-check: trees", () => {
  // Found by the random comparison below: in floats 0.7 × 3 = 2.0999999999999996, one rounding error
  // under a 2.1 stack. Read literally, that is a bet leaving 4e-16 behind, after which the opponent may
  // still raise and the hand continues with dust stacks. The spec now treats chip amounts within 1e-9
  // as equal, so a bet or raise that would leave at most 1e-9 behind is the all-in.
  it("a bet or raise that would leave only rounding dust behind is the all-in", () => {
    const board = randomBoard(rng(1), 5);
    const bet: SolverInput = {
      board, ranges: [[], []], pot: 3, stack: 2.1, allInThreshold: 1,
      sizes: { river: [{ bet: [0.7], raise: [] }, { bet: [], raise: [] }] },
    };
    expect(0.7 * 3).toBeLessThan(2.1);
    for (const root of [buildTree(bet), oracleTree(bet)]) {
      expect(root.actions!.map((a) => [a.kind, a.to])).toEqual([["check", 0], ["allin", 2.1]]);
      // IP faces an all-in: no raise, and a call ends the hand at showdown with nothing behind.
      expect(root.children[1].actions!.map((a) => a.kind)).toEqual(["fold", "call"]);
      expect(root.children[1].children[1].stacks).toEqual([0, 0]);
    }
    // Raise: OOP bets the 1 bb minimum into 3, IP raises to 1 + 0.47 × 5 = 3.3499999999999996 of 3.35.
    const raise: SolverInput = {
      board, ranges: [[], []], pot: 3, stack: 3.35, allInThreshold: 1, addAllIn: false,
      sizes: { river: [{ bet: [0.1], raise: [] }, { bet: [], raise: [0.47] }] },
    };
    for (const root of [buildTree(raise), oracleTree(raise)]) {
      const ip = root.children[1];
      expect(ip.actions!.map((a) => [a.kind, a.to])).toEqual([["fold", 0], ["call", 1], ["allin", 3.35]]);
      expect(ip.children[2].actions!.map((a) => a.kind)).toEqual(["fold", "call"]);
    }
  });

  // docs/solver.md "Inputs": both implementations reject the same inputs and agree on the degenerate
  // ones that used to recurse forever (a stack under the tolerance offered 0-chip all-ins), let a bet
  // below the tolerance go uncalled (minBet <= 1e-9), or built "벳 NaN%" from a NaN size.
  it("both reject the same invalid inputs and build the same trees for degenerate ones", () => {
    const board = randomBoard(rng(2), 5);
    const turn = randomBoard(rng(3), 4);
    const base: SolverInput = { board, ranges: [[], []], pot: 10, stack: 100 };
    const river = (bet: unknown[], raise: unknown[] = []) =>
      ({ river: [{ bet, raise }, { bet: [0.5], raise }] }) as unknown as SolverInput["sizes"];
    const invalid: Partial<SolverInput>[] = [
      { pot: 0 }, { pot: -2 }, { pot: NaN }, { pot: Infinity }, { stack: -1 }, { stack: NaN }, { stack: Infinity },
      { minBet: 0 }, { minBet: 1e-9 }, { minBet: -1 }, { minBet: NaN }, { minBet: Infinity },
      { raiseLimit: -1 }, { raiseLimit: 2.5 }, { raiseLimit: NaN }, { raiseLimit: Infinity }, { addAllIn: 0 as never },
      { allInThreshold: 0 }, { allInThreshold: -1 }, { allInThreshold: NaN }, { allInThreshold: Infinity },
      { sizes: river([NaN]) }, { sizes: river([-0.5]) }, { sizes: river([Infinity]) }, { sizes: river(["1"]) },
      { sizes: river([0.5], [NaN]) }, { sizes: river([0.5], [-1]) },
      { sizes: { flop: [{ bet: [NaN], raise: [] }, { bet: [], raise: [] }] } },
      { sizes: { river: [{ bet: [], raise: [] }] } as never },
      { board: board.slice(0, 2) }, { board: [board[0], board[0], board[1]] }, { board: [0, 1, 52] }, { board: [0, 1, 2.5] },
    ];
    for (const over of invalid) {
      const input = { ...base, ...over };
      expect(() => buildTree(input), `core ${JSON.stringify(over)}`).toThrow();
      expect(() => estimateMemory(input), `estimate ${JSON.stringify(over)}`).toThrow();
      expect(() => oracleTree(input), `oracle ${JSON.stringify(over)}`).toThrow();
    }
    const valid: Partial<SolverInput>[] = [
      { stack: 1e-12 }, { stack: 1e-9 }, { stack: 2e-9 }, { board: turn, stack: 1e-10 }, { board: turn, stack: 3e-9 },
      { minBet: 2e-9, sizes: river([1e-12, 0], [0]) },
      { pot: 1, minBet: 1.25 }, { pot: 1, minBet: 0.333 }, { pot: 1, minBet: 0.336 }, { pot: 3, minBet: 2.675 },
      { sizes: river([0, 0, 0.5], [0, 0.25]), raiseLimit: 3 },
      { allInThreshold: 1.5, stack: 12 }, { allInThreshold: 1e-6, stack: 30 },
    ];
    for (const over of valid) {
      const input = { ...base, ...over };
      const orc = oracleTree(input);
      const errs: string[] = [];
      compareTrees(buildTree(input), orc, errs);
      expect(errs, JSON.stringify(over)).toEqual([]);
      expect(estimateMemory(input), JSON.stringify(over)).toMatchObject(oracleTreeStats(orc));
    }

    // Ranges: NaN, negative and > 1 weights (also on board combos) and too many entries are rejected by both.
    const ok = randomRanges(rng(4), board, 4, 4);
    const onBoard = COMBOS.findIndex((c) => board.includes(c.cards[0]));
    const live = ok[0].findIndex((w) => w > 0);
    for (const [i, w] of [[live, NaN], [live, -0.5], [live, 1.5], [live, 50], [onBoard, NaN], [onBoard, 2]]) {
      const r = Float64Array.from(ok[0]);
      r[i] = w;
      const input: SolverInput = { ...base, ranges: [r, ok[1]] };
      expect(() => createSolver(input), `core ${i} ${w}`).toThrow();
      expect(() => estimateMemory(input), `estimate ${i} ${w}`).toThrow();
      expect(() => new OracleGame(input), `oracle ${i} ${w}`).toThrow();
    }
    const long: SolverInput = { ...base, ranges: [ok[0], [...ok[1], 0]] };
    expect(() => createSolver(long)).toThrow();
    expect(() => new OracleGame(long)).toThrow();

    // Path steps: the same shapes are illegal in both, after the legal forms were looked up.
    const spot: SolverInput = { ...base, board: turn, ranges: randomRanges(rng(5), turn, 4, 4), stack: 10, raiseLimit: 0,
      sizes: { turn: [{ bet: [0.5], raise: [] }, { bet: [0.5], raise: [] }], river: [{ bet: [0.5], raise: [] }, { bet: [0.5], raise: [] }] } };
    const solver = createSolver(spot);
    solver.iterate(1);
    const sol = solver.solution();
    const game = new OracleGame(spot);
    const card = oracleNodeAt(game.root, [{ action: 0 }, { action: 0 }]).cards![7];
    const legal: PathStep[][] = [[{ action: 1 }], [{ action: 0 }, { action: 0 }, { card }]];
    for (const path of legal) {
      expect(sol.node(path).board).toEqual(oracleNodeAt(game.root, path).board);
    }
    const illegal = [
      [{ action: "1" }], [{ action: 1, card: 5 }], [{}], [null], [{ action: 0.5 }],
      [{ action: 0 }, { action: 0 }, { card: String(card) }], [{ action: 0 }, { action: 0 }, { action: card }],
    ] as unknown as PathStep[][];
    for (const path of illegal) {
      expect(() => sol.node(path), `core ${JSON.stringify(path)}`).toThrow();
      expect(() => oracleNodeAt(game.root, path), `oracle ${JSON.stringify(path)}`).toThrow();
    }
  });

  // Configs are drawn until the tree is small enough to build twice; the rest are skipped.
  const maxNodes = HEAVY ? 400_000 : 40_000;

  function run(seed: number, boardLen: number): { nodes: number } | null {
    const r = rng(seed);
    const input = randomTreeInput(r, boardLen);
    const est = estimateMemory(input);
    const nodes = est.actionNodes + est.chanceNodes + est.terminalNodes;
    if (nodes > maxNodes) return null;
    const core = buildTree(input);
    const orc = oracleTree(input);
    const errs: string[] = [];
    compareTrees(core, orc, errs);
    if (errs.length > 0) throw new Error(`seed ${seed} (${JSON.stringify(input)}):\n${errs.join("\n")}`);
    // estimateMemory counts without building; it must count the same tree.
    expect(est, `seed ${seed}`).toMatchObject(oracleTreeStats(orc));
    return { nodes };
  }

  it("river, turn and flop trees are identical on random configs", () => {
    const n = HEAVY ? 10000 : 1500;
    // Per board length: configs compared, configs skipped for size, nodes compared.
    const stats: Record<number, { compared: number; skipped: number; nodes: number }> = {};
    for (let seed = 1; seed <= n; seed++) {
      // Mostly river configs: turn trees are 48 times bigger and flop trees bigger again (most
      // flop configs are skipped for size; the ones left have short stacks or tiny menus).
      const len = seed % 10 === 0 ? 3 : seed % 3 === 0 ? 4 : 5;
      const st = (stats[len] ??= { compared: 0, skipped: 0, nodes: 0 });
      const res = run(seed, len);
      if (res) {
        st.compared++;
        st.nodes += res.nodes;
      } else st.skipped++;
    }
    debug("trees by board length:", JSON.stringify(stats));
    // Enough of each street got through the size filter for the comparison to mean something.
    expect(stats[5].compared).toBeGreaterThan(0.95 * (stats[5].compared + stats[5].skipped));
    expect(stats[4].compared).toBeGreaterThan(0.6 * (stats[4].compared + stats[4].skipped));
    expect(stats[3].compared).toBeGreaterThan(0.1 * (stats[3].compared + stats[3].skipped));
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------------------------
// Small solvable spots (river and turn, 5-40 combos per range)

/**
 * Random ranges with weights in (0, 1]. About a quarter of IP's combos are also in OOP's range
 * (so the same-combo terms of the card-removal sums matter), and each range gets a combo that
 * touches the board, which both implementations must ignore.
 */
function randomRanges(r: Rand, board: Card[], n0: number, n1: number): [Float64Array, Float64Array] {
  const live: number[] = [];
  const dead: number[] = [];
  COMBOS.forEach((c, i) => (board.includes(c.cards[0]) || board.includes(c.cards[1]) ? dead : live).push(i));
  const weight = () => (r() < 0.2 ? 1 : 1 - r());
  const w0 = new Float64Array(1326);
  const w1 = new Float64Array(1326);
  const chosen0: number[] = [];
  while (chosen0.length < n0) {
    const i = pick(r, live);
    if (w0[i] === 0) {
      w0[i] = weight();
      chosen0.push(i);
    }
  }
  let k1 = 0;
  while (k1 < n1) {
    const i = r() < 0.25 ? pick(r, chosen0) : pick(r, live);
    if (w1[i] === 0) {
      w1[i] = weight();
      k1++;
    }
  }
  w0[pick(r, dead)] = weight();
  w1[pick(r, dead)] = weight();
  return [w0, w1];
}

interface SpotOptions {
  street: "river" | "turn";
  minCombos: number;
  maxCombos: number;
  /** Largest tree (action + chance + terminal nodes) to accept. */
  maxNodes: number;
}

/** A random small spot; menus are redrawn until the tree fits `maxNodes`. */
function randomSpot(seed: number, o: SpotOptions): SolverInput {
  const r = rng(seed);
  const board = randomBoard(r, o.street === "river" ? 5 : 4);
  const pot = r() < 0.7 ? randInt(r, 2, 20) : 2 + r() * 18;
  const n0 = randInt(r, o.minCombos, o.maxCombos);
  const n1 = randInt(r, o.minCombos, o.maxCombos);
  const ranges = randomRanges(r, board, n0, n1);
  for (let attempt = 0; attempt < 500; attempt++) {
    // After a few misses, fall back to one bet size and no raises.
    const narrow = attempt >= 20;
    const stack = pot * pick(r, [0.5, 1, 1.5, 2, 3, 5]) * (r() < 0.5 ? 1 : 0.8 + 0.4 * r());
    const menu = (): StreetSizes => ({
      bet: narrow || r() < 0.6 ? [pick(r, NICE)] : [pick(r, NICE), pick(r, NICE)],
      raise: narrow || r() < 0.5 ? [] : [pick(r, NICE)],
    });
    const street = (): [StreetSizes, StreetSizes] => [menu(), menu()];
    const input: SolverInput = {
      board,
      ranges,
      pot,
      stack,
      sizes: o.street === "river" ? { river: street() } : { turn: street(), river: street() },
      raiseLimit: narrow ? 0 : randInt(r, 0, 2),
      addAllIn: !narrow && r() < 0.5,
      allInThreshold: pick(r, [0.67, 0.8, 1]),
      minBet: pick(r, [0.5, 1, 2]),
    };
    const est = estimateMemory(input);
    if (est.actionNodes + est.chanceNodes + est.terminalNodes <= o.maxNodes) return input;
  }
  throw new Error(`seed ${seed}: no ${o.street} tree with at most ${o.maxNodes} nodes`);
}

/** Longest run of each player's action nodes on any root-to-leaf path: [OOP, IP]. */
function actionDepths(root: OracleNode): [number, number] {
  const best: [number, number] = [0, 0];
  const rec = (node: OracleNode, d0: number, d1: number) => {
    if (node.kind === "action") {
      if (node.player === 0) d0++;
      else d1++;
    }
    best[0] = Math.max(best[0], d0);
    best[1] = Math.max(best[1], d1);
    for (const c of node.children) rec(c, d0, d1);
  };
  rec(root, 0, 0);
  return best;
}

/**
 * The core's average strategy as an oracle StrategyFn: Solution.node(path).strategy[a][combo].
 * A fresh Solution per node keeps its node cache from holding every node of the tree.
 */
function coreStrategy(solution: () => Solution): StrategyFn {
  const rows = new Map<string, Float32Array[]>();
  return (path, combo) => {
    const key = pathKey(path);
    let s = rows.get(key);
    if (!s) {
      s = solution().node(path).strategy!;
      rows.set(key, s);
    }
    return s.map((a) => a[combo]);
  };
}

/**
 * Tolerance on exploitability (% of pot) between the core and the oracle evaluating the same strategy.
 *
 * The core plays its float64 average strategy; the oracle reads the Float32 copy in SolutionNode.strategy,
 * each probability within a relative F32 of the core's. In BR_p only the opponent's probabilities enter:
 * at most D_opp of them multiply along any path, so every leaf's reach differs by a relative D_opp × F32
 * (to first order). Payoffs are at most M = P0 + S in size and, for each of p's hands, the reach reaching
 * the leaves adds up to its compatible weight, so |ΔBR_p| <= D_opp × F32 × M (the max over p's actions
 * changes by no more than its inputs). Exploitability is (BR_0 + BR_1 - P0) / (2 P0) × 100. A small
 * margin covers second-order terms and float64 summation noise.
 */
function exploitabilityTolerance(input: SolverInput, depths: [number, number]): number {
  const M = input.pot + input.stack;
  return 1.05 * ((depths[0] + depths[1]) * F32 * M) / (2 * input.pot) * 100 + 1e-9;
}

/** |ΔBR_p| bound for one player (see exploitabilityTolerance). */
function brTolerance(input: SolverInput, depths: [number, number], p: 0 | 1): number {
  const M = input.pot + input.stack;
  return 1.05 * depths[1 - p] * F32 * M + 1e-12 * M;
}

/**
 * The core's own numbers for a strategy against the oracle's best response to the same strategy (read
 * through `solution`): exploitability, and each player's best-response value.
 */
function checkBestResponse(
  label: string,
  input: SolverInput,
  game: OracleGame,
  core: { exploitability: number; br0: number; br1: number },
  solution: () => Solution,
) {
  const depths = actionDepths(game.root);
  const orc = bestResponseOnGame(game, coreStrategy(solution));
  const tol = exploitabilityTolerance(input, depths);
  debug(label, "core", core.exploitability, "oracle", orc.exploitability, "gap", core.exploitability - orc.exploitability, "tol", tol);
  expect(Math.abs(core.exploitability - orc.exploitability), `${label}: exploitability ${core.exploitability} vs oracle ${orc.exploitability} (tol ${tol})`).toBeLessThanOrEqual(tol);
  expect(Math.abs(core.br0 - orc.br0), `${label}: BR0 ${core.br0} vs ${orc.br0}`).toBeLessThanOrEqual(brTolerance(input, depths, 0));
  expect(Math.abs(core.br1 - orc.br1), `${label}: BR1 ${core.br1} vs ${orc.br1}`).toBeLessThanOrEqual(brTolerance(input, depths, 1));
}

/** The core's exploitability and best-response values, straight from the engine. */
const engineNumbers = (e: Engine) => ({ exploitability: exploitability(e), br0: bestResponseValue(e, 0), br1: bestResponseValue(e, 1) });

// The spots for sections 2 and 4. Turn trees are kept small because the oracle walks the whole
// tree once per hand and per opponent hand.
const riverSpot = (seed: number) =>
  randomSpot(seed, { street: "river", minCombos: 5, maxCombos: 40, maxNodes: HEAVY ? 400 : 150 });
const turnSpot = (seed: number) =>
  randomSpot(seed, { street: "turn", minCombos: 5, maxCombos: HEAVY ? 40 : 25, maxNodes: HEAVY ? 5000 : 1500 });

/**
 * A flop spot small enough for the oracle: short stacks and no bet sizes, so each street is check or
 * all-in (49 turn cards, 48 river cards, two-card runouts after a flop all-in).
 */
function flopSpot(seed: number): SolverInput {
  const r = rng(seed);
  const board = randomBoard(r, 3);
  const pot = randInt(r, 4, 20);
  const none: [StreetSizes, StreetSizes] = [{ bet: [], raise: [] }, { bet: [], raise: [] }];
  return {
    board,
    ranges: randomRanges(r, board, randInt(r, 3, 6), randInt(r, 3, 6)),
    pot,
    stack: pot * pick(r, [0.25, 0.5, 1]),
    sizes: { flop: none, turn: none, river: none },
  };
}

describe("cross-check: exploitability of the core's strategy", () => {
  const seeds = (base: number, n: number) => Array.from({ length: n }, (_, i) => base + i);

  it("matches the oracle's best response after 1, 2 and a modest number of iterations", () => {
    const spots = [
      ...seeds(1000, HEAVY ? 60 : 12).map((s) => ({ seed: s, input: riverSpot(s) })),
      ...seeds(2000, HEAVY ? 25 : 5).map((s) => ({ seed: s, input: turnSpot(s) })),
      ...seeds(2500, HEAVY ? 4 : 1).map((s) => ({ seed: s, input: flopSpot(s) })),
    ];
    for (const { seed, input } of spots) {
      const game = new OracleGame(input);
      // The public solver, and an engine run alongside it for the per-player best responses
      // (the runs are deterministic, so both hold the same numbers).
      const s = createSolver(input);
      const e = new Engine(input);
      // 1 iteration: both average strategies are uniform (deliberately bad).
      // 2 iterations: lopsided, still far from equilibrium. Then a modest solve.
      for (const t of [1, 2, 40]) {
        s.iterate(t - s.iteration);
        e.iterate(t - e.t);
        const core = engineNumbers(e);
        expect(s.exploitability()).toBe(core.exploitability);
        checkBestResponse(`seed ${seed} t=${t}`, input, game, core, () => s.solution());
      }
    }
  }, TIMEOUT);

  it("matches on random (non-equilibrium) strategies written into the strategy sums", () => {
    const spots = [
      ...seeds(3000, HEAVY ? 60 : 12).map((s) => ({ seed: s, input: riverSpot(s) })),
      ...seeds(4000, HEAVY ? 20 : 4).map((s) => ({ seed: s, input: turnSpot(s) })),
    ];
    for (const { seed, input } of spots) {
      const r = rng(seed * 31 + 7);
      const game = new OracleGame(input);
      const e = new Engine(input);
      fillRandomStrategy(r, e);
      checkBestResponse(`seed ${seed} random`, input, game, engineNumbers(e), () => new SolverSolution(e, () => NaN));
    }
  }, TIMEOUT);
});

/**
 * Random strategy sums: skewed weights, some exact zeros (actions never taken) and some hands with
 * all-zero sums (the average strategy is then uniform).
 */
function fillRandomStrategy(r: Rand, e: Engine): void {
  for (const node of e.actionNodes) {
    const n = e.hands[node.player!].n;
    const A = node.children.length;
    for (let h = 0; h < n; h++) {
      const allZero = r() < 0.1;
      for (let a = 0; a < A; a++) e.stratSum[node.off + a * n + h] = allZero || r() < 0.25 ? 0 : r() ** 2;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Game value: both solutions bracket the same equilibrium value

/**
 * For any strategy pair, P0 - BR_1 <= v* <= BR_0, where v* is OOP's equilibrium value (unique in a
 * two-player zero-sum game): BR_0 is OOP's best against IP's strategy, so it is at least the min-max
 * value, and likewise for IP. So the core's interval and the oracle's interval must overlap.
 */
describe("cross-check: game value", () => {
  it("the core's and the oracle CFR's value intervals overlap on tiny spots", () => {
    const spots = [
      ...Array.from({ length: HEAVY ? 30 : 8 }, (_, i) => 5000 + i).map((seed) => ({
        seed,
        input: randomSpot(seed, { street: "river", minCombos: 5, maxCombos: HEAVY ? 20 : 12, maxNodes: HEAVY ? 120 : 60 }),
        oracleIters: HEAVY ? 3000 : 600,
      })),
      ...Array.from({ length: HEAVY ? 10 : 3 }, (_, i) => 6000 + i).map((seed) => ({
        seed,
        input: randomSpot(seed, { street: "turn", minCombos: 5, maxCombos: HEAVY ? 12 : 8, maxNodes: HEAVY ? 3000 : 1500 }),
        oracleIters: HEAVY ? 800 : 150,
      })),
    ];
    for (const { seed, input, oracleIters } of spots) {
      const P0 = input.pot;
      // Core: solve well past the oracle's accuracy.
      const e = new Engine(input);
      for (let k = 0; k < 40 && exploitability(e) > 0.005; k++) e.iterate(50);
      const core = [P0 - bestResponseValue(e, 1), bestResponseValue(e, 0)];
      // Oracle: plain CFR+ on its own tree, measured by its own best response.
      const oc = createOracleCfr(input);
      oc.iterate(oracleIters);
      const ob = bestResponseOnGame(oc.game, oc.strategyAt);
      const orc = [P0 - ob.br1, ob.br0];
      debug(`seed ${seed}: core [${core}] (${exploitability(e)}%), oracle [${orc}] (${ob.exploitability}%)`);
      const slack = 1e-9 * (P0 + input.stack);
      expect(core[0], `seed ${seed}: core interval is ordered`).toBeLessThanOrEqual(core[1] + slack);
      expect(orc[0], `seed ${seed}: oracle interval is ordered`).toBeLessThanOrEqual(orc[1] + slack);
      expect(Math.max(core[0], orc[0]), `seed ${seed}: core [${core}] vs oracle [${orc}]`).toBeLessThanOrEqual(Math.min(core[1], orc[1]) + slack);
      // Both solves are good enough for the overlap to be a sharp test (widths in % of pot).
      expect(((core[1] - core[0]) / P0) * 100, `seed ${seed}: core width`).toBeLessThan(0.05);
      expect(((orc[1] - orc[0]) / P0) * 100, `seed ${seed}: oracle width`).toBeLessThan(HEAVY ? 0.5 : 1);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------------------------
// 4. EVs and ranges at the root and deeper nodes

/** Largest |core - oracle| / tolerance seen in checkNodes (printed with XC_DEBUG). */
let worstRatio = 0;

/** A random path from the root: random actions and cards, stopping at random or at a terminal. */
function randomPath(r: Rand, root: OracleNode): PathStep[] {
  const path: PathStep[] = [];
  let node = root;
  while (node.kind !== "terminal" && r() < 0.85) {
    const k = randInt(r, 0, node.children.length - 1);
    path.push(node.kind === "action" ? { action: k } : { card: node.cards![k] });
    node = node.children[k];
  }
  return path;
}

/**
 * Core SolutionNode.ranges and .ev against oracleNodeInfo evaluating the same (Float32) strategy.
 *
 * Tolerances, with D = OOP + IP action depth of the tree and W = P0 + 2S (the width of the payoff range):
 * - ranges: a product of at most D probabilities, each Float32-rounded on one side, then stored as
 *   Float32 by the core: relative (D + 1) × F32.
 * - ev = (Σ_o r(o) E[net | h, o]) / Σ_o r(o). The opponent weights r(o) differ by a relative D × F32,
 *   which moves a weighted average by at most D × F32 × W; the conditional expectations below the
 *   node differ by at most D × F32 × W; the core stores the result as Float32 (F32 × W). The core's
 *   card-removal sums (total - by card 1 - by card 2 + same combo) also lose about 16 float64 ulps
 *   of the opponent's total reach, which matters when the compatible reach is a small part of it.
 */
function checkNodes(label: string, input: SolverInput, e: Engine, game: OracleGame, paths: PathStep[][]) {
  const [d0, d1] = actionDepths(game.root);
  const D = d0 + d1;
  const W = input.pot + 2 * input.stack;
  const strategyAt = coreStrategy(() => new SolverSolution(e, () => NaN));
  const sol = new SolverSolution(e, () => NaN);
  let compared = 0;
  for (const path of paths) {
    const where = `${label} path ${pathKey(path) || "root"}`;
    const core = sol.node(path);
    const orc = oracleNodeInfo(input, strategyAt, path);
    for (const p of [0, 1] as const) {
      for (let c = 0; c < 1326; c++) {
        const a = core.ranges[p][c], b = orc.ranges[p][c];
        if (Math.abs(a - b) > (D + 1) * 1.05 * F32 * Math.max(a, b))
          expect.fail(`${where}: range[${p}][${c}] core ${a} vs oracle ${b}`);
      }
    }
    for (const p of [0, 1] as const) {
      const opp = orc.ranges[1 - p];
      let total = 0;
      for (let o = 0; o < 1326; o++) total += opp[o];
      for (let c = 0; c < 1326; c++) {
        const ce = core.ev[p][c], oe = orc.ev[p][c];
        if (Number.isNaN(oe)) {
          // Not in the list, blocked by the board, or no compatible opponent reach at all.
          if (!Number.isNaN(ce)) expect.fail(`${where}: ev[${p}][${c}] core ${ce} vs oracle NaN`);
          continue;
        }
        // Compatible opponent reach of this combo.
        const [x, y] = COMBOS[c].cards;
        let compat = 0;
        for (let o = 0; o < 1326; o++) {
          if (opp[o] === 0) continue;
          const [u, v] = COMBOS[o].cards;
          if (u !== x && u !== y && v !== x && v !== y) compat += opp[o];
        }
        // Below this the core treats the compatible reach as rounding residue (NaN); see solution.ts.
        if (compat <= 1e-9 * total) continue;
        const tol = 1.05 * (2 * D + 1) * F32 * W + 16 * 2 ** -53 * (total / compat) * W;
        if (!(Math.abs(ce - oe) <= tol)) expect.fail(`${where}: ev[${p}][${c}] core ${ce} vs oracle ${oe} (tol ${tol})`);
        worstRatio = Math.max(worstRatio, Math.abs(ce - oe) / tol);
        compared++;
      }
    }
  }
  return compared;
}

describe("cross-check: SolutionNode ev and ranges", () => {
  it("match the oracle at the root and along random paths", () => {
    const spots = [
      ...Array.from({ length: HEAVY ? 40 : 10 }, (_, i) => ({ seed: 7000 + i, input: riverSpot(7000 + i) })),
      ...Array.from({ length: HEAVY ? 15 : 4 }, (_, i) => ({ seed: 8000 + i, input: turnSpot(8000 + i) })),
    ];
    let compared = 0;
    for (const { seed, input } of spots) {
      const r = rng(seed * 17 + 3);
      const game = new OracleGame(input);
      const paths = [[], ...Array.from({ length: HEAVY ? 12 : 5 }, () => randomPath(r, game.root))];
      // A modest solve, and random strategies (where the opponent reach gets lopsided).
      const e = new Engine(input);
      e.iterate(30);
      compared += checkNodes(`seed ${seed} t=30`, input, e, game, paths);
      const er = new Engine(input);
      fillRandomStrategy(r, er);
      compared += checkNodes(`seed ${seed} random`, input, er, game, paths);

      // The root EVs, weighted by the initial ranges, give each player's game value: compare with
      // oracleValue (here W covers the Float32 ev storage and the strategy rounding as above).
      const values = valueOnGame(game, coreStrategy(() => new SolverSolution(e, () => NaN)));
      const root = new SolverSolution(e, () => NaN).node([]);
      const [d0, d1] = actionDepths(game.root);
      const W = input.pot + 2 * input.stack;
      for (const p of [0, 1] as const) {
        const w = input.ranges[p], wo = input.ranges[1 - p];
        let num = 0, den = 0;
        for (let c = 0; c < 1326; c++) {
          if (!(w[c] > 0) || Number.isNaN(root.ev[p][c])) continue;
          const [x, y] = COMBOS[c].cards;
          if (input.board.includes(x) || input.board.includes(y)) continue;
          let cs = 0;
          for (let o = 0; o < 1326; o++) {
            if (!(wo[o] > 0)) continue;
            const [u, v] = COMBOS[o].cards;
            if (input.board.includes(u) || input.board.includes(v)) continue;
            if (u !== x && u !== y && v !== x && v !== y) cs += wo[o];
          }
          num += w[c] * cs * root.ev[p][c];
          den += w[c] * cs;
        }
        expect(Math.abs(num / den - values[p]), `seed ${seed}: value ${p}`).toBeLessThanOrEqual(1.05 * (2 * (d0 + d1) + 1) * F32 * W);
      }
    }
    debug("ev values compared:", compared, "largest gap / tolerance:", worstRatio);
    expect(compared).toBeGreaterThan(0);
  }, TIMEOUT);
});
