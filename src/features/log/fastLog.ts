import { RANKS } from "../../poker/cards";
import { createStore } from "../../state/store";
import {
  AMOUNT_PATTERN,
  amountValue,
  bbPart,
  boardCards,
  canAddRank,
  checkSteps,
  chipsText,
  convertText,
  draftResult,
  handLv,
  marksOf,
  missedOf,
  missedPart,
  netBoth,
  postedBy,
  chipSeries,
  sessionMoney,
  signedText,
  toChips,
  typeAmount,
  unitText,
  type BoardMark,
  type FastRes,
  type Unit,
} from "./fastChips";
import { actsFor, isFastSpot, seatsBefore, spotsFor, VERDICT_MARK, type FastSpot, type VerdictKind } from "./fastVerdict";
import {
  emptyHand,
  estimatedLevel,
  fastActed,
  fastActText,
  fastOnly,
  fastVerdictOf,
  holeClass,
  isOther,
  levelEstimateAt,
  rememberedText,
  tidyHand,
  withHole,
  withLv,
  type LoggedHand,
} from "./handLog";
import { blindsOf, cleanBlinds, levelRow, levelSince, PUB_BREAKS, PUB_SCHEDULE, type Blinds, type BreakRow, type LevelEstimate, type LevelRow, type Lv } from "./levelClock";
import { anyPresetLevel } from "./structures";
import { cleanPre, isStage, STAGE_LABEL, type PreAction, type PreStage } from "./quickPre";
import { buttonSeat, positionsFor, TABLE_SIZES } from "./recorder";
import { cleanGuess, holeFromRanks, setBoardGuess } from "./suitGuess";
import type { StackCheck } from "./tourney";

export type { BoardMark, FastRes } from "./fastChips";

/**
 * 빠른 기록: every hand dealt to me, a few taps each: my seat, the class, then how many chips the hand
 * won or lost (in chips or in bb at the hand's level; a fold that only cost the blind is one tap) and
 * the board cards I remember, ranks only unless a suit is remembered. With "액션도 기록" open, also my
 * one preflop decision (what happened before me, my action), graded against the pub chart the moment
 * the action is tapped. The editor's state (the stage, the table size, the hand being typed, the unit,
 * the level picked) is kept in its own small store so a reload or a trip elsewhere loses nothing; each
 * saved hand is an ordinary LoggedHand (fast: true). Everything here is pure but the stores.
 *
 * 남의 핸드 is the same screen in "other" mode: a hand someone else showed (their seat, their class, what
 * happened before them, their action), saved as an other-hand (kind "other") and judged against the same
 * chart as information about how pub players play. Its seat doesn't move on by itself (the player shown
 * varies), and it has its own editor store and its own today's list. It has no chip result or board.
 */

/** Whose hands the screen takes: mine (빠른 기록) or other players' (남의 핸드). */
export type FastMode = "mine" | "other";
const kindFits = (h: Pick<LoggedHand, "kind">, mode: FastMode): boolean => isOther(h) === (mode === "other");

/** Which field the keypad types into: the hand (ranks), the result or 지금 스택 (digits), the board (ranks). */
export type FastFocus = "hand" | "result" | "board" | "stack";
const FAST_RES: readonly FastRes[] = ["+", "-", "fold", "walk", "stack"];
const FOCI: readonly FastFocus[] = ["result", "board", "stack"];

/**
 * The hand being typed. The fields after `players` are 빠른 기록's own (never in "other" mode), each
 * left out at its default so a draft without them is the draft as it always was.
 */
export interface FastDraft {
  seat: string;
  /** Rank indexes (cards.ts RANKS: 0 = 2 … 12 = A) in the order tapped: none, one or two. */
  ranks: number[];
  /** Suited or not, for two different ranks; null until picked. */
  suited: boolean | null;
  spot: FastSpot;
  /** Who opened or shoved before me (spot "open" / "shove"). */
  opener: string | null;
  /** The saved hand on screen to correct (its id), or null for a new hand. */
  editing: string | null;
  /** A hand being corrected keeps its own stage and table size (absent for a new hand: the session's). */
  stage?: PreStage;
  players?: number;
  /** 결과: 수익 "+", 손실 "-", 폴드, 워크 (the BB), 스택 (worked out from `stackNow`). */
  res?: FastRes;
  /** The amount typed on the pad, in `unit`: digits, in bb with one decimal ("12000", "20.5"). Only when non-empty. */
  amount?: string;
  /** 지금 스택 (my chips after this hand), typed in `stackUnit`. Only when non-empty. */
  stackNow?: string;
  /** The unit `amount` is typed in: "bb", absent for chips. */
  unit?: "bb";
  /** The unit `stackNow` is typed in (its own: a pot in bb, the stack counted in chips): "bb", absent for chips. */
  stackUnit?: "bb";
  /** The board remembered, in order (flop 0–2, turn 3, river 4). Only when non-empty. */
  board?: BoardMark[];
  /** The board card the suit row is for, when it isn't the last one (a slot tapped). */
  boardAt?: number;
  /** Which field the keypad types into; absent: the hand. */
  focus?: Exclude<FastFocus, "hand">;
  /** Correcting a saved hand only: its own level (null: 레벨 모름), whether it was estimated, its BB ante off. */
  level?: number | null;
  levelGuess?: true;
  noAnte?: true;
  /** Correcting a saved hand only: its own 직접 입력 blinds (its `level` null then). */
  blinds?: Blinds;
  /** 액션도 기록: the action tapped, waiting for its result in the calculator sheet (never 폴드: that saves at once). */
  act?: PreAction;
}

export interface FastState {
  /** The pub chart stage the verdicts use, for new hands. */
  stage: PreStage;
  /** Table size for new hands. */
  players: number;
  draft: FastDraft;
  /** The new hand put aside while a saved one is corrected. */
  parked: FastDraft | null;
  /** The unit new hands' amounts are typed in (the 칩 | bb toggle, remembered): "bb", absent for chips. */
  unit?: "bb";
  /** The same for 지금 스택. */
  stackUnit?: "bb";
  /** The unit 오늘 빠른 기록 shows (list, total, graph): "bb", absent for chips. */
  view?: "bb";
  /** 액션도 기록 is open. */
  actions?: true;
  /**
   * A level picked by hand for new hands (null: 레벨 모름 on purpose) and when. It holds for the session:
   * until SESSION_IDLE_MS after `at` or after the last of the session's hands logged since it with no pause
   * that long (pickLive: a hand logged after it had lapsed never brings it back). `t`: the tournament it was
   * picked in (fastTourney.ts); it holds only while that tournament is the current one (without: while none is).
   * The level is in the tournament's own table: 야자수 새틀's, or a ready-made structure's (WPL: Lv1–46).
   */
  levelPick?: { level: number | null; at: number; t?: string };
  /** New hands without the BB ante (absent: the pub's BB ante). */
  noAnte?: true;
  /** The calculator sheet's tab last used for the result: "amount" (금액); absent: 스택. */
  entry?: "amount";
}

export const fastStore = createStore<Partial<FastState>>("mygto.fast", {});
/** 남의 핸드's editor: its own hand being typed; the stage and table size follow 빠른 기록's (shareTable). */
export const fastOtherStore = createStore<Partial<FastState>>("mygto.fast.other", {});
export const storeFor = (mode: FastMode) => (mode === "other" ? fastOtherStore : fastStore);

/** A blank hand at `seat`, nothing happened before me yet. */
export const newDraft = (seat: string): FastDraft => ({ seat, ranks: [], suited: null, spot: "none", opener: null, editing: null });

