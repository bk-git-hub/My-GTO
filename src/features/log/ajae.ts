import type { HandClass } from "../../poker/cards";
import { preflopDecision } from "../../play/policy";
import { classDone, draftClass, type FastDraft } from "./fastLog";
import { spotOf, type FastSpot } from "./fastVerdict";
import type { PreStage } from "./quickPre";
import { buttonSeat, positionsFor } from "./recorder";

/**
 * 빠른 기록's 아재: the moment my two cards are in, the little 아재 by the hand reacts to how good they
 * are from my seat. The grade comes from the pub chart at the screen's stage, first in (everyone folded
 * to me), asked the same way 빠른 기록's verdict asks it (spotOf → preflopDecision), so every table size
 * and stage the screen offers works and the two never disagree. Everything here is pure; the face and
 * its moves are AjaeReaction.tsx.
 */

/**
 * monster: AA KK QQ AK. good: my seat opens it. meh: a seat or two later opens it (the BB: the button
 * opens it). fold: a fold here, but not a bad hand (자리 탓). trash: even the BB facing the button's open
 * throws it away, and no seat plays it first in: bad from every seat, so he kicks it. hammer: 72o.
 */
export type AjaeTier = "monster" | "good" | "meh" | "fold" | "trash" | "hammer";

const MONSTERS = new Set<HandClass>(["AA", "KK", "QQ", "AKs", "AKo"]);
const BLINDS = new Set(["SB", "BB"]);

/** What he says, rotating per tier; "kick" is the trash hand's (he kicks it instead of making a face). */
export const AJAE_LINES = {
  monster: ["캬~ 이거지", "왔다 왔어!", "오늘 밤은 내 거"],
  good: ["좋지~", "가자!", "오픈 각"],
  meh: ["흠…", "글쎄다…", "자리가 좀…"],
  fold: ["자리가 아쉽네", "뒤였으면 열었지", "패스~"],
  kick: ["에잉!", "저리 가!", "이걸 왜 줘", "퉤!"],
  hammer: ["해머네 ㅋ 건배", "이건 술안주"],
} as const satisfies Record<string, readonly string[]>;
export type AjaeLineSet = keyof typeof AJAE_LINES;

/** A few hands get their own line, whatever the rotation says. */
export const AJAE_SPECIAL: Partial<Record<HandClass, string>> = { AA: "주머니 로켓!", KK: "킹 두 장!" };

/** The line set for a tier: the trash hand gets the kick's. */
export const lineSet = (t: AjaeTier): AjaeLineSet => (t === "trash" ? "kick" : t);

/**
 * How often the chart puts chips in with `cls` in the spot, 0~1: every non-fold move counts (an open, a
 * 2bb open, a shove, a call, a 3-bet). 0 when the chart has nothing for the spot.
 */
function playShare(stage: PreStage, players: number, seat: string, cls: HandClass, spot: Extract<FastSpot, "none" | "open">, opener?: string): number {
  const sp = spotOf({ stage, players, seat, cls, spot, ...(opener ? { opener } : {}) });
  if (!sp) return 0;
  try {
    const dec = preflopDecision(sp);
    // Only a real chart: the policy's tight fallbacks for uncharted spots say nothing about the hand.
    if (!dec.scenario) return 0;
    return dec.moves(cls).reduce((a, m) => a + (m.kind === "fold" ? 0 : m.prob), 0);
  } catch {
    return 0;
  }
}

/**
 * The chart plays the hand: most of the time, the line 빠른 기록's verdict draws for 차트대로. The pub
 * charts are all-or-nothing today, so this only matters for a chart that mixes.
 */
const PLAYS = 0.5 - 1e-9;

/** The seats whose open makes my fold only "meh": the next two non-blind seats after me (the SB's is the button). */
export function laterSeats(players: number, seat: string): string[] {
  const seats = positionsFor(players);
  if (seat === "SB") return seats.includes("BTN") ? ["BTN"] : [];
  const i = seats.indexOf(seat);
  if (i < 0) return [];
  return seats.slice(i + 1).filter((s) => !BLINDS.has(s)).slice(0, 2);
}

/**
 * The stage whose BB defense decides what is trash, whatever stage is on screen. Short-stacked, the BB folds
 * 76s, T9o or Q9o to an open because of the stack, not because the hand is junk, so a 숏 chart would kick two
 * thirds of all hands; the middle stage's defense keeps the kick for the same ~40 offsuit hands everywhere.
 */
const TRASH_STAGE: PreStage = "mid";

/**
 * The tier of `cls` for my seat, first in at the stage. The trash test needs both halves: the BB folds
 * it facing the button's open at the middle stage (where the BB defends widest), and no seat at the table
 * plays it first in at the stage on screen (at the short and push stages the button and the SB shove hands
 * the BB can't call with, and a hand someone shoves is no hand to kick). The BB is graded by its own
 * defense against the button: a fold there is a fold, else good where the button opens the hand too.
 */
