import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as old from "../../../tests/fixtures/oldBuild34da70a";
import { bbPart, blindsText, chipSeries, handLv, levelChip, levelNear, netBoth, postedBy, walkWin } from "./fastChips";
import { cleanFastState, draftOf, fastStore, freshDraft, pickRes, resultParts, sessionText, withFastResult, type FastState } from "./fastLog";
import {
  anteFor,
  currentTourney,
  editTourney,
  fastEstimate,
  fieldsBlock,
  fieldsOf,
  infoOf,
  isCustom,
  levelFor,
  presetEstimate,
  presetOf,
  presetStartMs,
  saveNewFast,
  setFastStartClock,
  settleSpan,
  sheetLevelText,
  stageLevel,
  startLevelText,
  startNote,
  startTourney,
  tourneyEstimate,
  tourneyForNew,
  tourneyWhenAt,
  type TourneyFields,
} from "./fastTourney";
import { emptyHand, handLevelLabel, handLogStore, migrateStore, sanitize, type HandLogState, type LoggedHand } from "./handLog";
import { LevelRow } from "./inputs";
import { cleanBlinds, type Blinds } from "./levelClock";
import { PRESETS, presetBlinds } from "./structures";
import { cleanTourneys, withTourney, type Tourney } from "./tourney";
import { TourneySheet } from "./TourneySheet";

/**
 * 빠른 기록's WPL 메인 presets end to end: a tournament started from the sheet follows the WPL clock (its own
 * table, its breaks, its start level), its hands carry their blinds (with the level's number) so every chip and bb
 * figure is the WPL table's, and what it stores reads back right in this build without a rewrite and degrades to
 * 직접 입력 at the right blinds in the build before presets (tests/fixtures/oldBuild34da70a.ts).
 */

/** Tomorrow, 2026-11-21 (DAY1-B3), local time. */
const at = (h: number, m: number) => new Date(2026, 10, 21, h, m).getTime();
const L = (n: number, p = PRESETS.wpl1) => presetBlinds(p, n) as Blinds;

const day1: TourneyFields = { name: "WPL 메인 DAY1", clock: "10:00", stack: "35000", memo: "", structure: "wpl1", blinds: null };
const store = (extra: Partial<HandLogState> = {}) => handLogStore.set({ hands: [], lastLevel: null, ...extra });
const ts = () => cleanTourneys(handLogStore.get().tourneys);
const tOf = (id: string) => ts().find((t) => t.id === id) as Tourney;
const hand = (id: string, when: number, extra: Partial<LoggedHand> = {}): LoggedHand => ({ ...emptyHand(null), id, createdAt: when, updatedAt: when, seat: "BTN", fast: true, ...extra });

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

describe("WPL 메인 DAY1: the tournament and its clock", () => {
  it("is stored as 직접 입력 at L1's blinds with its preset, its 10:00 start and 35,000", () => {
    const id = startTourney(day1, at(9, 55))!;
    const t = tOf(id);
    expect(t).toMatchObject({ name: "WPL 메인 DAY1", start: at(10, 0), startSet: true, startStack: 35000, structure: "custom", blinds: { sb: 100, bb: 100, ante: 100 }, preset: "wpl1" });
    // the record's blinds are the chips only; DAY1 has no start level of its own to keep
    expect(t.blinds).not.toHaveProperty("lv");
    expect(t).not.toHaveProperty("startLevel");
    expect(presetOf(t)?.id).toBe("wpl1");
    expect(isCustom(t)).toBe(false);
    expect(fieldsOf(t)).toMatchObject({ structure: "wpl1", clock: "10:00", stack: "35000" });
    expect(fieldsOf(t)).not.toHaveProperty("startLevel");
  });

  it("follows the WPL clock from 10:00: L1, L2 at 10:30, the break at 12:00 keeps L4, L5 at 12:15, L12 at 16:10, L13 after the 20-minute break", () => {
    const id = startTourney(day1, at(9, 55))!;
    const t = tOf(id);
    const lv = (h: number, m: number) => levelFor(t, {}, [], at(h, m), tourneyEstimate(t, at(h, m), null));
    expect(lv(10, 0)).toEqual({ level: L(1), guessed: true, picked: false });
    expect(lv(10, 29).level).toEqual(L(1));
    expect(lv(10, 30).level).toEqual(L(2));
    expect(lv(10, 40).level).toEqual({ sb: 100, bb: 200, ante: 200, lv: 2 });
    expect(lv(12, 0).level).toEqual(L(4));
    expect(tourneyEstimate(t, at(12, 0), null)).toMatchObject({ phase: "break", nextLevel: 5 });
    expect(lv(12, 15).level).toEqual(L(5));
    expect(lv(16, 10).level).toEqual(L(12));
    expect(lv(16, 49).level).toEqual(L(12));
    expect(lv(16, 50).level).toEqual(L(13));
    // before the start: no level (the chip asks)
    expect(lv(9, 59).level).toBeNull();
    // the day's 야자수 새틀 start never stands in for it
    expect(tourneyEstimate({ ...t, startSet: undefined }, at(10, 40), { level: 9, phase: "level", minutesIn: 0, minutesLeft: 1, elapsedMinutes: 0 })).toBeNull();
    // 빠른 기록's estimate is the tournament's own (the current one)
    expect(fastEstimate(at(10, 40))).toMatchObject({ level: 2, phase: "level", startClock: "10:00" });
    // its level numbers aren't 야자수 새틀's: the first visit's stage isn't guessed from them
    expect(stageLevel(at(10, 40))).toBeNull();
  });

  it("shows the level chip as L2 100/200 and the sheet's line by the WPL table", () => {
    expect(levelChip(L(2))).toBe("L2 100/200");
    expect(levelChip(L(17))).toBe("L17 2,500/5,000");
    expect(levelChip(presetBlinds(PRESETS.wpl3, 31))).toBe("L31 7.5만/15만");
    expect(handLevelLabel({ level: null, blinds: L(2) })).toBe("L2 · 100/200 · 앤티 200");
    expect(startLevelText("10:00", at(10, 40), at(10, 40), day1)).toBe("지금 L2 100/200");
    expect(startLevelText("10:00", at(9, 40), at(9, 40), day1)).toBe("시작 전 · 20분 뒤");
    expect(startLevelText("10:00", at(12, 5), at(12, 5), day1)).toBe("지금 휴식 (L4 200/400)");
    expect(sheetLevelText("10:00", null, [], at(10, 40), day1)).toBe("지금 L2 100/200");
    // 야자수 새틀 as before for the same clock
    expect(startLevelText("10:00", at(10, 40), at(10, 40), { structure: "pub" })).toBe("지금 Lv3 200/400");
    expect(startLevelText("10:00", at(10, 40), at(10, 40))).toBe("지금 Lv3 200/400");
  });

  it("always has the BB ante (= BB), the toggle doesn't apply", () => {
    const t = tOf(startTourney(day1, at(9, 55))!);
    expect(anteFor(t, { noAnte: true })).toBe(true);
    expect(anteFor(t, {})).toBe(true);
  });
});

