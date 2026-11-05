import type { Card } from "../poker/cards";
import { checkRanges, countHands } from "./hands";
import { cardOrbits, dealCounts, IDENTITY, stabilizer, symmetryGroup } from "./iso";
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
  /** 16-bit storage of regrets and strategy sums (the solver's, not the tree's; checked here with the rest). */
  compress: boolean;
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
  const compress = input.compress ?? false;
  if (typeof compress !== "boolean") throw new Error("compress must be true or false");
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
    compress,
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

/** Everything legalActions reads from a betting state: equal keys, equal action lists. */
function stateKey(st: BetState): string {
  return `${st.street}|${st.player}|${st.pot}|${st.bets[0]}|${st.bets[1]}|${st.stacks[0]}|${st.stacks[1]}|${st.n}|${st.inc}`;
}

// ---------------------------------------------------------------------------------------------
// The packed tree

/**
 * The game tree, packed into a few typed arrays instead of one object per node: a flop tree has about
 * a million nodes, two thirds of them terminals, and as objects they took about 400 bytes each.
 *
 * Nodes are ids: the root is 0, and the children of a node are the consecutive ids from `child[id]`
 * (in action order, or in the order of `cards[board[id]]` at a chance node). Each node has a board
 * (an id into `boards`) and a descriptor (`desc`) that holds everything else: the node type, the
 * player, pot, bets, stacks, chips invested and the action list. Nodes that differ only in the cards
 * dealt (one river line under every turn and river card) share a descriptor, so a node costs 10 bytes
 * here whatever its type.
 *
 * The descriptors are the nodes of the betting skeleton: the tree built from the rules (legalActions,
 * applyAction) with every chance node collapsed to one child. The packed tree repeats that child for
 * each card that can come.
 *
 * With a symmetry group (suit permutations under which the board and both ranges are invariant, see
 * iso.ts and docs/solver.md "Suit isomorphism") a chance node gets a child only for one card per orbit
 * of the group that is left on its board (`cards[b]` lists those representatives, `members[b]` the other
 * cards of each orbit and the permutation that maps the representative to them). buildTree always builds
 * the full tree (identity group); the solver builds the reduced one.
 */
export class PackedTree {
  /** Number of nodes. */
  readonly size: number;
  /** Per node: its descriptor. */
  readonly desc: Int32Array;
  /** Per node: its board, an index into `boards`. */
  readonly board: Uint16Array;
  /** Per node: the id of its first child (the others follow it); -1 at a terminal. */
  readonly child: Int32Array;

  /** Per descriptor: NODE_ACTION, NODE_CHANCE, NODE_FOLD or NODE_SHOWDOWN. */
  readonly dType: Uint8Array;
  /**
   * Per descriptor: the number of children (actions, or cards that can come; 0 at a terminal). A chance node of
   * a tree with a symmetry group has fewer children (`cards[board]`): use numChildren(id).
   */
  readonly dNum: Int32Array;
  /** Per descriptor: the player to act (action node) or the player who folded (fold); -1 otherwise. */
  readonly dPlayer: Int8Array;
  /** Per descriptor: the pot, and bets and stacks at [2 × desc + player]. */
  readonly dPot: Float64Array;
  readonly dBets: Float64Array;
  readonly dStacks: Float64Array;
  /**
   * Per descriptor, at a terminal: chips put in over the whole solve. Fold: by the folder, x_f (the folder
   * nets -x_f, the winner P0 + x_f). Showdown: by each player, x (winner P0 + x, loser -x, tie P0 / 2).
   */
  readonly dInvested: Float64Array;
  /** Per descriptor, at an action node: its actions, frozen (shared by every node with the same betting state). */
  readonly dActions: (SolverAction[] | undefined)[];

