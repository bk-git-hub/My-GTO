import { COMBOS } from "../../play/handInfo";
import type { PathStep, Player, SolverInput } from "../types";
import { chanceProbability, compatible, OracleGame, sharesCard } from "./game";
import { forEachNode, oracleNodeAt, type OracleNode } from "./tree";

/**
 * Best response, exploitability and game values for any strategy, computed the slow
 * and obvious way.
 *
 * For a player p and one of p's hands h we walk the whole tree once, carrying the
 * opponent's reach for every opponent hand o:
 *   reach(o) = w(o) × (opponent's action probabilities on the path) × (chance probabilities),
 * with reach(o) = 0 once a dealt card hits o. At a terminal the value for h is
 *   Σ_o reach(o) × net_p(h, o)   over the o that share no card with h.
 * At p's own nodes we either follow p's strategy (value) or take the best action
 * (best response). Because the walk for h only ever sees p's information sets
 * (path, h), taking the max bottom-up is exactly a best response.
 */

/** The acting player's action probabilities at the action node reached by `path`, for one combo. */
export type StrategyFn = (path: PathStep[], comboIndex: number) => ArrayLike<number>;

/**
 * The strategy at each action node: the acting player's probabilities per hand index
 * (null for hands blocked by the node's board). Filled lazily, so a walk only asks
 * `strategyAt` about the nodes it actually visits.
 */
class StrategyTable {
  private readonly rows = new Map<OracleNode, (Float64Array | null)[]>();
  private readonly paths = new Map<OracleNode, PathStep[]>();

  constructor(
    private readonly game: OracleGame,
    private readonly strategyAt: StrategyFn,
  ) {
    forEachNode(game.root, (node, path) => {
      if (node.kind === "action") this.paths.set(node, path.slice());
    });
  }

  get(node: OracleNode): (Float64Array | null)[] {
    let rows = this.rows.get(node);
    if (!rows) {
      rows = this.compute(node);
      this.rows.set(node, rows);
    }
    return rows;
  }

  private compute(node: OracleNode): (Float64Array | null)[] {
    const path = this.paths.get(node);
    if (!path || node.kind !== "action") throw new Error("oracle: not an action node of this tree");
    const nA = node.actions!.length;
    return this.game.hands[node.player!].map((h) => {
      if (sharesCard(h.cards, node.board)) return null;
      const probs = this.strategyAt(path, h.combo);
      if (probs.length < nA) {
        throw new Error(`oracle: strategy for combo ${h.combo} has ${probs.length} entries, node has ${nA} actions`);
      }
      const row = new Float64Array(nA);
      let sum = 0;
      for (let a = 0; a < nA; a++) {
        const x = probs[a];
        if (!(x >= 0) || !Number.isFinite(x)) throw new Error(`oracle: bad probability ${x} for combo ${h.combo}`);
        row[a] = x;
        sum += x;
      }
      if (Math.abs(sum - 1) > 1e-4) {
        throw new Error(`oracle: probabilities for combo ${h.combo} sum to ${sum} at path ${JSON.stringify(path)}`);
      }
      return row;
    });
  }
}

type Mode = "value" | "best";

/**
 * Value for player p holding hand i (index into p's list) from `node` on, weighted by the
 * opponent's reach `oppReach` (indexed by the opponent's list). In "best" mode p maximizes
 * at its own nodes; in "value" mode p follows the strategy table.
 */
function walk(
  game: OracleGame,
  table: StrategyTable,
  p: Player,
  mode: Mode,
  node: OracleNode,
  i: number,
  oppReach: Float64Array,
): number {
  const opp: Player = p === 0 ? 1 : 0;
  const oppHands = game.hands[opp];

  // Nobody left for the opponent: this subtree is worth 0 to p.
  let any = false;
  for (let j = 0; j < oppReach.length; j++) if (oppReach[j] !== 0) any = true;
  if (!any) return 0;

  if (node.kind === "terminal") {
    return game.terminalValue(p, node, i, oppReach);
  }

  if (node.kind === "chance") {
    const prob = chanceProbability(node.board);
    const own = game.hands[p][i].cards;
    let v = 0;
    node.cards!.forEach((c, k) => {
      if (own.includes(c)) return; // my own card can't come
      const next = new Float64Array(oppHands.length);
      for (let j = 0; j < oppHands.length; j++) {
        next[j] = oppHands[j].cards.includes(c) ? 0 : oppReach[j] * prob;
      }
      v += walk(game, table, p, mode, node.children[k], i, next);
    });
    return v;
  }

  // Action node.
  const rows = table.get(node);
  const nA = node.actions!.length;
  if (node.player === p) {
    if (mode === "best") {
      let best = -Infinity;
      for (let a = 0; a < nA; a++) best = Math.max(best, walk(game, table, p, mode, node.children[a], i, oppReach));
      return best;
    }
    const sigma = rows[i]!;
    let v = 0;
    for (let a = 0; a < nA; a++) {
      if (sigma[a] === 0) continue;
      v += sigma[a] * walk(game, table, p, mode, node.children[a], i, oppReach);
    }
    return v;
  }
  // Opponent's node: split the opponent's reach over its actions.
  let v = 0;
  for (let a = 0; a < nA; a++) {
    const next = new Float64Array(oppHands.length);
    for (let j = 0; j < oppHands.length; j++) {
      if (oppReach[j] === 0) continue;
      const row = rows[j];
      if (!row) throw new Error("oracle: opponent hand blocked by the board still has reach");
      next[j] = oppReach[j] * row[a];
    }
    v += walk(game, table, p, mode, node.children[a], i, next);
  }
  return v;
}

