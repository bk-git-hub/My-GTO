import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fastLevel, fastStore, type FastState } from "./fastLog";
import {
  autoTourney,
  cancelNewTourney,
  currentTourney,
  deleteTourney,
  editTourney,
  fastEstimate,
  fastSession,
  fieldsBlock,
  fieldsOf,
  groupChips,
  groupFor,
  infoOf,
  newFields,
  previousTourney,
  resumeTourney,
  setFastStartClock,
  stampPick,
  stampStoredPick,
  startTourney,
  TOURNEY_IDLE_MS,
  tourneyEstimate,
  tourneyForNew,
  tourneyGroups,
  tourneyHands,
  tourneyTitle,
  tourneyWhen,
} from "./fastTourney";
import { emptyHand, handLogStore, levelEstimateAt, localDay, saveHand, type HandLogState, type LoggedHand } from "./handLog";
import { cleanTourneys, withTourney, type Tourney } from "./tourney";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 22:05 on a Tuesday night, and that night's 19:00 start: Lv9. */
const NIGHT = new Date(2026, 10, 17, 22, 5).getTime();
const START = new Date(2026, 10, 17, 19, 0).getTime();
const DAY_START = { day: localDay(NIGHT), clock: "19:00" };

const rec = (id: string, extra: Partial<Tourney> = {}): Tourney => ({ id, createdAt: START, updatedAt: START, activeAt: START, name: "", memo: "", start: START, startStack: null, ...extra });
const hand = (id: string, at: number, extra: Partial<LoggedHand> = {}): LoggedHand => ({ ...emptyHand(null), id, createdAt: at, updatedAt: at, seat: "BTN", fast: true, ...extra });
const store = (extra: Partial<HandLogState> = {}) => handLogStore.set({ hands: [], lastLevel: null, ...extra });
const ts = () => cleanTourneys(handLogStore.get().tourneys);

const initial = handLogStore.get();
const initialFast = fastStore.get();
let mem: Map<string, string>;
let writes: string[];
beforeEach(() => {
  mem = new Map();
  writes = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(k);
      mem.set(k, v);
    },
    removeItem: (k: string) => void mem.delete(k),
  });
  store();
  fastStore.set({});
  writes = [];
});
afterEach(() => {
  handLogStore.set(initial);
  fastStore.set(initialFast);
  vi.unstubAllGlobals();
});

describe("빠른 기록 tournaments: which one is current", () => {
  it("is the one started or resumed last, while it had a hand, a start or a resume within 12 hours", () => {
    const a = rec("a");
    const b = rec("b", { activeAt: START + MIN });
    expect(currentTourney([a, b], [], START + MIN)?.id).toBe("b");
    expect(currentTourney([], [], START)).toBeNull();
    // the boundary: 12 hours after its start it still counts, a moment later it is over
    expect(currentTourney([b], [], START + MIN + TOURNEY_IDLE_MS)?.id).toBe("b");
    expect(currentTourney([b], [], START + MIN + TOURNEY_IDLE_MS + 1)).toBeNull();
    // a hand 11 hours ago (mine or another player's) keeps it going
    const later = START + 20 * HOUR;
    expect(currentTourney([b], [hand("h", later - 11 * HOUR, { tourney: "b", kind: "other" })], later)?.id).toBe("b");
    expect(currentTourney([b], [hand("h", later - 11 * HOUR, { tourney: "a" })], later)).toBeNull();
    // resumed: an old one is current again
    expect(currentTourney([a, { ...b, activeAt: START - 9 * 24 * HOUR }], [], START)?.id).toBe("a");
    expect(currentTourney([{ ...a, activeAt: START + 5 * 24 * HOUR }, b], [], START + 5 * 24 * HOUR)?.id).toBe("a");
  });

  it("lists its 빠른 기록 hands of the screen's kind, newest first; with none current, today's hands from before tournaments", () => {
    const hs = [hand("m1", NIGHT - 2 * MIN, { tourney: "a" }), hand("o1", NIGHT - MIN, { tourney: "a", kind: "other" }), hand("m2", NIGHT, { tourney: "a" }), hand("x", NIGHT, { tourney: "b" }), hand("old", NIGHT - HOUR)];
    expect(tourneyHands(hs, "a").map((h) => h.id)).toEqual(["m2", "m1"]);
    expect(tourneyHands(hs, "a", "other").map((h) => h.id)).toEqual(["o1"]);
    expect(fastSession(rec("a"), hs, NIGHT).map((h) => h.id)).toEqual(["m2", "m1"]);
    expect(fastSession(null, hs, NIGHT).map((h) => h.id)).toEqual(["old"]);
  });
});

