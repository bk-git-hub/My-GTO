import { useSyncExternalStore } from "react";
import {
  LIMITS,
  QUIZ_KINDS,
  SCHEMA_VERSION,
  type Attempt,
  type AttemptGrade,
  type AttemptOutbox,
  type QuizKind,
} from "../../shared/contracts";
import { isId, newId } from "../../shared/ids";
import { recordAnswer } from "./stats";

/**
 * Local attempt log: every answered question as an immutable `Attempt` (shared/contracts.ts).
 * Lives next to the aggregate tallies in stats.ts (which stay exactly as before).
 *
 * Everything that touches the list is a pure function below, so it can be tested in node
 * without localStorage. The store at the bottom only wires those functions to storage + React.
 */

export const ATTEMPTS_KEY = "pubaz.attempts.v1";
export const DEVICE_KEY = "pubaz.device";

/** An attempt as kept on this device, with its sync state. */
export type LocalAttempt = Attempt & { syncedAt?: number; rejected?: true };

/** What a quiz screen passes in; id / v / deviceId are filled by the log. */
export type AttemptInput = Omit<Attempt, "id" | "v" | "deviceId" | "at"> & { at?: number };

const GRADES: readonly AttemptGrade[] = ["correct", "mixed", "wrong"];

// ───────────────────────── pure helpers ─────────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Cut to `max` UTF-16 units with "…", never splitting a surrogate pair, and replace lone
 * surrogates with U+FFFD. The server rejects lone surrogates (Postgres jsonb can't store them).
 */
export function truncate(s: string, max: number): string {
  const clean = s.replace(LONE_SURROGATE, "\uFFFD");
  if (clean.length <= max) return clean;
  let end = Math.max(0, max - 1);
  const last = clean.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return clean.slice(0, end) + "…";
}

function cleanKeys(keys: readonly string[]): string[] {
  return keys.slice(0, LIMITS.maxKeys).map((k) => truncate(k, LIMITS.maxKeyLength));
}

function cleanEv(ev: number | undefined): number | undefined {
  if (ev === undefined || !Number.isFinite(ev)) return undefined;
  return Math.round(Math.max(0, ev) * 100) / 100;
}

/** Build a well-formed Attempt (strings cut to LIMITS). */
export function buildAttempt(input: AttemptInput, deviceId: string, at: number = input.at ?? Date.now(), id: string = newId(at)): Attempt {
  const a: Attempt = {
    id,
    v: SCHEMA_VERSION,
    at,
    kind: input.kind,
    keys: cleanKeys(input.keys),
    spot: truncate(input.spot, LIMITS.maxSpotLength),
    title: truncate(input.title, LIMITS.maxTitleLength),
    chosen: truncate(input.chosen, LIMITS.maxLabelLength),
    correct: truncate(input.correct, LIMITS.maxLabelLength),
    grade: input.grade,
    deviceId,
  };
  const ev = cleanEv(input.evLossBB);
  if (ev !== undefined) a.evLossBB = ev;
  if (input.detail) a.detail = truncate(input.detail, LIMITS.maxDetailLength);
  return a;
}

const isStr = (x: unknown): x is string => typeof x === "string";

/**
 * Validate one row from storage or an import file. Returns null for anything that is not a
 * usable Attempt. Strings are cut to LIMITS; sync state is kept only when `keepSync`.
 */
export function sanitizeAttempt(raw: unknown, keepSync = false): LocalAttempt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isId(r.id)) return null;
  if (r.v !== SCHEMA_VERSION) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (!QUIZ_KINDS.includes(r.kind as QuizKind)) return null;
  if (!Array.isArray(r.keys) || !r.keys.every(isStr)) return null;
  if (!isStr(r.spot) || !r.spot || !isStr(r.title) || !isStr(r.chosen) || !isStr(r.correct)) return null;
  if (!GRADES.includes(r.grade as AttemptGrade)) return null;
  if (!isStr(r.deviceId) || !r.deviceId) return null;
  if (r.evLossBB !== undefined && (typeof r.evLossBB !== "number" || !Number.isFinite(r.evLossBB))) return null;
  if (r.detail !== undefined && !isStr(r.detail)) return null;

  const a: LocalAttempt = buildAttempt(
    {
      kind: r.kind as QuizKind,
      keys: r.keys as string[],
      spot: r.spot,
      title: r.title,
      chosen: r.chosen,
      correct: r.correct,
      grade: r.grade as AttemptGrade,
      evLossBB: r.evLossBB as number | undefined,
      detail: r.detail as string | undefined,
    },
    truncate(r.deviceId, 64),
    Math.floor(r.at),
    r.id,
  );
  if (keepSync) {
    if (typeof r.syncedAt === "number" && Number.isFinite(r.syncedAt)) a.syncedAt = r.syncedAt;
    if (r.rejected === true) a.rejected = true;
  }
  return a;
}

