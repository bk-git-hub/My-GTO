import { canonicalBoard, comboIndex, mapComboSuits, type DecodedFlop, type DecodedNode } from "../presolve/format";
import type { Card } from "../poker/cards";
import type { Game } from "./engine";
import { flopPair, matchableLines, matchPack, pendingPacks, type PackInfo, type PackMatch } from "./packMatch";
import type { MoveOption } from "./policy";
import type { LoadKey, PlayState, PostflopOracle } from "./table";

/**
 * A matched solver pack read at the AI table's flop decisions: the real flop actions mapped onto the pack's tree, the
 * node's actions in real chips, each combo's row (frequencies, EVs, reach) and the hero's grade against it. Only the
 * flop: turn and river have no stored nodes (a live turn solve is later work). Pure.
 *
 * Real sizes are the pack's `to` times the real flop pot over the pack's (potScale): linear in the pot along a line, so
 * a 33% bet stays 33% and the check-raise keeps the solver's rule. A real action the tree doesn't have leaves the tree
 * for the rest of the flop (OffTree), and those decisions fall back to the approximate rules.
 */

export type OffTree = "donk" | "size" | "reraise" | "allin" | "stack" | "node";
export const OFF_TEXT: Record<OffTree, string> = {
  donk: "동크 벳",
  size: "다른 벳 크기",
  reraise: "리레이즈",
  allin: "올인",
  stack: "스택이 달라 올인",
  node: "저장 안 된 노드",
};

/** Real size within this factor of the pack's: the same action. */
export const SIZE_TOL = 1.35;

export interface OracleAction {
  kind: MoveOption["kind"];
  /** Street total after the action (real chips); 0 for fold and check. */
  to: number;
  /** "체크", "벳 33% (2.0)", "레이즈 7.8", "콜 2.0", "폴드". */
  label: string;
  /** The pack's own label ("벳 33%"). */
  packLabel: string;
}

export interface PackRow {
  freq: number[];
  ev: number[];
  reach: number;
}

export interface OracleSpot {
  source: "pack";
  level: "exact" | "approx";
  packId: string;
  title: string;
  reasons: string[];
  path: number[];
  /** The node's pot, pack units. */
  nodePot: number;
  potScale: number;
  actions: OracleAction[];
  /** OOP's root: the tree only checks there (no lead), a limit of the tree, not a solver result. */
  oopRoot: boolean;
  /** The actor's row for a real COMBOS index, or null when the pack doesn't hold that combo here. */
  row(combo: number): PackRow | null;
  /** The combo is in the actor's starting range of the pack. */
  inRange(combo: number): boolean;
}

const LN_TOL = Math.log(SIZE_TOL);

const packAllIn = (node: DecodedNode, a: number) => {
  const act = node.actions[a];
  return act.kind === "allin" || act.to >= node.stacks[node.player] + node.bets[node.player] - 0.01;
};