/** A blank hand of mine at `seat`, its amount and 지금 스택 typed in the units last used for each. */
export const freshDraft = (s: Pick<FastState, "unit" | "stackUnit">, seat: string): FastDraft => ({
  ...newDraft(seat),
  ...(s.unit === "bb" ? { unit: "bb" as const } : {}),
  ...(s.stackUnit === "bb" ? { stackUnit: "bb" as const } : {}),
});

/** `x` without the keys `ks` (a field at its default is left out, not set to undefined). */
function omit<T extends object, K extends keyof T>(x: T, ...ks: K[]): Omit<T, K> {
  const out = { ...x };
  for (const k of ks) delete out[k];
  return out;
}

/** The amount's unit: chips unless it says bb. */
export const unitOf = (d: Pick<FastDraft, "unit">): Unit => (d.unit === "bb" ? "bb" : "chips");
/** 지금 스택's unit: chips unless it says bb. */
export const stackUnitOf = (d: Pick<FastDraft, "stackUnit">): Unit => (d.stackUnit === "bb" ? "bb" : "chips");

/**
 * My seat next hand: the button moves one seat clockwise, so I move one place earlier in the preflop
 * order (BTN → CO → … → UTG → BB → SB → BTN). The button for a seat not at this table.
 */
export function nextSeat(players: number, seat: string): string {
  const seats = positionsFor(players);
  const i = seats.indexOf(seat);
  if (i < 0) return buttonSeat(players);
  return seats[(i - 1 + seats.length) % seats.length];
}

/** The table size and stage the draft is entered at: its own when correcting a saved hand, else the session's. */
export const draftPlayers = (s: Pick<FastState, "players" | "draft">): number => s.draft.players ?? s.players;
export const draftStage = (s: Pick<FastState, "stage" | "draft">): PreStage => s.draft.stage ?? s.stage;

// ───────────── the hand ─────────────

/**
 * A rank tapped: the first or second card; a third tap starts a new hand class. Not while a saved hand
 * is being corrected: there a third tap does nothing (⌫ first), so a next hand typed by mistake into the
 * correction can't overwrite the saved one.
 */
export function tapRank(d: FastDraft, r: number): FastDraft {
  if (!Number.isInteger(r) || r < 0 || r > 12) return d;
  if (d.editing && classDone(d)) return d;
  const ranks = d.ranks.length >= 2 ? [r] : [...d.ranks, r];
  return { ...omit(d, "act"), ranks, suited: null };
}

/** ⌫: the suitedness first, then the last rank. */
export function undoTap(d: FastDraft): FastDraft {
  if (d.suited !== null) return { ...omit(d, "act"), suited: null };
  return { ...omit(d, "act"), ranks: d.ranks.slice(0, -1) };
}

/** 수딧 / 오프수트, for two different ranks. */
export function pickSuited(d: FastDraft, suited: boolean): FastDraft {
  if (d.ranks.length !== 2 || d.ranks[0] === d.ranks[1]) return d;
  return { ...omit(d, "act"), suited };
}

/** Two ranks of which a pair or with suitedness picked: the class is complete. */
export const classDone = (d: Pick<FastDraft, "ranks" | "suited">): boolean => d.ranks.length === 2 && (d.ranks[0] === d.ranks[1] || d.suited !== null);

/** The class as typed so far, high card first: "", "A", "AJ" (suitedness to pick), "AJo", "AJs", "TT". */
export function draftClass(d: Pick<FastDraft, "ranks" | "suited">): string {
  if (!d.ranks.length) return "";
  const [hi, lo] = [...d.ranks].sort((a, b) => b - a);
  if (lo === undefined) return RANKS[hi];
  if (hi === lo) return RANKS[hi] + RANKS[lo];
  return RANKS[hi] + RANKS[lo] + (d.suited === null ? "" : d.suited ? "s" : "o");
}

// ───────────── the spot ─────────────

/** My seat changed: an opener no longer before me goes, and a spot that can't happen there falls back to 폴드로 나에게. */
export function withSeat(d: FastDraft, seat: string, players: number): FastDraft {
  if (!positionsFor(players).includes(seat)) return d;
  const spot = spotsFor(players, seat).includes(d.spot) ? d.spot : "none";
  const opener = d.opener && (spot === "open" || spot === "shove") && seatsBefore(players, seat).includes(d.opener) ? d.opener : null;
  // A walk is the BB's only; an action waiting for its result goes with the seat it was tapped at.
  const kept = d.res === "walk" && seat !== "BB" ? omit(d, "res", "act") : seat !== d.seat ? omit(d, "act") : d;
  return { ...kept, seat, spot, opener };
}

/** What happened before me; the opener only goes with an open or a shove (and stays when moving between them). */
export function withSpot(d: FastDraft, spot: FastSpot): FastDraft {
  const keep = (spot === "open" || spot === "shove") && (d.spot === "open" || d.spot === "shove");
  return { ...(spot === d.spot ? d : omit(d, "act")), spot, opener: keep ? d.opener : null };
}

/** Everything but my action is in: my seat at this table, the class, a spot that can happen there, its opener. */
export function draftReady(d: FastDraft, players: number): boolean {
  if (!positionsFor(players).includes(d.seat) || !classDone(d)) return false;
  if (!spotsFor(players, d.seat).includes(d.spot)) return false;
  if (d.spot === "open" || d.spot === "shove") return d.opener !== null && seatsBefore(players, d.seat).includes(d.opener);
  return true;
}

/** The class's two cards with guessed suits (suited, offsuit; a pair offsuit), as the hand gets them. */
function classHole(d: Pick<FastDraft, "ranks" | "suited">): { hole: LoggedHand["hole"]; kind: "suited" | "offsuit"; pair: boolean } | null {
  if (!classDone(d)) return null;
  const [a, b] = d.ranks;
  const pair = a === b;
  const kind = pair || !d.suited ? "offsuit" : "suited";
  const hole = holeFromRanks(a, b, kind, []);
  return hole ? { hole, kind, pair } : null;
}

/**
 * The hand to save for the draft with my action (undefined only for a walk at the BB), on `base`: a
 * fresh hand (its id, time and level) or the saved one being corrected. Its cards come from the class
 * with guessed suits (holeFromRanks; marked guess.hole with holeKind), the stage, my action and the
 * opener go in the preflop block (so 테이블로 이어서 기록 can place them), the spot in `fastSpot`.
 * In "other" mode it is another player's hand (kind "other"): the seat, the cards and the action are
 * theirs, and my own seat is left out. Null when the draft isn't ready or the action doesn't fit the spot.
 * `act` null: no decision recorded (빠른 기록's default): only my seat at the table and a complete class
 * are needed, and `fastSpot` / `quickPre` are left off (taken off `base` too).
 */
