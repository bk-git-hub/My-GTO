import { describe, expect, it } from "vitest";
import { LIMITS, type Attempt } from "../../shared/contracts";
import { newId } from "../../shared/ids";
import {
  truncate,
  appendAttempt,
  applyRejected,
  applySynced,
  buildAttempt,
  buildExport,
  capAttempts,
  mergeAttempts,
  parseImport,
  parseStored,
  recordAttempt,
  sanitizeAttempt,
  selectUnsynced,
  stripOldDetails,
  attemptOutbox,
  attemptsStore,
  clearAttempts,
  type AttemptInput,
  type LocalAttempt,
} from "./attempts";

const DEV = newId(1_700_000_000_000);
const input = (over: Partial<AttemptInput> = {}): AttemptInput => ({
  kind: "preflop",
  keys: ["preflop", "preflop:pub/deep/rfi-btn"],
  spot: "preflop:pub/deep/rfi-btn:A5s",
  title: "BTN 오픈 · 딥 · A5s",
  chosen: "레이즈",
  correct: "레이즈 100%",
  grade: "correct",
  ...over,
});
let t = 1_700_000_000_000;
const make = (over: Partial<AttemptInput> = {}, extra: Partial<LocalAttempt> = {}): LocalAttempt => ({
  ...buildAttempt(input(over), DEV, (t += 1000)),
  ...extra,
});

describe("buildAttempt", () => {
  it("fills id/v/deviceId and truncates long strings to LIMITS", () => {
    const a = buildAttempt(
      input({ title: "가".repeat(500), detail: "x".repeat(5000), keys: Array.from({ length: 20 }, (_, i) => `k${i}${"y".repeat(200)}`), evLossBB: 1.23456 }),
      DEV,
      123456,
    );
    expect(a.v).toBe(1);
    expect(a.at).toBe(123456);
    expect(a.deviceId).toBe(DEV);
    expect(a.title.length).toBe(LIMITS.maxTitleLength);
    expect(a.detail!.length).toBe(LIMITS.maxDetailLength);
    expect(a.keys.length).toBe(LIMITS.maxKeys);
    expect(a.keys.every((k) => k.length <= LIMITS.maxKeyLength)).toBe(true);
    expect(a.evLossBB).toBe(1.23);
    expect(sanitizeAttempt(a)).toEqual(a);
  });

  it("drops non-finite or negative EV loss", () => {
    expect(buildAttempt(input({ evLossBB: NaN }), DEV, 1).evLossBB).toBeUndefined();
    expect(buildAttempt(input({ evLossBB: -0.4 }), DEV, 1).evLossBB).toBe(0);
  });
});

