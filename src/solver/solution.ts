import { averageStrategy, MODE_AVG, type Engine } from "./cfr";
import { cardMask, compatibleSums, NUM_COMBOS } from "./hands";
import { NODE_ACTION, NODE_CHANCE } from "./tree";
import type { PathStep, Player, Solution, SolutionNode } from "./types";

/**
 * The cache key of a step, after checking its shape: `{action: i}` or `{card: c}`, exactly one of the two
 * keys, with an integer value. Checked before the cache lookup, so `{action: "1"}` can't hit the entry
 * of `{action: 1}` and `{action: 1, card: 5}` can't stand for either.
 */
function stepKey(s: unknown, i: number): string {
  if (typeof s === "object" && s !== null) {
    const hasAction = "action" in s, hasCard = "card" in s;
    if (hasAction !== hasCard) {
      const v = hasAction ? (s as { action: unknown }).action : (s as { card: unknown }).card;
      if (Number.isInteger(v)) return `${hasAction ? "a" : "c"}${v as number}`;
    }
  }
  throw new Error(`illegal path at step ${i}: a step is {action: integer} or {card: integer}`);
}

/**
 * True when a typed array of a cached node has lost its buffer. Transferring a buffer away (a Web Worker's
 * postMessage with it in the transfer list, structuredClone with `transfer`, ArrayBuffer.transfer) empties
 * the array in place; every array of a node has NUM_COMBOS entries otherwise.
 */
function detached(n: SolutionNode): boolean {
  for (const list of [n.strategy, n.ranges, n.ev]) {
    if (list) for (const a of list) if (a.length !== NUM_COMBOS) return true;
  }
  return false;
}

/**
 * A view of the solver's current average strategy. It reads the solver's live arrays, so it is only
 * valid until the next iterate(); after that node() throws "stale solution".
 *
 * node(path) caches its result and returns the same object for the same path. That object and its plain
 * arrays are frozen; its typed arrays (strategy[a], ranges[p], ev[p]) are shared with later calls, so
 * callers must treat them as read-only (copy before changing them). Transferring them is fine: once one
 * of them is detached, node() builds that path's node afresh instead of handing back empty arrays.
 */
export class SolverSolution implements Solution {
  readonly iterations: number;
  private readonly cache = new Map<string, SolutionNode>();
  private expl: number | undefined;

  constructor(private readonly e: Engine, private readonly getExploitability: () => number) {
    this.iterations = e.t;
  }

  /** % of the starting pot; computed on first read and kept. */
  get exploitability(): number {
    if (this.expl === undefined) {
      this.checkFresh();
      this.expl = this.getExploitability();
    }
    return this.expl;
  }

  private checkFresh(): void {
    if (this.e.t !== this.iterations) throw new Error("stale solution: the solver has iterated since this solution was taken");
  }

  node(path: PathStep[]): SolutionNode {
    this.checkFresh();
    if (!Array.isArray(path)) throw new Error("illegal path: a path is an array of steps");
    const key = path.map(stepKey).join(".");
    const hit = this.cache.get(key);
    if (hit && !detached(hit)) return hit;

    const e = this.e;
    const hands = e.hands;
    // Reach of each player along the path: initial weight × own action probabilities (cards blocked → 0).
    const reach: [Float64Array, Float64Array] = [Float64Array.from(e.w[0]), Float64Array.from(e.w[1])];
    const tree = e.tree;
    let node = e.root;
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      // stepKey checked the shape: exactly one of action / card, an integer.
      const type = tree.type(node);
      if (type === NODE_ACTION) {
        const A = tree.numChildren(node);
        if (!("action" in step) || step.action < 0 || step.action >= A)
          throw new Error(`illegal path at step ${i}: expected an action index 0..${A - 1}`);
        const q = tree.player(node);
        const n = hands[q].n;
        const sig = new Float64Array(A * n);
        averageStrategy(e.stratSum, e.off[node], A, n, sig, new Float64Array(n));
        const r = reach[q], s = step.action * n;
        for (let h = 0; h < n; h++) r[h] *= sig[s + h];
        node = tree.child[node] + step.action;
      } else if (type === NODE_CHANCE) {
        const cards = tree.cards[tree.board[node]]!;
        const k = "card" in step ? cards.indexOf(step.card) : -1;
        if (k < 0) throw new Error(`illegal path at step ${i}: expected a card that can come`);
        const c = cards[k];
        for (const q of [0, 1] as const) {
          const wc = hands[q].withCard[c];
          for (let j = 0; j < wc.length; j++) reach[q][wc[j]] = 0;
        }
        node = tree.child[node] + k;
      } else {
        throw new Error(`illegal path at step ${i}: the hand is over`);
      }
    }

