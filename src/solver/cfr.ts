import { buildHands, pairWeight, type HandList } from "./hands";
import { foldValues, RiverCache, showdownValues, type RiverBoard } from "./showdown";
import { buildGameTree, NODE_ACTION, NODE_CHANCE, NODE_FOLD, NODE_SHOWDOWN, treeConfig, type PackedTree } from "./tree";
import type { SolverInput } from "./types";

/** Traversal modes of Engine.walk. */
export const MODE_CFR = 0; // DCFR update for the traversing player, everyone on the current strategy
export const MODE_BR = 1; // best response: traverser takes the max, opponent on the average strategy
export const MODE_AVG = 2; // evaluation: both players on the average strategy

// DCFR parameters (alpha = 1.5, beta = 0, gamma = 2) appear in Engine.discount.

/** inv[h] = 1 / Σ_a max(R[a][h], 0), or 0 when no regret is positive (then the strategy is uniform). */
function positiveRegretInv(R: Float32Array, off: number, A: number, n: number, inv: Float64Array): void {
  for (let h = 0; h < n; h++) inv[h] = 0;
  for (let a = 0; a < A; a++) {
    const b = off + a * n;
    for (let h = 0; h < n; h++) {
      const r = R[b + h];
      if (r > 0) inv[h] += r;
    }
  }
  for (let h = 0; h < n; h++) inv[h] = inv[h] > 0 ? 1 / inv[h] : 0;
}

/** inv[h] = 1 / Σ_a S[a][h], or 0 when the sum is 0 (then the average strategy is uniform). */
function strategySumInv(S: Float32Array, off: number, A: number, n: number, inv: Float64Array): void {
  for (let h = 0; h < n; h++) inv[h] = 0;
  for (let a = 0; a < A; a++) {
    const b = off + a * n;
    for (let h = 0; h < n; h++) inv[h] += S[b + h];
  }
  for (let h = 0; h < n; h++) inv[h] = inv[h] > 0 ? 1 / inv[h] : 0;
}

/**
 * Regret matching for one node: sig[a*n + h] = positive regret share, uniform when none is positive.
 * `inv` is scratch.
 */
export function regretMatch(R: Float32Array, off: number, A: number, n: number, sig: Float64Array, inv: Float64Array): void {
  positiveRegretInv(R, off, A, n, inv);
  const u = 1 / A;
  for (let a = 0; a < A; a++) {
    const b = off + a * n, s = a * n;
    for (let h = 0; h < n; h++) {
      const k = inv[h];
      const r = R[b + h];
      sig[s + h] = k === 0 ? u : r > 0 ? r * k : 0;
    }
  }
}

/** Average strategy for one node: strategy sums normalized per hand, uniform where a hand's sum is 0. */
export function averageStrategy(S: Float32Array, off: number, A: number, n: number, sig: Float64Array, inv: Float64Array): void {
  strategySumInv(S, off, A, n, inv);
  const u = 1 / A;
  for (let a = 0; a < A; a++) {
    const b = off + a * n, s = a * n;
    for (let h = 0; h < n; h++) {
      const k = inv[h];
      sig[s + h] = k === 0 ? u : S[b + h] * k;
    }
  }
}

/**
 * The solver state: tree, hand lists, per-node storage and scratch buffers, plus the one
 * vectorized traversal used for DCFR updates, best responses and evaluation.
 *
 * Nodes are ids of the PackedTree (`tree`); the root is 0. Per-node solver data lives in arrays indexed
 * by node id (`off`, `lastT`), and every action node's regrets and strategy sums live in two big slabs.
 *
 * Discounting is applied lazily: a node's regrets and strategy sums are discounted when the node is
 * next updated, with the product of the factors of every iteration since its last update. Scaling
 * all of a node's strategy sums (or all positive regrets) by one factor doesn't change the normalized
 * strategy, so reads in between see the right strategy.
 */
