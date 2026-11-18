import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fastLevel, fastStore, pickLive, SESSION_IDLE_MS, type FastState } from "./fastLog";
import {
  autoTourney,
  cancelNewTourney,
  cancelTarget,
  currentFields,
  currentTourney,
  deleteTourney,
  editTourney,
  fastEstimate,
  fastSession,
  fieldsBlock,
  fieldsOf,
  anteFor,
  groupChips,
  groupFor,
  infoOf,
  isCustom,
  levelFor,
  newFields,
  onTourneyDay,
  previousTourney,
  resumeTourney,
  runningUntagged,
  saveNewFast,
  setFastStartClock,
  setTourneyBlinds,
  sheetLevelText,
  stampPick,
  stampStoredPick,
  startLevelText,
  startNote,
  startTourney,
  TOURNEY_IDLE_MS,
  tourneyEstimate,
  tourneyForNew,
  tourneyGroups,
  tourneyHands,
  tourneyTitle,
  tourneyWhen,
} from "./fastTourney";
import { backupText, emptyHand, handLogStore, levelEstimateAt, localDay, saveHand, setTodayStart, withBackup, type HandLogState, type LoggedHand } from "./handLog";
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
    expect(stampPick(pick, "t1", NIGHT + MIN).levelPick).toEqual({ level: 7, at: NIGHT, t: "t1" });
    const stamped = stampPick(pick, "t1", NIGHT + MIN);
    expect(stampPick(stamped, "t2", NIGHT + MIN)).toBe(stamped);
    expect(stampPick({ ...pick, levelPick: undefined }, "t1", NIGHT).levelPick).toBeUndefined();
    // 남의 핸드 starting the tournament: the pick on 빠른 기록's own store takes it
    fastStore.set({ levelPick: { level: 7, at: NIGHT } });
    stampStoredPick("t9", NIGHT + MIN);
    expect(fastStore.get().levelPick).toEqual({ level: 7, at: NIGHT, t: "t9" });
    stampStoredPick("t10", NIGHT + MIN);
    expect(fastStore.get().levelPick?.t).toBe("t9");
  });

  it("drops a pick over 12 hours old instead of giving it to the new tournament", () => {
    const pick = { stage: "mid", players: 9, draft: { seat: "BTN", ranks: [], suited: null, spot: "none", opener: null, editing: null }, parked: null, levelPick: { level: 10, at: NIGHT } } as FastState;
    const later = NIGHT + SESSION_IDLE_MS + MIN;
    expect(stampPick(pick, "t1", later)).not.toHaveProperty("levelPick");
    expect(stampPick(pick, "t1", NIGHT + SESSION_IDLE_MS).levelPick?.t).toBe("t1");
    fastStore.set({ players: 9, levelPick: { level: 10, at: NIGHT } });
    stampStoredPick("t9", later);
    expect(fastStore.get()).toEqual({ players: 9 });
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
    // no start time on one started from the sheet: nothing guessed, not even from a day's start
    const tonight = levelEstimateAt(NIGHT, { startClock: { day: localDay(NIGHT), clock: "19:00" } });
    expect(tonight).not.toBeNull();
    expect(tourneyEstimate(rec("c"), NIGHT, tonight)).toBeNull();
    // one started by a hand on its own still follows the day's start typed in the picker
    expect(tourneyEstimate(rec("d", { auto: true }), NIGHT, tonight)).toBe(tonight);
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
    expect(newFields(NIGHT)).toEqual({ name: "", clock: "22:05", stack: "50000", memo: "", structure: "pub", blinds: null });
    store({ startClock: DAY_START });
    expect(newFields(NIGHT).clock).toBe("19:00");
    expect(fieldsOf(rec("a", { name: "n", memo: "m", startSet: true, startStack: 30000 }))).toEqual({ name: "n", clock: "19:00", stack: "30000", memo: "m", structure: "pub", blinds: null });
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

  it("groups my 빠른 기록 hands from before tournaments by 6-hour pauses, newest first, keyed by the newest hand's time", () => {
    const WEEK = NIGHT - 7 * 24 * HOUR;
    const hs = [hand("n2", NIGHT), hand("n1", NIGHT - HOUR), hand("w2", WEEK), hand("w1", WEEK - 2 * HOUR), hand("o", NIGHT, { kind: "other" }), hand("t", NIGHT, { tourney: "a" }), { ...hand("tbl", NIGHT), fast: undefined }];
    const { legacy } = tourneyGroups([], hs, NIGHT);
    expect(legacy.map((g) => [g.key, g.hands.map((h) => h.id)])).toEqual([
      [String(NIGHT), ["n2", "n1"]],
      [String(WEEK), ["w2", "w1"]],
    ]);
    expect(legacy[1].day).toBe(WEEK - 2 * HOUR);
    expect(groupFor("legacy", String(WEEK), [], hs, NIGHT)?.hands.map((h) => h.id)).toEqual(["w2", "w1"]);
    // its newest hand deleted (opened from the group and deleted in 빠른 기록): the same group, found by the time
    expect(groupFor("legacy", String(WEEK), [], hs.filter((h) => h.id !== "w2"), NIGHT)?.hands.map((h) => h.id)).toEqual(["w1"]);
    expect(groupFor("legacy", String(WEEK), [], hs.filter((h) => !h.id.startsWith("w")), NIGHT)).toBeNull();
    // an address by a hand's id still opens its group
    expect(groupFor("legacy", "w1", [], hs, NIGHT)?.key).toBe(String(WEEK));
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

describe("빠른 기록 tournaments: a level picked last night never comes back", () => {
  /** Last night's 22:05 (the pick), and tonight's 19:52 (the first hand). */
  const Y_PICK = NIGHT - 24 * HOUR;
  const T1952 = new Date(2026, 10, 17, 19, 52).getTime();
  const tonight = { day: localDay(T1952), clock: "19:00" };

  it("keeps a pick through the hands logged since it with no 12-hour pause, and no further", () => {
    const hs = [hand("a", T1952), hand("b", T1952 + 20 * MIN)];
    expect(pickLive(Y_PICK, hs)).toBe(Y_PICK);
    expect(pickLive(T1952 - HOUR, hs)).toBe(T1952 + 20 * MIN);
    expect(pickLive(T1952 + 30 * MIN, hs)).toBe(T1952 + 30 * MIN);
    const now = T1952 + 21 * MIN;
    const est = levelEstimateAt(now, { startClock: tonight });
    // last night's pick, though tagged with this tournament: the start time's Lv4 (20:13), not Lv30
    expect(fastLevel({ levelPick: { level: 10, at: Y_PICK, t: "a" } }, hs, now, est, "a")).toEqual({ level: 4, guessed: true, picked: false });
    // picked tonight: it holds
    expect(fastLevel({ levelPick: { level: 4, at: T1952 + 21 * MIN, t: "a" } }, hs, now, est, "a")).toEqual({ level: 4, guessed: false, picked: true });
  });

  it("drops last night's pick with tonight's first hand: the start time's level, never Lv30", () => {
    store({ startClock: tonight, hands: [hand("y1", Y_PICK - HOUR), hand("y2", Y_PICK + 10 * MIN)] });
    fastStore.set({ levelPick: { level: 10, at: Y_PICK } });
    // before the hand: lapsed (12 hours and more since the pick and last night's hands)
    expect(fastLevel(fastStore.get(), fastSession(null, handLogStore.get().hands, T1952), T1952, fastEstimate(T1952), null)).toMatchObject({ level: 3, picked: false });
    const r = saveNewFast(hand("n1", T1952), T1952);
    expect(r.started).not.toBeNull();
    const id = r.started!.id;
    // last night's hands stay where they were
    expect(handLogStore.get().hands.filter((h) => h.tourney === id).map((h) => h.id)).toEqual(["n1"]);
    // 빠른 기록 then gives the pick to the new tournament: dropped instead
    expect(stampPick(fastStore.get() as FastState, id, T1952)).not.toHaveProperty("levelPick");
    // the next hand (20:15): Lv4 by the start time
    const later = T1952 + 23 * MIN;
    const session = tourneyHands(handLogStore.get().hands, id);
    expect(fastLevel(fastStore.get(), session, later, fastEstimate(later), id)).toEqual({ level: 4, guessed: true, picked: false });
    expect(fastLevel({ levelPick: { level: 10, at: Y_PICK, t: id } }, session, later, fastEstimate(later), id)).toMatchObject({ level: 4, picked: false });
  });

  it("never brings back a pick made in a tournament resumed (이어 적기) the next day", () => {
    const yStart = START - 24 * HOUR;
    store({ tourneys: [rec("mon", { start: yStart, startSet: true, createdAt: yStart, activeAt: yStart })], hands: [hand("y1", Y_PICK - 30 * MIN, { tourney: "mon" })] });
    fastStore.set({ levelPick: { level: 10, at: Y_PICK, t: "mon" } });
    expect(resumeTourney("mon", T1952 - MIN)).toBe(true);
    const r = saveNewFast(hand("n1", T1952), T1952);
    expect(r).toMatchObject({ ok: true, started: null });
    expect(r.hand.tourney).toBe("mon");
    // yesterday's start doesn't cover tonight and no start is set today: no level (it asks), never the pick run on 22 hours
    const session = tourneyHands(handLogStore.get().hands, "mon");
    expect(fastLevel(fastStore.get(), session, T1952 + MIN, fastEstimate(T1952 + MIN), "mon")).toEqual({ level: null, guessed: false, picked: false });
  });
});

describe("빠른 기록 tournaments: a new hand on file (saveNewFast)", () => {
  it("tags it with the current tournament", () => {
    store({ tourneys: [rec("a", { activeAt: NIGHT - HOUR })] });
    expect(saveNewFast(hand("h1", NIGHT), NIGHT)).toMatchObject({ ok: true, started: null, hand: { id: "h1", tourney: "a" } });
    expect(handLogStore.get().hands.map((h) => [h.id, h.tourney])).toEqual([["h1", "a"]]);
  });

  it("starts one with the first hand in one write, taking in today's hands logged before tournaments (an update mid-tournament)", () => {
    store({ hands: [hand("y", NIGHT - 30 * HOUR), hand("m1", NIGHT - 2 * HOUR), hand("m2", NIGHT - HOUR), hand("o1", NIGHT - 90 * MIN, { kind: "other" }), { ...hand("tbl", NIGHT - HOUR), fast: undefined }] });
    expect(runningUntagged(handLogStore.get().hands, NIGHT).map((h) => h.id)).toEqual(["m2", "m1", "o1"]);
    writes = [];
    const r = saveNewFast(hand("h1", NIGHT), NIGHT);
    expect(r).toMatchObject({ ok: true, started: { auto: true, startStack: null } });
    expect(writes.filter((k) => k === "mygto.handlog")).toHaveLength(1);
    const id = r.started!.id;
    const hs = handLogStore.get().hands;
    expect(Object.fromEntries(hs.map((h) => [h.id, h.tourney ?? null]))).toEqual({ h1: id, m1: id, m2: id, o1: id, y: null, tbl: null });
    // edited now, so a backup merge keeps the tag
    expect(hs.find((h) => h.id === "m1")?.updatedAt).toBe(NIGHT);
    expect(ts().map((t) => t.id)).toEqual([id]);
    expect(tourneyWhen(ts()[0], hs)).toBe("20:05부터");
    expect(tourneyHands(hs, id).map((h) => h.id)).toEqual(["h1", "m2", "m1"]);
    // the next hand joins it
    expect(saveNewFast(hand("h2", NIGHT + MIN), NIGHT + MIN)).toMatchObject({ ok: true, started: null, hand: { tourney: id } });
  });

  it("keeps nothing, hand, tournament or tags, when the browser refuses the write", () => {
    store({ hands: [hand("m1", NIGHT - HOUR)] });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(saveNewFast(hand("h1", NIGHT), NIGHT)).toMatchObject({ ok: false, started: null });
    expect(handLogStore.get().hands.map((h) => [h.id, h.tourney])).toEqual([["m1", undefined]]);
    expect(handLogStore.get().tourneys).toBeUndefined();
  });

  it("takes today's hands from before tournaments into one started from the sheet only when asked", () => {
    store({ hands: [hand("m1", NIGHT - HOUR), hand("y", NIGHT - 30 * HOUR)] });
    const a = startTourney({ name: "", clock: "19:00", stack: "", memo: "" }, NIGHT)!;
    expect(handLogStore.get().hands.every((h) => !h.tourney)).toBe(true);
    expect(cancelNewTourney(a, NIGHT)).toBe(true);
    const b = startTourney({ name: "", clock: "19:00", stack: "", memo: "" }, NIGHT, true)!;
    expect(Object.fromEntries(handLogStore.get().hands.map((h) => [h.id, h.tourney ?? null]))).toEqual({ m1: b, y: null });
  });

  it("lets one started by a hand on its own follow the day's start, corrected in 핸드 복기 too, until it is edited", () => {
    store({ startClock: DAY_START });
    const r = saveNewFast(hand("h1", NIGHT - HOUR), NIGHT - HOUR);
    expect(r.started).toMatchObject({ auto: true, start: START, startSet: true });
    expect(fastEstimate(NIGHT)?.level).toBe(9);
    // 핸드 복기's level picker writes the day's start only
    setTodayStart("20:00", NIGHT);
    expect(fastEstimate(NIGHT)).toMatchObject({ level: 6, startClock: "20:00" });
    // edited in the sheet, its own start wins
    editTourney(r.started!.id, { name: "", clock: "19:00", stack: "", memo: "" }, NIGHT);
    expect(fastEstimate(NIGHT)?.level).toBe(9);
  });
});

describe("빠른 기록 tournaments: 새 토너먼트 취소 / 지우기", () => {
  it("never brings back yesterday's tournament: the new one only goes, and none is current", () => {
    const yStart = START - 24 * HOUR;
    store({ tourneys: [rec("mon", { name: "월요일 펍", start: yStart, startSet: true, createdAt: yStart, activeAt: yStart })], hands: [hand("y1", yStart + 3 * HOUR, { tourney: "mon" })] });
    const tue = startTourney({ name: "화요일 펍", clock: "19:00", stack: "50000", memo: "" }, START - 10 * MIN)!;
    const t = ts().find((x) => x.id === tue)!;
    expect(previousTourney(ts(), tue)?.id).toBe("mon");
    expect(cancelTarget(t, ts(), handLogStore.get().hands)).toBeNull();
    expect(cancelNewTourney(tue, START)).toBe(true);
    expect(ts().map((x) => x.id)).toEqual(["mon"]);
    expect(currentTourney(ts(), handLogStore.get().hands, START)).toBeNull();
    // the next hand starts tonight's own
    expect(saveNewFast(hand("n1", START + 5 * MIN), START + 5 * MIN).started).not.toBeNull();
  });

  it("goes back to the one in use when the new one was started, once (a second tap has nothing to undo)", () => {
    const a = startTourney({ name: "1부", clock: "19:00", stack: "50000", memo: "" }, START)!;
    saveHand(hand("a1", START + HOUR, { tourney: a }));
    const b = startTourney({ name: "2부", clock: "", stack: "", memo: "" }, START + 2 * HOUR)!;
    const c = startTourney({ name: "3부", clock: "", stack: "", memo: "" }, START + 2 * HOUR + MIN)!;
    const hs = () => handLogStore.get().hands;
    expect(cancelTarget(ts().find((x) => x.id === c)!, ts(), hs())?.id).toBe(b);
    expect(cancelNewTourney(c, START + 2 * HOUR + 2 * MIN)).toBe(true);
    expect(currentTourney(ts(), hs(), START + 2 * HOUR + 2 * MIN)?.id).toBe(b);
    // b is current again by the 취소, not as started: no 취소 offered for it (a double tap can't take it too)
    expect(cancelTarget(ts().find((x) => x.id === b)!, ts(), hs())).toBeNull();
    // resumed with 이어 적기: not a new one either
    expect(resumeTourney(a, START + 3 * HOUR)).toBe(true);
    expect(cancelTarget(ts().find((x) => x.id === a)!, ts(), hs())).toBeNull();
  });
});

describe("빠른 기록 tournaments: the sheet's start time", () => {
  const at = (h: number, m: number) => new Date(2026, 10, 17, h, m).getTime();

  it("offers the start time used last when today's falls from 6 hours ago to 2 hours ahead, else now", () => {
    store({ startClock: { day: localDay(at(12, 0) - 24 * HOUR), clock: "19:00" } });
    expect(newFields(at(19, 52)).clock).toBe("19:00");
    expect(newFields(at(18, 30)).clock).toBe("19:00");
    expect(newFields(at(14, 0)).clock).toBe("14:00");
    expect(newFields(at(2, 0) + 24 * HOUR).clock).toBe("02:00");
    // a tournament's start set in the sheet counts too (the later one)
    store({ startClock: { day: localDay(at(12, 0) - 48 * HOUR), clock: "19:00" }, tourneys: [rec("x", { start: at(18, 30) - 24 * HOUR, startSet: true })] });
    expect(newFields(at(19, 52)).clock).toBe("18:30");
  });

  it("says what the start time typed gives now, so a wrong one shows before it is saved", () => {
    expect(startLevelText("19:00", at(19, 52), at(19, 52))).toBe("지금 Lv3 200/400");
    expect(startLevelText("19:52", at(19, 52), at(19, 52))).toBe("지금 Lv1 100/200");
    expect(startLevelText("19:00", at(18, 40), at(18, 40))).toBe("시작 전 · 20분 뒤");
    expect(startLevelText("", at(19, 52), at(19, 52))).toBeNull();
    expect(startLevelText("저녁", at(19, 52), at(19, 52))).toBeNull();
    // another day's tournament (its start read near its own day): nothing about now
    expect(startLevelText("19:00", at(19, 0) - 24 * HOUR, at(19, 52))).toBeNull();
    let m = 0;
    while (startLevelText("19:00", at(19, 0), at(19, 0) + m * MIN)?.startsWith("지금 Lv") !== false && m < 600) m++;
    expect(startLevelText("19:00", at(19, 0), at(19, 0) + m * MIN)).toMatch(/^지금 휴식 \(Lv\d+ [\d,]+\/[\d,]+\)$/);
  });

  it("offers the pub's 50,000 as a value in the current tournament's sheet when its start stack isn't known, and the start its estimate runs on", () => {
    const est = { level: 9, phase: "level" as const, minutesIn: 5, minutesLeft: 15, elapsedMinutes: 185, startClock: "19:30" };
    expect(currentFields(rec("a", { name: "n", startSet: true, startStack: 30000 }), est, true)).toEqual({ name: "n", clock: "19:00", stack: "30000", memo: "", structure: "pub", blinds: null });
    expect(currentFields(rec("a", { startSet: true }), est, true)).toEqual({ name: "", clock: "19:00", stack: "50000", memo: "", structure: "pub", blinds: null });
    // 직접 입력: no 50,000 offered (a wrong start stack would skew every 스택 result), its blinds as on file
    expect(currentFields(rec("a", { structure: "custom", blinds: { sb: 100, bb: 200, ante: 200 } }), est, true)).toMatchObject({ stack: "", structure: "custom", blinds: { sb: 100, bb: 200, ante: 200 } });
    // started by a hand on its own: the day's start it follows
    expect(currentFields(rec("a", { auto: true }), est, true).clock).toBe("19:30");
    expect(currentFields(rec("a", { auto: true }), est, false).clock).toBe("");
    expect(currentFields(rec("a", { auto: true }), null, true).clock).toBe("");
  });

  it("says under an older tournament's start time which day it counts for", () => {
    const yest = rec("y", { start: START - 24 * HOUR, startSet: true });
    expect(sheetLevelText("19:00", yest, [], NIGHT)).toBe("11월 16일 (월) 시작 기준");
    expect(sheetLevelText("", yest, [], NIGHT)).toBeNull();
    expect(sheetLevelText("19:00", rec("a", { startSet: true }), [], NIGHT)).toBe("지금 Lv9 800/1,600");
    expect(sheetLevelText("19:00", null, [], NIGHT)).toBe("지금 Lv9 800/1,600");
  });

  it("tells the edit sheet what its start time does: today's estimate, or only its first day", () => {
    const t = rec("a", { startSet: true });
    expect(onTourneyDay(t, [], NIGHT)).toBe(true);
    expect(onTourneyDay(t, [], NIGHT + 24 * HOUR)).toBe(false);
    expect(startNote(t, [], true, NIGHT)).toBe("시작 시간을 바꾸면 앞으로 적는 핸드의 레벨 추정이 바뀌어요 (저장된 핸드는 그대로).");
    expect(startNote(t, [], true, NIGHT + 24 * HOUR)).toBe("11월 17일 (화)에 시작한 토너먼트라 시작 시간은 그날 기준이에요 · 오늘 레벨은 레벨 칩에서 골라 주세요.");
    expect(startNote(t, [], false, NIGHT)).toBe("저장된 핸드의 레벨은 그대로예요.");
  });

  it("keeps a tournament from another day on its day when the level picker's start is typed", () => {
    const yest = NIGHT - 24 * HOUR;
    store({ tourneys: [rec("y", { start: yest, createdAt: yest, activeAt: NIGHT - MIN, auto: true })], hands: [hand("y1", yest, { tourney: "y" })] });
    expect(setFastStartClock("21:00", NIGHT)).toMatchObject({ startClock: "21:00", level: 3 });
    expect(ts()[0]).not.toHaveProperty("startSet");
    expect(ts()[0].start).toBe(yest);
    expect(tourneyTitle(ts()[0], handLogStore.get().hands)).toBe("11/16 토너먼트");
    expect(handLogStore.get().startClock).toEqual({ day: localDay(NIGHT), clock: "21:00" });
  });
});

describe("빠른 기록 tournaments: the backup", () => {
  it("writes the tournaments and the hands' tags into the backup and brings them back; an older backup keeps ours", () => {
    const st = { hands: [hand("h1", NIGHT, { tourney: "a" })], lastLevel: null, tourneys: [rec("a", { name: "화요일" })] } as HandLogState;
    const { next, added } = withBackup({ hands: [], lastLevel: null }, backupText(st));
    expect(added).toBe(1);
    expect(next.hands.map((h) => [h.id, h.tourney])).toEqual([["h1", "a"]]);
    expect(cleanTourneys(next.tourneys)).toEqual([rec("a", { name: "화요일" })]);
    const old = JSON.stringify({ kind: "pubaj-hand-log", version: 2, hands: [hand("h2", NIGHT - HOUR)] });
    const kept = withBackup(st, old).next;
    expect(cleanTourneys(kept.tourneys).map((t) => t.id)).toEqual(["a"]);
    expect(kept.hands.map((h) => [h.id, h.tourney])).toEqual([
      ["h1", "a"],
      ["h2", undefined],
    ]);
  });
});

describe("빠른 기록 tournaments: 직접 입력 (blinds typed by hand)", () => {
  const B = { sb: 100, bb: 200, ante: 200 };
  const custom = { name: "목요일", clock: "19:00", stack: "30000", memo: "", structure: "custom" as const, blinds: B };

  it("starts one with its structure and blinds, no start time (nothing estimated from a clock)", () => {
    store({ startClock: DAY_START });
    const id = startTourney(custom, NIGHT)!;
    const t = ts().find((x) => x.id === id)!;
    expect(t).toMatchObject({ structure: "custom", blinds: B, start: NIGHT, startStack: 30000, name: "목요일" });
    expect(t).not.toHaveProperty("startSet");
    expect(isCustom(t)).toBe(true);
    // no estimate, not even the day's start
    expect(tourneyEstimate(t, NIGHT, levelEstimateAt(NIGHT, handLogStore.get()))).toBeNull();
    expect(fastEstimate(NIGHT)).toBeNull();
    // the level new hands go in at: its blinds, never guessed; the ante from them
    expect(levelFor(t, {}, [], NIGHT, null)).toEqual({ level: B, guessed: false, picked: false });
    expect(anteFor(t, { noAnte: true })).toBe(true);
    expect(anteFor({ ...t, blinds: { ...B, ante: 0 } }, {})).toBe(false);
    expect(levelFor({ ...t, blinds: undefined }, {}, [], NIGHT, null).level).toBeNull();
    // 야자수 새틀 as before
    const pub = startTourney({ name: "", clock: "19:00", stack: "50000", memo: "", structure: "pub", blinds: null }, NIGHT + MIN)!;
    const p = ts().find((x) => x.id === pub)!;
    expect(p).not.toHaveProperty("structure");
    expect(levelFor(p, {}, [], NIGHT + MIN, tourneyEstimate(p, NIGHT + MIN, null))).toMatchObject({ level: 9, guessed: true });
    expect(anteFor(p, { noAnte: true })).toBe(false);
  });

  it("starts one with no blinds yet (asked for once a hand is typed)", () => {
    const id = startTourney({ ...custom, blinds: null }, NIGHT)!;
    const t = ts().find((x) => x.id === id)!;
    expect(t).toMatchObject({ structure: "custom" });
    expect(t).not.toHaveProperty("blinds");
  });

  it("sets its blinds from now on in one write; refuses bad blinds, a 야자수 새틀 one, a refused write", () => {
    const id = startTourney(custom, NIGHT)!;
    writes = [];
    expect(setTourneyBlinds(id, { sb: 200, bb: 400, ante: 400 }, NIGHT + MIN)).toBe(true);
    expect(writes.filter((k) => k === "mygto.handlog")).toHaveLength(1);
    expect(ts().find((x) => x.id === id)).toMatchObject({ blinds: { sb: 200, bb: 400, ante: 400 }, updatedAt: NIGHT + MIN });
    expect(setTourneyBlinds(id, { sb: 500, bb: 400, ante: 0 }, NIGHT + MIN)).toBe(false);
    const pub = startTourney({ name: "", clock: "", stack: "", memo: "" }, NIGHT)!;
    expect(setTourneyBlinds(pub, B, NIGHT)).toBe(false);
    expect(setTourneyBlinds("nope", B, NIGHT)).toBe(false);
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(setTourneyBlinds(id, { sb: 300, bb: 600, ante: 600 }, NIGHT + 2 * MIN)).toBe(false);
    expect(ts().find((x) => x.id === id)?.blinds).toEqual({ sb: 200, bb: 400, ante: 400 });
  });

  it("switches structure in the sheet both ways, keeping its start; saved hands keep their own", () => {
    store({ hands: [hand("h1", NIGHT - HOUR, { level: 7, tourney: "a" })], tourneys: [rec("a", { startSet: true, startStack: 50000 })] });
    expect(editTourney("a", { ...fieldsOf(ts()[0]), structure: "custom", blinds: B }, NIGHT)).toBe(true);
    expect(ts()[0]).toMatchObject({ structure: "custom", blinds: B, start: START, startSet: true, startStack: 50000 });
    expect(fieldsOf(ts()[0])).toMatchObject({ structure: "custom", blinds: B });
    expect(handLogStore.get().hands[0]).toMatchObject({ level: 7 });
    expect(editTourney("a", { ...fieldsOf(ts()[0]), structure: "pub", blinds: null }, NIGHT + MIN)).toBe(true);
    expect(ts()[0]).not.toHaveProperty("structure");
    expect(ts()[0]).not.toHaveProperty("blinds");
    expect(fastEstimate(NIGHT)?.level).toBe(9);
  });

  it("offers 야자수 새틀 with the pub's 50,000 for a new one; checks 직접 입력's blinds", () => {
    expect(newFields(NIGHT)).toMatchObject({ structure: "pub", blinds: null, stack: "50000" });
    expect(fieldsBlock({ ...custom })).toBeNull();
    expect(fieldsBlock({ ...custom, blinds: null })).toBeNull();
    expect(fieldsBlock({ ...custom, blinds: { sb: 300, bb: 200, ante: 0 } })).toBe("blinds");
    // 직접 입력 has no clock to read
    expect(fieldsBlock({ ...custom, clock: "저녁" })).toBeNull();
  });

  it("files a new hand of a 직접 입력 tournament with the tournament's blinds as its own", () => {
    const id = startTourney(custom, NIGHT - HOUR)!;
    const r = saveNewFast(hand("h1", NIGHT, { level: null, blinds: B, bbAnte: true, result: "fold", net: -400 }), NIGHT);
    expect(r).toMatchObject({ ok: true, hand: { tourney: id } });
    expect(handLogStore.get().hands[0]).toMatchObject({ level: null, blinds: B, net: -400 });
    // the blinds raised later: the hand keeps its own
    setTourneyBlinds(id, { sb: 200, bb: 400, ante: 400 }, NIGHT + MIN);
    expect(handLogStore.get().hands[0].blinds).toEqual(B);
  });
});
