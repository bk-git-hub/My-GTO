import type { Card } from "../poker/cards";
import { checkRanges, countHands } from "./hands";
import type { RiverBoard } from "./showdown";
import {
  DEFAULT_SIZES,
  type GameTreeNode,
  type MemoryEstimate,
  type Player,
  type SolverAction,
  type SolverInput,
  type SolverStreet,
  type StreetSizes,
} from "./types";

/** Street index: 0 flop, 1 turn, 2 river (= board length - 3). */
export const STREETS: SolverStreet[] = ["flop", "turn", "river"];

/** Numeric node types for the hot loops (GameNode.type). */
export const NODE_ACTION = 0;
export const NODE_CHANCE = 1;
export const NODE_FOLD = 2;
export const NODE_SHOWDOWN = 3;

/**
 * Tolerance for comparing chip amounts (docs/solver.md): amounts within EPS are equal, so a bet that
 * would leave at most EPS behind is the all-in rather than a bet leaving rounding dust.
 */
const EPS = 1e-9;

/** Resolved tree settings: defaults filled in, fractions sorted ascending. */
export interface TreeConfig {
  board: Card[];
  pot0: number;
  stack0: number;
  /** [street][player] */
  sizes: [StreetSizes, StreetSizes][];
  raiseLimit: number;
  addAllIn: boolean;
  allInThreshold: number;
  minBet: number;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** A size list, checked (finite fractions >= 0, docs/solver.md "Inputs") and sorted ascending. */
function sizeList(xs: unknown, where: string): number[] {
  if (!Array.isArray(xs)) throw new Error(`${where} must be an array of fractions`);
  for (const f of xs) {
    if (!isFiniteNumber(f) || f < 0) throw new Error(`${where}: every size must be a finite number >= 0 (got ${String(f)})`);
  }
  return [...(xs as number[])].sort((a, b) => a - b);
}

/** Checks the tree settings of an input (docs/solver.md "Inputs") and fills in the defaults. */
export function treeConfig(input: SolverInput): TreeConfig {
  if (input === null || typeof input !== "object") throw new Error("the solver input must be an object");
  if (input.board === null || typeof input.board !== "object") throw new Error("board must be an array of 3, 4 or 5 cards");
  const board = Array.from(input.board);
  if (board.length < 3 || board.length > 5) throw new Error("board must have 3, 4 or 5 cards");
  const seen = new Set<number>();
  for (const c of board) {
    if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`invalid card: ${c}`);
    if (seen.has(c)) throw new Error(`duplicate board card: ${c}`);
    seen.add(c);
  }
  if (!isFiniteNumber(input.pot) || !(input.pot > 0)) throw new Error("pot must be a finite number > 0");
  if (!isFiniteNumber(input.stack) || !(input.stack >= 0)) throw new Error("stack must be a finite number >= 0");
  const minBet = input.minBet ?? 1;
  if (!isFiniteNumber(minBet) || !(minBet > EPS)) throw new Error(`minBet must be a finite number > ${EPS}`);
  const raiseLimit = input.raiseLimit ?? 2;
  if (!Number.isInteger(raiseLimit) || raiseLimit < 0) throw new Error("raiseLimit must be an integer >= 0");
  const addAllIn = input.addAllIn ?? true;
  if (typeof addAllIn !== "boolean") throw new Error("addAllIn must be true or false");
  const allInThreshold = input.allInThreshold ?? 0.67;
  if (!isFiniteNumber(allInThreshold) || !(allInThreshold > 0)) throw new Error("allInThreshold must be a finite number > 0");
  if (input.sizes !== undefined && (input.sizes === null || typeof input.sizes !== "object"))
    throw new Error("sizes must be an object with optional flop, turn and river entries");
  const sizes = STREETS.map((st) => {
    const s = input.sizes?.[st] ?? DEFAULT_SIZES;
    if (!Array.isArray(s) || s.length !== 2) throw new Error(`sizes.${st} must be [OOP sizes, IP sizes]`);
    return s.map((ps: StreetSizes, p) => {
      if (ps === null || typeof ps !== "object") throw new Error(`sizes.${st}[${p}] must be {bet, raise}`);
      return { bet: sizeList(ps.bet, `sizes.${st}[${p}].bet`), raise: sizeList(ps.raise, `sizes.${st}[${p}].raise`) };
    }) as [StreetSizes, StreetSizes];
  });
  return {
    board,
    pot0: input.pot,
    // A stack within EPS of 0 is 0, so every stack in the tree is exactly 0 or more than EPS.
    stack0: input.stack <= EPS ? 0 : input.stack,
    sizes,
    raiseLimit,
    addAllIn,
    allInThreshold,
    minBet,
  };
}

