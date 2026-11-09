import { describe, expect, it } from "vitest";
import type { Grade } from "../../play/table";
import {
  addHand,
  chipResult,
  EMPTY_SESSION,
  foldedOnly,
  formatNet,
  moveName,
  GOOD_BUT_LOST,
  handVerdict,
  mismatchNote,
  missLine,
  MISTAKE_BUT_WON,
  sessionLine,
  verdictReviewLines,
  type GradedDecision,
} from "./verdict";

const dec = (grade: Grade, over: Partial<GradedDecision> = {}): GradedDecision => ({ street: "flop", grade, chosen: "check", chosenLabel: "체크", ...over });
/** A preflop decision graded by the chart alone. */
const chart = (grade: Grade) => dec(grade, { street: "preflop", chosen: "call", chosenLabel: "콜 2.5" });
const turnCall = (grade: Grade) => dec(grade, { street: "turn", chosen: "call", chosenLabel: "콜 4" });

describe("handVerdict: the worst graded decision sets the class and headline", () => {
  it("all good -> green 판단 좋았어요", () => {
    expect(handVerdict([dec("good"), dec("good")])).toEqual({ kind: "good", cls: "correct", headline: "판단 좋았어요", graded: 2, mistakes: 0 });
  });

  it("any ok and no mistake -> amber 판단 괜찮았어요", () => {
    expect(handVerdict([dec("good"), dec("ok"), dec("info")])).toMatchObject({ kind: "ok", cls: "mixed", headline: "판단 괜찮았어요", graded: 2 });
  });

  it("any mistake -> red, counting the mistakes", () => {
    expect(handVerdict([dec("mistake"), dec("ok"), dec("good")])).toMatchObject({ kind: "mistake", cls: "wrong", headline: "실수 1개", mistakes: 1 });
    expect(handVerdict([dec("mistake"), dec("mistake"), dec("good")]).headline).toBe("실수 2개");
  });

  it("only 참고, or no decision at all -> neutral", () => {
    const none = { kind: "none", cls: "neutral", headline: "채점할 결정이 없었어요", graded: 0, mistakes: 0 };
    expect(handVerdict([])).toEqual(none);
    expect(handVerdict([dec("info"), dec("info")])).toEqual(none);
  });
});

describe("chip result: a secondary line, not the verdict", () => {
  it("formats wins, losses and break-even", () => {
    expect(formatNet(5)).toBe("+5bb");
    expect(formatNet(-3)).toBe("-3bb");
    expect(formatNet(0)).toBe("본전");
    expect(formatNet(-0.04)).toBe("본전");
    expect(formatNet(2.25)).toBe("+2.3bb");
  });

  it("adds 쇼다운 and a tone for the colored number", () => {
    expect(chipResult(-3, true)).toEqual({ amount: "-3bb", tone: "loss", showdown: true, text: "결과 -3bb · 쇼다운" });
    expect(chipResult(5, false)).toEqual({ amount: "+5bb", tone: "win", showdown: false, text: "결과 +5bb" });
    expect(chipResult(0, false)).toEqual({ amount: "본전", tone: "even", showdown: false, text: "결과 본전" });
  });
});

describe("mismatchNote: one sentence when the verdict and the chips disagree", () => {
  it("good or ok play that lost: a correct play can lose a hand", () => {
    expect(mismatchNote("good", -3)).toBe(GOOD_BUT_LOST);
    expect(mismatchNote("ok", -3)).toBe(GOOD_BUT_LOST);
  });

  it("a mistake that won: it cost in the long run", () => {
    expect(mismatchNote("mistake", 5)).toBe(MISTAKE_BUT_WON);
  });

  it("says nothing when they agree", () => {
    expect(mismatchNote("good", 5)).toBeNull();
    expect(mismatchNote("ok", 2)).toBeNull();
    expect(mismatchNote("mistake", -3)).toBeNull();
  });

  it("says nothing for a right fold that only lost the blinds", () => {
    const fold = [chart("good")].map((d) => ({ ...d, chosen: "fold", chosenLabel: "폴드" }));
    expect(foldedOnly(fold)).toBe(true);
    expect(mismatchNote("good", -0.5, foldedOnly(fold))).toBeNull();
    // a fold after putting chips in (open, then fold to a 3-bet) is a hand that was played
    const openFold = [dec("good", { street: "preflop", chosen: "raise:3" }), dec("good", { street: "preflop", chosen: "fold" })];
    expect(foldedOnly(openFold)).toBe(false);
    expect(mismatchNote("good", -3, foldedOnly(openFold))).toBe(GOOD_BUT_LOST);
    expect(foldedOnly([])).toBe(false);
  });

  it("says nothing at break-even or with no graded decision", () => {
    expect(mismatchNote("good", 0)).toBeNull();
    expect(mismatchNote("mistake", 0)).toBeNull();
    expect(mismatchNote("none", -1)).toBeNull();
    expect(mismatchNote("none", 4)).toBeNull();
  });
});

