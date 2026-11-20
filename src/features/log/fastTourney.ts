import type { Go } from "../../backNav";
import { levelChip, missedOf, oldestFirst, resultOfNet, sessionMoney, stackAt, type StackAt } from "./fastChips";
import {
  cleanFastState,
  fastLevel,
  fastStore,
  SESSION_GAP_MS,
  SESSION_IDLE_MS,
  sessionOf,
  startEdit,
  withFastResult,
  type FastDraft,
  type FastLevel,
  type FastMode,
  type FastState,
  type SessionInfo,
} from "./fastLog";
import {
  cleanStartClock,
  fastOnly,
  deleteHands,
  handLogStore,
  handRoute,
  isOther,
  levelEstimateAt,
  localDay,
  saveHand,
  setTodayStart,
  START_LEAD_MS,
  START_SPAN_MS,
  startClockFor,
  startFor,
  startMsOf,
  type HandLogState,
  type LoggedHand,
} from "./handLog";
import { cleanBlinds, durationText, levelAt, levelRow, levelStartMinutes, parseClock, plainBlinds, type Blinds, type LevelEstimate } from "./levelClock";
import { presetBlinds, presetById, presetFrom, presetSpanMinutes, presetStart, type PresetId, type StructurePreset } from "./structures";
import { cleanChecks, cleanTourneys, isStackChips, TOURNEY_MEMO_MAX, TOURNEY_NAME_MAX, withoutTourney, withTourney, type StackCheck, type Tourney } from "./tourney";

/**
 * 빠른 기록's tournaments: which one is current, the hands of each, the level clock its start gives, the
 * groups the 토너먼트 기록 screens list, and the store actions behind the sheet and the buttons.
 *
 * The current tournament is the one started or resumed (이어 적기) last, while it is live: it had a hand, a
 * start or a resume within TOURNEY_IDLE_MS. Every new 빠른 기록 hand (mine and other players') goes to it
 * with no tap of its own; with none current, the hand starts one on its own (autoTourney), on file in the
 * same write as the hand, and today's hands logged before tournaments (an update arriving mid-tournament) join
 * it. Nothing stores which one is current, so nothing can point at a record that is gone.
 */

/**
 * A tournament with no hand, start or resume for this long is over: the next hand starts a new one (as the
 * very first hand does). A pub tournament never pauses this long; one carried on another day is picked up
 * with 이어 적기. Infinity would keep the last one current for good.
 */
export const TOURNEY_IDLE_MS = SESSION_IDLE_MS;
/** The pub's starting stack (docs/game-profile.md: 시작 스택 50,000), offered in the new-tournament sheet. */
export const PUB_START_STACK = 50_000;