/** Oldest first: by time, then id. */
export function compareAttempts(a: Attempt, b: Attempt): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const isDone = (a: LocalAttempt) => a.syncedAt !== undefined || a.rejected === true;

/**
 * Keep at most `cap` attempts. Drops the oldest attempts the server already has (or will never
 * take: rejected) first, then the oldest of the rest. Input and output are oldest-first.
 */
export function capAttempts(list: LocalAttempt[], cap: number = LIMITS.localAttemptCap): LocalAttempt[] {
  let excess = list.length - cap;
  if (excess <= 0) return list;
  const drop = new Set<LocalAttempt>();
  for (const a of list) {
    if (excess === 0) break;
    if (isDone(a)) {
      drop.add(a);
      excess--;
    }
  }
  for (const a of list) {
    if (excess === 0) break;
    if (!drop.has(a)) {
      drop.add(a);
      excess--;
    }
  }
  return list.filter((a) => !drop.has(a));
}

/** Add one attempt (kept oldest-first) and apply the cap. Returns a new array. */
export function appendAttempt(list: LocalAttempt[], a: LocalAttempt, cap: number = LIMITS.localAttemptCap): LocalAttempt[] {
  const last = list[list.length - 1];
  const next = [...list, a];
  if (last && compareAttempts(last, a) > 0) next.sort(compareAttempts);
  return capAttempts(next, cap);
}

/** Merge rows into the log by id. Existing rows win (attempts are immutable). */
export function mergeAttempts(
  list: LocalAttempt[],
  incoming: LocalAttempt[],
  cap: number = LIMITS.localAttemptCap,
): { list: LocalAttempt[]; added: number; duplicates: number } {
  const seen = new Set(list.map((a) => a.id));
  const fresh: LocalAttempt[] = [];
  let duplicates = 0;
  for (const a of incoming) {
    if (seen.has(a.id)) {
      duplicates++;
      continue;
    }
    seen.add(a.id);
    fresh.push(a);
  }
  if (!fresh.length) return { list, added: 0, duplicates };
  const merged = capAttempts([...list, ...fresh].sort(compareAttempts), cap);
  const kept = new Set(merged.map((a) => a.id));
  return { list: merged, added: fresh.filter((a) => kept.has(a.id)).length, duplicates };
}

/** Rows read back from storage (keeps sync state, drops broken rows, restores order). */
export function parseStored(raw: string | null): LocalAttempt[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    const rows = Array.isArray(data) ? data : [];
    const out: LocalAttempt[] = [];
    const ids = new Set<string>();
    for (const row of rows) {
      const a = sanitizeAttempt(row, true);
      if (a && !ids.has(a.id)) {
        ids.add(a.id);
        out.push(a);
      }
    }
    return out.sort(compareAttempts);
  } catch {
    return [];
  }
}

export interface AttemptsExport {
  app: "pubaz";
  type: "attempts";
  v: typeof SCHEMA_VERSION;
  exportedAt: number;
  attempts: Attempt[];
}

/** Strip local sync state for export. */
function toPlain(a: LocalAttempt): Attempt {
  const { syncedAt: _s, rejected: _r, ...rest } = a;
  void _s;
  void _r;
  return rest;
}

export function buildExport(list: LocalAttempt[], now: number = Date.now()): string {
  const body: AttemptsExport = { app: "pubaz", type: "attempts", v: SCHEMA_VERSION, exportedAt: now, attempts: list.map(toPlain) };
  return JSON.stringify(body, null, 1);
}

/**
 * Read an export file (or a bare array of attempts). Throws on text that is not JSON or not
 * an attempts file; bad rows are counted, not fatal. Sync state is never imported: the server
 * dedupes by id, so re-sending an imported attempt is harmless.
 */
export function parseImport(text: string): { attempts: LocalAttempt[]; invalid: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSON 파일이 아니에요.");
  }
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { attempts?: unknown }).attempts)
      ? ((data as { attempts: unknown[] }).attempts)
      : null;
  if (!rows) throw new Error("PubAZ 기록 파일이 아니에요.");
  const attempts: LocalAttempt[] = [];
  let invalid = 0;
  for (const row of rows) {
    const a = sanitizeAttempt(row, false);
    if (a) attempts.push(a);
    else invalid++;
  }
  return { attempts, invalid };
}

/** Oldest-first attempts never synced and not rejected. */
export function selectUnsynced(list: LocalAttempt[], limit: number): Attempt[] {
  const out: Attempt[] = [];
  if (limit <= 0) return out;
  for (const a of list) {
    if (isDone(a)) continue;
    out.push(toPlain(a));
    if (out.length >= limit) break;
  }
  return out;
}

export function applySynced(list: LocalAttempt[], ids: string[], at: number): LocalAttempt[] {
  const set = new Set(ids);
  let changed = false;
  const next = list.map((a) => {
    if (!set.has(a.id) || a.syncedAt !== undefined) return a;
    changed = true;
    return { ...a, syncedAt: at };
  });
  return changed ? next : list;
}

