import { averageStrategy, MODE_AVG, type Engine } from "./cfr";
import { cardMask, compatibleSums, NUM_COMBOS } from "./hands";
import { NODE_ACTION, NODE_CHANCE, type GameNode } from "./tree";
import type { PathStep, Player, Solution, SolutionNode } from "./types";

const isAction = (s: PathStep): s is { action: number } => typeof s === "object" && s !== null && "action" in s;
const isCard = (s: PathStep): s is { card: number } => typeof s === "object" && s !== null && "card" in s;

/**
 * A view of the solver's current average strategy. It reads the solver's live arrays, so it is only
 * valid until the next iterate(); after that node() throws "stale solution".
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
    const key = path.map((s) => (isAction(s) ? `a${s.action}` : isCard(s) ? `c${s.card}` : "?")).join(".");
    const hit = this.cache.get(key);
    if (hit) return hit;

    const e = this.e;
    const hands = e.hands;
    // Reach of each player along the path: initial weight × own action probabilities (cards blocked → 0).
    const reach: [Float64Array, Float64Array] = [Float64Array.from(e.w[0]), Float64Array.from(e.w[1])];
    let node: GameNode = e.root;
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      if (node.type === NODE_ACTION) {
        const A = node.children.length;
        if (!isAction(step) || !Number.isInteger(step.action) || step.action < 0 || step.action >= A)
          throw new Error(`illegal path at step ${i}: expected an action index 0..${A - 1}`);
        const q = node.player!;
        const n = hands[q].n;
        const sig = new Float64Array(A * n);
        averageStrategy(e.stratSum, node.off, A, n, sig, new Float64Array(n));
        const r = reach[q], s = step.action * n;
        for (let h = 0; h < n; h++) r[h] *= sig[s + h];
        node = node.children[step.action];
      } else if (node.type === NODE_CHANCE) {
        const k = isCard(step) ? node.cards!.indexOf(step.card) : -1;
        if (k < 0) throw new Error(`illegal path at step ${i}: expected a card that can come`);
        const c = node.cards![k];
        for (const q of [0, 1] as const) {
          const wc = hands[q].withCard[c];
          for (let j = 0; j < wc.length; j++) reach[q][wc[j]] = 0;
        }
        node = node.children[k];
      } else {
        throw new Error(`illegal path at step ${i}: the hand is over`);
      }
    }

    const result = this.describe(node, reach);
    this.cache.set(key, result);
    return result;
  }

  private describe(node: GameNode, reach: [Float64Array, Float64Array]): SolutionNode {
    const e = this.e;
    const hands = e.hands;
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
      const A = node.children.length;
      const sig = new Float64Array(A * hl.n);
      averageStrategy(e.stratSum, node.off, A, hl.n, sig, new Float64Array(hl.n));
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
      e.walk(node, p, MODE_AVG, reach[p], reach[1 - p], e.out, 0);
      const tiny = total * 1e-12; // below this the compatible reach is zero up to rounding
      for (let h = 0; h < me.n; h++) {
        if (!blocked[p][h] && cs[h] > tiny) out[me.combo[h]] = e.out[h] / cs[h];
      }
      return out;
    }) as [Float32Array, Float32Array];

    return {
      kind: node.kind,
      street: node.street,
      board: node.board.slice(),
      pot: node.pot,
      bets: [node.bets[0], node.bets[1]],
      stacks: [node.stacks[0], node.stacks[1]],
      player: node.player as Player | undefined,
      actions: node.actions?.map((a) => ({ ...a })),
      strategy,
      cards: node.cards?.slice(),
      terminal: node.terminal,
      ranges,
      ev,
    };
  }
}
