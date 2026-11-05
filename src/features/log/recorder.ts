import { fullDeck, type Card } from "../../poker/cards";
import { act, legal, newGame, pot, PUB_TABLE, type Game, type Street } from "../../play/engine";

/** Position names by table size, in preflop action order (the last two are SB and BB). */
export const POSITIONS: Record<number, string[]> = {
  2: ["SB", "BB"], // heads-up: the SB is the button
  3: ["BTN", "SB", "BB"],
  4: ["CO", "BTN", "SB", "BB"],
  5: ["HJ", "CO", "BTN", "SB", "BB"],
  6: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  7: ["UTG", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  8: ["UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  9: PUB_TABLE.seats,
  10: ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
};
export const TABLE_SIZES = Object.keys(POSITIONS).map(Number);
export const positionsFor = (players: number) => POSITIONS[players] ?? PUB_TABLE.seats;
/** The seat that has the dealer button. */
export const buttonSeat = (players: number) => (players === 2 ? "SB" : "BTN");

/**
 * Recording every seat's action in a logged hand. The steps are replayed through
 * the hand-play engine, which keeps track of whose turn it is, what can be called
 * or raised, and the pot. Amounts are in bb; hole cards and the engine's own
 * board are placeholders (the user's board is stored on the hand).
 */

export type StepKind = "fold" | "check" | "call" | "raise";

/** One action. `to` is the street bet total after a bet/raise. `a` marks folds/checks filled in by skipping ahead. */
export interface LogStep {
  s: string;
  k: StepKind;
  to?: number;
  a?: 1;
}

/** Stack used for every seat when nothing else is known. */
export const DEFAULT_STACK_BB = 100;

export interface TableInput {
  heroSeat: string;
  /** My stack in bb, if known. Other seats default to it. */
  heroStack: number | null;
  /** Per-seat starting stacks in bb that differ from the default. */
  stacks: Record<string, number>;
  /** Positions in preflop order (default: 9-handed). */
  seats?: string[];
  /** The BB posts a 1bb ante (default true). */
  bbAnte?: boolean;
  /** Deck to deal from, last card first (see handAnalysis deckFor); default: unshuffled. */
  deck?: Card[];
}

export const baseStack = (t: TableInput) => t.heroStack ?? DEFAULT_STACK_BB;

export function freshGame(t: TableInput): Game {
  const seats = t.seats ?? PUB_TABLE.seats;
  const base = baseStack(t);
  const stacks = seats.map((s) => (s === t.heroSeat ? base : (t.stacks[s] ?? base)));
  // Unshuffled deck unless real cards are given: replays stay deterministic.
  return newGame(base, seats.indexOf(t.heroSeat), t.deck ?? fullDeck(), { seats, bbAnte: t.bbAnte ?? true }, stacks);
}

/** Apply one step if it is legal for the player to act; null otherwise. */
export function applyStep(g: Game, st: LogStep): Game | null {
  if (g.done || g.toAct === null || g.players[g.toAct].seat !== st.s) return null;
  const L = legal(g, g.toAct);
  if (st.k === "check" && !L.canCheck) return null;
  if (st.k === "fold" && L.canCheck) return null;
  if (st.k === "raise" && (!L.canRaise || st.to === undefined || !Number.isFinite(st.to))) return null;
  return act(g, st.k, st.to);
}

/** Replay steps from the start of the hand, stopping at the first one that no longer fits. */
export function replay(t: TableInput, steps: LogStep[]): { game: Game; applied: number } {
  let game = freshGame(t);
  let applied = 0;
  for (const st of steps) {
    const next = applyStep(game, st);
    if (!next) break;
    game = next;
    applied++;
  }
  return { game, applied };
}

function defaultStep(g: Game): LogStep {
  const idx = g.toAct!;
  return { s: g.players[idx].seat, k: legal(g, idx).canCheck ? "check" : "fold", a: 1 };
}

/** Seats still to act on this street, starting with the one to act now. */
export function upcoming(g: Game): string[] {
  const out: string[] = [];
  let cur: Game | null = g;
  while (cur && !cur.done && cur.toAct !== null && cur.street === g.street) {
    const seat = cur.players[cur.toAct].seat;
    if (out.includes(seat)) break;
    out.push(seat);
    cur = applyStep(cur, defaultStep(cur));
  }
  return out;
}

/** Steps that check or fold everyone before `seat`, so `seat` acts next. Empty if `seat` can't be reached this street. */
export function skipTo(g: Game, seat: string): LogStep[] {
  const steps: LogStep[] = [];
  let cur: Game | null = g;
  while (cur && !cur.done && cur.toAct !== null && cur.street === g.street && cur.players[cur.toAct].seat !== seat) {
    const st = defaultStep(cur);
    steps.push(st);
    cur = applyStep(cur, st);
  }
  return cur && cur.toAct !== null && cur.street === g.street && cur.players[cur.toAct].seat === seat ? steps : [];
}

/** Undo the last action together with the skipped seats before it (or just a trailing skip). */
export function undoSteps(steps: LogStep[]): LogStep[] {
  const out = steps.slice();
  const trailingAuto = () => out.length > 0 && out[out.length - 1].a === 1;
  if (trailingAuto()) {
    while (trailingAuto()) out.pop();
    return out;
  }
  out.pop();
  while (trailingAuto()) out.pop();
  return out;
}

const raisesOn = (g: Game, street: Street) => g.log.filter((e) => e.street === street && (e.kind === "raise" || e.kind === "bet")).length;

/** What the next bet or raise by the player to act is called. */
export function raiseVerb(g: Game): string {
  const n = raisesOn(g, g.street);
  if (g.street !== "preflop") return n === 0 ? "벳" : "레이즈";
  if (n === 0) return g.log.some((e) => e.kind === "call") ? "레이즈" : "오픈";
  return `${n + 2}벳`;
}

export interface SizeOption {
  label: string;
  to: number;
}

/** Common bet/raise sizes (street totals, rounded to 0.5bb) that are legal now. */
export function sizeOptions(g: Game): SizeOption[] {
  if (g.done || g.toAct === null) return [];
  const L = legal(g, g.toAct);
  if (!L.canRaise) return [];
  let cands: [string, number][];
  if (g.street === "preflop") {
    cands = raisesOn(g, "preflop") === 0 ? [["", 2], ["", 2.5], ["", 3]] : [["3배", g.currentBet * 3], ["4배", g.currentBet * 4]];
  } else if (g.currentBet === 0) {
    const p = pot(g);
    cands = [["33%", p * 0.33], ["50%", p * 0.5], ["75%", p * 0.75], ["팟", p]];
  } else {
    cands = [["3배", g.currentBet * 3]];
  }
  const seen = new Set<number>();
  return cands
    .map(([label, to]) => ({ label, to: Math.max(L.minRaiseTo, Math.round(to * 2) / 2) }))
    .filter((o) => o.to < L.maxRaiseTo - 1e-9 && !seen.has(o.to) && seen.add(o.to));
}

export interface StreetLine {
  street: Street;
  actions: string[];
  /** Pot at the end of the street (or now, for the current street). */
  pot: number;
}

/**
 * Readable actions per street: "CO 오픈 2.5bb", "BB(나) 콜 7.5bb". Folds are listed only for
 * players who had put chips in voluntarily, and for me; the rest are implied.
 */
export function streetLines(g: Game, fmt: (bb: number) => string): StreetLine[] {
  const lines: StreetLine[] = [];
  const invested = new Set<number>();
  const raises: Record<string, number> = {};
  let limped = false;
  for (const e of g.log) {
    let line = lines[lines.length - 1];
    if (!line || line.street !== e.street) {
      line = { street: e.street, actions: [], pot: e.potAfter };
      lines.push(line);
    }
    line.pot = e.potAfter;
    if (e.kind === "post") continue;
    const p = g.players[e.idx];
    const who = `${e.seat}${p.hero ? "(나)" : ""}`;
    let text: string;
    if (e.kind === "fold") {
      if (!invested.has(e.idx) && !p.hero) continue;
      text = "폴드";
    } else if (e.kind === "check") text = "체크";
    else if (e.kind === "call") {
      const limp = e.street === "preflop" && !raises.preflop;
      if (limp) limped = true;
      text = `${limp ? "림프" : "콜"} ${fmt(e.amount)}`;
    } else {
      const n = raises[e.street] ?? 0;
      raises[e.street] = n + 1;
      const verb = e.street === "preflop" ? (n === 0 ? (limped ? "레이즈" : "오픈") : `${n + 2}벳`) : n === 0 ? "벳" : "레이즈";
      text = `${verb} ${fmt(e.amount)}`;
    }
    if (e.kind === "call" || e.kind === "bet" || e.kind === "raise") invested.add(e.idx);
    line.actions.push(`${who} ${text}${e.allIn ? " 올인" : ""}`);
  }
  return lines;
}

/** Amount label: chips when the big blind in chips is known, otherwise bb. */
export function amountLabel(bb: number, bbChips: number | null): string {
  if (bbChips) return Math.round(bb * bbChips).toLocaleString();
  return `${Math.round(bb * 10) / 10}bb`;
}
