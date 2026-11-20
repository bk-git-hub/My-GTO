import { describe, expect, it } from "vitest";
import { positionsFor } from "../features/log/recorder";
import { ALL_HANDS, fullDeck, type HandClass } from "../poker/cards";
import { PREFLOP_STAGES } from "../data/sets/preflopData";
import { AS_CALL_TAG, callEdge, chartFacts, chartTags, chartText, EV_SOFT, gradeVsChart, groupFreqs, LOW_LIMP_SOFT, LOW_SOFT, lowLimpJam, MODEL_GAP_SOFT, SIZE_SOFT, type CallNumbers } from "./chartGrade";
import { chartFor, pickChart, type ChartForOptions, type ChartHit, type ChartPick } from "./computedChart";
import { act, legal, newGame, type Game } from "./engine";

function play(stack: number, moves: [string, "call" | "raise" | "jam", number?][], opts: { ante?: boolean } = {}): Game {
  let g = newGame(stack, 0, fullDeck(), { seats: positionsFor(9), bbAnte: opts.ante ?? true });
  for (const [seat, k, to] of moves) {
    while (g.players[g.toAct!].seat !== seat) g = act(g, "fold");
    g = k === "jam" ? act(g, "raise", legal(g, g.toAct!).maxRaiseTo) : act(g, k, to);
  }
  return g;
}
const upTo = (g: Game, seat: string) => {
  while (g.players[g.toAct!].seat !== seat) g = act(g, "fold");
  return g;
};
function at(g: Game, pin?: ChartPick, opts: ChartForOptions = {}): { hit: ChartHit; allIn: number } {
  const a = chartFor(g, g.toAct!, pin ? { ...opts, pin } : opts);
  if (!a.ok) throw new Error(a.text);
  return { hit: a, allIn: legal(g, g.toAct!).maxRaiseTo };
}
const FOLD = { kind: "fold" as const };
const CALL = { kind: "call" as const };
const raise = (to: number) => ({ kind: "raise" as const, to });