export class Engine {
  readonly tree: PackedTree;
  /** The root's node id. */
  readonly root = 0;
  readonly hands: [HandList, HandList];
  readonly pot0: number;
  /** Initial weights per hand list (the root reach). */
  readonly w: [Float64Array, Float64Array];
  /** Σ over compatible pairs of w0 × w1: the normalizer for best-response values. */
  readonly pairTotal: number;
  /** Ids of the action nodes, in the order of their storage blocks. */
  readonly actionNodes: Int32Array;
  readonly chanceCount: number;
  readonly terminalCount: number;
  /**
   * Per node: offset of an action node's block in `regret` / `stratSum`, laid out [action][hand]. Int32 when
   * every offset fits (up to 2^31 - 1 entries, 8 GB per array), so the hot loops index with small integers
   * (a Float64Array here costs about 15% on every iteration); Float64 beyond that.
   */
  readonly off: Int32Array | Float64Array;
  /** Per node: the last iteration whose discount has been applied to an action node's storage. */
  readonly lastT: Int32Array;
  /** Regrets and strategy sums, every action node's block at off[node]: [action][hand]. */
  readonly regret: Float32Array;
  readonly stratSum: Float32Array;
  readonly riverCache: RiverCache;
  /** Per board id of the tree: its cached strength order, for the river boards that have showdowns. */
  private readonly riverOf: (RiverBoard | undefined)[] = [];
  /** Iterations done. */
  t = 0;
  /**
   * Skip walking subtrees the opponent doesn't reach (their values are exactly 0; p's strategy sums are
   * still updated by sumOnly). Results are the same either way; tests turn it off to check that.
   */
  pruneUnreached = true;

  // The tree's arrays, held directly for the hot loops (see PackedTree).
  private readonly nDesc: Int32Array;
  private readonly nBoard: Uint16Array;
  private readonly nChild: Int32Array;
  private readonly dType: Uint8Array;
  private readonly dNum: Int32Array;
  private readonly dPlayer: Int8Array;
  private readonly dInvested: Float64Array;

  // Scratch, one set per tree depth so the recursion never allocates.
  private readonly rsBuf: Float64Array[] = [];
  private readonly roBuf: Float64Array[] = [];
  private readonly tmpBuf: Float64Array[] = [];
  private readonly invBuf: Float64Array[] = [];
  private readonly sigBuf: Float64Array[] = [];
  private readonly valBuf: Float64Array[][] = [];
  /** Root output buffer for callers. */
  readonly out: Float64Array;
  // Discount factors computed by discount().
  private pf = 1;
  private nf = 1;
  private sf = 1;

