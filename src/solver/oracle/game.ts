import type { Card } from "../../poker/cards";
import { evaluate } from "../../poker/evaluator";
import { COMBOS } from "../../play/handInfo";
import type { Player, SolverInput } from "../types";
import { oracleTree, type OracleNode } from "./tree";

/**
 * The game around the oracle tree: who holds what, which hand pairs can happen,
 * terminal payoffs and chance probabilities. Everything is explicit and per pair.
 */

export interface OracleHand {
  /** Index into COMBOS. */
  combo: number;
  cards: [Card, Card];
  /** Initial range weight (> 0). */
  weight: number;
}

/** A player's hands: COMBOS indices with weight > 0 that don't touch the starting board. */
export function oracleHands(input: SolverInput, player: Player): OracleHand[] {
  const weights = input.ranges[player];
  const out: OracleHand[] = [];
  for (let i = 0; i < COMBOS.length; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    const [a, b] = COMBOS[i].cards;
    if (input.board.includes(a) || input.board.includes(b)) continue;
    out.push({ combo: i, cards: [a, b], weight: w });
  }
  return out;
}

/** True when the two card lists share a card. */
export function sharesCard(a: readonly Card[], b: readonly Card[]): boolean {
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

/** Two hands can be dealt together when they share no card. */
export function compatible(h: OracleHand, o: OracleHand): boolean {
  return !sharesCard(h.cards, o.cards);
}

/** Probability of each card that can come at a chance node with this board (given both hands). */
export function chanceProbability(board: readonly Card[]): number {
  return 1 / (52 - board.length - 4);
}

/**
 * Net of player 0 at a terminal for one pair of hands (player 1's net is P0 minus this).
 * - Fold by f: winner P0 + x_f, folder −x_f.
 * - Showdown (equal contributions x): winner P0 + x, loser −x, tie P0/2 each.
 */
export function terminalNet0(node: OracleNode, P0: number, h0: OracleHand, h1: OracleHand): number {
  if (node.kind !== "terminal") throw new Error("oracle: not a terminal node");
  if (node.terminal === "fold") {
    const f = node.folder!;
    const xf = node.contributions[f];
    return f === 0 ? -xf : P0 + xf;
  }
  const [x, x1] = node.contributions;
  if (Math.abs(x - x1) > 1e-9) throw new Error("oracle: showdown with unequal contributions");
  if (node.board.length !== 5) throw new Error("oracle: showdown before the river");
  const s0 = evaluate([...node.board, ...h0.cards], 7);
  const s1 = evaluate([...node.board, ...h1.cards], 7);
  if (s0 > s1) return P0 + x;
  if (s0 < s1) return -x;
  return P0 / 2;
}

/** The game: tree, hand lists and a per-board hand strength cache. */
export class OracleGame {
  readonly input: SolverInput;
  readonly P0: number;
  readonly root: OracleNode;
  readonly hands: [OracleHand[], OracleHand[]];
  /** Showdown strengths per river board: [player 0 by hand index, player 1 by hand index], NaN when blocked. */
  private readonly strengthByBoard = new Map<string, [Float64Array, Float64Array]>();
  private readonly strengthByNode = new WeakMap<OracleNode, [Float64Array, Float64Array]>();

  /** compat[i0 * n1 + i1] = 1 when player 0's hand i0 and player 1's hand i1 share no card. */
  private readonly compat: Uint8Array;

  constructor(input: SolverInput) {
    this.input = input;
    this.P0 = input.pot;
    this.root = oracleTree(input);
    this.hands = [oracleHands(input, 0), oracleHands(input, 1)];
    const [H0, H1] = this.hands;
    this.compat = new Uint8Array(H0.length * H1.length);
    for (let i0 = 0; i0 < H0.length; i0++) {
      for (let i1 = 0; i1 < H1.length; i1++) this.compat[i0 * H1.length + i1] = compatible(H0[i0], H1[i1]) ? 1 : 0;
    }
  }

  /** True when p's hand i and the opponent's hand j share no card. */
  canPair(p: Player, i: number, j: number): boolean {
    const n1 = this.hands[1].length;
    return (p === 0 ? this.compat[i * n1 + j] : this.compat[j * n1 + i]) === 1;
  }

  /** evaluate() of board + hand for every hand of both players (NaN for hands that touch the board). */
  private strengths(node: OracleNode): [Float64Array, Float64Array] {
    let s = this.strengthByNode.get(node);
    if (s) return s;
    const key = [...node.board].sort((a, b) => a - b).join(",");
    s = this.strengthByBoard.get(key);
    if (!s) {
      const one = (hands: OracleHand[]) =>
        Float64Array.from(hands, (h) => (sharesCard(h.cards, node.board) ? NaN : evaluate([...node.board, ...h.cards], 7)));
      s = [one(this.hands[0]), one(this.hands[1])];
      this.strengthByBoard.set(key, s);
    }
    this.strengthByNode.set(node, s);
    return s;
  }

  /**
   * Net of player p at a terminal, holding own hand i (index in p's list) against opponent
   * hand j. The caller must only ask for pairs that can occur here (no shared card); hands
   * blocked by the board give NaN at a showdown.
   */
  terminalNet(p: Player, node: OracleNode, i: number, j: number): number {
    if (node.kind !== "terminal") throw new Error("oracle: not a terminal node");
    const [i0, i1] = p === 0 ? [i, j] : [j, i];
    let net0: number;
    if (node.terminal === "fold") {
      // net_w = P0 + x_f, net_f = −x_f
      const f = node.folder!;
      const xf = node.contributions[f];
      net0 = f === 0 ? -xf : this.P0 + xf;
    } else {
      const [x, x1] = node.contributions;
      if (Math.abs(x - x1) > 1e-9) throw new Error("oracle: showdown with unequal contributions");
      const [s0, s1] = this.strengths(node);
      const a = s0[i0];
      const b = s1[i1];
      if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
      net0 = a > b ? this.P0 + x : a < b ? -x : this.P0 / 2;
    }
    return p === 0 ? net0 : this.P0 - net0;
  }

  /**
   * Σ_j oppReach[j] × net_p(i, j) at a terminal, over the opponent hands j that share no card
   * with p's hand i. This is the same sum as calling terminalNet for each pair, with the
   * per-terminal lookups hoisted out of the loop.
   */
  terminalValue(p: Player, node: OracleNode, i: number, oppReach: Float64Array): number {
    if (node.kind !== "terminal") throw new Error("oracle: not a terminal node");
    const P0 = this.P0;
    if (node.terminal === "fold") {
      // net_w = P0 + x_f, net_f = −x_f; the same for every pair, so sum the compatible reach.
      const f = node.folder!;
      const xf = node.contributions[f];
      const netP = p === f ? -xf : P0 + xf;
      let reach = 0;
      for (let j = 0; j < oppReach.length; j++) if (oppReach[j] !== 0 && this.canPair(p, i, j)) reach += oppReach[j];
      return netP * reach;
    }
    const [x, x1] = node.contributions;
    if (Math.abs(x - x1) > 1e-9) throw new Error("oracle: showdown with unequal contributions");
    const [s0, s1] = this.strengths(node);
    const mine = (p === 0 ? s0 : s1)[i];
    const theirs = p === 0 ? s1 : s0;
    if (Number.isNaN(mine)) throw new Error("oracle: own hand is blocked by the board at a showdown");
    let v = 0;
    for (let j = 0; j < oppReach.length; j++) {
      const r = oppReach[j];
      if (r === 0 || !this.canPair(p, i, j)) continue;
      const t = theirs[j];
      if (Number.isNaN(t)) throw new Error("oracle: an opponent hand blocked by the board still has reach");
      // winner P0 + x, loser −x, tie P0 / 2
      v += r * (mine > t ? P0 + x : mine < t ? -x : P0 / 2);
    }
    return v;
  }

  /** Σ over compatible pairs of w0 × w1 with the initial weights (the normalizer for BR and values). */
  pairWeightSum(): number {
    let sum = 0;
    for (const h0 of this.hands[0]) for (const h1 of this.hands[1]) if (compatible(h0, h1)) sum += h0.weight * h1.weight;
    return sum;
  }
}