describe("missLine: names the moves graded 실수, else 괜찮음, without an EV sum", () => {
  it("names a single mistake by street and move", () => {
    expect(missLine([dec("mistake"), turnCall("good")])).toBe("실수: 플랍 체크");
  });

  it("names two mistakes in order, without their sizes", () => {
    expect(missLine([chart("good"), dec("mistake"), turnCall("mistake")])).toBe("실수: 플랍 체크, 턴 콜");
    const bet = dec("mistake", { street: "river", chosen: "raise:2.1", chosenLabel: "벳 33% (2.1)" });
    expect(missLine([turnCall("mistake"), bet])).toBe("실수: 턴 콜, 리버 벳 33%");
  });

  it("names a chart-graded preflop mistake", () => {
    expect(missLine([chart("mistake"), dec("good")])).toBe("실수: 프리플랍 콜");
  });

  it("names 괜찮음 moves only when there is no mistake", () => {
    expect(missLine([dec("good"), turnCall("ok")])).toBe("아쉬운 선택: 턴 콜");
    expect(missLine([dec("ok"), turnCall("ok")])).toBe("아쉬운 선택: 플랍 체크, 턴 콜");
    expect(missLine([dec("ok"), turnCall("mistake")])).toBe("실수: 턴 콜");
  });

  it("is null when every graded decision was good, or nothing was graded", () => {
    expect(missLine([chart("good"), dec("good"), turnCall("good")])).toBeNull();
    expect(missLine([])).toBeNull();
    expect(missLine([dec("info")])).toBeNull();
  });

  it("never names a 참고 decision", () => {
    expect(missLine([dec("info"), turnCall("good")])).toBeNull();
    expect(missLine([dec("info"), turnCall("mistake")])).toBe("실수: 턴 콜");
    expect(missLine([dec("info"), turnCall("ok")])).toBe("아쉬운 선택: 턴 콜");
  });

  it("names moves without their sizes", () => {
    expect(moveName("콜 2.5")).toBe("콜");
    expect(moveName("벳 33% (2.1)")).toBe("벳 33%");
    expect(moveName("벳 팟 (7.5)")).toBe("벳 팟");
    expect(moveName("3벳 10.5")).toBe("3벳");
    expect(moveName("레이즈 7.5")).toBe("레이즈");
    expect(moveName("올인 45")).toBe("올인");
    expect(moveName("체크")).toBe("체크");
  });
});

describe("session totals: decisions first, chips last", () => {
  it("starts empty with no line", () => {
    expect(EMPTY_SESSION).toEqual({ hands: 0, net: 0, graded: 0, mistakes: 0 });
    expect(sessionLine(EMPTY_SESSION)).toBeNull();
  });

  it("adds hands up, keeping mistakes over decisions apart from the chips", () => {
    let t = EMPTY_SESSION;
    t = addHand(t, { net: -3, graded: 1, mistakes: 0 });
    t = addHand(t, { net: -9.5, graded: 3, mistakes: 1 });
    t = addHand(t, { net: 0.5, graded: 2, mistakes: 1 });
    expect(t).toEqual({ hands: 3, net: -12, graded: 6, mistakes: 2 });
    expect(sessionLine(t)).toBe("이번 세션 3핸드 · 실수 2개 / 결정 6개 · 결과 합계 -12bb");
    expect(sessionLine(addHand(t, { net: 20, graded: 2, mistakes: 0 }))).toBe("이번 세션 4핸드 · 실수 2개 / 결정 8개 · 결과 합계 +8bb");
    expect(sessionLine({ hands: 2, net: 0, graded: 3, mistakes: 0 })).toBe("이번 세션 2핸드 · 실수 0개 / 결정 3개 · 결과 합계 0bb");
  });

  it("does not let float sums leak into the chip total", () => {
    let t = EMPTY_SESSION;
    for (const net of [0.1, 0.2, 0.4]) t = addHand(t, { net, graded: 1, mistakes: 0 });
    expect(t.net).toBe(0.7);
  });

  it("leaves the decision count out while nothing was graded", () => {
    expect(sessionLine({ hands: 2, net: 1.5, graded: 0, mistakes: 0 })).toBe("이번 세션 2핸드 · 결과 합계 +1.5bb");
  });

  it("does not mutate the totals it is given", () => {
    const t = { hands: 1, net: 2, graded: 2, mistakes: 1 };
    addHand(t, { net: 1, graded: 1, mistakes: 1 });
    expect(t).toEqual({ hands: 1, net: 2, graded: 2, mistakes: 1 });
  });
});

describe("verdictReviewLines: the AI review reads the verdict before the chips", () => {
  it("states the verdict, names the mistakes, and asks to judge decisions, not results", () => {
    const lines = verdictReviewLines([chart("good"), dec("mistake"), turnCall("ok")]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("판단 평가: 실수 1개 (채점한 결정 3개 중 실수 1개)");
    expect(lines[1]).toBe("실수: 플랍 체크");
    expect(lines[2]).toMatch(/^리뷰 기준: .*칩 결과가 아니라.*결정/);
  });

  it("names 괜찮음 moves when there was no mistake", () => {
    expect(verdictReviewLines([dec("good"), turnCall("ok")])[1]).toBe("아쉬운 선택: 턴 콜");
  });

  it("has no miss line when every decision was good, and never an EV sum", () => {
    const lines = verdictReviewLines([dec("good"), chart("good")]);
    expect(lines[0]).toBe("판단 평가: 판단 좋았어요 (채점한 결정 2개 중 실수 0개)");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^리뷰 기준: /);
    expect(lines.join("\n")).not.toMatch(/EV/);
  });

  it("has only the verdict and the rule without graded decisions", () => {
    const lines = verdictReviewLines([dec("info")]);
    expect(lines[0]).toBe("판단 평가: 채점할 결정이 없었어요");
    expect(lines).toHaveLength(2);
  });
});