export const newTourneyId = (now: number = Date.now()): string => `t-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const kindFits = (h: Pick<LoggedHand, "kind">, mode: FastMode): boolean => isOther(h) === (mode === "other");
const byNewest = (a: LoggedHand, b: LoggedHand) => b.createdAt - a.createdAt;

/** The 빠른 기록 hands of tournament `id` of the mode's kind (mine, or other players'), newest first. */
export function tourneyHands(hands: LoggedHand[], id: string, mode: FastMode = "mine"): LoggedHand[] {
  return hands.filter((h) => h.fast === true && h.tourney === id && kindFits(h, mode)).sort(byNewest);
}

/** Every 빠른 기록 hand of tournament `id`, mine and other players'. */
const allOf = (hands: LoggedHand[], id: string): LoggedHand[] => hands.filter((h) => h.fast === true && h.tourney === id);

/** The time of its newest hand (mine or other), or null with none. */
export function lastHandAt(hands: LoggedHand[], id: string): number | null {
  let at: number | null = null;
  for (const h of hands) if (h.fast === true && h.tourney === id && (at === null || h.createdAt > at)) at = h.createdAt;
  return at;
}

/** The time of its oldest hand (mine or other), or null with none. */
function firstHandAt(hands: LoggedHand[], id: string): number | null {
  let at: number | null = null;
  for (const h of hands) if (h.fast === true && h.tourney === id && (at === null || h.createdAt < at)) at = h.createdAt;
  return at;
}

/**
 * When it was last used: its start or resume, or its newest hand. A ready-made structure's day (WPL) counts its
 * start too: set up the night before, it is still live at its start the next morning (a start ahead: live till then).
 */
export function lastActivity(t: Tourney, hands: LoggedHand[]): number {
  const used = Math.max(t.activeAt, lastHandAt(hands, t.id) ?? -Infinity);
  return t.startSet && presetOf(t) ? Math.max(used, t.start) : used;
}

/**
 * When it counts as started (which one is current): its start or resume; a ready-made structure's day set up
 * ahead, from its start once that has come (a pub tournament logged the night before doesn't hold its morning).
 */
function startedAt(t: Tourney, now: number): number {
  return t.startSet && presetOf(t) && t.start <= now ? Math.max(t.activeAt, t.start) : t.activeAt;
}

/** The one started or resumed last by `now` (a tie: the one made later). */
function latest(ts: Tourney[], now: number): Tourney | null {
  return ts.reduce<Tourney | null>((b, t) => {
    const a = b ? startedAt(b, now) : -Infinity;
    const x = startedAt(t, now);
    return !b || x > a || (x === a && t.createdAt >= b.createdAt) ? t : b;
  }, null);
}

/** The current tournament at `now`: the one started or resumed last, if it was used within TOURNEY_IDLE_MS; else null. */
export function currentTourney(ts: Tourney[], hands: LoggedHand[], now: number): Tourney | null {
  const t = latest(ts, now);
  return t && now - lastActivity(t, hands) <= TOURNEY_IDLE_MS ? t : null;
}

/** A start covers the moments from 10 hours before it to 14 hours after (the same window as a day's start time). */
export const startCovers = (start: number, at: number): boolean => at >= start - START_LEAD_MS && at < start + START_SPAN_MS;

const MIN_MS = 60_000;

/**
 * A ready-made structure's day from `start` (at `startLevel`) covers from START_LEAD_MS before it to the end of its
 * table, at least START_SPAN_MS (DAY3's sixteen 60-minute levels run longer than that).
 */
export function presetCovers(p: StructurePreset, startLevel: number | undefined, start: number, at: number): boolean {
  return at >= start - START_LEAD_MS && at < start + Math.max(START_SPAN_MS, presetSpanMinutes(p, startLevel) * MIN_MS);
}

/** The local start at `clock` `delta` days from `ref`'s day, or null for a clock that can't be read. */
function clockOn(clock: string, ref: number, delta: number): number | null {
  const c = parseClock(clock);
  if (!c || !Number.isFinite(ref)) return null;
  const d = new Date(ref);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta, c.h, c.m).getTime();
}

/**
 * The start a new tournament of ready-made structure `p` takes from its fixed `clock`, made at `now`: the first of
 * yesterday's, today's and tomorrow's that can still be joined (now before it plus its joinMinutes). So DAY1's 10:00
 * made in the evening is the next morning's, made after midnight or at the table it is that day's. Null for a clock
 * that can't be read.
 */
export function presetStartMs(p: StructurePreset, clock: string, now: number): number | null {
  for (const delta of [-1, 0, 1]) {
    const c = clockOn(clock, now, delta);
    if (c === null) return null;
    if (now < c + p.joinMinutes * MIN_MS) return c;
  }
  return clockOn(clock, now, 1);
}

/**
 * The start a hand at `at` of ready-made structure `p` (from `startLevel`) was played after: the latest of the
 * days' starts at `clock` up to `at` whose day covers it (DAY3 played past 03:00 is still the day before's), else
 * the clock read near `at` (startMsFor). Null for a clock that can't be read.
 */
function presetHandStart(p: StructurePreset, startLevel: number | undefined, clock: string, at: number): number | null {
  for (const delta of [0, -1]) {
    const c = clockOn(clock, at, delta);
    if (c !== null && c <= at && presetCovers(p, startLevel, c, at)) return c;
  }
  return startMsFor(clock, at);
}

/**
 * The level at `at` by the tournament's start, when it has one set and it covers `at`; else `fallback` (the
 * day's start time's estimate). So a tournament resumed on a later day never gives blinds from days ago:
 * there the day's start counts, else none (레벨 ?). A tournament started by a hand on its own and never
 * edited took the day's start as a copy: it follows the day's start while one covers `at` (a start
 * corrected in 핸드 복기 counts here too).
 */
export function tourneyEstimate(t: Tourney | null, at: number, fallback: LevelEstimate | null): LevelEstimate | null {
  // A ready-made structure (WPL): its own table from its own start (and start level); never the day's 야자수 새틀 clock.
  const p = presetOf(t);
  if (t && p) return t.startSet && presetCovers(p, t.startLevel, t.start, at) ? { ...levelAt(t.start, at, presetFrom(p, t.startLevel), p.breaks), startClock: clockOf(t.start) } : null;
  // 직접 입력: the blinds are typed as they go up; nothing is guessed from a clock, not even the day's.
  if (t && isCustom(t)) return null;
  if (t?.startSet && startCovers(t.start, at) && !(t.auto && fallback)) return { ...levelAt(t.start, at), startClock: clockOf(t.start) };
  return fallback;
}

/** The ready-made structure (WPL 메인 DAY1/2/3) tournament `t` follows, or null (야자수 새틀, 직접 입력). */
export const presetOf = (t: Pick<Tourney, "structure" | "preset"> | null | undefined): StructurePreset | null => (t?.structure === "custom" ? presetById(t.preset) : null);

/**
 * What a start `clock` (read near `at`) gives at `at` by ready-made structure tournament `t`'s table (its start
 * level), nothing stored: for a hand of it being corrected. False for a clock that can't be read or a tournament
 * without a ready-made structure.
 */
export function presetEstimate(t: Tourney, clock: string, at: number): LevelEstimate | null | false {
  const p = presetOf(t);
  const start = p ? presetHandStart(p, t.startLevel, clock, at) : null;
  if (!p || start === null) return false;
  return { ...levelAt(start, at, presetFrom(p, t.startLevel), p.breaks), startClock: clockOf(start) };
}

/** A 직접 입력 tournament: its blinds are typed by hand (no 야자수 새틀 level, no time estimate). Not one with a ready-made structure. */
export const isCustom = (t: Pick<Tourney, "structure" | "preset"> | null | undefined): boolean => t?.structure === "custom" && !presetOf(t);

/**
 * The level new hands go in at in tournament `t` (null: none current): a 직접 입력 tournament's blinds as set
 * (none yet: null, never guessed); a ready-made structure's level (a level picked, moved on by its clock, else its
 * clock `est`) as its blinds with their number; else fastLevel's (a level picked, else the estimate `est`).
 */
export function levelFor(t: Tourney | null, s: Pick<FastState, "levelPick">, session: LoggedHand[], now: number, est: LevelEstimate | null): FastLevel & { picked: boolean } {
  if (t && isCustom(t)) return { level: t.blinds ?? null, guessed: false, picked: false };
  const p = presetOf(t);
  if (t && p) {
    const r = fastLevel(s, session, now, est, t.id, p.schedule, p.breaks, (lv, at) => presetPickFrom(t, p, lv, at));
    return { ...r, level: typeof r.level === "number" ? presetBlinds(p, r.level) : null };
  }
  return fastLevel(s, session, now, est, t?.id ?? null);
}

/**
 * Where a level picked at `at` in ready-made structure tournament `t` runs from, on its clock's boundaries: the floor
 * keeps the structure's clock, so a pick moves the day by whole levels and never by the minutes of the tap. The
 * level the clock is at (a tap that confirms it), or the one it comes to next (picked before the start or in the
 * break before it): from where the clock has it, nothing moved. Another level: from the start of the clock's level
 * at the pick (up to the picked level's length back). In a break, after the table, or with no start covering the
 * pick: from the moment it was picked (as 야자수 새틀's picks).
 */
export function presetPickFrom(t: Tourney, p: StructurePreset, level: number, at: number): number {
  if (!t.startSet || !presetCovers(p, t.startLevel, t.start, at)) return at;
  const rows = presetFrom(p, t.startLevel);
  const startOf = (lv: number): number | null => {
    const m = levelStartMinutes(lv, rows, p.breaks);
    return m === null ? null : t.start + m * MIN_MS;
  };
  const e = levelAt(t.start, at, rows, p.breaks);
  if ((e.phase === "level" && e.level === level) || ((e.phase === "before" || e.phase === "break") && e.nextLevel === level)) return startOf(level) ?? at;
  if (e.phase !== "level" || e.level === null) return at;
  const from = startOf(e.level);
  const len = levelRow(level, p.schedule)?.minutes ?? 0;
  return from === null ? at : at - Math.min(at - from, len * MIN_MS);
}

/** Whether new hands in `t` have the BB ante: a 직접 입력 tournament's from its blinds (앤티 0: none), a ready-made structure's always, else the toggle's. */
export const anteFor = (t: Tourney | null, s: Pick<FastState, "noAnte">): boolean => (t && isCustom(t) ? (t.blinds?.ante ?? 0) > 0 : presetOf(t) ? true : !s.noAnte);

/** The stage 빠른 기록 opens at on a first visit, from the level the clock gives: 야자수 새틀's only (its levels are what levelStage knows). */
export function stageLevel(at: number, s: HandLogState = handLogStore.get()): number | null {
  const cur = currentTourney(cleanTourneys(s.tourneys), s.hands, at);
  if (presetOf(cur) || isCustom(cur)) return null;
  const e = fastEstimate(at, s);
  return e && e.phase !== "before" ? e.level : null;
}

/** The estimate 빠른 기록 uses at `at`: the current tournament's start, else the day's (tourneyEstimate). */
export function fastEstimate(at: number, s: HandLogState = handLogStore.get()): LevelEstimate | null {
  return tourneyEstimate(currentTourney(cleanTourneys(s.tourneys), s.hands, at), at, levelEstimateAt(at, s));
}

/**
 * The tournament a first hand at `at` starts on its own: the day's start time as its start when one covers
 * `at`; else the hand's time, for showing only (no `startSet`: no level is guessed from it). Name and start
 * stack unknown; `auto` until edited.
 */
export function autoTourney(at: number, s: HandLogState = handLogStore.get()): Tourney {
  const ms = startMsOf(startFor(at, s) ?? undefined);
  return {
    id: newTourneyId(at),
    createdAt: at,
    updatedAt: at,
    activeAt: at,
    name: "",
    memo: "",
    start: ms ?? at,
    ...(ms !== null ? { startSet: true as const } : {}),
    startStack: null,
    auto: true,
  };
}

/**
 * The tournament a new hand saved at `at` goes to: the current one (`start` null), or a new one not on file
 * yet (`start`: the record, for saveHand to store with the hand in one write).
 */
export function tourneyForNew(at: number, s: HandLogState = handLogStore.get()): { id: string; start: Tourney | null } {
  const cur = currentTourney(cleanTourneys(s.tourneys), s.hands, at);
  if (cur) return { id: cur.id, start: null };
  const t = autoTourney(at, s);
  return { id: t.id, start: t };
}

/** A pick picked while no tournament was current, made over SESSION_IDLE_MS before `now`: over (never stamped onto a new one). */
const pickLapsed = (p: { at?: unknown }, now: number): boolean => typeof p.at !== "number" || now - p.at > SESSION_IDLE_MS;

/**
 * A level picked before the tournament existed now belongs to it; one picked over SESSION_IDLE_MS ago is
 * dropped instead (last night's pick never comes back with tonight's first hand). The same state back when
 * nothing changes.
 */
export function stampPick(s: FastState, id: string, now: number): FastState {
  if (!s.levelPick || s.levelPick.t) return s;
  if (pickLapsed(s.levelPick, now)) {
    const { levelPick: _p, ...rest } = s;
    void _p;
    return rest;
  }
  return { ...s, levelPick: { ...s.levelPick, t: id } };
}

/** A level picked in tournament `id` goes from 빠른 기록's stored editor (its structure changed: the number means another level now). */
function dropStoredPick(id: string): void {
  const raw = fastStore.get();
  const p = raw.levelPick;
  if (!p || typeof p !== "object" || p.t !== id) return;
  const { levelPick: _p, ...rest } = raw;
  void _p;
  fastStore.set(rest);
}

/** The same on 빠른 기록's stored editor (a tournament started from 남의 핸드, or from the sheet: the level pick lives there). */
export function stampStoredPick(id: string, now: number): void {
  const raw = fastStore.get();
  const p = raw.levelPick;
  if (!p || typeof p !== "object" || p.t) return;
  if (pickLapsed(p, now)) {
    const { levelPick: _p, ...rest } = raw;
    void _p;
    fastStore.set(rest);
  } else fastStore.set({ ...raw, levelPick: { ...p, t: id } });
}

/**
 * Today's hands logged before tournaments, still running at `now` (the ones 빠른 기록 shows with none
 * current: sessionOf, mine and other players' each): a tournament started now takes them in.
 */
export function runningUntagged(hands: LoggedHand[], now: number): LoggedHand[] {
  const loose = hands.filter((h) => !h.tourney);
  return [...sessionOf(loose, now, "mine"), ...sessionOf(loose, now, "other")];
}

/** `s` with the hands `ids` tagged with tournament `id` (edited `now`, so a backup merge keeps the tag). */
function tagHands(s: HandLogState, ids: Set<string>, id: string, now: number): HandLogState {
  if (!ids.size) return s;
  return { ...s, hands: s.hands.map((h) => (ids.has(h.id) && !h.tourney ? { ...h, tourney: id, updatedAt: Math.max(h.updatedAt, now) } : h)) };
}

/**
 * A new 빠른 기록 hand on file, tagged with the tournament it goes to (tourneyForNew): the current one, or
 * one it starts, stored in the same write with today's running hands from before tournaments joining it
 * (runningUntagged). `hand`: as saved; `started`: the tournament it started, else null. Nothing is kept
 * when the browser refuses the write.
 */
export function saveNewFast(h: LoggedHand, now: number, extra: LoggedHand[] = []): { ok: boolean; hand: LoggedHand; started: Tourney | null } {
  const st = handLogStore.get();
  const nt = tourneyForNew(now, st);
  const hand: LoggedHand = { ...h, tourney: nt.id };
  // `extra`: hands that go with it in the same write (the seats skipped since the last hand, as folds), same tournament.
  const withExtra = (x: HandLogState): HandLogState =>
    extra.length ? { ...x, hands: [...x.hands.filter((y) => !extra.some((e) => e.id === y.id)), ...extra.map((e) => ({ ...e, tourney: nt.id }))].sort((a, b) => b.createdAt - a.createdAt) } : x;
  const add = (x: HandLogState): HandLogState => presetBlindsTo(withExtra(x), nt.id, hand);
  const t = nt.start;
  if (!t) return { ok: saveHand(hand, add), hand, started: null };
  const join = new Set(runningUntagged(st.hands, now).map((x) => x.id));
  const ok = saveHand(hand, (s) => add(tagHands(withTourney(s, t), join, t.id, now)));
  return { ok, hand, started: ok ? t : null };
}

/**
 * A ready-made structure's tournament `id` with its stored `blinds` at hand `h`'s (in the same write as the hand):
 * an older app reads it as 직접 입력 at those blinds, so they stay the blinds of now. Its updatedAt stays (only that
 * app reads them). The same state back for any other tournament, or a hand with no blinds.
 */
function presetBlindsTo(s: HandLogState, id: string, h: LoggedHand): HandLogState {
  const t = cleanTourneys(s.tourneys).find((x) => x.id === id);
  const b = h.level === null ? cleanBlinds(h.blinds) : null;
  if (!t || !presetOf(t) || !b || (t.blinds && t.blinds.sb === b.sb && t.blinds.bb === b.bb && t.blinds.ante === b.ante)) return s;
  return withTourney(s, { ...t, blinds: plainBlinds(b) });
}

// ───────────── display ─────────────

const pad2 = (n: number) => String(n).padStart(2, "0");
/** "19:00". */
export const clockOf = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** "11월 17일 (월)". */
export const dateOf = (ms: number): string => new Date(ms).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });

/** The day it is about: its start when set, else its first hand, else when it was made. */
export function tourneyDay(t: Tourney, hands: LoggedHand[]): number {
  return t.startSet ? t.start : (firstHandAt(hands, t.id) ?? t.createdAt);
}

/** The title a tournament on the day of `ms` gets without a name: "11/17 토너먼트". */
export function defaultTitle(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} 토너먼트`;
}