  /** Board id -> its cards (frozen). Id 0 is the starting board; boards are ordered as dealt. */
  readonly boards: Card[][];
  /**
   * Board id -> the cards dealt at a chance node on it, ascending (frozen): every card that can come, or with a
   * symmetry group one representative per orbit (the smallest card of each).
   */
  readonly cards: (Card[] | undefined)[] = [];
  /**
   * The symmetry group of the spot (suit permutation indices, see iso.ts; [IDENTITY] for the full tree), and
   * per board id the part of it that fixes every card dealt since the start: the permutations under which
   * the subtrees on that board are symmetric. Identical groups are the same array.
   */
  readonly group: readonly number[];
  readonly boardGroup: (readonly number[])[];
  /**
   * Board id -> for a chance node on it with a symmetry group: the cards that get no child of their own. The
   * orbit of cards[b][k] is that card plus card[start[k]..start[k+1]); perm[j] (a suit permutation of
   * boardGroup[b]) maps cards[b][k] to card[j], and the subtree under card[j] is the image of the subtree
   * under cards[b][k] by that permutation. Undefined when every card is its own representative.
   */
  readonly members: ({ start: Int32Array; card: Uint8Array; perm: Uint8Array } | undefined)[];

  readonly actionCount: number;
  readonly chanceCount: number;
  readonly terminalCount: number;
  /** Largest distance from the root (the solver keeps scratch buffers per depth). */
  readonly maxDepth: number;
  /** Most actions at one node. */
  readonly maxActions: number;

  private readonly boardIds = new Map<number, number>();
  /** members while the tree is built (made dense at the end, so the solver never reads past its end). */
  private readonly orbitTables: ({ start: Int32Array; card: Uint8Array; perm: Uint8Array } | undefined)[] = [];
  /** Subgroups by their elements, so equal groups share one array. */
  private readonly groups = new Map<string, readonly number[]>();
  // Frozen [b0, b1] arrays per descriptor for the GameNode views, made on first use.
  private readonly betsView: ([number, number] | undefined)[] = [];
  private readonly stacksView: ([number, number] | undefined)[] = [];
  private rootView: GameNode | undefined;

  /**
   * `group`: the symmetry group (suit permutation indices including IDENTITY, closed under composition; see
   * symmetryGroup). The default, the identity alone, builds the full tree.
   */
  constructor(cfg: TreeConfig, group: readonly number[] = [IDENTITY]) {
    const sk = new Skeleton(cfg);
    const rootDesc = sk.root();
    const D = sk.type.length;
    // Every skeleton node is repeated once per deal of the cards that come before it: copies[k] times
    // for a node with k cards dealt since the start (the same for every betting line).
    const { copies } = dealCounts(cfg.board, group);
    const len0 = cfg.board.length;
    let N = 0;
    for (let d = 0; d < D; d++) N += copies[sk.boardLen[d] - len0];
    if (N > 2 ** 31 - 1) throw new Error(`the game tree has ${N} nodes, more than this solver can index`);
    this.size = N;
    this.desc = new Int32Array(N);
    this.board = new Uint16Array(N);
    this.child = new Int32Array(N);
    this.boards = [Object.freeze(cfg.board.slice()) as Card[]];
    this.group = this.shared(group);
    this.boardGroup = [this.group];

    this.dType = Uint8Array.from(sk.type);
    this.dNum = Int32Array.from(sk.num);
    this.dPlayer = Int8Array.from(sk.player);
    this.dPot = Float64Array.from(sk.pot);
    this.dBets = Float64Array.from(sk.bets);
    this.dStacks = Float64Array.from(sk.stacks);
    this.dInvested = Float64Array.from(sk.invested);
    this.dActions = sk.actions;
    this.maxDepth = sk.maxDepth;
    this.maxActions = sk.maxActions;

    // Expand the skeleton depth first. Each node reserves consecutive ids for its children, then
    // fills them in; a chance node fills one copy of its skeleton child per card, on the new board.
    const { desc, board, child } = this;
    const dType = this.dType;
    const kids = sk.kids;
    let next = 1, action = 0, chance = 0, terminal = 0;
    const fill = (id: number, d: number, b: number): void => {
      desc[id] = d;
      board[id] = b;
      const type = dType[d];
      if (type === NODE_ACTION) {
        action++;
        const ks = kids[d];
        const first = next;
        next += ks.length;
        child[id] = first;
        for (let i = 0; i < ks.length; i++) fill(first + i, ks[i], b);
      } else if (type === NODE_CHANCE) {
        chance++;
        const cs = this.cardsOf(b);
        const first = next;
        next += cs.length;
        child[id] = first;
        const k = kids[d][0];
        for (let i = 0; i < cs.length; i++) fill(first + i, k, this.dealt(b, cs[i]));
      } else {
        terminal++;
        child[id] = -1;
      }
    };
    fill(0, rootDesc, 0);
    // The ids handed out must be the count above (a typed array would drop writes past its end silently).
    if (next !== N) throw new Error(`internal: the tree filled ${next} nodes, ${N} expected`);
    this.members = Array.from({ length: this.boards.length }, (_, b) => this.orbitTables[b]);
    this.actionCount = action;
    this.chanceCount = chance;
    this.terminalCount = terminal;
  }