/** The pack node the real flop line has reached, or why it left the tree. */
export function flopPath(g: Game, m: PackMatch, flop: DecodedFlop): { path: number[] } | { off: OffTree } {
  const path: number[] = [];
  for (const e of g.log) {
    if (e.street !== "flop" || e.kind === "post") continue;
    const node = flop.node(path);
    if (!node || m.seats[node.player] !== e.idx) return { off: "node" };
    const acts = node.actions;
    let a = -1;
    if (e.kind === "check") a = acts.findIndex((x) => x.kind === "check");
    else if (e.kind === "fold") a = acts.findIndex((x) => x.kind === "fold");
    else if (e.kind === "call") {
      a = acts.findIndex((x) => x.kind === "call");
      if (a >= 0 && e.allIn && !packAllIn(node, a)) return { off: "stack" };
    } else {
      const facing = node.bets[1 - node.player] > node.bets[node.player];
      const cands = acts.map((x, i) => ({ x, i })).filter(({ x }) => (facing ? x.kind === "raise" || x.kind === "allin" : x.kind === "bet" || x.kind === "allin"));
      if (!cands.length) return { off: facing ? "reraise" : path.length === 0 && node.player === 0 ? "donk" : "size" };
      let best = -1, bestD = Infinity;
      for (const { x, i } of cands) {
        const d = Math.abs(Math.log(e.amount / (x.to * m.potScale)));
        if (d < bestD) [best, bestD] = [i, d];
      }
      if (bestD > LN_TOL) return { off: e.allIn ? "allin" : "size" };
      if (e.allIn && !packAllIn(node, best)) return { off: "stack" };
      a = best;
    }
    if (a < 0) return { off: "node" };
    path.push(a);
  }
  return { path };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

function search(arr: Uint16Array, x: number): number {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === x) return mid;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** The pack spot of seat `idx` (the actor at the reached node), off-tree, or null when it isn't its pack decision. */
export function packSpot(s: PlayState, idx: number, m: PackMatch, flop: DecodedFlop): OracleSpot | { off: OffTree } | null {
  const g = s.game;
  if (g.street !== "flop" || g.board.length !== 3) return null;
  const r = flopPath(g, m, flop);
  if ("off" in r) return r;
  const node = flop.node(r.path);
  if (!node) return { off: "node" };
  if (m.seats[node.player] !== idx) return null;
  const me = g.players[idx];
  const allInTo = me.streetBet + me.stack;
  const { suitMap } = canonicalBoard(g.board.slice(0, 3));
  const start = flop.ranges[node.player];
  const actions = node.actions.map((a): OracleAction => {
    if (a.kind === "check") return { kind: "check", to: 0, label: "체크", packLabel: a.label };
    if (a.kind === "fold") return { kind: "fold", to: 0, label: "폴드", packLabel: a.label };
    if (a.kind === "call") return { kind: "call", to: g.currentBet, label: `콜 ${r1(Math.min(g.currentBet - me.streetBet, me.stack))}`, packLabel: a.label };
    const to = Math.min(allInTo, r2(a.to * m.potScale));
    const allIn = to >= allInTo - 1e-9;
    const word = allIn ? "올인" : a.kind === "bet" ? `${a.label.replace(/\s*[\d.]+$/, "")}` : "레이즈";
    return { kind: "raise", to, label: a.kind === "bet" && !allIn ? `${word} (${r1(to)})` : `${word} ${r1(to)}`, packLabel: a.label };
  });
  const canon = (combo: number) => mapComboSuits(combo, suitMap);
  return {
    source: "pack",
    level: m.level,
    packId: m.packId,
    title: m.title,
    reasons: m.reasons,
    path: r.path,
    nodePot: node.pot,
    potScale: m.potScale,
    actions,
    oopRoot: r.path.length === 0 && node.player === 0 && !node.actions.some((a) => a.kind === "bet"),
    row(combo) {
      const j = search(node.combos, canon(combo));
      if (j < 0) return null;
      return { freq: node.strategy.map((x) => x[j]), ev: node.ev.map((x) => x[j]), reach: node.reach[j] };
    },
    inRange: (combo) => (start[canon(combo)] ?? 0) > 0,
  };
}

/** play/ copy of the solver page's EV tolerance (features/solver/view.ts evTolerance), which play/ must not import. */
export const evTolerance = (pot: number) => Math.max(0.05, 0.005 * pot);

export interface PackGrade {
  grade: "good" | "ok" | "mistake";
  /** EV lost against the best action, pack units (bb in an exact match). */
  loss: number;
  /** loss ÷ the node's pot. */
  lossPct: number;
  freq: number;
  best: number;
}

/**
 * The grade of action `chosen` with `combo` at a pack node, EV first (EVs are reliable for low-reach combos whose
 * frequencies may not have converged): good within the EV tolerance or 1% of the pot, or a mix of 5%+ at reach 0.1+;
 * ok within 5% of the pot (10% in an approximate match); else a mistake. Null without a row or an EV.
 */
export function gradeAtNode(sp: OracleSpot, combo: number, chosen: number): PackGrade | null {
  const row = sp.row(combo);
  if (!row) return null;
  const evs = row.ev.map((x, i) => ({ x, i })).filter(({ x }) => Number.isFinite(x));
  const mine = row.ev[chosen];
  if (!evs.length || !Number.isFinite(mine)) return null;
  const top = evs.reduce((b, e) => (e.x > b.x ? e : b));
  const loss = Math.max(0, top.x - mine);
  const lossPct = sp.nodePot > 0 ? loss / sp.nodePot : 0;
  const freq = row.freq[chosen] ?? 0;
  const grade = loss <= evTolerance(sp.nodePot) || lossPct <= 0.01 || (freq >= 0.05 && row.reach >= 0.1) ? "good" : lossPct <= (sp.level === "exact" ? 0.05 : 0.1) ? "ok" : "mistake";
  return { grade, loss, lossPct, freq, best: top.i };
}

/** The hero is in the hand, exactly two players are live and neither is all-in: a flop a heads-up pack can stand for. */
export function packEligible(s: PlayState): boolean {
  const g = s.game;
  if (g.players[s.heroIdx].folded) return false;
  const pair = flopPair(g);
  return !!pair && pair.every((i) => !g.players[i].allIn);
}

export interface OracleSource {
  /** The registry, or null until the manifest is loaded. */
  packs(): readonly PackInfo[] | null;
  /** A decoded flop file already loaded, or null. */
  flop(path: string): DecodedFlop | null;
}

/**
 * The AI table's postflop oracle over a pack source: what must load first (the manifest when a flop is dealt, then the
 * matched file), the match itself, and the pack spot of a seat. Synchronous; packSource.ts does the loading.
 */
export function createOracle(src: OracleSource): PostflopOracle {
  return {
    needs(s: PlayState): LoadKey | null {
      const g = s.game;
      if (!s.profiles || g.done || g.street !== "flop" || s.post?.failed) return null;
      if (g.players[s.heroIdx].folded) return null;
      // The manifest only where some pack could match (not for a limped pot or a line off the charts), then, in one load,
      // the file lists of the packs that could match this flop (the catalog lists packs without their files).
      if (s.post === undefined) {
        if (!packEligible(s) || !matchableLines(s)) return null;
        const packs = src.packs();
        if (!packs) return { kind: "manifest" };
        const ids = pendingPacks(s, packs);
        return ids.length ? { kind: "packs", ids } : null;
      }
      const m = s.post.match;
      return m && !src.flop(m.file.path) ? { kind: "flop", path: m.file.path } : null;
    },
    match(s: PlayState) {
      const packs = src.packs();
      return packs && packEligible(s) ? matchPack(s, packs) : null;
    },
    spot(s: PlayState, idx: number) {
      const m = s.post?.match;
      if (!m || s.post?.failed || s.game.street !== "flop" || s.game.players[s.heroIdx].folded) return null;
      const flop = src.flop(m.file.path);
      return flop ? packSpot(s, idx, m, flop) : null;
    },
  };
}

/** COMBOS index of two hole cards. */
export const comboOf = (cards: readonly Card[]) => comboIndex(cards[0], cards[1]);