  constructor(input: SolverInput) {
    // Check every input before building the (possibly big) tree, so a bad one fails fast. That includes
    // the ranges giving a game at all: the hand lists are small (a few KB), so they come first too.
    const cfg = treeConfig(input);
    this.hands = buildHands(input.board, input.ranges); // checks the weights (checkRanges)
    if (this.hands[0].n === 0 || this.hands[1].n === 0) throw new Error("both ranges need at least one combo off the board");
    this.pairTotal = pairWeight(this.hands);
    if (!(this.pairTotal > 0)) throw new Error("the ranges have no compatible combos");
    this.w = [Float64Array.from(this.hands[0].weight), Float64Array.from(this.hands[1].weight)];
    this.pot0 = input.pot;
    const tree = buildGameTree(input, cfg);
    this.tree = tree;
    this.chanceCount = tree.chanceCount;
    this.terminalCount = tree.terminalCount;
    this.nDesc = tree.desc;
    this.nBoard = tree.board;
    this.nChild = tree.child;
    this.dType = tree.dType;
    this.dNum = tree.dNum;
    this.dPlayer = tree.dPlayer;
    this.dInvested = tree.dInvested;

    // Storage blocks in node order, and the strength order of every river board with a showdown.
    const N = tree.size;
    let size = 0;
    for (let id = 0; id < N; id++) {
      const d = this.nDesc[id];
      if (this.dType[d] === NODE_ACTION) size += this.dNum[d] * this.hands[this.dPlayer[d]].n;
    }
    this.off = size <= 2 ** 31 - 1 ? new Int32Array(N) : new Float64Array(N);
    this.lastT = new Int32Array(N);
    this.actionNodes = new Int32Array(tree.actionCount);
    this.riverCache = new RiverCache(this.hands);
    size = 0;
    let k = 0;
    for (let id = 0; id < N; id++) {
      const d = this.nDesc[id];
      const type = this.dType[d];
      if (type === NODE_ACTION) {
        this.actionNodes[k++] = id;
        this.off[id] = size;
        size += this.dNum[d] * this.hands[this.dPlayer[d]].n;
      } else if (type === NODE_SHOWDOWN) {
        const b = this.nBoard[id];
        if (!this.riverOf[b]) this.riverOf[b] = this.riverCache.get(tree.boards[b]);
      }
    }
    this.regret = new Float32Array(size);
    this.stratSum = new Float32Array(size);

    const nMax = Math.max(this.hands[0].n, this.hands[1].n);
    const A = tree.maxActions;
    for (let d = 0; d <= tree.maxDepth; d++) {
      this.rsBuf.push(new Float64Array(nMax));
      this.roBuf.push(new Float64Array(nMax));
      this.tmpBuf.push(new Float64Array(nMax));
      this.invBuf.push(new Float64Array(nMax));
      this.sigBuf.push(new Float64Array(A * nMax));
      const vals: Float64Array[] = [];
      for (let a = 0; a < A; a++) vals.push(new Float64Array(nMax));
      this.valBuf.push(vals);
    }
    this.out = new Float64Array(nMax);
  }

  /** The player to act at an action node. */
  player(node: number): number {
    return this.dPlayer[this.nDesc[node]];
  }

  /** The number of actions at an action node (children at any node). */
  numActions(node: number): number {
    return this.dNum[this.nDesc[node]];
  }

  /** Run n DCFR iterations; each updates OOP, then IP (alternating updates). */
  iterate(n: number): void {
    const out = this.out;
    for (let k = 0; k < n; k++) {
      this.t++;
      this.walk(0, 0, MODE_CFR, this.w[0], this.w[1], out, 0);
      this.walk(0, 1, MODE_CFR, this.w[1], this.w[0], out, 0);
    }
  }

  /**
   * Counterfactual values for player p at `node`, written to out[0..n_p):
   * Σ over compatible opponent hands of reachOpp × p's net, chance probabilities folded into reachOpp.
   * `rs` (p's own reach) is only used in MODE_CFR, for the strategy sums.
   */
  walk(node: number, p: number, mode: number, rs: Float64Array, ro: Float64Array, out: Float64Array, d: number): void {
    const desc = this.nDesc[node];
    const type = this.dType[desc];
    if (type === NODE_ACTION) {
      if (this.dPlayer[desc] !== p) this.opponentNode(node, p, mode, rs, ro, out, d);
      else if (mode === MODE_CFR) this.updateNode(node, p, rs, ro, out, d);
      else if (mode === MODE_BR) this.maxNode(node, p, rs, ro, out, d);
      else this.averageNode(node, p, rs, ro, out, d);
    } else if (type === NODE_CHANCE) {
      this.chanceNode(node, p, mode, rs, ro, out, d);
    } else if (type === NODE_FOLD) {
      // The folder nets -x_f, the winner P0 + x_f.
      const x = this.dInvested[desc];
      foldValues(this.hands[p], this.hands[1 - p], ro, p === this.dPlayer[desc] ? 0 - x : this.pot0 + x, out);
    } else {
      showdownValues(this.riverOf[this.nBoard[node]]!, p, ro, this.pot0, this.dInvested[desc], out);
    }
  }

