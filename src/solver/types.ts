import type { Card } from "../poker/cards";

/**
 * Contract for the heads-up postflop solver (see docs/solver.md).
 *
 * Units: everything is in big blinds. "Net" values are a player's chips at the end
 * minus their chips at the start of the solve; the starting pot belongs to nobody,
 * so the two players' nets always sum to `pot`.
 *
 * Ranges are weights (0..1) indexed like `COMBOS` in src/play/handInfo.ts (1326 combos).
 */

/** 0 = OOP (acts first after the flop), 1 = IP. */
export type Player = 0 | 1;
export type SolverStreet = "flop" | "turn" | "river";

/** Bet sizes for one player on one street. */
export interface StreetSizes {
  /** Opening bets when nobody has bet on this street yet, as fractions of the pot (0.33 = a third of the pot). */
  bet: number[];
  /**
   * Raises, as fractions of the pot after calling: raising "to" = myStreetBet + toCall + f * (pot + toCall),
   * where pot includes every chip already in the middle (this street's bets too). f = 1 is a pot-sized raise.
   */
  raise: number[];
}

export interface SolverInput {
  /** 3, 4 or 5 cards. The solve starts at the beginning of the street this board implies, OOP to act. */
  board: Card[];
  /**
   * [OOP, IP] weights per COMBOS index: at most 1326 numbers in [0, 1] each (entries past the end are 0;
   * NaN, negative or > 1 throws). Combos that share a card with the board are ignored.
   */
  ranges: [ArrayLike<number>, ArrayLike<number>];
  /** Chips in the middle at the start (bb), finite and > 0. */
  pot: number;
  /** Effective stack behind for both players at the start (bb), finite and >= 0; at most 1e-9 counts as 0. */
  stack: number;
  /** Sizes per street, [OOP, IP]. A street without an entry uses DEFAULT_SIZES. Sizes are finite numbers >= 0. */
  sizes?: Partial<Record<SolverStreet, [StreetSizes, StreetSizes]>>;
  /** Raises allowed after the first bet on a street (2 = bet, raise, re-raise, then call or fold). An integer >= 0. Default 2. */
  raiseLimit?: number;
  /** Offer all-in whenever chips remain. Default true. */
  addAllIn?: boolean;
  /**
   * A bet or raise that would put in at least this share of the remaining stack becomes all-in. A finite
   * number > 0 (above 1 it never applies; a bet of the whole stack is the all-in anyway). Default 0.67.
   */
  allInThreshold?: number;
  /** Smallest opening bet (bb), finite and > 1e-9. Default 1. Raises follow no-limit rules (at least the last raise increment). */
  minBet?: number;
}

export const DEFAULT_SIZES: [StreetSizes, StreetSizes] = [
  { bet: [0.33, 0.75], raise: [0.75] },
  { bet: [0.33, 0.75], raise: [0.75] },
];

export interface SolveOptions {
  /** Hard cap on iterations, a number >= 0 rounded down (Infinity: until the target or onProgress stops it). Default 1000. */
  iterations?: number;
  /** Stop once exploitability (% of pot) is at or below this. Default 0.5. */
  targetExploitability?: number;
  /** Measure exploitability every this many iterations, a number > 0 rounded down to at least 1. Default 25. */
  checkEvery?: number;
  /** Called after each exploitability check. Return false to stop early. */
  onProgress?: (p: { iteration: number; exploitability: number }) => boolean | void;
}

export type ActionKind = "fold" | "check" | "call" | "bet" | "raise" | "allin";

export interface SolverAction {
  kind: ActionKind;
  /** This player's total bet on the street after the action (bb). 0 for fold and check. */
  to: number;
  /** Short label, e.g. "체크", "벳 33%", "레이즈 9.5", "올인". */
  label: string;
}

/**
 * A step from a node: an action index at an action node, or the card dealt at a chance node (any card that
 * can come). Exactly one of the two keys, with an integer value; anything else makes node() throw.
 */
export type PathStep = { action: number } | { card: Card };

/**
 * One node of a solution. node() returns the same cached object for the same path: it and its plain
 * arrays are frozen, and its typed arrays (strategy, ranges, ev) are shared with later calls, so treat
 * them as read-only and copy before changing them.
 */
export interface SolutionNode {
  kind: "action" | "chance" | "terminal";
  street: SolverStreet;
  board: Card[];
  /** Total chips in the middle at this node, this street's bets included. */
  pot: number;
  /** Each player's bet on the current street. */
  bets: [number, number];
  /** Each player's chips behind. */
  stacks: [number, number];
  /** Action node: who acts and what they can do. */
  player?: Player;
  actions?: SolverAction[];
  /** Action node: average strategy, one array per action, COMBOS-indexed (0 where the combo isn't in range). */
  strategy?: Float32Array[];
  /** Chance node: the cards that can come. */
  cards?: Card[];
  /** Terminal node: how the hand ended. */
  terminal?: "fold" | "showdown";
  /** Range weights of each player reaching this node, COMBOS-indexed (initial weight × probability of the actions taken). */
  ranges: [Float32Array, Float32Array];
  /**
   * Expected net (bb) per combo for each player from this node on, both playing the average strategy,
   * normalized by the opponent's compatible reach (NaN where the combo can't be here).
   */
  ev: [Float32Array, Float32Array];
}

export interface Solution {
  iterations: number;
  /** % of the starting pot. */
  exploitability: number;
  /** The node reached by following `path` from the root. Throws on an illegal path. */
  node(path: PathStep[]): SolutionNode;
}

/** Size of a spot before solving it (see `estimateMemory`). */
export interface MemoryEstimate {
  /** Rough total bytes the solver will hold: per-node strategy storage, tree objects, caches and scratch. */
  bytes: number;
  actionNodes: number;
  chanceNodes: number;
  terminalNodes: number;
}

/** Incremental solver (`createSolver`): run a few iterations at a time so a Web Worker stays responsive. */
export interface IncrementalSolver {
  /** Run floor(n) more DCFR iterations (each one updates OOP, then IP); n must be a finite number >= 0. */
  iterate(n: number): void;
  /** Iterations run so far. */
  readonly iteration: number;
  /** Current exploitability, % of the starting pot (cached until the next iterate()). */
  exploitability(): number;
  /** A view of the current average strategy. It goes stale (its node() throws) after the next iterate(). */
  solution(): Solution;
}

/**
 * One node of the game tree as built by `buildTree` (no strategy data). Read-only: nodes share arrays with
 * each other, and action lists (shared by every node with the same betting state) are frozen.
 */
export interface GameTreeNode {
  kind: "action" | "chance" | "terminal";
  street: SolverStreet;
  /** The board at this node. At a chance node it is the board before the card is dealt. */
  board: Card[];
  /** Total chips in the middle, this street's bets included. */
  pot: number;
  /** Each player's bet on the current street (at a chance node or terminal: as the street ended). */
  bets: [number, number];
  stacks: [number, number];
  /** Action node: who acts and what they can do (`children[i]` follows `actions[i]`). */
  player?: Player;
  actions?: SolverAction[];
  /** Chance node: the cards that can come, ascending (`children[i]` follows `cards[i]`). */
  cards?: Card[];
  /** Terminal node: how the hand ended. */
  terminal?: "fold" | "showdown";
  /** Fold terminal: who folded. */
  folder?: Player;
  /** One child per action (action node) or per card (chance node); empty at a terminal. */
  children: GameTreeNode[];
}
