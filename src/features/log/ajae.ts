import { RANKS, type HandClass } from "../../poker/cards";
import { classDone, draftClass, type FastDraft } from "./fastLog";
import { bbPlayShare, limpShare, raiseShare, TRASH_DEFENSE, trashDefenseShare } from "./judgeChart";
import type { PreStage } from "./quickPre";
import { buttonSeat, positionsFor } from "./recorder";

/**
 * 빠른 기록's 아재: the moment my two cards are in, the little 아재 by the hand reacts to how good they
 * are from my seat. The grade comes from the judge chart of the screen's stage (judgeChart.ts: our solver at 딥 and
 * 미들, our computed short-stack charts at 숏 and 푸시), first in (everyone folded to me), at every table size the
 * screen offers. 빠른 기록's verdict reads the same charts per stage (computedChart.ts PICK_FOR_STAGE), so the two
 * agree. Each tier has its moves, taken in turn
 * (AJAE_MOVES), so hands of the same tier in a row get a different show; the big pocket pairs have shows of their
 * own (AJAE_SPECIALS: AA flies a plane, KK is a gorilla or gets crowned, QQ waltzes, JJ splits into two jacks), and so
 * do five hands with a story (AJAE_HAND_SHOWS: T2's cowboy hat, TT's 장땡, 38's 광땡, A8's dead man's hand, 96 swapped to 69
 * and a blush).
 * He never says a word. Everything here is pure; the art (the bald, mustached 아재 of the launch splash and the app
 * icon) and the moves are AjaeReaction.tsx and ajae.css.
 */

/**
 * monster: AA KK QQ AK. good: my seat opens it. meh: a seat or two later opens it (the BB: the button
 * opens it). fold: a fold here, but not a bad hand (자리 탓). meh and fold are the seat's call, so he ponders
 * them. trash: even the 55bb BB facing the HJ's open throws it away, and no seat opens it first in: bad from
 * every seat, so he rips it up or kicks it. hammer: 72o, the worst hand there is: he loses it completely, every time.
 */
export type AjaeTier = "monster" | "good" | "meh" | "fold" | "trash" | "hammer";

const MONSTERS = new Set<HandClass>(["AA", "KK", "QQ", "AKs", "AKo"]);
const BLINDS = new Set(["SB", "BB"]);

/**
 * What he does, by tier, in turn: each reaction of a tier takes the next one (a trash hand right after
 * another gets the next of rage → kick → mallet → slam, whatever came between). The first move of each tier is
 * its main one. Face moves (ponder, hmm, glare) are the chest-up face popping up big; body moves
 * (BODY_MOVES) are the whole 아재 performing beside the class, after which the face stays in its slot.
 * - monster: the all-in shove (two chip stacks pushed into the hand): AK's, as AA, KK and QQ have shows of their own
 *   (AJAE_SPECIALS, as JJ has);
 * - good: a shuffle under a mirror ball, every other time the robot;
 * - meh and fold (the seat's call): first he ponders it (the hand on his chin, eyes up, a thought cloud);
 *   every other time meh gets "흠" (the shades down the nose, a ?) and fold a glare at the seat row. meh
 *   rests on the "흠" face, fold on the pondering one;
 * - trash: first the rage (72o's, with the hand's own two cards: ajaeCards), then he kicks the hand, smashes it with a
 *   mallet or slams its cards to the floor; he stays furious after each;
 * - hammer (72o): the rage, every time. Bigger and longer than the other trash moves: he double-takes, boils over
 *   with steam shooting out of his ears, rips both cards (the 7 of clubs and the 2 of diamonds) in half and stomps the
 *   pieces, then stays as furious as trash.
 */
export const AJAE_MOVES = {
  monster: ["shove"],
  good: ["shuffle", "robot"],
  meh: ["ponder", "hmm"],
  fold: ["ponder", "glare"],
  trash: ["rage", "kick", "mallet", "slam"],
  hammer: ["rage"],
} as const satisfies Record<AjaeTier, readonly string[]>;