  /** The group with these elements, as the one shared array. */
  private shared(group: readonly number[]): readonly number[] {
    const key = group.join();
    let g = this.groups.get(key);
    if (!g) {
      g = Object.freeze(group.slice());
      this.groups.set(key, g);
    }
    return g;
  }

  /** The cards dealt at a chance node on board b, ascending: all that can come, or one per orbit. */
  private cardsOf(b: number): Card[] {
    let cs = this.cards[b];
    if (!cs) {
      const orbits = cardOrbits(this.boards[b], this.boardGroup[b]);
      cs = Object.freeze(orbits.reps) as Card[];
      this.cards[b] = cs;
      if (orbits.card.length > 0) this.orbitTables[b] = { start: orbits.start, card: orbits.card, perm: orbits.perm };
    }
    return cs;
  }

  /** The id of board b with card c dealt. */
  private dealt(b: number, c: Card): number {
    const key = b * 52 + c;
    let id = this.boardIds.get(key);
    if (id === undefined) {
      id = this.boards.length;
      this.boards.push(Object.freeze([...this.boards[b], c]) as Card[]);
      const g = this.boardGroup[b];
      this.boardGroup.push(g.length === 1 ? g : this.shared(stabilizer(g, c)));
      this.boardIds.set(key, id);
    }
    return id;
  }

  /** Node type of a node (NODE_ACTION, ...). */
  type(id: number): number {
    return this.dType[this.desc[id]];
  }

  /** Number of children of a node (at a chance node: the cards in cards[board[id]]). */
  numChildren(id: number): number {
    const d = this.desc[id];
    return this.dType[d] === NODE_CHANCE ? this.cards[this.board[id]]!.length : this.dNum[d];
  }

  /** The acting player at an action node (the folder at a fold terminal). */
  player(id: number): Player {
    return this.dPlayer[this.desc[id]] as Player;
  }

  /** The public view of a node (see GameNode); a new object on every call. */
  view(id: number): GameNode {
    return new GameNode(this, id);
  }

  /** The root's view, made once. */
  get root(): GameNode {
    return (this.rootView ??= this.view(0));
  }

  /** Frozen [b0, b1] of a descriptor, shared by every view that shows it. */
  betsOf(d: number): [number, number] {
    return (this.betsView[d] ??= Object.freeze([this.dBets[2 * d], this.dBets[2 * d + 1]]) as [number, number]);
  }

  /** Frozen [s0, s1] of a descriptor, shared by every view that shows it. */
  stacksOf(d: number): [number, number] {
    return (this.stacksView[d] ??= Object.freeze([this.dStacks[2 * d], this.dStacks[2 * d + 1]]) as [number, number]);
  }

  /** Bytes of the per-node arrays: 10 per node (estimateMemory adds the solver's 12 per node and the descriptors). */
  get nodeBytes(): number {
    return this.desc.byteLength + this.board.byteLength + this.child.byteLength;
  }
}

/** A shared empty children list for skeleton terminals. */
const NO_KIDS: number[] = [];

/**
 * The betting skeleton: the game tree from the rules with every chance node collapsed to one child,
 * as parallel arrays (one entry per skeleton node, which becomes a descriptor of the packed tree).
 */
class Skeleton {
  type: number[] = [];
  /** Children in the packed tree: actions, or 52 - board length at a chance node. */
  num: number[] = [];
  player: number[] = [];
  pot: number[] = [];
  bets: number[] = [];
  stacks: number[] = [];
  invested: number[] = [];
  /** Board length (3, 4 or 5) at the node: the cards dealt since the start are boardLen - the starting board's. */
  boardLen: number[] = [];
  actions: (SolverAction[] | undefined)[] = [];
  /** Skeleton children: one per action; a chance node's single child stands for every card. */
  kids: number[][] = [];
  maxDepth = 0;
  maxActions = 1;
  /** Identical betting states (e.g. the same line reached two ways) share one action list. */
  private actionCache = new Map<string, SolverAction[]>();

