import type { Go } from "../../backNav";
import { missedOf, sessionMoney } from "./fastChips";
import { cleanFastState, fastStore, SESSION_GAP_MS, SESSION_IDLE_MS, sessionOf, startEdit, type FastMode, type FastState, type SessionInfo } from "./fastLog";
import {
  fastOnly,
  handLogStore,
  handRoute,
  isOther,
  levelEstimateAt,
  setTodayStart,
  START_LEAD_MS,
  START_SPAN_MS,
  startClockFor,
  startFor,
  startMsOf,
  type HandLogState,
  type LoggedHand,
} from "./handLog";
import { levelAt, parseClock, type LevelEstimate } from "./levelClock";
import { cleanTourneys, TOURNEY_MEMO_MAX, TOURNEY_NAME_MAX, withoutTourney, withTourney, type Tourney } from "./tourney";

/**
 * 빠른 기록's tournaments: which one is current, the hands of each, the level clock its start gives, the
 * groups the 토너먼트 기록 screens list, and the store actions behind the sheet and the buttons.
 *
 * The current tournament is the one started or resumed (이어 적기) last, while it is live: it had a hand, a
 * start or a resume within TOURNEY_IDLE_MS. Every new 빠른 기록 hand (mine and other players') goes to it
 * with no tap of its own; with none current, the hand starts one on its own (autoTourney), on file in the
 * same write as the hand. Nothing stores which one is current, so nothing can point at a record that is gone.
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

/** When it was last used: its start or resume, or its newest hand. */
export function lastActivity(t: Tourney, hands: LoggedHand[]): number {
  return Math.max(t.activeAt, lastHandAt(hands, t.id) ?? -Infinity);
}

/** The one started or resumed last (a tie: the one made later). */
function latest(ts: Tourney[]): Tourney | null {
  return ts.reduce<Tourney | null>((b, t) => (!b || t.activeAt > b.activeAt || (t.activeAt === b.activeAt && t.createdAt >= b.createdAt) ? t : b), null);
}

/** The current tournament at `now`: the one started or resumed last, if it was used within TOURNEY_IDLE_MS; else null. */
export function currentTourney(ts: Tourney[], hands: LoggedHand[], now: number): Tourney | null {
  const t = latest(ts);
  return t && now - lastActivity(t, hands) <= TOURNEY_IDLE_MS ? t : null;
}

/** A start covers the moments from 10 hours before it to 14 hours after (the same window as a day's start time). */
export const startCovers = (start: number, at: number): boolean => at >= start - START_LEAD_MS && at < start + START_SPAN_MS;

/**
 * The level at `at` by the tournament's start, when it has one set and it covers `at`; else `fallback` (the
 * day's start time's estimate). So a tournament resumed on a later day never gives blinds from days ago:
 * there the day's start counts, else none (레벨 ?).
 */