/**
 * The face's stand-ins for the body moves when there is no room above the hand row for the whole 아재 (AJAE_ROOM):
 * the trash moves and 72o's rage both boil over in the face (fume); AA, KK and QQ's shows cheer, as AK's shove does
 * (ajaePairMove); a hand with a story whose show doesn't fit does what its tier's hands do (ajaeShowMove). meh and
 * fold have only face moves, which always fit, so theirs never play.
 */
export const AJAE_CRAMPED = { monster: "cheer", good: "nod", meh: "ponder", fold: "ponder", trash: "fume", hammer: "fume" } as const satisfies Record<AjaeTier, string>;

/**
 * The pocket pairs' own shows, played instead of the tier's move (a pair's list in turn, like a tier's: KK alternates).
 * Each is flashier than the good hands' mirror-ball shuffle, AA the most, then KK, QQ, JJ:
 * - AA, the plane: he flies in in a little propeller plane, loops the loop (its smoke ring stays in the sky), makes a
 *   low pass over the hand trailing a contrail across the screen, comes back and lands beside it, under fireworks and
 *   two crossing searchlights;
 * - KK, the gorilla: in a gorilla costume he leaps in and pounds his chest (shockwave rings, leaves shaken down), roars,
 *   then lifts the costume's head off: it's him inside (a flash, confetti);
 * - KK, every other time, the crown: under rays of light a crown floats down onto his bald head as he kneels; it lands
 *   with a gleam, he rises in a royal cape, fanfare trumpets blow, gold confetti falls and he raises a scepter;
 * - QQ, the ladies: in a bow tie he waltzes with two queen cards (drawn, dancing), twirls them, hearts float up, and he
 *   ends with a gentleman's bow;
 * - JJ, the jacks: as on the launch splash, he dives into a jack card (its court picture is him), a second, identical
 *   jack slides out of it and the two snap apart sideways (gold snap marks, a sheen, flying pips).
 * The resting face after one is the hand's tier's, as after any body move (JJ's tier depends on the seat).
 */
export const AJAE_SPECIALS = {
  AA: ["plane"],
  KK: ["gorilla", "crown"],
  QQ: ["waltz"],
  JJ: ["split"],
} as const satisfies Partial<Record<HandClass, readonly string[]>>;

/** The pocket pairs with a show of their own. */
export type AjaePair = keyof typeof AJAE_SPECIALS;
export type AjaeSpecial = (typeof AJAE_SPECIALS)[AjaePair][number];

/**
 * Five hands with a story get a show of their own too, every time, at every seat, instead of the tier's move (the
 * offsuit and the suited hand alike). Two are 섯다's best hands (no more of 섯다's 족보 than these), the rest poker lore;
 * each about as lively as the good hands' mirror-ball shuffle, on its 2.5 s clock, and it reads in its first second:
 * - T2, the cowboy: an homage to the poker legend who won it all twice with ten-deuce (no likeness of anyone: his hat
 *   only). A cowboy hat comes spinning down out of a sunset glow onto his bald head (a gold star, dust), he tips it,
 *   twirls a lasso and ropes the hand (it is yanked), hops with a yee-haw and the hat pops up off his head and back;
 * - TT, 장땡: the hand's two tens rise out of it and flip into 화투's two 10월 cards (the deer under red maples, the
 *   maples with their blue ribbon); he slaps them down 섯다-style (a burst, the hand jumps) and maple leaves rain down;
 * - 38, 광땡: he squeezes two face-down 화투 cards (섯다's 쪼기), his shades fly up, and he flips them: 3월's cherry
 *   blossom 광 and 8월's moon 광 float up glowing (each 광 emblem drawn as a glowing sun, no character on it) under
 *   turning rays of light, cherry petals drifting, two fireworks;
 * - A8, the dead man's hand: he holds two black cards, an ace and an eight, and a cold wind blows a tumbleweed across;
 *   a cartoon skull in a little cowboy hat rises out of the hand clacking its jaw, he jumps, drops the cards and
 *   shivers (pale, his teeth chattering, sweat flying, shiver lines) until it sinks away (spooky, nothing gory);
 * - 96, the shy one: the hand's two cards rise out of it, the 9 and the 6, and with a wave of his hand they swap places
 *   (two curved arrows) to read 6 9; he looks again, blushes deep red from his chin to the top of his bald head, steam
 *   puffing off it, hides his face in his hands and twists bashfully, peeks once through his fingers and hides again,
 *   little hearts floating up (tasteful: shy, nothing more).
 * The resting face after one is the show's own, not the hand's tier's (AJAE_SHOW_REST): a gag never ends on the
 * furious trash face.
 */