export function fastHand(d: FastDraft, act: PreAction | undefined | null, base: LoggedHand, stage: PreStage, players: number, mode: FastMode = "mine"): LoggedHand | null {
  if (act === null) {
    if (!positionsFor(players).includes(d.seat)) return null;
    const c = classHole(d);
    if (!c) return null;
    const { quickPre: _q, fastSpot: _s, kind: _k, mySeat: _m, ...bare } = base;
    void _q;
    void _s;
    void _k;
    void _m;
    const h: LoggedHand = { ...bare, players, seat: d.seat, fast: true, ...(mode === "other" ? { kind: "other" as const } : {}) };
    return tidyHand(withHole(h, c.hole, true, c.pair ? undefined : c.kind));
  }
  if (!draftReady(d, players)) return null;
  const acts = actsFor(d.spot, d.seat);
  if (act === undefined ? acts.length > 0 : !acts.includes(act)) return null;
  const c = classHole(d);
  if (!c) return null;
  const facing = d.spot === "open" || d.spot === "shove";
  const seats = positionsFor(players);
  const quickPre = cleanPre({ stage, pinned: true, action: act, ...(d.spot === "shove" ? { openAllIn: true } : {}), ...(facing && d.opener ? { openerSeat: d.opener } : {}) }, seats);
  const { quickPre: _was, kind: _kind, mySeat: _my, ...rest } = base;
  void _was;
  void _kind;
  void _my;
  const h: LoggedHand = { ...rest, players, seat: d.seat, ...(quickPre ? { quickPre } : {}), fast: true, fastSpot: d.spot, ...(mode === "other" ? { kind: "other" as const } : {}) };
  return tidyHand(withHole(h, c.hole, true, c.pair ? undefined : c.kind));
}

/** The seats dealt between `from` and `to` going round the table, at this table size (none: `to` is next, the same seat, or not at the table). */
export function seatsBetween(players: number, from: string, to: string): string[] {
  const seats = positionsFor(players);
  if (!seats.includes(from) || !seats.includes(to) || from === to) return [];
  const out: string[] = [];
  let x = nextSeat(players, from);
  while (x !== to && out.length < seats.length) {
    out.push(x);
    x = nextSeat(players, x);
  }
  return x === to ? out : [];
}

/** A hand saved without its cards (핸드 생략: 폴드 or −1bb with no rank typed): my seat, the table size and the chips only. */
export function fastBlankHand(d: FastDraft, base: LoggedHand, players: number): LoggedHand | null {
  if (!positionsFor(players).includes(d.seat) || d.ranks.length) return null;
  const { quickPre: _q, fastSpot: _s, kind: _k, mySeat: _m, ...bare } = base;
  void _q;
  void _s;
  void _k;
  void _m;
  return tidyHand({ ...bare, players, seat: d.seat, hole: [], fast: true });
}

/** The level a hand goes in at (a 야자수 새틀 level, a 직접 입력 tournament's blinds, or null), and whether it came from the start-time estimate. */
export interface FastLevel {
  level: Lv;
  guessed: boolean;
}

/** The board on the hand is the marks as they stand (a correction that didn't touch the board keeps the hand's own cards). */
const sameMarks = (h: Pick<LoggedHand, "board" | "guess">, marks: BoardMark[]): boolean => JSON.stringify(marksOf(h.board, h.guess?.board)) === JSON.stringify(marks);

/** The marks as cards on `h`: typed suits as typed, the rest guessed (guess.board), the 숫자만 way. */
function withMarks(h: LoggedHand, marks: BoardMark[]): LoggedHand | null {
  if (sameMarks(h, marks)) return h;
  const b = boardCards(marks, h.hole);
  if (!b) return null;
  const { guess: _g, ...rest } = h;
  void _g;
  const guess = cleanGuess(setBoardGuess(setBoardGuess(h.guess, [0, 1, 2, 3, 4], false), b.guessed, true));
  return { ...rest, board: b.cards, ...(guess ? { guess } : {}) };
}

/** The draft's result as draftResult takes it: the sign and amount, 지금 스택 and the stack before the hand (for 스택). */
const resultIn = (d: FastDraft, seat: string, level: Lv, bbAnte: boolean, before: number | null) => ({
  res: d.res,
  amount: d.amount,
  unit: unitOf(d),
  seat,
  level,
  bbAnte,
  stackNow: d.stackNow,
  stackUnit: stackUnitOf(d),
  before,
});

/**
 * The draft's result, board and 지금 스택 on the hand, at the level `lv`; null while the draft says why
 * not (blockOf). The net is in chips; 지금 스택 (my chips after the hand) is kept as the hand's start
 * stack, `stack = now − net`. Known board cards win over the guessed hole cards (tidyHand re-picks them);
 * a board that can't be placed in full is refused rather than cut. 스택: the net is 지금 스택 less
 * `before` (my stack before the hand, stackAt; null: not known, and the hand keeps 지금 스택 with no result),
 * and the hand says so (`fastStack`).
 */
export function withFastResult(h: LoggedHand, d: FastDraft, lv: FastLevel, bbAnte: boolean, before: number | null = null): LoggedHand | null {
  const unit = unitOf(d);
  const { fastUnit: _u, fastStack: _s, ...was } = withLv(h, lv.level, lv.guessed);
  void _u;
  void _s;
  const out = draftResult(resultIn(d, was.seat, lv.level, bbAnte, before));
  if ("block" in out) return null;
  // An amount typed in bb says so on the hand, so a correction opens it as it was typed.
  const typedBb = d.res !== "stack" && unit === "bb" && out.net !== null && amountValue(d.amount ?? "") !== null;
  const x: LoggedHand = { ...was, result: out.result, net: out.net, bbAnte, ...(typedBb ? { fastUnit: "bb" as const } : {}), ...(d.res === "stack" ? { fastStack: true as const } : {}) };
  const marks = d.board ?? [];
  const placed = withMarks(x, marks);
  if (!placed) return null;
  let stack: number | null = null;
  if (d.stackNow) {
    const now = toChips(d.stackNow, stackUnitOf(d), lv.level);
    if (now === null || now - (out.net ?? 0) < 0) return null;
    stack = now - (out.net ?? 0);
  }
  const done = tidyHand({ ...placed, stack });
  return done.board.length === marks.length ? done : null;
}

/** Why the draft can't be saved yet ("stackNow": 스택 with no 지금 스택 typed; "over": a loss bigger than the stack before). */
export type FastBlock = "class" | "sign" | "level" | "stack" | "stackNow" | "over" | "board";

/** The marks fit the class: every card can be placed, none on top of the hole cards that can't move. */
export function boardFits(d: FastDraft): boolean {
  const marks = d.board ?? [];
  if (!marks.length) return true;
  const c = classHole(d);
  if (!c) return true;
  const h = withMarks(withHole(emptyHand(null), c.hole, true, c.pair ? undefined : c.kind), marks);
  return !!h && tidyHand(h).board.length === marks.length;
}

/** Why the draft can't be saved yet ("class" | "sign" | "level" | "stack" | "stackNow" | "over" | "board"), or null. `before`: my stack before the hand (스택, and a loss can't be bigger). */
export function blockOf(d: FastDraft, players: number, level: Lv, bbAnte: boolean, before: number | null = null): FastBlock | null {
  if (!positionsFor(players).includes(d.seat) || !classDone(d)) return "class";
  const out = draftResult(resultIn(d, d.seat, level, bbAnte, before));
  if ("block" in out) return out.block;
  if (d.stackNow) {
    const now = toChips(d.stackNow, stackUnitOf(d), level);
    if (now === null) return "level";
    if (now - (out.net ?? 0) < 0) return "stack";
  }
  return boardFits(d) ? null : "board";
}

/**
 * Correcting with 액션 접힘: the hand's recorded decision if it still fits the draft (its action among
 * the spot's choices at the draft's seat; a walk: the BB facing nobody), else null (the save drops it,
 * and its verdict).
 */
export function keptAction(saved: LoggedHand, d: FastDraft): PreAction | undefined | null {
  if (!fastActed(saved)) return null;
  const act = saved.quickPre?.action;
  if (act === undefined) return d.seat === "BB" && d.spot === "none" ? undefined : null;
  return actsFor(d.spot, d.seat).includes(act) ? act : null;
}