/** Betting state at an action node. */
export interface BetState {
  street: number;
  board: Card[];
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  player: Player;
  /** Bets and raises made on this street. */
  n: number;
  /** Last raise increment. */
  inc: number;
}

/** Raise amounts in labels: rounded to 0.1, no trailing ".0" (15.75 -> "15.8", 10 -> "10"). */
const fmtRaise = (x: number) => String(Math.round(x * 10) / 10);
/** A bet raised to minBet: the amount to 0.01, no trailing zeros (1.25 -> "1.25", 1.5 -> "1.5", 1 -> "1"). */
const fmtBet = (x: number) => String(Math.round(x * 100) / 100);

/** The actions at an action node, in the order and with the merging rules of docs/solver.md. */
export function legalActions(cfg: TreeConfig, st: BetState): SolverAction[] {
  const i = st.player;
  const myBet = st.bets[i];
  const maxBet = Math.max(st.bets[0], st.bets[1]);
  const stack = st.stacks[i];
  const oppStack = st.stacks[1 - i];
  const sz = cfg.sizes[st.street][i];
  const thr = cfg.allInThreshold;
  const toCall = maxBet - myBet;
  const out: SolverAction[] = [];
  let allin = false;

  if (toCall <= EPS) {
    out.push({ kind: "check", to: 0, label: "체크" });
    for (const f of sz.bet) {
      const raw = f * st.pot;
      const amount = Math.max(cfg.minBet, raw);
      if (amount >= thr * stack - EPS || amount >= stack - EPS) allin = true;
      else {
        const label = raw < cfg.minBet ? `벳 ${fmtBet(amount)}` : `벳 ${Math.round(f * 100)}%`;
        out.push({ kind: "bet", to: myBet + amount, label });
      }
    }
    if (cfg.addAllIn && stack > 0) allin = true;
  } else {
    out.push({ kind: "fold", to: 0, label: "폴드" });
    out.push({ kind: "call", to: maxBet, label: "콜" });
    if (st.n <= cfg.raiseLimit && stack > toCall + EPS && oppStack > 0) {
      for (const f of sz.raise) {
        // Raise to: call first, then f × the pot after calling; at least a minimum raise.
        const to = Math.max(myBet + toCall + f * (st.pot + toCall), maxBet + st.inc);
        if (to - myBet >= thr * stack - EPS || to - myBet >= stack - EPS) allin = true;
        else out.push({ kind: "raise", to, label: `레이즈 ${fmtRaise(to)}` });
      }
      if (cfg.addAllIn) allin = true;
    }
  }
  if (allin) out.push({ kind: "allin", to: myBet + stack, label: "올인" });

  // Merge duplicates (same kind and amount), keeping the first.
  const merged: SolverAction[] = [];
  for (const a of out) {
    let dup = false;
    for (const b of merged) if (b.kind === a.kind && Math.abs(b.to - a.to) <= EPS) dup = true;
    if (!dup) merged.push(a);
  }
  return merged;
}

/** What follows an action: a fold, the end of the street, or the opponent's turn. */
type Next =
  | { type: "fold"; folder: Player }
  | { type: "street-end"; state: BetState }
  | { type: "act"; state: BetState };

export function applyAction(st: BetState, a: SolverAction): Next {
  const i = st.player;
  const o = (1 - i) as Player;
  if (a.kind === "fold") return { type: "fold", folder: i };
  if (a.kind === "check") {
    if (i === 0) return { type: "act", state: { ...st, player: 1 } };
    return { type: "street-end", state: st };
  }
  const maxBet = Math.max(st.bets[0], st.bets[1]);
  const bets: [number, number] = [st.bets[0], st.bets[1]];
  const stacks: [number, number] = [st.stacks[0], st.stacks[1]];
  const add = a.to - bets[i];
  bets[i] = a.to;
  if (a.kind === "call") {
    // Equal stacks: after a call both players have the same chips behind.
    stacks[i] = stacks[o];
    return { type: "street-end", state: { ...st, pot: st.pot + add, bets, stacks } };
  }
  // A bet or raise that isn't the all-in leaves more than EPS behind, so stacks are 0 only after an all-in.
  stacks[i] = a.kind === "allin" ? 0 : stacks[i] - add;
  return {
    type: "act",
    state: {
      ...st,
      pot: st.pot + add,
      bets,
      stacks,
      player: o,
      n: st.n + 1,
      inc: Math.max(st.inc, a.to - maxBet),
    },
  };
}

