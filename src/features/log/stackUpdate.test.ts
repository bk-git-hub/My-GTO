import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RANKS } from "../../poker/cards";
import { checkSteps, chipSeries, draftResult, missedOf, missedPart, sessionMoney, stackAt } from "./fastChips";
import { MoneyHead } from "./FastResult";
import {
  backKey,
  blockOf,
  cleanFastState,
  draftOf,
  fastHand,
  newDraft,
  pickRes,
  pickSuited,
  sessionText,
  setFocus,
  tapRank,
  typeDigit,
  withFastResult,
  type FastDraft,
  type FastLevel,
} from "./fastLog";
import {
  checkStack,
  countFor,
  editTourney,
  fastResultNow,
  fieldsOf,
  groupChips,
  infoOf,
  openCheck,
  removeCheck,
  restack,
  saveNewFast,
  stackBefore,
  tourneyHands,
  type TourneyGroup,
} from "./fastTourney";
import { backupText, emptyHand, handLogStore, migrateStore, sanitize, saveHand, tidyHand, withBackup, type HandLogState, type LoggedHand } from "./handLog";
import { cleanChecks, cleanTourney, cleanTourneys, mergeTourneys, type StackCheck, type Tourney } from "./tourney";
import { GroupRes } from "./TourneyScreens";
import { chipUpdateNote } from "./TourneySheet";
import { deleteWithUndo, undoLast } from "./undoDelete";

/**
 * 스택 and 칩 업데이트: a hand's chips worked out from my stack counted after it (지금 스택 less my stack
 * before it), and my stack typed between hands. Synthetic data only.
 */

const MIN = 60_000;
const T0 = new Date(2026, 10, 17, 19, 0).getTime();
const at = (m: number) => T0 + m * MIN;
const LV5: FastLevel = { level: 5, guessed: false };
const R = (k: string) => RANKS.indexOf(k);

