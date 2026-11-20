import { cardLabel, handClassOf, rankOf, RANKS, suitOf, type Card } from "../../poker/cards";
import { createStore } from "../../state/store";
import { sanitizeState, SCOUT_KEY } from "../scout/scoutModel";
import { scoutToHands } from "./legacyScout";
import { blindsOf, cleanBlinds, clockText, levelAt, levelRow, parseClock, type Blinds, type LevelEstimate, type Lv } from "./levelClock";
import { actedPreflop, cleanPre, isStage, knownStage, preHasInfo, preSteps, shoveCap, STAGE_LABEL, summaryOf, summaryOfGame, summaryText, tidyPre, type PreStage, type QuickPre } from "./quickPre";
import { amountLabel, MY_TAGS, positionsFor, POSITIONS, replay, streetLines, type LogStep, type SeatTags, type StepKind, type TableInput } from "./recorder";
import { actLabel, fastVerdict, isFastSpot, theirWords, type FastInput, type FastSpot, type Verdict } from "./fastVerdict";
import { cleanGuess, describeGuess, flopFromRanks, holeFromRanks, nextBoardCard, setBoardGuess, setHoleGuess, type FlopTexture, type HoleKind, type SuitGuess } from "./suitGuess";
import { cleanTourneys, isTourneyId, mergeTourneys, type Tourney } from "./tourney";

/**
 * Hands the user played at the pub, kept in this browser's localStorage only
 * (no server, no cost). Export/import as a JSON file is the backup.
 */

export type Result = "win" | "lose" | "chop" | "fold";
export const RESULT_LABEL: Record<Result, string> = { win: "이김", lose: "짐", chop: "찹", fold: "폴드" };

