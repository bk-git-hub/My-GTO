/**
 * Storage interface for the /api/v1 server. Two implementations:
 *   - MemoryStore   (store.memory.ts)   tests and the dev-only SERVER_MODE=memory
 *   - PostgresStore (store.postgres.ts) production, over an injected SqlClient
 *
 * Pull cursors are opaque strings. Both stores use a server-assigned, per-user
 * monotonically increasing sequence (decimal string), NOT the attempt id: attempt ids
 * carry the client's clock, so a device that syncs late would otherwise upload ids
 * "behind" a cursor another device already passed, and those attempts would never be pulled.
 */

import type { Attempt, Plan } from "../shared/contracts.js";

export interface UserRecord {
  id: string;
  /** Epoch ms. */
  createdAt: number;
}

export interface InsertResult {
  /** Newly stored ids. */
  accepted: string[];
  /** Ids the user already had. */
  duplicates: string[];
}

export interface AttemptPage {
  attempts: Attempt[];
  /** Cursor of the last returned attempt; null when the page is empty. */
  cursor: string | null;
}

export interface Store {
  /** User that owns this device; creates both on first sight. */
  getOrCreateUserForDevice(deviceId: string, newUserId: string, now: number): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | null>;
  /** Idempotent by (userId, attempt.id). Attempts must already be validated. */
  insertAttempts(userId: string, attempts: Attempt[], now: number): Promise<InsertResult>;
  /** Attempts stored after `after` (exclusive), oldest first. `after` must satisfy isCursor or be null. */
  listAttempts(userId: string, after: string | null, limit: number): Promise<AttemptPage>;
  /** Current counter value for (user, metric, period), 0 when absent. */
  getUsage(userId: string, metric: string, period: string): Promise<number>;
  /**
   * Atomically adds 1 if the counter is below `limit`.
   * Returns the counter after the call and whether the increment happened.
   */
  consumeUsage(userId: string, metric: string, period: string, limit: number): Promise<{ allowed: boolean; used: number }>;
  /** "pro" when the user has an active pro entitlement at `now`. */
  getPlan(userId: string, now: number): Promise<Plan>;
}

/** Cursor format shared by both stores: positive decimal sequence number. */
export function isCursor(value: string): boolean {
  return /^[1-9][0-9]{0,17}$/.test(value);
}