describe("빠른 기록 tournaments: the first hand starts one on its own", () => {
  it("saves the hand and a new tournament in one write (no name, start stack unknown), and the next hand joins it", () => {
    const at = NIGHT;
    const nt = tourneyForNew(at);
    expect(nt.start).toMatchObject({ id: nt.id, auto: true, startStack: null, start: at, name: "", activeAt: at });
    // no day's start covers the hand: its time is shown, but no level is guessed from it
    expect(nt.start).not.toHaveProperty("startSet");
    expect(saveHand(hand("h1", at, { tourney: nt.id }), (s) => withTourney(s, nt.start!))).toBe(true);
    expect(writes.filter((k) => k === "mygto.handlog")).toHaveLength(1);
    const saved = JSON.parse(mem.get("mygto.handlog")!) as HandLogState;
    expect(saved.hands.map((h) => [h.id, h.tourney])).toEqual([["h1", nt.id]]);
    expect(saved.tourneys?.map((t) => t.id)).toEqual([nt.id]);
    expect(tourneyForNew(at + MIN)).toEqual({ id: nt.id, start: null });
  });

  it("takes the day's start time as its start when one covers the hand", () => {
    store({ startClock: DAY_START });
    const t = autoTourney(NIGHT);
    expect(t).toMatchObject({ start: START, startSet: true, auto: true });
    expect(tourneyEstimate(t, NIGHT, null)?.level).toBe(9);
  });

  it("keeps neither the hand nor the tournament when the browser refuses the write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const nt = tourneyForNew(NIGHT);
    expect(saveHand(hand("h1", NIGHT, { tourney: nt.id }), (s) => withTourney(s, nt.start!))).toBe(false);
    expect(handLogStore.get().hands).toEqual([]);
    expect(handLogStore.get().tourneys).toBeUndefined();
  });

  it("gives a level picked before it to it, and only to it", () => {
    const pick = { stage: "mid", players: 9, draft: { seat: "BTN", ranks: [], suited: null, spot: "none", opener: null, editing: null }, parked: null, levelPick: { level: 7, at: NIGHT } } as FastState;
    expect(stampPick(pick, "t1").levelPick).toEqual({ level: 7, at: NIGHT, t: "t1" });
    const stamped = stampPick(pick, "t1");
    expect(stampPick(stamped, "t2")).toBe(stamped);
    expect(stampPick({ ...pick, levelPick: undefined }, "t1").levelPick).toBeUndefined();
    // 남의 핸드 starting the tournament: the pick on 빠른 기록's own store takes it
    fastStore.set({ levelPick: { level: 7, at: NIGHT } });
    stampStoredPick("t9");
    expect(fastStore.get().levelPick).toEqual({ level: 7, at: NIGHT, t: "t9" });
    stampStoredPick("t10");
    expect(fastStore.get().levelPick?.t).toBe("t9");
  });
});