/**
 * A game tree node. It implements the public GameTreeNode shape and carries the solver's
 * per-node bookkeeping (all fields set in the constructor so V8 keeps one hidden class).
 */
export class GameNode implements GameTreeNode {
  kind: "action" | "chance" | "terminal";
  /** NODE_ACTION, NODE_CHANCE, NODE_FOLD or NODE_SHOWDOWN. */
  type: number;
  street: SolverStreet;
  board: Card[];
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  player: Player | undefined = undefined;
  actions: SolverAction[] | undefined = undefined;
  cards: Card[] | undefined = undefined;
  terminal: "fold" | "showdown" | undefined = undefined;
  folder: Player | undefined = undefined;
  children: GameNode[];
  /** Distance from the root (indexes the solver's scratch buffers). */
  depth: number;
  /**
   * Terminal: chips put in over the whole solve. Fold: by the folder, x_f (folder nets -x_f, the
   * winner P0 + x_f). Showdown: by each player, x (winner P0 + x, loser -x, tie P0 / 2).
   */
  invested = 0;
  /** Action node: offset of this node's block in the solver's regret / strategy-sum arrays. */
  off = 0;
  /** Action node: last iteration whose discount has been applied to this node's storage. */
  lastT = 0;
  /** Showdown: the cached strength order for this river board (set by the solver). */
  river: RiverBoard | null = null;

  constructor(type: number, board: Card[], pot: number, bets: [number, number], stacks: [number, number], depth: number) {
    this.type = type;
    this.kind = type === NODE_ACTION ? "action" : type === NODE_CHANCE ? "chance" : "terminal";
    this.street = STREETS[board.length - 3];
    this.board = board;
    this.pot = pot;
    this.bets = bets;
    this.stacks = stacks;
    this.depth = depth;
    this.children = type === NODE_FOLD || type === NODE_SHOWDOWN ? NO_CHILDREN : [];
  }

  /** Fold terminal: player p's net, given the starting pot. */
  foldNet(p: number, pot0: number): number {
    return p === this.folder ? 0 - this.invested : pot0 + this.invested;
  }
}

/** Shared (never modified) children list of every terminal, to save memory on big trees. */
const NO_CHILDREN: GameNode[] = [];

/** A built tree with the sizes the solver needs to preallocate. */
export interface BuiltTree {
  root: GameNode;
  actionNodes: GameNode[];
  showdownNodes: GameNode[];
  chanceCount: number;
  terminalCount: number;
  maxDepth: number;
  maxActions: number;
}

class Builder {
  actionNodes: GameNode[] = [];
  showdownNodes: GameNode[] = [];
  chanceCount = 0;
  terminalCount = 0;
  maxDepth = 0;
  maxActions = 1;
  /** Identical betting states (e.g. the same river line under different cards) share one action list. */
  private actionCache = new Map<string, SolverAction[]>();

  constructor(private cfg: TreeConfig) {}

  root(): GameNode {
    const { board, pot0, stack0 } = this.cfg;
    const st: BetState = {
      street: board.length - 3,
      board,
      pot: pot0,
      bets: [0, 0],
      stacks: [stack0, stack0],
      player: 0,
      n: 0,
      inc: 0,
    };
    if (stack0 <= 0) return this.runout(board, pot0, [0, 0], [0, 0], 0);
    return this.action(st, 0);
  }

  private actionsFor(st: BetState): SolverAction[] {
    const key = `${st.street}|${st.player}|${st.pot}|${st.bets[0]}|${st.bets[1]}|${st.stacks[0]}|${st.stacks[1]}|${st.n}|${st.inc}`;
    let acts = this.actionCache.get(key);
    if (!acts) {
      // Shared by every node with this betting state, so frozen: a caller can't change one node's
      // menu (or the solver's) by writing into another's.
      acts = Object.freeze(legalActions(this.cfg, st).map((a) => Object.freeze(a))) as SolverAction[];
      this.actionCache.set(key, acts);
    }
    return acts;
  }