/** Its name, or "11/17 토너먼트" by its day. */
export function tourneyTitle(t: Tourney, hands: LoggedHand[]): string {
  return t.name || defaultTitle(tourneyDay(t, hands));
}

/** "19:00 시작" (its start set), "21:05부터" (its first hand), or "시작 시각 모름". */
export function tourneyWhen(t: Tourney, hands: LoggedHand[]): string {
  if (t.startSet) return `${clockOf(t.start)} 시작`;
  const first = firstHandAt(hands, t.id);
  return first !== null ? `${clockOf(first)}부터` : "시작 시각 모름";
}

/** tourneyWhen seen at `now`: a start still to come on a later day with its date ("11월 21일 (토) 10:00 시작": a WPL day set up the night before). */
export function tourneyWhenAt(t: Tourney, hands: LoggedHand[], now: number): string {
  return t.startSet && t.start > now && localDay(t.start) !== localDay(now) ? `${dateOf(t.start)} ${clockOf(t.start)} 시작` : tourneyWhen(t, hands);
}

/**
 * The tournament's lines for the copy text (sessionText); a ready-made structure names its event ("WPL 메인 이벤트")
 * and its day, pace and the levels its hands were played at ("DAY1 · 30분 레벨 · L1–L4"; none yet: "L19부터").
 */
export function infoOf(t: Tourney, hands: LoggedHand[]): SessionInfo {
  const p = presetOf(t);
  return {
    title: tourneyTitle(t, hands),
    when: `${dateOf(tourneyDay(t, hands))} ${tourneyWhen(t, hands)}`,
    startStack: t.startStack,
    memo: t.memo,
    ...(t.checks?.length ? { checks: t.checks } : {}),
    ...(p ? { event: p.event, structure: `${p.short} · ${presetFrom(p, t.startLevel)[0].minutes}분 레벨 · ${playedLevels(t, p, hands)}` } : {}),
  };
}