describe("appendAttempt / capAttempts", () => {
  it("appends oldest-first and keeps order when an older attempt arrives late", () => {
    const a = make();
    const b = make();
    const c = make();
    expect(appendAttempt([a, b], c).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(appendAttempt([a, c], b).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  });

  it("drops the oldest synced attempts first, then the oldest", () => {
    const old = make();
    const synced1 = make({}, { syncedAt: 1 });
    const mid = make();
    const synced2 = make({}, { syncedAt: 2 });
    const rejected = make({}, { rejected: true });
    const newest = make();
    const list = [old, synced1, mid, synced2, rejected, newest];
    expect(capAttempts(list, 6)).toBe(list);
    expect(capAttempts(list, 5).map((x) => x.id)).toEqual([old.id, mid.id, synced2.id, rejected.id, newest.id]);
    expect(capAttempts(list, 3).map((x) => x.id)).toEqual([old.id, mid.id, newest.id]);
    // Everything synced/rejected is gone, so the oldest unsynced goes next.
    expect(capAttempts(list, 2).map((x) => x.id)).toEqual([mid.id, newest.id]);
  });

  it("caps on append", () => {
    let list: LocalAttempt[] = [];
    for (let i = 0; i < 12; i++) list = appendAttempt(list, make(), 10);
    expect(list.length).toBe(10);
  });
});

describe("import / export", () => {
  it("round-trips an export without sync state", () => {
    const a = make({}, { syncedAt: 99 });
    const b = make({ grade: "wrong", evLossBB: 2.5, detail: "보드 As Kd 7c" });
    const { attempts, invalid } = parseImport(buildExport([a, b], 5));
    expect(invalid).toBe(0);
    expect(attempts.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(attempts[0].syncedAt).toBeUndefined();
    expect(attempts[1]).toEqual(b);
  });

  it("accepts a bare array and counts invalid rows", () => {
    const good = make();
    const rows = [
      good,
      { ...make(), id: "nope" },
      { ...make(), kind: "poker" },
      { ...make(), grade: "great" },
      { ...make(), v: 2 },
      { ...make(), keys: [1, 2] },
      { ...make(), evLossBB: "1" },
      null,
      "text",
    ];
    const r = parseImport(JSON.stringify(rows));
    expect(r.attempts.map((x) => x.id)).toEqual([good.id]);
    expect(r.invalid).toBe(8);
  });

  it("throws a readable error on non-JSON or a foreign file", () => {
    expect(() => parseImport("not json")).toThrow(/JSON/);
    expect(() => parseImport('{"hello":1}')).toThrow(/PubAZ/);
  });

  it("merges by id: existing rows win, duplicates are counted, order is restored", () => {
    const a = make();
    const b = make();
    const c = make();
    const changedB = { ...b, title: "바뀐 제목" };
    const r = mergeAttempts([a, c], [changedB, b, a]);
    expect(r.added).toBe(1);
    expect(r.duplicates).toBe(2);
    expect(r.list.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(r.list[1].title).toBe("바뀐 제목");
    const again = mergeAttempts(r.list, [a, b, c]);
    expect(again.added).toBe(0);
    expect(again.list).toBe(r.list);
  });

  it("applies the cap when a merge overflows", () => {
    const existing = [make({}, { syncedAt: 1 }), make()];
    const r = mergeAttempts(existing, [make(), make()], 3);
    expect(r.list.length).toBe(3);
    expect(r.list.some((x) => x.syncedAt)).toBe(false);
  });

  it("parseStored keeps sync state, drops broken rows and dupes, survives garbage", () => {
    const a = make({}, { syncedAt: 7 });
    const b = make({}, { rejected: true });
    const stored = parseStored(JSON.stringify([b, a, a, { bad: true }]));
    expect(stored.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(stored[0].syncedAt).toBe(7);
    expect(stored[1].rejected).toBe(true);
    expect(parseStored("{{{")).toEqual([]);
    expect(parseStored(null)).toEqual([]);
    expect(parseStored('{"a":1}')).toEqual([]);
  });
});

describe("outbox semantics", () => {
  it("lists unsynced oldest-first, skipping synced and rejected, without local fields", () => {
    const a = make();
    const b = make({}, { syncedAt: 5 });
    const c = make({}, { rejected: true });
    const d = make();
    const e = make();
    const list = [a, b, c, d, e];
    const out = selectUnsynced(list, 2);
    expect(out.map((x) => x.id)).toEqual([a.id, d.id]);
    expect(out.every((x: Attempt) => !("syncedAt" in x) && !("rejected" in x))).toBe(true);
    expect(selectUnsynced(list, 0)).toEqual([]);
  });

  it("markSynced / markRejected are immutable and idempotent", () => {
    const a = make();
    const b = make();
    const list = [a, b];
    const synced = applySynced(list, [a.id, "unknown"], 1000);
    expect(list[0].syncedAt).toBeUndefined();
    expect(synced[0].syncedAt).toBe(1000);
    expect(applySynced(synced, [a.id], 2000)[0].syncedAt).toBe(1000);
    expect(applySynced(synced, [a.id], 2000)).toBe(synced);
    const rejected = applyRejected(synced, [b.id]);
    expect(rejected[1].rejected).toBe(true);
    expect(selectUnsynced(rejected, 10)).toEqual([]);
    expect(applyRejected(rejected, [b.id])).toBe(rejected);
  });

  it("works end to end through the store without localStorage", () => {
    clearAttempts();
    const x = recordAttempt(input(), 1000);
    const y = recordAttempt(input({ grade: "wrong" }), 2000);
    expect(attemptsStore.items().map((a) => a.id)).toEqual([x.id, y.id]);
    expect(x.deviceId).toBe(y.deviceId);
    expect(attemptOutbox.unsynced(10).map((a) => a.id)).toEqual([x.id, y.id]);
    attemptOutbox.markSynced([x.id], 3000);
    attemptOutbox.markRejected([y.id]);
    expect(attemptOutbox.unsynced(10)).toEqual([]);
    expect(attemptsStore.get().saveFailed).toBe(false);
    clearAttempts();
    expect(attemptsStore.items()).toEqual([]);
  });
});

describe("stripOldDetails", () => {
  it("removes detail from all but the newest rows", () => {
    const list = [make({ detail: "a" }), make({ detail: "b" }), make({ detail: "c" })];
    const out = stripOldDetails(list, 1);
    expect(out.map((x) => x.detail)).toEqual([undefined, undefined, "c"]);
    expect(list[0].detail).toBe("a");
  });
});

describe("truncate (server-safe strings)", () => {
  it("never splits a surrogate pair and replaces lone surrogates", () => {
    const emoji = "🂡"; // one surrogate pair
    const cut = truncate("ab" + emoji + "cd", 4); // would end between the pair
    expect(cut).toBe("ab…");
    expect(truncate("x\ud83dy", 10)).toBe("x�y");
    expect(truncate("a" + emoji, 10)).toBe("a" + emoji);
  });
});
