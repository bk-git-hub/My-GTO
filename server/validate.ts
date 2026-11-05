/**
 * Server-side validation of attempts sent by clients. Never trust the client:
 * every field is type-checked, bounded by LIMITS, and unknown fields are dropped.
 */

import { LIMITS, QUIZ_KINDS, SCHEMA_VERSION, type Attempt, type AttemptGrade, type QuizKind } from "../shared/contracts.js";
import { isId } from "../shared/ids.js";

export type ValidationResult = { ok: true; attempt: Attempt } | { ok: false; reason: string };

/** Earliest accepted `at` (the app did not exist before this). */
export const MIN_ATTEMPT_AT = Date.UTC(2024, 0, 1);
/** Allowed clock skew into the future. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
/** Sanity cap for EV loss in big blinds. */
export const MAX_EV_LOSS_BB = 10_000;

const GRADES: readonly AttemptGrade[] = ["correct", "mixed", "wrong"];

/** A UTF-16 surrogate without its partner (not well-formed; jsonb rejects it). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function boundedString(value: unknown, max: number, allowEmpty: boolean): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && value.length === 0) return false;
  if (value.length > max) return false;
  // Postgres text/jsonb cannot store NUL characters or lone surrogates; one such
  // value would fail the whole batch insert (500) instead of one rejected item.
  return !value.includes("\u0000") && !LONE_SURROGATE.test(value);
}

export function validateAttempt(input: unknown, now: number = Date.now()): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "not_object" };
  const a = input as Record<string, unknown>;

  if (!isId(a.id)) return { ok: false, reason: "bad_id" };
  if (a.v !== SCHEMA_VERSION) return { ok: false, reason: "bad_version" };
  // Integer only: `at_ms` is a Postgres bigint, and a fraction fails the whole batch.
  if (typeof a.at !== "number" || !Number.isInteger(a.at) || a.at < MIN_ATTEMPT_AT || a.at > now + MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: "bad_at" };
  }
  if (typeof a.kind !== "string" || !(QUIZ_KINDS as readonly string[]).includes(a.kind)) return { ok: false, reason: "bad_kind" };
  if (!Array.isArray(a.keys) || a.keys.length > LIMITS.maxKeys) return { ok: false, reason: "bad_keys" };
  for (const k of a.keys) if (!boundedString(k, LIMITS.maxKeyLength, false)) return { ok: false, reason: "bad_keys" };
  if (!boundedString(a.spot, LIMITS.maxSpotLength, false)) return { ok: false, reason: "bad_spot" };
  if (!boundedString(a.title, LIMITS.maxTitleLength, true)) return { ok: false, reason: "bad_title" };
  if (!boundedString(a.chosen, LIMITS.maxLabelLength, true)) return { ok: false, reason: "bad_chosen" };
  if (!boundedString(a.correct, LIMITS.maxLabelLength, true)) return { ok: false, reason: "bad_correct" };
  if (typeof a.grade !== "string" || !(GRADES as readonly string[]).includes(a.grade)) return { ok: false, reason: "bad_grade" };
  if (a.evLossBB !== undefined) {
    if (typeof a.evLossBB !== "number" || !Number.isFinite(a.evLossBB) || a.evLossBB < 0 || a.evLossBB > MAX_EV_LOSS_BB) {
      return { ok: false, reason: "bad_ev_loss" };
    }
  }
  if (a.detail !== undefined && !boundedString(a.detail, LIMITS.maxDetailLength, true)) return { ok: false, reason: "bad_detail" };
  if (!isId(a.deviceId)) return { ok: false, reason: "bad_device_id" };

  // Rebuild from known fields only (unknown fields are stripped).
  const attempt: Attempt = {
    id: a.id,
    v: SCHEMA_VERSION,
    at: a.at,
    kind: a.kind as QuizKind,
    keys: [...(a.keys as string[])],
    spot: a.spot,
    title: a.title,
    chosen: a.chosen,
    correct: a.correct,
    grade: a.grade as AttemptGrade,
    deviceId: a.deviceId,
  };
  if (typeof a.evLossBB === "number") attempt.evLossBB = a.evLossBB;
  if (typeof a.detail === "string") attempt.detail = a.detail;
  return { ok: true, attempt };
}