describe("WPL 메인: a level picked moves on with the WPL clock", () => {
  it("L4 picked at 10:40 (the clock: L2) runs from 10:30, on the clock's boundaries: the break at 11:00, L5 from 11:15; 레벨 모름 picked holds", () => {
    const id = startTourney(day1, at(9, 55))!;
    const t = tOf(id);
    const s: Pick<FastState, "levelPick"> = { levelPick: { level: 4, at: at(10, 40), t: id } };
    const lv = (h: number, m: number) => levelFor(t, s, [], at(h, m), tourneyEstimate(t, at(h, m), null));
    expect(lv(10, 40)).toEqual({ level: L(4), guessed: false, picked: true });
    expect(lv(10, 59).level).toEqual(L(4));
    expect(lv(11, 0)).toEqual({ level: L(4), guessed: false, picked: true });
    expect(lv(11, 14).level).toEqual(L(4));
    expect(lv(11, 15)).toEqual({ level: L(5), guessed: true, picked: true });
    expect(lv(11, 55).level).toEqual(L(6));
    expect(levelFor(t, { levelPick: { level: null, at: at(10, 40), t: id } }, [], at(11, 0), tourneyEstimate(t, at(11, 0), null))).toEqual({ level: null, guessed: false, picked: true });
    // a pick of another tournament, or of a level this table doesn't have, is no pick
    expect(levelFor(t, { levelPick: { level: 4, at: at(10, 40), t: "other" } }, [], at(10, 40), tourneyEstimate(t, at(10, 40), null)).level).toEqual(L(2));
    expect(levelFor(t, { levelPick: { level: 30, at: at(10, 40), t: id } }, [], at(10, 40), tourneyEstimate(t, at(10, 40), null)).level).toEqual(L(2));
  });

  it("keeps a DAY3 level picked in the editor's store (Lv31–46 aren't 야자수 새틀's)", () => {
    expect(cleanFastState({ levelPick: { level: 35, at: 1, t: "t-1" } }).levelPick).toEqual({ level: 35, at: 1, t: "t-1" });
    expect(cleanFastState({ levelPick: { level: 47, at: 1 } }).levelPick).toBeUndefined();
  });

  it("never takes a level picked before it existed (in 야자수 새틀's numbers)", () => {
    fastStore.set({ levelPick: { level: 9, at: at(9, 50) } });
    const id = startTourney(day1, at(9, 55))!;
    expect(fastStore.get().levelPick).toEqual({ level: 9, at: at(9, 50) });
    const t = tOf(id);
    expect(levelFor(t, cleanFastState(fastStore.get()), [], at(10, 40), tourneyEstimate(t, at(10, 40), null)).level).toEqual(L(2));
  });

  it("sets its start from the level picker's clock, never the day's start (야자수 새틀's)", () => {
    const id = startTourney(day1, at(9, 55))!;
    expect(setFastStartClock("10:15", at(10, 40))).toMatchObject({ level: 1, startClock: "10:15" });
    expect(tOf(id)).toMatchObject({ start: at(10, 15), startSet: true, preset: "wpl1" });
    expect(handLogStore.get().startClock).toBeUndefined();
    expect(setFastStartClock("저녁", at(10, 40))).toBe(false);
    // a corrected hand's time by the tournament's table, nothing stored
    expect(presetEstimate(tOf(id), "10:00", at(11, 5))).toMatchObject({ level: 3, startClock: "10:00" });
    expect(tOf(id).start).toBe(at(10, 15));
  });
});

