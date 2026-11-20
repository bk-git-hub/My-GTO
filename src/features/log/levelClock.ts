/**
 * Level clock: the player forgot the blind level, so estimate it from the tournament's start time and
 * the time of the hand. Pure: every function takes the times it needs (no Date.now inside).
 */

export interface LevelRow {
  level: number;
  sb: number;
  bb: number;
  /** BB ante: the big blind posts this much on top of the blind. */
  ante: number;
  minutes: number;
}

export interface BreakRow {
  afterLevel: number;
  minutes: number;
  /** What else happens in it, as the structure sheet says ("추가등록 마감", "100 칩 레이스"); the level picker's line shows it while the break is on. */
  note?: string;
}

/**
 * The pub tournament's blind structure, copied row by row from docs/game-profile.md (블라인드 구조).
 * 20-minute levels through Lv14 (re-entry closes at the end of Lv14), 12-minute levels from Lv15.
 * Every row in the doc gives a duration; for a schedule row without one (minutes missing or not
 * positive) the clock reuses the previous level's duration.
 */
export const PUB_SCHEDULE: LevelRow[] = [
  { level: 1, sb: 100, bb: 200, ante: 200, minutes: 20 },
  { level: 2, sb: 200, bb: 300, ante: 300, minutes: 20 },
  { level: 3, sb: 200, bb: 400, ante: 400, minutes: 20 },
  { level: 4, sb: 300, bb: 500, ante: 500, minutes: 20 },
  { level: 5, sb: 300, bb: 600, ante: 600, minutes: 20 },
  { level: 6, sb: 400, bb: 800, ante: 800, minutes: 20 },
  { level: 7, sb: 500, bb: 1000, ante: 1000, minutes: 20 },
  { level: 8, sb: 600, bb: 1200, ante: 1200, minutes: 20 },
  { level: 9, sb: 800, bb: 1600, ante: 1600, minutes: 20 },
  { level: 10, sb: 1000, bb: 2000, ante: 2000, minutes: 20 },
  { level: 11, sb: 1500, bb: 2500, ante: 2500, minutes: 20 },
  { level: 12, sb: 2000, bb: 3000, ante: 3000, minutes: 20 },
  { level: 13, sb: 2000, bb: 4000, ante: 4000, minutes: 20 },
  { level: 14, sb: 2500, bb: 5000, ante: 5000, minutes: 20 },
  { level: 15, sb: 3000, bb: 6000, ante: 6000, minutes: 12 },
  { level: 16, sb: 4000, bb: 8000, ante: 8000, minutes: 12 },
  { level: 17, sb: 5000, bb: 10000, ante: 10000, minutes: 12 },
  { level: 18, sb: 6000, bb: 12000, ante: 12000, minutes: 12 },
  { level: 19, sb: 8000, bb: 16000, ante: 16000, minutes: 12 },
  { level: 20, sb: 10000, bb: 20000, ante: 20000, minutes: 12 },
  { level: 21, sb: 15000, bb: 30000, ante: 30000, minutes: 12 },
  { level: 22, sb: 20000, bb: 40000, ante: 40000, minutes: 12 },
  { level: 23, sb: 25000, bb: 50000, ante: 50000, minutes: 12 },
  { level: 24, sb: 30000, bb: 60000, ante: 60000, minutes: 12 },
  { level: 25, sb: 40000, bb: 80000, ante: 80000, minutes: 12 },
  { level: 26, sb: 50000, bb: 100000, ante: 100000, minutes: 12 },
  { level: 27, sb: 75000, bb: 150000, ante: 150000, minutes: 12 },
  { level: 28, sb: 100000, bb: 200000, ante: 200000, minutes: 12 },
  { level: 29, sb: 150000, bb: 300000, ante: 300000, minutes: 12 },
  { level: 30, sb: 200000, bb: 400000, ante: 400000, minutes: 12 },
];

/** The breaks (휴식 rows) of the same table: each comes right after the named level. */
export const PUB_BREAKS: BreakRow[] = [
  { afterLevel: 3, minutes: 10 },
  { afterLevel: 6, minutes: 10 },
  { afterLevel: 10, minutes: 10 },
  { afterLevel: 14, minutes: 20 },
  { afterLevel: 19, minutes: 10 },
  { afterLevel: 25, minutes: 10 },
];

export type LevelPhase = "before" | "level" | "break" | "after";