export const LOG_STREETS = ["preflop", "flop", "turn", "river"] as const;
export type LogStreet = (typeof LOG_STREETS)[number];
export const LOG_STREET_LABEL: Record<LogStreet, string> = { preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버" };

/** What an opponent showed down. */
export interface ShowdownNote {
  /** Nickname for the player ("빨간모자"), "" if unknown. */
  name: string;
  seat: string;
  cards: Card[];
  /** What they did with it: "올인 콜", "3벳" ... */
  did: string;
}

/** Whose hand a record is: mine (absent means mine), or another player's that I watched. */
export type HandKind = "mine" | "other";

export interface LoggedHand {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Players dealt in (2~10). */
  players: number;
  /** The BB posts a BB-sized ante. */
  bbAnte: boolean;
  /** Blind level number (levelClock PUB_SCHEDULE, Lv1-30), null if not entered. */
  level: number | null;
  /**
   * The replay's hero (the "subject"): me in my own hand; in another player's hand (kind "other") the
   * player watched. `seat`, `hole`, `stack`, `result` and `net` are always the subject's, so the replay,
   * equity and decision grading work the same for both kinds.
   */
  seat: string;
  hole: Card[];
  /** The subject's chips at the start of the hand. */
  stack: number | null;
  note: string;
  result: Result | null;
  /** Chips won (+) or lost (−). */
  net: number | null;
  board: Card[];
  /** Every seat's actions, replayed through the play engine (see recorder.ts). */
  steps: LogStep[];
  /** Starting stacks in bb for seats that differ from mine. */
  stacks: Record<string, number>;
  /** Free-text notes per street (older hands were recorded this way). */
  actions: Record<LogStreet, string>;
  showdowns: ShowdownNote[];
  /** Jotted on the quick-record screen: it opens there again until actions are recorded on the table. */
  quick?: boolean;
  /**
   * The quick screen's preflop block (stage, the subject's action, the open). Kept when the hand is
   * carried on to the table, where it becomes the first steps; from then on the steps are the record.
   */
  quickPre?: QuickPre;
  /** "other": another player's hand I watched (정보 수집); absent: mine. Only "other" is stored. */
  kind?: HandKind;
  /** In another player's hand: my own seat, if I was dealt in at that table (never the subject's seat). */
  mySeat?: string;
  /** Suits that were guessed from remembered ranks (suitGuess.ts): the hole cards, and board cards by index. */
  guess?: SuitGuess;
  /** With guessed hole suits: what was remembered about them. Absent for a pair or when not guessed. */
  holeKind?: HoleKind;
  /** The level came from the tournament start time (levelEstimateAt), not from the user. */
  levelGuess?: true;
  /**
   * Saved on 빠른 기록: my seat and class, and the chip result (`result`, `net`) and the board cards I
   * remember (`board`, suits typed or guessed: `guess.board`); with `fastSpot` also my preflop decision
   * (what happened before me, my action; the stage, the action and the opener are in `quickPre`). Kept
   * if the hand is carried on to the table.
   */
  fast?: true;
  /** 빠른 기록: what happened before my decision, only when the decision was recorded. Only with `fast`. */
  fastSpot?: FastSpot;
  /** 빠른 기록: the amount (`net`) was typed in bb, so a correction opens it in bb. Only with `fast`; absent: chips. */
  fastUnit?: "bb";
  /**
   * 빠른 기록: the result was worked out from 지금 스택 (스택: my chips after the hand less my stack before it;
   * the stack before unknown: no result), so a correction opens it that way and works it out again. Only with `fast`.
   */
  fastStack?: true;
  /**
   * 빠른 기록 / 남의 핸드: the tournament (Tourney.id, tourney.ts) the hand was logged in. Absent: logged before
   * tournaments existed (grouped by time gaps under 이전 기록). Never set by the table flow.
   */
  tourney?: string;
  /**
   * 빠른 기록 in a 직접 입력 tournament (and 남의 핸드 there): the blinds the hand was played at; `level` is null then
   * and `bbAnte` is `blinds.ante > 0`. In a ready-made structure's tournament (WPL) the same, with the level's
   * number in `blinds.lv` (an older app reads the hand as 직접 입력 at those blinds). Absent: the hand's blinds are
   * its level's (PUB_SCHEDULE), as always.
   */
  blinds?: Blinds;
}

/** The day's tournament start: the local day the clock time falls on, and the clock ("19:00"). */
export interface StartClock {
  /** Local date "YYYY-MM-DD". */
  day: string;
  clock: string;
}

/** The old 정보 수집 records were copied into other-hands (see importScout). */
export interface ScoutImport {
  /** When the copy last ran. */
  at: number;
  /** Signature of the "mygto.scout" text copied: the same text again does nothing. */
  sig: string;
  /** Every hand id the copy has made: never made again, even after the user deletes one. */
  ids: string[];
}

export interface HandLogState {
  hands: LoggedHand[];
  /** Level and table size of the last saved hand, so the next entry starts there. */
  lastLevel: number | null;
  lastPlayers?: number;
  /** Stack stage of the last hand that told one (tapped, or from its stack), for the quick screen's preflop block. */
  lastStage?: PreStage;
  /** The tournament start set last, for estimating a forgotten level (todayStart / setTodayStart); also the clock offered next time. */
  startClock?: StartClock;
  /** Every day's tournament start (one per day, oldest first): a later day never replaces an earlier one. */
  startClocks?: StartClock[];
  /** The scout records' one-time copy into other-hands has run (importScout). */
  scoutImport?: ScoutImport;
  /** 빠른 기록's tournaments (tourney.ts), oldest first: kept like the start times, in the backup too. */
  tourneys?: Tourney[];
}

export const handLogStore = createStore<HandLogState>("mygto.handlog", { hands: [], lastLevel: null });

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A blank hand: mine, or with kind "other" another player's. */
export function emptyHand(level: number | null = handLogStore.get().lastLevel, kind: HandKind = "mine"): LoggedHand {
  const now = Date.now();
  return {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    players: handLogStore.get().lastPlayers ?? 9,
    bbAnte: true,
    level,
    seat: "",
    hole: [],
    stack: null,
    note: "",
    result: null,
    net: null,
    board: [],
    steps: [],
    stacks: {},
    actions: { preflop: "", flop: "", turn: "", river: "" },
    showdowns: [],
    ...(kind === "other" ? { kind } : {}),
  };
}

export const emptyShowdown = (): ShowdownNote => ({ name: "", seat: "", cards: [], did: "" });

// ───────────── whose hand ─────────────

/** Another player's hand that I watched (the subject is them, not me). */
export const isOther = (h: Pick<LoggedHand, "kind">): boolean => h.kind === "other";

/**
 * Who the hand is about, as one word: "나" for my hands, "상대" for another player's. The same word
 * names the subject everywhere: the tag on the table ("나" / "상대"), seat tags in action lines
 * ("(나)" / "(상대)", heroTag) and labels ("내 핸드" / "상대 핸드", subjectWord).
 */
export const subjectLabel = (h: Pick<LoggedHand, "kind">): string => (isOther(h) ? "상대" : "나");

/** A label about the subject: subjectWord(h, "핸드") is "내 핸드" or "상대 핸드". */
export const subjectWord = (h: Pick<LoggedHand, "kind">, noun: string): string => `${isOther(h) ? "상대" : "내"} ${noun}`;

/** The tag after the subject's seat in action lines and turn labels: "(나)" or "(상대)". */
export const heroTag = (h: Pick<LoggedHand, "kind">): string => `(${subjectLabel(h)})`;

/** The seat tags for streetLines: the subject, and in another player's hand my own seat as "(나)". */
export function seatTags(h: Pick<LoggedHand, "kind" | "mySeat">): SeatTags {
  if (!isOther(h)) return MY_TAGS;
  return h.mySeat ? { hero: heroTag(h), seats: { [h.mySeat]: "(나)" } } : { hero: heroTag(h) };
}

/** A seat with its tag for this hand: "BB(나)", "CO(상대)", "BTN". */
export function seatName(h: Pick<LoggedHand, "kind" | "mySeat" | "seat">, seat: string): string {
  const t = seatTags(h);
  return `${seat}${seat === h.seat ? t.hero : (t.seats?.[seat] ?? "")}`;
}

// ───────────── guessed suits ─────────────

const HOLE_KINDS: readonly HoleKind[] = ["suited", "offsuit", "unknown"];
const isHoleKind = (x: unknown): x is HoleKind => typeof x === "string" && (HOLE_KINDS as readonly string[]).includes(x);

/** The remembered suitedness agrees with the cards picked (a pair is never "suited"). */
function kindFits(kind: HoleKind, hole: Card[]): boolean {
  if (kind === "unknown") return true;
  const pair = rankOf(hole[0]) === rankOf(hole[1]);
  const same = suitOf(hole[0]) === suitOf(hole[1]);
  return kind === "suited" ? !pair && same : !same;
}

/**
 * The hand with its guess markers matching its cards: a hole guess needs two hole cards, board indexes
 * must be dealt, `holeKind` goes with a hole guess and must agree with the cards. The same object comes
 * back when nothing changes. Call it after the cards change.
 */
export function tidyGuess(h: LoggedHand): LoggedHand {
  const g = cleanGuess(h.guess);
  const hole = g?.hole && h.hole.length === 2 ? true : undefined;
  const guess = cleanGuess({ hole, board: (g?.board ?? []).filter((i) => i < h.board.length) });
  const holeKind = guess?.hole && isHoleKind(h.holeKind) && kindFits(h.holeKind, h.hole) ? h.holeKind : undefined;
  const sameGuess = guess ? JSON.stringify(guess) === JSON.stringify(h.guess) : !("guess" in h);
  const sameKind = holeKind ? holeKind === h.holeKind : !("holeKind" in h);
  if (sameGuess && sameKind) return h;
  const { guess: _g, holeKind: _k, ...rest } = h;
  void _g;
  void _k;
  return { ...rest, ...(guess ? { guess } : {}), ...(holeKind ? { holeKind } : {}) };
}

/** 빠른 기록's marks out of step: the flag other than true, or a spot, a unit or a 스택 mark without it or not a known one. */
const badFastMarks = (h: LoggedHand): boolean =>
  ("fast" in h && h.fast !== true) ||
  ("fastSpot" in h && (h.fast !== true || !isFastSpot(h.fastSpot))) ||
  ("fastUnit" in h && (h.fast !== true || h.fastUnit !== "bb")) ||
  ("fastStack" in h && (h.fast !== true || h.fastStack !== true));

/**
 * The hand with every derived marker in step with the rest: tidyGuess, my seat only in another player's
 * hand and never the subject's seat or one missing at this table size, an estimated level only with a
 * level. The same object comes back when nothing changes. Call it on every edit before saving.
 */
export function tidyHand(h: LoggedHand): LoggedHand {
  let next = noRepeats(reguess(tidyGuess(h)));
  const mySeatOk = isOther(next) && typeof next.mySeat === "string" && next.mySeat !== next.seat && positionsFor(next.players).includes(next.mySeat);
  if ("mySeat" in next && !mySeatOk) {
    const { mySeat: _m, ...rest } = next;
    void _m;
    next = rest;
  }
  if ("levelGuess" in next && (next.levelGuess !== true || next.level === null)) {
    const { levelGuess: _l, ...rest } = next;
    void _l;
    next = rest;
  }
  // 빠른 기록's marks: the flag only as true, its spot, its unit and its 스택 mark only with it and only known ones.
  if (badFastMarks(next)) {
    const { fast, fastSpot, fastUnit, fastStack, ...rest } = next;
    next = fast === true ? { ...rest, fast, ...(isFastSpot(fastSpot) ? { fastSpot } : {}), ...(fastUnit === "bb" ? { fastUnit } : {}), ...(fastStack === true ? { fastStack } : {}) } : rest;
  }
  // The tournament it was logged in: only a usable id.
  if ("tourney" in next && !isTourneyId(next.tourney)) {
    const { tourney: _t, ...rest } = next;
    void _t;
    next = rest;
  }
  // Blinds typed by hand: only valid ones, and only while no schedule level is set (a level picked later wins).
  if ("blinds" in next && (next.level !== null || !cleanBlinds(next.blinds))) {
    const { blinds: _b, ...rest } = next;
    void _b;
    next = rest;
  }
  return next;
}

/** The hole cards' suits were guessed. */
export const holeGuessed = (h: Pick<LoggedHand, "hole" | "guess">): boolean => h.guess?.hole === true && h.hole.length === 2;

/** The subject's hole cards if their suits are known (typed exactly); none when they were guessed. */
export const knownHole = (h: Pick<LoggedHand, "hole" | "guess">): Card[] => (holeGuessed(h) ? [] : h.hole);

/** The board cards from index `from` up to `to` whose suits are known (not guessed). */
export function knownBoard(h: Pick<LoggedHand, "board" | "guess">, from = 0, to = 5): Card[] {
  const g = h.guess?.board ?? [];
  return h.board.flatMap((c, i) => (i >= from && i < to && !g.includes(i) ? [c] : []));
}

/**
 * Every card on the hand whose suit is known: the exact hole cards, the board cards not guessed and the
 * cards shown down. An exact card field takes these as used; guessed cards give way to it (reguess).
 */
export const knownCards = (h: Pick<LoggedHand, "hole" | "board" | "guess" | "showdowns">): Card[] => [...knownHole(h), ...knownBoard(h), ...h.showdowns.flatMap((s) => s.cards)];

/** The guessed hole cards and guessed board cards, for a new guess to steer clear of (it gives way to known cards only). */
export const guessedCards = (h: Pick<LoggedHand, "hole" | "board" | "guess">): Card[] => [...(holeGuessed(h) ? h.hole : []), ...h.board.filter((_, i) => (h.guess?.board ?? []).includes(i))];

const flopTexture = (flop: Card[]): { tex: Exclude<FlopTexture, "unknown">; pair?: [number, number] } => {
  const s = flop.map(suitOf);
  const n = new Set(s).size;
  if (n === 3) return { tex: "rainbow" };
  if (n === 1) return { tex: "monotone" };
  return { tex: "twotone", pair: s[0] === s[1] ? [0, 1] : s[0] === s[2] ? [0, 2] : [1, 2] };
};

/**
 * Known cards always win over guessed ones: a guessed card that a card typed exactly (the board, a hand
 * shown down, the hole cards) now lands on is picked again from the same ranks, and only that guess: the
 * hole cards with what was remembered (suited / offsuit), a guessed flop keeping its texture (which two
 * share a suit), a turn or river as a new suit or the flush suit as before. The same object comes back
 * when nothing clashes.
 */
export function reguess(h: LoggedHand): LoggedHand {
  const gBoard = (h.guess?.board ?? []).filter((i) => i < h.board.length);
  const holeG = holeGuessed(h);
  if (!holeG && !gBoard.length) return h;
  const known = knownCards(h);
  const used = new Set<Card>(known);
  let hole = h.hole;
  let board = h.board;
  if (holeG && (hole.some((c) => used.has(c)) || hole[0] === hole[1])) {
    const [r1, r2] = [rankOf(hole[0]), rankOf(hole[1])];
    const kind = r1 === r2 ? "unknown" : (h.holeKind ?? "unknown");
    const avoid = [...used, ...gBoard.map((i) => board[i])];
    const next = holeFromRanks(r1, r2, kind, avoid, board) ?? holeFromRanks(r1, r2, kind, [...used], board);
    if (next) hole = next;
  }
  if (holeG) hole.forEach((c) => used.add(c));
  const guessedAt = (i: number) => gBoard.includes(i);
  // A whole guessed flop that clashes is picked again as a whole, so it keeps its texture.
  if ([0, 1, 2].every(guessedAt) && board.slice(0, 3).some((c) => used.has(c))) {
    const flop = board.slice(0, 3);
    const { tex, pair } = flopTexture(flop);
    const ranks = flop.map(rankOf) as [number, number, number];
    const later = board.slice(3).filter((_, k) => guessedAt(3 + k));
    const next = flopFromRanks(ranks, tex, [...used, ...later], pair) ?? flopFromRanks(ranks, tex, [...used], pair) ?? flopFromRanks(ranks, "unknown", [...used]);
    if (next) board = [...next, ...board.slice(3)];
  }
  // Any other guessed card that clashes (with a known card, the hole or a board card before it): just that card.
  const placed = new Set<Card>(used);
  for (let i = 0; i < board.length; i++) {
    const c = board[i];
    if (!guessedAt(i)) continue;
    if (placed.has(c) || board.slice(0, i).includes(c)) {
      const before = board.slice(0, i);
      const ctx = i < 3 ? board.slice(0, 3).filter((_, k) => k !== i) : before;
      const flushy = ctx.filter((x) => suitOf(x) === suitOf(c)).length >= (i < 3 ? 1 : 2);
      const taken = [...placed, ...before];
      const next = nextBoardCard(rankOf(c), ctx, flushy ? "flushSuit" : "newSuit", taken) ?? nextBoardCard(rankOf(c), ctx, "unknown", taken);
      if (next !== null) board = [...board.slice(0, i), next, ...board.slice(i + 1)];
    }
    placed.add(board[i]);
  }
  if (hole === h.hole && board === h.board) return h;
  return tidyGuess({ ...h, hole, board });
}

/**
 * Never a known card twice on one hand (an import, an older version, a field that missed a card): the
 * hole cards win, then the board (cut before its first repeat, as the board is dealt in order), then the
 * hands shown down (a repeated one loses its cards). The same object comes back when nothing repeats.
 */
export function noRepeats(h: LoggedHand): LoggedHand {
  const seen = new Set<Card>();
  const hole = h.hole.filter((c, i) => h.hole.indexOf(c) === i);
  hole.forEach((c) => seen.add(c));
  let cut = h.board.length;
  for (let i = 0; i < h.board.length; i++) {
    if (seen.has(h.board[i])) {
      cut = i;
      break;
    }
    seen.add(h.board[i]);
  }
  let sdChanged = false;
  const showdowns = h.showdowns.map((sd) => {
    if (sd.cards.some((c) => seen.has(c)) || (sd.cards.length === 2 && sd.cards[0] === sd.cards[1])) {
      sdChanged = true;
      return { ...sd, cards: [] };
    }
    sd.cards.forEach((c) => seen.add(c));
    return sd;
  });
  if (hole.length === h.hole.length && cut === h.board.length && !sdChanged) return h;
  return tidyGuess({ ...h, hole, board: h.board.slice(0, cut), showdowns });
}

/**
 * The hand class as far as it is known: "ATs" for known cards; with guessed suits what was remembered,
 * "ATs" / "ATo" / "AT" (suitedness unknown) / "TT". "" without two hole cards.
 */
export function holeClass(h: Pick<LoggedHand, "hole" | "guess" | "holeKind">): string {
  if (h.hole.length !== 2) return "";
  if (!holeGuessed(h)) return handClassOf(h.hole[0], h.hole[1]);
  const [hi, lo] = [rankOf(h.hole[0]), rankOf(h.hole[1])].sort((a, b) => b - a);
  if (hi === lo) return RANKS[hi] + RANKS[lo];
  return RANKS[hi] + RANKS[lo] + (h.holeKind === "suited" ? "s" : h.holeKind === "offsuit" ? "o" : "");
}

/** The hand class for labels and grading text: "ATs", or "ATs (수트 추정)" when the suits were guessed. */
export function holeLabel(h: Pick<LoggedHand, "hole" | "guess" | "holeKind">): string {
  const cls = holeClass(h);
  return cls && holeGuessed(h) ? `${cls} (수트 추정)` : cls;
}

/** "플랍·턴 수트 추정" for guessed board cards, "" when the board's suits are all known. */
export function boardGuessText(h: Pick<LoggedHand, "board" | "guess">): string {
  return describeGuess({ board: (h.guess?.board ?? []).filter((i) => i < h.board.length) });
}

/** Something worth saving was entered. */
export function hasContent(h: LoggedHand): boolean {
  return h.hole.length > 0 || h.note.trim() !== "" || h.board.length > 0 || h.showdowns.length > 0 || h.steps.length > 0;
}

/**
 * A hand on file still holds something worth keeping: cards, a note or table actions, or anything else
 * typed into it: the seat, a stack (its own or another seat's), the result, the preflop block, my seat
 * in another player's hand, street notes. So clearing its cards to type them again (⌫⌫ in 수딧·오프만 too)
 * doesn't drop the rest. The level isn't counted: every new hand starts with one, typed or not.
 */
export function worthKeeping(h: LoggedHand): boolean {
  return (
    hasContent(h) ||
    h.seat !== "" ||
    h.stack !== null ||
    h.result !== null ||
    h.net !== null ||
    preHasInfo(h.quickPre) ||
    !!h.mySeat ||
    Object.keys(h.stacks).length > 0 ||
    LOG_STREETS.some((st) => h.actions[st].trim() !== "")
  );
}

/**
 * The card field holds cards that can be kept: it is clean (`cardsClean`: no typo or half-typed card,
 * otherwise `hole` is an older parse than what is on screen) and holds two cards or none. One card isn't a hand.
 */
const cardsUsable = (h: LoggedHand, cardsClean: boolean) => cardsClean && h.hole.length !== 1;

/**
 * What a quick hand on screen puts on file. While the card field is mid-edit (a typo, a half-typed card,
 * one card alone) its cards don't count: the ones on file stand in (none for a new hand), so the seat,
 * stack, result and note are still kept.
 */
export function quickCopy(stored: LoggedHand | null, shown: LoggedHand, cardsClean: boolean): LoggedHand {
  if (cardsUsable(shown, cardsClean)) return shown;
  const hole = stored ? stored.hole : [];
  // The cards on file go with their own guess marker (the board's marks stay as shown).
  const { guess, holeKind: _k, ...rest } = shown;
  void _k;
  const g = cleanGuess({ hole: stored && holeGuessed(stored) ? true : undefined, board: guess?.board });
  const kind = g?.hole ? stored?.holeKind : undefined;
  return { ...rest, hole, ...(g ? { guess: g } : {}), ...(kind ? { holeKind: kind } : {}) };
}

/** Why a quick hand with nothing on file isn't saved yet, or null when it can be. */
export function memoBlocker(h: LoggedHand, cardsClean: boolean): string | null {
  if (hasContent(quickCopy(null, h, cardsClean))) return null;
  return cardsUsable(h, cardsClean) ? "카드 두 장이나 메모를 넣으면 바로 저장돼요" : "카드 두 장을 맞게 넣으면 저장돼요";
}

export type QuickSave = "none" | "save" | "delete";

/**
 * What the quick-record screen does with an edit: `stored` is the copy on file (null if none), `shown`
 * what the screen shows; a save writes quickCopy(stored, shown, cardsClean). A new hand is saved the
 * moment it has two clean cards or a note, and every later edit goes to the same hand, even while the
 * card field is mid-edit (the last good cards stay on file then). It is deleted only once nothing worth
 * keeping is left in it (untouched hands are never stored).
 */
export function quickSaveAction(stored: LoggedHand | null, shown: LoggedHand, cardsClean: boolean): QuickSave {
  const keep = quickCopy(stored, shown, cardsClean);
  if (!stored) return hasContent(keep) ? "save" : "none";
  if (!worthKeeping(keep)) return "delete";
  return sameHand(stored, keep) ? "none" : "save";
}

/**
 * Nothing on the quick screen is waiting to be written: it shows exactly the hand on file (or, with none
 * on file, nothing worth saving), so it can be left for the next hand or the table without losing an edit.
 */
export function quickSettled(stored: LoggedHand | null, shown: LoggedHand, cardsClean: boolean): boolean {
  if (!cardsClean) return false;
  return stored ? sameHand(stored, shown) : !hasContent(shown);
}

/** The same hand apart from when it was last saved (so re-checking an unchanged hand writes nothing). */
function sameHand(a: LoggedHand, b: LoggedHand): boolean {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  keys.delete("updatedAt");
  for (const k of keys) if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) return false;
  return true;
}

