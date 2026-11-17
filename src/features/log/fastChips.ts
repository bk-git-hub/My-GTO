import { makeCard, rankOf, suitOf, type Card } from "../../poker/cards";
import type { LoggedHand, Result } from "./handLog";
import { levelRow } from "./levelClock";
import { nextBoardCard } from "./suitGuess";

/**
 * 빠른 기록's chips: what a hand cost or won, typed in chips or in big blinds at the hand's level, the
 * board cards remembered (ranks, a suit only where it was remembered), and the session's chip run for
 * the graph. Pure: everything takes what it needs (the level, the hands).
 */

/** What an amount is typed in. */
export type Unit = "chips" | "bb";
/** The draft's result: 땄음 "+", 잃음 "-", 폴드, 워크 (the BB, everyone folded). */
export type FastRes = "+" | "-" | "fold" | "walk";
/** A remembered board card: rank 0–12 (cards.ts RANKS), suit 0–3 only when remembered. */
export interface BoardMark {
  r: number;
  s?: number;
}

/** The minus sign amounts are shown with (U+2212: as wide as +, never read as a dash). */
export const MINUS = "−";

// ───────────── blinds ─────────────

/**
 * Chips `seat` posts before the cards: the SB its small blind, the BB its big blind plus the BB ante
 * (`bbAnte`), every other seat nothing. Null when it posts something but the level isn't known.
 * Heads-up the SB is the button and posts the small blind.
 */
export function postedBy(seat: string, level: number | null, bbAnte = true): number | null {
  if (seat !== "SB" && seat !== "BB") return 0;
  const row = levelRow(level);
  if (!row) return null;
  return seat === "SB" ? row.sb : row.bb + (bbAnte ? row.ante : 0);
}

/** The BB's win when everyone folds to it: the small blind (its own blind and ante come back). Null without a level. */
export function walkWin(level: number | null): number | null {
  return levelRow(level)?.sb ?? null;
}

// ───────────── amounts ─────────────

/** A stored amount's shape per unit: chips up to 9 digits; bb up to 4 digits and one decimal. */
export const AMOUNT_PATTERN: Record<Unit, RegExp> = { chips: /^\d{1,9}$/, bb: /^\d{1,4}(\.\d?)?$/ };

/**
 * A key typed into an amount ("0"–"9", "00", "000", "."): chips take digits only (at most 9, "." does
 * nothing); bb take up to 4 whole digits and one decimal ("000" does nothing). A leading 0 gives way
 * to the next digit, "00" / "000" on an empty field do nothing, "." on an empty field types "0.".
 * The same text comes back when the key doesn't fit.
 */
export function typeAmount(text: string, key: string, unit: Unit): string {
  if (key === ".") {
    if (unit === "chips" || text.includes(".")) return text;
    return text === "" ? "0." : `${text}.`;
  }
  if (!/^\d{1,3}$/.test(key)) return text;
  if (unit === "bb" && key === "000") return text;
  const dot = text.indexOf(".");
  if (dot >= 0) return text.length - dot - 1 + key.length > 1 ? text : text + key;
  if (key.length > 1 && (text === "" || text === "0")) return text;
  const next = text === "0" ? key : text + key;
  return next.length > (unit === "chips" ? 9 : 4) ? text : next;
}

