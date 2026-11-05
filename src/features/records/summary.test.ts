import { describe, expect, it } from "vitest";
import type { Attempt, AttemptGrade, QuizKind } from "../../../shared/contracts";
import { newId } from "../../../shared/ids";
import { bestOptionLabel, chosenOptionLabel, decisionCorrect, decisionEvLoss, evLoss, playGrade } from "../play/playAttempt";
import type { Decision } from "../../play/table";
import {
  attemptFacts,
  byKind,
  dayKey,
  filterHistory,
  formatTime,
  legacyTotals,
  overview,
  practiceRoute,
  spotLabel,
  weakSpots,
} from "./summary";

const NOW = new Date(2026, 10, 5, 15, 30).getTime(); // 2026-11-05 15:30 local
const at = (daysAgo: number, h = 10, m = 0) => new Date(2026, 10, 5 - daysAgo, h, m).getTime();

function att(over: Partial<Attempt> & { kind?: QuizKind; grade?: AttemptGrade } = {}): Attempt {
  const time = over.at ?? at(0);
  return {
    id: newId(time),
    v: 1,
    at: time,
    kind: "preflop",
    keys: ["preflop", "preflop:pub/deep/rfi-btn"],
    spot: "preflop:pub/deep/rfi-btn:A5s",
    title: "BTN 오픈 · 딥 · A5s",
    chosen: "레이즈",
    correct: "레이즈",
    grade: "correct",
    deviceId: "dev",
    ...over,
  };
}

describe("time helpers", () => {
  it("formats today vs other days in local time", () => {
    expect(formatTime(at(0, 9, 5), NOW)).toBe("오늘 09:05");
    expect(formatTime(at(2, 23, 59), NOW)).toBe("11/3 23:59");
    expect(dayKey(at(0))).toBe("2026-11-05");
  });
});

describe("overview", () => {
  it("counts totals (mixed = correct), today and a 14-day bar series", () => {
    const list = [
      att({ at: at(0), grade: "correct" }),
      att({ at: at(0, 11), grade: "mixed" }),
      att({ at: at(0, 12), grade: "wrong" }),
      att({ at: at(3), grade: "wrong" }),
      att({ at: at(20), grade: "correct" }), // outside the window
    ];
    const o = overview(list, NOW);
    expect(o.attempts).toBe(5);
    expect(o.correct).toBe(3);
    expect(o.today).toBe(3);
    expect(o.todayCorrect).toBe(2);
    expect(o.days).toHaveLength(14);
    expect(o.days[13]).toMatchObject({ day: "2026-11-05", label: "11/5", today: true, attempts: 3 });
    expect(o.days[10]).toMatchObject({ label: "11/2", attempts: 1, correct: 0 });
    expect(o.days[0].label).toBe("10/23");
    expect(o.days.reduce((n, d) => n + d.attempts, 0)).toBe(4);
  });

  it("handles an empty log", () => {
    const o = overview([], NOW);
    expect(o).toMatchObject({ attempts: 0, correct: 0, today: 0 });
  });
});

describe("byKind", () => {
  it("summarises each kind present with a last-20 trend and EV loss", () => {
    const list: Attempt[] = [];
    // 20 wrong answers long ago, then 20 correct ones: recent 100% vs overall 50% → up.
    for (let i = 0; i < 40; i++) list.push(att({ kind: "odds", spot: "odds:팟 오즈", at: at(10) + i * 1000, grade: i < 20 ? "wrong" : "correct" }));
    list.push(att({ kind: "play", spot: "play:deep:flop", grade: "wrong", evLossBB: 1.5 }));
    list.push(att({ kind: "play", spot: "play:deep:flop", grade: "correct", evLossBB: 0.5 }));
    list.push(att({ kind: "play", spot: "play:deep:turn", grade: "correct" }));
    const s = byKind(list);
    expect(s.map((k) => k.kind)).toEqual(["odds", "play"]);
    expect(s[0]).toMatchObject({ attempts: 40, correct: 20, recent: { attempts: 20, correct: 20 }, trend: "up", avgEvLoss: null });
    expect(s[1]).toMatchObject({ attempts: 3, correct: 2, trend: null, avgEvLoss: 1, evCount: 2 });
  });

  it("marks a falling trend", () => {
    const list: Attempt[] = [];
    for (let i = 0; i < 30; i++) list.push(att({ at: at(5) + i * 1000, grade: i < 10 ? "correct" : i % 2 ? "wrong" : "correct" }));
    expect(byKind(list)[0].trend).toBe("down");
  });
});