/**
 * A hand jotted on the quick-record screen with nothing recorded on the table yet (no actions, board
 * or showdowns): it opens on the quick screen again, which shows everything it holds.
 */
export function isQuickHand(h: LoggedHand): boolean {
  return h.quick === true && h.steps.length === 0 && h.board.length === 0 && h.showdowns.length === 0;
}

/** Where a saved hand opens: the table flow (at its first missing step), mine or another player's. */
export const handRoute = (h: Pick<LoggedHand, "id">): string => `log/${h.id}`;

// ───────────── 빠른 기록 ─────────────

/**
 * A hand from 빠른 기록 with nothing recorded on the table yet (no steps or showdowns). A board alone
 * comes from 빠른 기록 itself (the cards remembered), so it stays one.
 */
export const fastOnly = (h: LoggedHand): boolean => h.fast === true && h.steps.length === 0 && h.showdowns.length === 0;

/** 빠른 기록 with my preflop decision on file (a spot; an action, or a walk): what the chart grades. */
export const fastActed = (h: Pick<LoggedHand, "fast" | "fastSpot" | "quickPre">): boolean => h.fast === true && (isFastSpot(h.fastSpot) || h.quickPre?.action !== undefined);

/** A 빠른 기록 hand as the verdict reads it (null for a hand not from there, without its class, or saved without a decision). */
export function fastInputOf(h: LoggedHand): FastInput | null {
  if (!fastActed(h) || h.hole.length !== 2) return null;
  const cls = holeClass(h);
  if (cls.length < 2 || (cls.length === 2 && cls[0] !== cls[1])) return null;
  return {
    stage: h.quickPre?.stage ?? "mid",
    players: h.players,
    seat: h.seat,
    cls,
    spot: h.fastSpot ?? "none",
    ...(h.quickPre?.openerSeat ? { opener: h.quickPre.openerSeat } : {}),
    ...(h.quickPre?.action ? { act: h.quickPre.action } : {}),
  };
}

/**
 * The chart's verdict on a 빠른 기록 hand (null for another hand). Another player's hand (kind "other")
 * is judged the same way but worded from their side: 차트보다 루즈 / 타이트 instead of 오버 / 언더플레이.
 */
export function fastVerdictOf(h: LoggedHand): Verdict | null {
  const i = fastInputOf(h);
  if (!i) return null;
  const v = fastVerdict(i);
  return isOther(h) ? theirWords(v) : v;
}

/** A 빠른 기록 decision in a few words: "UTG 오픈 → 콜", "림프 → 아이소", "3벳 → 4벳", "오픈", "워크". */
export function fastActText(h: Pick<LoggedHand, "seat" | "fastSpot" | "quickPre">): string {
  const spot = h.fastSpot ?? "none";
  const act = h.quickPre?.action;
  const opener = h.quickPre?.openerSeat ?? "";
  const mine = act ? actLabel(spot, act, h.seat) : "워크";
  const before = spot === "limp" ? "림프" : spot === "open" ? `${opener} 오픈` : spot === "shove" ? `${opener} 올인` : spot === "3bet" ? "3벳" : spot === "cold3" ? "오픈·3벳" : "";
  return before ? `${before} → ${mine}` : mine;
}

/**
 * The preflop block as the table should take it (preSteps). A 빠른 기록 hand the block can't place
 * (facing limps or a 3-bet, whose seats it doesn't know, or a fold facing an open, which the block reads
 * as a fold first in) places nothing: the table starts from the first seat rather than with folds that
 * never happened.
 */
export function tablePre(h: LoggedHand): QuickPre | undefined {
  if (h.fast === true) {
    const spot = h.fastSpot ?? "none";
    if (spot === "limp" || spot === "3bet" || spot === "cold3") return undefined;
    if ((spot === "open" || spot === "shove") && h.quickPre?.action === "fold") return undefined;
  }
  return h.quickPre;
}

/** Which hands the past-hands list shows. */
export type ListFilter = "all" | "mine" | "other";

export type LogView =
  | { kind: "new" }
  /** 빠른 기록: every hand of mine, a few taps each. */
  | { kind: "fast" }
  | { kind: "list"; filter: ListFilter }
  | { kind: "players" }
  /** 남의 핸드: another player's hands on the 빠른 기록 screen (other mode). */
  | { kind: "other" }
  /** 빠른 기록's tournaments: the list, one tournament, one group of hands logged before tournaments (by any hand in it). */
  | { kind: "tourneys" }
  | { kind: "tourney"; id: string }
  | { kind: "legacy"; id: string }
  | { kind: "edit"; id: string };

/**
 * The screen a "#log/…" route shows: "" a new hand of mine (the hand first), "fast" 빠른 기록, "list", "list/mine",
 * "list/other", "players", "other" 남의 핸드 (빠른 기록 for other players' hands), "<id>" a saved hand in
 * the table flow, "fast/past" 빠른 기록's tournaments, "fast/t/<id>" one of them, "fast/s/<handId>" a group of
 * 빠른 기록 hands logged before tournaments. The old addresses "other/<id>" (a hand on the old 남의 핸드 screen) and the quick-record
 * routes ("quick", "quick/<id>") open that hand in the table flow, or the entry screen if it is gone.
 */
