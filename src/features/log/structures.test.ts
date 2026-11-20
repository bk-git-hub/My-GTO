import { describe, expect, it } from "vitest";
import { levelAt, levelSince, levelStartMinutes } from "./levelClock";
import { anyPresetLevel, isPresetId, PRESETS, presetBlinds, presetFrom, presetSpanMinutes, presetStart, WPL_DAY1, WPL_DAY1_BREAKS, WPL_DAY2, WPL_DAY2_BREAKS, WPL_DAY3, WPL_DAY3_BREAKS } from "./structures";

/**
 * The WPL 메인 이벤트's structures, pinned row by row against the official guide (9th Holdem Masters, pages 3–4):
 * [level, sb, bb, minutes] (every ante is a BB ante as big as the big blind), and every break.
 */

/** Tomorrow, 2026-11-21 (DAY1-B3), local time. */
const at = (h: number, m: number) => new Date(2026, 10, 21, h, m).getTime();
const D1 = at(10, 0);
const D2 = at(13, 0);

const PRESET_EVENTS = () => [...new Set(Object.values(PRESETS).map((p) => p.event))];
const rows = (t: typeof WPL_DAY1) => t.map((r) => [r.level, r.sb, r.bb, r.minutes]);

describe("WPL 메인: the three tables, as the sheet prints them", () => {
  it("DAY1: Lv1–24, 30 minutes, BB ante = BB, the breaks after 4, 8, 12 (20 min, 추가등록 마감), 16, 20 (20 min)", () => {
    expect(rows(WPL_DAY1)).toEqual([
      [1, 100, 100, 30],
      [2, 100, 200, 30],
      [3, 200, 300, 30],
      [4, 200, 400, 30],
      [5, 300, 500, 30],
      [6, 300, 600, 30],
      [7, 400, 800, 30],
      [8, 500, 1000, 30],
      [9, 600, 1200, 30],
      [10, 600, 1200, 30],
      [11, 800, 1600, 30],
      [12, 800, 1600, 30],
      [13, 1000, 2000, 30],
      [14, 1500, 2500, 30],
      [15, 1500, 3000, 30],
      [16, 2000, 4000, 30],
      [17, 2500, 5000, 30],
      [18, 3000, 6000, 30],
      [19, 4000, 8000, 30],
      [20, 5000, 10000, 30],
      [21, 6000, 12000, 30],
      [22, 8000, 16000, 30],
      [23, 10000, 20000, 30],
      [24, 12000, 24000, 30],
    ]);
    expect(WPL_DAY1_BREAKS).toEqual([
      { afterLevel: 4, minutes: 15 },
      { afterLevel: 8, minutes: 15 },
      { afterLevel: 12, minutes: 20, note: "추가등록 마감 · 100칩 레이스" },
      { afterLevel: 16, minutes: 15 },
      { afterLevel: 20, minutes: 20, note: "500칩 레이스" },
    ]);
  });

  it("DAY2: Lv19–30, 40 minutes, the breaks after 22, 26 (1,000칩 레이스), 30 (5,000칩 레이스)", () => {
    expect(rows(WPL_DAY2)).toEqual([
      [19, 4000, 8000, 40],
      [20, 5000, 10000, 40],
      [21, 6000, 12000, 40],
      [22, 8000, 16000, 40],
      [23, 10000, 20000, 40],
      [24, 15000, 30000, 40],
      [25, 20000, 40000, 40],
      [26, 25000, 50000, 40],
      [27, 30000, 60000, 40],
      [28, 40000, 80000, 40],
      [29, 50000, 100000, 40],
      [30, 60000, 120000, 40],
    ]);
    expect(WPL_DAY2_BREAKS).toEqual([
      { afterLevel: 22, minutes: 15 },
      { afterLevel: 26, minutes: 20, note: "1,000칩 레이스" },
      { afterLevel: 30, minutes: 20, note: "5,000칩 레이스" },
    ]);
  });

  it("DAY3: Lv31–46 at 60 minutes (the sheet's note; its column says 40), the breaks after 34, 38, 42", () => {
    expect(rows(WPL_DAY3)).toEqual([
      [31, 75000, 150000, 60],
      [32, 100000, 200000, 60],
      [33, 150000, 300000, 60],
      [34, 200000, 400000, 60],
      [35, 250000, 500000, 60],
      [36, 300000, 600000, 60],
      [37, 400000, 800000, 60],
      [38, 500000, 1000000, 60],
      [39, 600000, 1200000, 60],
      [40, 800000, 1600000, 60],
      [41, 1000000, 2000000, 60],
      [42, 1500000, 3000000, 60],
      [43, 2000000, 4000000, 60],
      [44, 2500000, 5000000, 60],
      [45, 3000000, 6000000, 60],
      [46, 4000000, 8000000, 60],
    ]);
    expect(WPL_DAY3_BREAKS).toEqual([
      { afterLevel: 34, minutes: 15 },
      { afterLevel: 38, minutes: 15 },
      { afterLevel: 42, minutes: 15 },
    ]);
  });

  it("has every ante a BB ante as big as the big blind, and sb ≤ bb", () => {
    for (const r of [...WPL_DAY1, ...WPL_DAY2, ...WPL_DAY3]) {
      expect(r.ante).toBe(r.bb);
      expect(r.sb).toBeLessThanOrEqual(r.bb);
    }
  });
});

