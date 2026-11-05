/**
 * In-memory Store for tests and local experiments.
 * DEV ONLY: on Vercel every function instance has its own copy and loses it on cold start.
 */

import type { Attempt, Plan } from "../shared/contracts.js";
import type { AttemptPage, InsertResult, Store, UserRecord } from "./store.js";

interface StoredAttempt {
  seq: number;
  attempt: Attempt;
}

export class MemoryStore implements Store {
  private users = new Map<string, UserRecord>();
  private devices = new Map<string, string>();
  private attempts = new Map<string, StoredAttempt[]>();
  private attemptIds = new Map<string, Set<string>>();
  private usage = new Map<string, number>();
  private entitlements = new Map<string, number | null>();
  private seq = 0;

  async getOrCreateUserForDevice(deviceId: string, newUserId: string, now: number): Promise<UserRecord> {
    const existing = this.devices.get(deviceId);
    if (existing) {
      const user = this.users.get(existing);
      if (user) return user;
    }
    const user: UserRecord = { id: newUserId, createdAt: now };
    this.users.set(user.id, user);
    this.devices.set(deviceId, user.id);
    return user;
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async insertAttempts(userId: string, attempts: Attempt[]): Promise<InsertResult> {
    const ids = this.attemptIds.get(userId) ?? new Set<string>();
    const list = this.attempts.get(userId) ?? [];
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const attempt of [...attempts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (ids.has(attempt.id)) {
        duplicates.push(attempt.id);
        continue;
      }
      ids.add(attempt.id);
      list.push({ seq: ++this.seq, attempt: structuredClone(attempt) });
      accepted.push(attempt.id);
    }
    this.attemptIds.set(userId, ids);
    this.attempts.set(userId, list);
    return { accepted, duplicates };
  }

  async listAttempts(userId: string, after: string | null, limit: number): Promise<AttemptPage> {
    const from = after === null ? 0 : Number(after);
    const page = (this.attempts.get(userId) ?? []).filter((s) => s.seq > from).slice(0, limit);
    return {
      attempts: page.map((s) => structuredClone(s.attempt)),
      cursor: page.length > 0 ? String(page[page.length - 1].seq) : null,
    };
  }

  async getUsage(userId: string, metric: string, period: string): Promise<number> {
    return this.usage.get(`${userId}|${metric}|${period}`) ?? 0;
  }

  async consumeUsage(userId: string, metric: string, period: string, limit: number): Promise<{ allowed: boolean; used: number }> {
    const key = `${userId}|${metric}|${period}`;
    const used = this.usage.get(key) ?? 0;
    if (used >= limit) return { allowed: false, used };
    this.usage.set(key, used + 1);
    return { allowed: true, used: used + 1 };
  }

  async getPlan(userId: string, now: number): Promise<Plan> {
    if (!this.entitlements.has(userId)) return "free";
    const expiresAt = this.entitlements.get(userId);
    return expiresAt === null || (expiresAt !== undefined && expiresAt > now) ? "pro" : "free";
  }

  /** Test/dev helper: grant pro until `expiresAt` (null = no expiry). Real grants come from payment webhooks. */
  grantPro(userId: string, expiresAt: number | null): void {
    this.entitlements.set(userId, expiresAt);
  }
}