export function logView(sub: string, hands: LoggedHand[]): LogView {
  if (sub === "" || sub === "new" || sub === "quick") return { kind: "new" };
  if (sub === "fast") return { kind: "fast" };
  // Hand ids never hold a "/", so these never shadow a saved hand.
  if (sub === "fast/past") return { kind: "tourneys" };
  if (sub.startsWith("fast/t/") && sub.length > "fast/t/".length) return { kind: "tourney", id: sub.slice("fast/t/".length) };
  if (sub.startsWith("fast/s/") && sub.length > "fast/s/".length) return { kind: "legacy", id: sub.slice("fast/s/".length) };
  if (sub === "list") return { kind: "list", filter: "all" };
  if (sub === "list/mine") return { kind: "list", filter: "mine" };
  if (sub === "list/other") return { kind: "list", filter: "other" };
  if (sub === "players") return { kind: "players" };
  if (sub === "other") return { kind: "other" };
  if (sub.startsWith("other/")) {
    const id = sub.slice("other/".length);
    // A hand saved on the old 남의 핸드 screen opens in the table flow; deleted meanwhile: the entry screen.
    return hands.some((x) => x.id === id) ? { kind: "edit", id } : { kind: "other" };
  }
  if (sub.startsWith("quick/")) {
    const id = sub.slice("quick/".length);
    return hands.some((x) => x.id === id) ? { kind: "edit", id } : { kind: "new" };
  }
  return { kind: "edit", id: sub };
}

/**
 * Recorded only part of the way: no result yet, and the cards, the seat or the action are still
 * missing (the subject folding ends it too). Shown as "작성 중" in the past hands. Another player's
 * hand collected for its preflop range (cards, seat and what they did, or a note) with nothing on the
 * table is complete as it is: only table actions left mid-way make it 작성 중.
 */
export function unfinished(h: LoggedHand): boolean {
  if (h.result !== null || h.net !== null) return false;
  // A hand jotted on 빠른 기록 is complete as it is, until it is carried on to the table.
  if (fastOnly(h)) return false;
  if (h.hole.length < 2 || !h.seat) return true;
  if (isOther(h) && h.steps.length === 0) return h.quickPre?.action === undefined && h.note.trim() === "";
  const { game } = replay(tableOf(h), h.steps);
  if (game.done) return false;
  return !game.players.some((p) => p.hero && p.folded);
}

/**
 * The hand's preflop in one line, for the past hands: from the quick block (quickPreLine) or, for a
 * hand recorded on the table, from the subject's first preflop action ("CO 오픈 2.5bb", "CO 2.5bb 오픈 → 콜").
 */
export function actionLine(h: LoggedHand): string {
  const pre = quickPreLine(h);
  if (pre || !h.steps.length || !h.seat) return pre;
  const s = summaryOfGame(replay(tableOf(h), h.steps).game, h.seat, shoveBb(h));
  return s ? summaryText(s) : "";
}

/**
 * A new hand (mine, or another player's): the level estimated from today's start time when one is set
 * (marked as estimated), else the last level used.
 */
export function freshHand(kind: HandKind = "mine", now: number = Date.now()): LoggedHand {
  const est = estimatedLevel(levelEstimateAt(now));
  const h = emptyHand(est ?? handLogStore.get().lastLevel, kind);
  return est !== null ? withLevel(h, est, true) : h;
}

/**
 * A new hand's level brought up to the moment `at` (its first save, or a blank hand reused later): a
 * level that came from the start time, or none at all, takes the level the start time says for `at`.
 * A level the user picked, or 레벨 모름 picked on purpose (`declined`), stays. Same object when unchanged.
 */
export function freshLevel(h: LoggedHand, at: number, declined = false): LoggedHand {
  if (!(h.levelGuess === true || (h.level === null && !declined))) return h;
  const lv = estimatedLevel(levelEstimateAt(at));
  return lv !== null && (lv !== h.level || h.levelGuess !== true) ? withLevel(h, lv, true) : h;
}

/** The hand with new hole cards; `guessed` marks their suits as guessed, with what was remembered (`holeKind`). */
export function withHole(h: LoggedHand, hole: Card[], guessed = false, holeKind?: HoleKind): LoggedHand {
  const { guess, holeKind: _k, ...rest } = h;
  void _k;
  const g = setHoleGuess(guess, guessed && hole.length === 2);
  return tidyGuess({ ...rest, hole, ...(g ? { guess: g } : {}), ...(g?.hole && holeKind ? { holeKind } : {}) });
}

/**
 * The hand with a new board: the cards from index `from` on were just entered, their suits `guessed`
 * (from remembered ranks) or typed exactly (which clears their marks).
 */
export function withBoard(h: LoggedHand, board: Card[], from: number, guessed = false): LoggedHand {
  const at = [0, 1, 2, 3, 4].filter((i) => i >= from);
  const g = setBoardGuess(h.guess, at.filter((i) => board[i] !== h.board[i]), false);
  const marked = guessed ? setBoardGuess(g, at.filter((i) => i < board.length), true) : g;
  const { guess: _g, ...rest } = h;
  void _g;
  return tidyGuess({ ...rest, board, ...(marked ? { guess: marked } : {}) });
}

/** Board, street actions, showdowns or a chip result were filled in. */
export function hasDetail(h: LoggedHand): boolean {
  return (
    h.board.length > 0 ||
    h.steps.length > 0 ||
    h.showdowns.length > 0 ||
    h.net !== null ||
    LOG_STREETS.some((s) => h.actions[s].trim() !== "")
  );
}

/**
 * Insert or update a hand. `also` changes the rest of the store in the same write (빠른 기록: the tournament a
 * first hand starts goes on file with it, or neither does). Returns false if the browser refused to store it
 * (storage full): then nothing of it is kept.
 */
export function saveHand(h: LoggedHand, also?: (s: HandLogState) => HandLogState): boolean {
  const prev = handLogStore.get();
  const saved: LoggedHand = { ...h, updatedAt: Date.now() };
  const others = prev.hands.filter((x) => x.id !== h.id);
  const hands = [saved, ...others].sort((a, b) => b.createdAt - a.createdAt);
  // Keep the rest of the store (the day's start time, the scout copy's note, the tournaments) as it is.
  const next: HandLogState = { ...prev, hands, lastLevel: h.level ?? prev.lastLevel, lastPlayers: h.players, ...stageMemo(h, prev) };
  const ok = handLogStore.set(also ? also(next) : next);
  if (!ok) handLogStore.set(prev);
  else requestPersistence();
  return ok;
}

export function deleteHand(id: string): void {
  handLogStore.set((s) => ({ ...s, hands: s.hands.filter((h) => h.id !== id) }));
}

// ───────────── deleting with 되돌리기 ─────────────

/** A hand taken out of the log, with the hand it stood right before (null: it was the last), so 되돌리기 can put it back in its place. */
export interface RemovedHand {
  hand: LoggedHand;
  before: string | null;
}

/** The log without the hands `ids`, and what was taken out, in log order. Every other hand stays as it was, in its order. */
export function removeHands(hands: LoggedHand[], ids: Iterable<string>): { hands: LoggedHand[]; removed: RemovedHand[] } {
  const drop = new Set(ids);
  const kept: LoggedHand[] = [];
  const removed: RemovedHand[] = [];
  let run: LoggedHand[] = [];
  for (const h of hands) {
    if (drop.has(h.id)) {
      run.push(h);
      continue;
    }
    for (const r of run) removed.push({ hand: r, before: h.id });
    run = [];
    kept.push(h);
  }
  for (const r of run) removed.push({ hand: r, before: null });
  return { hands: kept, removed };
}

/**
 * The removed hands back, exactly as they were (same ids, times and content), each right before the hand
 * it stood before; one whose neighbour is gone too goes by its time (the log is newest first). A hand
 * already back in the log (same id) is not doubled. Hands saved in the meantime stay where they are.
 */
export function restoreHands(hands: LoggedHand[], removed: RemovedHand[]): LoggedHand[] {
  const out = [...hands];
  const have = new Set(out.map((h) => h.id));
  for (const { hand, before } of removed) {
    if (have.has(hand.id)) continue;
    let i = before === null ? out.length : out.findIndex((h) => h.id === before);
    if (i < 0) {
      i = out.findIndex((h) => h.createdAt < hand.createdAt);
      if (i < 0) i = out.length;
    }
    out.splice(i, 0, hand);
    have.add(hand.id);
  }
  return out;
}

/** What one delete took out, for 되돌리기: the hands, and whether one of them was the hand put aside from 이어서. */
export interface Deletion {
  removed: RemovedHand[];
  aside: string | null;
}

/**
 * Delete the hands `ids` from the log (the rest of the store untouched, but for what `also` changes in the
 * same write: 빠른 기록's hands by 스택 after them). A pointer to one of them (the hand put aside from 이어서)
 * is let go too. Null when none of them was on file.
 */
export function deleteHands(ids: Iterable<string>, also?: (s: HandLogState) => HandLogState): Deletion | null {
  const prev = handLogStore.get();
  const { hands, removed } = removeHands(prev.hands, ids);
  if (!removed.length) return null;
  const next: HandLogState = { ...prev, hands };
  handLogStore.set(also ? also(next) : next);
  const aside = asideId !== null && removed.some((r) => r.hand.id === asideId) ? asideId : null;
  if (aside) asideId = null;
  return { removed, aside };
}

/**
 * 되돌리기: the deleted hands back in their places (`also`: the rest of the same write, as for deleteHands).
 * False if the browser refused to store them (they stay on screen until reload).
 */
export function undoDeletion(d: Deletion, also?: (s: HandLogState) => HandLogState): boolean {
  const prev = handLogStore.get();
  const next: HandLogState = { ...prev, hands: restoreHands(prev.hands, d.removed) };
  const ok = handLogStore.set(also ? also(next) : next);
  if (d.aside && asideId === null) asideId = d.aside;
  if (ok) requestPersistence();
  return ok;
}

// ───────────── picking hands in 지난 기록 (편집) ─────────────

/** One hand picked or unpicked. */
export const toggleId = (sel: readonly string[], id: string): string[] => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

/** Every one of `ids` is picked (and there is at least one). */
export const allPicked = (sel: readonly string[], ids: readonly string[]): boolean => ids.length > 0 && ids.every((id) => sel.includes(id));

/** 전체 선택: all of `ids` picked, or, when they all already are, none of them. */
export const pickAll = (sel: readonly string[], ids: readonly string[]): string[] => (allPicked(sel, ids) ? sel.filter((x) => !ids.includes(x)) : [...sel, ...ids.filter((id) => !sel.includes(id))]);

/** The picks still in the log (a hand deleted elsewhere drops out), in the log's order. */
export const livePicks = (sel: readonly string[], hands: readonly LoggedHand[]): string[] => hands.filter((h) => sel.includes(h.id)).map((h) => h.id);

