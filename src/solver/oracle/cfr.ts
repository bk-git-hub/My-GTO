import type { PathStep, Player, SolverInput } from "../types";
import { bestResponseOnGame, valueOnGame, type StrategyFn } from "./bestResponse";
import { chanceProbability, OracleGame, sharesCard } from "./game";
import { forEachNode, oracleNodeAt, pathKey, type OracleNode } from "./tree";

/**
 * Plain scalar CFR+ for small spots, over explicit information sets.
 *
 * An information set is (path from the root including dealt cards, own combo). They live
 * in a dictionary keyed by `${pathKey(path)}|${combo}`. Each iteration updates player 0,
 * then player 1 (alternating updates). For the updating player p and each of p's hands h
 * we walk the tree carrying the opponent's reach per opponent hand, exactly like the best
 * response code, and at p's nodes:
 *   σ = regret matching (positive regrets normalized, uniform if none),
 *   v_a = value of child a,  v = Σ σ_a v_a,
 *   regret_a = max(0, regret_a + v_a − v)          (CFR+ floors regrets at 0)
 *   strategySum_a += t × ownReach × σ_a            (linear averaging)
 * The answer is the normalized strategySum (uniform where it is all 0).
 */

interface InfoSet {
  regret: Float64Array;
  strategySum: Float64Array;
  /** Current strategy, refreshed for the opponent's sets before each pass. */
  current: Float64Array;
}

function regretMatching(regret: Float64Array, out: Float64Array): Float64Array {
  let pos = 0;
  for (let a = 0; a < regret.length; a++) if (regret[a] > 0) pos += regret[a];
  for (let a = 0; a < regret.length; a++) out[a] = pos > 0 ? Math.max(regret[a], 0) / pos : 1 / regret.length;
  return out;
}

function averageOf(set: InfoSet): Float64Array {
  const n = set.strategySum.length;
  const out = new Float64Array(n);
  let sum = 0;
  for (let a = 0; a < n; a++) sum += set.strategySum[a];
  for (let a = 0; a < n; a++) out[a] = sum > 0 ? set.strategySum[a] / sum : 1 / n;
  return out;
}

export interface OracleCfr {
  readonly game: OracleGame;
  /** Iterations done so far. */
  readonly iteration: number;
  /** Run n more iterations. */
  iterate(n: number): void;
  /** Average strategy of the acting player at the action node reached by `path` (zeros for combos not in that player's list or blocked by the board). */
  strategyAt: StrategyFn;
  /** Exploitability (% of pot) of the current average strategy, by the oracle's best response. */
  exploitability(): number;
}

export function createOracleCfr(input: SolverInput): OracleCfr {
  const game = new OracleGame(input);
  const dict = new Map<string, InfoSet>();
  /** Per action node, its information sets by hand index of the acting player (null if blocked by the board). */
  const setsAt = new Map<OracleNode, (InfoSet | null)[]>();
  /** All information sets per player, to refresh current strategies. */
  const setsOf: [InfoSet[], InfoSet[]] = [[], []];

  forEachNode(game.root, (node, path) => {
    if (node.kind !== "action") return;
    const nA = node.actions!.length;
    const q = node.player!;
    const key = pathKey(path);
    const sets = game.hands[q].map((h) => {
      if (sharesCard(h.cards, node.board)) return null;
      const set: InfoSet = {
        regret: new Float64Array(nA),
        strategySum: new Float64Array(nA),
        current: new Float64Array(nA).fill(1 / nA),
      };
      dict.set(`${key}|${h.combo}`, set);
      setsOf[q].push(set);
      return set;
    });
    setsAt.set(node, sets);
  });

  let t = 0;

  /** Counterfactual value for p holding hand i, from `node` on, against opponent reach `oppReach`. */
  function cfr(p: Player, node: OracleNode, i: number, ownReach: number, oppReach: Float64Array): number {
    const opp: Player = p === 0 ? 1 : 0;
    const oppHands = game.hands[opp];

    if (node.kind === "terminal") {
      return game.terminalValue(p, node, i, oppReach);
    }

    if (node.kind === "chance") {
      const prob = chanceProbability(node.board);
      const own = game.hands[p][i].cards;
      let v = 0;
      node.cards!.forEach((c, k) => {
        if (own.includes(c)) return;
        const next = new Float64Array(oppHands.length);
        for (let j = 0; j < oppHands.length; j++) next[j] = oppHands[j].cards.includes(c) ? 0 : oppReach[j] * prob;
        v += cfr(p, node.children[k], i, ownReach, next);
      });
      return v;
    }

    const nA = node.actions!.length;
    const sets = setsAt.get(node)!;
    if (node.player === p) {
      const set = sets[i]!;
      const sigma = regretMatching(set.regret, new Float64Array(nA));
      const values = new Float64Array(nA);
      let v = 0;
      for (let a = 0; a < nA; a++) {
        values[a] = cfr(p, node.children[a], i, ownReach * sigma[a], oppReach);
        v += sigma[a] * values[a];
      }
      for (let a = 0; a < nA; a++) {
        set.regret[a] = Math.max(0, set.regret[a] + values[a] - v);
        set.strategySum[a] += t * ownReach * sigma[a];
      }
      return v;
    }

    // Opponent's node: the opponent plays its current strategy (fixed during this pass).
    let v = 0;
    for (let a = 0; a < nA; a++) {
      const next = new Float64Array(oppHands.length);
      for (let j = 0; j < oppHands.length; j++) {
        if (oppReach[j] === 0) continue;
        next[j] = oppReach[j] * sets[j]!.current[a];
      }
      v += cfr(p, node.children[a], i, ownReach, next);
    }
    return v;
  }

  function iterate(n: number) {
    for (let k = 0; k < n; k++) {
      t++;
      for (const p of [0, 1] as const) {
        const opp: Player = p === 0 ? 1 : 0;
        for (const set of setsOf[opp]) regretMatching(set.regret, set.current);
        const oppWeights = Float64Array.from(game.hands[opp], (h) => h.weight);
        for (let i = 0; i < game.hands[p].length; i++) cfr(p, game.root, i, 1, oppWeights);
      }
    }
  }

  const strategyAt: StrategyFn = (path: PathStep[], comboIndex: number) => {
    const node = oracleNodeAt(game.root, path);
    if (node.kind !== "action") throw new Error("oracle: strategyAt needs an action node");
    const set = dict.get(`${pathKey(path)}|${comboIndex}`);
    if (!set) return new Float64Array(node.actions!.length);
    return averageOf(set);
  };

  return {
    game,
    get iteration() {
      return t;
    },
    iterate,
    strategyAt,
    exploitability: () => bestResponseOnGame(game, strategyAt).exploitability,
  };
}

export interface OracleSolveResult {
  /** Average strategy, same signature as the best-response input. */
  strategyAt: StrategyFn;
  /** % of the starting pot. */
  exploitability: number;
  /** Expected net of player 0 with both players on the average strategy. */
  value0: number;
  iterations: number;
}

/** Run `iterations` CFR+ iterations and report the average strategy, its exploitability and player 0's value. */
export function oracleSolve(input: SolverInput, iterations: number): OracleSolveResult {
  const solver = createOracleCfr(input);
  solver.iterate(iterations);
  const exploitability = solver.exploitability();
  const [value0] = valueOnGame(solver.game, solver.strategyAt);
  return { strategyAt: solver.strategyAt, exploitability, value0, iterations };
}