export const AJAE_HAND_SHOWS = {
  T2o: "cowboy",
  T2s: "cowboy",
  TT: "jangttaeng",
  "83o": "gwangttaeng",
  "83s": "gwangttaeng",
  A8o: "deadman",
  A8s: "deadman",
  "96o": "blush",
  "96s": "blush",
} as const satisfies Partial<Record<HandClass, string>>;

/** The hands with a story (AJAE_HAND_SHOWS) and their shows. */
export type AjaeShowHand = keyof typeof AJAE_HAND_SHOWS;
export type AjaeHandShow = (typeof AJAE_HAND_SHOWS)[AjaeShowHand];

export type AjaeMove = (typeof AJAE_MOVES)[AjaeTier][number] | (typeof AJAE_CRAMPED)[AjaeTier] | AjaeSpecial | AjaeHandShow;

/** The pairs' shows (AJAE_SPECIALS). */
export const SPECIAL_MOVES: ReadonlySet<AjaeMove> = new Set<AjaeMove>(Object.values(AJAE_SPECIALS).flat());

/** The shows of the hands with a story (AJAE_HAND_SHOWS). */
export const HAND_SHOW_MOVES: ReadonlySet<AjaeMove> = new Set<AjaeMove>(Object.values(AJAE_HAND_SHOWS));

/**
 * The face he rests on after a hand with a story's show, whatever the hand's tier (T2, 38 and 96 are trash at most
 * seats): pleased after the cowboy, 장땡 and 광땡; the fold face, shades up and pondering, after the dead man's hand;
 * the "흠" face after 96's blush. Also once the reaction is at rest for good (cue.settled), as long as the show was
 * what he played: a show that didn't fit, replaced by the tier's move, rests on the tier's face like that move.
 */
export const AJAE_SHOW_REST = {
  cowboy: "good",
  jangttaeng: "good",
  gwangttaeng: "good",
  deadman: "fold",
  blush: "meh",
} as const satisfies Record<AjaeHandShow, AjaeTier>;

/** The face to rest on after `move` with the hand's tier on screen `tier`: a hand with a story's show's own (AJAE_SHOW_REST), else the tier's. */
export function ajaeRestTier(move: AjaeMove, tier: AjaeTier): AjaeTier {
  return (AJAE_SHOW_REST as Partial<Record<AjaeMove, AjaeTier>>)[move] ?? tier;
}

/** The moves where the whole 아재 performs beside the class (the others are the face's): the tiers', the pairs' and the hands' shows. */
export const BODY_MOVES: ReadonlySet<AjaeMove> = new Set<AjaeMove>(["shove", "shuffle", "robot", "kick", "mallet", "slam", "rage", ...SPECIAL_MOVES, ...HAND_SHOW_MOVES]);

/**
 * The room each body move needs above the hand row, in px from the row's top up to the sticky stage bar's
 * bottom edge (96 with the page at the top): the highest anything of the move paints (a hop, the mallet
 * overhead, a note, a sparkle, a puff of steam; the plane at the top of its loop, the crown coming down) plus a
 * little. Scrolled further, the bar would cut his head off, so another move of the tier that fits plays instead,
 * or the face (AJAE_CRAMPED). The mirror ball hangs higher than the dancer: below BALL_ROOM the dance has none.
 * The pairs' shows count him and his props, not the sky around them (fireworks, confetti, rays of light and
 * searchlights may pass under the bar); so do the hands' shows, measured in the app (the cowboy's hat spinning down onto
 * his head and popping up off it in the yee-haw; TT's tens and 10월 cards hovering; 38's 광 cards hovering and their
 * sparkles; A8's cards flung up as he jumps, and his surprise lines; 96's steam and hearts off his head), not their
 * glows, rays, fireworks, falling leaves and petals, wind or thrown stars. A face move needs no room of its own (it
 * pops in its slot), only less of a pop below POP_ROOM.
 */
