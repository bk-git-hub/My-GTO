import type { Card } from "../../poker/cards";
import {
  DEFAULT_SIZES,
  type ActionKind,
  type PathStep,
  type Player,
  type SolverInput,
  type SolverStreet,
  type StreetSizes,
} from "../types";

/**
 * Independent reference tree builder (the "oracle").
 *
 * It follows the "Game tree rules" section of docs/solver.md line by line and
 * favours obvious code over speed. It shares nothing with src/solver/tree.ts.
 *
 * Field conventions (where the spec leaves room):
 * - Every node's `street` is the one implied by its own board, and `bets` are the
 *   bets on that street. So a chance node keeps the bets of the street that just
 *   ended, and the first node after a dealt card has bets [0, 0].
 * - `contributions[i]` = chips player i put in since the start of the solve = S − stacks[i].
 */

export interface OracleAction {
  kind: ActionKind;
  /** This player's street total after the action (0 for fold and check). */
  to: number;
  label: string;
}

export interface OracleNode {
  kind: "action" | "chance" | "terminal";
  street: SolverStreet;
  board: Card[];
  /** Every chip in the middle, the starting pot and this street's bets included. */
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  /** Chips each player put in since the start of the solve. */
  contributions: [number, number];
  /** Action node: who acts. */
  player?: Player;
  /** Action node: the legal actions, children aligned. */
  actions?: OracleAction[];
  children: OracleNode[];
  /** Chance node: the cards that can come, ascending, children aligned. */
  cards?: Card[];
  terminal?: "fold" | "showdown";
  /** Fold terminal: who folded. */
  folder?: Player;
}

/** Settings with the spec defaults filled in. */
interface Config {
  P0: number;
  S: number;
  sizes: SolverInput["sizes"];
  raiseLimit: number;
  addAllIn: boolean;
  allInThreshold: number;
  minBet: number;
}

/** The betting state of the spec: street (from the board), pot, bets, stacks, player to act, n, inc. */
interface State {
  board: Card[];
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  toAct: Player;
  /** Bets and raises made on this street. */
  n: number;
  /** Last raise increment on this street. */
  inc: number;
}

/**
 * Chip tolerance of the spec: two amounts within EPS are equal. Two actions of the same kind
 * closer than this are the same action, and a bet or raise that would leave at most EPS behind
 * is the all-in (so no player is ever left with rounding dust behind).
 */
const EPS = 1e-9;

export function streetOfBoard(board: readonly Card[]): SolverStreet {
  if (board.length === 3) return "flop";
  if (board.length === 4) return "turn";
  if (board.length === 5) return "river";
  throw new Error(`oracle: board must have 3, 4 or 5 cards (got ${board.length})`);
}

function configOf(input: SolverInput): Config {
  if (!(input.pot > 0)) throw new Error("oracle: pot must be > 0");
  if (!(input.stack >= 0)) throw new Error("oracle: stack must be >= 0");
  return {
    P0: input.pot,
    S: input.stack,
    sizes: input.sizes,
    raiseLimit: input.raiseLimit ?? 2,
    addAllIn: input.addAllIn ?? true,
    allInThreshold: input.allInThreshold ?? 0.67,
    minBet: input.minBet ?? 1,
  };
}

function sizesFor(cfg: Config, street: SolverStreet, player: Player): StreetSizes {
  const entry = cfg.sizes?.[street];
  return entry ? entry[player] : DEFAULT_SIZES[player];
}

/** Round to 0.1 for labels: 9.5 -> "9.5", 10 -> "10". */
function fmt(x: number): string {
  return String(Math.round(x * 10) / 10);
}