/** Keep the level, table size and stack stage of a hand not saved yet, so the next new hand starts there too. */
export function rememberSetup(h: Pick<LoggedHand, "level" | "players"> & Partial<Pick<LoggedHand, "stack" | "quickPre">>): void {
  const s = handLogStore.get();
  const lastLevel = h.level ?? s.lastLevel;
  const memo = stageMemo(h, s);
  if (s.lastLevel !== lastLevel || s.lastPlayers !== h.players || memo.lastStage !== s.lastStage) handLogStore.set({ ...s, lastLevel, lastPlayers: h.players, ...memo });
}

/** The stage to remember after this hand: the one it tells (tapped, or from its stack), else the one before. */
function stageMemo(h: Pick<LoggedHand, "level"> & Partial<Pick<LoggedHand, "stack" | "quickPre" | "blinds">>, s: HandLogState): { lastStage?: PreStage } {
  const stage = knownStage(h.quickPre, stackBb({ stack: h.stack ?? null, level: h.level, ...(h.blinds ? { blinds: h.blinds } : {}) })) ?? lastStage(s);
  return stage ? { lastStage: stage } : {};
}

/**
 * A quick hand after an edit, its preflop block kept in step with the rest (see tidyPre): an unpinned
 * stage follows the stack, an opener must be another seat at this table, an empty block goes away.
 */
export function tidyQuick(h: LoggedHand, last: PreStage | null = lastStage()): LoggedHand {
  const { quickPre: was, ...rest } = h;
  const quickPre = tidyPre(was, { bb: stackBb(h), seats: positionsFor(h.players), seat: h.seat, last });
  if (quickPre ? JSON.stringify(quickPre) === JSON.stringify(was) : !("quickPre" in h)) return h;
  return quickPre ? { ...rest, quickPre } : rest;
}

/** The stack stage last used, if any (a stored value that isn't one is ignored). */
export function lastStage(s: HandLogState = handLogStore.get()): PreStage | null {
  return isStage(s.lastStage) ? s.lastStage : null;
}

// ───────────── resuming ─────────────

export type HandProgress = "setup" | "hand" | LogStreet | "done";

/** How far the recording got: the first missing piece, the street the action is on, or done. */
export function handProgress(h: LoggedHand): HandProgress {
  if (!h.seat) return "setup";
  if (h.hole.length < 2) return "hand";
  const { game } = replay(tableOf(h), h.steps);
  return game.done ? "done" : game.street;
}

export const PROGRESS_LABEL: Record<HandProgress, string> = { setup: "테이블", hand: "핸드", ...LOG_STREET_LABEL, done: "끝" };

/** A hand left mid-way this long ago is no longer offered for resuming. */
export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * The hand to offer "이어서 기록" for: the most recently edited hand of that kind (mine by default)
 * with something in it, if it has no result yet, its action isn't over, and it was touched within the
 * last 12 hours.
 */
export function resumable(hands: LoggedHand[], now: number, kind: HandKind = "mine"): LoggedHand | null {
  let last: LoggedHand | null = null;
  for (const h of hands) if (isOther(h) === (kind === "other") && hasContent(h) && !fastOnly(h) && (!last || h.updatedAt > last.updatedAt)) last = h;
  if (!last || now - last.updatedAt > RESUME_WINDOW_MS) return null;
  if (last.result !== null || last.net !== null) return null;
  return handProgress(last) === "done" ? null : last;
}

/** A hand left with "＋ 새 핸드" on purpose: not offered for resuming again this session. */
let asideId: string | null = null;
export function putAside(id: string): void {
  asideId = id;
}

/** The hand the new-hand screen offers to pick up again, if any (mine by default). */
export function resumeOffer(hands: LoggedHand[], now: number, kind: HandKind = "mine"): LoggedHand | null {
  const r = resumable(hands, now, kind);
  return r && r.id !== asideId ? r : null;
}

let persistAsked = false;
/** Ask the browser not to evict our storage under pressure (best effort, no prompt on most browsers). */
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* not supported */
  }
}

// ───────────── formatting ─────────────

/** The blinds of a level (Lv1-30, from levelClock's PUB_SCHEDULE), or null for no level or an unknown one. */
export function levelInfo(level: number | null): { sb: number; bb: number } | null {
  const row = level === null ? null : levelRow(level);
  return row ? { sb: row.sb, bb: row.bb } : null;
}

/** "Lv26 · 50,000/100,000", or "레벨 모름". */
export function levelLabel(level: number | null): string {
  const info = levelInfo(level);
  return info ? `Lv${level} · ${info.sb.toLocaleString()}/${info.bb.toLocaleString()}` : "레벨 모름";
}

/**
 * A hand's level: levelLabel, plus " (추정)" when it came from the start time; a 직접 입력 hand's blinds: "블라인드
 * 400/800 · 앤티 800 (직접 입력)"; a ready-made structure's level (its blinds with their number): "L2 · 100/200 · 앤티 200".
 */
export function handLevelLabel(h: Pick<LoggedHand, "level" | "levelGuess" | "blinds">): string {
  const b = h.level === null ? cleanBlinds(h.blinds) : null;
  const ante = (x: Blinds) => (x.ante ? `앤티 ${x.ante.toLocaleString()}` : "앤티 없음");
  if (b?.lv !== undefined) return `L${b.lv} · ${b.sb.toLocaleString()}/${b.bb.toLocaleString()} · ${ante(b)}`;
  if (b) return `블라인드 ${b.sb.toLocaleString()}/${b.bb.toLocaleString()} · ${ante(b)} (직접 입력)`;
  const label = levelLabel(h.level);
  return h.levelGuess && levelInfo(h.level) ? `${label} (추정)` : label;
}

/** A hand's level as the chip maths take it (fastChips handLv): its own 직접 입력 blinds, else its level. */
const lvOfHand = (h: Pick<LoggedHand, "level" | "blinds">): Lv => (h.level === null && h.blinds ? h.blinds : h.level);

/**
 * The hand with its level set: `guessed` when it came from the start-time estimate (levelEstimateAt).
 * Bets and other seats' stacks are kept in bb but were typed as chips at the old level, so going from
 * one known level to another rescales them: the chips stay what was typed (5,000 stays 5,000). From or
 * to 레벨 모름 they stay in bb, as they were typed then. All-ins are marked (LogStep.all) and follow the
 * seat's real stack anyway.
 */
export function withLevel(h: LoggedHand, level: number | null, guessed = false): LoggedHand {
  return withLv(h, level, guessed);
}

/**
 * withLevel for any Lv: a schedule level or none (the hand's own blinds dropped), or a 직접 입력 tournament's
 * blinds (`level` null, `blinds` set, never estimated). Bets typed as chips rescale from the old big blind to
 * the new one as withLevel does.
 */
export function withLv(h: LoggedHand, lv: Lv, guessed = false): LoggedHand {
  const { levelGuess: _was, blinds: _b, ...rest } = h;
  void _was;
  void _b;
  const from = blindsOf(lvOfHand(h))?.bb ?? null;
  const custom = lv !== null && typeof lv === "object" ? cleanBlinds(lv) : null;
  const to = blindsOf(custom ?? (typeof lv === "number" ? lv : null))?.bb ?? null;
  const kept = from !== null && to !== null && from !== to ? rescaleBb(rest, from / to) : rest;
  if (custom) return { ...kept, level: null, blinds: custom };
  const level = typeof lv === "number" ? lv : null;
  return { ...kept, level, ...(guessed && level !== null ? { levelGuess: true as const } : {}) };
}

/** Every bb amount typed as chips (bet totals, other seats' stacks) times `f`, rounded like the engine (6 decimals). */
function rescaleBb<T extends Pick<LoggedHand, "steps" | "stacks">>(h: T, f: number): T {
  const r = (x: number) => Math.round(x * f * 1e6) / 1e6;
  return {
    ...h,
    steps: h.steps.map((st) => (st.to !== undefined ? { ...st, to: r(st.to) } : st)),
    stacks: Object.fromEntries(Object.entries(h.stacks).map(([seat, v]) => [seat, r(v)])),
  };
}

/** How many of the hand's table steps still replay (the rest no longer fit the seats and stacks). */
export const stepsThatFit = (h: LoggedHand): number => replay(tableOf(h), h.steps).applied;

// ───────────── the day's start time ─────────────

const HOUR_MS = 60 * 60 * 1000;
/** A start time covers from 10 hours before it to 14 hours after: back to back, the days tile the clock. */
export const START_LEAD_MS = 10 * HOUR_MS;
export const START_SPAN_MS = 14 * HOUR_MS;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The local date "YYYY-MM-DD" of a moment. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A stored start time with valid fields only ("19:00" form), or undefined. */
export function cleanStartClock(x: unknown): StartClock | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Record<string, unknown>;
  const m = typeof r.day === "string" ? DAY_RE.exec(r.day) : null;
  const clock = typeof r.clock === "string" ? clockText(r.clock) : null;
  if (!m || !clock) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (localDay(d.getTime()) !== r.day) return undefined;
  return { day: r.day as string, clock };
}

/** Epoch ms of a stored start time (local), or null when it isn't valid. */
export function startMsOf(sc: StartClock | undefined): number | null {
  const c = cleanStartClock(sc);
  const t = c ? parseClock(c.clock) : null;
  if (!c || !t) return null;
  const [y, mo, d] = c.day.split("-").map(Number);
  return new Date(y, mo - 1, d, t.h, t.m).getTime();
}

/** The start covers this moment (see START_LEAD_MS). */
const covers = (start: number, at: number) => at >= start - START_LEAD_MS && at < start + START_SPAN_MS;

/**
 * The start time a clock typed at `now` means: the yesterday, today or tomorrow whose 24-hour window
 * (10 hours before, 14 after) holds `now`. So "19:00" set at 15:00 is today's, set at 01:30 it is the
 * night before's (the tournament runs past midnight), and "00:30" set at 23:30 is tomorrow's. Null for
 * a clock that can't be read.
 */
export function startClockFor(clock: string, now: number): StartClock | null {
  const text = clockText(clock);
  const t = parseClock(clock);
  if (!text || !t || !Number.isFinite(now)) return null;
  const d = new Date(now);
  const at = (delta: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta, t.h, t.m).getTime();
  const cands = [-1, 0, 1].map(at);
  // Daylight saving can leave a gap or an overlap of an hour: then the nearest start wins.
  const start = cands.find((c) => covers(c, now)) ?? cands.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
  return { day: localDay(start), clock: text };
}

/** Keep this many days of start times (a few months of pub nights). */
const MAX_START_DAYS = 120;