  constructor(private cfg: TreeConfig) {}

  private add(type: number, len: number, pot: number, bets: readonly number[], stacks: readonly number[], player: number, invested: number, depth: number): number {
    if (depth > this.maxDepth) this.maxDepth = depth;
    const d = this.type.length;
    this.type.push(type);
    this.boardLen.push(len);
    this.num.push(0);
    this.player.push(player);
    this.pot.push(pot);
    this.bets.push(bets[0], bets[1]);
    this.stacks.push(stacks[0], stacks[1]);
    this.invested.push(invested);
    this.actions.push(undefined);
    this.kids.push(NO_KIDS);
    return d;
  }

  root(): number {
    const { board, pot0, stack0 } = this.cfg;
    if (stack0 <= 0) return this.runout(board.length, pot0, [0, 0], [0, 0], 0);
    return this.action({ street: board.length - 3, board, pot: pot0, bets: [0, 0], stacks: [stack0, stack0], player: 0, n: 0, inc: 0 }, 0);
  }

  private actionsFor(st: BetState): SolverAction[] {
    const key = stateKey(st);
    let acts = this.actionCache.get(key);
    if (!acts) {
      // Shared by every node with this betting state, so frozen: a caller can't change one node's
      // menu (or the solver's) by writing into another's.
      acts = Object.freeze(legalActions(this.cfg, st).map((a) => Object.freeze(a))) as SolverAction[];
      this.actionCache.set(key, acts);
    }
    return acts;
  }

  private action(st: BetState, depth: number): number {
    const acts = this.actionsFor(st);
    const d = this.add(NODE_ACTION, st.board.length, st.pot, st.bets, st.stacks, st.player, 0, depth);
    this.actions[d] = acts;
    this.num[d] = acts.length;
    this.maxActions = Math.max(this.maxActions, acts.length);
    const kids: number[] = [];
    for (const a of acts) {
      const next = applyAction(st, a);
      if (next.type === "fold") kids.push(this.fold(st, next.folder, depth + 1));
      else if (next.type === "act") kids.push(this.action(next.state, depth + 1));
      else kids.push(this.streetEnd(next.state, depth + 1));
    }
    this.kids[d] = kids;
    return d;
  }

  private fold(st: BetState, folder: Player, depth: number): number {
    // The folder loses what they put in; the winner nets the starting pot plus that.
    return this.add(NODE_FOLD, st.board.length, st.pot, st.bets, st.stacks, folder, this.cfg.stack0 - st.stacks[folder], depth);
  }

  private showdown(pot: number, bets: readonly number[], stacks: readonly number[], depth: number): number {
    return this.add(NODE_SHOWDOWN, 5, pot, bets, stacks, -1, this.cfg.stack0 - stacks[0], depth);
  }

  /** A chance node on a board of `len` cards; `child` builds the subtree that follows any card. */
  private chance(len: number, pot: number, bets: readonly number[], stacks: readonly number[], depth: number, child: () => number): number {
    const d = this.add(NODE_CHANCE, len, pot, bets, stacks, -1, 0, depth);
    this.num[d] = 52 - len;
    this.kids[d] = [child()];
    return d;
  }

  /** Both players all-in: deal the rest of the board with no actions, then show down. */
  private runout(len: number, pot: number, bets: readonly number[], stacks: readonly number[], depth: number): number {
    if (len === 5) return this.showdown(pot, bets, stacks, depth);
    return this.chance(len, pot, bets, stacks, depth, () => this.runout(len + 1, pot, [0, 0], stacks, depth + 1));
  }

  private streetEnd(st: BetState, depth: number): number {
    const len = st.board.length;
    if (st.stacks[0] === 0 && st.stacks[1] === 0) return this.runout(len, st.pot, st.bets, st.stacks, depth);
    if (len === 5) return this.showdown(st.pot, st.bets, st.stacks, depth);
    // The next street's betting doesn't depend on which card came; a placeholder board of the right length will do.
    const board = [...st.board, -1];
    return this.chance(len, st.pot, st.bets, st.stacks, depth, () =>
      this.action({ street: st.street + 1, board, pot: st.pot, bets: [0, 0], stacks: st.stacks, player: 0, n: 0, inc: 0 }, depth + 1),
    );
  }
}