describe("WPL 메인: the presets", () => {
  it("DAY1 10:00 with 35,000 from L1; DAY2 13:00 from L19 and DAY3 13:00 from L31, their stacks the day before's", () => {
    expect(PRESETS.wpl1).toMatchObject({ name: "WPL 메인 DAY1", short: "DAY1", clock: "10:00", startStack: 35000, startLevel: 1, pickStart: false });
    expect(PRESETS.wpl2).toMatchObject({ name: "WPL 메인 DAY2", short: "DAY2", clock: "13:00", startStack: null, startLevel: 19, pickStart: true });
    expect(PRESETS.wpl3).toMatchObject({ name: "WPL 메인 DAY3", short: "DAY3", clock: "13:00", startStack: null, startLevel: 31, pickStart: true });
    expect(PRESETS.wpl1.schedule).toBe(WPL_DAY1);
    expect(PRESETS.wpl1.breaks).toBe(WPL_DAY1_BREAKS);
  });

  it("lets DAY2 start below L19 (DAY1's Lv13–18 at 40 minutes) and DAY3 at a DAY2 level (Lv19–30 at 60 minutes)", () => {
    const d2 = PRESETS.wpl2.schedule;
    expect(d2.map((r) => r.level)).toEqual([13, 14, 15, 16, 17, 18, ...WPL_DAY2.map((r) => r.level)]);
    expect(d2.slice(0, 6).map((r) => [r.level, r.sb, r.bb, r.minutes])).toEqual(WPL_DAY1.slice(12, 18).map((r) => [r.level, r.sb, r.bb, 40]));
    expect(d2.slice(6)).toEqual(WPL_DAY2);
    expect(PRESETS.wpl2.breaks).toEqual([{ afterLevel: 16, minutes: 15 }, ...WPL_DAY2_BREAKS]);
    const d3 = PRESETS.wpl3.schedule;
    expect(d3.slice(0, 12).map((r) => [r.level, r.sb, r.bb, r.minutes])).toEqual(WPL_DAY2.map((r) => [r.level, r.sb, r.bb, 60]));
    expect(d3.slice(12)).toEqual(WPL_DAY3);
    expect(PRESETS.wpl3.breaks).toEqual([...WPL_DAY2_BREAKS, ...WPL_DAY3_BREAKS]);
  });

  it("runs DAY1 13 h 25 min, DAY2 from L19 8 h 35 min, DAY3 from L31 16 h 45 min; DAY1 can be joined till 16:50", () => {
    expect(presetSpanMinutes(PRESETS.wpl1, 1)).toBe(13 * 60 + 25);
    expect(presetSpanMinutes(PRESETS.wpl2, 19)).toBe(8 * 60 + 35);
    expect(presetSpanMinutes(PRESETS.wpl3, 31)).toBe(16 * 60 + 45);
    expect(PRESETS.wpl1.joinMinutes).toBe(6 * 60 + 50);
    expect([PRESETS.wpl2.joinMinutes, PRESETS.wpl3.joinMinutes]).toEqual([360, 360]);
    expect(PRESET_EVENTS()).toEqual(["WPL 메인 이벤트"]);
  });

  it("gives a level's blinds with its number, and the table from a start level on", () => {
    expect(presetBlinds(PRESETS.wpl1, 1)).toEqual({ sb: 100, bb: 100, ante: 100, lv: 1 });
    expect(presetBlinds(PRESETS.wpl1, 12)).toEqual({ sb: 800, bb: 1600, ante: 1600, lv: 12 });
    expect(presetBlinds(PRESETS.wpl2, 24)).toEqual({ sb: 15000, bb: 30000, ante: 30000, lv: 24 });
    expect(presetBlinds(PRESETS.wpl1, 25)).toBeNull();
    expect(presetBlinds(PRESETS.wpl1, null)).toBeNull();
    expect(presetStart(PRESETS.wpl2, 21)).toBe(21);
    expect(presetStart(PRESETS.wpl2, 31)).toBe(19);
    expect(presetStart(PRESETS.wpl2, undefined)).toBe(19);
    expect(presetStart(PRESETS.wpl1, 5)).toBe(1);
    expect(presetFrom(PRESETS.wpl2, 21)[0].level).toBe(21);
    expect(presetFrom(PRESETS.wpl3, undefined)[0].level).toBe(31);
    expect(isPresetId("wpl1") && isPresetId("wpl3") && !isPresetId("wpl4") && !isPresetId("custom")).toBe(true);
    expect([1, 24, 31, 46].every(anyPresetLevel)).toBe(true);
    expect(anyPresetLevel(47) || anyPresetLevel(0)).toBe(false);
  });
});

