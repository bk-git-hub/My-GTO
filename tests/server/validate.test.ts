import { describe, expect, it } from "vitest";
import { LIMITS } from "../../shared/contracts";
import { validateAttempt } from "../../server/validate";
import { NOW, makeAttempt } from "./helpers";

function reason(input: unknown): string | null {
  const r = validateAttempt(input, NOW);
  return r.ok ? null : r.reason;
}

describe("validateAttempt", () => {
  it("accepts a well-formed attempt and strips unknown fields", () => {
    const a = { ...makeAttempt({ evLossBB: 0.4, detail: "보드 A♠7♦2♣" }), extra: "x", userId: "SOMEONE" };
    const r = validateAttempt(a, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempt).not.toHaveProperty("extra");
    expect(r.attempt).not.toHaveProperty("userId");
    expect(r.attempt.evLossBB).toBe(0.4);
    expect(r.attempt.detail).toBe("보드 A♠7♦2♣");
  });

  it("accepts every quiz kind and grade, and empty keys", () => {
    for (const kind of ["preflop", "stack", "odds", "equity", "play", "postflop", "daily"] as const) {
      expect(reason(makeAttempt({ kind }))).toBeNull();
    }
    for (const grade of ["correct", "mixed", "wrong"] as const) expect(reason(makeAttempt({ grade }))).toBeNull();
    expect(reason(makeAttempt({ keys: [] }))).toBeNull();
  });

  it("rejects wrong types and shapes", () => {
    expect(reason(null)).toBe("not_object");
    expect(reason([])).toBe("not_object");
    expect(reason("x")).toBe("not_object");
    expect(reason({ ...makeAttempt(), id: "not-an-id" })).toBe("bad_id");
    expect(reason({ ...makeAttempt(), id: "01ARZ3NDEKTSV4RRFFQ69G5FAI" })).toBe("bad_id"); // I is not Crockford
    expect(reason({ ...makeAttempt(), v: 2 })).toBe("bad_version");
    expect(reason({ ...makeAttempt(), at: "1700000000000" })).toBe("bad_at");
    expect(reason({ ...makeAttempt(), kind: "river" })).toBe("bad_kind");
    expect(reason({ ...makeAttempt(), keys: "preflop" })).toBe("bad_keys");
    expect(reason({ ...makeAttempt(), keys: [1] })).toBe("bad_keys");
    expect(reason({ ...makeAttempt(), keys: [""] })).toBe("bad_keys");
    expect(reason({ ...makeAttempt(), spot: "" })).toBe("bad_spot");
    expect(reason({ ...makeAttempt(), title: 3 })).toBe("bad_title");
    expect(reason({ ...makeAttempt(), chosen: null })).toBe("bad_chosen");
    expect(reason({ ...makeAttempt(), correct: undefined })).toBe("bad_correct");
    expect(reason({ ...makeAttempt(), grade: "great" })).toBe("bad_grade");
    expect(reason({ ...makeAttempt(), deviceId: "phone" })).toBe("bad_device_id");
    expect(reason({ ...makeAttempt(), detail: 5 })).toBe("bad_detail");
  });

  it("checks the time window", () => {
    expect(reason(makeAttempt({ at: Date.UTC(2023, 11, 31) }))).toBe("bad_at");
    expect(reason(makeAttempt({ at: NOW + 25 * 3600_000 }))).toBe("bad_at");
    expect(reason(makeAttempt({ at: NOW + 23 * 3600_000 }))).toBeNull();
    expect(reason(makeAttempt({ at: Number.NaN }))).toBe("bad_at");
    // at_ms is a Postgres bigint: a fraction would fail the whole batch insert.
    expect(reason(makeAttempt({ at: NOW - 1000.5 }))).toBe("bad_at");
  });

  it("checks evLossBB", () => {
    expect(reason(makeAttempt({ evLossBB: 0 }))).toBeNull();
    expect(reason(makeAttempt({ evLossBB: -0.1 }))).toBe("bad_ev_loss");
    expect(reason(makeAttempt({ evLossBB: Number.POSITIVE_INFINITY }))).toBe("bad_ev_loss");
    expect(reason({ ...makeAttempt(), evLossBB: "1" })).toBe("bad_ev_loss");
    expect(reason({ ...makeAttempt(), evLossBB: null })).toBe("bad_ev_loss");
  });

  it("enforces LIMITS", () => {
    expect(reason(makeAttempt({ keys: Array.from({ length: LIMITS.maxKeys }, (_, i) => `k${i}`) }))).toBeNull();
    expect(reason(makeAttempt({ keys: Array.from({ length: LIMITS.maxKeys + 1 }, (_, i) => `k${i}`) }))).toBe("bad_keys");
    expect(reason(makeAttempt({ keys: ["k".repeat(LIMITS.maxKeyLength + 1)] }))).toBe("bad_keys");
    expect(reason(makeAttempt({ spot: "s".repeat(LIMITS.maxSpotLength) }))).toBeNull();
    expect(reason(makeAttempt({ spot: "s".repeat(LIMITS.maxSpotLength + 1) }))).toBe("bad_spot");
    expect(reason(makeAttempt({ title: "t".repeat(LIMITS.maxTitleLength + 1) }))).toBe("bad_title");
    expect(reason(makeAttempt({ chosen: "c".repeat(LIMITS.maxLabelLength + 1) }))).toBe("bad_chosen");
    expect(reason(makeAttempt({ correct: "c".repeat(LIMITS.maxLabelLength + 1) }))).toBe("bad_correct");
    expect(reason(makeAttempt({ detail: "d".repeat(LIMITS.maxDetailLength) }))).toBeNull();
    expect(reason(makeAttempt({ detail: "d".repeat(LIMITS.maxDetailLength + 1) }))).toBe("bad_detail");
  });

  it("rejects NUL characters (Postgres cannot store them)", () => {
    expect(reason(makeAttempt({ title: "a\u0000b" }))).toBe("bad_title");
  });

  it("rejects lone UTF-16 surrogates (jsonb cannot store them) but keeps pairs", () => {
    expect(reason(makeAttempt({ title: "a\ud83d" }))).toBe("bad_title");
    expect(reason(makeAttempt({ detail: "\ude00b" }))).toBe("bad_detail");
    expect(reason(makeAttempt({ keys: ["k\ud83d"] }))).toBe("bad_keys");
    expect(reason(makeAttempt({ chosen: "\ude00\ud83d" }))).toBe("bad_chosen");
    expect(reason(makeAttempt({ title: "AA 😀 레이즈" }))).toBeNull();
  });
});
