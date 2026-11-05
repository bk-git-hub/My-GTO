import { QUIZ_KIND_LABEL, QUIZ_KINDS, type Attempt, type QuizKind } from "../../../shared/contracts";

/** Pure helpers for the records page (no React, no storage). */

export interface Tally {
  attempts: number;
  correct: number;
}

/** Same rule as the stats tallies: a mixed-frequency answer counts as correct. */
export const isCorrect = (a: Pick<Attempt, "grade">) => a.grade !== "wrong";

export function rate(t: Tally): number | null {
  return t.attempts ? t.correct / t.attempts : null;
}

export function pctText(r: number | null): string {
  return r === null ? "-" : `${Math.round(r * 100)}%`;
}

function tally(list: readonly Attempt[]): Tally {
  let correct = 0;
  for (const a of list) if (isCorrect(a)) correct++;
  return { attempts: list.length, correct };
}

/** Device-local calendar day, "YYYY-MM-DD". */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "오늘 14:05" or "11/3 14:05" (device local time). */
export function formatTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return dayKey(ts) === dayKey(now) ? `오늘 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export interface DayBar extends Tally {
  day: string;
  /** "11/5" */
  label: string;
  today: boolean;
}

export interface Overview extends Tally {
  today: number;
  todayCorrect: number;
  days: DayBar[];
}

/** Totals, today's count and the last `days` local days (oldest first, today last). */
export function overview(list: readonly Attempt[], now: number = Date.now(), days = 14): Overview {
  const base = new Date(now);
  const bars: DayBar[] = [];
  const index = new Map<string, DayBar>();
  for (let i = days - 1; i >= 0; i--) {
    // Noon avoids DST edges when stepping back whole days.
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i, 12);
    const bar: DayBar = { day: dayKey(d.getTime()), label: `${d.getMonth() + 1}/${d.getDate()}`, today: i === 0, attempts: 0, correct: 0 };
    bars.push(bar);
    index.set(bar.day, bar);
  }
  for (const a of list) {
    const bar = index.get(dayKey(a.at));
    if (!bar) continue;
    bar.attempts++;
    if (isCorrect(a)) bar.correct++;
  }
  const todayBar = bars[bars.length - 1];
  return { ...tally(list), today: todayBar?.attempts ?? 0, todayCorrect: todayBar?.correct ?? 0, days: bars };
}

export type Trend = "up" | "down" | "flat" | null;

export interface KindSummary extends Tally {
  kind: QuizKind;
  label: string;
  recent: Tally;
  /** Last-20 accuracy vs overall: ±5 points or more counts as a trend. Null until there are more than 20 attempts. */
  trend: Trend;
  /** Average EV given up, over attempts that have one. */
  avgEvLoss: number | null;
  evCount: number;
}

export const RECENT_N = 20;

export function byKind(list: readonly Attempt[]): KindSummary[] {
  const groups = new Map<QuizKind, Attempt[]>();
  for (const a of list) {
    const g = groups.get(a.kind);
    if (g) g.push(a);
    else groups.set(a.kind, [a]);
  }
  const out: KindSummary[] = [];
  for (const kind of QUIZ_KINDS) {
    const g = groups.get(kind);
    if (!g) continue;
    const sorted = [...g].sort((x, y) => x.at - y.at);
    const all = tally(sorted);
    const recent = tally(sorted.slice(-RECENT_N));
    let trend: Trend = null;
    if (sorted.length > RECENT_N) {
      const diff = (rate(recent) ?? 0) - (rate(all) ?? 0);
      trend = diff >= 0.05 ? "up" : diff <= -0.05 ? "down" : "flat";
    }
    const evs = sorted.filter((a) => typeof a.evLossBB === "number").map((a) => a.evLossBB!);
    out.push({
      kind,
      label: QUIZ_KIND_LABEL[kind],
      ...all,
      recent,
      trend,
      avgEvLoss: evs.length ? Math.round((evs.reduce((s, x) => s + x, 0) / evs.length) * 100) / 100 : null,
      evCount: evs.length,
    });
  }
  return out;
}

const STAGE_LABEL: Record<string, string> = { deep: "딥", mid: "미들", short: "숏", push: "푸시/폴드" };
const STREET_LABEL: Record<string, string> = { preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버" };

/** Where to practise a spot. Stack spots go straight to the stage + seat drill. */
export function practiceRoute(spot: string, kind: QuizKind): string {
  const parts = spot.split(":");
  if (kind === "stack" && parts[0] === "stack" && parts.length >= 4) {
    const [, mode, stageId, seat] = parts;
    if (mode === "cash") return `quiz/stack/cash/all/${encodeURIComponent(seat)}`;
    if (mode === "pub") return `quiz/stack/pub/${stageId}/${encodeURIComponent(seat)}`;
    return "quiz/stack";
  }
  if (kind === "preflop") return "quiz/preflop";
  if (kind === "odds") return "quiz/odds";
  if (kind === "equity") return "quiz/equity";
  if (kind === "play") return "play";
  return "home";
}

/** A name for a spot group (titles of single attempts can carry random parts). */
export function spotLabel(spot: string, kind: QuizKind, latestTitle: string): string {
  const parts = spot.split(":");
  if (kind === "play" && parts.length >= 3) return `핸드 플레이 · ${STAGE_LABEL[parts[1]] ?? parts[1]} · ${STREET_LABEL[parts[2]] ?? parts[2]}`;
  if ((kind === "odds" || kind === "equity") && parts.length >= 2) return `${QUIZ_KIND_LABEL[kind]} · ${parts.slice(1).join(":")}`;
  return latestTitle || spot;
}

export interface WeakSpot extends Tally {
  spot: string;
  kind: QuizKind;
  label: string;
  route: string;
  lastAt: number;
}

/** Spots with at least `min` attempts, lowest accuracy first (tie: more attempts first). */
export function weakSpots(list: readonly Attempt[], min = 3, top = 5): WeakSpot[] {
  const groups = new Map<string, { kind: QuizKind; attempts: number; correct: number; lastAt: number; title: string }>();
  for (const a of list) {
    const g = groups.get(a.spot) ?? { kind: a.kind, attempts: 0, correct: 0, lastAt: 0, title: a.title };
    g.attempts++;
    if (isCorrect(a)) g.correct++;
    if (a.at >= g.lastAt) {
      g.lastAt = a.at;
      g.title = a.title;
      g.kind = a.kind;
    }
    groups.set(a.spot, g);
  }
  const out: WeakSpot[] = [];
  for (const [spot, g] of groups) {
    if (g.attempts < min) continue;
    out.push({
      spot,
      kind: g.kind,
      attempts: g.attempts,
      correct: g.correct,
      lastAt: g.lastAt,
      label: spotLabel(spot, g.kind, g.title),
      route: practiceRoute(spot, g.kind),
    });
  }
  out.sort((x, y) => x.correct / x.attempts - y.correct / y.attempts || y.attempts - x.attempts || y.lastAt - x.lastAt);
  return out.slice(0, top);
}

/** Newest first, optionally one kind and/or only wrong answers. */
export function filterHistory<T extends Attempt>(list: readonly T[], kind: QuizKind | "all", wrongOnly: boolean): T[] {
  return list
    .filter((a) => (kind === "all" || a.kind === kind) && (!wrongOnly || a.grade === "wrong"))
    .sort((x, y) => y.at - x.at || (y.id > x.id ? 1 : y.id < x.id ? -1 : 0));
}

/** The stats keys that hold one tally per quiz area (sum = every answer ever counted). */
export const TOP_KEYS = ["preflop", "stack", "stack-cash", "odds", "equity", "play"] as const;

/**
 * Answers counted in the tallies but not in the log — i.e. from before the log existed.
 * Per top key: tally minus logged attempts carrying that key (never below zero).
 */
export function legacyTotals(byKey: Record<string, Tally>, list: readonly Attempt[]): Tally {
  const logged = new Map<string, Tally>();
  for (const a of list) {
    for (const k of a.keys) {
      if (!(TOP_KEYS as readonly string[]).includes(k)) continue;
      const t = logged.get(k) ?? { attempts: 0, correct: 0 };
      t.attempts++;
      if (isCorrect(a)) t.correct++;
      logged.set(k, t);
    }
  }
  let attempts = 0;
  let correct = 0;
  for (const k of TOP_KEYS) {
    const t = byKey[k];
    if (!t) continue;
    const l = logged.get(k) ?? { attempts: 0, correct: 0 };
    const extra = Math.max(0, t.attempts - l.attempts);
    attempts += extra;
    correct += Math.min(extra, Math.max(0, t.correct - l.correct));
  }
  return { attempts, correct };
}

/** Facts for the AI coach about one logged attempt. */
export function attemptFacts(a: Attempt): string {
  return [
    `기록 종류: ${QUIZ_KIND_LABEL[a.kind]}`,
    `문제: ${a.title}`,
    `사용자의 선택: ${a.chosen}`,
    `정답(최선): ${a.correct}`,
    `채점: ${a.grade === "correct" ? "정답" : a.grade === "mixed" ? "부분 정답 (혼합 빈도)" : "오답"}`,
    typeof a.evLossBB === "number" ? `EV 손실: ${a.evLossBB}bb` : "",
    a.detail ? `\n${a.detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