  /**
   * Apply every node's pending discount now, so the raw regret and strategy-sum arrays are what an
   * eager implementation would hold. Not needed for solving or for reading strategies.
   */
  syncDiscounts(): void {
    const R = this.regret, S = this.stratSum;
    for (const node of this.actionNodes) {
      if (this.lastT[node] === this.t) continue;
      this.discount(node);
      const pf = this.pf, nf = this.nf, sf = this.sf;
      const off = this.off[node];
      const end = off + this.numActions(node) * this.hands[this.player(node)].n;
      for (let i = off; i < end; i++) {
        const r = R[i];
        R[i] = r > 0 ? r * pf : r * nf;
        S[i] *= sf;
      }
    }
  }

  /** Discount factors for a node whose storage was last discounted at iteration lastT[node]. */
  private discount(node: number): void {
    let pf = 1, nf = 1, sf = 1;
    for (let k = this.lastT[node] + 1; k <= this.t; k++) {
      const ka = k * Math.sqrt(k); // k^1.5
      pf *= ka / (ka + 1);
      nf *= 0.5;
      const q = k / (k + 1);
      sf *= q * q;
    }
    this.lastT[node] = this.t;
    this.pf = pf;
    this.nf = nf;
    this.sf = sf;
  }

  /** p's own node in a DCFR update: recurse with reach × σ_a, then update regrets and strategy sums. */
  private updateNode(node: number, p: number, rs: Float64Array, ro: Float64Array, out: Float64Array, d: number): void {
    const first = this.nChild[node];
    const A = this.dNum[this.nDesc[node]];
    const n = this.hands[p].n;
    const off = this.off[node];
    const R = this.regret, S = this.stratSum;
    const sig = this.sigBuf[d];
    const vals = this.valBuf[d];
    const crs = this.rsBuf[d];
    const inv = this.invBuf[d];
    // Current strategy by regret matching, computed action by action together with the child reach.
    positiveRegretInv(R, off, A, n, inv);
    const u = 1 / A;
    for (let a = 0; a < A; a++) {
      const s = a * n, b = off + s;
      for (let h = 0; h < n; h++) {
        const k = inv[h];
        const r = R[b + h];
        const x = k === 0 ? u : r > 0 ? r * k : 0;
        sig[s + h] = x;
        crs[h] = rs[h] * x;
      }
      this.walk(first + a, p, MODE_CFR, crs, ro, vals[a], d + 1);
    }
    // Node value v = Σ σ_a v_a.
    const v0 = vals[0];
    for (let h = 0; h < n; h++) out[h] = sig[h] * v0[h];
    for (let a = 1; a < A; a++) {
      const va = vals[a], s = a * n;
      for (let h = 0; h < n; h++) out[h] += sig[s + h] * va[h];
    }
    // Discount the stored values (lazily, covering any iterations this node was skipped), then add
    // regret_a += v_a - v and strategySum_a += reachSelf × σ_a.
    // Branch-free form of (r > 0 ? r × pf : r × nf): r (pf + nf) / 2 + |r| (pf - nf) / 2.
    this.discount(node);
    const hs = (this.pf + this.nf) / 2, hd = (this.pf - this.nf) / 2, sf = this.sf;
    for (let a = 0; a < A; a++) {
      const va = vals[a], s = a * n, b = off + s;
      for (let h = 0; h < n; h++) {
        const r = R[b + h];
        R[b + h] = r * hs + Math.abs(r) * hd + va[h] - out[h];
        S[b + h] = S[b + h] * sf + rs[h] * sig[s + h];
      }
    }
  }