// ───────────── the keypad's other fields ─────────────

/** The keypad goes to `f` (the hand: the field is left out). */
export const setFocus = (d: FastDraft, f: FastFocus): FastDraft => (f === "hand" ? omit(d, "focus") : { ...d, focus: f });

/** The field the keypad types into: the hand until the class is complete. */
export const focusOf = (d: FastDraft): FastFocus => (classDone(d) ? (d.focus ?? "hand") : "hand");

/** `d` with the text field `k` set, or left out when empty. */
const withText = (d: FastDraft, k: "amount" | "stackNow", t: string): FastDraft => (t ? { ...d, [k]: t } : omit(d, k));

/**
 * 수익 / 손실 set the sign and take the keypad to the amount; 스택 takes the keypad to 지금 스택 (what is typed
 * there stays; with nothing there, an amount typed under 수익 / 손실 moves over to it: most likely my stack
 * typed under the wrong chip, not typed twice); 폴드 / 워크 set the result and drop the amount.
 */
export function pickRes(d: FastDraft, res: FastRes): FastDraft {
  if (res === "+" || res === "-") return { ...d, res, focus: "result" };
  if (res === "stack") {
    const carry = !d.stackNow && d.amount && unitOf(d) === stackUnitOf(d) ? { stackNow: d.amount } : {};
    return { ...omit(d, "amount"), ...carry, res, focus: "stack" };
  }
  return { ...omit(d, "amount"), res };
}

/**
 * The calculator sheet's tabs: 스택 (지금 스택: what is typed there stays; with nothing there, an amount typed
 * under 금액 moves over to it, as pickRes does; 스택 is the result only once a stack is typed), 금액 (the amount;
 * 스택 let go as the result, the amount and 지금 스택 kept), 보드 (the board, its suit row on the last card).
 * Nothing typed is ever deleted by a tab.
 */
export function pickEntry(d: FastDraft, e: "stack" | "amount" | "board"): FastDraft {
  if (e === "board") return pickBoardSlot(d, (d.board ?? []).length);
  if (e === "amount") return { ...(d.res === "stack" ? omit(d, "res") : d), focus: "result" };
  if (d.stackNow) return { ...d, res: "stack", focus: "stack" };
  if (d.amount && unitOf(d) === stackUnitOf(d)) return { ...omit(d, "amount"), stackNow: d.amount, res: "stack", focus: "stack" };
  return { ...(d.res === "+" || d.res === "-" || d.res === "stack" ? omit(d, "res") : d), focus: "stack" };
}

/**
 * The class just completed (by a tap, with no keypad field yet and 액션도 기록 closed): the calculator sheet comes up
 * in the tab used last (`entry`: 금액, else 스택), or, for a class typed again over a result already typed (⌫ back
 * to the hand and a new tap), in the tab that result was typed in. The same draft otherwise.
 */
export function openOnClass(prev: FastDraft, next: FastDraft, s: Pick<FastState, "entry" | "actions">, forced = false): FastDraft {
  if (classDone(prev) || !classDone(next) || next.focus || s.actions === true || forced) return next;
  return entryField(next, s);
}

/**
 * The draft with the calculator on the field its result was typed in: 금액 for a sign with its amount (or an
 * amount, or a sign alone), 지금 스택 for a stack typed (스택 the result then, as typing it makes it), else the
 * tab used last (`entry`).
 */
export function entryField(d: FastDraft, s: Pick<FastState, "entry">): FastDraft {
  const signed = d.res === "+" || d.res === "-";
  const amount = (signed && !!d.amount) || (!d.stackNow && d.res !== "stack" && (!!d.amount || signed));
  if (amount || (!d.stackNow && d.res !== "stack" && s.entry === "amount")) return { ...d, focus: "result" };
  return d.stackNow && d.res !== "stack" ? { ...d, res: "stack", focus: "stack" } : { ...d, focus: "stack" };
}

/**
 * A digit key ("0"–"9", "00", "000", ".") into the amount or 지금 스택, whichever has the keypad. 지금 스택
 * typed is 스택 (the result worked out from it), after 폴드 / 워크 too; only a +/− draft with its amount
 * (one stored with both) keeps its sign.
 */
export function typeDigit(d: FastDraft, key: string): FastDraft {
  const f = focusOf(d);
  if (f !== "result" && f !== "stack") return d;
  const k = f === "result" ? "amount" : "stackNow";
  const was = d[k] ?? "";
  const t = typeAmount(was, key, f === "result" ? unitOf(d) : stackUnitOf(d));
  if (t === was) return d;
  // An amount typed after 폴드 / 워크 / 스택 asks for its sign; 지금 스택 typed is 스택.
  const both = (d.res === "+" || d.res === "-") && !!d.amount;
  const base =
    f === "result" && (d.res === "fold" || d.res === "walk" || d.res === "stack")
      ? omit(d, "res")
      : f === "stack" && !both && d.res !== "stack"
        ? { ...d, res: "stack" as const }
        : d;
  return withText(base, k, t);
}

/** A rank onto the board (the suit row then goes to it, the new last card): refused (the same draft back) when it can't be dealt with this class. */
export function tapBoardRank(d: FastDraft, r: number): FastDraft {
  const marks = d.board ?? [];
  if (!classDone(d) || !canAddRank(marks, r, d.ranks)) return d;
  const next = { ...omit(d, "boardAt"), board: [...marks, { r }] };
  return boardFits(next) ? next : d;
}

/** The board card the suit row is for: a slot tapped, else the last card; -1 with no board. */
export const boardTarget = (d: Pick<FastDraft, "board" | "boardAt">): number => {
  const n = (d.board ?? []).length;
  return d.boardAt !== undefined && d.boardAt >= 0 && d.boardAt < n ? d.boardAt : n - 1;
};

/**
 * A board slot tapped: the keypad goes to the board and, for a card already typed, the suit row goes to
 * that card (a suit remembered late, for the K of K 7 2). An empty slot: the suit row back to the last card.
 */
export function pickBoardSlot(d: FastDraft, i: number): FastDraft {
  const n = (d.board ?? []).length;
  const to = { ...omit(d, "boardAt"), focus: "board" as const };
  return Number.isInteger(i) && i >= 0 && i < n - 1 ? { ...to, boardAt: i } : to;
}

/**
 * A suit for the board card the suit row is for (boardTarget; tapped again: back to the rank only);
 * refused for a card already on the board or one that can't be dealt.
 */
export function tapBoardSuit(d: FastDraft, s: number): FastDraft {
  const marks = d.board ?? [];
  const i = boardTarget(d);
  const m = marks[i];
  if (!m || !Number.isInteger(s) || s < 0 || s > 3) return d;
  const put = (x: BoardMark) => ({ ...d, board: marks.map((k, j) => (j === i ? x : k)) });
  if (m.s === s) return put({ r: m.r });
  if (marks.some((k, j) => j !== i && k.r === m.r && k.s === s)) return d;
  const next = put({ r: m.r, s });
  return boardFits(next) ? next : d;
}

/**
 * ⌫ on whatever has the keypad: the hand as always (undoTap); the amount's last character, then its
 * sign, then back to the hand (the sheet closes); 지금 스택's last character (emptied: 스택 let go), then
 * back to the hand; the last board card's suit, then the card, then back to the result: 금액 when the draft
 * has a sign or an amount, else 스택. Back to the hand, an action waiting for its result goes too.
 */