export function ajaeTier(cls: HandClass, seat: string, stage: PreStage, players: number): AjaeTier {
  if (cls === "72o") return "hammer";
  if (MONSTERS.has(cls)) return "monster";
  const seats = positionsFor(players);
  const btn = buttonSeat(players);
  const opens = (s: string) => playShare(stage, players, s, cls, "none");
  const bbDefendsAt = (st: PreStage) => (seats.includes("BB") ? playShare(st, players, "BB", cls, "open", btn) : 0);
  const bbDefends = bbDefendsAt(stage);
  if (bbDefendsAt(TRASH_STAGE) <= 1e-9 && seats.every((s) => s === "BB" || opens(s) <= 1e-9)) return "trash";
  if (seat === "BB") return bbDefends < PLAYS ? "fold" : opens(btn) >= PLAYS ? "good" : "meh";
  if (opens(seat) >= PLAYS) return "good";
  // The button's "later" is the BB's defense against it.
  const later = seat === btn && seat !== "SB" ? bbDefends >= PLAYS : laterSeats(players, seat).some((s) => opens(s) >= PLAYS);
  // A fold here, but a hand someone opens or defends: the seat's fault, not the hand's.
  return later ? "meh" : "fold";
}

// ───────────── when he reacts ─────────────

/** One reaction: the class it is for (with the hand being corrected, if any), its tier then, and its line. */
export interface AjaeCue {
  /** Counts up with every reaction: a new one restarts the moves. */
  n: number;
  /** The draft it reacts to (ajaeKey): it shows only while that is still on screen. */
  key: string;
  cls: HandClass;
  /** The tier when the cards went in: a different one now (my seat changed) shows at rest, without moving. */
  tier: AjaeTier;
  line: string;
  /** Set once the tier on screen differed from `tier` (ajaeSeen): he never moves again for this reaction, even if it changes back. */
  settled?: true;
}

export interface AjaeState {
  cue: AjaeCue | null;
  /** Reactions so far: the next cue's n. */
  n: number;
  /** Lines said so far per set, so each reaction says the next one. */
  said: Partial<Record<AjaeLineSet, number>>;
}

export const AJAE_START: AjaeState = { cue: null, n: 0, said: {} };

/** The complete class on screen with the hand it belongs to ("" while the class isn't complete). */
export const ajaeKey = (d: Pick<FastDraft, "ranks" | "suited" | "editing">): string => (classDone(d) ? `${draftClass(d)}|${d.editing ?? ""}` : "");

/**
 * The 아재 after one input on the hand (`before` → `after`), at the stage and table size the hand is entered
 * at. A class completed by this tap (the pair's second rank, 수딧 / 오프수트, or switching between them)
 * reacts; a class no longer complete takes him away at once; anything else (my seat, the spot) keeps the
 * reaction on screen. Pure: it is a state updater.
 */
export function ajaeStep(s: AjaeState, before: FastDraft, after: FastDraft, stage: PreStage, players: number): AjaeState {
  const key = ajaeKey(after);
  if (!key) return s.cue ? { ...s, cue: null } : s;
  if (key === ajaeKey(before)) return s.cue && s.cue.key === key ? s : { ...s, cue: null };
  const cls = draftClass(after);
  const tier = ajaeTier(cls, after.seat, stage, players);
  const set = lineSet(tier);
  const k = s.said[set] ?? 0;
  const lines = AJAE_LINES[set];
  const line = (tier !== "trash" ? AJAE_SPECIAL[cls] : undefined) ?? lines[k % lines.length];
  return { cue: { n: s.n + 1, key, cls, tier, line }, n: s.n + 1, said: { ...s.said, [set]: k + 1 } };
}

/** He goes, without a reaction (the reaction counts and lines carry on). */
export const ajaeQuiet = (s: AjaeState): AjaeState => (s.cue ? { ...s, cue: null } : s);

/**
 * What is left of the reaction with `d` on screen, at the stage and table size shown. FastView runs it on
 * every render, so this one rule covers every way the hand on screen changes without a tap of mine (saved,
 * opened to correct, put back by 취소, given back when the corrected hand is deleted, restored on load):
 * - the hand on screen is not the one he reacted to: the reaction is gone for good, so the same class put
 *   back later never replays it;
 * - my seat, the stage or the table size gives the class another tier: the reaction is settled for good,
 *   the face shows the tier on screen at rest, and going back to the first seat doesn't replay it.
 * The same state otherwise.
 */
export function ajaeSeen(s: AjaeState, d: Pick<FastDraft, "seat" | "ranks" | "suited" | "editing">, stage: PreStage, players: number): AjaeState {
  const cue = s.cue;
  if (!cue) return s;
  if (cue.key !== ajaeKey(d)) return ajaeQuiet(s);
  if (cue.settled || ajaeTier(cue.cls, d.seat, stage, players) === cue.tier) return s;
  return { ...s, cue: { ...cue, settled: true } };
}