/** The levels the hands of ready-made structure tournament `t` were played at: "L1–L4", "L2"; none: "L19부터" (its start level). */
function playedLevels(t: Tourney, p: StructurePreset, hands: LoggedHand[]): string {
  const lvs = allOf(hands, t.id).flatMap((h) => {
    const b = h.level === null ? cleanBlinds(h.blinds) : null;
    return b?.lv !== undefined ? [b.lv] : [];
  });
  if (!lvs.length) return `L${presetStart(p, t.startLevel)}부터`;
  const lo = Math.min(...lvs);
  const hi = Math.max(...lvs);
  return lo === hi ? `L${lo}` : `L${lo}–L${hi}`;
}

// ───────────── the groups the 토너먼트 기록 screens list ─────────────

export interface TourneyGroup {
  kind: "tourney" | "legacy";
  /** The tournament's id, or a legacy group's newest hand's time (its route key: deleting that hand keeps it found). */
  key: string;
  /** The record; for an id on hands but missing from the store, one made from its hands (not stored). Null for legacy. */
  t: Tourney | null;
  /** My 빠른 기록 hands, newest first. */
  hands: LoggedHand[];
  /** Its other players' hands (0 for legacy: those stay in 지난 기록). */
  others: number;
  /** The day it is about. */
  day: number;
  current: boolean;
}

/** A record for a tournament id found on hands but not in the store (made from a backup of hands only, say). */
function stubOf(id: string, own: LoggedHand[]): Tourney {
  const at = own.reduce((m, h) => Math.min(m, h.createdAt), Infinity);
  const t = Number.isFinite(at) ? at : 0;
  return { id, createdAt: t, updatedAt: t, activeAt: t, name: "", memo: "", start: t, startStack: null };
}

/** The record for `id`, or one made from its hands when only hands carry it; null when neither. */
function recordOf(id: string, ts: Tourney[], hands: LoggedHand[]): Tourney | null {
  const t = ts.find((x) => x.id === id);
  if (t) return t;
  const own = allOf(hands, id);
  return own.length ? stubOf(id, own) : null;
}

function groupOf(t: Tourney, own: LoggedHand[], cur: Tourney | null): TourneyGroup {
  const mine = own.filter((h) => !isOther(h)).sort(byNewest);
  return { kind: "tourney", key: t.id, t, hands: mine, others: own.length - mine.length, day: tourneyDay(t, own), current: cur?.id === t.id };
}

/** My 빠른 기록 hands logged before tournaments, split where 6 hours pass between two, newest first. */
function legacyGroups(hands: LoggedHand[]): TourneyGroup[] {
  const old = hands.filter((h) => h.fast === true && !h.tourney && !isOther(h)).sort(byNewest);
  const out: TourneyGroup[] = [];
  let run: LoggedHand[] = [];
  const close = () => {
    if (run.length) out.push({ kind: "legacy", key: String(run[0].createdAt), t: null, hands: run, others: 0, day: run[run.length - 1].createdAt, current: false });
    run = [];
  };
  for (const h of old) {
    if (run.length && run[run.length - 1].createdAt - h.createdAt > SESSION_GAP_MS) close();
    run.push(h);
  }
  close();
  return out;
}

/**
 * The tournaments (the current one first, then by day, newest first; one made by a hand on its own that has
 * no hands left and isn't current is left out) and the groups of hands logged before tournaments.
 */
export function tourneyGroups(ts: Tourney[], hands: LoggedHand[], now: number): { tourneys: TourneyGroup[]; legacy: TourneyGroup[] } {
  const cur = currentTourney(ts, hands, now);
  const byT = new Map<string, LoggedHand[]>();
  for (const h of hands) {
    if (h.fast !== true || !h.tourney) continue;
    const list = byT.get(h.tourney);
    if (list) list.push(h);
    else byT.set(h.tourney, [h]);
  }
  const known = new Set(ts.map((t) => t.id));
  const recs = [...ts, ...[...byT.entries()].filter(([id]) => !known.has(id)).map(([id, own]) => stubOf(id, own))];
  const tourneys = recs
    .map((t) => groupOf(t, byT.get(t.id) ?? [], cur))
    .filter((g) => g.current || !(g.t?.auto && g.hands.length === 0 && g.others === 0))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.day - a.day || (b.t?.createdAt ?? 0) - (a.t?.createdAt ?? 0));
  return { tourneys, legacy: legacyGroups(hands) };
}

/**
 * A legacy group by its key: the newest hand's time (with that hand deleted, the group whose newest hand is
 * under SESSION_GAP_MS before it: the same group), else any hand's id in it.
 */
function legacyFor(key: string, hands: LoggedHand[]): TourneyGroup | null {
  const gs = legacyGroups(hands);
  if (/^\d{1,16}$/.test(key)) {
    const at = Number(key);
    const g = gs.find((x) => x.hands[0].createdAt === at) ?? gs.find((x) => x.hands[0].createdAt < at && at - x.hands[0].createdAt <= SESSION_GAP_MS);
    if (g) return g;
  }
  return gs.find((g) => g.hands.some((h) => h.id === key)) ?? null;
}

/** One group for a route: a tournament by its id (record or one made from its hands), a legacy group by its key (legacyFor); null when gone. */
export function groupFor(kind: "tourney" | "legacy", key: string, ts: Tourney[], hands: LoggedHand[], now: number): TourneyGroup | null {
  if (kind === "legacy") return legacyFor(key, hands);
  const t = recordOf(key, ts, hands);
  return t ? groupOf(t, allOf(hands, key), currentTourney(ts, hands, now)) : null;
}

/** The chips of a group's hands: Σ net plus the chips 지금 스택 and 칩 업데이트 show beyond them (from the start stack when known); null with no result at all. */
export function groupChips(hands: LoggedHand[], startStack: number | null, checks: readonly StackCheck[] = []): number | null {
  const m = sessionMoney(hands);
  const missed = missedOf(hands, startStack, checks);
  if (!m.withResult && !missed) return null;
  return m.chips + (missed?.chips ?? 0);
}

/** A group's name: the tournament's title, or "11월 7일 (금) 빠른 기록". */
export function groupTitle(g: TourneyGroup, hands: LoggedHand[]): string {
  return g.t ? tourneyTitle(g.t, hands) : `${dateOf(g.day)} 빠른 기록`;
}

/** A group's time: "11월 17일 (월) 19:00 시작", or a legacy group's "21:05~01:10". */
export function groupWhen(g: TourneyGroup, hands: LoggedHand[]): string {
  if (g.t) return `${dateOf(g.day)} ${tourneyWhen(g.t, hands)}`;
  const first = g.hands[g.hands.length - 1];
  const last = g.hands[0];
  return first && last ? `${clockOf(first.createdAt)}~${clockOf(last.createdAt)}` : "";
}

/** The current tournament's hands of the mode's kind, else (none current) today's hands logged before tournaments (sessionOf). */
export function fastSession(cur: Tourney | null, hands: LoggedHand[], now: number, mode: FastMode = "mine"): LoggedHand[] {
  return cur ? tourneyHands(hands, cur.id, mode) : sessionOf(hands.filter((h) => !h.tourney), now, mode);
}

/**
 * My stack before a hand of mine (stackAt), for 스택: a new one at `now` (the current tournament's hands, its
 * start stack and 칩 업데이트; none current: today's hands logged before tournaments), or `edit`, a saved hand
 * being corrected (its own tournament's, else its group from before tournaments, up to its time, itself left out).
 */