export function backKey(d: FastDraft): FastDraft {
  switch (focusOf(d)) {
    case "result":
      if (d.amount) return withText(d, "amount", d.amount.slice(0, -1));
      if (d.res) return omit(d, "res");
      return setFocus(omit(d, "act"), "hand");
    case "stack":
      if (d.stackNow) {
        const t = withText(d, "stackNow", d.stackNow.slice(0, -1));
        return t.stackNow || t.res !== "stack" ? t : omit(t, "res");
      }
      return setFocus(omit(d, "act"), "hand");
    case "board": {
      const marks = d.board ?? [];
      const last = marks[marks.length - 1];
      const b = omit(d, "boardAt");
      if (!last) return setFocus(b, d.amount || d.res === "+" || d.res === "-" ? "result" : "stack");
      if (last.s !== undefined) return { ...b, board: [...marks.slice(0, -1), { r: last.r }] };
      return marks.length > 1 ? { ...b, board: marks.slice(0, -1) } : omit(b, "board");
    }
    default:
      return undoTap(d);
  }
}

/** The unit of the field the keypad types into: 지금 스택's while it has the keypad, else the amount's. */
export const keyUnitOf = (d: FastDraft): Unit => (focusOf(d) === "stack" ? stackUnitOf(d) : unitOf(d));

/**
 * 칩 | bb: the unit of the field the keypad types into (the amount, or 지금 스택 while it has the keypad);
 * the other field keeps its own. What is typed keeps its digits (unitText: the toggle says what they
 * mean, and tapping back undoes it). The same draft back when the digits can't be read in that unit.
 */
export function switchUnit(d: FastDraft, to: Unit): FastDraft {
  if (focusOf(d) === "stack") {
    const t = stackUnitOf(d) === to ? null : unitText(d.stackNow ?? "", to);
    if (t === null) return d;
    return { ...omit(d, "stackNow", "stackUnit"), ...(t ? { stackNow: t } : {}), ...(to === "bb" ? { stackUnit: "bb" as const } : {}) };
  }
  const t = unitOf(d) === to ? null : unitText(d.amount ?? "", to);
  if (t === null) return d;
  return { ...omit(d, "amount", "unit"), ...(t ? { amount: t } : {}), ...(to === "bb" ? { unit: "bb" as const } : {}) };
}

/** Chips as the draft's text in `unit`: the exact bb to 0.1 (else null), or the chips. */
function textIn(chips: number, unit: Unit, level: Lv): string | null {
  if (chips < 0 || !Number.isFinite(chips)) return null;
  if (unit === "chips") return AMOUNT_PATTERN.chips.test(String(chips)) ? String(chips) : null;
  const t = convertText(String(chips), "chips", "bb", level);
  return AMOUNT_PATTERN.bb.test(t) && toChips(t, "bb", level) === chips ? t : null;
}

/**
 * A saved 빠른 기록 hand back in the editor, to correct it. A hand of mine also brings its result (the
 * amount in the unit it was typed in, `fastUnit`; a hand without an amount takes `unit` for one typed
 * now; one worked out from 지금 스택, `fastStack`: 스택 again), its board as remembered, 지금 스택 (the chips after the hand: its start stack plus the net) in
 * `stackUnit` when it is exact there to 0.1bb (else in chips), its level and BB ante.
 */
export function draftOf(h: LoggedHand, unit: Unit = "chips", stackUnit: Unit = "chips"): FastDraft {
  const ranks = h.hole.length === 2 ? h.hole.map((c) => c >> 2) : [];
  const pair = ranks.length === 2 && ranks[0] === ranks[1];
  const suited = ranks.length === 2 && !pair ? h.holeKind === "suited" || (h.holeKind === undefined && (h.hole[0] & 3) === (h.hole[1] & 3)) : null;
  const spot = isFastSpot(h.fastSpot) ? h.fastSpot : "none";
  const opener = spot === "open" || spot === "shove" ? (h.quickPre?.openerSeat ?? null) : null;
  const d: FastDraft = { seat: h.seat, ranks, suited, spot, opener, editing: h.id, ...(h.quickPre?.stage ? { stage: h.quickPre.stage } : {}), players: h.players };
  if (isOther(h)) return d;
  const lv = handLv(h);
  const posted = postedBy(h.seat, lv, h.bbAnte);
  const fold = h.result === "fold" && (h.net === null || h.net === 0 || (posted !== null && h.net === -posted));
  // Worked out from 지금 스택: opened that way, to work it out again.
  const byStack = h.fastStack === true && h.stack !== null && h.result !== "fold";
  const res: FastRes | undefined = byStack ? "stack" : fold ? "fold" : (h.net ?? 0) > 0 ? "+" : (h.net ?? 0) < 0 ? "-" : h.result === "win" || h.result === "chop" ? "+" : h.result === "lose" ? "-" : h.result === "fold" ? "fold" : undefined;
  const absNet = res === "+" || res === "-" ? (h.net === null ? null : Math.abs(h.net)) : null;
  const after = h.stack !== null ? h.stack + (h.net ?? 0) : null;
  // Each text in its unit when it is exact there, else in chips: the amount's as typed (or, with none, the unit asked for).
  const amountIn: Unit = absNet === null ? unit : h.fastUnit === "bb" ? "bb" : "chips";
  const u: Unit = amountIn === "bb" && (absNet === null || textIn(absNet, "bb", lv) !== null) ? "bb" : "chips";
  const su: Unit = stackUnit === "bb" && after !== null && textIn(after, "bb", lv) !== null ? "bb" : "chips";
  const amount = absNet !== null ? textIn(absNet, u, lv) : res === "+" && h.result === "chop" ? "0" : null;
  const stackNow = after !== null ? textIn(after, su, lv) : null;
  const blinds = h.level === null ? cleanBlinds(h.blinds) : null;
  const marks = marksOf(h.board, h.guess?.board);
  return {
    ...d,
    ...(res ? { res } : {}),
    ...(amount ? { amount } : {}),
    ...(stackNow ? { stackNow } : {}),
    ...(u === "bb" ? { unit: "bb" as const } : {}),
    ...(su === "bb" && stackNow ? { stackUnit: "bb" as const } : {}),
    ...(marks.length ? { board: marks } : {}),
    // The calculator sheet opens in the hand's own tab: 금액 for an amount, else 스택.
    focus: res === "+" || res === "-" ? ("result" as const) : ("stack" as const),
    // A level off the schedule isn't carried (cleanDraft would drop it): the hand's own stays then.
    ...(h.level === null || levelRow(h.level) ? { level: h.level } : {}),
    ...(h.levelGuess && h.level !== null && levelRow(h.level) ? { levelGuess: true as const } : {}),
    ...(!h.bbAnte ? { noAnte: true as const } : {}),
    ...(blinds ? { blinds } : {}),
  };
}

/**
 * Until when a level picked at `at` was in use: the last of the session's hands logged since it with no
 * pause over SESSION_IDLE_MS (from the pick to the first, and between them), else `at`. So a pick left
 * last night stays lapsed when tonight's first hand goes in: that hand comes after the pause.
 */
export function pickLive(at: number, session: LoggedHand[]): number {
  let live = at;
  for (const t of session.map((h) => h.createdAt).filter((t) => t >= at).sort((a, b) => a - b)) {
    if (t - live > SESSION_IDLE_MS) break;
    live = t;
  }
  return live;
}