let n = 0;
/** A 빠른 기록 hand of mine at minute `m` (Lv5 300/600, BB ante). */
const hand = (m: number, net: number | null, extra: Partial<LoggedHand> = {}): LoggedHand => {
  n++;
  return {
    ...emptyHand(5),
    id: `x${n}`,
    createdAt: at(m),
    updatedAt: at(m),
    seat: "CO",
    fast: true,
    net,
    result: net === null ? null : net > 0 ? "win" : net < 0 ? "lose" : "fold",
    ...extra,
  };
};
const check = (m: number, stack: number): StackCheck => ({ at: at(m), stack });
function typed(seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft {
  let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
  if (cls[2]) d = pickSuited(d, cls[2] === "s");
  return { ...d, ...extra };
}
/** The draft as the default screen saves it, with my stack before the hand. */
const saved = (d: FastDraft, before: number | null, b: LoggedHand = { ...emptyHand(null), id: "new", createdAt: at(100), updatedAt: at(100) }) => {
  const h = fastHand(d, null, b, "mid", 9);
  return h && withFastResult(h, d, LV5, true, before);
};
/** 스택 typed on the keypad: "61800" → the draft with 지금 스택 61,800. */
const byStack = (d: FastDraft, keys: string) => [...keys].reduce((x, k) => typeDigit(x, k), pickRes(d, "stack"));

describe("스택: my stack before a hand (stackAt)", () => {
  it("is the start stack plus every result since, the blinds of a fold included", () => {
    // 50,000; a BB fold (−1,200: blind and ante at Lv5), an SB fold (−300), a win of 3,600
    const hs = [hand(1, -1200, { seat: "BB", result: "fold" }), hand(2, -300, { seat: "SB", result: "fold" }), hand(3, 3600)];
    expect(stackAt(hs, 50000, [])).toEqual({ chips: 52100 });
    // before the third hand (a correction of it: its own time, itself left out)
    expect(stackAt(hs, 50000, [], hs[2].createdAt, hs[2].id)).toEqual({ chips: 48500 });
    expect(stackAt([], 50000, [])).toEqual({ chips: 50000 });
  });

  it("starts again from a 칩 업데이트, or from a hand's 지금 스택 (its chips after it)", () => {
    const hs = [hand(1, -1200, { seat: "BB", result: "fold" }), hand(10, 2000), hand(20, -500)];
    // after a break: 60,000 counted at minute 5; then +2,000 and −500
    expect(stackAt(hs, 50000, [check(5, 60000)])).toEqual({ chips: 61500 });
    // a hand with 지금 스택: its stack on file is its start (now − net), its chips after it are stack + net
    const anchored = [hand(1, 1000), hand(2, -2000, { stack: 40000 }), hand(3, 500)];
    expect(stackAt(anchored, 50000, [])).toEqual({ chips: 38500 });
    // a hand worked out from 스택 with the stack before it unknown: no result, its stack is 지금 스택
    expect(stackAt([hand(1, null, { stack: 45000, fastStack: true }), hand(2, 1000)], null, [])).toEqual({ chips: 46000 });
    // a hand and a 칩 업데이트 at the same moment: the hand first
    expect(stackAt([hand(5, 1000)], 50000, [check(5, 70000)])).toEqual({ chips: 70000 });
  });

  it("is unknown with nothing on file, or with a hand since that has no chips: never guessed", () => {
    expect(stackAt([hand(1, 1000)], null, [])).toEqual({ chips: null, why: "none" });
    expect(stackAt([], null, [])).toEqual({ chips: null, why: "none" });
    // a win without an amount, a blind's fold without a level
    expect(stackAt([hand(1, 1000), hand(2, null, { result: "win" })], 50000, [])).toEqual({ chips: null, why: "gap" });
    expect(stackAt([hand(1, null, { result: "fold", seat: "BB", level: null })], 50000, [])).toEqual({ chips: null, why: "gap" });
    // a stack on file after the gap makes it known again
    expect(stackAt([hand(1, null, { result: "win" }), hand(2, 0, { result: "fold", stack: 64000 })], 50000, [])).toEqual({ chips: 64000 });
    expect(stackAt([hand(1, null, { result: "win" })], 50000, [check(2, 61000)])).toEqual({ chips: 61000 });
    // a count below zero is no stack
    expect(stackAt([hand(1, -60000)], 50000, [])).toEqual({ chips: null, why: "gap" });
  });
});

describe("스택: the draft's result worked out from 지금 스택", () => {
  const base = { unit: "chips" as const, seat: "CO", level: 5, bbAnte: true };
  it("is 지금 스택 less the stack before: up, down or 본전", () => {
    expect(draftResult({ ...base, res: "stack", stackNow: "61800", before: 58200 })).toEqual({ result: "win", net: 3600 });
    expect(draftResult({ ...base, res: "stack", stackNow: "52000", before: 58200 })).toEqual({ result: "lose", net: -6200 });
    expect(draftResult({ ...base, res: "stack", stackNow: "58200", before: 58200 })).toEqual({ result: "chop", net: 0 });
    // busted: 0
    expect(draftResult({ ...base, res: "stack", stackNow: "0", before: 58200 })).toEqual({ result: "lose", net: -58200 });
    // typed in bb at Lv5 (600)
    expect(draftResult({ ...base, res: "stack", stackNow: "103", stackUnit: "bb", before: 58200 })).toEqual({ result: "win", net: 3600 });
  });
  it("leaves the result unknown without the stack before; waits for 지금 스택 and for a level to read bb", () => {
    expect(draftResult({ ...base, res: "stack", stackNow: "61800", before: null })).toEqual({ result: null, net: null });
    expect(draftResult({ ...base, res: "stack", stackNow: "61800" })).toEqual({ result: null, net: null });
    expect(draftResult({ ...base, res: "stack", before: 58200 })).toEqual({ block: "stackNow" });
    expect(draftResult({ ...base, res: "stack", stackNow: "0.", stackUnit: "bb", before: 58200 })).toEqual({ block: "stackNow" });
    expect(draftResult({ ...base, level: null, res: "stack", stackNow: "103", stackUnit: "bb", before: 58200 })).toEqual({ block: "level" });
  });
});

describe("스택 on the keypad", () => {
  it("takes the keypad to 지금 스택 and drops an amount; ⌫ empties it, then lets 스택 go back to the result", () => {
    const d = pickRes({ ...pickRes(typed("CO", "AKs"), "+"), amount: "3600" }, "stack");
    expect(d).toMatchObject({ res: "stack", focus: "stack" });
    expect(d).not.toHaveProperty("amount");
    const typedIn = byStack(typed("CO", "AKs"), "618" + "00".slice(0, 1) + "0");
    expect(typedIn).toMatchObject({ res: "stack", stackNow: "61800" });
    let b = typedIn;
    for (let i = 0; i < 5; i++) b = backKey(b);
    expect(b).toMatchObject({ res: "stack", focus: "stack" });
    expect(b).not.toHaveProperty("stackNow");
    b = backKey(b);
    expect(b).not.toHaveProperty("res");
    expect(b.focus).toBe("result");
    // 지금 스택 typed first (보드 row) stays when 스택 is tapped
    const first = [..."61800"].reduce((x, k) => typeDigit(x, k), setFocus(typed("CO", "AKs"), "stack"));
    expect(pickRes(first, "stack")).toMatchObject({ res: "stack", stackNow: "61800" });
    // an amount typed on the 결과 line lets 스택 go and asks for the sign
    expect(typeDigit(setFocus(d, "result"), "5")).toMatchObject({ amount: "5" });
    expect(typeDigit(setFocus(d, "result"), "5")).not.toHaveProperty("res");
    // kept on file as the editor's state
    expect(cleanFastState({ draft: typedIn }).draft).toMatchObject({ res: "stack", stackNow: "61800", focus: "stack" });
  });

  it("saves the worked-out result, 지금 스택 as the hand's stack, and says it came from 스택", () => {
    const h = saved(byStack(typed("CO", "AKs"), "61800"), 58200)!;
    expect(h).toMatchObject({ result: "win", net: 3600, stack: 58200, fastStack: true, level: 5 });
    // its chips after it are 지금 스택
    expect((h.stack as number) + (h.net as number)).toBe(61800);
    // the stack before unknown: the stack goes on file, the result stays unknown
    const unknown = saved(byStack(typed("CO", "AKs"), "61800"), null)!;
    expect(unknown).toMatchObject({ result: null, net: null, stack: 61800, fastStack: true });
    // nothing typed: not saved, and the save says why
    expect(saved(pickRes(typed("CO", "AKs"), "stack"), 58200)).toBeNull();
    expect(blockOf(pickRes(typed("CO", "AKs"), "stack"), 9, 5, true, 58200)).toBe("stackNow");
    expect(blockOf(byStack(typed("CO", "AKs"), "61800"), 9, 5, true, 58200)).toBeNull();
    expect(blockOf(byStack(typed("CO", "AKs"), "61800"), 9, 5, true, null)).toBeNull();
    // 폴드 stays one tap, and an amount typed as before keeps its own result (no 스택 mark)
    expect(saved(pickRes(typed("BB", "94o"), "fold"), 58200)).toMatchObject({ result: "fold", net: -1200 });
    expect(saved({ ...pickRes(typed("CO", "AKs"), "+"), amount: "3600" }, 58200)).not.toHaveProperty("fastStack");
  });

  it("opens a hand saved by 스택 the same way, and works it out again from what is on file then", () => {
    const h = saved(byStack(typed("CO", "AKs"), "61800"), 58200)!;
    const d = draftOf(h);
    expect(d).toMatchObject({ res: "stack", stackNow: "61800" });
    expect(d).not.toHaveProperty("amount");
    // the stack before it was put right meanwhile (a start stack typed): the result follows
    expect(withFastResult(h, d, LV5, true, 60000)).toMatchObject({ result: "win", net: 1800, stack: 60000, fastStack: true });
    // corrected to 수익 with an amount: the 스택 mark goes
    const signed = withFastResult(h, { ...d, res: "+", amount: "3600" }, LV5, true, 58200)!;
    expect(signed).toMatchObject({ result: "win", net: 3600, stack: 58200 });
    expect(signed).not.toHaveProperty("fastStack");
    // one saved with the stack before unknown opens as 스택 with its 지금 스택
    expect(draftOf(saved(byStack(typed("CO", "AKs"), "61800"), null)!)).toMatchObject({ res: "stack", stackNow: "61800" });
  });

  it("keeps the 스택 mark on file and in the backup, only on a 빠른 기록 hand", () => {
    const h = saved(byStack(typed("CO", "AKs"), "61800"), 58200)!;
    expect(sanitize(JSON.parse(JSON.stringify(h)))).toMatchObject({ fastStack: true, net: 3600, stack: 58200 });
    expect(sanitize({ ...h, fastStack: "yes" })).not.toHaveProperty("fastStack");
    const { fast: _f, ...notFast } = h;
    void _f;
    expect(tidyHand(notFast as LoggedHand)).not.toHaveProperty("fastStack");
    expect(tidyHand(h)).toBe(h);
    // an older hand without it is as it was
    expect(migrateStore({ hands: [hand(1, 1000)], lastLevel: null }, null)).toBeNull();
  });
});

describe("칩 업데이트 on the chip graph and the total", () => {
  it("is an adjustment at its place between hands: a jump marked as a 칩 업데이트, the run going on from it", () => {
    // 50,000; −1,200 (BB fold); +3,000; a break: 60,000 counted; −600
    const hs = [hand(1, -1200, { seat: "BB", result: "fold" }), hand(2, 3000), hand(30, -600)];
    const s = chipSeries(hs, "chips", 50000, [check(20, 60000)])!;
    expect(s.segments).toEqual([
      [
        { x: 0, y: 50000 },
        { x: 1, y: 48800 },
        { x: 2, y: 51800 },
      ],
      [
        { x: 2, y: 60000 },
        { x: 3, y: 59400 },
      ],
    ]);
    expect(s.jumps).toEqual([{ x: 2, from: 51800, to: 60000, check: true }]);
    expect(s.anchors).toEqual([{ x: 2, y: 60000 }]);
    expect([s.start, s.end]).toEqual([50000, 59400]);
    // the total: the hands logged plus the 칩 업데이트 part
    const m = missedOf(hs, 50000, [check(20, 60000)])!;
    expect(m).toEqual({ chips: 8200, bb: 13.7, upd: { chips: 8200, bb: 13.7 } });
    expect(sessionMoney(hs).chips + m.chips).toBe(s.end - s.start);
    expect(groupChips(hs, 50000, [check(20, 60000)])).toBe(9400);
    // the same count typed again changes nothing on the line (a ring where it was counted)
    const same = chipSeries(hs, "chips", 50000, [check(20, 51800)])!;
    expect(same.jumps).toEqual([]);
    expect(same.anchors).toEqual([{ x: 2, y: 51800 }]);
    expect(missedOf(hs, 50000, [check(20, 51800)])).toBeNull();
  });

  it("starts the run when nothing before it does, ends it after the last hand, and sits apart from hands missed", () => {
    // no start stack: the run is real stacks back from the first 칩 업데이트
    const hs = [hand(1, 1000), hand(10, -500)];
    const s = chipSeries(hs, "chips", null, [check(5, 40000)])!;
    expect(s.absolute).toBe(true);
    expect(s.segments).toEqual([
      [
        { x: 0, y: 39000 },
        { x: 1, y: 40000 },
        { x: 2, y: 39500 },
      ],
    ]);
    expect(missedOf(hs, null, [check(5, 40000)])).toBeNull();
    // after the last hand: the run ends at it
    const end = chipSeries(hs, "chips", 50000, [check(20, 45000)])!;
    expect(end.end).toBe(45000);
    expect(end.jumps).toEqual([{ x: 2, from: 50500, to: 45000, check: true }]);
    // a hand's own 지금 스택 that disagrees too: 빠진 핸드 and 칩 업데이트 apart
    const both = [hand(1, 1000), hand(10, -500, { stack: 48000 })];
    // 51,000 counted, 48,000 on file at the second hand (−3,000 missed), 47,500 after it, 60,000 counted (+12,500)
    expect(missedOf(both, 50000, [check(20, 60000)])).toEqual({ chips: 9500, bb: 15.8, upd: { chips: 12500, bb: 20.8 } });
    // with no hand, no graph (the meta line shows the stack instead)
    expect(chipSeries([], "chips", 50000, [check(5, 60000)])).toBeNull();
    // hands with no chips at all and a 칩 업데이트: a run all the same
    expect(chipSeries([hand(1, null)], "chips", null, [check(5, 60000)])?.end).toBe(60000);
    // a 칩 업데이트 and the next hand's 지금 스택 at the same place: the 칩 업데이트 first
    const two = chipSeries([hand(1, 1000), hand(10, 0, { stack: 62000 })], "chips", 50000, [check(5, 60000)])!;
    expect(two.jumps).toEqual([
      { x: 1, from: 51000, to: 60000, check: true },
      { x: 1, from: 60000, to: 62000 },
    ]);
  });

  it("in bb, at the big blind of the hand before it", () => {
    const hs = [hand(1, -1200, { seat: "BB", result: "fold" }), hand(30, 600, { level: 6 })];
    const s = chipSeries(hs, "bb", 50000, [check(20, 60000)])!;
    expect(s.unit).toBe("bb");
    expect(s.jumps.map((j) => [j.x, Math.round(j.from * 10) / 10, Math.round(j.to * 10) / 10, j.check])).toEqual([[1, 81.3, 100, true]]);
  });

  it("says what each 칩 업데이트 changed from the count then", () => {
    const hs = [hand(1, 1000), hand(10, null, { result: "win" }), hand(30, -500)];
    expect(checkSteps(hs, 50000, [check(40, 52000), check(5, 55000)])).toEqual([
      { at: at(5), stack: 55000, diff: 4000 },
      // a hand without chips since: not known
      { at: at(40), stack: 52000, diff: null },
    ]);
  });
});

describe("칩 업데이트 on file", () => {
  const initial = handLogStore.get();
  let mem: Map<string, string>;
  beforeEach(() => {
    mem = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    handLogStore.set({ hands: [], lastLevel: null });
  });
  afterEach(() => {
    handLogStore.set(initial);
    vi.unstubAllGlobals();
  });
  const rec = (extra: Partial<Tourney> = {}): Tourney => ({ id: "t1", createdAt: T0, updatedAt: T0, activeAt: T0, name: "", memo: "", start: T0, startSet: true, startStack: 50000, ...extra });
  const tn = () => cleanTourneys(handLogStore.get().tourneys)[0];

  it("goes on the tournament; one with no hand since is put right in place; one can be taken off", () => {
    handLogStore.set({ hands: [hand(1, -1200, { seat: "BB", result: "fold", tourney: "t1" })], lastLevel: null, tourneys: [rec()] });
    expect(countFor(tn(), handLogStore.get().hands)).toEqual({ chips: 48800 });
    expect(checkStack("t1", 60000, at(20))).toBe(true);
    expect(tn().checks).toEqual([check(20, 60000)]);
    expect(tn().updatedAt).toBe(at(20));
    // typed again with no hand since (a typo, a rebuy just after): in place, measured against the count before it
    expect(openCheck(tn(), handLogStore.get().hands)).toEqual(check(20, 60000));
    expect(countFor(tn(), handLogStore.get().hands)).toEqual({ chips: 48800 });
    expect(checkStack("t1", 61000, at(22))).toBe(true);
    expect(tn().checks).toEqual([check(22, 61000)]);
    // a hand since: the next one is added
    handLogStore.set({ ...handLogStore.get(), hands: [hand(30, 500, { tourney: "t1" }), ...handLogStore.get().hands] });
    expect(openCheck(tn(), handLogStore.get().hands)).toBeNull();
    expect(countFor(tn(), handLogStore.get().hands)).toEqual({ chips: 61500 });
    expect(checkStack("t1", 0, at(40))).toBe(true);
    expect(tn().checks).toEqual([check(22, 61000), check(40, 0)]);
    // not a stack: refused
    expect(checkStack("t1", -1, at(41))).toBe(false);
    expect(checkStack("t1", 12.5, at(41))).toBe(false);
    expect(checkStack("nope", 1000, at(41))).toBe(false);
    // taken off
    expect(removeCheck("t1", at(40), at(50))).toBe(true);
    expect(tn().checks).toEqual([check(22, 61000)]);
    expect(removeCheck("t1", at(40), at(50))).toBe(false);
    expect(removeCheck("t1", at(22), at(51))).toBe(true);
    expect(tn()).not.toHaveProperty("checks");
  });

  it("is where the next hand's stack before starts, and the hand by 스택 works from it", () => {
    // 50,000; a BB fold at Lv5; a hand by 스택 (61,800 after it); a 칩 업데이트 after a break; a hand with no result; a hand by 스택
    handLogStore.set({ hands: [], lastLevel: null, tourneys: [rec({ activeAt: at(0) })] });
    const fold = withFastResult(fastHand(pickRes(typed("BB", "94o"), "fold"), null, { ...emptyHand(5), id: "a", createdAt: at(1), updatedAt: at(1) }, "mid", 9)!, pickRes(typed("BB", "94o"), "fold"), LV5, true)!;
    expect(saveNewFast(fold, at(1)).ok).toBe(true);
    const b1 = stackBefore(handLogStore.get(), null, at(3));
    expect(b1).toEqual({ chips: 48800 });
    const d1 = byStack(typed("SB", "AKs"), "61800");
    const h1 = withFastResult(fastHand(d1, null, { ...emptyHand(5), id: "b", createdAt: at(3), updatedAt: at(3) }, "mid", 9)!, d1, LV5, true, b1.chips)!;
    expect(h1).toMatchObject({ result: "win", net: 13000, stack: 48800 });
    expect(saveNewFast(h1, at(3)).ok).toBe(true);
    expect(checkStack("t1", 70000, at(20))).toBe(true);
    expect(stackBefore(handLogStore.get(), null, at(25))).toEqual({ chips: 70000 });
    // a win with no amount: the next stack before isn't known
    const d2 = pickRes(typed("CO", "QQ"), "+");
    expect(saveNewFast(withFastResult(fastHand(d2, null, { ...emptyHand(5), id: "c", createdAt: at(30), updatedAt: at(30) }, "mid", 9)!, d2, LV5, true)!, at(30)).ok).toBe(true);
    const b3 = stackBefore(handLogStore.get(), null, at(32));
    expect(b3).toEqual({ chips: null, why: "gap" });
    const d3 = byStack(typed("BTN", "72o"), "90000");
    const h3 = withFastResult(fastHand(d3, null, { ...emptyHand(5), id: "d", createdAt: at(32), updatedAt: at(32) }, "mid", 9)!, d3, LV5, true, b3.chips)!;
    expect(h3).toMatchObject({ result: null, net: null, stack: 90000, fastStack: true });
    expect(saveNewFast(h3, at(32)).ok).toBe(true);
    // from it on, known again
    expect(stackBefore(handLogStore.get(), null, at(33))).toEqual({ chips: 90000 });
    // a correction of the hand by 스택: its own stack before
    const st = handLogStore.get();
    expect(stackBefore(st, st.hands.find((h) => h.id === "b")!, at(40))).toEqual({ chips: 48800 });
    expect(stackBefore(st, st.hands.find((h) => h.id === "d")!, at(40))).toEqual({ chips: null, why: "gap" });
    // the graph and the total: 50,000 → 48,800 → 61,800 | 70,000 → 70,000 (no result) | 90,000 → 90,000
    const t = tn();
    const hs = tourneyHands(st.hands, "t1");
    const s = chipSeries(hs, "chips", t.startStack, t.checks)!;
    expect(s.segments.flat().map((p) => p.y)).toEqual([50000, 48800, 61800, 70000, 70000, 90000, 90000]);
    // the jump after the win with no amount (and the hand by 스택 itself, its stack before unknown) is their result, not hands missed
    expect(s.jumps).toEqual([
      { x: 2, from: 61800, to: 70000, check: true },
      { x: 3, from: 70000, to: 90000, gap: true },
    ]);
    expect(groupChips(hs, t.startStack, t.checks)).toBe(40000);
    expect(missedOf(hs, t.startStack, t.checks)).toEqual({ chips: 28200, bb: 47, upd: { chips: 8200, bb: 13.7 }, gap: { chips: 20000, bb: 33.3 } });
    // the copy text says it
    const text = sessionText(hs, "mine", infoOf(t, st.hands));
    expect(text).toContain("결과 +40,000칩");
    expect(text).toContain("(기록한 핸드 +11,800칩 · 결과 모름 +20,000칩 · 칩 업데이트 +8,200칩)");
    expect(text).toContain("시작 스택 50,000 → 지금 90,000");
    expect(text).toMatch(/칩 업데이트 \d\d:\d\d 70,000 \(\+8,200\)/);
  });

  it("is cleaned on load, merged from a backup, and an older record without it is as it was", () => {
    expect(cleanChecks([{ at: 5, stack: 100 }, { at: 1, stack: 0 }, { at: 5, stack: 200 }, { at: "x", stack: 1 }, { at: 2, stack: -1 }, { at: 3, stack: 1.5 }, null])).toEqual([
      { at: 1, stack: 0 },
      { at: 5, stack: 200 },
    ]);
    expect(cleanTourney({ ...rec(), checks: "nope" })).toEqual(rec());
    expect(cleanTourney({ ...rec(), checks: [] })).toEqual(rec());
    expect(cleanTourney({ ...rec(), checks: [{ at: at(5), stack: 60000 }] })).toEqual(rec({ checks: [check(5, 60000)] }));
    // the later edited record wins, 칩 업데이트 with it
    const mine = rec({ updatedAt: at(10), checks: [check(5, 60000)] });
    expect(mergeTourneys([rec()], [mine])).toEqual([mine]);
    expect(mergeTourneys([mine], [rec()])).toEqual([mine]);
    // the backup round trip: the tournament's 칩 업데이트 and a hand's 스택 mark come back
    const h = { ...hand(8, 3600, { stack: 58200, fastStack: true as const, tourney: "t1" }) };
    const st: HandLogState = { hands: [h], lastLevel: null, tourneys: [mine] };
    const { next } = withBackup({ hands: [], lastLevel: null }, backupText(st));
    expect(cleanTourneys(next.tourneys)).toEqual([mine]);
    expect(next.hands[0]).toMatchObject({ fastStack: true, net: 3600, stack: 58200 });
    // a backup from before 칩 업데이트 keeps ours
    const old = JSON.stringify({ kind: "pubaj-hand-log", version: 2, hands: [], tourneys: [rec()] });
    expect(cleanTourneys(withBackup(st, old).next.tourneys)).toEqual([mine]);
    // the stored log with a record from before: nothing to migrate
    expect(migrateStore({ hands: [], lastLevel: null, tourneys: [rec()] }, null)).toBeNull();
    expect(migrateStore({ hands: [], lastLevel: null, tourneys: [mine] }, null)).toBeNull();
    // the copy info carries them only when there are some
    expect(infoOf(rec(), [])).not.toHaveProperty("checks");
    expect(infoOf(mine, []).checks).toEqual([check(5, 60000)]);
  });
});

describe("스택 the easy way: 지금 스택 alone, and a stack typed under 수익 / 손실", () => {
  it("is 스택 when 지금 스택 is typed with no result picked: the result is worked out", () => {
    const d = [..."61800"].reduce((x, k) => typeDigit(x, k), setFocus(typed("CO", "AKs"), "stack"));
    expect(d).toMatchObject({ res: "stack", stackNow: "61800", focus: "stack" });
    expect(saved(d, 58200)).toMatchObject({ result: "win", net: 3600, stack: 58200, fastStack: true });
    // a result picked first keeps it: 지금 스택 is then the stack on file
    const signed = [..."64200"].reduce((x, k) => typeDigit(x, k), setFocus({ ...pickRes(typed("CO", "AKs"), "+"), amount: "6000" }, "stack"));
    expect(signed).toMatchObject({ res: "+", amount: "6000", stackNow: "64200" });
    expect([..."64200"].reduce((x, k) => typeDigit(x, k), setFocus(pickRes(typed("CO", "AKs"), "-"), "stack")).res).toBe("-");
    // an amount typed with no sign yet: still asks for the sign
    expect([..."64200"].reduce((x, k) => typeDigit(x, k), setFocus({ ...typed("CO", "AKs"), amount: "6000" }, "stack"))).not.toHaveProperty("res");
  });

  it("moves an amount typed under 수익 / 손실 over to 지금 스택 when 스택 is tapped", () => {
    const d = pickRes({ ...pickRes(typed("CO", "AKs"), "+"), amount: "41200" }, "stack");
    expect(d).toMatchObject({ res: "stack", stackNow: "41200", focus: "stack" });
    expect(d).not.toHaveProperty("amount");
    expect(saved(d, 27500)).toMatchObject({ result: "win", net: 13700, stack: 27500 });
    // 지금 스택 already typed: it stays, the amount goes
    expect(pickRes({ ...pickRes(typed("CO", "AKs"), "+"), amount: "3600", stackNow: "61800" }, "stack")).toMatchObject({ stackNow: "61800" });
    // typed in another unit: not moved
    expect(pickRes({ ...pickRes(typed("CO", "AKs"), "+"), amount: "20", unit: "bb" }, "stack")).not.toHaveProperty("stackNow");
  });

  it("waits on a loss bigger than the stack before, unless 지금 스택 says the stack itself", () => {
    const base = { unit: "chips" as const, seat: "CO", level: 5, bbAnte: true };
    expect(draftResult({ ...base, res: "-", amount: "91000", before: 81000 })).toEqual({ block: "over" });
    // the whole stack: all in and lost
    expect(draftResult({ ...base, res: "-", amount: "81000", before: 81000 })).toEqual({ result: "lose", net: -81000 });
    expect(draftResult({ ...base, res: "-", amount: "91000", before: null })).toEqual({ result: "lose", net: -91000 });
    expect(draftResult({ ...base, res: "-", amount: "91000", before: 81000, stackNow: "5000" })).toEqual({ result: "lose", net: -91000 });
    // a win that big can be (a multiway pot): not blocked
    expect(draftResult({ ...base, res: "+", amount: "91000", before: 81000 })).toEqual({ result: "win", net: 91000 });
    const lost = { ...pickRes(typed("CO", "AKs"), "-"), amount: "91000" };
    expect(blockOf(lost, 9, 5, true, 81000)).toBe("over");
    expect(saved(lost, 81000)).toBeNull();
    // in bb: 152bb at Lv5 (600) is 91,200
    expect(blockOf({ ...lost, amount: "152", unit: "bb" }, 9, 5, true, 81000)).toBe("over");
  });
});

describe("결과 모름: a jump after hands with no chips", () => {
  it("is told apart from hands missed and from 칩 업데이트", () => {
    // 50,000; +12,000; a win with no amount; 90,000 on file at the next hand
    const hs = [hand(1, 12000), hand(2, null, { result: "win" }), hand(3, 0, { result: "chop", stack: 90000 })];
    const s = chipSeries(hs, "chips", 50000)!;
    expect(s.jumps).toEqual([{ x: 2, from: 62000, to: 90000, gap: true }]);
    const m = missedOf(hs, 50000)!;
    expect(m).toEqual({ chips: 28000, bb: 46.7, gap: { chips: 28000, bb: 46.7 } });
    expect(missedPart(m)).toEqual({ chips: 0, bb: 0 });
    // the hand's own result unknown (스택 with the stack before unknown): its jump too
    expect(chipSeries([hand(1, 12000), hand(2, null, { stack: 90000, fastStack: true })], "chips", 50000)!.jumps).toEqual([{ x: 1, from: 62000, to: 90000, gap: true }]);
    // all known: hands missed
    expect(chipSeries([hand(1, 12000), hand(2, 0, { result: "chop", stack: 90000 })], "chips", 50000)!.jumps).toEqual([{ x: 1, from: 62000, to: 90000 }]);
    // a stack on file after the unknown hand puts it behind: a later jump is hands missed again
    const later = [hand(1, null, { result: "win" }), hand(2, 1000, { stack: 60000 }), hand(3, 0, { result: "chop", stack: 65000 })];
    expect(chipSeries(later, "chips", 50000)!.jumps).toEqual([
      { x: 1, from: 50000, to: 60000, gap: true },
      { x: 2, from: 61000, to: 65000 },
    ]);
    // on the total's line
    const html = renderToStaticMarkup(createElement(MoneyHead, { money: sessionMoney(later), missed: missedOf(later, 50000), view: "chips", onView: () => {} }));
    expect(html.replace(/<[^>]+>/g, "")).toContain("기록한 핸드 +1,000 · 빠진 핸드 +4,000 · 결과 모름 +10,000");
    const gapOnly = renderToStaticMarkup(createElement(MoneyHead, { money: sessionMoney(hs), missed: m, view: "chips", onView: () => {} }));
    expect(gapOnly.replace(/<[^>]+>/g, "")).toContain("기록한 핸드 +12,000 · 결과 모름 +28,000");
    expect(gapOnly).not.toContain("빠진 핸드");
  });
});

describe("hands by 스택 follow what is on file before them", () => {
  const initial = handLogStore.get();
  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    handLogStore.set({ hands: [], lastLevel: null, tourneys: [rec()] });
  });
  afterEach(() => {
    handLogStore.set(initial);
    vi.unstubAllGlobals();
  });
  const rec = (extra: Partial<Tourney> = {}): Tourney => ({ id: "t1", createdAt: T0, updatedAt: T0, activeAt: T0, name: "", memo: "", start: T0, startSet: true, startStack: 50000, ...extra });
  /** A new hand saved as 빠른 기록's 저장 saves it (fastResultNow: the stack before read from the store). */
  const put = (id: string, m: number, d: FastDraft) => {
    const made = fastHand(d, null, { ...emptyHand(5), id, createdAt: at(m), updatedAt: at(m) }, "mid", 9)!;
    const { hand: h } = fastResultNow(made, d, LV5, true, null, at(m));
    expect(h).not.toBeNull();
    expect(saveNewFast(h!, at(m)).ok).toBe(true);
  };
  /** A hand corrected as 빠른 기록's 고쳐서 저장 saves it (fastResultNow with the hand, then restack in the same write). */
  const fix = (id: string, change: Partial<FastDraft>) => {
    const was = get(id);
    const d = { ...draftOf(was), ...change };
    const { hand: h } = fastResultNow(was, d, LV5, true, was, at(200));
    expect(saveHand(h!, (s) => restack(s, h!.tourney, at(200)))).toBe(true);
  };
  const get = (id: string) => handLogStore.get().hands.find((h) => h.id === id)!;
  const tn = () => cleanTourneys(handLogStore.get().tourneys)[0];
  const jumps = () => chipSeries(tourneyHands(handLogStore.get().hands, "t1"), "chips", tn().startStack, tn().checks ?? [])!.jumps;
  const won = (amount: string) => ({ ...pickRes(typed("CO", "AKs"), "+"), amount });

  it("saves through the store's stack before (fastResultNow)", () => {
    put("A", 1, won("5000"));
    expect(fastResultNow(fastHand(byStack(typed("BTN", "QQ"), "57000"), null, { ...emptyHand(5), id: "B", createdAt: at(2), updatedAt: at(2) }, "mid", 9)!, byStack(typed("BTN", "QQ"), "57000"), LV5, true, null, at(2))).toMatchObject({
      before: 55000,
      hand: { net: 2000, result: "win", stack: 55000, fastStack: true },
    });
    // a loss bigger than the stack before waits, and says the stack before
    const lost = { ...pickRes(typed("BTN", "QQ"), "-"), amount: "60000" };
    expect(fastResultNow(fastHand(lost, null, { ...emptyHand(5), id: "B", createdAt: at(2), updatedAt: at(2) }, "mid", 9)!, lost, LV5, true, null, at(2))).toEqual({ hand: null, before: 55000 });
  });

  it("an earlier hand's amount corrected: the hand by 스택 after it keeps its 지금 스택, its result follows", () => {
    put("A", 1, won("5000")); // typed +5,000; it was +3,000
    put("B", 2, byStack(typed("BTN", "QQ"), "60000"));
    expect(get("B")).toMatchObject({ net: 5000, stack: 55000 });
    put("C", 3, won("1000"));
    fix("A", { amount: "3000" });
    expect(get("B")).toMatchObject({ net: 7000, stack: 53000, result: "win", fastStack: true });
    expect(get("B").updatedAt).toBe(at(200));
    // the hand after it is as it was
    expect(get("C")).toMatchObject({ net: 1000 });
    expect(jumps()).toEqual([]);
    // run again: nothing more changes
    const st = handLogStore.get();
    expect(restack(st, "t1", at(300))).toBe(st);
  });

  it("an earlier hand deleted, then put back: the hand by 스택 after it follows both ways", () => {
    put("A", 1, won("5000"));
    put("B", 2, byStack(typed("BTN", "QQ"), "60000"));
    expect(deleteWithUndo(["A"], at(100))).toBe(1);
    expect(get("B")).toMatchObject({ net: 10000, stack: 50000 });
    expect(jumps()).toEqual([]);
    expect(undoLast(at(101))).toBe(true);
    expect(get("B")).toMatchObject({ net: 5000, stack: 55000 });
    expect(jumps()).toEqual([]);
  });

  it("a mistyped 칩 업데이트 taken off, a start stack set later", () => {
    put("A", 1, won("5000"));
    expect(checkStack("t1", 5500, at(10))).toBe(true); // meant 55,000
    put("B", 20, byStack(typed("BTN", "QQ"), "57000"));
    expect(get("B").net).toBe(51500);
    expect(removeCheck("t1", at(10), at(30))).toBe(true);
    expect(get("B")).toMatchObject({ net: 2000, stack: 55000 });
    expect(jumps()).toEqual([]);
    // no start stack: the hand by 스택 has no result; the start stack typed later works it out
    handLogStore.set({ hands: [], lastLevel: null, tourneys: [rec({ startStack: null })] });
    put("A", 1, won("5000"));
    put("B", 2, byStack(typed("BTN", "QQ"), "60000"));
    expect(get("B")).toMatchObject({ net: null, result: null, stack: 60000 });
    expect(editTourney("t1", { ...fieldsOf(tn()), stack: "50000" }, at(40))).toBe(true);
    expect(get("B")).toMatchObject({ net: 5000, result: "win", stack: 55000 });
  });
});

