/**
 * 빠른 기록's tournaments: the record itself (name, memo, start time, start stack) and how the stored list
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
}

export const TOURNEY_NAME_MAX = 40;
export const TOURNEY_MEMO_MAX = 500;
export const MAX_TOURNEYS = 1000;
const ID_MAX = 64;
const STACK_MAX = 999_999_999;

const fin = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** A tournament id as stored on a hand or a record: a non-empty string of at most 64 characters. */
export const isTourneyId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= ID_MAX;

/** One stored or imported record with valid fields only, or null (no usable id or createdAt). */
export function cleanTourney(x: unknown): Tourney | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const createdAt = fin(r.createdAt);
  if (!isTourneyId(r.id) || createdAt === null) return null;
  const stack = r.startStack;
  const startStack = typeof stack === "number" && Number.isInteger(stack) && stack >= 1 && stack <= STACK_MAX ? stack : null;
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