export function tourneyEstimate(t: Tourney | null, at: number, fallback: LevelEstimate | null): LevelEstimate | null {
  if (t?.startSet && startCovers(t.start, at)) return { ...levelAt(t.start, at), startClock: clockOf(t.start) };
  return fallback;
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

/** A level picked before the tournament existed now belongs to it (the same state back when nothing changes). */
export function stampPick(s: FastState, id: string): FastState {
  return s.levelPick && !s.levelPick.t ? { ...s, levelPick: { ...s.levelPick, t: id } } : s;
}

/** The same on 빠른 기록's stored editor (a tournament started from 남의 핸드: the level pick lives there). */
export function stampStoredPick(id: string): void {
  const raw = fastStore.get();
  const p = raw.levelPick;
  if (p && typeof p === "object" && !p.t) fastStore.set({ ...raw, levelPick: { ...p, t: id } });
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

/** The tournament's lines for the copy text (sessionText). */
export function infoOf(t: Tourney, hands: LoggedHand[]): SessionInfo {
  return { title: tourneyTitle(t, hands), when: `${dateOf(tourneyDay(t, hands))} ${tourneyWhen(t, hands)}`, startStack: t.startStack, memo: t.memo };
}

// ───────────── the groups the 토너먼트 기록 screens list ─────────────

export interface TourneyGroup {
  kind: "tourney" | "legacy";
  /** The tournament's id, or a legacy group's newest hand id (its route key). */
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
    if (run.length) out.push({ kind: "legacy", key: run[0].id, t: null, hands: run, others: 0, day: run[run.length - 1].createdAt, current: false });
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

/** One group for a route: a tournament by its id (record or one made from its hands), a legacy group by any hand in it; null when gone. */
export function groupFor(kind: "tourney" | "legacy", key: string, ts: Tourney[], hands: LoggedHand[], now: number): TourneyGroup | null {
  if (kind === "legacy") return legacyGroups(hands).find((g) => g.hands.some((h) => h.id === key)) ?? null;
  const t = recordOf(key, ts, hands);
  return t ? groupOf(t, allOf(hands, key), currentTourney(ts, hands, now)) : null;
}

/** The chips of a group's hands: Σ net plus the chips 지금 스택 shows beyond them (from the start stack when known); null with no result at all. */
export function groupChips(hands: LoggedHand[], startStack: number | null): number | null {
  const m = sessionMoney(hands);
  const missed = missedOf(hands, startStack);
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

// ───────────── the sheet's fields ─────────────

export interface TourneyFields {
  name: string;
  /** "HH:MM", or "" (not known). */
  clock: string;
  /** Digits, or "" (not known). */
  stack: string;
  memo: string;
}

/** A new tournament's fields: no name, the day's start time when one covers now (else now), the pub's starting stack, no memo. */
export function newFields(now: number, s: HandLogState = handLogStore.get()): TourneyFields {
  const ms = startMsOf(startFor(now, s) ?? undefined);
  return { name: "", clock: clockOf(ms ?? now), stack: String(PUB_START_STACK), memo: "" };
}

/** A tournament's fields as on file (no clock without a start set, no stack when it isn't known). */
export function fieldsOf(t: Tourney): TourneyFields {
  return { name: t.name, clock: t.startSet ? clockOf(t.start) : "", stack: t.startStack !== null ? String(t.startStack) : "", memo: t.memo };
}

/** Why the fields can't be saved, or null: "clock" (can't be read as a time), "stack" (not 1 to 9 digits, or 0). Empty ones are fine (not known). */
export function fieldsBlock(f: TourneyFields): "clock" | "stack" | null {
  if (f.clock.trim() && !parseClock(f.clock)) return "clock";
  const st = f.stack.trim();
  if (st && (!/^\d{1,9}$/.test(st) || Number(st) === 0)) return "stack";
  return null;
}

/** The start a clock means near `ref`: the yesterday, today or tomorrow whose window holds `ref` (startClockFor). Null for a clock that can't be read. */
export function startMsFor(clock: string, ref: number): number | null {
  const sc = startClockFor(clock, ref);
  return sc ? startMsOf(sc) : null;
}

/** The record's fields from the sheet, its start read near `ref`; null when they can't be saved. */
function fromFields(f: TourneyFields, ref: number): Pick<Tourney, "name" | "memo" | "startStack"> & { start: number | null } | null {
  if (fieldsBlock(f)) return null;
  const st = f.stack.trim();
  return {
    name: f.name.trim().slice(0, TOURNEY_NAME_MAX).trim(),
    memo: f.memo.slice(0, TOURNEY_MEMO_MAX),
    start: f.clock.trim() ? startMsFor(f.clock, ref) : null,
    startStack: st ? Number(st) : null,
  };
}

// ───────────── store actions (one write each; a refused write leaves the store as it was) ─────────────

function write(next: HandLogState, prev: HandLogState): boolean {
  const ok = handLogStore.set(next);
  if (!ok) handLogStore.set(prev);
  return ok;
}

/** A new tournament from the sheet; it becomes the current one. A clock left empty: no start set. Returns its id, or null. */
export function startTourney(f: TourneyFields, now: number = Date.now()): string | null {
  const v = fromFields(f, now);
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
  };
  return write(withTourney(prev, t), prev) ? t.id : null;
}

/**
 * The sheet's edits to tournament `id` (a stub made from its hands is stored by it). The clock is read near
 * its own start (else its first hand, else when it was made), so an old tournament keeps its date. It is no
 * longer `auto`; whether it is current doesn't change.
 */
export function editTourney(id: string, f: TourneyFields, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const t = recordOf(id, cleanTourneys(prev.tourneys), prev.hands);
  if (!t) return false;
  const v = fromFields(f, t.startSet ? t.start : (firstHandAt(prev.hands, id) ?? t.createdAt));
  if (!v) return false;
  const { auto: _a, startSet: _s, ...rest } = t;
  void _a;
  void _s;
  const next: Tourney = { ...rest, name: v.name, memo: v.memo, start: v.start ?? t.start, ...(v.start !== null ? { startSet: true as const } : {}), startStack: v.startStack, updatedAt: now };
  return write(withTourney(prev, next), prev);
}

/** 이어 적기: tournament `id` becomes the current one again (a stub made from its hands is stored by it). */
export function resumeTourney(id: string, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const t = recordOf(id, cleanTourneys(prev.tourneys), prev.hands);
  if (!t) return false;
  return write(withTourney(prev, { ...t, activeAt: now, updatedAt: now }), prev);
}

/** Deletes tournament `id`: only one no hand carries (mine or other players'); false otherwise. */
export function deleteTourney(id: string): boolean {
  const prev = handLogStore.get();
  if (prev.hands.some((h) => h.tourney === id) || !cleanTourneys(prev.tourneys).some((t) => t.id === id)) return false;
  return write(withoutTourney(prev, id), prev);
}

/** The tournament that was current before `id`: the one started or resumed last among the others (any age), or null. */
export function previousTourney(ts: Tourney[], id: string): Tourney | null {
  return latest(ts.filter((t) => t.id !== id));
}

/** "새 토너먼트 취소": tournament `id` has no hands: it goes, and the one before it is current again, in one write. */
export function cancelNewTourney(id: string, now: number = Date.now()): boolean {
  const prev = handLogStore.get();
  const ts = cleanTourneys(prev.tourneys);
  if (prev.hands.some((h) => h.tourney === id) || !ts.some((t) => t.id === id)) return false;
  const back = previousTourney(ts, id);
  const gone = withoutTourney(prev, id);
  return write(back ? withTourney(gone, { ...back, activeAt: now, updatedAt: now }) : gone, prev);
}

/**
 * The level picker's 시작 시각 on 빠른 기록, typed at `at`: the current tournament's start, when it has none
 * set or its start covers `at` (the day's start is set too, as the picker always did, for the table flow);
 * otherwise (none current, or one resumed on a later day) the day's start only. Returns the estimate after
 * it (fastEstimate), or false when the clock can't be read or storage refused it.
 */
export function setFastStartClock(clock: string, at: number): LevelEstimate | null | false {
  const prev = handLogStore.get();
  const cur = currentTourney(cleanTourneys(prev.tourneys), prev.hands, at);
  if (cur && (!cur.startSet || startCovers(cur.start, at))) {
    const start = startMsFor(clock, at);
    if (start === null) return false;
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