/** Initial reach of the opponent of p: just the initial weights. */
function initialReach(game: OracleGame, p: Player): Float64Array {
  return Float64Array.from(game.hands[p === 0 ? 1 : 0], (h) => h.weight);
}

/** Σ_h w_p(h) × walk(root, h) / Σ_{compatible pairs} w0 w1. */
function rootAverage(game: OracleGame, table: StrategyTable, p: Player, mode: Mode): number {
  const norm = game.pairWeightSum();
  if (!(norm > 0)) throw new Error("oracle: no compatible pair of hands");
  const reach = initialReach(game, p);
  let total = 0;
  game.hands[p].forEach((h, i) => {
    total += h.weight * walk(game, table, p, mode, game.root, i, reach);
  });
  return total / norm;
}

export interface OracleBestResponseResult {
  /** Expected net of player 0 best-responding to player 1's strategy. */
  br0: number;
  /** Expected net of player 1 best-responding to player 0's strategy. */
  br1: number;
  /** (BR_0 + BR_1 − P0) / 2 / P0 × 100. */
  exploitability: number;
}

/** Best response values on an already built game (lets callers reuse the tree). */
export function bestResponseOnGame(game: OracleGame, strategyAt: StrategyFn): OracleBestResponseResult {
  const table = new StrategyTable(game, strategyAt);
  const br0 = rootAverage(game, table, 0, "best");
  const br1 = rootAverage(game, table, 1, "best");
  const P0 = game.P0;
  return { br0, br1, exploitability: ((br0 + br1 - P0) / 2 / P0) * 100 };
}

/** Each player's best response to the other's strategy, and the exploitability in % of the starting pot. */
export function oracleBestResponse(input: SolverInput, strategyAt: StrategyFn): OracleBestResponseResult {
  return bestResponseOnGame(new OracleGame(input), strategyAt);
}

/** Expected net of each player when both follow the strategy, on an already built game. */
export function valueOnGame(game: OracleGame, strategyAt: StrategyFn): [number, number] {
  const table = new StrategyTable(game, strategyAt);
  return [rootAverage(game, table, 0, "value"), rootAverage(game, table, 1, "value")];
}

/** Expected net of each player when both follow `strategyAt` (normalized like BR; the two sum to P0). */
export function oracleValue(input: SolverInput, strategyAt: StrategyFn): [number, number] {
  return valueOnGame(new OracleGame(input), strategyAt);
}

export interface OracleNodeInfo {
  /** Initial weight × own action probabilities along the path, COMBOS-indexed; 0 when blocked by the node's board. */
  ranges: [Float64Array, Float64Array];
  /**
   * Expected net per combo from this node on with both players on the strategy:
   * Σ_o reachOpp(o) × E[net | h, o] / Σ_o reachOpp(o) over the o compatible with h.
   * NaN outside the player's hand list, for combos blocked by the node's board, or with no compatible opponent reach.
   */
  ev: [Float64Array, Float64Array];
}

/**
 * Ranges and per-combo EVs at the node reached by `path` (the same quantities as
 * SolutionNode.ranges / SolutionNode.ev in docs/solver.md), for cross-checking.
 */
export function oracleNodeInfo(input: SolverInput, strategyAt: StrategyFn, path: PathStep[]): OracleNodeInfo {
  const game = new OracleGame(input);
  const target = oracleNodeAt(game.root, path);
  const table = new StrategyTable(game, strategyAt);

  // Each player's own reach per hand along the path.
  const reach = [
    Float64Array.from(game.hands[0], (h) => h.weight),
    Float64Array.from(game.hands[1], (h) => h.weight),
  ];
  let node = game.root;
  for (const step of path) {
    if (node.kind === "action") {
      const a = (step as { action: number }).action;
      const q = node.player!;
      const rows = table.get(node);
      for (let i = 0; i < reach[q].length; i++) reach[q][i] *= rows[i] ? rows[i]![a] : 0;
    } else {
      const c = (step as { card: number }).card;
      for (const q of [0, 1] as const) {
        game.hands[q].forEach((h, i) => {
          if (h.cards.includes(c)) reach[q][i] = 0;
        });
      }
    }
    node = oracleNodeAt(node, [step]);
  }

  const ranges: [Float64Array, Float64Array] = [new Float64Array(COMBOS.length), new Float64Array(COMBOS.length)];
  const ev: [Float64Array, Float64Array] = [
    new Float64Array(COMBOS.length).fill(NaN),
    new Float64Array(COMBOS.length).fill(NaN),
  ];
  for (const p of [0, 1] as const) {
    const opp: Player = p === 0 ? 1 : 0;
    game.hands[p].forEach((h, i) => {
      if (sharesCard(h.cards, target.board)) return;
      ranges[p][h.combo] = reach[p][i];
      let compatibleSum = 0;
      game.hands[opp].forEach((o, j) => {
        if (compatible(h, o)) compatibleSum += reach[opp][j];
      });
      if (!(compatibleSum > 0)) return;
      ev[p][h.combo] = walk(game, table, p, "value", target, i, reach[opp]) / compatibleSum;
    });
  }
  return { ranges, ev };
}
