import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { bbPart, levelNear, netBoth } from "./fastChips";
import { resultParts, resultText } from "./fastLog";
import { CheckRow, FastItem } from "./FastParts";
import { Bb, Parts } from "./FastResult";
import { emptyHand, type LoggedHand } from "./handLog";
import { ChipUpdateSheet, TourneySheet } from "./TourneySheet";

/**
 * 빠른 기록's auto-converted bb, easy to see: every bb next to chips is its own `.bb` span (the bb color, bold,
 * as big as the chips beside it), worked out by the same rules as before. Never "?bb": without a level the
 * chips stand alone.
 */

const M = "−";
const noop = () => {};
let n = 0;
/** A 빠른 기록 hand of mine at minute `m` of the night. */
const hand = (m: number, level: number | null, extra: Partial<LoggedHand> = {}): LoggedHand => {
  n++;
  return { ...emptyHand(level), id: `b${n}`, createdAt: m * 60_000, updatedAt: m * 60_000, seat: "CO", fast: true, ...extra };
};
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("the bb on its own", () => {
  it("is the chips at the level's big blind, signed when asked, and nothing without a level", () => {
    // Lv5 300/600
    expect(bbPart(61800, 5)).toBe("103bb");
    expect(bbPart(12800, 5, true)).toBe("+21.3bb");
    expect(bbPart(-1200, 5, true)).toBe(`${M}2bb`);
    expect(bbPart(-1200, 5)).toBe(`${M}2bb`);
    expect(bbPart(0, 5, true)).toBeNull();
    expect(bbPart(0, 5)).toBe("0bb");
    expect(bbPart(12800, null)).toBeNull();
    expect(bbPart(12800, 99)).toBeNull();
  });

  it("counts a moment between hands at the level of the last hand before it, else the first one after", () => {
    const hs = [hand(10, 3), hand(20, null), hand(30, 6)];
    expect(levelNear(hs, 25 * 60_000)).toBe(3);
    expect(levelNear(hs, 30 * 60_000)).toBe(6);
    expect(levelNear(hs, 5 * 60_000)).toBe(3);
    expect(levelNear(hs, Infinity)).toBe(6);
    expect(levelNear([hand(1, null)], Infinity)).toBeNull();
    expect(levelNear([], 0)).toBeNull();
  });

  it("gives a hand's result as before, the bb apart (the copy text keeps its words exactly)", () => {
    const cases: Pick<LoggedHand, "result" | "net" | "level">[] = [
      { result: "win", net: 12000, level: 5 },
      { result: "lose", net: -4800, level: 5 },
      { result: "fold", net: -300, level: 5 },
      { result: "fold", net: 0, level: 5 },
      { result: "fold", net: null, level: null },
      { result: "chop", net: 0, level: 5 },
      { result: "win", net: null, level: 5 },
      { result: "win", net: 12000, level: null },
      { result: null, net: null, level: 5 },
    ];
    expect(cases.map(resultParts)).toEqual([
      { text: "+12,000", bb: "+20bb" },
      { text: `${M}4,800`, bb: `${M}8bb` },
      { text: `폴드 ${M}300`, bb: `${M}0.5bb` },
      { text: "폴드", bb: null },
      { text: "폴드", bb: null },
      { text: "본전", bb: null },
      { text: "수익", bb: null },
      { text: "+12,000", bb: null },
      { text: "", bb: null },
    ]);
    // the words as they always were
    expect(cases.map(resultText)).toEqual(["+12,000 (+20bb)", `${M}4,800 (${M}8bb)`, `폴드 ${netBoth(-300, 5)}`, "폴드", "폴드", "본전", "수익", "+12,000", ""]);
  });
});