describe("weakSpots", () => {
  it("needs 3+ attempts, sorts by accuracy then attempts, top 5", () => {
    const list: Attempt[] = [];
    const add = (spot: string, kind: QuizKind, grades: AttemptGrade[]) =>
      grades.forEach((grade, i) => list.push(att({ spot, kind, grade, at: at(1) + i * 1000 + list.length, title: `${spot} #${i}` })));
    add("stack:pub:short:CO:K9o", "stack", ["wrong", "wrong", "correct"]); // 33%, 3
    add("odds:MDF", "odds", ["wrong", "correct", "wrong", "correct", "wrong", "wrong"]); // 33%, 6
    add("play:mid:river", "play", ["wrong", "wrong", "wrong"]); // 0%
    add("preflop:x:AA", "preflop", ["correct", "correct", "correct"]); // 100%
    add("equity:플랍 에퀴티", "equity", ["wrong", "wrong"]); // only 2 → excluded
    add("stack:cash:100bb:UTG+1:A9s", "stack", ["mixed", "wrong", "wrong", "wrong"]); // 25%
    const w = weakSpots(list);
    expect(w.map((x) => x.spot)).toEqual(["play:mid:river", "stack:cash:100bb:UTG+1:A9s", "odds:MDF", "stack:pub:short:CO:K9o", "preflop:x:AA"]);
    expect(w[0]).toMatchObject({ label: "핸드 플레이 · 미들 · 리버", route: "play", attempts: 3, correct: 0 });
    expect(w[1].route).toBe("quiz/stack/cash/all/UTG%2B1");
    expect(w[2].label).toBe("팟 오즈·EV · MDF");
    expect(w[3]).toMatchObject({ route: "quiz/stack/pub/short/CO", label: "stack:pub:short:CO:K9o #2" });
    expect(weakSpots(list, 3, 2)).toHaveLength(2);
  });

  it("routes each kind to its quiz", () => {
    expect(practiceRoute("preflop:pub/deep/rfi-btn:A5s", "preflop")).toBe("quiz/preflop");
    expect(practiceRoute("equity:프리플랍 에퀴티", "equity")).toBe("quiz/equity");
    expect(practiceRoute("odds:팟 오즈", "odds")).toBe("quiz/odds");
    expect(practiceRoute("daily:x", "daily")).toBe("home");
    expect(spotLabel("preflop:a:AKs", "preflop", "BTN 오픈 · 딥 · AKs")).toBe("BTN 오픈 · 딥 · AKs");
  });
});

describe("history and legacy totals", () => {
  it("filters by kind and wrong-only, newest first", () => {
    const a = att({ at: at(2), kind: "odds", grade: "wrong" });
    const b = att({ at: at(1), kind: "preflop", grade: "wrong" });
    const c = att({ at: at(0), kind: "preflop", grade: "mixed" });
    expect(filterHistory([a, b, c], "all", false).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(filterHistory([a, b, c], "preflop", false).map((x) => x.id)).toEqual([c.id, b.id]);
    expect(filterHistory([a, b, c], "all", true).map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it("legacy = tallies minus logged answers per top key, never negative", () => {
    const list = [
      att({ keys: ["preflop", "preflop:x"], grade: "correct" }),
      att({ keys: ["stack-cash", "stack-cash:100bb"], kind: "stack", grade: "wrong" }),
      att({ keys: ["odds", "odds:MDF"], kind: "odds", grade: "correct" }), // imported: no tally
    ];
    const byKey = {
      preflop: { attempts: 10, correct: 7 },
      "preflop:x": { attempts: 10, correct: 7 },
      "stack-cash": { attempts: 3, correct: 1 },
      play: { attempts: 4, correct: 4 },
    };
    expect(legacyTotals(byKey, list)).toEqual({ attempts: 9 + 2 + 4, correct: 6 + 1 + 4 });
    expect(legacyTotals({}, list)).toEqual({ attempts: 0, correct: 0 });
  });

  it("builds coach facts from an attempt", () => {
    const f = attemptFacts(att({ grade: "wrong", evLossBB: 1.2, detail: "보드: As Kd 7c" }));
    expect(f).toContain("채점: 오답");
    expect(f).toContain("EV 손실: 1.2bb");
    expect(f).toContain("보드: As Kd 7c");
  });
});

describe("play attempt helpers", () => {
  const opts = [
    { key: "fold", label: "폴드", ev: 0 },
    { key: "call", label: "콜 4", ev: 1.4 },
    { key: "raise:12", label: "레이즈 12", ev: -0.6 },
  ];
  it("computes EV loss only with 2+ EVs", () => {
    expect(evLoss(opts, "raise:12")).toBe(2);
    expect(evLoss(opts, "call")).toBe(0);
    expect(evLoss([{ key: "fold", label: "폴드", ev: null }, { key: "call", label: "콜", ev: 1 }], "call")).toBeUndefined();
  });
  it("names the best option by EV, else by chart frequency", () => {
    expect(bestOptionLabel(opts)).toBe("콜 4 (+1.4bb)");
    expect(
      bestOptionLabel([
        { key: "fold", label: "폴드 (차트 20%)", ev: null },
        { key: "raise:3", label: "레이즈 3 (차트 80%)", ev: null },
      ]),
    ).toBe("레이즈 3 (차트 80%)");
  });
  it("keeps a chart-graded preflop all-in call consistent with its grade", () => {
    const dec = (street: Decision["street"], options: Decision["options"], chosen: string): Decision => ({
      street, board: [], pot: 20, toCall: 10, reqEquity: 0.33, spr: 0, equity: 0.3,
      chosen, chosenLabel: chosen, options, grade: "good", summary: "", villains: [],
    });
    // Chart calls 100%, but EV vs the estimated range is -0.5bb: graded "good" by the chart.
    const pre = dec("preflop", [
      { key: "fold", label: "폴드 (차트 0%)", ev: 0 },
      { key: "call", label: "콜 (차트 100%)", ev: -0.5 },
    ], "call");
    expect(decisionCorrect(pre)).toBe("콜 (차트 100%)");
    expect(chosenOptionLabel(pre)).toBe("콜 (차트 100%)");
    expect(decisionEvLoss(pre)).toBeUndefined();
    // Postflop stays EV-based.
    const post = dec("flop", opts, "raise:12");
    expect(decisionCorrect(post)).toBe("콜 4 (+1.4bb)");
    expect(chosenOptionLabel(post)).toBe("레이즈 12 (-0.6bb)");
    expect(decisionEvLoss(post)).toBe(2);
  });
  it("maps play grades like the tallies do", () => {
    expect([playGrade("good"), playGrade("ok"), playGrade("mistake"), playGrade("info")]).toEqual(["correct", "mixed", "wrong", null]);
  });
});