/** Stored start times, valid ones only, one per day (the later entry wins), oldest first. */
export function cleanStartClocks(x: unknown): StartClock[] {
  const byDay = new Map<string, StartClock>();
  for (const sc of Array.isArray(x) ? x : []) {
    const c = cleanStartClock(sc);
    if (c) byDay.set(c.day, c);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-MAX_START_DAYS);
}

/** Every day's start time on file: the per-day list and the one set last (it wins for its day). */
export function allStarts(s: Pick<HandLogState, "startClock" | "startClocks">): StartClock[] {
  const last = cleanStartClock(s.startClock);
  return cleanStartClocks([...(Array.isArray(s.startClocks) ? s.startClocks : []), ...(last ? [last] : [])]);
}

/**
 * The start time that covers the moment `at`, by its day: of the starts whose window holds it, the latest
 * one that began by then (a tournament running past midnight), else the earliest still to come. Null when
 * no day's start covers it.
 */
export function startFor(at: number, s: Pick<HandLogState, "startClock" | "startClocks"> = handLogStore.get()): StartClock | null {
  let best: { sc: StartClock; ms: number } | null = null;
  for (const sc of allStarts(s)) {
    const ms = startMsOf(sc);
    if (ms === null || !covers(ms, at)) continue;
    const better = !best || (ms <= at ? best.ms > at || ms > best.ms : best.ms > at && ms < best.ms);
    if (better) best = { sc, ms };
  }
  return best?.sc ?? null;
}

/** The tournament start clock ("19:00") that covers `now`, if one was set for that day; null otherwise. */
export function todayStart(now: number = Date.now(), s: Pick<HandLogState, "startClock" | "startClocks"> = handLogStore.get()): string | null {
  return startFor(now, s)?.clock ?? null;
}

/**
 * Sets the tournament start of the day that `at` (default now; the hand being edited, when filling in
 * last night's hands the next day) falls in, from what the user typed ("19:00", "7시", "1900"...). Other
 * days keep theirs. Null or "" clears the start covering `at`. Returns false when the clock can't be
 * read or storage refused the write.
 */
export function setTodayStart(clock: string | null, at: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const days = allStarts(prev);
  const coversAt = (sc: StartClock) => {
    const ms = startMsOf(sc);
    return ms !== null && covers(ms, at);
  };
  const { startClock: _old, startClocks: _list, ...rest } = prev;
  void _old;
  void _list;
  if (clock === null || clock.trim() === "") {
    const left = days.filter((sc) => !coversAt(sc));
    if (left.length === days.length) return true;
    const last = left[left.length - 1];
    return handLogStore.set({ ...rest, ...(last ? { startClock: last } : {}), ...(left.length ? { startClocks: left } : {}) });
  }
  const sc = startClockFor(clock, at);
  if (!sc) return false;
  // The new start replaces its own day's and any other day's that claimed this moment.
  const startClocks = cleanStartClocks([...days.filter((x) => x.day !== sc.day && !coversAt(x)), sc]);
  return handLogStore.set({ ...rest, startClock: sc, startClocks });
}

/** The level running at `atMs` by the start time of its day, or null when no start covers that moment. */
export function levelEstimateAt(atMs: number = Date.now(), s: Pick<HandLogState, "startClock" | "startClocks"> = handLogStore.get()): LevelEstimate | null {
  const sc = startFor(atMs, s);
  const start = startMsOf(sc ?? undefined);
  if (!sc || start === null) return null;
  return { ...levelAt(start, atMs), startClock: sc.clock };
}

/** The level to fill in from an estimate: the level running (in a break, the one just played); null before the start. */
export const estimatedLevel = (est: LevelEstimate | null): number | null => (est && est.phase !== "before" ? est.level : null);

/** The later of two start times (by day, then clock), for merging a backup. */
export function laterStart(a: StartClock | undefined, b: StartClock | undefined): StartClock | undefined {
  const ca = cleanStartClock(a);
  const cb = cleanStartClock(b);
  if (!ca || !cb) return ca ?? cb;
  return (startMsOf(cb) ?? 0) > (startMsOf(ca) ?? 0) ? cb : ca;
}

/** My stack in big blinds, if both the stack and the level are known. */
export function stackBb(h: Pick<LoggedHand, "stack" | "level"> & { blinds?: Blinds }): number | null {
  const info = blindsOf(lvOfHand(h));
  if (!info || h.stack === null || !(h.stack > 0)) return null;
  return Math.round((h.stack / info.bb) * 10) / 10;
}

export const cardsText = (cs: Card[]) => cs.map(cardLabel).join(" ");

/** The recorder's view of this hand's table. */
export function tableOf(h: LoggedHand): TableInput {
  return { heroSeat: h.seat, heroStack: stackBb(h), stacks: h.stacks, seats: positionsFor(h.players), bbAnte: h.bbAnte };
}

/** Board cards dealt on a street (flop 3, turn 1, river 1). */
export function streetBoard(board: Card[], street: string): Card[] {
  if (street === "flop") return board.slice(0, 3);
  if (street === "turn") return board.slice(3, 4);
  if (street === "river") return board.slice(4, 5);
  return [];
}

/** My all-in this hand as a preflop street total in bb (see shoveCap), if my stack is known. */
export const shoveBb = (h: LoggedHand): number | null => shoveCap(stackBb(h), h.seat, h.bbAnte);

/**
 * The hand's preflop is still what the quick block says: no table steps, or only the seats before me
 * (the folds the block filled in, when my own action didn't fit the table).
 */
function blockSays(h: LoggedHand): boolean {
  return !!h.quickPre && (!h.steps.length || !actedPreflop(replay(tableOf(h), h.steps).game, h.seat));
}

/**
 * The preflop as one line for the past hands ("CO 2.5bb 오픈 → 콜"), for a hand jotted with the quick
 * screen's preflop block: from the block, or once the table has my own preflop action, from the table.
 * The stage leads when the hand has no stack in bb to show ("숏 · CO 올인").
 */
export function quickPreLine(h: LoggedHand): string {
  if (!h.quickPre) return "";
  if (!blockSays(h)) {
    const s = summaryOfGame(replay(tableOf(h), h.steps).game, h.seat, shoveBb(h));
    return s ? summaryText(s) : "";
  }
  const s = summaryOf(h.quickPre, h.seat, shoveBb(h));
  const stage = stackBb(h) === null && h.quickPre.stage ? STAGE_LABEL[h.quickPre.stage] : "";
  return [stage, s ? summaryText(s) : ""].filter(Boolean).join(" · ");
}

export function holeText(cs: Card[]): string {
  if (cs.length === 2) return `${cardsText(cs)} (${handClassOf(cs[0], cs[1])})`;
  return cs.length ? cardsText(cs) : "모름";
}

/** The subject's hole cards as text: "A♦ T♦ (ATs)", or for guessed suits only what is known, "ATs (수트 추정)". */
export function handHoleText(h: Pick<LoggedHand, "hole" | "guess" | "holeKind">): string {
  return holeGuessed(h) ? holeLabel(h) : holeText(h.hole);
}

/** The board as remembered on 빠른 기록: suits typed as "K♥", guessed ones as the rank only: "K♥ 7 2". */
export function rememberedText(h: Pick<LoggedHand, "board" | "guess">): string {
  const g = h.guess?.board ?? [];
  return h.board.map((c, i) => (g.includes(i) ? RANKS[rankOf(c)] : cardLabel(c))).join(" ");
}

/** The board as text, with which streets' suits were guessed: "K♦ 9♦ 2♠ 6♣ (플랍 수트 추정)". */
export function boardText(h: Pick<LoggedHand, "board" | "guess">): string {
  const g = boardGuessText(h);
  return `${cardsText(h.board)}${g ? ` (${g})` : ""}`;
}

/** What the AI coach is asked to review for this hand (mine or another player's). */
export function coachPrompt(h: LoggedHand): { title: string; question: string } {
  const cards = holeGuessed(h) ? holeLabel(h) : h.hole.map(cardLabel).join("");
  if (isOther(h)) {
    return {
      title: `상대 핸드 리뷰 · ${h.seat || "자리 모름"} ${cards}`,
      question:
        "펍에서 다른 플레이어가 친 핸드를 본 거야. 이 플레이어가 이 자리·스택에서 이 핸드로 이렇게 플레이한 게 어떤 성향을 보여주는지, 프리플랍 레인지를 어떻게 추정할 수 있는지, 이런 상대를 만나면 내가 어떻게 조정하면 좋을지 알려줘.",
    };
  }
  return {
    title: `기록 리뷰 · ${h.seat || "자리 모름"} ${cards}`,
    question:
      "내가 펍에서 실제로 친 핸드야. 스트리트별로 내 결정이 괜찮았는지, 결과와 상관없이 결정 자체가 좋았는지, 아쉬운 결정이 있다면 뭐였는지, 이런 펍아재 상대로는 어떻게 조정하면 좋을지 알려줘.",
  };
}