describe("a tournament's result chip in 토너먼트 기록 with a 칩 업데이트", () => {
  it("counts the 칩 업데이트 in", () => {
    const t: Tourney = { id: "t1", createdAt: T0, updatedAt: T0, activeAt: T0, name: "", memo: "", start: T0, startSet: true, startStack: 50000, checks: [check(5, 70000)] };
    const hs = [hand(1, 3000, { tourney: "t1" }), hand(10, -1000, { tourney: "t1" })];
    const g: TourneyGroup = { kind: "tourney", key: "t1", t, hands: hs, others: 0, day: T0, current: false };
    // 50,000 +3,000 = 53,000; counted 70,000; −1,000: +19,000
    expect(renderToStaticMarkup(createElement(GroupRes, { g }))).toBe('<span class="tn-res up">+19,000</span>');
    expect(renderToStaticMarkup(createElement(GroupRes, { g: { ...g, t: { ...t, checks: undefined } } }))).toBe('<span class="tn-res up">+2,000</span>');
  });
});

describe("칩 업데이트's sheet", () => {
  it("says how far the stack typed is from the count, and tints a 0 too many or too few", () => {
    expect(chipUpdateNote("", { chips: 41200 }, null, 5)).toEqual({ text: "칩 개수 그대로 (0이면 탈락)", tone: null });
    expect(chipUpdateNote("61200", { chips: 41200 }, null, 5)).toEqual({ text: "= 61,200칩 · 102bb · 앱보다 +20,000", tone: "diff" });
    expect(chipUpdateNote("41200", { chips: 41200 }, null, 5)).toEqual({ text: "= 41,200칩 · 68.7bb · 앱이 센 것과 같아요", tone: null });
    expect(chipUpdateNote("612000", { chips: 41200 }, null, 5)).toMatchObject({ text: "= 612,000칩 · 1020bb · 앱보다 +570,800 · 자릿수 확인", tone: "big" });
    expect(chipUpdateNote("6120", { chips: 41200 }, null, 5)).toMatchObject({ tone: "big" });
    // busted is 0, not a slip
    expect(chipUpdateNote("0", { chips: 41200 }, null, 5).tone).toBe("diff");
    // reopened right after one: measured against the one just typed; the slip check stays on the app's count
    expect(chipUpdateNote("62000", { chips: 41200 }, check(5, 61200), 5)).toEqual({ text: "= 62,000칩 · 103.3bb · 방금보다 +800", tone: "diff" });
    expect(chipUpdateNote("61200", { chips: 41200 }, check(5, 612000), 5).tone).toBe("diff");
    expect(chipUpdateNote("61200", { chips: 41200 }, check(5, 61200), 5).text).toContain("방금과 같아요");
    // nothing to measure against
    expect(chipUpdateNote("61200", { chips: null, why: "none" }, null, null)).toEqual({ text: "= 61,200칩", tone: null });
  });
});