  private action(st: BetState, depth: number): GameNode {
    this.maxDepth = Math.max(this.maxDepth, depth);
    const node = new GameNode(NODE_ACTION, st.board, st.pot, st.bets, st.stacks, depth);
    node.player = st.player;
    node.actions = this.actionsFor(st);
    this.maxActions = Math.max(this.maxActions, node.actions.length);
    this.actionNodes.push(node);
    for (const a of node.actions) {
      const next = applyAction(st, a);
      if (next.type === "fold") node.children.push(this.fold(st, next.folder, depth + 1));
      else if (next.type === "act") node.children.push(this.action(next.state, depth + 1));
      else node.children.push(this.streetEnd(next.state, depth + 1));
    }
    return node;
  }

  private fold(st: BetState, folder: Player, depth: number): GameNode {
    this.maxDepth = Math.max(this.maxDepth, depth);
    this.terminalCount++;
    const node = new GameNode(NODE_FOLD, st.board, st.pot, st.bets, st.stacks, depth);
    node.terminal = "fold";
    node.folder = folder;
    // The folder loses what they put in; the winner nets the starting pot plus that.
    node.invested = this.cfg.stack0 - st.stacks[folder];
    return node;
  }

  private showdown(board: Card[], pot: number, bets: [number, number], stacks: [number, number], depth: number): GameNode {
    this.maxDepth = Math.max(this.maxDepth, depth);
    this.terminalCount++;
    const node = new GameNode(NODE_SHOWDOWN, board, pot, bets, stacks, depth);
    node.terminal = "showdown";
    node.invested = this.cfg.stack0 - stacks[0];
    this.showdownNodes.push(node);
    return node;
  }

  private chance(board: Card[], pot: number, bets: [number, number], stacks: [number, number], depth: number,
    child: (board: Card[]) => GameNode): GameNode {
    this.maxDepth = Math.max(this.maxDepth, depth);
    this.chanceCount++;
    const node = new GameNode(NODE_CHANCE, board, pot, bets, stacks, depth);
    node.cards = remainingCards(board);
    for (const c of node.cards) node.children.push(child([...board, c]));
    return node;
  }

  /** Both players all-in: deal the rest of the board with no actions, then show down. */
  private runout(board: Card[], pot: number, bets: [number, number], stacks: [number, number], depth: number): GameNode {
    if (board.length === 5) return this.showdown(board, pot, bets, stacks, depth);
    return this.chance(board, pot, bets, stacks, depth, (b) => this.runout(b, pot, [0, 0], stacks, depth + 1));
  }

  private streetEnd(st: BetState, depth: number): GameNode {
    if (st.stacks[0] === 0 && st.stacks[1] === 0) return this.runout(st.board, st.pot, st.bets, st.stacks, depth);
    if (st.board.length === 5) return this.showdown(st.board, st.pot, st.bets, st.stacks, depth);
    return this.chance(st.board, st.pot, st.bets, st.stacks, depth, (b) =>
      this.action(
        { street: st.street + 1, board: b, pot: st.pot, bets: [0, 0], stacks: st.stacks, player: 0, n: 0, inc: 0 },
        depth + 1,
      ),
    );
  }
}

/** Cards not on the board, ascending. */
export function remainingCards(board: Card[]): Card[] {
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) if (!board.includes(c)) out.push(c);
  return out;
}

/** Build the full tree with the bookkeeping the solver needs (`cfg`: the input's treeConfig, if already made). */
export function buildGameTree(input: SolverInput, cfg: TreeConfig = treeConfig(input)): BuiltTree {
  const b = new Builder(cfg);
  const root = b.root();
  return {
    root,
    actionNodes: b.actionNodes,
    showdownNodes: b.showdownNodes,
    chanceCount: b.chanceCount,
    terminalCount: b.terminalCount,
    maxDepth: b.maxDepth,
    maxActions: b.maxActions,
  };
}

/**
 * The game tree for a spot (for tests and the UI), without solving. Read-only: nodes share arrays
 * (an action list with every node of the same betting state, boards, bets and stacks with their
 * neighbours). Action lists and their actions are frozen.
 */
export function buildTree(input: SolverInput): GameNode {
  return buildGameTree(input).root;
}

// ---------------------------------------------------------------------------------------------
// Counting without building (estimateMemory)

interface Counts {
  action: number;
  chance: number;
  terminal: number;
  /** Σ over each player's action nodes of the number of actions. */
  slots: [number, number];
  maxDepth: number;
  maxActions: number;
}

/**
 * Count the tree under a betting state. The subtree under a chance node has the same shape for every
 * card, so we count one child and multiply by the number of cards (`mult` = how many copies).
 */
