/**
 * Postgres Store over a minimal injected SqlClient (no driver dependency yet).
 *
 * Production wiring (Phase 1) will use @neondatabase/serverless, roughly:
 *   import { Pool } from "@neondatabase/serverless";
 *   const pool = new Pool({ connectionString: env.DATABASE_URL });
 *   const store = new PostgresStore({ query: (text, params) => pool.query(text, params) });
 * Schema: server/db/migrations/001_init.sql. Every statement is parameterized;
 * user input never becomes part of SQL text.
 */

import type { Attempt, Plan } from "../shared/contracts.js";
import type { AttemptPage, InsertResult, Store, UserRecord } from "./store.js";

export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params: unknown[]): Promise<{ rows: T[] }>;
}

export class PostgresStore implements Store {
  private readonly sql: SqlClient;

  constructor(sql: SqlClient) {
    this.sql = sql;
  }

  async getOrCreateUserForDevice(deviceId: string, newUserId: string, now: number): Promise<UserRecord> {
    const found = await this.findDeviceUser(deviceId, now);
    if (found) return found;
    // One statement: create the user, then the device row. If another request created the
    // device in the meantime, the device is left alone and we read the winner below (the
    // loser's user row stays empty; a cleanup job removes users with no devices and attempts).
    // A device whose account was deleted moves to the new account.
    await this.sql.query(
      `WITH new_user AS (
         INSERT INTO users (id, created_at) VALUES ($2, to_timestamp($3::double precision / 1000))
         RETURNING id
       )
       INSERT INTO devices (device_id, user_id, created_at, last_seen_at)
       SELECT $1, id, to_timestamp($3::double precision / 1000), to_timestamp($3::double precision / 1000) FROM new_user
       ON CONFLICT (device_id) DO UPDATE SET user_id = EXCLUDED.user_id, secret_hash = NULL, last_seen_at = EXCLUDED.last_seen_at
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = devices.user_id AND u.deleted_at IS NOT NULL)`,
      [deviceId, newUserId, now],
    );
    const created = await this.findDeviceUser(deviceId, now);
    if (!created) throw new Error("device user not found after insert");
    return created;
  }

  private async findDeviceUser(deviceId: string, now: number): Promise<UserRecord | null> {
    const { rows } = await this.sql.query<{ id: string; created_ms: string | number }>(
      `UPDATE devices d SET last_seen_at = to_timestamp($2::double precision / 1000)
       FROM users u
       WHERE d.device_id = $1 AND u.id = d.user_id AND u.deleted_at IS NULL
       RETURNING u.id, (extract(epoch FROM u.created_at) * 1000)::bigint AS created_ms`,
      [deviceId, now],
    );
    return rows[0] ? { id: rows[0].id, createdAt: Number(rows[0].created_ms) } : null;
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const { rows } = await this.sql.query<{ id: string; created_ms: string | number }>(
      `SELECT id, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    return rows[0] ? { id: rows[0].id, createdAt: Number(rows[0].created_ms) } : null;
  }

  async insertAttempts(userId: string, attempts: Attempt[]): Promise<InsertResult> {
    if (attempts.length === 0) return { accepted: [], duplicates: [] };
    const sorted = [...attempts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const input = sorted.map((a) => ({
      id: a.id,
      kind: a.kind,
      at_ms: a.at,
      grade: a.grade,
      spot: a.spot,
      device_id: a.deviceId,
      payload: a,
    }));
    // `FOR UPDATE` on the user row serializes pushes of the same user, so per-user `seq`
    // values become visible in order and a concurrent pull can never skip one.
    const { rows } = await this.sql.query<{ id: string }>(
      `WITH locked AS (
         SELECT id FROM users WHERE id = $1 FOR UPDATE
       ), input AS (
         SELECT * FROM jsonb_to_recordset($2::jsonb)
           AS x(id text, kind text, at_ms bigint, grade text, spot text, device_id text, payload jsonb)
       ), ins AS (
         INSERT INTO attempts (user_id, id, kind, at, grade, spot, device_id, payload)
         SELECT locked.id, input.id, input.kind, to_timestamp(input.at_ms::double precision / 1000),
                input.grade, input.spot, input.device_id, input.payload
         FROM input CROSS JOIN locked
         ORDER BY input.id
         ON CONFLICT (user_id, id) DO NOTHING
         RETURNING id
       )
       SELECT id FROM ins`,
      [userId, JSON.stringify(input)],
    );
    const inserted = new Set(rows.map((r) => r.id));
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const a of sorted) (inserted.has(a.id) ? accepted : duplicates).push(a.id);
    return { accepted, duplicates };
  }

  async listAttempts(userId: string, after: string | null, limit: number): Promise<AttemptPage> {
    const { rows } = await this.sql.query<{ seq: string | number; payload: Attempt | string }>(
      `SELECT seq::text AS seq, payload FROM attempts
       WHERE user_id = $1 AND seq > $2::bigint
       ORDER BY seq
       LIMIT $3`,
      [userId, after ?? "0", limit],
    );
    return {
      attempts: rows.map((r) => (typeof r.payload === "string" ? (JSON.parse(r.payload) as Attempt) : r.payload)),
      cursor: rows.length > 0 ? String(rows[rows.length - 1].seq) : null,
    };
  }

  async getUsage(userId: string, metric: string, period: string): Promise<number> {
    const { rows } = await this.sql.query<{ count: string | number }>(
      `SELECT count FROM usage_counters WHERE user_id = $1 AND metric = $2 AND period = $3`,
      [userId, metric, period],
    );
    return rows[0] ? Number(rows[0].count) : 0;
  }

  async consumeUsage(userId: string, metric: string, period: string, limit: number): Promise<{ allowed: boolean; used: number }> {
    if (limit <= 0) return { allowed: false, used: await this.getUsage(userId, metric, period) };
    const { rows } = await this.sql.query<{ count: string | number }>(
      `INSERT INTO usage_counters (user_id, metric, period, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_id, metric, period)
       DO UPDATE SET count = usage_counters.count + 1
       WHERE usage_counters.count < $4
       RETURNING count`,
      [userId, metric, period, limit],
    );
    if (rows[0]) return { allowed: true, used: Number(rows[0].count) };
    return { allowed: false, used: await this.getUsage(userId, metric, period) };
  }

  async getPlan(userId: string, now: number): Promise<Plan> {
    const { rows } = await this.sql.query<{ entitlement: string }>(
      `SELECT entitlement FROM entitlements
       WHERE user_id = $1 AND entitlement = 'pro'
         AND (expires_at IS NULL OR expires_at > to_timestamp($2::double precision / 1000))
       LIMIT 1`,
      [userId, now],
    );
    return rows.length > 0 ? "pro" : "free";
  }
}