/** Plain-text summary for the AI coach. */
export function handFacts(h: LoggedHand): string {
  const bb = stackBb(h);
  const info = levelInfo(h.level);
  const other = isOther(h);
  const lines = [
    `게임: 홀덤펍 토너먼트 · ${h.players}인 · ${h.bbAnte === false ? "앤티 없음" : "BB 앤티(BB가 BB 금액만큼 앤티)"} · 시작 50,000 · ${other ? "사용자가 테이블에서 본 다른 플레이어(상대)의 핸드를 기록한 것 (사용자 본인의 핸드가 아님)" : "사용자가 실제로 친 핸드를 기록한 것"}`,
    `레벨: ${levelLabel(h.level)}${h.levelGuess && info ? " (시작 시각으로 추정)" : ""}`,
    `${subjectWord(h, "자리")}: ${h.seat || "모름"} · ${subjectWord(h, "핸드")}: ${handHoleText(h)}`,
    `${subjectWord(h, "스택")}: ${h.stack !== null ? `${h.stack.toLocaleString()}칩` : "모름"}${bb !== null ? ` (${bb}bb)` : ""}`,
  ];
  if (other && h.mySeat) lines.push(`내 자리: ${h.mySeat} (같은 테이블에서 지켜봄)`);
  if (holeGuessed(h) || boardGuessText(h)) lines.push("참고: 수트를 추정한 카드가 있어 플러시 관련 승률은 근사값");
  // A board remembered on 빠른 기록: the guessed suits would read as facts, so only what was typed.
  if (h.board.length) lines.push(fastOnly(h) ? `보드 (빠른 기록 · 기억나는 카드만, 숫자만 적힌 건 수트 모름): ${rememberedText(h)}` : `보드: ${boardText(h)}`);
  const fv = blockSays(h) ? fastVerdictOf(h) : null;
  if (fv && h.quickPre) {
    const stage = h.quickPre.stage ? `${STAGE_LABEL[h.quickPre.stage]} 구간 · ` : "";
    lines.push(`프리플랍 (빠른 기록, ${other ? "상대 결정 하나" : "내 결정 하나"}): ${stage}${h.seat || "자리 모름"} ${fastActText(h)} · 차트 판정 ${fv.text}${fv.chart ? ` (${fv.chart})` : ""}`);
  } else if (h.quickPre && blockSays(h)) {
    const s = summaryOf(h.quickPre, h.seat, shoveBb(h));
    const stage = h.quickPre.stage ? `${STAGE_LABEL[h.quickPre.stage]} 구간` : "";
    lines.push(`프리플랍 (빠른 기록, 금액은 bb): ${[stage, s ? summaryText(s) : ""].filter(Boolean).join(" · ")}`);
  }
  if (h.steps.length) {
    const t = tableOf(h);
    const others = Object.entries(h.stacks).filter(([seat]) => seat !== h.seat);
    const both = (bb: number) => (info ? `${amountLabel(bb, info.bb)}(${Math.round(bb * 10) / 10}bb)` : amountLabel(bb, null));
    lines.push(
      `시작 스택: 다른 자리는 ${t.heroStack === null ? "모름(100bb로 가정)" : other ? "상대와 같음" : "나와 같음"}${others.length ? `, 예외 ${others.map(([seat, bb]) => `${seat} ${both(bb)}`).join(", ")}` : ""}`,
      "액션 기록 (금액은 그 스트리트에서 낸 총액, 언급 없는 자리는 폴드):",
    );
    const { game } = replay(t, h.steps);
    for (const l of streetLines(game, both, seatTags(h))) {
      const cards = streetBoard(h.board, l.street);
      lines.push(`- ${LOG_STREET_LABEL[l.street as LogStreet]}${cards.length ? ` [${cardsText(cards)}]` : ""}: ${l.actions.join(", ") || "액션 없음"} → 팟 ${both(l.pot)}`);
    }
  }
  for (const st of LOG_STREETS) if (h.actions[st].trim()) lines.push(`${LOG_STREET_LABEL[st]} 메모: ${h.actions[st].trim()}`);
  for (const sd of h.showdowns) {
    const who = myShowdown(h, sd) ? `나 ${sd.seat}` : [sd.name.trim() || (other ? "다른 플레이어" : "상대"), sd.seat].filter(Boolean).join(" ");
    lines.push(`쇼다운: ${who} ${sd.cards.length ? holeText(sd.cards) : "카드 모름"}${sd.did.trim() ? ` — ${sd.did.trim()}` : ""}`);
  }
  const result = [h.result ? RESULT_LABEL[h.result] : "", h.net !== null ? `${h.net > 0 ? "+" : ""}${h.net.toLocaleString()}칩${info && h.net ? ` (${h.net > 0 ? "+" : ""}${Math.round((h.net / info.bb) * 10) / 10}bb)` : ""}` : ""]
    .filter(Boolean)
    .join(" ");
  if (result) lines.push(`결과${other ? " (상대 기준)" : ""}: ${result}`);
  if (h.note.trim()) lines.push(`메모: ${h.note.trim()}`);
  return lines.join("\n");
}

// ───────────── opponents ─────────────

export interface VillainEntry {
  hand: LoggedHand;
  showdown: ShowdownNote;
}

/** A hand shown down at my own seat in another player's hand: my cards, never an opponent's. */
export const myShowdown = (h: Pick<LoggedHand, "kind" | "mySeat">, sd: Pick<ShowdownNote, "seat">): boolean => isOther(h) && !!h.mySeat && sd.seat === h.mySeat;

/** Showdowns grouped by opponent nickname, most-seen first. Unnamed ones go under "이름 없음". My own (myShowdown) are left out. */
export function villainBook(hands: LoggedHand[]): { name: string; entries: VillainEntry[] }[] {
  const byName = new Map<string, VillainEntry[]>();
  for (const hand of hands) {
    for (const showdown of hand.showdowns) {
      if (myShowdown(hand, showdown)) continue;
      const name = showdown.name.trim() || "이름 없음";
      byName.set(name, [...(byName.get(name) ?? []), { hand, showdown }]);
    }
  }
  return [...byName.entries()]
    .map(([name, entries]) => ({ name, entries }))
    .sort((a, b) => (a.name === "이름 없음" ? 1 : b.name === "이름 없음" ? -1 : b.entries.length - a.entries.length));
}

export function knownNames(hands: LoggedHand[]): string[] {
  return [...new Set(hands.flatMap((h) => h.showdowns.filter((s) => !myShowdown(h, s)).map((s) => s.name.trim())).filter(Boolean))].sort();
}

// ───────────── backup ─────────────

/**
 * File marker. Version 2 files carry fields an older app would silently drop on import (whose hand,
 * my seat, guessed suits, an estimated level, all-in marks), so they get a new marker the older app
 * refuses ("not a backup file") instead of turning others' hands into mine. Version 1 files, under the
 * app's old name (PubAZ), still import.
 */
export const EXPORT_KIND = "pubaj-hand-log";
const OLD_EXPORT_KIND = "pubaz-hand-log";

/**
 * The backup file: every hand (with kind, mySeat, guess, holeKind, levelGuess, fast, fastSpot, fastUnit,
 * fastStack, tourney, blinds), the start times and 빠른 기록's tournaments (with their 칩 업데이트, structure and
 * blinds). An older app reading it drops the tournaments, the hands' `tourney` (it loses only the grouping) and
 * `blinds` (a 직접 입력 hand then reads as 레벨 모름; a tournament as 야자수 새틀), so the file keeps its marker and version.
 * A ready-made structure's tournament (`preset`, WPL) is 직접 입력 at its `blinds` to an app from before presets,
 * and its hands 직접 입력 hands at theirs (only the level numbers are lost).
 */
export function exportData(hands: LoggedHand[], startClock?: StartClock, startClocks?: StartClock[], tourneys?: Tourney[]): string {
  const sc = cleanStartClock(startClock);
  const days = cleanStartClocks(startClocks);
  const ts = cleanTourneys(tourneys);
  return JSON.stringify(
    { kind: EXPORT_KIND, version: 2, exportedAt: new Date().toISOString(), ...(sc ? { startClock: sc } : {}), ...(days.length ? { startClocks: days } : {}), ...(ts.length ? { tourneys: ts } : {}), hands },
    null,
    1,
  );
}

const isCard = (x: unknown): x is Card => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 52;
const cardList = (x: unknown, max: number): Card[] => (Array.isArray(x) ? x.filter(isCard).slice(0, max) : []);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Coerce one stored or imported record into a LoggedHand, or null if it has no usable id. */
export function sanitize(x: unknown): LoggedHand | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const created = num(r.createdAt) ?? Date.now();
  const actions = (r.actions && typeof r.actions === "object" ? r.actions : {}) as Record<string, unknown>;
  const result = str(r.result);
  const players = num(r.players);
  const size = players !== null && POSITIONS[players] ? players : 9;
  const seats = new Set(positionsFor(size));
  const seat = str(r.seat);
  const level = num(r.level);
  const other = r.kind === "other";
  const mySeat = other && typeof r.mySeat === "string" && seats.has(r.mySeat) && r.mySeat !== seat ? r.mySeat : null;
  const guess = cleanGuess(r.guess);
  const hand: LoggedHand = {
    id,
    createdAt: created,
    updatedAt: num(r.updatedAt) ?? created,
    players: size,
    bbAnte: typeof r.bbAnte === "boolean" ? r.bbAnte : true,
    level,
    seat,
    hole: cardList(r.hole, 2),
    stack: num(r.stack),
    note: str(r.note),
    result: result in RESULT_LABEL ? (result as Result) : null,
    net: num(r.net),
    board: cardList(r.board, 5),
    steps: (Array.isArray(r.steps) ? r.steps : []).flatMap((x): LogStep[] => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const k = str(o.k) as StepKind;
      if (!seats.has(str(o.s)) || !["fold", "check", "call", "raise"].includes(k)) return [];
      const to = num(o.to);
      return [{ s: str(o.s), k, ...(to !== null ? { to } : {}), ...(o.a ? { a: 1 as const } : {}), ...(o.all && k === "raise" ? { all: 1 as const } : {}) }];
    }),
    stacks: Object.fromEntries(
      Object.entries(r.stacks && typeof r.stacks === "object" ? (r.stacks as Record<string, unknown>) : {}).filter(
        ([seat, v]) => seats.has(seat) && typeof v === "number" && v > 0,
      ),
    ) as Record<string, number>,
    actions: { preflop: str(actions.preflop), flop: str(actions.flop), turn: str(actions.turn), river: str(actions.river) },
    showdowns: (Array.isArray(r.showdowns) ? r.showdowns : []).map((s) => {
      const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      return { name: str(o.name), seat: str(o.seat), cards: cardList(o.cards, 2), did: str(o.did) };
    }),
    ...(r.quick === true ? { quick: true } : {}),
    ...withPre(cleanPre(r.quickPre, positionsFor(size))),
    ...(other ? { kind: "other" as const } : {}),
    ...(mySeat ? { mySeat } : {}),
    ...(guess ? { guess } : {}),
    ...(isHoleKind(r.holeKind) ? { holeKind: r.holeKind } : {}),
    ...(r.levelGuess === true && level !== null ? { levelGuess: true as const } : {}),
    ...(r.fast === true
      ? {
          fast: true as const,
          ...(isFastSpot(r.fastSpot) ? { fastSpot: r.fastSpot } : {}),
          ...(r.fastUnit === "bb" ? { fastUnit: "bb" as const } : {}),
          ...(r.fastStack === true ? { fastStack: true as const } : {}),
        }
      : {}),
    ...(isTourneyId(r.tourney) ? { tourney: r.tourney } : {}),
    ...(level === null && cleanBlinds(r.blinds) ? { blinds: cleanBlinds(r.blinds) as Blinds } : {}),
  };
  return tidyHand(hand);
}

const withPre = (quickPre: QuickPre | undefined) => (quickPre ? { quickPre } : {});