// The children accessor of GameNode views (set in GameNode's static block, which can read its private fields).
let CHILDREN: PropertyDescriptor;

/**
 * A node of the tree as `buildTree` returns it: a read-only view of one node of a PackedTree, with the
 * public GameTreeNode fields. Views are made on demand: `children` is built on first access and kept,
 * so walking part of a big tree only creates the views it touches. `children` is an own enumerable
 * property, like the other fields, so spreading, JSON or structured clone (postMessage) of a node see it
 * (and build the whole subtree under it). Arrays are shared between views and frozen.
 */
export class GameNode implements GameTreeNode {
  /** The node's id in its PackedTree. */
  readonly id: number;
  /** NODE_ACTION, NODE_CHANCE, NODE_FOLD or NODE_SHOWDOWN. */
  readonly type: number;
  readonly kind: "action" | "chance" | "terminal";
  readonly street: SolverStreet;
  readonly board: Card[];
  readonly pot: number;
  readonly bets: [number, number];
  readonly stacks: [number, number];
  readonly player: Player | undefined;
  readonly actions: SolverAction[] | undefined;
  readonly cards: Card[] | undefined;
  readonly terminal: "fold" | "showdown" | undefined;
  readonly folder: Player | undefined;
  /** Terminal: chips put in over the whole solve (PackedTree.dInvested); 0 elsewhere. */
  readonly invested: number;
  declare readonly children: GameNode[];
  readonly #tree: PackedTree;
  #children: GameNode[] | undefined = undefined;

  static {
    CHILDREN = {
      enumerable: true,
      get(this: GameNode): GameNode[] {
        let c = this.#children;
        if (!c) {
          const t = this.#tree, n = t.numChildren(this.id), first = t.child[this.id];
          c = Object.freeze(Array.from({ length: n }, (_, i) => t.view(first + i))) as GameNode[];
          this.#children = c;
        }
        return c;
      },
    };
  }

  constructor(tree: PackedTree, id: number) {
    const d = tree.desc[id];
    const type = tree.dType[d];
    const b = tree.board[id];
    const board = tree.boards[b];
    this.id = id;
    this.type = type;
    this.kind = type === NODE_ACTION ? "action" : type === NODE_CHANCE ? "chance" : "terminal";
    this.street = STREETS[board.length - 3];
    this.board = board;
    this.pot = tree.dPot[d];
    this.bets = tree.betsOf(d);
    this.stacks = tree.stacksOf(d);
    this.player = type === NODE_ACTION ? (tree.dPlayer[d] as Player) : undefined;
    this.actions = type === NODE_ACTION ? tree.dActions[d] : undefined;
    this.cards = type === NODE_CHANCE ? tree.cards[b] : undefined;
    this.terminal = type === NODE_FOLD ? "fold" : type === NODE_SHOWDOWN ? "showdown" : undefined;
    this.folder = type === NODE_FOLD ? (tree.dPlayer[d] as Player) : undefined;
    this.invested = tree.dInvested[d];
    this.#tree = tree;
    Object.defineProperty(this, "children", CHILDREN);
  }

  /** Fold terminal: player p's net, given the starting pot. */
  foldNet(p: number, pot0: number): number {
    return p === this.folder ? 0 - this.invested : pot0 + this.invested;
  }
}

/** Cards not on the board, ascending. */
export function remainingCards(board: readonly Card[]): Card[] {
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) if (!board.includes(c)) out.push(c);
  return out;
}

/**
 * Build the packed tree the solver uses (`cfg`: the input's treeConfig, if already made; `group`: the spot's
 * symmetry group, by default none, which gives the full tree).
 */
export function buildGameTree(input: SolverInput, cfg: TreeConfig = treeConfig(input), group: readonly number[] = [IDENTITY]): PackedTree {
  return new PackedTree(cfg, group);
}

/**
 * The game tree for a spot (for tests and the UI), without solving: the root's view (GameNode), whose
 * children are built as they are reached. Read-only: views share frozen arrays (an action list with
 * every node of the same betting state, a board with every node on it, bets and stacks with every node
 * of the same betting line).
 */
export function buildTree(input: SolverInput): GameNode {
  return buildGameTree(input).root;
}
// ---------------------------------------------------------------------------------------------
// Counting without building (estimateMemory)