export interface LevelEstimate {
  /** The level running (during a break: the level that just ended; after the schedule: the last level). Null before the start. */
  level: number | null;
  phase: LevelPhase;
  /** Whole minutes since this phase began (after the schedule: since its last level ended). */
  minutesIn: number;
  /** Minutes until this phase ends, rounded up (before: until the start; after: 0). */
  minutesLeft: number;
  /** The level that comes next (before: the first level; during a break its blinds apply right after). */
  nextLevel?: number;
  /** Whole minutes since the tournament started (negative before the start). */
  elapsedMinutes: number;
  /** The start time as "19:00", when the estimate came from estimateLevel. */
  startClock?: string;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface Segment {
  kind: "level" | "break";
  level: number;
  start: number; // ms from the tournament start
  end: number;
  next?: number;
}

/** The schedule laid out on a timeline (ms from the start). */
function timeline(schedule: LevelRow[], breaks: BreakRow[]): Segment[] {
  const out: Segment[] = [];
  let t = 0;
  let lastMinutes = 0;
  schedule.forEach((row, i) => {
    const minutes = Number.isFinite(row.minutes) && row.minutes > 0 ? row.minutes : lastMinutes;
    lastMinutes = minutes;
    const next = schedule[i + 1]?.level;
    out.push({ kind: "level", level: row.level, start: t, end: t + minutes * MIN, next });
    t += minutes * MIN;
    if (next === undefined) return; // a break after the last level changes nothing
    const br = breaks.find((b) => b.afterLevel === row.level);
    if (br && Number.isFinite(br.minutes) && br.minutes > 0) {
      out.push({ kind: "break", level: row.level, start: t, end: t + br.minutes * MIN, next });
      t += br.minutes * MIN;
    }
  });
  return out;
}

/**
 * The level running at `atMs` for a tournament that started at `startMs`. Intervals are half-open:
 * at the exact moment a level ends, the next level (or the break) has begun.
 */
export function levelAt(startMs: number, atMs: number, schedule: LevelRow[] = PUB_SCHEDULE, breaks: BreakRow[] = PUB_BREAKS): LevelEstimate {
  const segs = timeline(schedule, breaks);
  if (!Number.isFinite(startMs) || !Number.isFinite(atMs)) return { level: null, phase: "before", minutesIn: 0, minutesLeft: 0, elapsedMinutes: 0 };
  const d = atMs - startMs;
  const elapsedMinutes = Math.floor(d / MIN);
  if (d < 0) {
    const r: LevelEstimate = { level: null, phase: "before", minutesIn: 0, minutesLeft: Math.ceil(-d / MIN), elapsedMinutes };
    if (segs.length) r.nextLevel = segs[0].level;
    return r;
  }
  const seg = segs.find((s) => s.start <= d && d < s.end);
  if (!seg) {
    const last = segs[segs.length - 1];
    return { level: last ? last.level : null, phase: "after", minutesIn: Math.floor((d - (last?.end ?? 0)) / MIN), minutesLeft: 0, elapsedMinutes };
  }
  const r: LevelEstimate = {
    level: seg.level,
    phase: seg.kind,
    minutesIn: Math.floor((d - seg.start) / MIN),
    minutesLeft: Math.ceil((seg.end - d) / MIN),
    elapsedMinutes,
  };
  if (seg.next !== undefined) r.nextLevel = seg.next;
  return r;
}

/** Minutes from the tournament's start to the start of `level` (the breaks before it included), or null off the schedule. */
export function levelStartMinutes(level: number, schedule: LevelRow[] = PUB_SCHEDULE, breaks: BreakRow[] = PUB_BREAKS): number | null {
  const seg = timeline(schedule, breaks).find((s) => s.kind === "level" && s.level === level);
  return seg ? seg.start / MIN : null;
}

/**
 * The level running at `atMs` when `level` was running at `pickMs`, taking the pick as that level's
 * start (so it never runs ahead of what was said): the schedule moves it on from there, breaks
 * included (in a break: the level just played). `level` itself before the pick or off the schedule.
 */
export function levelSince(level: number, pickMs: number, atMs: number, schedule: LevelRow[] = PUB_SCHEDULE, breaks: BreakRow[] = PUB_BREAKS): number {
  const off = levelStartMinutes(level, schedule, breaks);
  if (off === null || !Number.isFinite(pickMs) || !Number.isFinite(atMs) || atMs <= pickMs) return level;
  return levelAt(pickMs - off * MIN, atMs, schedule, breaks).level ?? level;
}

/** The blinds of a level in a schedule, or null when the schedule doesn't have it. */
export function levelRow(level: number | null, schedule: LevelRow[] = PUB_SCHEDULE): LevelRow | null {
  return schedule.find((r) => r.level === level) ?? null;
}

// ───────────── blinds typed by hand (직접 입력) ─────────────

/** The blinds a hand is played at, in chips: the small blind, the big blind, the BB ante (0: none). */
export interface Blinds {
  sb: number;
  bb: number;
  ante: number;
  /**
   * The level number in a ready-made structure (WPL 메인: structures.ts), for its label only ("L2 100/200"); the
   * chips are the three fields above. Absent for blinds typed by hand. An older app drops it and keeps the chips.
   */
  lv?: number;
}

/**
 * A level as 빠른 기록's chip maths take it: a 야자수 새틀 level (PUB_SCHEDULE), a 직접 입력 tournament's blinds,
 * or null (not known). Existing `number | null` values are Lv as they are.
 */
export type Lv = number | Blinds | null;

/** The biggest blind or ante that can be typed (8 digits). */
export const BLINDS_MAX = 99_999_999;

const blindInt = (x: unknown, min: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= min && x <= BLINDS_MAX;

/** The biggest level number a structure's blinds may carry (`lv`). */
export const LV_MAX = 99;

/**
 * Stored / typed blinds with valid fields only: integers, 1 ≤ sb ≤ bb ≤ BLINDS_MAX, 0 ≤ ante ≤ BLINDS_MAX, and a
 * structure's level number `lv` (1 … LV_MAX) kept when there is one; else null.
 */
export function cleanBlinds(x: unknown): Blinds | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (!blindInt(r.sb, 1) || !blindInt(r.bb, 1) || !blindInt(r.ante, 0) || r.sb > r.bb) return null;
  const lv = typeof r.lv === "number" && Number.isInteger(r.lv) && r.lv >= 1 && r.lv <= LV_MAX ? r.lv : null;
  return { sb: r.sb, bb: r.bb, ante: r.ante, ...(lv !== null ? { lv } : {}) };
}

/** The chips only (a structure's level number left out): what a 직접 입력 tournament keeps. */
export const plainBlinds = (b: Blinds): Blinds => ({ sb: b.sb, bb: b.bb, ante: b.ante });

/** The blinds of `lv`: a schedule level's row (sb, bb, ante), custom blinds when valid, else null. */
export function blindsOf(lv: Lv, schedule: LevelRow[] = PUB_SCHEDULE): Blinds | null {
  if (lv === null) return null;
  if (typeof lv === "number") {
    const row = levelRow(lv, schedule);
    return row ? { sb: row.sb, bb: row.bb, ante: row.ante } : null;
  }
  return cleanBlinds(lv);
}

/** The same blinds (both null counts as the same). */
export const sameBlinds = (a: Blinds | null, b: Blinds | null): boolean => (a === null || b === null ? a === b : a.sb === b.sb && a.bb === b.bb && a.ante === b.ante);

/** "다음 단계": the first 야자수 새틀 row whose big blind is above `b.bb` (its sb, bb, ante), or null past Lv30. Without blinds: Lv1's. */
export function nextPubBlinds(b: Blinds | null): Blinds | null {
  const row = PUB_SCHEDULE.find((r) => b === null || r.bb > b.bb);
  return row ? { sb: row.sb, bb: row.bb, ante: row.ante } : null;
}

// ───────────── start time ─────────────

/**
 * A clock time typed by the player: "19:00", "7:30", "19시", "19시 30분", "7시 반", "1930", "730", "19",
 * "오후 7시", "7pm". Returns hours (0-23) and minutes, or null. A bare "7:30" means 07:30 (no AM/PM guess).
 */
export function parseClock(text: string): { h: number; m: number } | null {
  if (typeof text !== "string") return null;
  let s = text.trim().toLowerCase().replace(/\s+/g, "");
  let meridiem: "am" | "pm" | null = null;
  const pre = /^(오전|오후|am|pm)/.exec(s);
  if (pre) {
    meridiem = pre[1] === "오전" || pre[1] === "am" ? "am" : "pm";
    s = s.slice(pre[1].length);
  } else {
    const post = /(am|pm)$/.exec(s);
    if (post) {
      meridiem = post[1] === "am" ? "am" : "pm";
      s = s.slice(0, -2);
    }
  }
  let h: number;
  let m: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{1,2})[:.](\d{2})$/.exec(s))) {
    h = Number(match[1]);
    m = Number(match[2]);
  } else if ((match = /^(\d{1,2})시(?:(반)|(\d{1,2})분?)?$/.exec(s))) {
    h = Number(match[1]);
    m = match[2] ? 30 : match[3] ? Number(match[3]) : 0;
  } else if ((match = /^(\d{3,4})$/.exec(s))) {
    const n = Number(match[1]);
    h = Math.floor(n / 100);
    m = n % 100;
  } else if ((match = /^(\d{1,2})$/.exec(s))) {
    h = Number(match[1]);
    m = 0;
  } else return null;
  if (meridiem === "am") {
    if (h > 12) return null;
    if (h === 12) h = 0;
  } else if (meridiem === "pm" && h < 12) h += 12;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** "19:00" for a clock text the player typed, or null when it can't be read. */