export function stackBefore(s: Pick<HandLogState, "hands" | "tourneys">, edit: LoggedHand | null, now: number): StackAt {
  const ts = cleanTourneys(s.tourneys);
  if (edit) {
    const t = edit.tourney ? recordOf(edit.tourney, ts, s.hands) : null;
    const own = edit.tourney ? tourneyHands(s.hands, edit.tourney) : (legacyFor(edit.id, s.hands)?.hands ?? []);
    return stackAt(own, t?.startStack ?? null, t?.checks ?? [], edit.createdAt, edit.id);
  }
  const cur = currentTourney(ts, s.hands, now);
  return stackAt(fastSession(cur, s.hands, now), cur?.startStack ?? null, cur?.checks ?? []);
}

/**
 * The draft's hand as 저장 or an action saves it (withFastResult; null: it waits), with my stack before it
 * for 스택 (stackBefore) read from the store at `now`: a corrected hand's (`edit`) own, else the current
 * tournament's. `before` is returned too, for why a save waits (blockOf).
 */
export function fastResultNow(made: LoggedHand, d: FastDraft, lv: FastLevel, ante: boolean, edit: LoggedHand | null, now: number): { hand: LoggedHand | null; before: number | null } {
  const before = stackBefore(handLogStore.get(), edit, now).chips;
  return { hand: withFastResult(made, d, lv, ante, before), before };
}

/**
 * Every hand of tournament `id` worked out by 스택 (fastStack) worked out again from what is on file before it
 * now, oldest first: what it says is my stack after it (its stack plus its net: 지금 스택 as typed), so when
 * something before it changes (a hand corrected or deleted, a 칩 업데이트 taken off, the start stack set) its
 * result follows, rather than the difference turning up as a hand missed. The stack before it not known: no
 * result, 지금 스택 kept as its stack. Only the hands that change are touched (their updatedAt moved on to
 * `now`); the same state back when none does. Run twice, it changes nothing more.
 */
export function restack(s: HandLogState, id: string | undefined, now: number): HandLogState {
  if (!id) return s;
  const t = recordOf(id, cleanTourneys(s.tourneys), s.hands);
  let own = tourneyHands(s.hands, id);
  const changed = new Map<string, LoggedHand>();
  for (const { id: hid } of oldestFirst(own)) {
    const h = own.find((x) => x.id === hid) as LoggedHand;
    if (h.fastStack !== true || h.stack === null || h.result === "fold") continue;
    const after = h.stack + (h.net ?? 0);
    const before = stackAt(own, t?.startStack ?? null, t?.checks ?? [], h.createdAt, h.id).chips;
    const net = before === null ? null : after - before;
    const stack = before ?? after;
    if (net === h.net && stack === h.stack) continue;
    const next: LoggedHand = { ...h, net, result: net === null ? null : resultOfNet(net), stack, updatedAt: Math.max(now, h.updatedAt) };
    changed.set(h.id, next);
    own = own.map((x) => (x.id === h.id ? next : x));
  }
  return changed.size ? { ...s, hands: s.hands.map((x) => changed.get(x.id) ?? x) } : s;
}

/** ⏳: a 빠른 기록 hand of mine saved with its sign (− 손실 / + 수익) and no chips yet. */
export const isPending = (h: LoggedHand): boolean => h.fast === true && !isOther(h) && (h.result === "win" || h.result === "lose") && h.net === null && h.fastStack !== true;

/** ⏳ hands a known stack can fill: oldest first, what they made together, and the 스택 hand that ends them (if one does). */
export interface SettleSpan {
  pending: LoggedHand[];
  total: number;
  /** A 스택 hand whose own chips aren't known (its stack before is): it takes what the ⏳ hands don't. Null: a 칩 업데이트 ends them. */
  end: LoggedHand | null;
}

/**
 * The newest run of ⏳ hands in tournament `id` that a stack known after them can fill: from the last stack
 * known before them (the start stack, a 칩 업데이트, a hand's stack) to the next one (a 칩 업데이트, or a 스택
 * hand), with every other hand between them known in chips. Null when there is none (no stack known on either
 * side, or a hand between with no chips on file: a blind's fold without a level, a result left out).
 */
export function settleSpan(s: Pick<HandLogState, "hands" | "tourneys">, id: string): SettleSpan | null {
  const t = recordOf(id, cleanTourneys(s.tourneys), s.hands);
  const own = tourneyHands(s.hands, id);
  type Ev = { t: number; k: 0; h: LoggedHand } | { t: number; k: 1; stack: number };
  const evs: Ev[] = [...own.map((h): Ev => ({ t: h.createdAt, k: 0, h })), ...cleanChecks(t?.checks).map((c): Ev => ({ t: c.at, k: 1, stack: c.stack }))].sort((a, b) => a.t - b.t || a.k - b.k);
  const start = t?.startStack ?? null;
  let known: number | null = start !== null && start > 0 ? start : null;
  let sum = 0;
  let pending: LoggedHand[] = [];
  let blocked = false;
  let found: SettleSpan | null = null;
  const close = (stack: number, end: LoggedHand | null) => {
    if (pending.length && known !== null && !blocked) found = { pending, total: stack - known - sum, end };
  };
  const reset = (k: number | null) => {
    known = k;
    sum = 0;
    pending = [];
    blocked = false;
  };
  for (const e of evs) {
    if (e.k === 1) {
      close(e.stack, null);
      reset(e.stack);
      continue;
    }
    const h = e.h;
    if (h.stack !== null) {
      // A 스택 hand with its chips unknown: its stack is the stack after it, and it shares what is left.
      if (h.fastStack === true && h.net === null) close(h.stack, h);
      else close(h.stack, null);
      reset(h.stack + (h.net ?? 0));
    } else if (isPending(h)) pending.push(h);
    else if (h.net === null) blocked = true;
    else sum += h.net;
  }
  return found;
}

/** The ⏳ hands' chips as worked out (`nets`: hand id → chips), in tournament `id`; the 스택 hands after them follow (restack). */
export function settleHands(id: string, nets: ReadonlyMap<string, number>, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  let changed = false;
  const hands = prev.hands.map((h) => {
    const n = nets.get(h.id);
    if (n === undefined || h.tourney !== id || !isPending(h) || !Number.isFinite(n)) return h;
    changed = true;
    return { ...h, net: n, result: resultOfNet(n), updatedAt: Math.max(now, h.updatedAt) };
  });
  if (!changed) return false;
  return write(restack({ ...prev, hands }, id, now), prev);
}

/** restack for each of the tournaments `ids`. */
export const restackAll = (s: HandLogState, ids: Iterable<string | undefined>, now: number): HandLogState => [...new Set(ids)].reduce((x, id) => restack(x, id, now), s);

// ───────────── the sheet's fields ─────────────

export interface TourneyFields {
  name: string;
  /** "HH:MM", or "" (not known). */
  clock: string;
  /** Digits, or "" (not known). */
  stack: string;
  memo: string;
  /** The blind structure: "pub" (or absent) = 야자수 새틀, "custom" = 직접 입력, or a ready-made one (structures.ts: "wpl1" …). */
  structure?: "pub" | "custom" | PresetId;
  /** 직접 입력's starting / current blinds; null or absent: not set. */
  blinds?: Blinds | null;
  /** A ready-made structure's start level (DAY2, DAY3); null or absent: its own. */
  startLevel?: number | null;
}

/** The ready-made structure the sheet's fields pick, or null (야자수 새틀, 직접 입력). */
export const fieldsPreset = (f: Pick<TourneyFields, "structure">): StructurePreset | null => presetById(f.structure);

/** How far before and after now the last start time used is offered for a new tournament: one running, or one about to begin. */
const OFFER_BEFORE_MS = 6 * 60 * 60 * 1000;
const OFFER_AFTER_MS = 2 * 60 * 60 * 1000;

