import { fullDeck, type Card } from "../../poker/cards";
import { act, legal, newGame, pot, PUB_TABLE, type Game, type LogEntry, type Street } from "../../play/engine";

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

/**
 * One action. `to` is the street bet total after a bet/raise. `a` marks folds/checks filled in by
 * skipping ahead. `all` marks an all-in: it replays as everything the seat has (whatever its stack turns
 * out to be once the level or the stacks are corrected), and as an all-in call when that can't raise.
 */
export interface LogStep {
  s: string;
  k: StepKind;
  to?: number;
  a?: 1;
  all?: 1;
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

/**
 * What a step does at this point of the hand, or null when it doesn't fit: an all-in (`all`) raises to
 * the seat's whole stack, and a raise to all of it or more that the stack can't make (it no longer
 * covers more than the bet, or nobody is left to respond) is an all-in call.
 */
export function resolveStep(g: Game, st: LogStep): { k: StepKind; to?: number } | null {
  if (g.done || g.toAct === null || g.players[g.toAct].seat !== st.s) return null;
  const L = legal(g, g.toAct);
  if (st.k === "check") return L.canCheck ? { k: "check" } : null;
  if (st.k === "fold") return L.canCheck ? null : { k: "fold" };
  if (st.k === "call") return { k: "call" };
  const shove = st.all === 1 || (st.to !== undefined && Number.isFinite(st.to) && st.to >= L.maxRaiseTo - 1e-9);
  if (!L.canRaise) return shove && !L.canCheck ? { k: "call" } : null;
  if (st.all === 1) return { k: "raise", to: L.maxRaiseTo };
  if (st.to === undefined || !Number.isFinite(st.to)) return null;
  return { k: "raise", to: st.to };
}

/** Apply one step if it is legal for the player to act; null otherwise (see resolveStep). */
export function applyStep(g: Game, st: LogStep): Game | null {
  const r = resolveStep(g, st);
  return r ? act(g, r.k, r.to) : null;
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
 * Tags written after a seat name in action lines: `hero` after the replay's hero (me in my own hand,
 * the observed player in another player's hand), `seats` after other seats (my seat in another
 * player's hand). handLog.ts seatTags(h) gives the right ones for a hand.
 */
export interface SeatTags {
  hero: string;
  seats?: Record<string, string>;
}

/** My own hand: the hero is me. */
export const MY_TAGS: SeatTags = { hero: "(나)" };

/** One action from the log in words: who ("BB(나)") and what ("오픈 2.5bb", "콜 7.5bb 올인", "폴드"). */
interface ActionWords {
  e: LogEntry;
  who: string;
  text: string;
  /** The hero or a tagged seat: their folds are always listed. */
  tagged: boolean;
}

/** Every action in the log in words (the blinds posted are left out), named the way streetLines names them. */
function actionWords(g: Game, fmt: (bb: number) => string, tags: SeatTags): ActionWords[] {
  const out: ActionWords[] = [];
  const raises: Record<string, number> = {};
  let limped = false;
  for (const e of g.log) {
    if (e.kind === "post") continue;
    const p = g.players[e.idx];
    const tag = p.hero ? tags.hero : (tags.seats?.[e.seat] ?? "");
    let text: string;
    if (e.kind === "fold") text = "폴드";
    else if (e.kind === "check") text = "체크";
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
    out.push({ e, who: `${e.seat}${tag}`, text: `${text}${e.allIn ? " 올인" : ""}`, tagged: p.hero || !!tag });
  }
  return out;
}

/**
 * Readable actions per street: "CO 오픈 2.5bb", "BB(나) 콜 7.5bb". Folds are listed only for
 * players who had put chips in voluntarily, for the hero and for tagged seats; the rest are implied.
 */
export function streetLines(g: Game, fmt: (bb: number) => string, tags: SeatTags = MY_TAGS): StreetLine[] {
  const lines: StreetLine[] = [];
  const invested = new Set<number>();
  const words = actionWords(g, fmt, tags);
  let k = 0;
  for (const e of g.log) {
    let line = lines[lines.length - 1];
    if (!line || line.street !== e.street) {
      line = { street: e.street, actions: [], pot: e.potAfter };
      lines.push(line);
    }
    line.pot = e.potAfter;
    if (e.kind === "post") continue;
    const w = words[k++];
    if (e.kind === "fold" && !invested.has(e.idx) && !w.tagged) continue;
    if (e.kind === "call" || e.kind === "bet" || e.kind === "raise") invested.add(e.idx);
    line.actions.push(`${w.who} ${w.text}`);
  }
  return lines;
}

const STREET_WORD: Record<Street, string> = { preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버" };

/** One run of what 되돌리기 takes back: an action, or folds or checks in a row put together. */
export interface UndoPart {
  /** The street it was on, named when the undo goes back over the end of that street; else null. */
  street: Street | null;
  /** Who: "UTG", "BTN, SB" or "UTG~HJ" (a run of three or more). */
  who: string;
  /** How many actions the run holds. */
  n: number;
  /** What: "폴드", "오픈 2.5bb", "콜 7.5bb 올인". */
  text: string;
}

/**
 * What one tap of 되돌리기 takes back (the steps undoSteps drops), run by run. Folds or checks in a row
 * are put together; the street is named on the first run of each street when the undo goes back over the end
 * of a street. `g` is the game after every one of `steps`. Empty with nothing to undo.
 */
export function undoParts(g: Game, steps: LogStep[], fmt: (bb: number) => string, tags: SeatTags = MY_TAGS): UndoPart[] {
  const n = steps.length - undoSteps(steps).length;
  const gone = n > 0 ? actionWords(g, fmt, tags).slice(-n) : [];
  if (!gone.length) return [];
  // The street on screen: a finished hand stays on the street of its last action.
  const now = g.done ? gone[gone.length - 1].e.street : g.street;
  const named = gone.some((w) => w.e.street !== now);
  const parts: UndoPart[] = [];
  let street: Street | null = null;
  for (let i = 0; i < gone.length; ) {
    const w = gone[i];
    let j = i + 1;
    if (w.e.kind === "fold" || w.e.kind === "check") while (j < gone.length && gone[j].e.kind === w.e.kind && gone[j].e.street === w.e.street) j++;
    const run = gone.slice(i, j);
    const who = run.length === 1 ? w.who : run.length === 2 ? `${w.who}, ${run[1].who}` : `${w.who}~${run[run.length - 1].who}`;
    parts.push({ street: named && w.e.street !== street ? w.e.street : null, who, n: run.length, text: w.text });
    street = w.e.street;
    i = j;
  }
  return parts;
}

/**
 * One run in words: "UTG~HJ 5명 폴드", "프리플랍 BB(나) 콜 2.5bb". Shorter where room is short: `count` gives
 * a run of two or more only its count ("5명 폴드"), `short` the preflop its short name ("프리 BB(나) 콜 2.5bb").
 */
export function undoPartText(p: UndoPart, opt: { count?: boolean; short?: boolean } = {}): string {
  const street = p.street ? `${opt.short && p.street === "preflop" ? "프리" : STREET_WORD[p.street]} ` : "";
  const who = p.n === 1 ? p.who : opt.count ? `${p.n}명` : p.n === 2 ? p.who : `${p.who} ${p.n}명`;
  return `${street}${who} ${p.text}`;
}

/**
 * What one tap of 되돌리기 takes back, in words: "UTG+1 폴드", "BTN 오픈 2.5bb", "UTG~HJ 5명 폴드 · CO 오픈 2.5bb".
 * Folds or checks in a row are put together ("SB, BB 폴드", "SB~CO 4명 체크"); a street the hand has already
 * left is named ("프리플랍 BB 체크": the undo goes back to the preflop). Null with nothing to undo.
 */
export function undoEcho(g: Game, steps: LogStep[], fmt: (bb: number) => string, tags: SeatTags = MY_TAGS): string | null {
  const parts = undoParts(g, steps, fmt, tags);
  return parts.length ? parts.map((p) => undoPartText(p)).join(" · ") : null;
}

/** Amount label: chips when the big blind in chips is known, otherwise bb. */
export function amountLabel(bb: number, bbChips: number | null): string {
  if (bbChips) return Math.round(bb * bbChips).toLocaleString();
  return `${Math.round(bb * 10) / 10}bb`;
}