export function clockText(text: string): string | null {
  const c = parseClock(text);
  return c ? `${String(c.h).padStart(2, "0")}:${String(c.m).padStart(2, "0")}` : null;
}

/** The runtime's local offset from UTC in minutes at a moment (Korea: +540). */
export function localOffsetMinutes(ms: number): number {
  return -new Date(ms).getTimezoneOffset();
}

/** Epoch ms of clock time `c` on the local day of `dayMs`, shifted by `dayDelta` days. */
function onDay(c: { h: number; m: number }, dayMs: number, offsetMin: number | undefined, dayDelta: number): number {
  if (offsetMin === undefined) {
    // The runtime's own timezone (DST-safe through the Date constructor).
    const d = new Date(dayMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayDelta, c.h, c.m).getTime();
  }
  const shift = offsetMin * MIN;
  const dayStart = Math.floor((dayMs + shift) / DAY) * DAY - shift;
  return dayStart + dayDelta * DAY + (c.h * 60 + c.m) * MIN;
}

/** An explicit offset must be a finite number (left out means the runtime's timezone). */
const validOffset = (offsetMin: number | undefined) => offsetMin === undefined || Number.isFinite(offsetMin);

/**
 * Epoch ms of a clock time ("19:00", "7:30", "19시", "1930", ...) on the local day that contains `dayMs`.
 * `offsetMin` is the timezone's offset from UTC in minutes (Korea: 540); left out, the runtime's local
 * timezone is used. Null when the clock text can't be read.
 */