describe("빠른 기록 tournaments: the level clock", () => {
  it("estimates from the tournament's start inside its own window, else from the day's start, else none", () => {
    const t = rec("a", { startSet: true });
    expect(tourneyEstimate(t, NIGHT, null)).toMatchObject({ level: 9, startClock: "19:00" });
    // resumed the next day: two days' blinds never come from a start yesterday
    const next = NIGHT + 24 * HOUR;
    expect(tourneyEstimate(t, next, null)).toBeNull();
    const dayEst = levelEstimateAt(next, { startClock: { day: localDay(next), clock: "21:00" } });
    expect(tourneyEstimate(t, next, dayEst)).toBe(dayEst);
    // no start set (a tournament started by a hand on its own): the fallback
    expect(tourneyEstimate(rec("b"), NIGHT, null)).toBeNull();
    expect(tourneyEstimate(null, NIGHT, dayEst)).toBe(dayEst);
  });

  it("takes a level picked only in the tournament it was picked in (a pick without one only while none is current)", () => {
    const at = NIGHT;
    const est = { level: 9, phase: "level" as const, minutesIn: 5, minutesLeft: 15, elapsedMinutes: 185 };
    expect(fastLevel({ levelPick: { level: 7, at, t: "a" } }, [], at, est, "a")).toEqual({ level: 7, guessed: false, picked: true });
    expect(fastLevel({ levelPick: { level: 7, at, t: "a" } }, [], at, est, "b")).toEqual({ level: 9, guessed: true, picked: false });
    expect(fastLevel({ levelPick: { level: 7, at, t: "a" } }, [], at, null, null)).toEqual({ level: null, guessed: false, picked: false });
    expect(fastLevel({ levelPick: { level: 7, at } }, [], at, est, null)).toEqual({ level: 7, guessed: false, picked: true });
    expect(fastLevel({ levelPick: { level: 7, at } }, [], at, est, "a")).toEqual({ level: 9, guessed: true, picked: false });
  });

  it("sets the current tournament's start from the picker's 시작 시각 (and the day's), the day's only when it doesn't cover the moment", () => {
    // started by a hand on its own: no start yet
    store({ tourneys: [rec("a", { start: NIGHT - HOUR, activeAt: NIGHT - HOUR, auto: true })] });
    const e = setFastStartClock("19:00", NIGHT);
    expect(e && e.level).toBe(9);
    expect(ts()[0]).toMatchObject({ start: START, startSet: true });
    expect(ts()[0]).not.toHaveProperty("auto");
    expect(handLogStore.get().startClock).toEqual(DAY_START);
    expect(fastEstimate(NIGHT)?.level).toBe(9);
    // a start set that covers the moment: replaced
    expect(setFastStartClock("20:00", NIGHT)).toMatchObject({ level: 6, startClock: "20:00" });
    expect(ts()[0].start).toBe(START + HOUR);
    expect(setFastStartClock("25시", NIGHT)).toBe(false);
  });

  it("writes the day's start only, with no tournament current or one resumed on a later day", () => {
    expect(setFastStartClock("19:00", NIGHT)).toMatchObject({ level: 9 });
    expect(handLogStore.get().startClock).toEqual(DAY_START);
    expect(handLogStore.get().tourneys).toBeUndefined();
    const next = NIGHT + 24 * HOUR;
    store({ tourneys: [rec("a", { startSet: true, activeAt: next - MIN })] });
    expect(fastEstimate(next)).toBeNull();
    const e = setFastStartClock("21:00", next);
    // 21:00 start, 22:05: the break after Lv3 (Lv3's blinds)
    expect(e).toMatchObject({ startClock: "21:00", level: 3, phase: "break" });
    expect(ts()[0].start).toBe(START);
    expect(handLogStore.get().startClock).toEqual({ day: localDay(next), clock: "21:00" });
  });
});