describe("WPL 메인: the clock", () => {
  const day1 = (h: number, m: number) => levelAt(D1, at(h, m), WPL_DAY1, WPL_DAY1_BREAKS);

  it("DAY1 from 10:00: 30-minute levels, the breaks in between", () => {
    expect(day1(10, 0)).toMatchObject({ level: 1, phase: "level", minutesLeft: 30 });
    expect(day1(10, 29)).toMatchObject({ level: 1, phase: "level" });
    expect(day1(10, 30)).toMatchObject({ level: 2, phase: "level" });
    expect(day1(10, 40)).toMatchObject({ level: 2, phase: "level", minutesIn: 10, minutesLeft: 20 });
    expect(day1(11, 59)).toMatchObject({ level: 4, phase: "level" });
    expect(day1(12, 0)).toMatchObject({ level: 4, phase: "break", nextLevel: 5, minutesLeft: 15 });
    expect(day1(12, 14)).toMatchObject({ level: 4, phase: "break" });
    expect(day1(12, 15)).toMatchObject({ level: 5, phase: "level" });
    expect(day1(14, 14)).toMatchObject({ level: 8, phase: "level" });
    expect(day1(14, 15)).toMatchObject({ level: 8, phase: "break", nextLevel: 9 });
    expect(day1(14, 30)).toMatchObject({ level: 9, phase: "level" });
    expect(day1(16, 10)).toMatchObject({ level: 12, phase: "level" });
    // the 20-minute break after Lv12 (추가등록 마감)
    expect(day1(16, 30)).toMatchObject({ level: 12, phase: "break", nextLevel: 13, minutesLeft: 20 });
    expect(day1(16, 49)).toMatchObject({ level: 12, phase: "break" });
    expect(day1(16, 50)).toMatchObject({ level: 13, phase: "level" });
    expect(day1(18, 50)).toMatchObject({ level: 16, phase: "break", minutesLeft: 15 });
    expect(day1(19, 5)).toMatchObject({ level: 17, phase: "level" });
    expect(day1(21, 5)).toMatchObject({ level: 20, phase: "break", minutesLeft: 20 });
    expect(day1(21, 25)).toMatchObject({ level: 21, phase: "level" });
    expect(day1(23, 24)).toMatchObject({ level: 24, phase: "level" });
    expect(day1(23, 25)).toMatchObject({ level: 24, phase: "after" });
    expect(day1(9, 50)).toMatchObject({ level: null, phase: "before", minutesLeft: 10, nextLevel: 1 });
    expect(levelStartMinutes(13, WPL_DAY1, WPL_DAY1_BREAKS)).toBe(12 * 30 + 15 + 15 + 20);
  });

  it("DAY2 from L19 at 13:00: 40-minute levels; from L21 the same clock runs on from there", () => {
    const day2 = (from: number, h: number, m: number) => levelAt(D2, at(h, m), presetFrom(PRESETS.wpl2, from), PRESETS.wpl2.breaks);
    expect(day2(19, 13, 0)).toMatchObject({ level: 19, phase: "level" });
    expect(day2(19, 13, 39)).toMatchObject({ level: 19 });
    expect(day2(19, 13, 40)).toMatchObject({ level: 20, phase: "level" });
    expect(day2(19, 15, 39)).toMatchObject({ level: 22, phase: "level" });
    expect(day2(19, 15, 40)).toMatchObject({ level: 22, phase: "break", nextLevel: 23, minutesLeft: 15 });
    expect(day2(19, 15, 55)).toMatchObject({ level: 23, phase: "level" });
    expect(day2(19, 18, 35)).toMatchObject({ level: 26, phase: "break", minutesLeft: 20 });
    expect(day2(19, 18, 55)).toMatchObject({ level: 27, phase: "level" });
    expect(day2(21, 13, 0)).toMatchObject({ level: 21, phase: "level" });
    expect(day2(21, 14, 20)).toMatchObject({ level: 22, phase: "break" });
    expect(day2(21, 14, 35)).toMatchObject({ level: 23, phase: "level" });
    // started below L19: DAY1's levels at DAY2's pace, then DAY2's own
    expect(day2(17, 13, 40)).toMatchObject({ level: 18, phase: "level" });
    expect(day2(17, 14, 20)).toMatchObject({ level: 19, phase: "level" });
  });

  it("DAY3 from L31 at 13:00: 60-minute levels and its breaks; from a DAY2 level, that level first", () => {
    const day3 = (from: number, h: number, m: number) => levelAt(D2, at(h, m), presetFrom(PRESETS.wpl3, from), PRESETS.wpl3.breaks);
    expect(day3(31, 13, 59)).toMatchObject({ level: 31, phase: "level" });
    expect(day3(31, 14, 0)).toMatchObject({ level: 32, phase: "level" });
    expect(day3(31, 16, 59)).toMatchObject({ level: 34 });
    expect(day3(31, 17, 0)).toMatchObject({ level: 34, phase: "break", nextLevel: 35, minutesLeft: 15 });
    expect(day3(31, 17, 15)).toMatchObject({ level: 35, phase: "level" });
    expect(day3(29, 13, 0)).toMatchObject({ level: 29 });
    expect(day3(29, 14, 0)).toMatchObject({ level: 30 });
    expect(day3(29, 15, 0)).toMatchObject({ level: 30, phase: "break", minutesLeft: 20 });
    expect(day3(29, 15, 20)).toMatchObject({ level: 31, phase: "level" });
  });

  it("moves a level picked on with the clock from the pick (DAY1: L2 picked at 10:40 is L3 at 11:10, L4 at 11:40, a break at 12:10)", () => {
    const since = (lv: number, pick: number, now: number) => levelSince(lv, pick, now, WPL_DAY1, WPL_DAY1_BREAKS);
    expect(since(2, at(10, 40), at(11, 9))).toBe(2);
    expect(since(2, at(10, 40), at(11, 10))).toBe(3);
    expect(since(2, at(10, 40), at(11, 40))).toBe(4);
    expect(since(2, at(10, 40), at(12, 10))).toBe(4);
    expect(since(2, at(10, 40), at(12, 25))).toBe(5);
    // DAY3's hour
    expect(levelSince(33, at(13, 0), at(13, 59), PRESETS.wpl3.schedule, PRESETS.wpl3.breaks)).toBe(33);
    expect(levelSince(33, at(13, 0), at(14, 0), PRESETS.wpl3.schedule, PRESETS.wpl3.breaks)).toBe(34);
    expect(levelSince(33, at(13, 0), at(15, 0), PRESETS.wpl3.schedule, PRESETS.wpl3.breaks)).toBe(34);
    expect(levelSince(33, at(13, 0), at(15, 15), PRESETS.wpl3.schedule, PRESETS.wpl3.breaks)).toBe(35);
  });
});
