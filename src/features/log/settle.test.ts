import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seatsBetween } from "./fastLog";
import { deleteTourneyAll, isPending, saveNewFast, settleHands, settleSpan } from "./fastTourney";
import { emptyHand, handLogStore, type HandLogState, type LoggedHand } from "./handLog";
import type { Tourney } from "./tourney";

const MIN = 60_000;
const T0 = new Date(2026, 10, 19, 19, 0).getTime();
const rec = (id: string, extra: Partial<Tourney> = {}): Tourney => ({ id, createdAt: T0, updatedAt: T0, activeAt: T0, name: "", memo: "", start: T0, startStack: 50_000, ...extra });
const hand = (id: string, at: number, extra: Partial<LoggedHand> = {}): LoggedHand => ({ ...emptyHand(5), id, createdAt: at, updatedAt: at, seat: "BTN", fast: true, tourney: "t", ...extra });
const store = (extra: Partial<HandLogState> = {}) => handLogStore.set({ hands: [], lastLevel: null, ...extra });
const get = (id: string) => handLogStore.get().hands.find((h) => h.id === id) as LoggedHand;

const initial = handLogStore.get();
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + 60 * MIN);
  store();
});
afterEach(() => {
  handLogStore.set(initial);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("⏳ hands", () => {
  it("are a sign with no chips; one alone is filled by the 칩 업데이트 after it, the other hands' chips taken off", () => {
    const hands = [
      hand("f1", T0 + MIN, { result: "fold", net: -300 }),
      hand("p1", T0 + 2 * MIN, { result: "win", net: null }),
      hand("f2", T0 + 3 * MIN, { result: "fold", net: 0 }),
    ];
    store({ hands, tourneys: [rec("t", { checks: [{ at: T0 + 4 * MIN, stack: 61_700 }] })] });
    expect(hands.map(isPending)).toEqual([false, true, false]);
    const span = settleSpan(handLogStore.get(), "t");
    expect(span).toMatchObject({ total: 12_000, end: null });
    expect(span?.pending.map((h) => h.id)).toEqual(["p1"]);
    expect(settleHands("t", new Map([["p1", 12_000]]))).toBe(true);
    expect(get("p1")).toMatchObject({ net: 12_000, result: "win" });
    expect(settleSpan(handLogStore.get(), "t")).toBeNull();
  });

  it("leaves several to be split, and nothing when a hand between has no chips (a blind's fold with no level)", () => {
    const hands = [hand("p1", T0 + MIN, { result: "win", net: null }), hand("p2", T0 + 2 * MIN, { result: "lose", net: null })];
    store({ hands, tourneys: [rec("t", { checks: [{ at: T0 + 3 * MIN, stack: 58_000 }] })] });
    const span = settleSpan(handLogStore.get(), "t");
    expect(span?.pending.map((h) => h.id)).toEqual(["p1", "p2"]);
    expect(span?.total).toBe(8_000);
    store({ hands: [...hands, hand("b", T0 + 90_000, { seat: "BB", result: "fold", net: null })], tourneys: [rec("t", { checks: [{ at: T0 + 3 * MIN, stack: 58_000 }] })] });
    expect(settleSpan(handLogStore.get(), "t")).toBeNull();
  });

  it("are ended by a 스택 hand with its own chips unknown: it takes what they don't", () => {
    const hands = [hand("p1", T0 + MIN, { result: "win", net: null }), hand("s", T0 + 2 * MIN, { fastStack: true, stack: 70_000, net: null, result: null })];
    store({ hands, tourneys: [rec("t")] });
    const span = settleSpan(handLogStore.get(), "t");
    expect(span).toMatchObject({ total: 20_000 });
    expect(span?.end?.id).toBe("s");
    expect(settleHands("t", new Map([["p1", 15_000]]))).toBe(true);
    expect(get("s")).toMatchObject({ net: 5_000, stack: 65_000, result: "win" });
  });
});

describe("the seats skipped", () => {
  it("are the seats dealt between, going round (UTG, then BB and SB, then the button)", () => {
    expect(seatsBetween(9, "UTG", "BTN")).toEqual(["BB", "SB"]);
    expect(seatsBetween(9, "BTN", "CO")).toEqual([]);
    expect(seatsBetween(9, "BTN", "BTN")).toEqual([]);
    expect(seatsBetween(6, "UTG+2", "BTN")).toEqual([]);
  });

  it("go on file with the hand in one write, in its tournament", () => {
    store({ hands: [hand("a", T0 + MIN)], tourneys: [rec("t", { activeAt: T0 + MIN })] });
    const fill = hand("x", T0 + 2 * MIN, { seat: "CO", result: "fold", net: 0, tourney: undefined });
    const r = saveNewFast(hand("b", T0 + 3 * MIN, { seat: "HJ", tourney: undefined }), T0 + 3 * MIN, [fill]);
    expect(r.ok).toBe(true);
    expect(handLogStore.get().hands.map((h) => [h.id, h.tourney])).toEqual([["b", "t"], ["x", "t"], ["a", "t"]]);
    expect(deleteTourneyAll("t")).toBe(true);
    expect(handLogStore.get().hands).toEqual([]);
  });
});