/** The clock of the start set last (a day's start, or a 야자수 새틀 / 직접 입력 tournament's: a WPL day's fixed start isn't the pub's), or null. */
function lastStartClock(s: HandLogState): string | null {
  const day = startMsOf(cleanStartClock(s.startClock));
  const t = cleanTourneys(s.tourneys)
    .filter((x) => x.startSet && !presetOf(x))
    .reduce<number | null>((m, x) => (m === null || x.start > m ? x.start : m), null);
  const last = day === null ? t : t === null ? day : Math.max(day, t);
  return last === null ? null : clockOf(last);
}

/**
 * A new tournament's fields: no name; the day's start time when one covers now, else the start time used
 * last when today's falls from 6 hours ago to 2 hours ahead (set up mid-tournament, the blinds stay right),
 * else now; the pub's starting stack; no memo.
 */
export function newFields(now: number, s: HandLogState = handLogStore.get()): TourneyFields {
  const day = startMsOf(startFor(now, s) ?? undefined);
  const last = day === null ? lastStartClock(s) : null;
  const ms = last !== null ? startMsFor(last, now) : null;
  const offer = day ?? (ms !== null && ms >= now - OFFER_BEFORE_MS && ms <= now + OFFER_AFTER_MS ? ms : now);
  return { name: "", clock: clockOf(offer), stack: String(PUB_START_STACK), memo: "", structure: "pub", blinds: null };
}

/**
 * The start the sheet's 시작 시간 means: read near `ref` (startMsFor); for a new tournament (`fresh`) of a ready-made
 * structure, the next of its fixed starts that can still be joined (presetStartMs: made the night before, the next
 * morning's). Null for a clock that can't be read.
 */
export function sheetStartMs(clock: string, ref: number, f?: Pick<TourneyFields, "structure">, fresh = false): number | null {
  const p = f ? fieldsPreset(f) : null;
  return p && fresh ? presetStartMs(p, clock, ref) : startMsFor(clock, ref);
}

/**
 * What the sheet's 시작 시간 (read near `ref`, sheetStartMs) gives at `now`, shown under it as it is typed: "지금 Lv3
 * 200/400", "지금 휴식 (Lv3 200/400)", "시작 전 · 25분 뒤", "지금 구조표 끝 (Lv…)"; null for an empty or
 * unreadable clock, or a start that doesn't cover `now` (another day's tournament). `f`: a ready-made
 * structure picked (and its start level): its table, "지금 L2 100/200", and a start on a later day by its date
 * ("11월 21일 (토) 시작 · 12시간 뒤"), so a day set up the night before shows which day it is.
 */
export function startLevelText(clock: string, ref: number, now: number, f?: Pick<TourneyFields, "structure" | "startLevel">, fresh = false): string | null {
  if (!clock.trim()) return null;
  const p = f ? fieldsPreset(f) : null;
  const start = sheetStartMs(clock, ref, f, fresh);
  if (start === null) return null;
  const sl = f?.startLevel ?? undefined;
  if (p && start > now) {
    const left = durationText(Math.ceil((start - now) / MIN_MS));
    return localDay(start) !== localDay(now) ? `${dateOf(start)} 시작 · ${left} 뒤` : `시작 전 · ${left} 뒤`;
  }
  if (p ? !presetCovers(p, sl, start, now) : !startCovers(start, now)) return null;
  const e = p ? levelAt(start, now, presetFrom(p, sl), p.breaks) : levelAt(start, now);
  const chip = (lv: number | null) => (p ? levelChip(presetBlinds(p, lv)) : levelChip(lv));
  if (e.phase === "before") return `시작 전 · ${durationText(e.minutesLeft)} 뒤`;
  if (e.phase === "break") return `지금 휴식 (${chip(e.level)})`;
  if (e.phase === "after") return `지금 구조표 끝 (${chip(e.level)})`;
  return `지금 ${chip(e.level)}`;
}

/**
 * The sheet's line under 시작 시간 for tournament `t` (null: a new one, its clock read near now): what the
 * clock gives now (startLevelText, by the structure the fields `f` pick), or, for a tournament of another day,
 * the day it counts for ("11월 16일 (월) 시작 기준"); null for an empty clock.
 */
export function sheetLevelText(clock: string, t: Tourney | null, hands: LoggedHand[], now: number, f?: Pick<TourneyFields, "structure" | "startLevel">): string | null {
  const ref = t ? tourneyRef(t, hands) : now;
  const lv = startLevelText(clock, ref, now, f, !t);
  if (lv || !t || !clock.trim()) return lv;
  const start = startMsFor(clock, ref);
  return start !== null ? `${dateOf(start)} 시작 기준` : null;
}

/** The moment a tournament's start time is read near: its start when set, else its first hand, else when it was made. */
export function tourneyRef(t: Tourney, hands: LoggedHand[]): number {
  return t.startSet ? t.start : (firstHandAt(hands, t.id) ?? t.createdAt);
}

/** It is on `now`'s day: its start (else its first hand, else when it was made) covers `now`. False for one resumed on a later day. */
export function onTourneyDay(t: Tourney, hands: LoggedHand[], now: number): boolean {
  return startCovers(tourneyRef(t, hands), now);
}

/** The edit sheet's line on what its 시작 시간 does: for the current one on its day, the estimate of hands to come; resumed on a later day, its first day only. */
export function startNote(t: Tourney, hands: LoggedHand[], current: boolean, now: number): string {
  if (!current) return "저장된 핸드의 레벨은 그대로예요.";
  // A ready-made structure's day: still to come (set up ahead), or running by its table (DAY3 past 03:00 too).
  const p = presetOf(t);
  if (p && t.startSet ? now < t.start || presetCovers(p, t.startLevel, t.start, now) : onTourneyDay(t, hands, now)) return "시작 시간을 바꾸면 앞으로 적는 핸드의 레벨 추정이 바뀌어요 (저장된 핸드는 그대로).";
  return `${dateOf(tourneyRef(t, hands))}에 시작한 토너먼트라 시작 시간은 그날 기준이에요 · 오늘 레벨은 레벨 칩에서 골라 주세요.`;
}

/** A tournament's fields as on file (no clock without a start set, no stack when it isn't known). */
export function fieldsOf(t: Tourney): TourneyFields {
  const p = presetOf(t);
  return {
    name: t.name,
    clock: t.startSet ? clockOf(t.start) : "",
    stack: t.startStack !== null ? String(t.startStack) : "",
    memo: t.memo,
    structure: p ? p.id : isCustom(t) ? "custom" : "pub",
    blinds: isCustom(t) ? (t.blinds ?? null) : null,
    ...(p?.pickStart ? { startLevel: presetStart(p, t.startLevel) } : {}),
  };
}

/**
 * The current tournament's fields for 빠른 기록's sheet: as on file, with the pub's 50,000 offered as a value
 * when its start stack isn't known (야자수 새틀 only: the sheet shows "= 50,000칩"; cleared, it stays unknown); for one
 * started by a hand on its own, on its day, the start its estimate `est` runs on (the day's).
 */
export function currentFields(t: Tourney, est: LevelEstimate | null, onDay: boolean): TourneyFields {
  const f = fieldsOf(t);
  return { ...f, ...(t.startStack === null && f.structure === "pub" ? { stack: String(PUB_START_STACK) } : {}), ...(t.auto && onDay && est?.startClock ? { clock: est.startClock } : {}) };
}

/**
 * Why the fields can't be saved, or null: "clock" (can't be read as a time; 야자수 새틀 and ready-made structures), "stack"
 * (not 1 to 9 digits, or 0), "blinds" (직접 입력 with blinds that aren't valid). Empty ones are fine (not known).
 */