    const result = this.describe(node, reach);
    this.cache.set(key, result);
    return result;
  }

  private describe(id: number, reach: [Float64Array, Float64Array]): SolutionNode {
    const e = this.e;
    const hands = e.hands;
    const node = e.tree.view(id);
    const dead = cardMask(node.board);
    // Hands blocked by cards dealt after the start (the lists already exclude the starting board).
    const blocked = hands.map((hl) => {
      const b = new Uint8Array(hl.n);
      for (let h = 0; h < hl.n; h++) b[h] = dead[hl.c1[h]] | dead[hl.c2[h]];
      return b;
    });

    const ranges = [0, 1].map((q) => {
      const out = new Float32Array(NUM_COMBOS);
      const hl = hands[q];
      for (let h = 0; h < hl.n; h++) if (!blocked[q][h]) out[hl.combo[h]] = reach[q][h];
      return out;
    }) as [Float32Array, Float32Array];

    let strategy: Float32Array[] | undefined;
    if (node.type === NODE_ACTION) {
      const q = node.player!;
      const hl = hands[q];
      const A = e.tree.numChildren(id);
      const sig = new Float64Array(A * hl.n);
      averageStrategy(e.stratSum, e.off[id], A, hl.n, sig, new Float64Array(hl.n));
      strategy = [];
      for (let a = 0; a < A; a++) {
        const out = new Float32Array(NUM_COMBOS);
        for (let h = 0; h < hl.n; h++) if (!blocked[q][h]) out[hl.combo[h]] = sig[a * hl.n + h];
        strategy.push(out);
      }
    }

    // ev[p](h) = cfv_p(h) / compatible opponent reach, both on the average strategy from here on.
    const ev = [0, 1].map((p) => {
      const out = new Float32Array(NUM_COMBOS).fill(NaN);
      const me = hands[p], opp = hands[1 - p];
      const cs = new Float64Array(me.n);
      const total = compatibleSums(me, opp, reach[1 - p], cs);
      if (!(total > 0)) return out;
      e.walk(id, p, MODE_AVG, reach[p], reach[1 - p], e.out, 0);
      const tiny = total * 1e-12; // below this the compatible reach is zero up to rounding
      for (let h = 0; h < me.n; h++) {
        if (!blocked[p][h] && cs[h] > tiny) out[me.combo[h]] = e.out[h] / cs[h];
      }
      return out;
    }) as [Float32Array, Float32Array];

    // node() hands out this cached object on every call for the path, so everything that can be frozen
    // is. Typed arrays with elements can't be frozen: they are documented read-only.
    const freeze = Object.freeze;
    return freeze({
      kind: node.kind,
      street: node.street,
      board: freeze(node.board.slice()),
      pot: node.pot,
      bets: freeze([node.bets[0], node.bets[1]]) as [number, number],
      stacks: freeze([node.stacks[0], node.stacks[1]]) as [number, number],
      player: node.player as Player | undefined,
      actions: node.actions && freeze(node.actions.map((a) => freeze({ ...a }))),
      strategy: strategy && freeze(strategy),
      cards: node.cards && freeze(node.cards.slice()),
      terminal: node.terminal,
      ranges: freeze(ranges),
      ev: freeze(ev),
    }) as SolutionNode;
  }
}