describe("grading against the computed chart", () => {
  it("good, close, ok and mistake, as the quiz grades", () => {
    const btn = at(upTo(play(100, [["CO", "raise", 2.5]]), "BTN"));
    expect(gradeVsChart(btn.hit, "A5s", raise(6.6), btn.allIn)).toMatchObject({ grade: "good", freq: 1 });
    expect(chartText(btn.hit, "A5s")).toBe("솔버 100bb · BTN vs CO 오픈 — 콜 0% / 3벳 6.6bb 100% / 폴드 0%");
    // UTG at 100bb with the 2.2bb open: A4s is folded, but opening it is within ε (a close call)
    const utg = at(newGame(100, 0, fullDeck()), pickChart(100, { to: 2.2, sb: false }));
    const close = gradeVsChart(utg.hit, "A4s", raise(2.2), utg.allIn);
    expect(close).toMatchObject({ grade: "good", freq: 0, close: ["오픈 2.2bb", "폴드"] });
    expect(chartTags(utg.hit, close)).toEqual(["신뢰도 높음", "EV 거의 같음"]);
    // 66 opens 10%: a mix of 5% or more is ok
    expect(gradeVsChart(utg.hit, "66", raise(2.2), utg.allIn)).toMatchObject({ grade: "ok", freq: expect.closeTo(0.1, 6) });
    expect(gradeVsChart(utg.hit, "72o", raise(2.2), utg.allIn)).toMatchObject({ grade: "mistake", freq: 0 });
  });

  it("softens a ✗ to △ for a low-confidence chart one step away, never two", () => {
    // the SB limps AQs (rfi-sb, 낮음): raising it is one step from the limp
    const sb = at(upTo(play(100, []), "SB"));
    expect(sb.hit.confidence).toBe("low");
    const aqs = gradeVsChart(sb.hit, "AQs", raise(3.5), sb.allIn);
    expect(aqs).toMatchObject({ grade: "ok", soft: "신뢰도 낮은 차트" });
    // the tag says the confidence once
    expect(chartTags(sb.hit, aqs)).toEqual(["신뢰도 낮음"]);
    // opening 72o is two steps from the fold
    expect(gradeVsChart(sb.hit, "72o", raise(3.5), sb.allIn)).toMatchObject({ grade: "mistake" });
  });

  it("only shows a low-confidence chart that limps a premium, never grades by it", () => {
    // 100bb SB AA: 림프 100% in a 낮음 chart. Raising and limping it are 참고, folding it is still a ✗.
    const sb = at(upTo(play(100, []), "SB"));
    expect(sb.hit.scenario.strategy.AA.limp).toBe(1);
    const open = gradeVsChart(sb.hit, "AA", raise(3.5), sb.allIn);
    expect(open).toMatchObject({ grade: "info", soft: LOW_LIMP_SOFT });
    expect(chartTags(sb.hit, open)).toEqual(["신뢰도 낮은 차트라 참고만"]);
    expect(gradeVsChart(sb.hit, "AA", CALL, sb.allIn)).toMatchObject({ grade: "info", soft: LOW_LIMP_SOFT });
    expect(gradeVsChart(sb.hit, "AA", FOLD, sb.allIn).grade).toBe("mistake");
    // KK limps 90%: its top action too
    expect(gradeVsChart(sb.hit, "KK", raise(3.5), sb.allIn).grade).toBe("info");
    // an open-shove is no limp or open: graded, a ✗ as before (the chart has no all-in, and limps it)
    const shove = gradeVsChart(sb.hit, "AA", raise(sb.allIn), sb.allIn);
    expect(shove).toMatchObject({ grade: "mistake", freq: 0 });
    expect(shove.soft).toBeUndefined();
    expect(gradeVsChart(sb.hit, "KK", raise(sb.allIn), sb.allIn).grade).toBe("mistake");
    expect(chartTags(sb.hit, shove)).toEqual(["신뢰도 낮음", "이 차트엔 없는 선택"]);
  });

  it("softens the all-in of a premium a low-confidence chart limps to △ where its tree has an all-in", () => {
    // 35bb SB AKo: 림프 80% / 오픈 2.5bb 20% / 올인 0% in a 낮음 chart whose tree has the all-in
    for (const stack of [30, 35, 44.9]) {
      const sb = at(upTo(play(stack, []), "SB"));
      expect([sb.hit.pick.stageId, sb.hit.confidence, sb.hit.scenario.strategy.AKo.limp]).toEqual(["35bb-2", "low", 0.8]);
      const jam = gradeVsChart(sb.hit, "AKo", raise(sb.allIn), sb.allIn);
      expect(jam).toMatchObject({ grade: "ok", freq: 0, soft: LOW_SOFT });
      expect(jam.offTree).toBeUndefined();
      // tagged 신뢰도 낮음 once (and the stack approximation away from 35bb)
      expect(chartTags(sb.hit, jam)).toEqual(["신뢰도 낮음", ...sb.hit.approx]);
      // the rule 빠른 기록's verdict shares
      expect(lowLimpJam(sb.hit, "AKo", sb.allIn)).toBe("soft");
      expect(lowLimpJam(sb.hit, "AA", sb.allIn)).toBeNull();
      // as AA's jam there is (one step from its 100% open)
      expect(gradeVsChart(sb.hit, "AA", raise(sb.allIn), sb.allIn).grade).toBe("ok");
      // its limp and open stay 참고, its fold a ✗
      expect(gradeVsChart(sb.hit, "AKo", CALL, sb.allIn).grade).toBe("info");
      expect(gradeVsChart(sb.hit, "AKo", FOLD, sb.allIn).grade).toBe("mistake");
      // a jam of a non-premium the chart never jams is still a ✗ (72o: two steps from its fold)
      expect(gradeVsChart(sb.hit, "72o", raise(sb.allIn), sb.allIn).grade).toBe("mistake");
    }
    // 55bb: the tree has no all-in, so AA's open-shove stays a ✗ (이 차트엔 없는 선택)
    const deep = at(upTo(play(55, []), "SB"));
    expect(deep.hit.scenario.strategy.AA.limp).toBe(1);
    expect(gradeVsChart(deep.hit, "AA", raise(deep.allIn), deep.allIn)).toMatchObject({ grade: "mistake", offTree: true });
    expect(lowLimpJam(deep.hit, "AA", deep.allIn)).toBe("offTree");
  });

  it("never shows a ✓ or ✗ the hand's own call EV contradicts by more than 1bb", () => {
    // 35bb HJ opens 2, the BTN jams: graded on the 25bb chart, which calls KQo 60% and folds KJo
    const hj = at(upTo(play(35, [["HJ", "raise", 2], ["BTN", "jam"]]), "HJ"));
    expect(hj.hit.spotId).toBe("hj-open-vs-btn-jam");
    expect(gradeVsChart(hj.hit, "KQo", CALL, hj.allIn).grade).toBe("good");
    // (the equity shown right at the price: only the EV speaks)
    const ev = (x: number): CallNumbers => ({ ev: x, equity: 0.45, need: 0.45 });
    // the EV agrees, or is within 1bb: the chart's grade stands
    expect(gradeVsChart(hj.hit, "KQo", CALL, hj.allIn, ev(0.4)).grade).toBe("good");
    expect(gradeVsChart(hj.hit, "KQo", CALL, hj.allIn, ev(-1)).grade).toBe("good");
    // a call ✓ at -1.5bb and a fold ✗ when the call loses 1.5bb are △, said why
    expect(gradeVsChart(hj.hit, "KQo", CALL, hj.allIn, ev(-1.5))).toMatchObject({ grade: "ok", soft: EV_SOFT });
    expect(gradeVsChart(hj.hit, "AA", FOLD, hj.allIn, ev(-1.5))).toMatchObject({ grade: "ok", soft: EV_SOFT });
    // a call ✗ at +2bb and a fold ✓ when the call wins 2bb, the same
    expect(gradeVsChart(hj.hit, "KJo", CALL, hj.allIn).grade).toBe("mistake");
    expect(gradeVsChart(hj.hit, "KJo", CALL, hj.allIn, ev(2))).toMatchObject({ grade: "ok", soft: EV_SOFT });
    expect(gradeVsChart(hj.hit, "KJo", FOLD, hj.allIn, ev(2))).toMatchObject({ grade: "ok", soft: EV_SOFT });
    expect(chartTags(hj.hit, gradeVsChart(hj.hit, "KJo", CALL, hj.allIn, ev(2)))).toContain(EV_SOFT);
    // a raise over the jam is its call
    expect(gradeVsChart(hj.hit, "KJo", raise(hj.allIn), hj.allIn, ev(2))).toMatchObject({ grade: "ok", soft: EV_SOFT, asCall: true });
    // not facing an all-in there is no call EV to contradict
    const btn = at(upTo(play(100, [["CO", "raise", 2.5]]), "BTN"));
    expect(gradeVsChart(btn.hit, "72o", CALL, btn.allIn, ev(5)).grade).toBe("mistake");
  });

  it("never shows a ✓ or ✗ beside an equity 2 points or more on the other side of the price", () => {
    // 12bb BB vs a CO jam: the chart calls AA and folds 72o (a call of it ✗, its fold ✓). The numbers below are made
    // up to put the equity on either side of the price, as a jammer with another range than the chart's would.
    const bb = at(upTo(play(12, [["CO", "jam"]]), "BB"));
    expect(bb.hit.facingJam).toBe(true);
    expect(gradeVsChart(bb.hit, "72o", CALL, bb.allIn).grade).toBe("mistake");
    expect(gradeVsChart(bb.hit, "72o", FOLD, bb.allIn).grade).toBe("good");
    // "필요 41% · 그때 추정 44%" with a call EV of only +0.8bb: no ✗ beside it
    const shown = (equity: number, need: number, x = 0.5): CallNumbers => ({ ev: x, equity, need });
    expect(gradeVsChart(bb.hit, "72o", CALL, bb.allIn, shown(0.44, 0.41, 0.8))).toMatchObject({ grade: "ok", soft: EV_SOFT });
    // and no ✓ for its fold
    expect(gradeVsChart(bb.hit, "72o", FOLD, bb.allIn, shown(0.44, 0.41, 0.8))).toMatchObject({ grade: "ok", soft: EV_SOFT });
    // a point either way (as the card rounds it) is within the noise: the grade stands
    expect(gradeVsChart(bb.hit, "72o", CALL, bb.allIn, shown(0.4249, 0.4151, 0.2)).grade).toBe("mistake");
    expect(gradeVsChart(bb.hit, "72o", FOLD, bb.allIn, shown(0.4249, 0.4151, 0.2)).grade).toBe("good");
    // the card's whole points: 42.6% vs 40.4% shows 43 vs 40, three points
    expect(gradeVsChart(bb.hit, "72o", CALL, bb.allIn, shown(0.426, 0.404, 0.3)).grade).toBe("ok");
    // a ✓ call two points short of the price is △ too
    expect(gradeVsChart(bb.hit, "AA", CALL, bb.allIn, shown(0.39, 0.41, -0.3))).toMatchObject({ grade: "ok", soft: EV_SOFT });
    expect(gradeVsChart(bb.hit, "AA", CALL, bb.allIn, shown(0.4, 0.41, -0.3)).grade).toBe("good");
    expect(callEdge(shown(0.44, 0.41, 0.8), "fold")).toEqual({ bb: -0.8, points: -3 });
  });

  it("grades a first-in open by the chart of its own size at 100bb", () => {
    // CO K8o: the 2.2bb-open chart opens it 100%, the 3bb-open chart folds it
    const g = upTo(play(100, []), "CO");
    const small = at(g, undefined, { ownRaise: 2.2 });
    expect(small.hit.pick.stageId).toBe("100bb-2.2");
    expect(gradeVsChart(small.hit, "K8o", raise(2.2), small.allIn).grade).toBe("good");
    const big = at(g, undefined, { ownRaise: 3 });
    expect(big.hit.pick.stageId).toBe("100bb-3");
    expect(gradeVsChart(big.hit, "K8o", raise(3), big.allIn)).toMatchObject({ grade: "mistake", freq: 0 });
  });

  it("takes a raise over an all-in as a call of it", () => {
    // BTN 100bb, AKo, raises to 30 over a 10bb CO jam to isolate: the push/fold chart calls AKo 100%
    let g = newGame(100, 0, fullDeck(), { seats: positionsFor(9), bbAnte: true }, [100, 100, 100, 100, 100, 10, 100, 100, 100]);
    g = upTo(g, "CO");
    g = act(g, "raise", legal(g, g.toAct!).maxRaiseTo);
    const btn = at(upTo(g, "BTN"));
    expect([btn.hit.pick.source, btn.hit.spotId, btn.hit.facingJam]).toEqual(["nash", "call-btn-vs-co", true]);
    const iso = gradeVsChart(btn.hit, "AKo", raise(30), btn.allIn);
    expect(iso).toMatchObject({ grade: "good", freq: 1, asCall: true });
    expect(chartTags(btn.hit, iso)).toContain(AS_CALL_TAG);
    // a hand the chart folds is still a ✗, raised or called
    expect(gradeVsChart(btn.hit, "72o", raise(30), btn.allIn).grade).toBe("mistake");
  });

  it("does not grade a limp or flat the short-stack and push/fold charts leave out, unless they fold the hand", () => {
    // 17bb SB K4o: the short-stack chart opens or jams it (no limp); 72o it folds
    const sb = at(upTo(play(17, []), "SB"));
    expect(gradeVsChart(sb.hit, "K4o", CALL, sb.allIn)).toMatchObject({ grade: "info", soft: MODEL_GAP_SOFT });
    expect(chartTags(sb.hit, gradeVsChart(sb.hit, "K4o", CALL, sb.allIn))).toEqual([MODEL_GAP_SOFT]);
    expect(gradeVsChart(sb.hit, "72o", CALL, sb.allIn)).toMatchObject({ grade: "mistake", offTree: true });
    // 20bb BTN 88 against a CO 2bb open: only jam or fold there
    const btn = at(upTo(play(20, [["CO", "raise", 2]]), "BTN"));
    expect(gradeVsChart(btn.hit, "88", CALL, btn.allIn)).toMatchObject({ grade: "info", soft: MODEL_GAP_SOFT });
    // the solver's own missing actions stay graded: a 100bb open-jam
    const deep = at(upTo(play(100, []), "CO"));
    expect(gradeVsChart(deep.hit, "33", raise(100), deep.allIn).grade).toBe("mistake");
  });

  it("says EV 거의 같음 only when my action is one of the close calls", () => {
    // 35bb BTN KQo vs an HJ 2.2 open: 3-bet and call are within ε, the fold is not
    const btn = at(upTo(play(35, [["HJ", "raise", 2.2]]), "BTN"));
    const fold = gradeVsChart(btn.hit, "KQo", FOLD, btn.allIn);
    expect(fold.close).toBeDefined();
    expect(chartTags(btn.hit, fold)).not.toContain("EV 거의 같음");
    expect(chartTags(btn.hit, gradeVsChart(btn.hit, "KQo", CALL, btn.allIn))).toContain("EV 거의 같음");
  });

  it("keeps the tags short and says each thing once", () => {
    // 70bb BTN QJo folds to a CO 3bb open: the 55bb chart calls it, softened for the bigger open
    const btn = at(upTo(play(70, [["CO", "raise", 3]]), "BTN"));
    const g = gradeVsChart(btn.hit, "QJo", FOLD, btn.allIn);
    expect(g).toMatchObject({ grade: "ok", soft: "레이즈 크기가 차트와 달라요" });
    expect(chartTags(btn.hit, g)).toEqual(["신뢰도 중간", "유효스택 70bb → 55bb 차트", "오픈 3bb · 차트 2.2bb"]);
  });

  it("keeps the coach facts from repeating why a ✗ was softened or there is no grade (the summary says it)", () => {
    const btn = at(upTo(play(70, [["CO", "raise", 3]]), "BTN"));
    const soft = gradeVsChart(btn.hit, "QJo", FOLD, btn.allIn);
    expect(soft.soft).toBe(SIZE_SOFT);
    expect(chartFacts(btn.hit, "QJo", soft).join("\n")).not.toContain(SIZE_SOFT);
    const sb = at(upTo(play(100, []), "SB"));
    expect(chartFacts(sb.hit, "AA", gradeVsChart(sb.hit, "AA", raise(3.5), sb.allIn)).join("\n")).not.toContain(LOW_LIMP_SOFT);
    const noAnte = at(play(100, [], { ante: false }));
    expect(chartFacts(noAnte.hit, "72o", gradeVsChart(noAnte.hit, "72o", raise(3), noAnte.allIn)).join("\n")).not.toContain("앤티 없는 판이라 참고만");
    // the facts still carry the chart, its confidence and the approximations
    const facts = chartFacts(btn.hit, "QJo", soft);
    expect(facts[0]).toMatch(/^차트: 솔버 55bb .* · 신뢰도 중간$/);
    expect(facts).toContain("근사: 유효스택 70bb → 55bb 차트, 오픈 3bb · 차트 2.2bb");
    expect(facts.some((f) => f.startsWith("채점 메모"))).toBe(false);
  });

  it("softens a fold against a bigger open than the chart's, not a looser play", () => {
    const g = upTo(play(55, [["CO", "raise", 3]]), "BTN");
    const { hit, allIn } = at(g);
    expect(hit.sizeRatio).toBeGreaterThanOrEqual(1.25);
    expect(gradeVsChart(hit, "QJo", FOLD, allIn)).toMatchObject({ grade: "ok", soft: "레이즈 크기가 차트와 달라요" });
    expect(gradeVsChart(hit, "72o", CALL, allIn).grade).toBe("mistake");
  });

  it("softens a model-artifact cell", () => {
    // the first flagged cell of the 100bb-2.2 stage, with an action its chart never takes
    let found = false;
    for (const sc of PREFLOP_STAGES[0].scenarios.filter((s) => s.flags?.length && s.kind === "vsOpen" && !s.reachFrom)) {
      const opener = sc.villain!;
      const g = upTo(play(100, [[opener, "raise", 2.2]]), sc.hero);
      const { hit, allIn } = at(g, pickChart(100, { to: 2.2, sb: false }));
      if (hit.spotId !== sc.id) continue;
      for (const h of ALL_HANDS.filter((x) => hit.scenario.quizSkip?.[x])) {
        const freq = groupFreqs(hit.moves(h as HandClass, allIn), allIn);
        const move = freq.call === 0 ? CALL : freq.fold === 0 ? FOLD : null;
        if (!move) continue;
        const gr = gradeVsChart(hit, h as HandClass, move, allIn);
        if (gr.close) continue;
        expect(gr).toMatchObject({ grade: "ok", soft: "모델 한계 칸" });
        found = true;
        break;
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });

  it("does not grade without an ante or off the line's reach", () => {
    const noAnte = at(play(100, [], { ante: false }));
    expect(gradeVsChart(noAnte.hit, "72o", raise(3), noAnte.allIn)).toMatchObject({ grade: "info", soft: "앤티 없는 판이라 참고만" });
    // UTG opened 72o, which its chart never does, and faces a 3-bet
    const g = upTo(play(100, [["UTG", "raise", 3], ["CO", "raise", 9]]), "UTG");
    const { hit, allIn } = at(g);
    expect(hit.spotId).toBe("utg-open-vs-co-3bet");
    expect(gradeVsChart(hit, "72o", FOLD, allIn)).toMatchObject({ grade: "info", soft: "앞 액션이 차트 밖이라 채점 안 해요" });
  });

  it("takes a raise for the chart's shove, and a shove for its commit-sized raise, as 빠른 기록 does", () => {
    // 17bb CO: A5o opens 2bb; a shove is that raise of another size (short stacks shove anyway)
    const co = at(upTo(play(17, []), "CO"));
    expect(gradeVsChart(co.hit, "A5o", raise(17), co.allIn)).toMatchObject({ grade: "good", size: "2bb 오픈" });
    // 10bb UTG pushes 44: a min-raise is the push
    const p = at(play(10, []));
    expect(gradeVsChart(p.hit, "44", raise(2), p.allIn)).toMatchObject({ grade: "good", size: "올인" });
    // 100bb: an open-jam is not the 3bb open
    const deep = at(upTo(play(100, []), "CO"));
    expect(gradeVsChart(deep.hit, "33", raise(100), deep.allIn)).toMatchObject({ grade: "mistake", offTree: true });
  });
});