  /** p's own node in a best response: per-hand maximum over actions. */
  private maxNode(node: number, p: number, rs: Float64Array, ro: Float64Array, out: Float64Array, d: number): void {
    const first = this.nChild[node];
    const A = this.dNum[this.nDesc[node]];
    const n = this.hands[p].n;
    const tmp = this.tmpBuf[d];
    this.walk(first, p, MODE_BR, rs, ro, out, d + 1);
    for (let a = 1; a < A; a++) {
      this.walk(first + a, p, MODE_BR, rs, ro, tmp, d + 1);
      for (let h = 0; h < n; h++) if (tmp[h] > out[h]) out[h] = tmp[h];
    }
  }

  /** p's own node when evaluating the average strategy: v = Σ σ̄_a v_a. */
  private averageNode(node: number, p: number, rs: Float64Array, ro: Float64Array, out: Float64Array, d: number): void {
    const first = this.nChild[node];
    const A = this.dNum[this.nDesc[node]];
    const n = this.hands[p].n;
    const sig = this.sigBuf[d];
    const tmp = this.tmpBuf[d];
    averageStrategy(this.stratSum, this.off[node], A, n, sig, this.invBuf[d]);
    for (let h = 0; h < n; h++) out[h] = 0;
    for (let a = 0; a < A; a++) {
      this.walk(first + a, p, MODE_AVG, rs, ro, tmp, d + 1);
      const s = a * n;
      for (let h = 0; h < n; h++) out[h] += sig[s + h] * tmp[h];
    }
  }

  /**
   * The opponent's node: v = Σ_a cfv(child_a, reachOpp × σ_a). A child the opponent never reaches has
   * value 0 and isn't walked; in a DCFR update only p's strategy sums are refreshed there (sumOnly).
   */
  private opponentNode(node: number, p: number, mode: number, rs: Float64Array, ro: Float64Array, out: Float64Array, d: number): void {
    const first = this.nChild[node];
    const A = this.dNum[this.nDesc[node]];
    const nO = this.hands[1 - p].n;
    const nP = this.hands[p].n;
    const inv = this.invBuf[d];
    // The opponent's strategy: current (regret matching) when training, average otherwise.
    const cfr = mode === MODE_CFR;
    const store = cfr ? this.regret : this.stratSum;
    const off = this.off[node];
    if (cfr) positiveRegretInv(store, off, A, nO, inv);
    else strategySumInv(store, off, A, nO, inv);
    const u = 1 / A;
    const cro = this.roBuf[d];
    const tmp = this.tmpBuf[d];
    let started = false;
    for (let a = 0; a < A; a++) {
      const b = off + a * nO;
      let sum = 0;
      if (cfr) {
        for (let o = 0; o < nO; o++) {
          const k = inv[o];
          const r = store[b + o];
          const v = ro[o] * (k === 0 ? u : r > 0 ? r * k : 0);
          cro[o] = v;
          sum += v;
        }
      } else {
        for (let o = 0; o < nO; o++) {
          const k = inv[o];
          const v = ro[o] * (k === 0 ? u : store[b + o] * k);
          cro[o] = v;
          sum += v;
        }
      }
      if (sum <= 0 && this.pruneUnreached) {
        // The opponent never takes this action: p's values below are exactly 0 (reach is never negative).
        if (cfr) this.sumOnly(first + a, p, rs, d + 1);
        continue;
      }
      if (!started) {
        this.walk(first + a, p, mode, rs, cro, out, d + 1);
        started = true;
      } else {
        this.walk(first + a, p, mode, rs, cro, tmp, d + 1);
        for (let h = 0; h < nP; h++) out[h] += tmp[h];
      }
    }
    if (!started) for (let h = 0; h < nP; h++) out[h] = 0;
  }