export function fieldsBlock(f: TourneyFields): "clock" | "stack" | "blinds" | null {
  if (f.structure !== "custom" && f.clock.trim() && !parseClock(f.clock)) return "clock";
  const st = f.stack.trim();
  if (st && (!/^\d{1,9}$/.test(st) || Number(st) === 0)) return "stack";
  if (f.structure === "custom" && f.blinds != null && !cleanBlinds(f.blinds)) return "blinds";
  return null;
}

/** The start a clock means near `ref`: the yesterday, today or tomorrow whose window holds `ref` (startClockFor). Null for a clock that can't be read. */
export function startMsFor(clock: string, ref: number): number | null {
  const sc = startClockFor(clock, ref);
  return sc ? startMsOf(sc) : null;
}

/** What the sheet's fields give a record's structure: 직접 입력 (its blinds), a ready-made one (its start level), or neither (야자수 새틀). */
interface StructureFields {
  custom: boolean;
  blinds: Blinds | null;
  preset: StructurePreset | null;
  startLevel: number | null;
}

/** The record's fields from the sheet, its start read near `ref` (sheetStartMs; `fresh`: a new tournament; 직접 입력: none); null when they can't be saved. */
function fromFields(f: TourneyFields, ref: number, fresh = false): (Pick<Tourney, "name" | "memo" | "startStack"> & { start: number | null } & StructureFields) | null {
  if (fieldsBlock(f)) return null;
  const st = f.stack.trim();
  const custom = f.structure === "custom";
  const preset = fieldsPreset(f);
  const blinds = custom ? cleanBlinds(f.blinds) : null;
  return {
    name: f.name.trim().slice(0, TOURNEY_NAME_MAX).trim(),
    memo: f.memo.slice(0, TOURNEY_MEMO_MAX),
    start: !custom && f.clock.trim() ? sheetStartMs(f.clock, ref, f, fresh) : null,
    startStack: st ? Number(st) : null,
    custom,
    blinds: blinds ? plainBlinds(blinds) : null,
    preset,
    startLevel: preset?.pickStart ? presetStart(preset, f.startLevel) : null,
  };
}

/**
 * A record's structure fields: 직접 입력 with its blinds when set; a ready-made one as 직접 입력 (for an older app) at its
 * start level's blinds, with its id and start level; else nothing (야자수 새틀).
 */
function structureOf(v: StructureFields): Pick<Tourney, "structure" | "blinds" | "preset" | "startLevel"> {
  if (v.preset) {
    const b = presetBlinds(v.preset, presetStart(v.preset, v.startLevel));
    return { structure: "custom", ...(b ? { blinds: plainBlinds(b) } : {}), preset: v.preset.id, ...(v.startLevel !== null ? { startLevel: v.startLevel } : {}) };
  }
  return v.custom ? { structure: "custom", ...(v.blinds ? { blinds: v.blinds } : {}) } : {};
}

// ───────────── store actions (one write each; a refused write leaves the store as it was) ─────────────

function write(next: HandLogState, prev: HandLogState): boolean {
  const ok = handLogStore.set(next);
  if (!ok) handLogStore.set(prev);
  return ok;
}

/**
 * A new tournament from the sheet; it becomes the current one (a level picked while none was current goes
 * with it, unless it has a ready-made structure: that runs on its own clock). A clock left empty: no start set.
 * 직접 입력: its structure and blinds, no start set (no estimate). A ready-made structure (WPL): stored as 직접 입력
 * at its start level's blinds (for an older app) with its id and start level; its start from the clock, the next
 * day's once that day can no longer be joined (presetStartMs: DAY1 set up the evening before is the next morning's).
 * `join`: today's running hands from before tournaments (runningUntagged) go to it, in the same write.
 * Returns its id, or null.
 */
export function startTourney(f: TourneyFields, now: number = Date.now(), join = false): string | null {
  const v = fromFields(f, now, true);
  if (!v) return null;
  const prev = handLogStore.get();
  const t: Tourney = {
    id: newTourneyId(now),
    createdAt: now,
    updatedAt: now,
    activeAt: now,
    name: v.name,
    memo: v.memo,
    start: v.start ?? now,
    ...(v.start !== null ? { startSet: true as const } : {}),
    startStack: v.startStack,
    ...structureOf(v),
  };
  const ids = new Set(join ? runningUntagged(prev.hands, now).map((h) => h.id) : []);
  if (!write(tagHands(withTourney(prev, t), ids, t.id, now), prev)) return null;
  // A ready-made structure's level runs on its own clock: a level picked before it (in 야자수 새틀's numbers) isn't its.
  if (!presetOf(t)) stampStoredPick(t.id, now);
  return t.id;
}

/**
 * The sheet's edits to tournament `id` (a stub made from its hands is stored by it). The clock is read near
 * its own start (else its first hand, else when it was made), so an old tournament keeps its date. It is no
 * longer `auto`; whether it is current doesn't change. Switched to 직접 입력: its structure and blinds, its
 * start kept as it was (only shown); back to 야자수 새틀: both dropped, the clock applies to new hands again. To a
 * ready-made structure (WPL): its preset and start level, the clock read as for 야자수 새틀, by its table. A level
 * picked in it goes when the table or the start level changes. Saved hands keep their own level or blinds either way.
 */
export function editTourney(id: string, f: TourneyFields, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const t = recordOf(id, cleanTourneys(prev.tourneys), prev.hands);
  if (!t) return false;
  const v = fromFields(f, tourneyRef(t, prev.hands));
  if (!v) return false;
  const { auto: _a, startSet: _s, structure: _st, blinds: _b, preset: _p, startLevel: _l, ...rest } = t;
  void _a;
  void _s;
  void _st;
  void _b;
  void _p;
  void _l;
  // 직접 입력 has no clock: its start stays as it was.
  const start = v.custom ? { start: t.start, ...(t.startSet ? { startSet: true as const } : {}) } : { start: v.start ?? t.start, ...(v.start !== null ? { startSet: true as const } : {}) };
  // A ready-made structure kept with its start level: its blinds stay the blinds of now (its last hand's, for an older app).
  const same = !!v.preset && presetOf(t)?.id === v.preset.id && (t.startLevel ?? null) === v.startLevel && !!t.blinds;
  const next: Tourney = { ...rest, name: v.name, memo: v.memo, ...start, startStack: v.startStack, ...structureOf(v), ...(same ? { blinds: t.blinds } : {}), updatedAt: now };
  // A start stack set or changed: the hands by 스택 work from it.
  if (!write(restack(withTourney(prev, next), id, now), prev)) return false;
  // Another table (야자수 새틀 ↔ a ready-made one, or another day): a level picked in it would be read in the new one's
  // numbers; another start level for the day: the clock from it is what was said last.
  if (presetOf(t)?.id !== v.preset?.id || (t.startLevel ?? null) !== v.startLevel) dropStoredPick(id);
  return true;
}

/**
 * 직접 입력: the blinds of tournament `id` from now on (new hands; saved ones keep theirs), in one write (a stub
 * made from its hands is stored by it). False for blinds that aren't valid, a tournament that isn't 직접 입력,
 * or a refused write (the store left as it was).
 */
export function setTourneyBlinds(id: string, b: Blinds, now: number = Date.now()): boolean {
  const clean = cleanBlinds(b);
  if (!clean) return false;
  const blinds = plainBlinds(clean);
  const prev = handLogStore.get();
  const t = recordOf(id, cleanTourneys(prev.tourneys), prev.hands);
  if (!t || !isCustom(t)) return false;
  return write(withTourney(prev, { ...t, blinds, updatedAt: Math.max(now, t.updatedAt) }), prev);
}

