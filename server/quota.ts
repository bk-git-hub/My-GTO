/**
 * AI coach quota: requests per user per KST day, by plan.
 */

import type { MeResponse, Plan } from "../shared/contracts.js";
import type { Store } from "./store.js";

/** Coach requests per KST day. */
export const COACH_DAILY_LIMIT_FREE = 5;
export const COACH_DAILY_LIMIT_PRO = 100;
export const COACH_DAILY_LIMIT: Record<Plan, number> = { free: COACH_DAILY_LIMIT_FREE, pro: COACH_DAILY_LIMIT_PRO };
export const COACH_METRIC = "coach";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** KST calendar date, e.g. "2026-11-05". Used as the usage period key and the daily-quiz seed. */
export function kstDateKey(now: number): string {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of the next KST midnight after `now`. */
export function nextKstMidnight(now: number): number {
  return Math.floor((now + KST_OFFSET_MS) / DAY_MS + 1) * DAY_MS - KST_OFFSET_MS;
}

export type CoachQuota = MeResponse["coach"];

/** Read-only view of today's coach usage. */
export async function getCoachQuota(store: Store, userId: string, plan: Plan, now: number): Promise<CoachQuota> {
  const used = await store.getUsage(userId, COACH_METRIC, kstDateKey(now));
  return { used, limit: COACH_DAILY_LIMIT[plan], resetsAt: nextKstMidnight(now) };
}

/** Check-and-increment in one atomic store call. `ok: false` means the request must be refused. */
export async function consumeCoachQuota(store: Store, userId: string, plan: Plan, now: number): Promise<{ ok: boolean; quota: CoachQuota }> {
  const limit = COACH_DAILY_LIMIT[plan];
  const { allowed, used } = await store.consumeUsage(userId, COACH_METRIC, kstDateKey(now), limit);
  return { ok: allowed, quota: { used, limit, resetsAt: nextKstMidnight(now) } };
}