export const AJAE_ROOM: Readonly<Partial<Record<AjaeMove, number>>> = {
  shuffle: 58,
  robot: 50,
  shove: 51,
  kick: 53,
  mallet: 74,
  slam: 53,
  rage: 60,
  plane: 93,
  gorilla: 90,
  crown: 92,
  waltz: 52,
  split: 86,
  cowboy: 79,
  jangttaeng: 66,
  gwangttaeng: 72,
  deadman: 75,
  blush: 68,
};
export const BALL_ROOM = 90;
/**
 * The face's full pop (2.15x, growing up from the slot) reaches about 63 px above the row (the ponder's thought
 * cloud, floating up); with less room than this it pops smaller and from its middle (cue.low, ajae.css .aj-low),
 * so the stage bar doesn't cut off the top of his head, his cloud, his vein or his steam.
 */
export const POP_ROOM = 64;

/**
 * The move for the k-th reaction of the tier, with `room` px above the hand row (undefined: not measured,
 * all the room in the world). The tier's move in turn if it fits, else the next of the tier's moves that
 * fits, else the face's stand-in.
 */
export function ajaeMove(tier: AjaeTier, k: number, room?: number): AjaeMove {
  return fitting(AJAE_MOVES[tier], k, room) ?? AJAE_CRAMPED[tier];
}

/** The k-th of `moves` in turn if it fits in `room`, else the next one that does (undefined: none does). */
function fitting(moves: readonly AjaeMove[], k: number, room?: number): AjaeMove | undefined {
  for (let i = 0; i < moves.length; i++) {
    const m = moves[(k + i) % moves.length];
    const need = AJAE_ROOM[m];
    // a face move always fits (it is the face in its slot), however far the row is scrolled
    if (room === undefined || need === undefined || room >= need) return m;
  }
  return undefined;
}

/** `cls` as a pair with shows of its own (AJAE_SPECIALS), if it is one. */
export const ajaePair = (cls: HandClass): AjaePair | undefined => (Object.hasOwn(AJAE_SPECIALS, cls) ? (cls as AjaePair) : undefined);

/**
 * The move for the k-th reaction to the pair, with `room` px above the hand row: the pair's show in turn if it fits,
 * else its next show that fits, else what the kt-th hand of its tier would do there (ajaeMove: the tier's move that
 * fits, or the face's stand-in: cheer for AA, KK and QQ). The caller counts the reaction as the pair's either way.
 */
export function ajaePairMove(pair: AjaePair, k: number, tier: AjaeTier, kt: number, room?: number): AjaeMove {
  return fitting(AJAE_SPECIALS[pair], k, room) ?? ajaeMove(tier, kt, room);
}

/** `cls` as a hand with a story (AJAE_HAND_SHOWS), if it is one. */
export const ajaeShowHand = (cls: HandClass): AjaeShowHand | undefined => (Object.hasOwn(AJAE_HAND_SHOWS, cls) ? (cls as AjaeShowHand) : undefined);

/**
 * The move for a reaction to a hand with a story, with `room` px above the hand row: its show if it fits, else, as for
 * a pair, what the kt-th hand of its tier would do there (the tier's move that fits, or the face's stand-in). The
 * caller leaves the tier's turn alone either way, as for a pair.
 */
export function ajaeShowMove(hand: AjaeShowHand, tier: AjaeTier, kt: number, room?: number): AjaeMove {
  return fitting([AJAE_HAND_SHOWS[hand]], 0, room) ?? ajaeMove(tier, kt, room);
}

/** A card the rage rips: its rank (a letter of RANKS: T is the ten) and its suit (a letter of SUITS). */
export interface AjaeCard {
  rank: string;
  suit: "s" | "h" | "d" | "c";
}

/**
 * The two cards the rage rips for `cls`: the hand's own (J4o a jack and a four), the high card first (the one in front,
 * as the 7 is in 72o). The class names no suits, so each class has fixed ones, by the ranks' places in RANKS: offsuit,
 * two different suits, a black high card (clubs for an odd place, else spades) and a red low card (hearts for an odd
 * place, else diamonds), so 72o is the 7 of clubs and the 2 of diamonds; suited, the same suit on both (clubs when the
 * high card's place is odd, else diamonds).
 */