describe("WPL 메인: the chips of a hand at the WPL blinds", () => {
  it("costs SB 100 / BB 100+100 to fold at L1, the walk wins 100", () => {
    expect(postedBy("SB", L(1), true)).toBe(100);
    expect(postedBy("BB", L(1), true)).toBe(200);
    expect(postedBy("BTN", L(1), true)).toBe(0);
    expect(walkWin(L(1))).toBe(100);
    expect(postedBy("BB", L(2), true)).toBe(400);
    expect(postedBy("SB", L(12), true)).toBe(800);
  });

  it("saves a blind's fold with its blinds and level number, the bb counted at them", () => {
    const t = tOf(startTourney(day1, at(9, 55))!);
    const lv = levelFor(t, {}, [], at(10, 5), tourneyEstimate(t, at(10, 5), null));
    const base = hand("f1", at(10, 5), { seat: "BB", level: 5, levelGuess: true });
    const h = withFastResult(base, pickRes(freshDraft({}, "BB"), "fold"), lv, anteFor(t, {}))!;
    expect(h).toMatchObject({ level: null, blinds: { sb: 100, bb: 100, ante: 100, lv: 1 }, net: -200, result: "fold", bbAnte: true });
    expect(h).not.toHaveProperty("levelGuess");
    expect(resultParts(h)).toEqual({ text: "폴드 −200", bb: "−2bb" });
    // corrected: the draft brings its blinds back
    expect(draftOf(h)).toMatchObject({ level: null, blinds: { sb: 100, bb: 100, ante: 100, lv: 1 }, res: "fold" });
  });

  it("counts bb at the hand's own level everywhere: amounts, −1bb, the graph, a 칩 업데이트, ⏳ settled", () => {
    const id = startTourney(day1, at(9, 55))!;
    const hs = [
      hand("a", at(10, 10), { level: null, blinds: L(1), bbAnte: true, net: 1500, result: "win", tourney: id }),
      hand("b", at(10, 35), { level: null, blinds: L(2), bbAnte: true, net: null, result: "win", tourney: id }),
    ];
    expect(bbPart(1500, handLv(hs[0]), true)).toBe("+15bb");
    expect(netBoth(1500, handLv(hs[0]))).toBe("+1,500 (+15bb)");
    // −1bb at L2: 200 chips
    expect(cleanBlinds(L(2))?.bb).toBe(200);
    // the chip graph in bb: each hand at its own big blind, from 35,000 (350bb at L1)
    const g = chipSeries(hs, "bb", 35000)!;
    expect(g.unit).toBe("bb");
    expect(g.segments.flat()[0].y).toBe(350);
    // a 칩 업데이트 between hands: at the level of the hand before it
    expect(levelNear(hs, at(10, 40))).toEqual(L(2));
    // ⏳ at L2 filled by a 칩 업데이트 of 37,500: +1,000 = +5bb at its 200
    store({ hands: hs, tourneys: [{ ...tOf(id), checks: [{ at: at(10, 45), stack: 37500 }] }] });
    const span = settleSpan(handLogStore.get(), id)!;
    expect(span.total).toBe(1000);
    expect(bbPart(span.total, handLv(span.pending[0]), true)).toBe("+5bb");
  });

  it("files a new hand with the tournament's blinds kept as the blinds of now (for an older app)", () => {
    const id = startTourney(day1, at(9, 55))!;
    writes = [];
    const r = saveNewFast(hand("n1", at(10, 40), { level: null, blinds: L(2), bbAnte: true, result: "fold", net: 0 }), at(10, 40));
    expect(r).toMatchObject({ ok: true, hand: { tourney: id } });
    expect(writes.filter((k) => k === "mygto.handlog")).toHaveLength(1);
    expect(tOf(id)).toMatchObject({ blinds: { sb: 100, bb: 200, ante: 200 }, preset: "wpl1", updatedAt: at(9, 55) });
    expect(handLogStore.get().hands[0]).toMatchObject({ blinds: { sb: 100, bb: 200, ante: 200, lv: 2 } });
  });

  it("names the event in the copied summary", () => {
    const id = startTourney(day1, at(9, 55))!;
    const hs = [hand("a", at(10, 10), { level: null, blinds: L(1), bbAnte: true, net: 1500, result: "win", tourney: id, hole: [48, 44] })];
    const text = sessionText(hs, "mine", infoOf(tOf(id), hs));
    expect(text.split("\n")[0]).toBe("PubAJ 빠른 기록 · WPL 메인 DAY1 · 11월 21일 (토) 10:00 시작 · 1핸드 (WPL 메인 이벤트)");
    expect(text.split("\n")[1]).toBe("구조: DAY1 · 30분 레벨 · L1");
    // the name once: the event and the day are said by the other parts
    expect(text.match(/WPL 메인 DAY1/g)).toHaveLength(1);
    expect(text).toContain("+1,500 (+15bb)");
    expect(text).toContain("시작 스택 35,000");
  });
});