describe("the bb on screen", () => {
  it("is a .bb span, never glued to the chips, and nothing at all without one", () => {
    expect(html(createElement(Bb, { v: "+25.6bb" }))).toBe('<span class="bb">+25.6bb</span>');
    expect(html(createElement(Bb, { v: "130bb", className: "fc-bb" }))).toBe('<span class="bb fc-bb">130bb</span>');
    expect(html(createElement(Bb, { v: null }))).toBe("");
    // a line's text pieces run together around the bb
    expect(html(createElement(Parts, { p: ["+12,800", " ", { bb: "+25.6bb" }, " · ", "다음"] }))).toBe('+12,800 <span class="bb">+25.6bb</span> · 다음');
  });

  it("goes under a list row's chips (one column, so the board keeps its room): the bb in chips, the chips in bb, a stack's bb; nothing without a level", () => {
    const row = (h: LoggedHand, view: "chips" | "bb" = "chips") => html(createElement(FastItem, { h, view, other: false, editing: false, onClick: noop }));
    expect(row(hand(1, 5, { result: "win", net: 12800 }))).toContain('<span class="fi-money"><span class="fi-net up">+12,800</span> <span class="fi-bb bb">+21.3bb</span></span>');
    expect(row(hand(1, 5, { result: "fold", net: -1200 }))).toContain(`<span class="fi-money"><span class="fi-net fold">폴드 ${M}1,200</span> <span class="fi-bb bb">${M}2bb</span></span>`);
    expect(row(hand(1, 5, { result: "win", net: 12800 }), "bb")).toContain('<span class="fi-money"><span class="fi-net up">+21.3bb</span> <span class="fi-bb">12,800</span></span>');
    expect(row(hand(1, 5, { result: null, net: null, stack: 90000, fastStack: true }))).toContain('<span class="fi-money"><span class="fi-net">스택 90,000</span> <span class="fi-bb bb">150bb</span></span>');
    // the board right after the column
    expect(row(hand(1, 9, { result: "win", net: 31200, board: parseCards("Ad8s5h") }))).toMatch(/<span class="fi-bb bb">\+19\.5bb<\/span><\/span><span class="fi-board"><span class="s-d">A♦<\/span>/);
    // nothing in the other unit: the chips alone, as before
    expect(row(hand(1, null, { result: "win", net: 12800 }))).toContain('<span class="fi-net up">+12,800</span><span class="fi-board">');
    expect(row(hand(1, null, { result: "win", net: 12800 }))).not.toContain("fi-bb");
    expect(row(hand(1, 5, { result: "fold", net: 0 }))).not.toContain("fi-bb");
    expect(row(hand(1, 5, { result: "chop", net: 0 }))).not.toContain("fi-bb");
  });

  it("goes under a 칩 업데이트's stack at the level given", () => {
    const c = { at: 0, stack: 65000, diff: 3200 };
    expect(html(createElement(CheckRow, { c, level: 5 }))).toContain('<span class="fc-count"><b class="fc-stack">65,000</b><span class="bb fc-bb">108.3bb</span></span><span class="fc-diff up">+3,200</span>');
    expect(html(createElement(CheckRow, { c }))).toContain('<span class="fc-count"><b class="fc-stack">65,000</b></span><span class="fc-diff up">+3,200</span>');
  });

  it("reads the app's count with its bb on the 칩 업데이트 calculator, and the stack typed big with its bb", () => {
    const sheet = html(createElement(ChipUpdateSheet, { now: { chips: 63000 }, level: 5, open: null, onSave: () => null, onClose: noop }));
    expect(sheet).toContain('<span class="calc-note">앱이 센 스택 <b>63,000</b> <span class="bb">105bb</span></span>');
    // nothing typed yet: the display asks, the line says what to type (the keypad, no input element)
    expect(sheet).toContain('<b class="calc-num ph">지금 칩은?</b>');
    expect(sheet).toContain('<div class="calc-line hint">칩 개수 그대로 · 0이면 탈락</div>');
    expect(sheet).not.toContain("<input");
    expect(sheet).not.toContain("?bb");
  });

  it("shows a start stack's bb at the first level (야자수 새틀 Lv1: 100/200), or at a 직접 입력 tournament's starting BB", () => {
    const sheet = html(createElement(TourneySheet, { mode: "new", initial: { name: "", clock: "19:00", stack: "50000", memo: "" }, defaultName: "11/7 토너먼트", onSave: () => null, onClose: noop }));
    expect(sheet).toContain('class="tn-numfield" aria-label="시작 스택 50,000 · 계산기로 넣기">50,000 <span class="bb">250bb</span></button><small>Lv1 기준 · 누르면 계산기</small>');
    const custom = html(
      createElement(TourneySheet, { mode: "new", initial: { name: "", clock: "", stack: "30000", memo: "", structure: "custom", blinds: { sb: 100, bb: 200, ante: 200 } }, defaultName: "11/7 토너먼트", onSave: () => null, onClose: noop }),
    );
    expect(custom).toContain('>30,000 <span class="bb">150bb</span></button><small>BB 200 기준</small>');
    expect(custom).toContain(">100/200 <small>앤티 200</small></button>");
    expect(custom).not.toContain('type="time"');
  });
});