/**
 * 이어 적기: tournament `id` becomes the current one again (a stub made from its hands is stored by it; a
 * level picked while none was current goes with it).
 */
export function resumeTourney(id: string, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const t = recordOf(id, cleanTourneys(prev.tourneys), prev.hands);
  if (!t || !write(withTourney(prev, { ...t, activeAt: now, updatedAt: now }), prev)) return false;
  if (!presetOf(t)) stampStoredPick(id, now);
  return true;
}

/** Deletes tournament `id`: only one no hand carries (mine or other players'); false otherwise. */
export function deleteTourney(id: string): boolean {
  const prev = handLogStore.get();
  if (prev.hands.some((h) => h.tourney === id) || !cleanTourneys(prev.tourneys).some((t) => t.id === id)) return false;
  return write(withoutTourney(prev, id), prev);
}

/** Deletes tournament `id` with every hand in it (mine and other players'). False when there was nothing to delete. */
export function deleteTourneyAll(id: string): boolean {
  const ids = handLogStore.get().hands.filter((h) => h.tourney === id).map((h) => h.id);
  if (!ids.length) return deleteTourney(id);
  return deleteHands(ids, (s) => withoutTourney(s, id)) !== null;
}

/**
 * 칩 업데이트: my stack counted at `now`, on tournament `id` (a stub made from its hands is stored by it). A
 * 칩 업데이트 with no hand of mine logged in it since (a count typed again: a typo, a rebuy just after) is put
 * right in place rather than added. False for a stack that isn't 0 … 999,999,999 chips, or a refused write.
 */
export function checkStack(id: string, stack: number, now: number = Date.now()): boolean {
  if (!isStackChips(stack)) return false;
  const prev = handLogStore.get();
  const t = recordOf(id, cleanTourneys(prev.tourneys), prev.hands);
  if (!t) return false;
  const was = cleanChecks(t.checks);
  const last = was[was.length - 1];
  const redo = !!last && !tourneyHands(prev.hands, id).some((h) => h.createdAt > last.at);
  const checks = cleanChecks([...(redo ? was.slice(0, -1) : was), { at: Math.max(now, last?.at ?? -Infinity), stack }]);
  return write(restack(withTourney(prev, { ...t, checks, updatedAt: Math.max(now, t.updatedAt) }), id, now), prev);
}

/** The 칩 업데이트 of tournament `id` made at `at` taken off. False when there is none such, or the write was refused. */
export function removeCheck(id: string, at: number, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const t = cleanTourneys(prev.tourneys).find((x) => x.id === id);
  const was = cleanChecks(t?.checks);
  if (!t || !was.some((c) => c.at === at)) return false;
  const { checks: _c, ...rest } = t;
  void _c;
  const left = was.filter((c) => c.at !== at);
  // The hands by 스택 after it work from what is on file without it.
  return write(restack(withTourney(prev, { ...rest, ...(left.length ? { checks: left } : {}), updatedAt: Math.max(now, t.updatedAt) }), id, now), prev);
}

/** The 칩 업데이트 that could be put right in place (checkStack): the last one, when no hand of mine has been logged in tournament `t` since. */
export function openCheck(t: Tourney, hands: LoggedHand[]): StackCheck | null {
  const last = t.checks?.[t.checks.length - 1];
  return last && !tourneyHands(hands, t.id).some((h) => h.createdAt > last.at) ? last : null;
}

/**
 * What a 칩 업데이트 on tournament `t` now is measured against: the app's count (stackAt: its start stack or the
 * last stack on file, plus every result since), the 칩 업데이트 it would put right in place (openCheck) left out.
 */
export function countFor(t: Tourney, hands: LoggedHand[]): StackAt {
  const open = openCheck(t, hands);
  return stackAt(tourneyHands(hands, t.id), t.startStack, (t.checks ?? []).filter((c) => c !== open));
}

/** The tournament started or resumed last before `id`, among the others (any age), by `now` (default: whenever), or null. */
export function previousTourney(ts: Tourney[], id: string, now = Infinity): Tourney | null {
  return latest(ts.filter((t) => t.id !== id), now);
}

/**
 * What "새 토너먼트 취소" goes back to for tournament `t`: the one that was current when `t` was started
 * (still in use within TOURNEY_IDLE_MS then), when `t` was never resumed since; else null (deleting `t`
 * leaves none current: yesterday's tournament is never brought back by it).
 */
export function cancelTarget(t: Tourney, ts: Tourney[], hands: LoggedHand[]): Tourney | null {
  if (t.activeAt !== t.createdAt) return null;
  const back = previousTourney(ts, t.id, t.createdAt);
  return back && t.createdAt - lastActivity(back, hands) <= TOURNEY_IDLE_MS ? back : null;
}

/**
 * "새 토너먼트 취소 / 지우기": tournament `id` has no hands: it goes, and the one that was current when it
 * was started (cancelTarget) is current again, in one write; with none such, it only goes.
 */
export function cancelNewTourney(id: string, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const ts = cleanTourneys(prev.tourneys);
  const t = ts.find((x) => x.id === id);
  if (!t || prev.hands.some((h) => h.tourney === id)) return false;
  const back = cancelTarget(t, ts, prev.hands);
  const gone = withoutTourney(prev, id);
  return write(back ? withTourney(gone, { ...back, activeAt: now, updatedAt: now }) : gone, prev);
}

/**
 * The level picker's 시작 시각 on 빠른 기록, typed at `at`: the current tournament's start, when its start
 * covers `at` or, with none set, the new start covers its first hand (the day's start is set too, as the
 * picker always did, for the table flow); otherwise (none current, or one resumed on a later day) the day's
 * start only, so a tournament from another day keeps its day. Returns the estimate after it (fastEstimate),
 * or false when the clock can't be read or storage refused it.
 */
export function setFastStartClock(clock: string, at: number): LevelEstimate | null | false {
  const prev = handLogStore.get();
  const cur = currentTourney(cleanTourneys(prev.tourneys), prev.hands, at);
  const start = startMsFor(clock, at);
  const p = presetOf(cur);
  if (cur && p) {
    // A ready-made structure's day: its own start only (the day's start is 야자수 새틀's, for the table flow), read near
    // the start it has (a day set up the night before stays the next day's; late in the day it stays that day's).
    const start = cur.startSet ? startMsFor(clock, cur.start) : presetStartMs(p, clock, at);
    if (start === null) return false;
    const { auto: _a, ...rest } = cur;
    void _a;
    if (!write(withTourney(prev, { ...rest, start, startSet: true, updatedAt: at }), prev)) return false;
    return fastEstimate(at);
  }
  if (cur && start !== null && (cur.startSet ? startCovers(cur.start, at) : startCovers(start, tourneyRef(cur, prev.hands)))) {
    const { auto: _a, ...rest } = cur;
    void _a;
    if (!write(withTourney(prev, { ...rest, start, startSet: true, updatedAt: at }), prev)) return false;
    setTodayStart(clock, at);
  } else if (!setTodayStart(clock, at)) return false;
  return fastEstimate(at);
}

/** A hand tapped on a tournament's screen: still just a 빠른 기록 of mine, it opens in 빠른 기록's editor; anything else in the table flow. */
export function openHand(h: LoggedHand, go: Go): void {
  if (fastOnly(h) && !isOther(h)) {
    fastStore.set(startEdit(cleanFastState(fastStore.get()), h));
    go("log/fast");
  } else go(handRoute(h));
}