export function applyRejected(list: LocalAttempt[], ids: string[]): LocalAttempt[] {
  const set = new Set(ids);
  let changed = false;
  const next = list.map((a) => {
    if (!set.has(a.id) || a.rejected) return a;
    changed = true;
    return { ...a, rejected: true as const };
  });
  return changed ? next : list;
}

/** Copies with `detail` removed from all but the newest `keepNewest` rows (to fit a full storage). */
export function stripOldDetails(list: LocalAttempt[], keepNewest: number): LocalAttempt[] {
  const cut = list.length - keepNewest;
  return list.map((a, i) => {
    if (i >= cut || a.detail === undefined) return a;
    const { detail: _d, ...rest } = a;
    void _d;
    return rest;
  });
}

// ───────────────────────── storage + React store ─────────────────────────

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let deviceId: string | null = null;

/** This device's id, created once and kept in localStorage (stable for the session even without storage). */
export function getDeviceId(): string {
  if (deviceId) return deviceId;
  const st = storage();
  try {
    const saved = st?.getItem(DEVICE_KEY);
    if (isId(saved)) return (deviceId = saved);
  } catch {
    /* unavailable */
  }
  deviceId = newId();
  try {
    st?.setItem(DEVICE_KEY, deviceId);
  } catch {
    /* unavailable or full */
  }
  return deviceId;
}

export interface AttemptLogState {
  items: LocalAttempt[];
  /** True when the last write to localStorage failed even after shrinking (kept in memory only). */
  saveFailed: boolean;
}

function loadState(): AttemptLogState {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(ATTEMPTS_KEY) ?? null;
  } catch {
    /* unavailable */
  }
  return { items: parseStored(raw), saveFailed: false };
}

let state: AttemptLogState = loadState();
const listeners = new Set<() => void>();

/** Write to localStorage; when it is full, drop details of older rows and try again. */
function persist(items: LocalAttempt[]): boolean {
  const st = storage();
  if (!st) return false;
  for (const keep of [Infinity, 1000, 200, 0]) {
    try {
      st.setItem(ATTEMPTS_KEY, JSON.stringify(keep === Infinity ? items : stripOldDetails(items, keep)));
      return true;
    } catch {
      /* quota exceeded: shrink and retry */
    }
  }
  return false;
}

function setItems(next: LocalAttempt[]) {
  if (next === state.items) return;
  const ok = persist(next);
  state = { items: next, saveFailed: !ok && storage() !== null };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getState = () => state;

// Another tab wrote the log: reload so neither tab overwrites the other's attempts.
if (typeof window !== "undefined") {
  try {
    window.addEventListener("storage", (e) => {
      if (e.key !== ATTEMPTS_KEY) return;
      state = loadState();
      listeners.forEach((l) => l());
    });
  } catch {
    /* not a browser */
  }
}

export const attemptsStore = {
  get: getState,
  subscribe,
  items: () => state.items,
};

/** React hook: the whole log, oldest first. */
export function useAttemptLog(): AttemptLogState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function useAttempts(): LocalAttempt[] {
  return useAttemptLog().items;
}

/** Append one answered question to the local log. Never throws. */
export function recordAttempt(input: AttemptInput, at: number = input.at ?? Date.now()): Attempt {
  const a = buildAttempt(input, getDeviceId(), at);
  try {
    setItems(appendAttempt(state.items, a));
  } catch {
    /* never break a quiz because of the log */
  }
  return a;
}

/**
 * The one call every answer site uses: updates the aggregate tallies exactly as before
 * (`recordAnswer(keys, grade !== "wrong")`) and appends the attempt to the log.
 */
export function recordQuiz(input: AttemptInput): Attempt | null {
  recordAnswer(input.keys, input.grade !== "wrong");
  try {
    return recordAttempt(input);
  } catch {
    return null;
  }
}

export function clearAttempts() {
  setItems([]);
}

export function exportAttemptsJson(now: number = Date.now()): string {
  return buildExport(state.items, now);
}

/** Merge an export file into the log. Throws (with a Korean message) when the file is unusable. */
export function importAttemptsJson(text: string): { added: number; duplicates: number; invalid: number } {
  const { attempts, invalid } = parseImport(text);
  const r = mergeAttempts(state.items, attempts);
  setItems(r.list);
  return { added: r.added, duplicates: r.duplicates, invalid };
}

/** Outbox for the sync engine (src/sync). */
export const attemptOutbox: AttemptOutbox = {
  unsynced: (limit) => selectUnsynced(state.items, limit),
  markSynced: (ids, at) => setItems(applySynced(state.items, ids, at)),
  markRejected: (ids) => setItems(applyRejected(state.items, ids)),
};