describe("WPL 메인 DAY2 / DAY3: the start level", () => {
  it("DAY2 from L19 at 13:00 (13:40: L20), its stack typed; from L21 the clock runs from there", () => {
    const id = startTourney({ name: "WPL 메인 DAY2", clock: "13:00", stack: "", memo: "", structure: "wpl2", startLevel: 19 }, at(12, 50))!;
    const t = tOf(id);
    expect(t).toMatchObject({ structure: "custom", preset: "wpl2", startLevel: 19, startStack: null, blinds: { sb: 4000, bb: 8000, ante: 8000 }, start: at(13, 0) });
    expect(levelFor(t, {}, [], at(13, 39), tourneyEstimate(t, at(13, 39), null)).level).toEqual(L(19, PRESETS.wpl2));
    expect(levelFor(t, {}, [], at(13, 40), tourneyEstimate(t, at(13, 40), null)).level).toEqual(L(20, PRESETS.wpl2));
    expect(fieldsOf(t)).toMatchObject({ structure: "wpl2", startLevel: 19, stack: "" });
    expect(editTourney(id, { ...fieldsOf(t), startLevel: 21 }, at(13, 5))).toBe(true);
    const t2 = tOf(id);
    expect(t2).toMatchObject({ startLevel: 21, blinds: { sb: 6000, bb: 12000, ante: 12000 } });
    expect(levelFor(t2, {}, [], at(13, 41), tourneyEstimate(t2, at(13, 41), null)).level).toEqual(L(22, PRESETS.wpl2));
    expect(startLevelText("13:00", at(13, 41), at(13, 41), { structure: "wpl2", startLevel: 21 })).toBe("지금 L22 8,000/1.6만");
  });

  it("DAY3 from L31 by default (60-minute levels); a start level the table doesn't have falls back to it", () => {
    const id = startTourney({ name: "", clock: "13:00", stack: "1500000", memo: "", structure: "wpl3", startLevel: null }, at(12, 50))!;
    const t = tOf(id);
    expect(t).toMatchObject({ preset: "wpl3", startLevel: 31, startStack: 1500000 });
    expect(levelFor(t, {}, [], at(13, 59), tourneyEstimate(t, at(13, 59), null)).level).toEqual(L(31, PRESETS.wpl3));
    expect(levelFor(t, {}, [], at(14, 0), tourneyEstimate(t, at(14, 0), null)).level).toEqual(L(32, PRESETS.wpl3));
    const odd = tOf(startTourney({ name: "", clock: "13:00", stack: "", memo: "", structure: "wpl3", startLevel: 5 }, at(12, 51))!);
    expect(odd.startLevel).toBe(31);
  });

  it("drops a level picked in it when the sheet changes its start level or its structure (not for a name)", () => {
    const id = startTourney({ name: "", clock: "13:00", stack: "", memo: "", structure: "wpl2", startLevel: 19 }, at(12, 50))!;
    const pick = { levelPick: { level: 20, at: at(13, 50), t: id } };
    fastStore.set(pick);
    expect(editTourney(id, { ...fieldsOf(tOf(id)), name: "DAY2-B" }, at(13, 51))).toBe(true);
    expect(fastStore.get()).toEqual(pick);
    expect(editTourney(id, { ...fieldsOf(tOf(id)), startLevel: 20 }, at(13, 52))).toBe(true);
    expect(fastStore.get().levelPick).toBeUndefined();
    fastStore.set(pick);
    expect(editTourney(id, { ...fieldsOf(tOf(id)), structure: "pub" }, at(13, 53))).toBe(true);
    expect(fastStore.get().levelPick).toBeUndefined();
    // another tournament's pick stays
    const other = { levelPick: { level: 9, at: at(13, 50), t: "t-other" } };
    fastStore.set(other);
    expect(editTourney(id, { ...fieldsOf(tOf(id)), structure: "wpl1" }, at(13, 54))).toBe(true);
    expect(fastStore.get()).toEqual(other);
  });

  it("switches structure in the sheet both ways; saved hands keep their own blinds", () => {
    const id = startTourney(day1, at(9, 55))!;
    store({ ...handLogStore.get(), hands: [hand("h1", at(10, 40), { level: null, blinds: L(2), tourney: id })] });
    expect(editTourney(id, { ...fieldsOf(tOf(id)), structure: "pub" }, at(10, 45))).toBe(true);
    expect(tOf(id)).not.toHaveProperty("structure");
    expect(tOf(id)).not.toHaveProperty("preset");
    expect(tOf(id)).not.toHaveProperty("blinds");
    expect(tOf(id)).toMatchObject({ start: at(10, 0), startSet: true });
    expect(editTourney(id, { ...fieldsOf(tOf(id)), structure: "wpl1" }, at(10, 46))).toBe(true);
    expect(tOf(id)).toMatchObject({ structure: "custom", preset: "wpl1" });
    expect(editTourney(id, { ...fieldsOf(tOf(id)), structure: "custom", blinds: { sb: 300, bb: 600, ante: 600 } }, at(10, 47))).toBe(true);
    expect(tOf(id)).toMatchObject({ structure: "custom", blinds: { sb: 300, bb: 600, ante: 600 } });
    expect(tOf(id)).not.toHaveProperty("preset");
    expect(isCustom(tOf(id))).toBe(true);
    expect(handLogStore.get().hands[0].blinds).toEqual(L(2));
    expect(fieldsBlock({ ...day1, clock: "저녁" })).toBe("clock");
  });
});

