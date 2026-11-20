import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RANKS } from "../../poker/cards";
import { fastHand, fastStats, newDraft, pickSuited, tapRank, type FastDraft } from "./fastLog";
import { FastItem, FastStatsRow, REF_MARK, shortVerdict } from "./FastParts";
import { emptyHand, type LoggedHand } from "./handLog";

/** 빠른 기록's list rows and chart line with a 참고 verdict (a chart answered, not to grade by). */

const R = (k: string) => RANKS.indexOf(k);
function typed(seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft {
  let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
  if (cls[2]) d = pickSuited(d, cls[2] === "s");
  return { ...d, ...extra };
}
let n = 0;
const hand = (d: FastDraft, act: Parameters<typeof fastHand>[1], stage: "deep" | "short" | "mid", mode: "mine" | "other" = "other"): LoggedHand => {
  n++;
  const base: LoggedHand = { ...emptyHand(null), id: `fp${n}`, createdAt: n * 60_000, updatedAt: n * 60_000 };
  return fastHand(d, act, base, stage, 9, mode)!;
};
const noop = () => {};

describe("참고 in 빠른 기록's lists", () => {
  it("shortens a 참고 verdict to 참고 for a row, as it does the others", () => {
    expect(shortVerdict("참고 · 이 차트엔 림프·플랫이 없어요")).toBe("참고");
    expect(shortVerdict("참고 · 신뢰도 낮은 차트라 참고만")).toBe("참고");
    expect(shortVerdict("⚠ 오버플레이 (차트: 폴드) · 솔버 55bb 기준")).toBe("⚠ 오버 (폴드)");
    expect(shortVerdict("차트 없음 · 림프 팟")).toBe("차트 없음");
  });

  it("leaves the action column of a 남의 핸드 row its room", () => {
    const flat = hand(typed("BTN", "88", { spot: "open", opener: "CO" }), "call", "short");
    const html = renderToStaticMarkup(createElement(FastItem, { h: flat, view: "chips", other: true, editing: false, onClick: noop }));
    expect(html).toContain('<span class="fi-act">CO 오픈 → 콜</span>');
    expect(html).toContain('<span class="fi-verdict">참고</span>');
    expect(html).not.toContain("림프·플랫");
  });

  it("marks a 참고 in a chips row with 참고, apart from the – of 차트 없음 (a tournament's rows)", () => {
    const row = (h: LoggedHand) => renderToStaticMarkup(createElement(FastItem, { h: { ...h, result: "win", net: 12000 }, view: "chips", other: false, editing: false, onClick: noop }));
    // 숏 SB K4o limp: the short-stack chart has no limp (참고); 딥 SB AA limp: the low-confidence chart's premium limp
    for (const h of [hand(typed("SB", "K4o"), "limp", "short", "mine"), hand(typed("SB", "AA"), "limp", "deep", "mine")]) {
      const html = row(h);
      expect(html).toContain("fi-net up");
      expect(html).toContain(`<span class="fi-verdict ref">${REF_MARK}</span>`);
      expect(html).not.toContain(">–<");
    }
    expect(REF_MARK).toBe("참고");
    // 차트 없음 (a limp pot) keeps its dash, a graded hand its sign
    expect(row(hand(typed("BTN", "AJo", { spot: "limp" }), "call", "mid", "mine"))).toContain('<span class="fi-verdict">–</span>');
    expect(row(hand(typed("CO", "72o"), "fold", "mid", "mine"))).toContain('<span class="fi-verdict">✓</span>');
  });

  it("counts 참고 apart from 차트 없음 in the chart line", () => {
    const hands = [
      hand(typed("SB", "K4o"), "limp", "short"),
      hand(typed("SB", "AA"), "limp", "deep"),
      hand(typed("BTN", "AJo", { spot: "limp" }), "call", "mid"),
      hand(typed("CO", "72o"), "fold", "mid"),
    ];
    const s = fastStats(hands);
    expect([s.ref, s.by.none, s.graded]).toEqual([2, 3, 1]);
    const html = renderToStaticMarkup(createElement(FastStatsRow, { stats: s, other: true }));
    expect(html).toContain("참고 2");
    expect(html).toContain("차트 없음 1");
    // none of either: neither label
    const plain = renderToStaticMarkup(createElement(FastStatsRow, { stats: fastStats([hands[3]]), other: false }));
    expect(plain).not.toContain("참고");
    expect(plain).not.toContain("차트 없음");
  });
});