/**
 * The level new hands go in at: a level picked for the session, moved on by the schedule from the
 * moment it was picked (levelSince: once past the level picked it is an estimate, `guessed`); else
 * the start-time estimate `est` (default: today's start time; 빠른 기록 passes its tournament's); else
 * none (never a stale last level: folds and bb amounts would go wrong unseen). `picked`: it comes from a
 * pick (레벨 모름 picked on purpose among them). A pick holds only in the tournament it was made in
 * (`tid`: the current one's id, null for none), so starting or resuming another never carries it over.
 * `schedule` / `breaks`: the tournament's table (a ready-made structure's; default 야자수 새틀's); a pick of a
 * level that table doesn't have is no pick (the structure was changed since). `from`: where a pick runs from (a
 * ready-made structure's lines it up with its clock: fastTourney.ts presetPickFrom); default the moment it was made.
 */
export function fastLevel(
  s: Pick<FastState, "levelPick">,
  session: LoggedHand[],
  now: number,
  est: LevelEstimate | null = levelEstimateAt(now),
  tid: string | null = null,
  schedule: LevelRow[] = PUB_SCHEDULE,
  breaks: BreakRow[] = PUB_BREAKS,
  from: (level: number, at: number) => number = (_level, at) => at,
): FastLevel & { picked: boolean } {
  const pick = s.levelPick;
  if (pick && (pick.t ?? null) === tid && now - pickLive(pick.at, session) <= SESSION_IDLE_MS && (pick.level === null || levelRow(pick.level, schedule))) {
    if (pick.level === null) return { level: null, guessed: false, picked: true };
    const level = levelSince(pick.level, from(pick.level, pick.at), now, schedule, breaks);
    return { level, guessed: level !== pick.level, picked: true };
  }
  const lv = estimatedLevel(est);
  return lv !== null ? { level: lv, guessed: true, picked: false } : { level: null, guessed: false, picked: false };
}

// ───────────── saving, correcting ─────────────

/** The newest 빠른 기록 hand of the mode's kind. */
const newestFast = (hands: LoggedHand[], mode: FastMode): LoggedHand | null =>
  hands.reduce<LoggedHand | null>((b, h) => (h.fast === true && kindFits(h, mode) && (!b || h.createdAt > b.createdAt) ? h : b), null);

/**
 * The editor after `saved` went on file (`hands` is the log with it): a new hand clears the editor for
 * the next one at the next seat. A corrected hand gives back the new hand that was put aside; if it was
 * the newest one, the next seat follows its (maybe corrected) seat. In "other" mode the seat stays where
 * it was picked (the next hand shown is anybody's): a new hand starts at the same seat.
 */
export function afterSave(s: FastState, saved: LoggedHand, hands: LoggedHand[], mode: FastMode = "mine"): FastState {
  if (mode === "other") {
    const seat = positionsFor(s.players).includes(saved.seat) ? saved.seat : buttonSeat(s.players);
    return { ...s, draft: s.draft.editing ? (s.parked ?? newDraft(seat)) : newDraft(seat), parked: null };
  }
  if (!s.draft.editing) return { ...s, draft: freshDraft(s, nextSeat(s.players, saved.seat)), parked: null };
  const back = s.parked ?? freshDraft(s, nextSeat(s.players, saved.seat));
  const latest = newestFast(hands, mode)?.id === saved.id;
  return { ...s, draft: latest ? withSeat(back, nextSeat(s.players, saved.seat), s.players) : back, parked: null };
}

/**
 * A saved hand opened in the editor (되돌리기, or tapped in the list): the new hand on screen is put aside. Only a
 * hand still just a 빠른 기록, of the mode's kind. The calculator sheet comes up on its result, unless the action
 * rows are on screen (a hand with its decision on file, or 액션도 기록 open): the sheet would cover them.
 */
export function startEdit(s: FastState, h: LoggedHand, mode: FastMode = "mine"): FastState {
  if (!fastOnly(h) || !kindFits(h, mode)) return s;
  const d = draftOf(h, s.unit === "bb" ? "bb" : "chips", "chips");
  return { ...s, draft: fastActed(h) || s.actions === true ? omit(d, "focus") : d, parked: s.draft.editing ? s.parked : s.draft };
}

/** Back to the new hand put aside (the corrected hand stays as it was saved). */
export function cancelEdit(s: FastState): FastState {
  return { ...s, draft: s.parked ?? freshDraft(s, buttonSeat(s.players)), parked: null };
}

/** The hands `ids` were deleted: a correction of one of them gives way to the new hand put aside. The same state otherwise. */
export function forgetHands(s: FastState, ids: Iterable<string>): FastState {
  const gone = new Set(ids);
  return s.draft.editing && gone.has(s.draft.editing) ? cancelEdit(s) : s;
}

/**
 * The stage and table size set on one of the two screens, for the other one too (both are the same
 * table): its new hand moves to the button only if its seat isn't at a table that size. A hand being
 * corrected keeps its own.
 */
export function shareTable(s: FastState, stage: PreStage, players: number): FastState {
  if (!isSize(players)) return s;
  const fit = (d: FastDraft) => (d.editing ? d : withSeat(d, positionsFor(players).includes(d.seat) ? d.seat : buttonSeat(players), players));
  return { ...s, stage, players, draft: fit(s.draft), parked: s.parked ? fit(s.parked) : null };
}

// ───────────── stored state ─────────────

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const isSize = (x: unknown): x is number => typeof x === "number" && TABLE_SIZES.includes(x);

function cleanDraft(x: unknown, players: number): FastDraft {
  const r = obj(x);
  const editing = typeof r.editing === "string" && r.editing ? r.editing : null;
  const own = editing && isSize(r.players) ? r.players : null;
  const n = own ?? players;
  const seat = typeof r.seat === "string" && positionsFor(n).includes(r.seat) ? r.seat : buttonSeat(n);
  const ranks = (Array.isArray(r.ranks) ? r.ranks : []).filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 12).slice(0, 2);
  const suited = ranks.length === 2 && ranks[0] !== ranks[1] && typeof r.suited === "boolean" ? r.suited : null;
  const d = withSpot({ seat, ranks, suited, spot: "none", opener: null, editing }, isFastSpot(r.spot) ? r.spot : "none");
  const withOpener = typeof r.opener === "string" ? { ...d, opener: r.opener } : d;
  const placed = withSeat(withOpener, seat, n);
  return { ...placed, ...(editing && isStage(r.stage) ? { stage: r.stage } : {}), ...(own ? { players: own } : {}), ...cleanChips(r, placed) };
}

/** A stored board: up to 5 marks of a rank and maybe a suit, no card twice, at most 4 of a rank; anything else: none. */
function cleanMarks(x: unknown): BoardMark[] {
  if (!Array.isArray(x) || x.length > 5) return [];
  const marks: BoardMark[] = [];
  for (const v of x) {
    const o = obj(v);
    if (!Number.isInteger(o.r) || (o.r as number) < 0 || (o.r as number) > 12) return [];
    if (o.s !== undefined && (!Number.isInteger(o.s) || (o.s as number) < 0 || (o.s as number) > 3)) return [];
    marks.push(o.s === undefined ? { r: o.r as number } : { r: o.r as number, s: o.s as number });
  }
  const known = marks.filter((m) => m.s !== undefined).map((m) => `${m.r}.${m.s}`);
  if (new Set(known).size < known.length) return [];
  for (const m of marks) if (marks.filter((k) => k.r === m.r).length > 4) return [];
  return marks;
}