describe("빠른 기록 tournaments: the sheet and the buttons", () => {
  it("starts a tournament from the sheet: it becomes current; 새 토너먼트 취소 brings the one before back", () => {
    const first = startTourney({ name: " 수요일 펍 ", clock: "19:00", stack: "50000", memo: "테이블 3" }, START + 5 * MIN)!;
    expect(ts()[0]).toMatchObject({ id: first, name: "수요일 펍", memo: "테이블 3", start: START, startSet: true, startStack: 50000 });
    expect(ts()[0]).not.toHaveProperty("auto");
    saveHand(hand("h1", NIGHT - HOUR, { tourney: first }));
    const second = startTourney({ name: "", clock: "", stack: "", memo: "" }, NIGHT)!;
    expect(currentTourney(ts(), handLogStore.get().hands, NIGHT)?.id).toBe(second);
    expect(ts().find((t) => t.id === second)).toMatchObject({ start: NIGHT, startStack: null });
    expect(ts().find((t) => t.id === second)).not.toHaveProperty("startSet");
    expect(previousTourney(ts(), second)?.id).toBe(first);
    expect(cancelNewTourney(first, NIGHT + MIN)).toBe(false);
    expect(cancelNewTourney(second, NIGHT + MIN)).toBe(true);
    expect(ts().map((t) => t.id)).toEqual([first]);
    expect(currentTourney(ts(), handLogStore.get().hands, NIGHT + MIN)?.id).toBe(first);
    expect(startTourney({ name: "", clock: "7시 반 저녁", stack: "", memo: "" }, NIGHT)).toBeNull();
  });

  it("resumes a past tournament (이어 적기) and deletes only one no hand carries", () => {
    store({ tourneys: [rec("old", { activeAt: START - 7 * 24 * HOUR }), rec("new", { activeAt: START })], hands: [hand("o", START, { tourney: "new", kind: "other" })] });
    expect(resumeTourney("old", NIGHT)).toBe(true);
    expect(currentTourney(ts(), handLogStore.get().hands, NIGHT)?.id).toBe("old");
    expect(tourneyForNew(NIGHT + MIN).id).toBe("old");
    expect(resumeTourney("gone", NIGHT)).toBe(false);
    // another player's hand counts: not deleted
    expect(deleteTourney("new")).toBe(false);
    expect(deleteTourney("old")).toBe(true);
    expect(ts().map((t) => t.id)).toEqual(["new"]);
  });

  it("gives a level picked while none was current to the tournament started or resumed next, and keeps one picked in another", () => {
    fastStore.set({ levelPick: { level: 5, at: NIGHT } });
    const id = startTourney({ name: "", clock: "", stack: "", memo: "" }, NIGHT)!;
    expect(fastStore.get().levelPick).toEqual({ level: 5, at: NIGHT, t: id });
    store({ tourneys: [rec("old", { activeAt: START - 24 * HOUR })] });
    fastStore.set({ levelPick: { level: 7, at: NIGHT } });
    resumeTourney("old", NIGHT);
    expect(fastStore.get().levelPick?.t).toBe("old");
    // picked in "old": a new tournament doesn't take it, and 취소 brings it back with "old"
    const fresh = startTourney({ name: "", clock: "", stack: "", memo: "" }, NIGHT + MIN)!;
    expect(fastStore.get().levelPick?.t).toBe("old");
    expect(fastLevel(fastStore.get(), [], NIGHT + MIN, null, fresh).picked).toBe(false);
    cancelNewTourney(fresh, NIGHT + 2 * MIN);
    expect(fastLevel(fastStore.get(), [], NIGHT + 2 * MIN, null, currentTourney(ts(), [], NIGHT + 2 * MIN)?.id ?? null)).toMatchObject({ level: 7, picked: true });
  });

  it("edits a tournament: an old one keeps its date when its clock changes, `auto` goes, a stub from its hands is stored", () => {
    const tue = new Date(2026, 10, 10, 19, 0).getTime();
    store({ tourneys: [rec("w", { start: tue, startSet: true, createdAt: tue, auto: true })], hands: [hand("x", tue + 2 * HOUR, { tourney: "lost" })] });
    expect(editTourney("w", { name: "화요일", clock: "18:30", stack: "40000", memo: "" }, NIGHT)).toBe(true);
    expect(ts()[0]).toMatchObject({ name: "화요일", start: tue - 30 * MIN, startSet: true, startStack: 40000, updatedAt: NIGHT });
    expect(ts()[0]).not.toHaveProperty("auto");
    // its clock emptied: no start set
    editTourney("w", { name: "화요일", clock: "", stack: "", memo: "" }, NIGHT);
    expect(ts()[0]).not.toHaveProperty("startSet");
    expect(ts()[0].startStack).toBeNull();
    // a tournament only its hands know (a backup without the list): renamed, and dated by its first hand
    expect(editTourney("lost", { name: "복구", clock: "19:00", stack: "", memo: "" }, NIGHT)).toBe(true);
    expect(ts().find((t) => t.id === "lost")).toMatchObject({ name: "복구", start: tue, startSet: true });
    expect(editTourney("nowhere", { name: "x", clock: "", stack: "", memo: "" }, NIGHT)).toBe(false);
    expect(editTourney("w", { name: "x", clock: "", stack: "0", memo: "" }, NIGHT)).toBe(false);
  });

  it("offers the sheet's fields: the day's start (else now) and the pub's 50,000 for a new one; a record's own", () => {
    expect(newFields(NIGHT)).toEqual({ name: "", clock: "22:05", stack: "50000", memo: "" });
    store({ startClock: DAY_START });
    expect(newFields(NIGHT).clock).toBe("19:00");
    expect(fieldsOf(rec("a", { name: "n", memo: "m", startSet: true, startStack: 30000 }))).toEqual({ name: "n", clock: "19:00", stack: "30000", memo: "m" });
    expect(fieldsOf(rec("a"))).toMatchObject({ clock: "", stack: "" });
    expect(fieldsBlock({ name: "", clock: "", stack: "", memo: "" })).toBeNull();
    expect(fieldsBlock({ name: "", clock: "저녁", stack: "", memo: "" })).toBe("clock");
    expect(fieldsBlock({ name: "", clock: "19:00", stack: "0", memo: "" })).toBe("stack");
    expect(fieldsBlock({ name: "", clock: "19:00", stack: "5만", memo: "" })).toBe("stack");
  });
});