/**
 * Merge an exported file into the current hands. A hand already here is replaced only if the file's
 * copy was edited more recently. `startClock` is the later of `currentStart` and the file's start time
 * (old files have none); `startClocks` every day's start from both (ours wins for a day both have).
 * `tourneys`: 빠른 기록's tournaments from both, one per id (the later edited wins; a tie: ours).
 * The old 정보 수집 data file (exportLegacyScout) is read too: its showdowns become other-hands, and
 * only ones not here yet are added. Throws with a readable message.
 */
export function mergeImport(
  text: string,
  current: LoggedHand[],
  currentStart?: StartClock,
  currentStarts?: StartClock[],
  currentTourneys?: Tourney[],
): { hands: LoggedHand[]; added: number; updated: number; startClock: StartClock | undefined; startClocks: StartClock[]; tourneys: Tourney[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("백업 파일을 읽을 수 없어요. PubAJ에서 내보낸 파일인지 확인해 주세요.");
  }
  const d = data as { kind?: unknown; hands?: unknown; startClock?: unknown; startClocks?: unknown; sessions?: unknown; tourneys?: unknown };
  const ours = cleanStartClocks(currentStarts);
  const byId = new Map(current.map((h) => [h.id, h]));
  let added = 0, updated = 0;
  if (d && d.kind === undefined && Array.isArray(d.sessions)) {
    // The old 정보 수집 file: add the showdowns not in the log yet (one already here is never overwritten).
    for (const h of scoutToHands(sanitizeState(d))) {
      if (byId.has(h.id)) continue;
      byId.set(h.id, tidyHand(h));
      added++;
    }
    const hands = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
    return { hands, added, updated, startClock: cleanStartClock(currentStart), startClocks: ours, tourneys: cleanTourneys(currentTourneys) };
  }
  if (!d || (d.kind !== EXPORT_KIND && d.kind !== OLD_EXPORT_KIND) || !Array.isArray(d.hands)) throw new Error("PubAJ 핸드 기록 백업 파일이 아니에요.");
  for (const raw of d.hands) {
    const h = sanitize(raw);
    if (!h) continue;
    const mine = byId.get(h.id);
    if (!mine) added++;
    else if (h.updatedAt > mine.updatedAt) updated++;
    else continue;
    byId.set(h.id, h);
  }
  const hands = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  const theirs = cleanStartClocks([...(Array.isArray(d.startClocks) ? d.startClocks : []), ...(cleanStartClock(d.startClock) ? [d.startClock] : [])]);
  const startClocks = cleanStartClocks([...theirs, ...ours]);
  return { hands, added, updated, startClock: laterStart(currentStart, cleanStartClock(d.startClock)), startClocks, tourneys: mergeTourneys(currentTourneys, d.tourneys) };
}

/** The backup file of the log as stored (지난 기록's 내보내기): every hand, the start times and 빠른 기록's tournaments. */
export function backupText(s: HandLogState): string {
  return exportData(s.hands, s.startClock, s.startClocks, s.tourneys);
}

/**
 * The log with a backup file merged in (지난 기록's 불러오기, mergeImport): its hands, start times and
 * tournaments, the rest of the store as it was; with the counts. Throws as mergeImport does.
 */
export function withBackup(prev: HandLogState, text: string): { next: HandLogState; added: number; updated: number } {
  const { hands, added, updated, startClock, startClocks, tourneys } = mergeImport(text, prev.hands, prev.startClock, prev.startClocks, prev.tourneys);
  const next: HandLogState = { ...prev, hands, ...(startClock ? { startClock } : {}), ...(startClocks.length ? { startClocks } : {}), ...(tourneys.length ? { tourneys } : {}) };
  return { next, added, updated };
}

// ───────────── migrations ─────────────

/**
 * A quick-record hand moved onto the table record (the quick screen is going away): with its preflop
 * block and no table steps, the block becomes the first steps (preSteps, as the old "테이블로" did).
 * The quick flag goes once the hand holds something worth keeping without it (cards, a note, steps…),
 * so a hand left with only its seat, stack or result keeps the flag and stays kept (worthKeeping).
 * `quickPre` stays on the hand. Idempotent; never touches cards or notes.
 */
export function migrateQuick(h: LoggedHand): LoggedHand {
  if (h.quick !== true) return h;
  let next = h;
  if (h.quickPre && h.steps.length === 0) {
    const steps = preSteps(tableOf(h), h.quickPre);
    if (steps.length) next = { ...next, steps };
  }
  if (!hasContent(next)) return next;
  const { quick: _q, ...rest } = next;
  void _q;
  return rest;
}

/** A short signature of a text (its length and a 32-bit FNV-1a hash), to tell whether it changed. */
export function textSig(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/** A stored ScoutImport with valid fields, or undefined. */
function cleanScoutImport(x: unknown): ScoutImport | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Record<string, unknown>;
  if (typeof r.sig !== "string") return undefined;
  const ids = Array.isArray(r.ids) ? [...new Set(r.ids.filter((i): i is string => typeof i === "string" && i !== ""))] : [];
  return { at: num(r.at) ?? 0, sig: r.sig, ids };
}

/**
 * Copies the old 정보 수집 records (`scoutRaw`, the text stored under "mygto.scout", read with the scout
 * module's own sanitize) into other-hands (legacyScout.ts): one per player who showed cards, id
 * "scout-<handId>-<seat>". The hand log notes the text's signature and every id made, so the same
 * text again does nothing, and a changed text only adds hands never made before (a hand the user
 * deleted is not brought back; one already in the log is never overwritten). Null when nothing changes.
 * "mygto.scout" itself is never written.
 */
export function importScout(s: HandLogState, scoutRaw: string | null, now: number = Date.now()): HandLogState | null {
  if (!scoutRaw) return null;
  const sig = textSig(scoutRaw);
  const was = cleanScoutImport(s.scoutImport);
  if (was?.sig === sig) return null;
  let made: LoggedHand[] = [];
  try {
    made = scoutToHands(sanitizeState(JSON.parse(scoutRaw)));
  } catch {
    // Unreadable text: noted all the same, so it isn't parsed again on every start.
  }
  const done = new Set(was?.ids ?? []);
  const have = new Set(s.hands.map((h) => h.id));
  const add = made.filter((h) => !done.has(h.id) && !have.has(h.id));
  const ids = [...new Set([...done, ...made.map((h) => h.id)])];
  const hands = add.length ? [...s.hands, ...add].sort((a, b) => b.createdAt - a.createdAt) : s.hands;
  return { ...s, hands, scoutImport: { at: now, sig, ids } };
}

/** How many hands the scout copy has made so far (0 before it ran). */
export const scoutImported = (s: HandLogState = handLogStore.get()): number => cleanScoutImport(s.scoutImport)?.ids.length ?? 0;

/** The text stored under "mygto.scout", or null (no storage, nothing stored). Read only. */
function readScoutRaw(): string | null {
  try {
    return localStorage.getItem(SCOUT_KEY);
  } catch {
    return null;
  }
}

/** The old 정보 수집 data exactly as stored, for a download button (백업 › 불러오기 reads it back, mergeImport); null if there is none. */
export function exportLegacyScout(): string | null {
  return readScoutRaw();
}

/** A stored hand that an earlier version saved without newer fields, or with fields that aren't valid. */
function needsSanitize(x: unknown): boolean {
  if (!x || typeof x !== "object") return true;
  const h = x as LoggedHand;
  if (!Array.isArray(h.steps) || !h.stacks || !h.actions || typeof h.players !== "number" || !Array.isArray(h.hole) || !Array.isArray(h.board) || !Array.isArray(h.showdowns)) return true;
  if (h.quickPre !== undefined && JSON.stringify(cleanPre(h.quickPre, positionsFor(h.players))) !== JSON.stringify(h.quickPre)) return true;
  if ("kind" in h && h.kind !== "other") return true;
  if ("mySeat" in h && (h.kind !== "other" || typeof h.mySeat !== "string" || h.mySeat === h.seat || !positionsFor(h.players).includes(h.mySeat))) return true;
  if ("levelGuess" in h && (h.levelGuess !== true || h.level === null)) return true;
  if (badFastMarks(h)) return true;
  if (("guess" in h || "holeKind" in h) && (tidyGuess(h) !== h || ("holeKind" in h && !isHoleKind(h.holeKind)))) return true;
  if ("tourney" in h && !isTourneyId(h.tourney)) return true;
  if ("blinds" in h && (h.level !== null || !cleanBlinds(h.blinds))) return true;
  return false;
}

/**
 * Everything the stored hand log needs on load, in order: hands from older versions sanitized, quick
 * hands moved onto the table record (migrateQuick), a malformed start time or tournament dropped, and the scout
 * records copied (importScout). Pure; null when nothing changes. Running it again changes nothing.
 */
export function migrateStore(s: HandLogState, scoutRaw: string | null, now: number = Date.now()): HandLogState | null {
  const loaded = Array.isArray(s.hands) ? s.hands : [];
  let hands = loaded;
  if (!Array.isArray(s.hands) || hands.some(needsSanitize)) hands = hands.map((h) => sanitize(h)).filter((h): h is LoggedHand => h !== null);
  const moved = hands.map(migrateQuick);
  if (moved.some((h, i) => h !== hands[i])) hands = moved;
  let next: HandLogState = hands === s.hands ? s : { ...s, hands };
  if ("startClock" in s) {
    const sc = cleanStartClock(s.startClock);
    if (JSON.stringify(sc) !== JSON.stringify(s.startClock)) {
      const { startClock: _bad, ...rest } = next;
      void _bad;
      next = sc ? { ...rest, startClock: sc } : rest;
    }
  }
  if ("startClocks" in s) {
    const days = cleanStartClocks(s.startClocks);
    if (JSON.stringify(days) !== JSON.stringify(s.startClocks)) {
      const { startClocks: _bad, ...rest } = next;
      void _bad;
      next = days.length ? { ...rest, startClocks: days } : rest;
    }
  }
  if ("tourneys" in s) {
    const ts = cleanTourneys(s.tourneys);
    if (JSON.stringify(ts) !== JSON.stringify(s.tourneys)) {
      const { tourneys: _bad, ...rest } = next;
      void _bad;
      next = ts.length ? { ...rest, tourneys: ts } : rest;
    }
  }
  next = importScout(next, scoutRaw, now) ?? next;
  return next === s ? null : next;
}

// Hands saved by an earlier version: fill in newer fields, move quick hands, copy the scout records. Once, on load.
{
  const next = migrateStore(handLogStore.get(), readScoutRaw());
  if (next) handLogStore.set(next);
}
