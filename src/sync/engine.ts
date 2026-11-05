/**
 * Sync engine: copies the local attempt log to the server. Local-first: the app never
 * waits on this, and a failure only means "try again later".
 * Nothing calls it yet (Phase 1 wires it to app start / visibility change / after answers).
 */

import { LIMITS, type Attempt, type AttemptOutbox, type SyncPushResponse } from "../../shared/contracts";
import { SyncApiError, type SyncApi } from "./api";

export interface SyncError {
  status: number;
  code: string;
  message: string;
  retryAfterMs?: number;
}

export interface SyncSummary {
  /** Attempts newly stored on the server. */
  pushed: number;
  /** Attempts the server already had (also marked synced). */
  duplicates: number;
  /** Attempts the server refused (marked rejected, not retried). */
  rejected: number;
  /** Push requests made. */
  batches: number;
  /** Set when the run stopped early; unsynced attempts stay in the outbox. */
  error?: SyncError;
}

export interface SyncOnceOptions {
  api: SyncApi;
  outbox: AttemptOutbox;
  /** Bearer token. `refresh: true` after a 401: re-run anonymous auth and return a new token. */
  getToken: (refresh: boolean) => Promise<string>;
  now: () => number;
  /** Safety cap on push requests per run (default 50 = 10,000 attempts). */
  maxBatches?: number;
}

function toSyncError(e: unknown): SyncError {
  if (e instanceof SyncApiError) return { status: e.status, code: e.code, message: e.message, retryAfterMs: e.retryAfterMs };
  return { status: 0, code: "client", message: e instanceof Error ? e.message : String(e) };
}

/** Pushes the outbox in batches of LIMITS.pushBatch until it is empty or something fails. */
export async function syncOnce(options: SyncOnceOptions): Promise<SyncSummary> {
  const { api, outbox, getToken, now, maxBatches = 50 } = options;
  const summary: SyncSummary = { pushed: 0, duplicates: 0, rejected: 0, batches: 0 };
  let token: string | null = null;
  let refreshed = false;

  while (summary.batches < maxBatches) {
    const batch = outbox.unsynced(LIMITS.pushBatch);
    if (batch.length === 0) break;
    const batchIds = new Set(batch.map((a: Attempt) => a.id));

    let res: SyncPushResponse;
    try {
      token ??= await getToken(false);
      summary.batches++;
      try {
        res = await api.push(token, { attempts: batch });
      } catch (e) {
        if (!(e instanceof SyncApiError) || e.status !== 401 || refreshed) throw e;
        refreshed = true;
        token = await getToken(true);
        res = await api.push(token, { attempts: batch });
      }
    } catch (e) {
      summary.error = toSyncError(e);
      return summary;
    }

    // Only trust ids that were actually in this batch.
    const synced = [...res.accepted, ...res.duplicates].filter((id) => batchIds.has(id));
    const rejected = res.rejected.map((r) => r.id).filter((id) => batchIds.has(id));
    if (synced.length > 0) outbox.markSynced(synced, now());
    if (rejected.length > 0) outbox.markRejected(rejected);
    summary.pushed += res.accepted.filter((id) => batchIds.has(id)).length;
    summary.duplicates += res.duplicates.filter((id) => batchIds.has(id)).length;
    summary.rejected += rejected.length;

    if (synced.length + rejected.length === 0) {
      // The server answered but settled nothing: stop instead of looping on the same batch.
      summary.error = { status: 0, code: "no_progress", message: "서버가 아무 기록도 처리하지 않았어요." };
      return summary;
    }
  }
  return summary;
}

export interface PullOptions {
  api: SyncApi;
  getToken: (refresh: boolean) => Promise<string>;
  /** Last cursor the app saved, or null for everything. */
  after: string | null;
  /** Called per page; save `cursor` only after the attempts are stored locally. */
  onPage: (attempts: Attempt[], cursor: string) => void | Promise<void>;
  maxPages?: number;
}

/**
 * Downloads attempts (from all of the user's devices) page by page.
 * The server returns cursor=null on an empty page; the caller keeps its last saved cursor.
 */
export async function pullAll(options: PullOptions): Promise<{ pulled: number; cursor: string | null; error?: SyncError }> {
  const { api, getToken, onPage, maxPages = 20 } = options;
  let cursor = options.after;
  let pulled = 0;
  try {
    const token = await getToken(false);
    for (let i = 0; i < maxPages; i++) {
      const page = await api.pull(token, cursor);
      if (page.cursor === null || page.attempts.length === 0) break;
      await onPage(page.attempts, page.cursor);
      pulled += page.attempts.length;
      cursor = page.cursor;
    }
  } catch (e) {
    return { pulled, cursor, error: toSyncError(e) };
  }
  return { pulled, cursor };
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

/**
 * Delay before the next sync attempt after `failures` consecutive failures
 * (exponential with full jitter). A server Retry-After wins when it is longer.
 */
export function nextBackoffMs(failures: number, error?: SyncError, options: BackoffOptions = {}): number {
  const { baseMs = 5_000, maxMs = 15 * 60_000, random = Math.random } = options;
  if (failures <= 0) return 0;
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 20));
  const jittered = Math.round(cap / 2 + random() * (cap / 2));
  return Math.max(jittered, error?.retryAfterMs ?? 0);
}

/** Errors worth retrying later. 4xx other than 401/408/429 mean the request itself is wrong. */
export function isRetryable(error: SyncError): boolean {
  if (error.status === 0) return error.code !== "client";
  return error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500;
}