export function ajaeCards(cls: HandClass): readonly [AjaeCard, AjaeCard] {
  const odd = (rank: string) => RANKS.indexOf(rank) % 2 === 1;
  const [hi, lo] = [cls[0], cls[1]];
  if (cls[2] === "s") {
    const suit = odd(hi) ? "c" : "d";
    return [{ rank: hi, suit }, { rank: lo, suit }];
  }
  return [{ rank: hi, suit: odd(hi) ? "c" : "s" }, { rank: lo, suit: odd(lo) ? "h" : "d" }];
}

/**
 * How often the judge chart (judgeChart.ts: the solver at 딥 and 미들, our computed short-stack charts at 숏 and
 * 푸시) plays `cls` first in from `seat`, 0~1. "open": raises and shoves only, what makes a hand good; "any": a limp
 * too (the solver's SB limps a lot of hands into the BB).
 */
function playShare(stage: PreStage, players: number, seat: string, cls: HandClass, how: "open" | "any"): number {
  const r = raiseShare(stage, players, seat, cls);
  return how === "open" ? r : r + limpShare(stage, players, seat, cls);
}

/** The chart plays the hand: most of the time, the line 빠른 기록's verdict draws for 차트대로 (the solver mixes). */
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
 * The defense that decides what is trash, whatever stage is on screen: the solver's 55bb BB facing the HJ's open
 * (judgeChart.ts TRASH_DEFENSE). Not the button's open: deep, the solver's BB defends most hands against the button,
 * which would leave only a handful to kick; and short-stacked the BB folds 76s, T9o or Q9o to an open because of the
 * stack, not because the hand is junk. Against the HJ at 55bb it folds 41 offsuit hands (72o among them).
 */
const TRASH_STAGE = TRASH_DEFENSE;

/**
 * The tier of `cls` for my seat, first in at the stage, by the stage's judge chart (judgeChart.ts). The trash test
 * needs both halves: the BB folds it facing the HJ's open at 55bb (TRASH_STAGE), and no seat at the table opens or
 * shoves it first in at the stage on screen, not even mixed (at the short and push stages the button and the SB shove
 * hands the BB can't call with, and a hand someone opens is no hand to kick). A hand my own seat's chart plays at
 * least half the time is never trash from my seat, though it is from the others: the solver's SB limps much of that
 * junk into the BB (meh from the SB, the seat's call), and deep the BB defends some of it against the button. good
 * takes an open or a shove at least half the time, so a hand the SB mostly limps is meh too. The BB is graded by its
 * own defense against the button: a fold there is a fold, else good where the button opens the hand too, else meh.
 */
export function ajaeTier(cls: HandClass, seat: string, stage: PreStage, players: number): AjaeTier {
  if (cls === "72o") return "hammer";
  if (MONSTERS.has(cls)) return "monster";
  const seats = positionsFor(players);
  const btn = buttonSeat(players);
  const opens = (s: string) => playShare(stage, players, s, cls, "open");
  const bbDefends = seats.includes("BB") ? bbPlayShare(stage, players, btn, cls) : 0;
  // My own seat's chart: the BB's is its defense against the button.
  const mine = seat === "BB" ? bbDefends : playShare(stage, players, seat, cls, "any");
  if (mine < PLAYS && trashDefenseShare(TRASH_STAGE, cls) <= 1e-9 && seats.every((s) => s === "BB" || opens(s) <= 1e-9)) return "trash";
  if (seat === "BB") return bbDefends < PLAYS ? "fold" : opens(btn) >= PLAYS ? "good" : "meh";
  if (opens(seat) >= PLAYS) return "good";
  // The SB's limp plays the hand, but it is no open: the seat's call, like a hand a later seat opens.
  if (mine >= PLAYS) return "meh";
  // The button's "later" is the BB's defense against it.
  const later = seat === btn && seat !== "SB" ? bbDefends >= PLAYS : laterSeats(players, seat).some((s) => opens(s) >= PLAYS);
  // A fold here, but a hand someone opens or defends: the seat's fault, not the hand's.
  return later ? "meh" : "fold";
}

