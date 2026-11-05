import type { Card } from "../poker/cards";
import { MODE_AVG, type Engine } from "./cfr";
import { cardMask, compatibleSums, NUM_COMBOS } from "./hands";
import { comboPerm, composePerms, IDENTITY, PERM_INV, permCard } from "./iso";
import { NODE_ACTION, NODE_CHANCE, NODE_FOLD, NODE_SHOWDOWN, remainingCards, STREETS } from "./tree";
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
    const tree = e.tree;
    // With suit isomorphism the solver holds one subtree per orbit of cards: a path through another card
    // continues in the representative's subtree, read through the suit permutation that maps it there.
    // `frame` maps the path's real cards to the cards of the subtree being walked (the identity until a
    // card off the representatives is dealt); reach is kept in the frame's hand order.
    let frame = IDENTITY;
    const board: Card[] = tree.boards[0].slice();
    // Reach of each player along the path: initial weight × own action probabilities (cards blocked → 0).
    let reach: [Float64Array, Float64Array] = [Float64Array.from(e.w[0]), Float64Array.from(e.w[1])];
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
        e.averageStrategyAt(node, sig, new Float64Array(n));
        const r = reach[q], s = step.action * n;
        for (let h = 0; h < n; h++) r[h] *= sig[s + h];
        node = tree.child[node] + step.action;
      } else if (type === NODE_CHANCE) {
        // Any card off the board can come (the full tree has a child for each).
        const card = "card" in step ? step.card : -1;
        if (!(card >= 0 && card < 52) || board.includes(card)) throw new Error(`illegal path at step ${i}: expected a card that can come`);
        const c = permCard(frame, card);
        for (const q of [0, 1] as const) {
          const wc = hands[q].withCard[c];
          for (let j = 0; j < wc.length; j++) reach[q][wc[j]] = 0;
        }
        const b = tree.board[node];
        let k = tree.cards[b]!.indexOf(c);
        if (k < 0) {
          // c = g(rep) for a representative of the solver's tree: continue under rep, in the frame g⁻¹ ∘ frame,
          // where hand h stands for the hand g(h) of the old frame.
          const m = tree.members[b]!;
          const j = m.card.indexOf(c);
          k = 0;
          while (m.start[k + 1] <= j) k++;
          const g = m.perm[j];
          frame = composePerms(PERM_INV[g], frame);
          reach = [0, 1].map((q) => {
            const old = reach[q], hp = e.handPerm[q][g]!;
            const out = new Float64Array(old.length);
            for (let h = 0; h < out.length; h++) out[h] = old[hp[h]];
            return out;
          }) as [Float64Array, Float64Array];
        }
        board.push(card);
        node = tree.child[node] + k;
      } else {
        throw new Error(`illegal path at step ${i}: the hand is over`);
      }
    }

    const result = this.describe(node, reach, frame, board);
    this.cache.set(key, result);
    return result;
  }

  /**
   * The SolutionNode of node `id` of the solver's tree, reached with these reaches (in the frame's hand order)
   * along a path that dealt `board` (real cards). Computed in the frame, then mapped back to real combos.
   */
  private describe(id: number, reach: [Float64Array, Float64Array], frame: number, board: Card[]): SolutionNode {
    const e = this.e;
    const hands = e.hands;
    const tree = e.tree;
    const d = tree.desc[id];
    const type = tree.dType[d];
    // The frame's board: the real board's image, on which the solver's node sits.
    const dead = cardMask(tree.boards[tree.board[id]]);
    // Hands blocked by cards dealt after the start (the lists already exclude the starting board).
    const blocked = hands.map((hl) => {
      const b = new Uint8Array(hl.n);
      for (let h = 0; h < hl.n; h++) b[h] = dead[hl.c1[h]] | dead[hl.c2[h]];
      return b;
    });
    // The real combo of each hand of the frame: the frame's combo mapped back by the inverse permutation.
    const toReal = frame === IDENTITY ? undefined : comboPerm(PERM_INV[frame]);
    const combo = hands.map((hl) => (toReal ? Int32Array.from(hl.combo, (i) => toReal[i]) : hl.combo));

    const ranges = [0, 1].map((q) => {
      const out = new Float32Array(NUM_COMBOS);
      const hl = hands[q], at = combo[q];
      for (let h = 0; h < hl.n; h++) if (!blocked[q][h]) out[at[h]] = reach[q][h];
      return out;
    }) as [Float32Array, Float32Array];

    let strategy: Float32Array[] | undefined;
    if (type === NODE_ACTION) {
      const q = tree.dPlayer[d];
      const hl = hands[q], at = combo[q];
      const A = tree.numChildren(id);
      const sig = new Float64Array(A * hl.n);
      e.averageStrategyAt(id, sig, new Float64Array(hl.n));
      strategy = [];
      for (let a = 0; a < A; a++) {
        const out = new Float32Array(NUM_COMBOS);
        for (let h = 0; h < hl.n; h++) if (!blocked[q][h]) out[at[h]] = sig[a * hl.n + h];
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
      const at = combo[p];
      for (let h = 0; h < me.n; h++) {
        if (!blocked[p][h] && cs[h] > tiny) out[at[h]] = e.out[h] / cs[h];
      }
      return out;
    }) as [Float32Array, Float32Array];

    // node() hands out this cached object on every call for the path, so everything that can be frozen
    // is. Typed arrays with elements can't be frozen: they are documented read-only.
    const freeze = Object.freeze;
    return freeze({
      kind: type === NODE_ACTION ? "action" : type === NODE_CHANCE ? "chance" : "terminal",
      street: STREETS[board.length - 3],
      board: freeze(board.slice()),
      pot: tree.dPot[d],
      bets: freeze([tree.dBets[2 * d], tree.dBets[2 * d + 1]]) as [number, number],
      stacks: freeze([tree.dStacks[2 * d], tree.dStacks[2 * d + 1]]) as [number, number],
      player: type === NODE_ACTION ? (tree.dPlayer[d] as Player) : undefined,
      actions: type === NODE_ACTION ? freeze(tree.dActions[d]!.map((a) => freeze({ ...a }))) : undefined,
      strategy: strategy && freeze(strategy),
      cards: type === NODE_CHANCE ? freeze(remainingCards(board)) : undefined,
      terminal: type === NODE_FOLD ? "fold" : type === NODE_SHOWDOWN ? "showdown" : undefined,
      ranges: freeze(ranges),
      ev: freeze(ev),
    }) as SolutionNode;
  }
}