describe("빠른 기록 tournaments: the 토너먼트 기록 list", () => {
  it("lists records with their hands and others' count, the current first; leaves out an empty one started by a hand; makes one for an id only hands carry", () => {
    const hs = [
      hand("a1", START + HOUR, { tourney: "a", net: 3000, result: "win" }),
      hand("a2", START + 2 * HOUR, { tourney: "a", net: -1000, result: "lose" }),
      hand("ao", START + 2 * HOUR, { tourney: "a", kind: "other" }),
      hand("l1", START + 30 * MIN, { tourney: "lost" }),
    ];
    const list = [rec("a"), rec("e", { auto: true, activeAt: START - HOUR, createdAt: START - HOUR }), rec("c", { createdAt: START + 3 * HOUR, activeAt: START + 3 * HOUR, start: START + 3 * HOUR })];
    const { tourneys } = tourneyGroups(list, hs, START + 3 * HOUR);
    expect(tourneys.map((g) => [g.key, g.current, g.hands.length, g.others])).toEqual([
      ["c", true, 0, 0],
      ["a", false, 2, 1],
      ["lost", false, 1, 0],
    ]);
    expect(tourneys[1].hands.map((h) => h.id)).toEqual(["a2", "a1"]);
    expect(tourneys[2].t).toMatchObject({ id: "lost", start: START + 30 * MIN });
    // an empty one started by a hand is listed while it is current
    expect(tourneyGroups([rec("e", { auto: true })], [], START).tourneys.map((g) => g.key)).toEqual(["e"]);
    expect(groupFor("tourney", "e", list, hs, START + 3 * HOUR)?.t?.id).toBe("e");
    expect(groupFor("tourney", "lost", list, hs, START + 3 * HOUR)?.hands).toHaveLength(1);
    expect(groupFor("tourney", "nope", list, hs, START)).toBeNull();
  });

  it("groups my 빠른 기록 hands from before tournaments by 6-hour pauses, newest first, found by any hand in them", () => {
    const hs = [hand("n2", NIGHT), hand("n1", NIGHT - HOUR), hand("w2", NIGHT - 7 * 24 * HOUR), hand("w1", NIGHT - 7 * 24 * HOUR - 2 * HOUR), hand("o", NIGHT, { kind: "other" }), hand("t", NIGHT, { tourney: "a" }), { ...hand("tbl", NIGHT), fast: undefined }];
    const { legacy } = tourneyGroups([], hs, NIGHT);
    expect(legacy.map((g) => [g.key, g.hands.map((h) => h.id)])).toEqual([
      ["n2", ["n2", "n1"]],
      ["w2", ["w2", "w1"]],
    ]);
    expect(legacy[1].day).toBe(NIGHT - 7 * 24 * HOUR - 2 * HOUR);
    expect(groupFor("legacy", "w1", [], hs, NIGHT)?.key).toBe("w2");
    expect(groupFor("legacy", "t", [], hs, NIGHT)).toBeNull();
  });

  it("sums a group's chips, with what 지금 스택 shows beyond the hands from the start stack; none without a result", () => {
    const hs = [hand("a", 1, { net: 3000, result: "win" }), hand("b", 2, { net: -1000, result: "lose", stack: 47000 })];
    expect(groupChips(hs, null)).toBe(2000);
    // started at 50,000, 지금 스택 46,000 after the second: 4,000 lost somewhere else
    expect(groupChips(hs, 50000)).toBe(-4000);
    expect(groupChips([hand("c", 1)], null)).toBeNull();
    expect(groupChips([hand("c", 1)], 50000)).toBeNull();
  });

  it("names a tournament by its day without a name, and says when it began", () => {
    const hs = [hand("x", START + 2 * HOUR + 5 * MIN, { tourney: "a" })];
    expect(tourneyTitle(rec("a"), hs)).toBe("11/17 토너먼트");
    expect(tourneyTitle(rec("a", { name: "수요일 펍" }), hs)).toBe("수요일 펍");
    expect(tourneyWhen(rec("a", { startSet: true }), hs)).toBe("19:00 시작");
    expect(tourneyWhen(rec("a"), hs)).toBe("21:05부터");
    expect(tourneyWhen(rec("a"), [])).toBe("시작 시각 모름");
    expect(infoOf(rec("a", { startSet: true, startStack: 50000, memo: "m" }), hs)).toEqual({ title: "11/17 토너먼트", when: "11월 17일 (화) 19:00 시작", startStack: 50000, memo: "m" });
  });
});