// ───────────── when he reacts ─────────────

/** One reaction: the class it is for (with the hand being corrected, if any), its tier then, and what he does. */
export interface AjaeCue {
  /** Counts up with every reaction: a new one restarts the moves. */
  n: number;
  /** The draft it reacts to (ajaeKey): it shows only while that is still on screen. */
  key: string;
  cls: HandClass;
  /** The tier when the cards went in: a different one now (my seat changed) shows at rest, without moving. */
  tier: AjaeTier;
  /** What he does (ajaeMove). */
  move: AjaeMove;
  /** The dance without its mirror ball: too little room above the hand row for it (BALL_ROOM). */
  noBall?: true;
  /** A face move with too little room above the hand row for the full pop (POP_ROOM): it pops smaller. */
  low?: true;
  /** Set once the tier on screen differed from `tier` (ajaeSeen): he never moves again for this reaction, even if it changes back. */
  settled?: true;
}

export interface AjaeState {
  cue: AjaeCue | null;
  /** Reactions so far: the next cue's n. */
  n: number;
  /** Reactions so far per tier, so each one takes the tier's next move (a pair or a hand with a show of its own doesn't count). */
  seen: Partial<Record<AjaeTier, number>>;
  /** Reactions so far per pair with a show of its own (AJAE_SPECIALS), so KK alternates its two. */
  pairs: Partial<Record<AjaePair, number>>;
}

export const AJAE_START: AjaeState = { cue: null, n: 0, seen: {}, pairs: {} };

/** The complete class on screen with the hand it belongs to ("" while the class isn't complete). */
export const ajaeKey = (d: Pick<FastDraft, "ranks" | "suited" | "editing">): string => (classDone(d) ? `${draftClass(d)}|${d.editing ?? ""}` : "");

/**
 * The 아재 after one input on the hand (`before` → `after`), at the stage and table size the hand is entered
 * at, with `room` px free above the hand row (AJAE_ROOM, BALL_ROOM, POP_ROOM; FastView measures it at the tap,
 * undefined: plenty; negative once the row is scrolled under the stage bar).
 * A class completed by this tap (the pair's second rank, 수딧 / 오프수트, or switching between them) reacts
 * with its tier's next move, or AA, KK, QQ and JJ with their own show's next (ajaePairMove: the tier's turn is
 * left for the other hands of the tier), or a hand with a story with its show (ajaeShowMove: the same); a class no longer complete takes him away at once; anything else (my
 * seat, the spot) keeps the reaction on screen. Pure: it is a state updater.
 */
export function ajaeStep(s: AjaeState, before: FastDraft, after: FastDraft, stage: PreStage, players: number, room?: number): AjaeState {
  const key = ajaeKey(after);
  if (!key) return s.cue ? { ...s, cue: null } : s;
  if (key === ajaeKey(before)) return s.cue && s.cue.key === key ? s : { ...s, cue: null };
  const cls = draftClass(after);
  const tier = ajaeTier(cls, after.seat, stage, players);
  const k = s.seen[tier] ?? 0;
  const pair = ajaePair(cls);
  const kp = pair ? (s.pairs[pair] ?? 0) : 0;
  const story = ajaeShowHand(cls);
  const move = pair ? ajaePairMove(pair, kp, tier, k, room) : story ? ajaeShowMove(story, tier, k, room) : ajaeMove(tier, k, room);
  const noBall = (move === "shuffle" || move === "robot") && room !== undefined && room < BALL_ROOM;
  const low = !BODY_MOVES.has(move) && room !== undefined && room < POP_ROOM;
  const cue: AjaeCue = { n: s.n + 1, key, cls, tier, move, ...(noBall ? { noBall: true as const } : {}), ...(low ? { low: true as const } : {}) };
  if (pair) return { ...s, cue, n: s.n + 1, pairs: { ...s.pairs, [pair]: kp + 1 } };
  if (story) return { ...s, cue, n: s.n + 1 };
  return { ...s, cue, n: s.n + 1, seen: { ...s.seen, [tier]: k + 1 } };
}

/** He goes, without a reaction (the reaction counts carry on). */
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