function ascending(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

function copyState(st: State): State {
  return {
    board: st.board,
    pot: st.pot,
    bets: [st.bets[0], st.bets[1]],
    stacks: [st.stacks[0], st.stacks[1]],
    toAct: st.toAct,
    n: st.n,
    inc: st.inc,
  };
}

/** The fields every node carries, taken from a state. */
function baseFields(cfg: Config, st: State) {
  return {
    street: streetOfBoard(st.board),
    board: st.board,
    pot: st.pot,
    bets: [st.bets[0], st.bets[1]] as [number, number],
    stacks: [st.stacks[0], st.stacks[1]] as [number, number],
    contributions: [cfg.S - st.stacks[0], cfg.S - st.stacks[1]] as [number, number],
  };
}

/** The legal actions at a state, in the spec's order, duplicates merged. */
function legalActions(cfg: Config, st: State): OracleAction[] {
  const p = st.toAct;
  const street = streetOfBoard(st.board);
  const sizes = sizesFor(cfg, street, p);
  const myBet = st.bets[p];
  const maxBet = Math.max(st.bets[0], st.bets[1]);
  const myStack = st.stacks[p];
  const oppStack = st.stacks[1 - p];
  const toCall = maxBet - myBet;

  const list: OracleAction[] = [];
  // Bets and raises that turn into all-ins become one `allin` action at the end.
  let wantAllIn = false;

  if (toCall <= EPS) {
    // Not facing a bet.
    list.push({ kind: "check", to: 0, label: "체크" });
    for (const f of ascending(sizes.bet)) {
      const raw = f * st.pot;
      const amount = Math.max(cfg.minBet, raw);
      if (amount >= cfg.allInThreshold * myStack - EPS || amount >= myStack - EPS) {
        wantAllIn = true;
        continue;
      }
      const label = cfg.minBet > raw ? `벳 ${fmt(amount)}` : `벳 ${Math.round(f * 100)}%`;
      list.push({ kind: "bet", to: myBet + amount, label });
    }
    if (cfg.addAllIn) wantAllIn = true;
    if (wantAllIn && myStack > 0) list.push({ kind: "allin", to: myBet + myStack, label: "올인" });
  } else {
    // Facing a bet.
    list.push({ kind: "fold", to: 0, label: "폴드" });
    list.push({ kind: "call", to: maxBet, label: "콜" });
    const raisesAllowed = st.n <= cfg.raiseLimit && myStack > toCall + EPS && oppStack > 0;
    if (raisesAllowed) {
      for (const f of ascending(sizes.raise)) {
        let to = myBet + toCall + f * (st.pot + toCall);
        // At least a minimum raise: the last increment on top of the current bet.
        to = Math.max(to, maxBet + st.inc);
        if (to - myBet >= cfg.allInThreshold * myStack - EPS || to - myBet >= myStack - EPS) {
          wantAllIn = true;
          continue;
        }
        list.push({ kind: "raise", to, label: `레이즈 ${fmt(to)}` });
      }
      if (cfg.addAllIn) wantAllIn = true;
      if (wantAllIn) list.push({ kind: "allin", to: myBet + myStack, label: "올인" });
    }
  }

  // Merge actions with the same kind and `to`, keeping the first.
  const merged: OracleAction[] = [];
  for (const a of list) {
    if (!merged.some((b) => b.kind === a.kind && Math.abs(b.to - a.to) <= EPS)) merged.push(a);
  }
  return merged;
}

function actionNode(cfg: Config, st: State): OracleNode {
  const actions = legalActions(cfg, st);
  const node: OracleNode = {
    kind: "action",
    ...baseFields(cfg, st),
    player: st.toAct,
    actions,
    children: [],
  };
  node.children = actions.map((a) => afterAction(cfg, st, a));
  return node;
}

function afterAction(cfg: Config, st: State, a: OracleAction): OracleNode {
  const p = st.toAct;
  const q: Player = p === 0 ? 1 : 0;
  switch (a.kind) {
    case "fold":
      return { kind: "terminal", ...baseFields(cfg, st), terminal: "fold", folder: p, children: [] };
    case "check": {
      // OOP check -> IP acts. IP check (only possible after OOP checked) -> street over.
      if (p === 0) {
        const next = copyState(st);
        next.toAct = 1;
        return actionNode(cfg, next);
      }
      return streetOver(cfg, st);
    }
    case "call": {
      const next = copyState(st);
      const toCall = a.to - st.bets[p];
      next.pot = st.pot + toCall;
      next.bets[p] = a.to;
      // With equal starting stacks, matching the opponent's street total leaves us with
      // exactly their stack (written this way so an all-in call gives exactly 0).
      next.stacks[p] = st.stacks[q];
      return streetOver(cfg, next);
    }
    case "bet":
    case "raise":
    case "allin": {
      const next = copyState(st);
      const maxBefore = Math.max(st.bets[0], st.bets[1]);
      const added = a.to - st.bets[p];
      next.pot = st.pot + added;
      next.stacks[p] = a.kind === "allin" ? 0 : st.stacks[p] - added;
      next.bets[p] = a.to;
      next.n = st.n + 1;
      next.inc = Math.max(st.inc, a.to - maxBefore);
      next.toAct = q;
      return actionNode(cfg, next);
    }
  }
}

/** Street over: all-in runout, river showdown, or a chance node into the next street. */
function streetOver(cfg: Config, st: State): OracleNode {
  if (st.stacks[0] === 0 && st.stacks[1] === 0) return runout(cfg, st);
  if (st.board.length === 5) return showdown(cfg, st);
  return chanceNode(cfg, st, (board) =>
    actionNode(cfg, {
      board,
      pot: st.pot,
      bets: [0, 0],
      stacks: [st.stacks[0], st.stacks[1]],
      toAct: 0,
      n: 0,
      inc: 0,
    }),
  );
}

/** Deal the remaining board cards with no betting, then a showdown. */
function runout(cfg: Config, st: State): OracleNode {
  if (st.board.length === 5) return showdown(cfg, st);
  return chanceNode(cfg, st, (board) =>
    runout(cfg, { ...copyState(st), board, bets: [0, 0], n: 0, inc: 0, toAct: 0 }),
  );
}

function showdown(cfg: Config, st: State): OracleNode {
  return { kind: "terminal", ...baseFields(cfg, st), terminal: "showdown", children: [] };
}

/** A chance node: every card not on the board, ascending; `next` builds the subtree for the new board. */
function chanceNode(cfg: Config, st: State, next: (board: Card[]) => OracleNode): OracleNode {
  const cards: Card[] = [];
  for (let c = 0; c < 52; c++) if (!st.board.includes(c)) cards.push(c);
  return {
    kind: "chance",
    ...baseFields(cfg, st),
    cards,
    children: cards.map((c) => next([...st.board, c])),
  };
}

/** Build the whole game tree for an input. */
export function oracleTree(input: SolverInput): OracleNode {
  const cfg = configOf(input);
  const board = input.board.slice();
  streetOfBoard(board);
  if (new Set(board).size !== board.length || board.some((c) => !(c >= 0 && c < 52 && Number.isInteger(c)))) {
    throw new Error("oracle: board cards must be distinct cards 0..51");
  }
  const root: State = { board, pot: cfg.P0, bets: [0, 0], stacks: [cfg.S, cfg.S], toAct: 0, n: 0, inc: 0 };
  if (cfg.S === 0) return runout(cfg, root);
  return actionNode(cfg, root);
}

/** Follow a path from the root: {action: i} at action nodes, {card} at chance nodes. Throws on an illegal path. */
export function oracleNodeAt(root: OracleNode, path: readonly PathStep[]): OracleNode {
  let node = root;
  for (let k = 0; k < path.length; k++) {
    const step = path[k];
    if (node.kind === "action") {
      if (!("action" in step)) throw new Error(`oracle: step ${k} must be an action at an action node`);
      const i = step.action;
      if (!Number.isInteger(i) || i < 0 || i >= node.children.length) {
        throw new Error(`oracle: step ${k}: action ${i} out of range`);
      }
      node = node.children[i];
    } else if (node.kind === "chance") {
      if (!("card" in step)) throw new Error(`oracle: step ${k} must be a card at a chance node`);
      const idx = node.cards!.indexOf(step.card);
      if (idx < 0) throw new Error(`oracle: step ${k}: card ${step.card} can't come here`);
      node = node.children[idx];
    } else {
      throw new Error(`oracle: step ${k}: the path continues past a terminal node`);
    }
  }
  return node;
}

/** Visit every node with its path (depth first, children in order). */
export function forEachNode(root: OracleNode, visit: (node: OracleNode, path: PathStep[]) => void): void {
  const path: PathStep[] = [];
  const rec = (node: OracleNode) => {
    visit(node, path);
    for (let i = 0; i < node.children.length; i++) {
      path.push(node.kind === "chance" ? { card: node.cards![i] } : { action: i });
      rec(node.children[i]);
      path.pop();
    }
  };
  rec(root);
}

/** Node counts, handy to compare with the core's estimateMemory. */
export function oracleTreeStats(root: OracleNode): { actionNodes: number; chanceNodes: number; terminalNodes: number } {
  let actionNodes = 0;
  let chanceNodes = 0;
  let terminalNodes = 0;
  forEachNode(root, (n) => {
    if (n.kind === "action") actionNodes++;
    else if (n.kind === "chance") chanceNodes++;
    else terminalNodes++;
  });
  return { actionNodes, chanceNodes, terminalNodes };
}

/** A stable string for a path, e.g. "a1/a0/c37". */
export function pathKey(path: readonly PathStep[]): string {
  return path.map((s) => ("action" in s ? `a${s.action}` : `c${s.card}`)).join("/");
}