function countAction(cfg: TreeConfig, st: BetState, depth: number, mult: number, c: Counts): void {
  c.maxDepth = Math.max(c.maxDepth, depth);
  const acts = legalActions(cfg, st);
  c.action += mult;
  c.slots[st.player] += mult * acts.length;
  c.maxActions = Math.max(c.maxActions, acts.length);
  for (const a of acts) {
    const next = applyAction(st, a);
    if (next.type === "fold") {
      c.terminal += mult;
      c.maxDepth = Math.max(c.maxDepth, depth + 1);
    } else if (next.type === "act") countAction(cfg, next.state, depth + 1, mult, c);
    else countStreetEnd(cfg, next.state, depth + 1, mult, c);
  }
}

function countRunout(boardLen: number, depth: number, mult: number, c: Counts): void {
  c.maxDepth = Math.max(c.maxDepth, depth);
  if (boardLen === 5) {
    c.terminal += mult;
    return;
  }
  c.chance += mult;
  countRunout(boardLen + 1, depth + 1, mult * (52 - boardLen), c);
}

function countStreetEnd(cfg: TreeConfig, st: BetState, depth: number, mult: number, c: Counts): void {
  const len = st.board.length;
  if (st.stacks[0] === 0 && st.stacks[1] === 0) return countRunout(len, depth, mult, c);
  c.maxDepth = Math.max(c.maxDepth, depth);
  if (len === 5) {
    c.terminal += mult;
    return;
  }
  c.chance += mult;
  // The next street's state doesn't depend on which card came; a placeholder board of the right length will do.
  const board = [...st.board, -1];
  countAction(
    cfg,
    { street: st.street + 1, board, pot: st.pot, bets: [0, 0], stacks: st.stacks, player: 0, n: 0, inc: 0 },
    depth + 1,
    mult * (52 - len),
    c,
  );
}

/**
 * Tree overhead per node in bytes, measured in V8 (Node 22): the node object with its boxed numbers,
 * its bets / stacks / children arrays; a chance node also holds a card list and one board per child.
 */
const ACTION_NODE_BYTES = 440;
const CHANCE_NODE_BYTES = 600;
const CHANCE_CARD_BYTES = 64;
const TERMINAL_NODE_BYTES = 330;

/**
 * Node counts and a byte estimate for solving this spot, without allocating any per-hand arrays.
 * Bytes = regret + strategy-sum storage (2 × 4 bytes per action per hand of the acting player)
 * + tree objects + the showdown strength cache + per-depth scratch.
 */
export function estimateMemory(input: SolverInput): MemoryEstimate {
  const cfg = treeConfig(input);
  checkRanges(input.ranges);
  const c: Counts = { action: 0, chance: 0, terminal: 0, slots: [0, 0], maxDepth: 0, maxActions: 1 };
  const len = cfg.board.length;
  if (cfg.stack0 <= 0) countRunout(len, 0, 1, c);
  else
    countAction(cfg, { street: len - 3, board: cfg.board, pot: cfg.pot0, bets: [0, 0], stacks: [cfg.stack0, cfg.stack0], player: 0, n: 0, inc: 0 }, 0, 1, c);

  const n0 = countHands(cfg.board, input.ranges[0]);
  const n1 = countHands(cfg.board, input.ranges[1]);
  const nMax = Math.max(n0, n1, 1);
  const storage = 8 * (c.slots[0] * n0 + c.slots[1] * n1);
  // Chance children: 52 - board length cards per chance node, on average close to 48.
  const chanceCards = len === 3 ? 48.5 : 48;
  const tree =
    c.action * ACTION_NODE_BYTES + c.chance * (CHANCE_NODE_BYTES + CHANCE_CARD_BYTES * chanceCards) + c.terminal * TERMINAL_NODE_BYTES;
  // One strength order per distinct river board: 1 (river), 48 (turn), C(49, 2) (flop); 12 bytes per hand.
  const riverBoards = len === 5 ? 1 : len === 4 ? 48 : 1176;
  const cache = riverBoards * (n0 + n1) * 12;
  const scratch = (c.maxDepth + 2) * (4 + 2 * c.maxActions) * nMax * 8;
  const hands = (n0 + n1) * 64 + 2 * 1326 * 4;
  return {
    bytes: Math.round(storage + tree + cache + scratch + hands),
    actionNodes: c.action,
    chanceNodes: c.chance,
    terminalNodes: c.terminal,
  };
}