  /**
   * Chance node: for each card, zero both players' hands holding it, scale the opponent's reach by
   * 1 / (52 - |board| - 4) (the card's probability given both hands), and add the child's value with
   * p's hands holding the card zeroed. Cards the opponent can't have reach for are handled like
   * unreached actions in opponentNode.
   */
  private chanceNode(node: number, p: number, mode: number, rs: Float64Array, ro: Float64Array, out: Float64Array, d: number): void {
    const me = this.hands[p], opp = this.hands[1 - p];
    const nP = me.n, nO = opp.n;
    const b = this.nBoard[node];
    const cards = this.tree.cards[b]!;
    const first = this.nChild[node];
    const scale = 1 / (52 - this.tree.boards[b].length - 4);
    const crs = this.rsBuf[d], cro = this.roBuf[d], tmp = this.tmpBuf[d];
    for (let h = 0; h < nP; h++) out[h] = 0;
    for (let k = 0; k < cards.length; k++) {
      const c = cards[k];
      for (let o = 0; o < nO; o++) cro[o] = ro[o] * scale;
      const oc = opp.withCard[c];
      for (let j = 0; j < oc.length; j++) cro[oc[j]] = 0;
      let any = false;
      for (let o = 0; o < nO; o++) {
        if (cro[o] !== 0) {
          any = true;
          break;
        }
      }
      const mc = me.withCard[c];
      let childRs = rs;
      if (mode === MODE_CFR) {
        for (let h = 0; h < nP; h++) crs[h] = rs[h];
        for (let j = 0; j < mc.length; j++) crs[mc[j]] = 0;
        childRs = crs;
      }
      if (!any && this.pruneUnreached) {
        if (mode === MODE_CFR) this.sumOnly(first + k, p, crs, d + 1);
        continue;
      }
      this.walk(first + k, p, mode, childRs, cro, tmp, d + 1);
      for (let j = 0; j < mc.length; j++) tmp[mc[j]] = 0;
      for (let h = 0; h < nP; h++) out[h] += tmp[h];
    }
  }

  /**
   * DCFR update of a subtree the opponent doesn't reach this iteration. Every counterfactual value
   * there is exactly 0, so regrets only get their discount, but p's strategy sums must still add
   * reachSelf × σ as in a full traversal (skipping that hurts the average strategy's convergence a lot).
   * No terminal is evaluated, which is what makes this cheaper than the full walk.
   */
  private sumOnly(node: number, p: number, rs: Float64Array, d: number): void {
    const desc = this.nDesc[node];
    const type = this.dType[desc];
    if (type === NODE_ACTION) {
      const first = this.nChild[node];
      const A = this.dNum[desc];
      if (this.dPlayer[desc] !== p) {
        for (let a = 0; a < A; a++) this.sumOnly(first + a, p, rs, d + 1);
        return;
      }
      const n = this.hands[p].n;
      const off = this.off[node];
      const R = this.regret, S = this.stratSum;
      const inv = this.invBuf[d], crs = this.rsBuf[d];
      positiveRegretInv(R, off, A, n, inv);
      this.discount(node);
      const hs = (this.pf + this.nf) / 2, hd = (this.pf - this.nf) / 2, sf = this.sf;
      const u = 1 / A;
      for (let a = 0; a < A; a++) {
        const b = off + a * n;
        let sum = 0;
        for (let h = 0; h < n; h++) {
          const k = inv[h];
          const r = R[b + h];
          const x = rs[h] * (k === 0 ? u : r > 0 ? r * k : 0);
          crs[h] = x;
          sum += x;
          R[b + h] = r * hs + Math.abs(r) * hd;
          S[b + h] = S[b + h] * sf + x;
        }
        if (sum > 0) this.sumOnly(first + a, p, crs, d + 1);
      }
    } else if (type === NODE_CHANCE) {
      const me = this.hands[p];
      const nP = me.n;
      const cards = this.tree.cards[this.nBoard[node]]!;
      const first = this.nChild[node];
      const crs = this.rsBuf[d];
      for (let k = 0; k < cards.length; k++) {
        for (let h = 0; h < nP; h++) crs[h] = rs[h];
        const mc = me.withCard[cards[k]];
        for (let j = 0; j < mc.length; j++) crs[mc[j]] = 0;
        this.sumOnly(first + k, p, crs, d + 1);
      }
    }
  }
}