/** Skeleton counts, per number of cards dealt since the start (index 0..2). */
interface Counts {
  action: number[];
  chance: number[];
  terminal: number[];
  /** Σ over each player's action nodes of the number of actions: slots[k][player]. */
  slots: [number, number][];
  /** Skeleton nodes (PackedTree descriptors). */
  desc: number;
  /** Distinct action lists (betting states, by stateKey), and their actions. */
  lists: Set<string>;
  listActions: number;
  maxDepth: number;
  maxActions: number;
}

/**
 * Count the betting skeleton under a betting state, by the number of cards dealt (`k`). The subtree under a
 * chance node has the same shape for every card, so each skeleton node is counted once here and multiplied
 * later by the number of deals that lead to it (dealCounts). Each call visits one node of the skeleton,
 * which becomes one PackedTree descriptor.
 */
function countAction(cfg: TreeConfig, st: BetState, depth: number, k: number, c: Counts): void {
  c.maxDepth = Math.max(c.maxDepth, depth);
  const acts = legalActions(cfg, st);
  c.action[k]++;
  c.desc++;
  const key = stateKey(st);
  if (!c.lists.has(key)) {
    c.lists.add(key);
    c.listActions += acts.length;
  }
  c.slots[k][st.player] += acts.length;
  c.maxActions = Math.max(c.maxActions, acts.length);
  for (const a of acts) {
    const next = applyAction(st, a);
    if (next.type === "fold") {
      c.terminal[k]++;
      c.desc++;
      c.maxDepth = Math.max(c.maxDepth, depth + 1);
    } else if (next.type === "act") countAction(cfg, next.state, depth + 1, k, c);
    else countStreetEnd(cfg, next.state, depth + 1, k, c);
  }
}

function countRunout(boardLen: number, depth: number, k: number, c: Counts): void {
  c.maxDepth = Math.max(c.maxDepth, depth);
  c.desc++;
  if (boardLen === 5) {
    c.terminal[k]++;
    return;
  }
  c.chance[k]++;
  countRunout(boardLen + 1, depth + 1, k + 1, c);
}

function countStreetEnd(cfg: TreeConfig, st: BetState, depth: number, k: number, c: Counts): void {
  const len = st.board.length;
  if (st.stacks[0] === 0 && st.stacks[1] === 0) return countRunout(len, depth, k, c);
  c.maxDepth = Math.max(c.maxDepth, depth);
  c.desc++;
  if (len === 5) {
    c.terminal[k]++;
    return;
  }
  c.chance[k]++;
  // The next street's state doesn't depend on which card came; a placeholder board of the right length will do.
  const board = [...st.board, -1];
  countAction(cfg, { street: st.street + 1, board, pot: st.pot, bets: [0, 0], stacks: st.stacks, player: 0, n: 0, inc: 0 }, depth + 1, k + 1, c);
}

/**
 * Memory model of the solver's tree, in bytes (calibrated in V8, Node 22, against the measured heap of
 * river, turn and flop solvers; see the estimateMemory tests):
 * - per node: the PackedTree's desc (Int32), board (Uint16) and first child (Int32), and the solver's
 *   storage offset (Float64) and last discounted iteration (Int32);
 * - per action node: its entry in the solver's list of action nodes (Int32);
 * - per descriptor: 7 typed-array entries and an action-list slot;
 * - per distinct action list (descriptors with the same betting state share one): the frozen array, and
 *   per action a frozen object, its label and its amount;
 * - per river board of the showdown cache: 14 bytes per hand that doesn't touch it (order, strength,
 *   same: Int32; two cards: Uint8) and 4 per hand that does (about 8% on a flop), and the RiverBoard
 *   object with its 12 typed arrays;
 * - with a symmetry group: per element, a hand permutation per player (Int32 per hand), and per board of the
 *   tree its card lists and orbit tables (BOARD_BYTES; a small share of a flop);
 * - with compressed storage: 2 + 2 bytes per stored regret and strategy sum instead of 4 + 4, and per node its
 *   three Float32 scales.
 */
const NODE_BYTES = 10 + 12;
const ACTION_NODE_BYTES = 4;
const DESC_BYTES = 64;
const LIST_BYTES = 48;
const LIST_ACTION_BYTES = 104;
const RIVER_HAND_BYTES = 13;
const RIVER_BOARD_BYTES = 2700;
const BOARD_BYTES = 200;
const SCALE_BYTES = 12;