describe("WPL 메인: the screens", () => {
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
  const noop = () => {};

  it("offers DAY1 / DAY2 / DAY3 next to 야자수 새틀 and 직접 입력 in the new-tournament sheet", () => {
    const out = html(createElement(TourneySheet, { mode: "new", initial: { name: "", clock: "19:00", stack: "50000", memo: "", structure: "pub", blinds: null }, defaultName: "11/21 토너먼트", onSave: () => null, onClose: noop }));
    for (const t of ["야자수 새틀", "직접 입력", "WPL", "메인", "DAY1", "DAY2", "DAY3", "10:00", "13:00"]) expect(out).toContain(t);
    expect(out).toContain('aria-label="WPL 메인 DAY1 · 10:00 시작"');
    expect((out.match(/role="radio"/g) ?? []).length).toBe(5);
  });

  it("shows DAY1's start, stack in bb at L1 and the level now; DAY2's start level to pick and its stack to type", () => {
    const d1 = html(createElement(TourneySheet, { mode: "new", initial: day1, defaultName: "", levelText: () => "지금 L2 100/200", onSave: () => null, onClose: noop }));
    expect(d1).toContain('aria-checked="true" aria-label="WPL 메인 DAY1 · 10:00 시작"');
    expect(d1).toContain('value="10:00"');
    expect(d1).toContain("35,000");
    expect(d1).toContain("350bb");
    expect(d1).toContain("L1 기준");
    expect(d1).toContain("지금 L2 100/200");
    expect(d1).not.toContain("시작 레벨");
    const d2 = html(createElement(TourneySheet, { mode: "new", initial: { name: "WPL 메인 DAY2", clock: "13:00", stack: "", memo: "", structure: "wpl2", startLevel: 19 }, defaultName: "", onSave: () => null, onClose: noop }));
    expect(d2).toContain("시작 레벨");
    expect(d2).toMatch(/<option value="19" selected="">L19 4,000\/8,000<\/option>/);
    expect(d2).toContain('<option value="13">L13 1,000/2,000</option>');
    expect(d2).toContain("DAY1 끝난 칩을 넣어요");
  });

  it("lists the WPL levels by number in the level picker, its breaks between them, no ante switch", () => {
    const p = PRESETS.wpl1;
    const out = html(
      createElement(LevelRow, {
        h: { id: "x", level: 2, levelGuess: true, bbAnte: true, createdAt: at(10, 40) },
        onLevel: noop,
        onAnte: noop,
        open: true,
        onToggle: noop,
        estimate: { level: 2, phase: "level", minutesIn: 10, minutesLeft: 20, elapsedMinutes: 40, startClock: "10:00", nextLevel: 3 },
        ladder: { rows: p.schedule, breaks: p.breaks },
      }),
    );
    expect(out).toContain("L2 · 100/200");
    expect(out).toContain("⏱ L2 추정 · 10:00 시작 40분째");
    expect(out).toContain("<small>L24</small>");
    expect(out).toContain("100/100");
    expect((out.match(/class="lv-brk/g) ?? []).length).toBe(5);
    expect(out).toContain("<small>20분</small>");
    expect(out).not.toContain('type="checkbox"');
    expect(out).toContain("BB 앤티 = BB");
    expect(out).not.toContain("Lv");
  });
});

describe("WPL 메인: what it stores, read by this build and by the build before presets", () => {
  /** A morning's state as this build writes it: a DAY1 tournament, a fold at L1 and a pot at L2. */
  function morning(): HandLogState {
    const id = startTourney(day1, at(9, 55))!;
    saveNewFast(hand("h1", at(10, 5), { seat: "BB", level: null, blinds: L(1), bbAnte: true, result: "fold", net: -200 }), at(10, 5));
    saveNewFast(hand("h2", at(10, 40), { seat: "CO", level: null, blinds: L(2), bbAnte: true, result: "win", net: 2400 }), at(10, 40));
    void id;
    return JSON.parse(mem.get("mygto.handlog")!) as HandLogState;
  }

  it("loads back with nothing rewritten (migrateStore: no change), the records and hands clean as stored", () => {
    const s = morning();
    expect(migrateStore(s, null)).toBeNull();
    expect(JSON.stringify(cleanTourneys(s.tourneys))).toBe(JSON.stringify(s.tourneys));
    // (sanitize, run only for a hand that needs it, keeps every field: the level number in its blinds too)
    for (const h of s.hands) expect(sanitize(h)).toEqual(h);
    // a 직접 입력 and a 야자수 새틀 tournament stored by the build before presets: the same bytes back
    const before = [
      { id: "t-c", createdAt: 1, updatedAt: 1, activeAt: 1, name: "목", memo: "", start: 1, startStack: 30000, structure: "custom", blinds: { sb: 100, bb: 200, ante: 200 } },
      { id: "t-p", createdAt: 2, updatedAt: 2, activeAt: 2, name: "", memo: "", start: 2, startSet: true, startStack: null },
    ];
    expect(JSON.stringify(cleanTourneys(before))).toBe(JSON.stringify(before));
    expect(migrateStore({ hands: [], lastLevel: null, tourneys: before as Tourney[] }, null)).toBeNull();
  });

  it("reads in the build before presets as 직접 입력 at the blinds of now, its hands at their own blinds, nothing sanitized", () => {
    const s = morning();
    // the tournament: 직접 입력, the last hand's blinds (L2), never 야자수 새틀 guessed from its 10:00 start
    const t = old.cleanTourneys(s.tourneys)[0];
    expect(t).toMatchObject({ structure: "custom", blinds: { sb: 100, bb: 200, ante: 200 }, name: "WPL 메인 DAY1", start: at(10, 0), startStack: 35000 });
    expect(old.isCustom(t)).toBe(true);
    expect(old.estimates(t)).toBe(false);
    expect(old.customLevel(t)).toEqual({ sb: 100, bb: 200, ante: 200 });
    // the hands: no sanitize on load (so no rewrite), the bb maths at their own blinds
    for (const h of s.hands) expect(old.needsSanitizeLines(h)).toBe(false);
    const fold = s.hands.find((h) => h.id === "h1")!;
    const pot = s.hands.find((h) => h.id === "h2")!;
    expect(old.blindsOfCustom(old.handLv(fold))).toEqual({ sb: 100, bb: 100, ante: 100 });
    expect(old.postedBy("BB", old.blindsOfCustom(old.handLv(fold)))).toBe(200);
    expect(2400 / old.blindsOfCustom(old.handLv(pot))!.bb).toBe(12);
    // that build writes the list back without the preset (it doesn't know it): the tournament stays 직접 입력 at L2's blinds here too
    expect(old.rewritesTourneysOnLoad(s.tourneys)).toBe(true);
    const back = cleanTourneys(old.cleanTourneys(s.tourneys))[0];
    expect(back).toMatchObject({ structure: "custom", blinds: { sb: 100, bb: 200, ante: 200 } });
    expect(isCustom(back)).toBe(true);
    expect(levelFor(back, {}, [], at(11, 0), null).level).toEqual({ sb: 100, bb: 200, ante: 200 });
    // a hand that build saved there (no level number): this build reads it at its blinds, labelled as 직접 입력
    const oldHand = { ...pot, id: "h3", blinds: { sb: 100, bb: 200, ante: 200 } };
    expect(sanitize(oldHand)).toEqual(oldHand);
    expect(levelChip(handLv(oldHand), true)).toBe("100/200");
    expect(blindsText(handLv(oldHand) as Blinds)).toBe("100/200 · 앤티 200");
  });

  it("keeps the preset through a backup merge and in the stored list (withTourney)", () => {
    const s = morning();
    const t = cleanTourneys(s.tourneys)[0];
    const merged = withTourney({ tourneys: [] as unknown }, t).tourneys[0];
    expect(merged).toEqual(t);
    expect(merged).toMatchObject({ preset: "wpl1" });
  });
});

describe("WPL 메인: set up the night before", () => {
  /** Tonight, 2026-11-20 (Fri), and the DAY2-B / DAY3 days. */
  const nov20 = (h: number, m: number) => new Date(2026, 10, 20, h, m).getTime();
  const dec = (d: number, h: number, m: number) => new Date(2026, 11, d, h, m).getTime();

  it("DAY1 made at 22:00 is the next morning's: dated in the sheet and the header, current through the night and at 10:00, L2 at 10:40", () => {
    expect(sheetLevelText("10:00", null, [], nov20(22, 0), { structure: "wpl1" })).toBe("11월 21일 (토) 시작 · 12시간 뒤");
    const id = startTourney(day1, nov20(22, 0))!;
    const t = tOf(id);
    expect(t).toMatchObject({ start: at(10, 0), startSet: true, preset: "wpl1" });
    expect(tourneyWhenAt(t, [], nov20(22, 0))).toBe("11월 21일 (토) 10:00 시작");
    expect(tourneyWhenAt(t, [], at(10, 40))).toBe("10:00 시작");
    expect(startNote(t, [], true, nov20(22, 0))).toBe("시작 시간을 바꾸면 앞으로 적는 핸드의 레벨 추정이 바뀌어요 (저장된 핸드는 그대로).");
    // the edit sheet reads it the same (near its own start)
    expect(sheetLevelText("10:00", t, [], nov20(22, 0), { structure: "wpl1" })).toBe("11월 21일 (토) 시작 · 12시간 뒤");
    for (const when of [nov20(23, 0), at(7, 30), at(9, 59), at(10, 5), at(16, 0)]) expect(currentTourney(ts(), [], when)?.id).toBe(id);
    expect(tourneyForNew(at(10, 40)).id).toBe(id);
    expect(levelFor(t, {}, [], at(10, 40), tourneyEstimate(t, at(10, 40), null))).toEqual({ level: L(2), guessed: true, picked: false });
    // the picker's start time typed that night stays the next day's
    expect(setFastStartClock("10:15", nov20(22, 30))).toBeNull();
    expect(tOf(id).start).toBe(at(10, 15));
  });

  it("made after midnight or at the table it is that day's; after late registration (16:50) the next day's flight", () => {
    const p = PRESETS.wpl1;
    expect(presetStartMs(p, "10:00", at(0, 30))).toBe(at(10, 0));
    expect(presetStartMs(p, "10:00", at(9, 55))).toBe(at(10, 0));
    expect(presetStartMs(p, "10:00", at(16, 49))).toBe(at(10, 0));
    expect(presetStartMs(p, "10:00", at(16, 50))).toBe(new Date(2026, 10, 22, 10, 0).getTime());
    expect(presetStartMs(p, "10:00", nov20(16, 0))).toBe(nov20(10, 0));
    expect(presetStartMs(p, "저녁", at(9, 0))).toBeNull();
    // DAY2 / DAY3: the evening before is the next day's, the day itself (late) its own
    expect(presetStartMs(PRESETS.wpl2, "13:00", dec(11, 22, 0))).toBe(dec(12, 13, 0));
    expect(presetStartMs(PRESETS.wpl2, "13:00", dec(12, 18, 30))).toBe(dec(12, 13, 0));
    expect(presetStartMs(PRESETS.wpl3, "13:00", dec(12, 23, 0))).toBe(dec(13, 13, 0));
    // 야자수 새틀 keeps its own rule (the clock read near now)
    const pub = startTourney({ ...day1, structure: "pub", clock: "10:00", name: "", stack: "50000" }, nov20(22, 0))!;
    expect(tOf(pub).start).toBe(nov20(10, 0));
  });

  it("a pub tournament logged that night is current till DAY1's start; from 10:00 DAY1 is", () => {
    const wpl = startTourney(day1, nov20(19, 0))!;
    const pub = startTourney({ ...day1, structure: "pub", clock: "19:30", name: "", stack: "50000" }, nov20(19, 20))!;
    const hs = [hand("p1", nov20(23, 50), { tourney: pub })];
    expect(currentTourney(ts(), hs, nov20(23, 55))?.id).toBe(pub);
    expect(currentTourney(ts(), hs, at(9, 59))?.id).toBe(pub);
    expect(currentTourney(ts(), hs, at(10, 0))?.id).toBe(wpl);
    expect(currentTourney(ts(), hs, at(12, 0))?.id).toBe(wpl);
  });

  it("DAY3's clock runs its whole table (16 h 45 min from L31 at 13:00), past 03:00", () => {
    const id = startTourney({ name: "", clock: "13:00", stack: "", memo: "", structure: "wpl3", blinds: null, startLevel: 31 }, dec(13, 12, 50))!;
    const t = tOf(id);
    const lvAt = (when: number) => tourneyEstimate(t, when, null)?.level ?? null;
    expect(lvAt(dec(14, 1, 0))).toBe(42);
    expect(lvAt(dec(14, 3, 30))).toBe(44);
    expect(lvAt(dec(14, 5, 44))).toBe(46);
    expect(tourneyEstimate(t, dec(14, 5, 45), null)).toBeNull();
    // a hand of 04:00 corrected: its start is the day before's 13:00
    expect(presetEstimate(t, "13:00", dec(14, 4, 0))).toMatchObject({ level: 45, startClock: "13:00" });
    expect(startNote(t, [], true, dec(14, 4, 0))).toContain("시작 시간을 바꾸면");
  });
});

describe("WPL 메인: a level picked lines up with the WPL clock", () => {
  const pickAt = (t: Tourney, level: number | null, when: number) => (h: number, m: number) =>
    levelFor(t, { levelPick: { level, at: when, t: t.id } }, [], at(h, m), tourneyEstimate(t, at(h, m), null));

  it("a tap on the level the clock is at confirms it: L3 at 11:00 and L13 at 16:50 as before, a BB fold at 11:10 costs L3's 600", () => {
    const t = tOf(startTourney(day1, at(9, 55))!);
    const lv = pickAt(t, 2, at(10, 50));
    expect(lv(10, 50)).toEqual({ level: L(2), guessed: false, picked: true });
    expect(lv(10, 59).level).toEqual(L(2));
    expect(lv(11, 0)).toEqual({ level: L(3), guessed: true, picked: true });
    expect(lv(11, 5).level).toEqual(L(3));
    expect(postedBy("BB", lv(11, 10).level, true)).toBe(600);
    expect(lv(16, 49).level).toEqual(L(12));
    expect(lv(16, 50).level).toEqual(L(13));
  });

  it("another level moves the day by whole levels: L3 tapped at 10:50 (the clock: L2) runs from 10:30; L2 tapped at 11:05 (the clock: L3) from 11:00", () => {
    const t = tOf(startTourney(day1, at(9, 55))!);
    const ahead = pickAt(t, 3, at(10, 50));
    expect(ahead(10, 50).level).toEqual(L(3));
    expect(ahead(10, 59).level).toEqual(L(3));
    expect(ahead(11, 0).level).toEqual(L(4));
    expect(ahead(11, 30).level).toEqual(L(4)); // its break
    expect(ahead(11, 45).level).toEqual(L(5));
    const behind = pickAt(t, 2, at(11, 5));
    expect(behind(11, 29).level).toEqual(L(2));
    expect(behind(11, 30).level).toEqual(L(3));
  });

  it("L1 picked before 10:00 (a blind's fold waiting for its level) starts at 10:00; L5 picked in the break before it runs from 12:15", () => {
    const t = tOf(startTourney(day1, at(9, 50))!);
    const early = pickAt(t, 1, at(9, 58));
    expect(early(9, 58)).toEqual({ level: L(1), guessed: false, picked: true });
    expect(early(10, 29).level).toEqual(L(1));
    expect(early(10, 30).level).toEqual(L(2));
    const brk = pickAt(t, 5, at(12, 5));
    expect(brk(12, 5)).toEqual({ level: L(5), guessed: false, picked: true });
    expect(brk(12, 44).level).toEqual(L(5));
    expect(brk(12, 45).level).toEqual(L(6));
  });

  it("DAY2: L21 picked 10 minutes in runs as a day from L21 (L22 at 13:40, its break, L23 at 14:35)", () => {
    const p = PRESETS.wpl2;
    const t = tOf(startTourney({ name: "", clock: "13:00", stack: "120000", memo: "", structure: "wpl2", blinds: null, startLevel: 19 }, new Date(2026, 11, 12, 12, 50).getTime())!);
    const d = (h: number, m: number) => new Date(2026, 11, 12, h, m).getTime();
    const lv = (h: number, m: number) => levelFor(t, { levelPick: { level: 21, at: d(13, 10), t: t.id } }, [], d(h, m), tourneyEstimate(t, d(h, m), null)).level;
    expect(lv(13, 39)).toEqual(L(21, p));
    expect(lv(13, 40)).toEqual(L(22, p));
    expect(lv(14, 20)).toEqual(L(22, p));
    expect(lv(14, 35)).toEqual(L(23, p));
  });

  it("야자수 새틀's picks still run from the tap", () => {
    const id = startTourney({ ...day1, structure: "pub", clock: "19:00", name: "", stack: "50000" }, at(18, 55))!;
    const t = tOf(id);
    // Lv2 (20-minute levels) tapped at 19:30, 10 minutes into the clock's Lv2: Lv3 at 19:50
    const lv = (h: number, m: number) => levelFor(t, { levelPick: { level: 2, at: at(19, 30), t: id } }, [], at(h, m), tourneyEstimate(t, at(h, m), null)).level;
    expect(lv(19, 49)).toBe(2);
    expect(lv(19, 50)).toBe(3);
  });
});

describe("WPL 메인: the rest of the review", () => {
  it("the copied summary names the levels played (none yet: the start level), DAY2's from the hands", () => {
    const id = startTourney(day1, at(9, 55))!;
    expect(infoOf(tOf(id), [])).toMatchObject({ event: "WPL 메인 이벤트", structure: "DAY1 · 30분 레벨 · L1부터" });
    const p = PRESETS.wpl2;
    const d2 = startTourney({ name: "", clock: "13:00", stack: "120000", memo: "", structure: "wpl2", blinds: null, startLevel: 19 }, at(12, 50))!;
    const hs = [21, 23, 22].map((n, i) => hand(`h${i}`, at(13, 10 + i * 40), { level: null, blinds: L(n, p), bbAnte: true, tourney: d2 }));
    expect(infoOf(tOf(d2), hs).structure).toBe("DAY2 · 40분 레벨 · L21–L23");
  });

  it("an edit that keeps the table and start level keeps the blinds of now (for an older app)", () => {
    const id = startTourney(day1, at(9, 55))!;
    saveNewFast(hand("n1", at(12, 20), { level: null, blinds: L(5), bbAnte: true, result: "fold", net: 0 }), at(12, 20));
    expect(tOf(id).blinds).toEqual({ sb: 300, bb: 500, ante: 500 });
    expect(editTourney(id, { ...fieldsOf(tOf(id)), name: "B3" }, at(12, 25))).toBe(true);
    expect(tOf(id)).toMatchObject({ name: "B3", blinds: { sb: 300, bb: 500, ante: 500 } });
    // another table: its start level's
    expect(editTourney(id, { ...fieldsOf(tOf(id)), structure: "wpl2", startLevel: 19, clock: "13:00" }, at(12, 30))).toBe(true);
    expect(tOf(id).blinds).toEqual({ sb: 4000, bb: 8000, ante: 8000 });
  });

  it("the level picker says what the break on now is for (추가등록 마감 · 100칩 레이스)", () => {
    const p = PRESETS.wpl1;
    const out = renderToStaticMarkup(
      createElement(LevelRow, {
        h: { id: "x", level: 12, levelGuess: true, bbAnte: true, createdAt: at(16, 35) },
        onLevel: () => {},
        onAnte: () => {},
        open: true,
        onToggle: () => {},
        estimate: { level: 12, phase: "break", minutesIn: 5, minutesLeft: 15, elapsedMinutes: 395, startClock: "10:00", nextLevel: 13 },
        ladder: { rows: p.schedule, breaks: p.breaks },
      }),
    );
    expect(out).toContain("⏱ 휴식 중 (다음 L13) · 추가등록 마감 · 100칩 레이스 · 10:00 시작 6시간 35분째");
  });
});