/** 빠른 기록's own draft fields, the valid ones only (each left out at its default). */
function cleanChips(r: Record<string, unknown>, d: FastDraft): Partial<FastDraft> {
  const unit: Unit = r.unit === "bb" ? "bb" : "chips";
  const stackUnit: Unit = r.stackUnit === "bb" ? "bb" : "chips";
  const text = (x: unknown, u: Unit) => (typeof x === "string" && AMOUNT_PATTERN[u].test(x) ? x : null);
  const amount = text(r.amount, unit);
  const stackNow = text(r.stackNow, stackUnit);
  const board = cleanMarks(r.board);
  const boardAt = Number.isInteger(r.boardAt) && (r.boardAt as number) >= 0 && (r.boardAt as number) < board.length - 1 ? (r.boardAt as number) : null;
  const res = FAST_RES.find((x) => x === r.res && (x !== "walk" || d.seat === "BB"));
  const focus = FOCI.find((x) => x === r.focus);
  const level = d.editing && (r.level === null || (typeof r.level === "number" && levelRow(r.level))) ? (r.level as number | null) : undefined;
  const blinds = d.editing && typeof level !== "number" ? cleanBlinds(r.blinds) : null;
  // An action waiting for its result: one of the spot's, never 폴드 (it saves at once), with the class complete.
  const act = classDone(d) && r.act !== "fold" && actsFor(d.spot, d.seat).includes(r.act as PreAction) ? (r.act as PreAction) : null;
  return {
    ...(res ? { res } : {}),
    ...(amount ? { amount } : {}),
    ...(stackNow ? { stackNow } : {}),
    ...(unit === "bb" ? { unit: "bb" as const } : {}),
    ...(stackUnit === "bb" ? { stackUnit: "bb" as const } : {}),
    ...(board.length ? { board } : {}),
    ...(boardAt !== null ? { boardAt } : {}),
    ...(focus && focus !== "hand" ? { focus } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(typeof level === "number" && r.levelGuess === true ? { levelGuess: true as const } : {}),
    ...(d.editing && r.noAnte === true ? { noAnte: true as const } : {}),
    ...(blinds ? { blinds } : {}),
    ...(act ? { act } : {}),
  };
}

/** The stored editor state with valid fields only; `stage` and `size` are the fallbacks for a first visit. */
export function cleanFastState(x: unknown, stage: PreStage = "mid", size = 9): FastState {
  const r = obj(x);
  const players = isSize(r.players) ? r.players : isSize(size) ? size : 9;
  const draft = cleanDraft(r.draft ?? {}, players);
  const parked = r.parked && draft.editing ? cleanDraft(r.parked, players) : null;
  const pick = obj(r.levelPick);
  const pickT = typeof pick.t === "string" && pick.t && pick.t.length <= 64 ? pick.t : null;
  const levelPick =
    typeof pick.at === "number" && Number.isFinite(pick.at) && (pick.level === null || (typeof pick.level === "number" && (levelRow(pick.level) || anyPresetLevel(pick.level))))
      ? { level: pick.level as number | null, at: pick.at, ...(pickT ? { t: pickT } : {}) }
      : null;
  return {
    stage: isStage(r.stage) ? r.stage : stage,
    players,
    draft,
    parked: parked && !parked.editing ? parked : null,
    ...(r.unit === "bb" ? { unit: "bb" as const } : {}),
    ...(r.stackUnit === "bb" ? { stackUnit: "bb" as const } : {}),
    ...(r.view === "bb" ? { view: "bb" as const } : {}),
    ...(r.actions === true ? { actions: true as const } : {}),
    ...(levelPick ? { levelPick } : {}),
    ...(r.noAnte === true ? { noAnte: true as const } : {}),
    ...(r.entry === "amount" ? { entry: "amount" as const } : {}),
  };
}

// ───────────── today's hands ─────────────

/** A pause this long between two 빠른 기록 hands ends a session. */
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
/** The newest hand this long ago: no session is on. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

/**
 * Today's session: the 빠른 기록 hands of the mode's kind (mine, or other players') back from the newest
 * until a 6-hour pause, newest first; none if the newest is over 12 hours old.
 */
export function sessionOf(hands: LoggedHand[], now: number, mode: FastMode = "mine"): LoggedHand[] {
  const fast = hands.filter((h) => h.fast === true && kindFits(h, mode)).sort((a, b) => b.createdAt - a.createdAt);
  if (!fast.length || now - fast[0].createdAt > SESSION_IDLE_MS) return [];
  const out = [fast[0]];
  for (let i = 1; i < fast.length && out[out.length - 1].createdAt - fast[i].createdAt <= SESSION_GAP_MS; i++) out.push(fast[i]);
  return out;
}

export interface FastStats {
  total: number;
  by: Record<VerdictKind, number>;
  /** Of `by.none`, the 참고 ones: a chart answered, but not to grade by (the rest have no chart). */
  ref: number;
  /** Hands with a chart grade for the spot (all but 참고 and 차트 없음). */
  graded: number;
  /** 차트대로 out of `graded`, 0~100, null with none graded. */
  okPct: number | null;
}

export function fastStats(hands: LoggedHand[]): FastStats {
  const by: Record<VerdictKind, number> = { ok: 0, mixed: 0, over: 0, under: 0, none: 0 };
  let ref = 0;
  for (const h of hands) {
    const v = fastVerdictOf(h);
    by[v?.kind ?? "none"]++;
    if (v?.ref) ref++;
  }
  const graded = hands.length - by.none;
  return { total: hands.length, by, ref, graded, okPct: graded ? Math.round((by.ok / graded) * 100) : null };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * A 빠른 기록 hand's chips in words: "+12,000 (+20bb)", "폴드", "폴드 −300 (−0.5bb)", "본전", "수익" for a
 * win without an amount; "" with no result.
 */
export function resultText(h: Pick<LoggedHand, "result" | "net" | "level"> & { blinds?: Blinds }): string {
  const p = resultParts(h);
  return p.bb ? `${p.text} (${p.bb})` : p.text;
}

/**
 * The same as the screen shows it, the bb apart so it can stand out next to the chips: "폴드 −300" and
 * "−0.5bb", "+12,000" and "+20bb", "본전" / "수익" / "" with no bb (null: also without a level).
 */
export function resultParts(h: Pick<LoggedHand, "result" | "net" | "level"> & { blinds?: Blinds }): { text: string; bb: string | null } {
  const lv = handLv(h);
  if (h.result === "fold") return h.net ? { text: `폴드 ${signedText(h.net, "chips")}`, bb: bbPart(h.net, lv, true) } : { text: "폴드", bb: null };
  if (h.net !== null) return h.net === 0 ? { text: "본전", bb: null } : { text: signedText(h.net, "chips"), bb: bbPart(h.net, lv, true) };
  // A sign with no chips yet: ⏳ (filled at the next 칩 업데이트).
  return { text: h.result === "win" ? "수익 ⏳" : h.result === "lose" ? "손실 ⏳" : h.result === "chop" ? "본전" : "", bb: null };
}

/** A hand has a chip result or a remembered board to show. */
export const hasChips = (h: Pick<LoggedHand, "result" | "net" | "board">): boolean => h.result !== null || h.net !== null || h.board.length > 0;

/**
 * One hand as a line: "21:05 미들 CO K9o 오픈 ⚠ 오버플레이 (차트: 폴드)" (another player's: "⚠ 차트보다 루즈
 * (차트: 폴드)"), then its result and board: " · +12,000 (+20bb) · 보드 K♥ 7 2". Saved without a decision:
 * "21:05 BTN AKs +12,000 (+20bb) · 보드 K♥ 7 2".
 */
export function fastLineText(h: LoggedHand): string {
  const board = h.board.length ? ` · 보드 ${rememberedText(h)}` : "";
  const res = resultText(h);
  if (!fastActed(h)) return [clock(h.createdAt), h.seat, holeClass(h), res].filter(Boolean).join(" ") + board;
  const v = fastVerdictOf(h);
  const stage = h.quickPre?.stage ? STAGE_LABEL[h.quickPre.stage] : "";
  const act = fastActText(h);
  // A walk says so once.
  return [clock(h.createdAt), stage, h.seat, holeClass(h), act, v && v.text !== act ? v.text : ""].filter(Boolean).join(" ") + (res ? ` · ${res}` : "") + board;
}

/** A tournament's lines for the copy text (fastTourney.ts infoOf). */
export interface SessionInfo {
  /** "11/17 토너먼트", or the name typed. */
  title: string;
  /** "11월 17일 (월) 19:00 시작", "11월 17일 (월) 21:05부터". */
  when: string;
  /** Chips at the start, null: not known. */
  startStack: number | null;
  memo: string;
  /** Its 칩 업데이트, when any. */
  checks?: StackCheck[];
  /** A ready-made structure's event ("WPL 메인 이벤트"): it stands in place of 펍 토너먼트. */
  event?: string;
  /** A ready-made structure's line after "구조: " ("DAY1 · 30분 레벨 · L1–L4"). */
  structure?: string;
}

/**
 * "오늘 요약 복사": the session in short text, for asking Claude later: my chips over the session (with
 * the stack where 지금 스택 was typed), the big pots, overplays and underplays, then every hand. In "other"
 * mode the hands are other players' (남의 핸드): looser and tighter than the chart first. With a
 * tournament's `info` (요약 복사), the first line names it and its start, the stack line runs from its start
 * stack when known, and its memo follows; without, the text is what it always was.
 */
export function sessionText(hands: LoggedHand[], mode: FastMode = "mine", info?: SessionInfo): string {
  if (!hands.length) return "";
  const other = mode === "other";
  const acted = other ? hands : hands.filter(fastActed);
  const s = fastStats(acted);
  const [over, under] = other ? ["차트보다 루즈", "차트보다 타이트"] : ["오버플레이", "언더플레이"];
  const old = [...hands].sort((a, b) => a.createdAt - b.createdAt);
  const day = new Date(old[0].createdAt).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  const head = info ? `${info.title} · ${info.when}` : day;
  const event = info?.event ?? "펍 토너먼트";
  const lines = [
    other
      ? `PubAJ 남의 핸드 · ${head} · ${hands.length}핸드 (${event}에서 본 다른 사람 핸드, 계산된 차트 기준)`
      : `PubAJ 빠른 기록 · ${head} · ${hands.length}핸드 (${event}${acted.length ? ", 계산된 차트 기준" : ""})`,
  ];
  if (info?.structure) lines.push(`구조: ${info.structure}`);
  const memo = info?.memo.trim();
  if (memo) lines.push(`메모: ${memo.replace(/\s*\n\s*/g, " / ")}`);
  const startStack = info?.startStack ?? null;
  const checks = info?.checks ?? [];
  if (!other) {
    const m = sessionMoney(hands);
    // Where 지금 스택 or a 칩 업데이트 disagreed with the count (hands missed, a count put right), the result is the stack's change: the hands logged plus the rest.
    const missed = missedOf(hands, startStack, checks);
    if (m.withResult || missed) {
      const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "");
      const chips = (n: number) => `${sign(n)}${Math.abs(n).toLocaleString()}칩`;
      const bbOf = (n: number | null) => (n !== null ? ` (${sign(n)}${Math.abs(Math.round(n * 10) / 10)}bb)` : "");
      const bb = missed ? (m.bb !== null && missed.bb !== null ? m.bb + missed.bb : null) : m.bb;
      // 빠진 핸드: the jumps other than 칩 업데이트 and 결과 모름 (shown when there are any, or nothing else to show).
      const lost = missed ? missedPart(missed).chips : 0;
      const split = missed
        ? ` (기록한 핸드 ${chips(m.chips)}${(!missed.upd && !missed.gap) || lost ? ` · 빠진 핸드 ${chips(lost)}` : ""}${missed.gap ? ` · 결과 모름 ${chips(missed.gap.chips)}` : ""}${missed.upd ? ` · 칩 업데이트 ${chips(missed.upd.chips)}` : ""})`
        : "";
      lines.push(`결과 ${chips(m.chips + (missed?.chips ?? 0))}${bbOf(bb)}${split} · 수익 ${m.won} · 손실 ${m.lost} · 폴드 ${m.folds} · 결과 없음 ${m.noResult}`);
    }
    const first = old.find((h) => h.stack !== null);
    const lastAnchor = [...old].reverse().find((h) => h.stack !== null);
    const run = startStack !== null || checks.length ? chipSeries(hands, "chips", startStack, checks) : null;
    if (startStack !== null) {
      // From the tournament's start stack to now: the graph's run (지금 스택 and 칩 업데이트 where typed, the nets between).
      lines.push(`시작 스택 ${startStack.toLocaleString()}${run ? ` → 지금 ${Math.round(run.end).toLocaleString()}` : ""}`);
    } else if (run?.absolute) {
      lines.push(`스택 ${Math.round(run.start).toLocaleString()} → ${Math.round(run.end).toLocaleString()} (지금 스택·칩 업데이트 기준)`);
    } else if (first && lastAnchor) {
      // From the first stack typed back to the start, to the last one forward: the nets in between.
      const before = old.slice(0, old.indexOf(first)).reduce((t, h) => t + (h.net ?? 0), 0);
      const after = old.slice(old.indexOf(lastAnchor)).reduce((t, h) => t + (h.net ?? 0), 0);
      lines.push(`스택 ${((first.stack as number) - before).toLocaleString()} → ${((lastAnchor.stack as number) + after).toLocaleString()} (지금 스택 기준)`);
    }
    if (checks.length) {
      const steps = checkSteps(hands, startStack, checks).map((c) => `${clock(c.at)} ${chipsText(c.stack)}${c.diff ? ` (${netBoth(c.diff, null)})` : ""}`);
      lines.push(`칩 업데이트 ${steps.join(" · ")}`);
    }
  }
  if (acted.length) lines.push(`차트대로 ${s.by.ok}/${s.graded}${s.okPct !== null ? ` (${s.okPct}%)` : ""} · 섞는 핸드 ${s.by.mixed} · ${over} ${s.by.over} · ${under} ${s.by.under}${s.ref ? ` · 참고 ${s.ref}` : ""} · 차트 없음 ${s.by.none - s.ref}`);
  if (!other) {
    const big = old.filter((h) => {
      const row = blindsOf(handLv(h));
      return row && h.net !== null && Math.abs(h.net) >= 10 * row.bb;
    });
    if (big.length) lines.push("", "[큰 팟 · 10bb 이상]", ...big.map((h) => `- ${fastLineText(h)}`));
  }
  const kind = (k: VerdictKind) => old.filter((h) => fastVerdictOf(h)?.kind === k);
  for (const [k, title] of [["over", over], ["under", under]] as const) {
    const xs = kind(k);
    if (xs.length) lines.push("", `[${title}]`, ...xs.map((h) => `- ${fastLineText(h)}`));
  }
  lines.push("", "[전체 · 시간순]", ...old.map((h, i) => `${i + 1}. ${fastLineText(h)}`));
  return lines.join("\n");
}

/** The verdict mark for a list row ("–" for a hand without one). */
export const markOf = (h: LoggedHand): string => VERDICT_MARK[fastVerdictOf(h)?.kind ?? "none"];