export function parseStartTime(clock: string, dayMs: number, offsetMin?: number): number | null {
  const c = parseClock(clock);
  if (!c || !Number.isFinite(dayMs) || !validOffset(offsetMin)) return null;
  return onDay(c, dayMs, offsetMin, 0);
}

/** How far the start time may be after the hand before it's read as the previous day's start. */
export const START_AFTER_HAND_SLACK_MS = 2 * 60 * MIN;

/**
 * The tournament's start (epoch ms) for a hand at `handMs`: the last time that clock time comes round
 * no later than two hours after the hand. So it's on the hand's local day, or on the previous day when
 * that would be more than two hours after the hand (a tournament running past midnight), or on the next
 * day when that is at most two hours after the hand (a start just after midnight, a hand just before).
 * Null when the clock text can't be read.
 */
export function startForHand(startClock: string, handMs: number, offsetMin?: number): number | null {
  const c = parseClock(startClock);
  if (!c || !Number.isFinite(handMs) || !validOffset(offsetMin)) return null;
  const same = onDay(c, handMs, offsetMin, 0);
  if (same - handMs > START_AFTER_HAND_SLACK_MS) return onDay(c, handMs, offsetMin, -1);
  const next = onDay(c, handMs, offsetMin, 1);
  return next - handMs <= START_AFTER_HAND_SLACK_MS ? next : same;
}

/** startForHand + levelAt in one step, with the start time kept for the label. Null for an unreadable clock. */
export function estimateLevel(
  startClock: string,
  handMs: number,
  offsetMin?: number,
  schedule: LevelRow[] = PUB_SCHEDULE,
  breaks: BreakRow[] = PUB_BREAKS,
): LevelEstimate | null {
  const start = startForHand(startClock, handMs, offsetMin);
  const clock = clockText(startClock);
  if (start === null || clock === null) return null;
  return { ...levelAt(start, handMs, schedule, breaks), startClock: clock };
}

// ───────────── label ─────────────

/** "3시간 5분", "3시간", "45분". */
export function durationText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest}분`;
  return rest ? `${h}시간 ${rest}분` : `${h}시간`;
}

/**
 * Korean label for an estimate: "Lv9 추정 · 19:00 시작 3시간 5분째", "휴식 중 (다음 Lv10) · …",
 * "시작 전 · 19:00 시작까지 20분", "Lv30 이후 (구조표 끝) · …". The start clock comes from
 * `startClock` or the estimate itself; without one the tail reads "시작 3시간 5분째". `prefix`: a ready-made
 * structure's level word ("L": "L2 추정").
 */
export function estimateLabel(r: LevelEstimate, startClock?: string, prefix = "Lv"): string {
  const clock = (startClock !== undefined ? clockText(startClock) : null) ?? r.startClock ?? null;
  const since = clock ? `${clock} 시작` : "시작";
  if (r.phase === "before") return `시작 전${clock ? ` · ${clock} 시작까지 ${durationText(r.minutesLeft)}` : ""}`;
  const tail = ` · ${since} ${durationText(r.elapsedMinutes)}째`;
  if (r.phase === "break") return `휴식 중${r.nextLevel !== undefined ? ` (다음 ${prefix}${r.nextLevel})` : ""}${tail}`;
  if (r.phase === "after") return `${r.level !== null ? `${prefix}${r.level} 이후 (구조표 끝)` : "구조표 끝"}${tail}`;
  return `${prefix}${r.level} 추정${tail}`;
}
