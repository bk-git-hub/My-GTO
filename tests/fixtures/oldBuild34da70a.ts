/**
 * The stored-data rules of the app as it was before ready-made structures (master 34da70a), copied verbatim from
 * src/features/log/levelClock.ts, tourney.ts, fastTourney.ts, fastChips.ts and handLog.ts of that commit (only the
 * imports and exports differ), so a test can read what this build stores the way that build reads it. Do not
 * update these to follow the app: they are the older app.
 */

export interface Blinds {
  sb: number;
  bb: number;
  ante: number;
}

export interface StackCheck {
  at: number;
  stack: number;
}

export interface Tourney {
  id: string;
  createdAt: number;
  updatedAt: number;
  activeAt: number;
  name: string;
  memo: string;
  start: number;
  startSet?: true;
  startStack: number | null;
  auto?: true;
  checks?: StackCheck[];
  structure?: "custom";
  blinds?: Blinds;
}

const BLINDS_MAX = 99_999_999;
const blindInt = (x: unknown, min: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= min && x <= BLINDS_MAX;

/** levelClock.ts */
export function cleanBlinds(x: unknown): Blinds | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (!blindInt(r.sb, 1) || !blindInt(r.bb, 1) || !blindInt(r.ante, 0) || r.sb > r.bb) return null;
  return { sb: r.sb, bb: r.bb, ante: r.ante };
}

const TOURNEY_NAME_MAX = 40;
const TOURNEY_MEMO_MAX = 500;
const MAX_TOURNEYS = 1000;
const MAX_CHECKS = 300;
const ID_MAX = 64;
const STACK_MAX = 999_999_999;

const fin = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const isTourneyId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= ID_MAX;
const isStackChips = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= STACK_MAX;

/** tourney.ts */
function cleanChecks(x: unknown): StackCheck[] {
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

/** tourney.ts */
export function cleanTourney(x: unknown): Tourney | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const createdAt = fin(r.createdAt);
  if (!isTourneyId(r.id) || createdAt === null) return null;
  const stack = r.startStack;
  const startStack = typeof stack === "number" && Number.isInteger(stack) && stack >= 1 && stack <= STACK_MAX ? stack : null;
  const checks = cleanChecks(r.checks);
  const custom = r.structure === "custom";
  const blinds = custom ? cleanBlinds(r.blinds) : null;
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
    ...(custom ? { structure: "custom" as const } : {}),
    ...(blinds ? { blinds } : {}),
  };
}

function ordered(byId: Map<string, Tourney>): Tourney[] {
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(-MAX_TOURNEYS);
}

/** tourney.ts */
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

/** fastTourney.ts: a 직접 입력 tournament (its blinds typed by hand). */
export const isCustom = (t: Pick<Tourney, "structure"> | null | undefined): boolean => t?.structure === "custom";

/** fastTourney.ts tourneyEstimate's first line: a 직접 입력 tournament never gets a level from a clock. */
export const estimates = (t: Tourney | null): boolean => !(t && isCustom(t));

/** fastTourney.ts levelFor, its 직접 입력 line (the rest is 야자수 새틀's clock, never reached for one). */
export const customLevel = (t: Tourney): Blinds | null => t.blinds ?? null;

/** fastChips.ts */
export const handLv = (h: { level: number | null; blinds?: Blinds }): number | Blinds | null => h.blinds ?? h.level;

/** levelClock.ts blindsOf for blinds (a number is a 야자수 새틀 level, not reached here). */
export const blindsOfCustom = (lv: number | Blinds | null): Blinds | null => (lv !== null && typeof lv === "object" ? cleanBlinds(lv) : null);

/** fastChips.ts postedBy, for blinds. */
export function postedBy(seat: string, level: Blinds | null, bbAnte = true): number | null {
  if (seat !== "SB" && seat !== "BB") return 0;
  const row = blindsOfCustom(level);
  if (!row) return null;
  return seat === "SB" ? row.sb : row.bb + (bbAnte ? row.ante : 0);
}

/**
 * handLog.ts needsSanitize, the lines about the fields a 빠른 기록 hand in a tournament carries (the others are the
 * table record's and are the same in both builds): true sends every hand through sanitize on load.
 */
export function needsSanitizeLines(h: { level: number | null; levelGuess?: unknown; tourney?: unknown; blinds?: unknown }): boolean {
  if ("levelGuess" in h && (h.levelGuess !== true || h.level === null)) return true;
  if ("tourney" in h && !isTourneyId(h.tourney)) return true;
  if ("blinds" in h && (h.level !== null || !cleanBlinds(h.blinds))) return true;
  return false;
}

/** handLog.ts migrateStore's tournament line: the list is written back on load when cleaning it changes it. */
export const rewritesTourneysOnLoad = (stored: unknown): boolean => JSON.stringify(cleanTourneys(stored)) !== JSON.stringify(stored);