/**
 * Whether the solver will use suit isomorphism, and with which group, for an input whose ranges are
 * checked. `isomorphism: false` (tests) turns it off: the group is then the identity alone.
 */
export function solverGroup(board: readonly Card[], ranges: SolverInput["ranges"], isomorphism = true): readonly number[] {
  return isomorphism ? symmetryGroup(board, ranges) : [IDENTITY];
}

/**
 * Node counts and a byte estimate for solving this spot, without allocating any per-hand arrays.
 * Bytes = regret + strategy-sum storage (2 × 4 bytes per action per hand of the acting player, 2 × 2 with
 * compressed storage, plus its per-node scales)
 * + the packed tree and per-node solver arrays + the showdown strength cache + per-depth scratch + hand lists.
 * The node counts are those of the game tree (as buildTree builds it); the bytes are for the tree the solver
 * really builds, which with suit isomorphism holds one subtree per orbit of cards at each chance node.
 *
 * It checks the inputs like createSolver, except that the ranges give a game (a hand off the board for each
 * player, a compatible pair): with empty ranges it sizes the tree alone, which is how the tests count nodes.
 * createSolver rejects those ranges before it builds anything, so gating on this estimate costs nothing.
 * `opts.isomorphism: false` sizes a solver built with isomorphism off (tests).
 */
export function estimateMemory(input: SolverInput, opts: { isomorphism?: boolean } = {}): MemoryEstimate {
  const cfg = treeConfig(input);
  checkRanges(input.ranges);
  const c: Counts = {
    action: [0, 0, 0], chance: [0, 0, 0], terminal: [0, 0, 0], slots: [[0, 0], [0, 0], [0, 0]],
    desc: 0, lists: new Set(), listActions: 0, maxDepth: 0, maxActions: 1,
  };
  const len = cfg.board.length;
  if (cfg.stack0 <= 0) countRunout(len, 0, 0, c);
  else
    countAction(cfg, { street: len - 3, board: cfg.board, pot: cfg.pot0, bets: [0, 0], stacks: [cfg.stack0, cfg.stack0], player: 0, n: 0, inc: 0 }, 0, 0, c);

  // The game tree's counts (every card), and the copies the solver holds (one card per orbit).
  const full = dealCounts(cfg.board, [IDENTITY]).copies;
  const group = solverGroup(cfg.board, input.ranges, opts.isomorphism ?? true);
  const iso = dealCounts(cfg.board, group);
  const times = (xs: number[], m: number[]) => xs.reduce((s, x, k) => s + x * m[k], 0);
  const n0 = countHands(cfg.board, input.ranges[0]);
  const n1 = countHands(cfg.board, input.ranges[1]);
  const nMax = Math.max(n0, n1, 1);
  const m = iso.copies;
  const action = times(c.action, m);
  const nodes = action + times(c.chance, m) + times(c.terminal, m);
  const slots = times(c.slots.map((s) => s[0]), m) * n0 + times(c.slots.map((s) => s[1]), m) * n1;
  const storage = cfg.compress ? 4 * slots + SCALE_BYTES * nodes : 8 * slots;
  const tree =
    nodes * NODE_BYTES + action * ACTION_NODE_BYTES + c.desc * DESC_BYTES + c.lists.size * LIST_BYTES + c.listActions * LIST_ACTION_BYTES;
  // One strength order per distinct river board the tree reaches: 1 (river), 48 (turn), C(49, 2) (flop)
  // without isomorphism.
  const cache = iso.riverBoards * ((n0 + n1) * RIVER_HAND_BYTES + RIVER_BOARD_BYTES);
  const scratch = (c.maxDepth + 2) * (4 + 2 * c.maxActions) * nMax * 8;
  const hands = (n0 + n1) * 64 + 2 * 1326 * 4;
  const symmetry = group.length > 1 ? (group.length - 1) * (n0 + n1) * 4 + (m[1] + m[2]) * BOARD_BYTES : 0;
  return {
    bytes: Math.round(storage + tree + cache + scratch + hands + symmetry),
    actionNodes: times(c.action, full),
    chanceNodes: times(c.chance, full),
    terminalNodes: times(c.terminal, full),
  };
}
