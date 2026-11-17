/**
 * 빠른 기록's tournaments: the record itself (name, memo, start time, start stack, 칩 업데이트) and how the stored list
 * is kept clean and merged from a backup. Pure, with no value imports from the hand log, so handLog.ts can
 * use it at load time (its migration runs when the module loads). The rules about which tournament is
 * current, its hands and its screens are in fastTourney.ts.
 */

export interface Tourney {
  /** "t-<Date.now() base36>-<6 random base36>". */
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Started or resumed (이어 적기) last at: the latest one is the current tournament while it is live. */
  activeAt: number;
  /** As typed, trimmed, at most 40 characters; "" shows the default title ("11/17 토너먼트"). */
  name: string;
  /** At most 500 characters. */
  memo: string;
  /**
   * Epoch ms. With `startSet`: the tournament's real start, the level clock of its hands. Without: when it
   * was made (the screens then go by its first hand's time).
   */
  start: number;
  /** The start was set (typed in the sheet or the level picker, or taken from the day's start): it drives the level estimate. */
  startSet?: true;
  /** Starting stack in chips (1 … 999,999,999), null: not known. The chip graph starts here. */
  startStack: number | null;
  /** Made by a hand on its own and never edited since (an empty one that isn't current is left off the list). */
  auto?: true;
  /**
   * 칩 업데이트: my stack counted and typed between hands (after a break, a rebuy or add-on, or just to put the
   * count right), oldest first. The chip graph and total follow each one (a difference from the count is an
   * adjustment, not a hand), and the next hand's stack before it starts there. Absent: none.
   */
  checks?: StackCheck[];
}

/** One 칩 업데이트: at `at` (epoch ms) I had `stack` chips (0 … 999,999,999: 0 is busted). */
export interface StackCheck {
  at: number;
  stack: number;
}

export const TOURNEY_NAME_MAX = 40;
export const TOURNEY_MEMO_MAX = 500;
export const MAX_TOURNEYS = 1000;
/** At most this many 칩 업데이트 a tournament (the newest kept). */
export const MAX_CHECKS = 300;
const ID_MAX = 64;
export const STACK_MAX = 999_999_999;

const fin = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** A tournament id as stored on a hand or a record: a non-empty string of at most 64 characters. */
export const isTourneyId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= ID_MAX;

/** A stack typed as a whole number of chips, 0 … 999,999,999. */
export const isStackChips = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= STACK_MAX;

/** Stored 칩 업데이트 with valid fields only, one per moment (the later entry wins), oldest first, at most MAX_CHECKS (newest kept). */
export function cleanChecks(x: unknown): StackCheck[] {
  const byAt = new Map<number, StackCheck>();
  for (const raw of Array.isArray(x) ? x : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const at = fin(r.at);
    if (at === null || !isStackChips(r.stack)) continue;
    byAt.set(at, { at, stack: r.stack });
  }
  return [...byAt.values()].sort((a, b) => a.at - b.at).slice(-MAX_CHECKS);
}

/** One stored or imported record with valid fields only, or null (no usable id or createdAt). */
export function cleanTourney(x: unknown): Tourney | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const createdAt = fin(r.createdAt);
  if (!isTourneyId(r.id) || createdAt === null) return null;
  const stack = r.startStack;
  const startStack = typeof stack === "number" && Number.isInteger(stack) && stack >= 1 && stack <= STACK_MAX ? stack : null;
  const checks = cleanChecks(r.checks);
  return {
    id: r.id,
    createdAt,
    updatedAt: fin(r.updatedAt) ?? createdAt,
    activeAt: fin(r.activeAt) ?? createdAt,
    name: typeof r.name === "string" ? r.name.trim().slice(0, TOURNEY_NAME_MAX).trim() : "",
    memo: typeof r.memo === "string" ? r.memo.slice(0, TOURNEY_MEMO_MAX) : "",
    start: fin(r.start) ?? createdAt,
    ...(r.startSet === true ? { startSet: true as const } : {}),
    startStack,
    ...(r.auto === true ? { auto: true as const } : {}),
    ...(checks.length ? { checks } : {}),
  };
}

/** Oldest made first (ties by id), at most MAX_TOURNEYS (the newest kept). */
function ordered(byId: Map<string, Tourney>): Tourney[] {
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(-MAX_TOURNEYS);
}

/** Stored records, valid ones only, one per id (the later updatedAt wins; a tie: the later entry), oldest createdAt first, at most MAX_TOURNEYS (newest kept). */
export function cleanTourneys(x: unknown): Tourney[] {
  const byId = new Map<string, Tourney>();
  for (const raw of Array.isArray(x) ? x : []) {
    const t = cleanTourney(raw);
    if (!t) continue;
    const was = byId.get(t.id);
    if (!was || t.updatedAt >= was.updatedAt) byId.set(t.id, t);
  }
  return ordered(byId);
}

/** A backup's records into ours: one per id, the later updatedAt wins (a tie: ours). */
export function mergeTourneys(ours: unknown, theirs: unknown): Tourney[] {
  const byId = new Map(cleanTourneys(ours).map((t) => [t.id, t]));
  for (const t of cleanTourneys(theirs)) {
    const was = byId.get(t.id);
    if (!was || t.updatedAt > was.updatedAt) byId.set(t.id, t);
  }
  return ordered(byId);
}

/** `s` with `t` (cleaned, as stored) added or put in place of the record with its id. Works on any `{ tourneys?: unknown }`. */
export function withTourney<S extends { tourneys?: unknown }>(s: S, t: Tourney): Omit<S, "tourneys"> & { tourneys: Tourney[] } {
  const c = cleanTourney(t);
  const rest = cleanTourneys(s.tourneys).filter((x) => x.id !== t.id);
  return { ...s, tourneys: ordered(new Map([...rest, ...(c ? [c] : [])].map((x) => [x.id, x]))) };
}

/** `s` without the record `id` (the field left out when none remain). */
export function withoutTourney<S extends { tourneys?: unknown }>(s: S, id: string): S {
  const left = cleanTourneys(s.tourneys).filter((x) => x.id !== id);
  const { tourneys: _t, ...rest } = s;
  void _t;
  return (left.length ? { ...rest, tourneys: left } : rest) as S;
}