/** The number an amount's text reads as ("12.5" → 12.5), null for nothing typed. */
export function amountValue(text: string): number | null {
  if (text === "" || text === ".") return null;
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

/** An amount in chips: chips as typed; bb at the level's big blind, rounded to a chip. Null without the text, or bb without a level. */
export function toChips(text: string, unit: Unit, level: number | null): number | null {
  const v = amountValue(text);
  if (v === null) return null;
  if (unit === "chips") return Math.round(v);
  const row = levelRow(level);
  return row ? Math.round(v * row.bb) : null;
}

/** x to one decimal, without a trailing ".0": 20.575 → "20.6", 20 → "20". */
const oneDec = (x: number): string => String(Math.round(x * 10) / 10);

/**
 * An amount's text in the other unit: chips → bb to 0.1bb ("12345" → "20.6" at Lv5), bb → chips exactly
 * ("20.5" → "12300"). Without a level, or with nothing typed, the text stays as it is.
 */
export function convertText(text: string, from: Unit, to: Unit, level: number | null): string {
  if (from === to) return text;
  const v = amountValue(text);
  const row = levelRow(level);
  if (v === null || !row) return text;
  return to === "bb" ? oneDec(v / row.bb) : String(Math.round(v * row.bb));
}

/** Chips in big blinds at the level, to 0.1; null without a level. */
export function inBb(chips: number, level: number | null): number | null {
  const row = levelRow(level);
  return row ? Math.round((chips / row.bb) * 10) / 10 : null;
}

// ───────────── formatting ─────────────

/** 12,000 */
export const chipsText = (n: number): string => n.toLocaleString();

/** Short chips for tight places: under 10,000 as is, else in 만: 15000 → "1.5만", 100000 → "10만". */
export function chipsShort(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? MINUS : "";
  return a < 10_000 ? `${sign}${a.toLocaleString()}` : `${sign}${oneDec(a / 10_000)}만`;
}

/** "20bb", "20.5bb". */
export const bbText1 = (x: number): string => `${oneDec(x)}bb`;

/** "+12,000" / "−12,000" / "본전"; in bb "+20bb" (chips again without a level). */
export function signedText(n: number, unit: Unit, level: number | null = null): string {
  if (n === 0) return "본전";
  const sign = n > 0 ? "+" : MINUS;
  const b = unit === "bb" ? inBb(Math.abs(n), level) : null;
  return b !== null ? `${sign}${bbText1(b)}` : `${sign}${Math.abs(n).toLocaleString()}`;
}

/** "+12,000 (+20bb)", "+12,000" without a level, "본전". */
export function netBoth(net: number, level: number | null): string {
  if (net === 0) return "본전";
  const b = inBb(net, level);
  return b !== null ? `${signedText(net, "chips")} (${signedText(net, "bb", level)})` : signedText(net, "chips");
}

/** The level chip: "Lv5 300/600", "Lv17 5,000/1만", "Lv26 5만/10만", "레벨 ?". */
export function levelChip(level: number | null): string {
  const row = levelRow(level);
  return row ? `Lv${row.level} ${chipsShort(row.sb)}/${chipsShort(row.bb)}` : "레벨 ?";
}

// ───────────── the draft's result ─────────────

export type ResultOut = { result: Result | null; net: number | null } | { block: "sign" | "level" };

/**
 * What the draft saves as: 폴드 loses what the seat posted (nothing for the seats before the blinds; a
 * blind's fold without a level is a fold of unknown chips), 워크 wins the small blind, + / − with an
 * amount wins or loses it (0 is a chop), a sign without an amount is a win or loss of unknown chips.
 * Blocked: an amount without a sign, or a bb amount without a level to turn it into chips.
 */
export function draftResult(i: { res?: FastRes; amount?: string; unit: Unit; seat: string; level: number | null; bbAnte: boolean }): ResultOut {
  const amount = i.amount ?? "";
  if (i.res === "fold") {
    const posted = postedBy(i.seat, i.level, i.bbAnte);
    return { result: "fold", net: posted === null ? null : posted === 0 ? 0 : -posted };
  }
  if (i.res === "walk") return i.seat === "BB" ? { result: "win", net: walkWin(i.level) } : { result: null, net: null };
  const v = amountValue(amount);
  if (!i.res) return v === null ? { result: null, net: null } : { block: "sign" };
  const win = i.res === "+";
  if (v === null) return { result: win ? "win" : "lose", net: null };
  if (v === 0) return { result: "chop", net: 0 };
  const chips = toChips(amount, i.unit, i.level);
  if (chips === null) return { block: "level" };
  return { result: win ? "win" : "lose", net: win ? chips : -chips };
}

// ───────────── the board ─────────────

/** A rank may go on the board: under 5 cards, and fewer than 4 of it counting the hole class's ranks. */
export function canAddRank(marks: BoardMark[], r: number, holeRanks: number[]): boolean {
  if (marks.length >= 5 || !Number.isInteger(r) || r < 0 || r > 12) return false;
  return marks.filter((m) => m.r === r).length + holeRanks.filter((x) => x === r).length < 4;
}

/**
 * Concrete cards for the marks: a card with its suit as typed; the rest guessed in order, each a new
 * suit as far as the board and the hole cards allow (suitGuess nextBoardCard, the "숫자만" way), never a
 * card already placed or in `hole`. `guessed`: the indexes typed without a suit. Null when a card can't
 * be placed (a known card twice, a rank with no card left).
 */
export function boardCards(marks: BoardMark[], hole: Card[]): { cards: Card[]; guessed: number[] } | null {
  if (marks.length > 5) return null;
  const cards: (Card | null)[] = marks.map((m) => (m.s === undefined ? null : makeCard(m.r, m.s)));
  const known = cards.filter((c): c is Card => c !== null);
  if (new Set(known).size < known.length) return null;
  const guessed: number[] = [];
  const isCard = (c: Card | null): c is Card => c !== null;
  for (let i = 0; i < marks.length; i++) {
    if (cards[i] !== null) continue;
    // The flop's other cards for a flop card, the cards before it for the turn and the river.
    const ctx = i < 3 ? cards.slice(0, 3).filter((c, k): c is Card => k !== i && c !== null) : cards.slice(0, i).filter(isCard);
    const taken = [...cards.filter(isCard), ...hole];
    const c = nextBoardCard(marks[i].r, ctx, "newSuit", taken) ?? nextBoardCard(marks[i].r, ctx, "unknown", taken);
    if (c === null) return null;
    cards[i] = c;
    guessed.push(i);
  }
  return { cards: cards as Card[], guessed };
}

/** Back from a saved board: a card whose suit was guessed keeps only its rank. */
export function marksOf(board: Card[], guessed: number[] = []): BoardMark[] {
  return board.map((c, i) => (guessed.includes(i) ? { r: rankOf(c) } : { r: rankOf(c), s: suitOf(c) }));
}

// ───────────── the session ─────────────

export interface SessionMoney {
  /** Σ net, a hand without one counted as 0. */
  chips: number;
  /** Σ net in bb at each hand's level (hands without a level left out), to 0.1; null if no hand with a net had a level. */
  bb: number | null;
  withResult: number;
  noResult: number;
  won: number;
  lost: number;
  folds: number;
}

export function sessionMoney(hands: LoggedHand[]): SessionMoney {
  let chips = 0;
  let bb = 0;
  let anyBb = false;
  let withResult = 0;
  let won = 0;
  let lost = 0;
  let folds = 0;
  for (const h of hands) {
    if (h.net !== null) {
      chips += h.net;
      const row = levelRow(h.level);
      if (row) {
        bb += h.net / row.bb;
        anyBb = true;
      }
    }
    if (h.result !== null || h.net !== null) withResult++;
    if (h.result === "win") won++;
    else if (h.result === "lose") lost++;
    else if (h.result === "fold") folds++;
  }
  return { chips, bb: anyBb ? Math.round(bb * 10) / 10 : null, withResult, noResult: hands.length - withResult, won, lost, folds };
}

export interface ChipPoint {
  x: number;
  y: number;
}

/** The session's chips over its hands, for the graph. */
export interface ChipSeries {
  /** The unit the points are in (chips when bb was asked for but no hand has a level). */
  unit: Unit;
  /** Some hand has a stack on file (지금 스택): the points are real stacks, else a running total from 0. */
  absolute: boolean;
  /** x = hands done (0: before the first), broken where a stack on file disagrees with the running count. */
  segments: ChipPoint[][];
  /** Where a stack on file disagrees with the count: at x, from the count to the stack. */
  jumps: { x: number; from: number; to: number }[];
  /** Points where the stack was known (지금 스택 typed on that hand). */
  anchors: ChipPoint[];
  start: number;
  end: number;
  min: number;
  max: number;
  /** Hands counted as 0: no chips on file (in bb also hands without a level). */
  unknown: number;
}

/** The hands oldest first (the graph's order). */
export const oldestFirst = (hands: LoggedHand[]): LoggedHand[] => [...hands].sort((a, b) => a.createdAt - b.createdAt);

/**
 * The chip run of the session's hands. Without any stack on file it is relative: 0 before the first hand,
 * each hand's net added (a hand without one counts 0). With stacks (the hand's chips at its start, from
 * 지금 스택), it is absolute from the first one: back to the first hand by taking the nets off, forward
 * by adding them; a later stack that disagrees with the count (a hand missed) breaks the line there with
 * a jump to it. In bb each point is divided by its hand's big blind (a hand without a level takes the
 * nearest earlier one's, else the next's); no level at all gives chips. Null without any net or stack.
 */
export function chipSeries(hands: LoggedHand[], unit: Unit): ChipSeries | null {
  const old = oldestFirst(hands);
  const n = old.length;
  const first = old.findIndex((h) => h.stack !== null);
  if (!n || (first < 0 && old.every((h) => h.net === null))) return null;
  const bbOf = old.map((h) => levelRow(h.level)?.bb ?? null);
  const u: Unit = unit === "bb" && bbOf.some((b) => b !== null) ? "bb" : "chips";
  const d = old.map((h) => h.net ?? 0);
  const segments: ChipPoint[][] = [];
  const jumps: ChipSeries["jumps"] = [];
  const anchors: ChipPoint[] = [];
  let unknown = 0;

  if (first < 0) {
    let y = 0;
    const seg: ChipPoint[] = [{ x: 0, y: 0 }];
    old.forEach((h, i) => {
      const bb = bbOf[i];
      if (h.net === null || (u === "bb" && bb === null)) unknown++;
      else y += u === "bb" ? h.net / (bb as number) : h.net;
      seg.push({ x: i + 1, y });
    });
    segments.push(seg);
  } else {
    const start: number[] = new Array(n).fill(0);
    start[first] = old[first].stack as number;
    for (let i = first - 1; i >= 0; i--) start[i] = start[i + 1] - d[i];
    let seg: ChipPoint[] = [{ x: 0, y: start[0] }];
    segments.push(seg);
    old.forEach((h, i) => {
      if (h.net === null) unknown++;
      if (i > first) {
        const count = start[i - 1] + d[i - 1];
        if (h.stack !== null && h.stack !== count) {
          jumps.push({ x: i, from: count, to: h.stack });
          seg = [{ x: i, y: h.stack }];
          segments.push(seg);
        }
        start[i] = h.stack ?? count;
      }
      const y = start[i] + d[i];
      seg.push({ x: i + 1, y });
      if (h.stack !== null) anchors.push({ x: i + 1, y });
    });
    if (u === "bb") {
      // Each point at its hand's big blind: point x is after hand x (point 0: the first hand's).
      const filled = bbOf.map((b, i) => b ?? [...bbOf.slice(0, i)].reverse().find((x) => x !== null) ?? bbOf.slice(i + 1).find((x) => x !== null) ?? 1);
      const at = (x: number) => filled[Math.max(x - 1, 0)] as number;
      for (const s of segments) for (const p of s) p.y /= at(p.x);
      for (const j of jumps) {
        j.from /= at(j.x);
        j.to /= at(j.x);
      }
      for (const a of anchors) a.y /= at(a.x);
    }
  }
  const all = segments.flat();
  const startY = all[0].y;
  const ys = [...all.map((p) => p.y), first < 0 ? 0 : startY];
  return { unit: u, absolute: first >= 0, segments, jumps, anchors, start: startY, end: all[all.length - 1].y, min: Math.min(...ys), max: Math.max(...ys), unknown };
}

/** The value after hand x (x = 0: before the first hand): the running count where a jump follows it. */
export function seriesAt(s: ChipSeries, x: number): number | null {
  for (const seg of s.segments) {
    const p = seg.find((q) => q.x === x);
    if (p) return p.y;
  }
  return null;
}
