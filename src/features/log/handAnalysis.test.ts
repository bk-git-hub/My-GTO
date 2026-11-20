import { describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { equityVsHand } from "../../poker/equity";
import { emptyHand, tableOf, type LoggedHand } from "./handLog";
import { analyseHand, deckFor, equityKnown, parseCardText, stageFor, SUIT_GUESS_NOTE } from "./handAnalysis";
import { replay, skipTo, type LogStep } from "./recorder";
import { chartGraded, decisionTags, GRADE_MARK } from "../../play/table";
import { EV_SOFT, LOW_LIMP_SOFT, LOW_SOFT } from "../../play/chartGrade";
import { THIN_JAM_NOTE } from "../../play/computedChart";

/** Record like the table UI: skip to a seat (the ones between fold or check), then act. */
function record(h: LoggedHand, moves: [string, LogStep["k"], number?][]): LogStep[] {
  let steps: LogStep[] = [];
  for (const [seat, k, to] of moves) {
    const { game } = replay(tableOf(h), steps);
    steps = [...steps, ...skipTo(game, seat), { s: seat, k, ...(to !== undefined ? { to } : {}) }];
    expect(replay(tableOf(h), steps).applied, `${seat} ${k}`).toBe(steps.length);
  }
  return steps;
}

/** The mockup hand: 9-handed, Lv6 (800 bb), everyone 32,000. I'm the BB with A♦T♦; CO shows K♣Q♣. */
function exampleHand(): LoggedHand {
  const h: LoggedHand = { ...emptyHand(6), players: 9, seat: "BB", hole: parseCards("AdTd"), stack: 32000, board: parseCards("Kd9d2s6cQd") };
  h.steps = record(h, [
    ["UTG", "call"], // limp 800
    ["CO", "raise", 3], // open 2,400
    ["BB", "call"],
    ["UTG", "call"],
    ["BB", "check"],
    ["UTG", "check"],
    ["CO", "raise", 4], // bet 3,200
    ["BB", "call"],
    ["UTG", "fold"],
    ["BB", "check"],
    ["CO", "raise", 8.75], // bet 7,000
    ["BB", "call"],
    ["BB", "raise", 11.25], // bet 9,000
    ["CO", "call"],
  ]);
  h.showdowns = [{ name: "빨간모자", seat: "CO", cards: parseCards("KcQc"), did: "" }];
  return h;
}

describe("card text", () => {
  it("parses hands and boards, and explains mistakes", () => {
    expect(parseCardText("AdTd", 2).cards).toEqual(parseCards("AdTd"));
    expect(parseCardText("ad td", 2).cards).toEqual(parseCards("AdTd"));
    expect(parseCardText("10d9c", 2).cards).toEqual(parseCards("Td9c"));
    expect(parseCardText("Kd9d2", 5)).toMatchObject({ cards: parseCards("Kd9d"), pending: "2", error: null });
    expect(parseCardText("AdAd", 2).error).toMatch(/두 번/);
    expect(parseCardText("Ax", 2).error).toMatch(/수트/);
    expect(parseCardText("Zd", 2).error).toMatch(/랭크/);
    expect(parseCardText("Kd", 2, parseCards("Kd")).error).toMatch(/이미/);
  });
});

describe("real cards and exact equity", () => {
  it("deals the known hole cards and board through the engine", () => {
    const holes = [undefined, parseCards("KcQc"), parseCards("AdTd")];
    const deck = deckFor(3, holes, parseCards("Kd9d2s"));
    const d = deck.slice();
    const dealt = [[d.pop(), d.pop()], [d.pop(), d.pop()], [d.pop(), d.pop()]];
    expect(dealt[1]).toEqual(parseCards("KcQc"));
    expect(dealt[2]).toEqual(parseCards("AdTd"));
    expect([d.pop(), d.pop(), d.pop()]).toEqual(parseCards("Kd9d2s"));
    expect(new Set(deck).size).toBe(52);
  });

  it("matches the hand-vs-hand equity on every street", () => {
    const hero = parseCards("AdTd"), co = parseCards("KcQc");
    for (const b of ["Kd9d2s", "Kd9d2s6c", "Kd9d2s6cQd"]) {
      const exact = equityVsHand(hero, co, parseCards(b));
      expect(equityKnown([hero, co], parseCards(b))[0]).toBeCloseTo(exact.win + exact.tie / 2, 6);
    }
    expect(equityKnown([hero, co], parseCards("Kd9d2s6c"))[0]).toBeCloseTo(12 / 44, 6); // 9 diamonds + 3 aces
  });
});

describe("analysing a recorded hand", () => {
  it("shows the run-out, the result and every decision of the example hand", () => {
    const a = analyseHand(exampleHand(), { decisions: true, iterations: 1500 });
    expect(a.applied).toBe(exampleHand().steps.length);
    expect(a.game.done).toBe(true);
    expect(a.streets.map((v) => v.street)).toEqual(["preflop", "flop", "turn", "river"]);
    const mine = a.streets.map((v) => v.known.find((k) => k.seat === "BB")?.equity ?? NaN);
    expect(mine[0]).toBeGreaterThan(0.55); // preflop ~58% (Monte Carlo)
    expect(mine[0]).toBeLessThan(0.62);
    expect(mine[1]).toBeCloseTo(0.456, 2);
    expect(mine[2]).toBeCloseTo(12 / 44, 6);
    expect(mine[3]).toBe(1);
    expect(a.streets[1].potStart).toBeCloseTo(10.5); // 8,400 at 800 a bb
    expect(a.streets[2].potStart).toBeCloseTo(18.5);
    expect(a.heroNet).toBeCloseTo(30.5); // +24,400
    expect(a.showdownSeats).toEqual(["CO"]);
    expect(a.decisions.map((d) => `${d.street}:${d.step.k}`)).toEqual([
      "preflop:call", "flop:check", "flop:call", "turn:check", "turn:call", "river:raise",
    ]);
    const turnCall = a.decisions[4];
    expect(turnCall.decision.reqEquity).toBeCloseTo(8.75 / (27.25 + 8.75), 3); // ~24%
    expect(turnCall.actual).toBeCloseTo(12 / 44, 6);
    expect(turnCall.actualComplete).toBe(true);
    for (const v of a.streets) expect(v.estimate, v.street).not.toBeNull();
  });

  it("analyses another player's hand for that player, with the same numbers and grades", () => {
    const mine = exampleHand();
    // The same hand watched from UTG: the BB is the subject, I limped and folded the flop.
    const theirs: LoggedHand = { ...mine, kind: "other", mySeat: "UTG" };
    const a = analyseHand(mine, { decisions: true, iterations: 1500 });
    const b = analyseHand(theirs, { decisions: true, iterations: 1500 });
    expect(b.heroNet).toBe(a.heroNet);
    expect(b.decisions.map((d) => [d.street, d.verb, d.decision.grade, d.actual])).toEqual(a.decisions.map((d) => [d.street, d.verb, d.decision.grade, d.actual]));
    expect(b.streets.map((v) => [v.estimate, v.known])).toEqual(a.streets.map((v) => [v.estimate, v.known]));
    // only the tags differ
    expect(a.streets[0].actions).toEqual(["UTG 림프 1", "CO 레이즈 3", "BB(나) 콜 3", "UTG 콜 3"]);
    expect(b.streets[0].actions).toEqual(["UTG(나) 림프 1", "CO 레이즈 3", "BB(상대) 콜 3", "UTG(나) 콜 3"]);
    expect(b.streets[1].actions).toContain("UTG(나) 폴드");
    expect(a.suitGuess).toBeNull();
    expect(a.streets.every((v) => !v.suitGuessed) && a.decisions.every((d) => !d.suitGuessed)).toBe(true);
  });

  it("flags the streets where guessed suits are in play", () => {
    // The turn's suit was guessed: the turn and river numbers are approximate, the earlier ones exact.
    const turn = analyseHand({ ...exampleHand(), guess: { board: [3] } }, { decisions: true, iterations: 600 });
    expect(turn.suitGuess).toEqual({ hole: false, board: [3] });
    expect(turn.streets.map((v) => v.suitGuessed)).toEqual([false, false, true, true]);
    expect(turn.decisions.map((d) => d.suitGuessed)).toEqual([false, false, false, true, true, true]);
    // guessed hole suits: every street
    const hole = analyseHand({ ...exampleHand(), guess: { hole: true }, holeKind: "suited" }, { decisions: true, iterations: 600 });
    expect(hole.suitGuess).toEqual({ hole: true, board: [] });
    expect(hole.streets.every((v) => v.suitGuessed)).toBe(true);
    expect(SUIT_GUESS_NOTE).toBe("수트를 추정한 카드가 있어 플러시 관련 승률은 근사예요");
    // a marker for a card that isn't on the hand is ignored
    expect(analyseHand({ ...exampleHand(), board: [], guess: { board: [4] } }, { iterations: 300 }).suitGuess).toBeNull();
  });

  it("gives the same numbers and grades every time for the same hand", () => {
    const h = exampleHand();
    const one = analyseHand(h, { decisions: true, iterations: 1500 });
    const two = analyseHand(h, { decisions: true, iterations: 1500 });
    expect(two.decisions.map((d) => [d.decision.grade, d.decision.equity])).toEqual(one.decisions.map((d) => [d.decision.grade, d.decision.equity]));
    expect(two.streets.map((v) => v.estimate)).toEqual(one.streets.map((v) => v.estimate));
    expect(Math.random).not.toBe(undefined);
  });

  it("can't settle a showdown without the opponent's cards, but a fold win settles itself", () => {
    const h = exampleHand();
    h.showdowns = [];
    expect(analyseHand(h).heroNet).toBeNull();
    const folded: LoggedHand = { ...emptyHand(6), players: 6, seat: "BTN", hole: parseCards("AsKs"), stack: 32000 };
    folded.steps = record(folded, [["BTN", "raise", 2.5], ["SB", "fold"], ["BB", "fold"]]);
    const a = analyseHand(folded);
    expect(a.game.done).toBe(true);
    expect(a.heroNet).toBeCloseTo(2.5); // blinds 1.5 + BB ante 1
  });

  it("narrows ranges from the actions: a limper looks wide, a 4-bettor strong", () => {
    const h: LoggedHand = { ...emptyHand(6), players: 9, seat: "BTN", hole: parseCards("7h7c"), stack: 32000 };
    h.steps = record(h, [["UTG", "call"]]);
    record(h, []);
    const vsLimp = analyseHand({ ...h, steps: [...h.steps, ...skipTo(replay(tableOf(h), h.steps).game, "BTN")] }, { iterations: 6000 }).current!;
    h.steps = record(h, [["CO", "raise", 3], ["BTN", "raise", 9], ["CO", "raise", 20]]);
    const vs4bet = analyseHand(h, { iterations: 6000 }).current!;
    expect(vsLimp.equity!).toBeGreaterThan(0.45); // 77 vs a wide limping range
    expect(vs4bet.equity!).toBeLessThan(vsLimp.equity! - 0.08); // vs a 4-bet range it's far worse
    expect(vs4bet.need).toBeGreaterThan(0); // facing 20bb, a call needs equity
    expect(stageFor(40)).toBe("mid");
  });

  it("grades preflop against the computed chart of the hand's stacks, never the pub chart", () => {
    // Lv6: 800 a bb. Each probe: the table, my seat, cards and stack, the moves, the grade and the chart line.
    const probe = (players: number, seat: string, hole: string, stack: number, moves: [string, LogStep["k"], number?][]) => {
      const h: LoggedHand = { ...emptyHand(6), players, seat, hole: parseCards(hole), stack };
      h.steps = record(h, moves);
      return analyseHand(h, { decisions: true, iterations: 300 }).decisions.find((d) => d.street === "preflop")!.decision;
    };
    const btn = probe(9, "BTN", "As5s", 80000, [["CO", "raise", 2.5], ["BTN", "raise", 6.6]]);
    expect([btn.grade, btn.chart, btn.chartInfo?.spot, btn.chartInfo?.confidence]).toEqual(["good", "솔버 100bb · BTN vs CO 오픈 — 콜 0% / 3벳 6.6bb 100% / 폴드 0%", "btn-vs-co-open", "높음"]);
    expect(btn.chartInfo?.facts[0]).toBe("차트: 솔버 100bb (100bb · 오픈 2.2bb) · BTN vs CO 오픈 · 콜 0% / 3벳 6.6bb 100% / 폴드 0% · 신뢰도 높음");
    const lj = probe(6, "UTG", "Kh9h", 44000, [["UTG", "raise", 2.2]]);
    expect([lj.chartInfo?.source, lj.chartInfo?.spot]).toEqual(["solver", "rfi-lj"]);
    const sq = probe(9, "CO", "9h9d", 44000, [["LJ", "raise", 2.2], ["HJ", "call"], ["CO", "raise", 8.8]]);
    expect([sq.grade, sq.chartInfo?.spot]).toEqual(["good", "co-at-lj-open-hj-call"]);
    const bb = probe(9, "BB", "7h6h", 16000, [["BTN", "raise", 2], ["BB", "call"]]);
    expect([bb.grade, bb.chartInfo?.source, bb.chart?.startsWith("숏스택 20bb · BB vs BTN 2bb 오픈")]).toEqual(["good", "shortnash", true]);
    // the mockup hand's BB call behind a UTG limp: no computed chart, so no grade
    const mock = analyseHand(exampleHand(), { decisions: true, iterations: 300 }).decisions[0].decision;
    expect([mock.grade, mock.chart, mock.chartInfo?.source]).toEqual(["info", "이 상황은 계산된 차트가 없어요 · 림프 팟", null]);
    // the summary says why there is no chart; the coach line only says how to judge instead, not the reason again
    expect(mock.summary).toBe("계산된 차트 없음 · 림프 팟");
    expect(mock.chartInfo?.facts).toEqual(["차트 없이 팟 오즈와 원리로만 판단"]);
    // marked 참고, and no "graded by the computed chart" footer for it
    expect([GRADE_MARK[mock.grade], chartGraded(mock), chartGraded(btn)]).toEqual(["참고", false, true]);
  });

  /** A recorded hand's preflop decisions (Lv6: 800 a bb), with per-seat stacks in bb. */
  // `id` seeds the Monte Carlo equity (analyseHand): give one where a test reads a number near a threshold.
  const pre = (seat: string, hole: string, bb: number, moves: [string, LogStep["k"], number?][], stacks: Record<string, number> = {}, id?: string) => {
    const h: LoggedHand = { ...emptyHand(6), ...(id ? { id } : {}), players: 9, seat, hole: parseCards(hole), stack: bb * 800, stacks };
    h.steps = record(h, moves);
    return analyseHand(h, { decisions: true, iterations: 300 }).decisions.filter((d) => d.street === "preflop").map((d) => d.decision);
  };

  it("grades a 100bb open by the chart of its own size, and keeps that stage for the rest of the hand", () => {
    const [small] = pre("CO", "Kh8d", 100, [["CO", "raise", 2.2]]);
    expect([small.grade, small.chartInfo?.stage, small.chart]).toEqual(["good", "100bb-2.2", "솔버 100bb · CO 오픈 레인지 — 오픈 2.2bb 100% / 폴드 0%"]);
    const [big] = pre("CO", "Kh8d", 100, [["CO", "raise", 3]]);
    expect([big.grade, big.chartInfo?.stage, big.chart]).toEqual(["mistake", "100bb-3", "솔버 100bb · CO 오픈 레인지 — 오픈 3bb 0% / 폴드 100%"]);
    // the open and the answer to the 3-bet read the same stage
    const both = pre("CO", "AhJd", 100, [["CO", "raise", 2.2], ["BTN", "raise", 7], ["CO", "call"]]);
    expect(both.map((d) => [d.chartInfo?.stage, d.chartInfo?.spot])).toEqual([
      ["100bb-2.2", "rfi-co"],
      ["100bb-2.2", "co-open-vs-btn-3bet"],
    ]);
    // the SB's limp and its call of the BB's raise: one stage, whatever the BB raised to
    for (const to of [2.5, 4]) expect(pre("SB", "QhTd", 100, [["SB", "call"], ["BB", "raise", to], ["SB", "call"]]).map((d) => d.chartInfo?.stage)).toEqual(["100bb-3", "100bb-3"]);
  });

  it("grades and narrows a raise over an all-in as a call of it", () => {
    // BTN 100bb isolates a 10bb CO jam with AKo: the push/fold chart calls it 100%
    const [iso] = pre("BTN", "AhKd", 100, [["CO", "raise", 10], ["BTN", "raise", 30]], { CO: 10 });
    expect([iso.grade, iso.chartInfo?.spot]).toEqual(["good", "call-btn-vs-co"]);
    expect(iso.chartInfo?.tags).toContain("올인엔 콜과 같아요");
    expect(iso.summary).toContain("올인엔 콜과 같아요");
    // the shown call EV is rounded, never -0.684000000000001bb
    for (const o of iso.options.filter((x) => x.ev !== null)) expect(o.ev).toBe(Math.round(o.ev! * 10) / 10);
    // the BTN's range after its iso raise is its calling range, as if it had called
    const share = (k: "raise" | "call") =>
      pre("BB", "7h2d", 100, [["CO", "raise", 10], k === "raise" ? ["BTN", "raise", 30] : ["BTN", "call"], ["BB", "fold"]], { CO: 10 })[0].villains.find((x) => x.seat === "BTN")!.share;
    expect(share("raise")).toBeCloseTo(share("call"), 6);
    expect(share("raise")).toBeLessThan(0.5);
  });

  it("does not grade a limp or flat the short-stack chart leaves out, nor a premium a low-confidence chart limps", () => {
    const [limp] = pre("SB", "Kh4d", 17, [["SB", "call"], ["BB", "check"]]);
    expect([limp.grade, limp.chartInfo?.tags]).toEqual(["info", ["이 차트엔 림프·플랫이 없어요"]]);
    const [trash] = pre("SB", "7h2d", 17, [["SB", "call"], ["BB", "check"]]);
    expect(trash.grade).toBe("mistake");
    const [flat] = pre("BTN", "8h8d", 20, [["CO", "raise", 2], ["BTN", "call"]]);
    expect(flat.grade).toBe("info");
    const [aa] = pre("SB", "AhAd", 100, [["SB", "raise", 3.5]]);
    expect([aa.grade, aa.summary, aa.chartInfo?.tags]).toEqual(["info", "신뢰도 낮은 차트라 참고만", ["신뢰도 낮은 차트라 참고만"]]);
    // the summary says it once; the coach facts don't repeat it
    expect(aa.chartInfo?.facts.join("\n")).not.toContain(LOW_LIMP_SOFT);
    // the same AA open-shoved for 100bb is graded: the chart limps it and has no all-in
    const [shove] = pre("SB", "AhAd", 100, [["SB", "raise", 100]]);
    expect([shove.grade, shove.chartInfo?.soft]).toEqual(["mistake", undefined]);
  });

  it("never shows a 30–45bb all-in call grade its own call EV contradicts", () => {
    // The reviewer's lines (h.probe): a re-jam over an open is graded on the 25bb chart and the jammer is narrowed by
    // its 25bb re-jam range; a first-in jam has no chart (the call EV stays).
    const lines: [string, number, (c: "call") => [string, LogStep["k"], number?][]][] = [
      ["HJ", 35, (c) => [["HJ", "raise", 2], ["BTN", "raise", 35], ["HJ", c]]],
      ["HJ", 42, (c) => [["HJ", "raise", 2.2], ["BTN", "raise", 42], ["HJ", c]]],
      ["BB", 40, (c) => [["CO", "raise", 40], ["BB", c]]],
      ["BTN", 40, (c) => [["UTG", "raise", 40], ["BTN", c]]],
    ];
    const hands = ["AhAd", "QhQd", "ThTd", "9h9d", "8h8d", "7h7d", "6h6d", "5h5d", "AhKh", "AhKd", "AhQh", "AhQd", "AhJh", "AhJd", "AhTh", "AhTd", "Ah9h", "Ah9d", "Ah8h", "Ah5h", "KhQh", "KhQd", "KhJh", "KhJd", "KhTh", "QhJh", "JhTh"];
    let contra = 0;
    const marks = new Map<number, Set<string>>();
    for (const [k, [seat, bb, moves]] of lines.entries()) {
      for (const hole of hands) {
        const h: LoggedHand = { ...emptyHand(6), id: `m3-${k}-${hole}`, players: 9, seat, hole: parseCards(hole), stack: bb * 800, stacks: {} };
        h.steps = record(h, moves("call"));
        const d = analyseHand(h, { decisions: true, iterations: 300 }).decisions.filter((x) => x.street === "preflop").at(-1)!.decision;
        const ev = d.options.find((o) => o.key === "call")!.ev!;
        // the card's 필요 X% · 그때 추정 Y%, as whole points
        const shown = Math.round(d.equity! * 100) - Math.round(d.reqEquity! * 100);
        if ((d.grade === "good" && (ev < -1 || shown <= -2)) || (d.grade === "mistake" && (ev > 1 || shown >= 2))) contra++;
        marks.set(k, (marks.get(k) ?? new Set()).add(d.grade));
        if (k >= 2) {
          // the first-in jams: 참고, the reason and the call EV (the BB's ante leaves the CO's last bb out of its pot)
          expect(d.summary, hole).toMatch(/^계산된 차트 없음 · 솔버가 이 라인을 풀지 않았어요 · 콜 EV [+-]?[\d.]+bb \(에퀴티 \d+% vs 필요 \d+%(, 내 스택을 넘는 1bb 제외)?\)$/);
        } else expect(d.chartInfo?.stage).toBe("25bb");
      }
    }
    expect(contra).toBe(0);
    expect([...marks.get(2)!, ...marks.get(3)!]).toEqual(["info", "info"]);
    expect(marks.get(0)).toEqual(new Set(["good", "ok", "mistake"]));
  });

  it("narrows a 30–45bb re-jam over an open by the 25bb re-jam range its call is graded on", () => {
    // the BTN's range after its jam over the HJ's 2bb open: at 35bb as at 25bb (before: the 35bb chart's any-raise range)
    const btn = (bb: number) => pre("HJ", "KhQd", bb, [["HJ", "raise", 2], ["BTN", "raise", bb], ["HJ", "call"]])[1].villains.find((v) => v.seat === "BTN")!.share;
    expect(btn(35)).toBeCloseTo(btn(25), 6);
    // and a call the 25bb chart likes but this hand's call EV doesn't, by more than 1bb, is only △ (a fixed id: the
    // equity is Monte Carlo, about 44% against a 46% price)
    const [, kqo] = pre("HJ", "KhQd", 44, [["HJ", "raise", 2.2], ["BTN", "raise", 44], ["HJ", "call"]], {}, "kqo-44");
    const ev = kqo.options.find((o) => o.key === "call")!.ev!;
    expect(ev).toBeLessThan(-1);
    expect([kqo.grade, kqo.chartInfo?.soft]).toEqual(["ok", EV_SOFT]);
    expect(kqo.summary).toContain(EV_SOFT);
  });

  it("prices a call of a covering all-in on the chips my stack can win, so the chart's clear grades stand", () => {
    // The reviewer's side-pot hands: the jammer has more chips than me, and only my own stack's worth of them is mine
    // to win. Before, the price counted every chip of the jam (10bb BB vs a 50bb jam: 13%), the EV rule then turned
    // the chart's ✓ and ✗ into △.
    const bb10 = (cls: string, k: "call" | "fold") => pre("BB", cls, 10, [["BTN", "raise", 50], ["BB", k]], { BTN: 50 }, `side10-${cls}-${k}`).at(-1)!;
    const fold72 = bb10("7h2d", "fold");
    // the BB's 8 more against the BTN's chips up to the BB's own 9: 1 ante + 0.5 + 9 + 1 = 11.5 to win, 41bb not
    expect([fold72.pot, fold72.sidePot, fold72.toCall]).toEqual([52.5, 41, 8]);
    expect(fold72.reqEquity).toBeCloseTo(8 / 19.5, 9);
    expect([fold72.grade, fold72.chartInfo?.soft]).toEqual(["good", undefined]);
    expect(fold72.summary).toContain("필요 41%, 내 스택을 넘는 41bb 제외)");
    expect(decisionTags(fold72)).toContain("내 스택을 넘는 41bb 제외");
    const call72 = bb10("7h2d", "call");
    expect(call72.grade).toBe("mistake");
    // its call EV against that price: the equity (about 30%) times 19.5, less the 8
    const ev = call72.options.find((o) => o.key === "call")!.ev!;
    expect(ev).toBeCloseTo(call72.equity! * 19.5 - 8, 0);
    expect(ev).toBeLessThan(-1);
    expect(bb10("AhQd", "call").grade).toBe("good");
    expect(bb10("AhQd", "fold").grade).toBe("mistake");
    // 18bb BB vs a 60bb CO jam, and a 35bb HJ open against a 100bb BTN jam: the chart's folds ✓, its calls of them ✗
    for (const cls of ["7h2d", "Kh5d", "Qh9d"]) {
      const bb18 = (k: "call" | "fold") => pre("BB", cls, 18, [["CO", "raise", 60], ["BB", k]], { CO: 60 }, `side18-${cls}-${k}`).at(-1)!;
      const f = bb18("fold");
      expect([f.sidePot, f.reqEquity! > 0.44 && f.reqEquity! < 0.46], cls).toEqual([43, true]);
      expect([f.grade, bb18("call").grade], cls).toEqual(["good", "mistake"]);
    }
    for (const cls of ["7h2d", "QhTd", "Jh9h"]) {
      const hj = (k: "call" | "fold") => pre("HJ", cls, 35, [["HJ", "raise", 2.2], ["BTN", "raise", 100], ["HJ", k]], { BTN: 100 }, `side35-${cls}-${k}`).at(-1)!;
      const f = hj("fold");
      expect([f.sidePot, f.reqEquity! > 0.44 && f.reqEquity! < 0.46], cls).toEqual([65, true]);
      expect([f.grade, hj("call").grade], cls).toEqual(["good", "mistake"]);
    }
    const aq = pre("HJ", "AhQd", 35, [["HJ", "raise", 2.2], ["BTN", "raise", 100], ["HJ", "call"]], { BTN: 100 }, "side35-aq").at(-1)!;
    expect(aq.grade).toBe("good");
    // the live price while the BB is still to act (the table screen's 필요 에퀴티) is the same
    const live: LoggedHand = { ...emptyHand(6), id: "side10-live", players: 9, seat: "BB", hole: parseCards("7h2d"), stack: 8000, stacks: { BTN: 50 } };
    live.steps = record(live, [["BTN", "raise", 50], ["SB", "fold"]]);
    expect(analyseHand(live).current?.need).toBeCloseTo(8 / 19.5, 9);
    // I cover the jammer: nothing is left out, and no tag
    const cover = pre("BB", "AhQd", 60, [["CO", "raise", 18], ["BB", "call"]], { CO: 18 }, "cover").at(-1)!;
    expect(cover.sidePot).toBeUndefined();
    expect(cover.reqEquity).toBeCloseTo(cover.toCall / (cover.pot + cover.toCall), 9);
    expect(decisionTags(cover)).not.toContain(expect.stringContaining("내 스택을 넘는"));
  });

  it("grades the all-in of a premium a low-confidence chart limps △ where its tree has an all-in", () => {
    // 35bb SB AKo: 림프 80% / 오픈 20% / 올인 0% in a 낮음 chart: two steps from the doubted limp, so △, tagged once
    const [ako] = pre("SB", "AhKd", 35, [["SB", "raise", 35]]);
    expect([ako.grade, ako.chartInfo?.soft, ako.chartInfo?.tags]).toEqual(["ok", LOW_SOFT, ["신뢰도 낮음"]]);
    expect(ako.summary).toBe(`차트 기준 올인 35 빈도 0% · ${LOW_SOFT}`);
    // its limp stays 참고, its fold a ✗
    expect(pre("SB", "AhKd", 35, [["SB", "call"]])[0].grade).toBe("info");
    expect(pre("SB", "AhKd", 35, [["SB", "fold"]])[0].grade).toBe("mistake");
    // 100bb has no all-in in its tree: the AA open-shove is a ✗ the chart lacks
    const [aa] = pre("SB", "AhAd", 100, [["SB", "raise", 100]]);
    expect([aa.grade, aa.chartInfo?.tags]).toEqual(["mistake", ["신뢰도 낮음", "이 차트엔 없는 선택"]]);
  });

  it("only shows a 20–25bb call of a first-in jam its equilibrium all but never makes", () => {
    const [co] = pre("BB", "AhTd", 25, [["CO", "raise", 25], ["BB", "call"]]);
    expect([co.grade, co.chartInfo?.source, co.chartInfo?.confidence, co.chartInfo?.soft]).toEqual(["info", "shortnash", "낮음", THIN_JAM_NOTE]);
    expect(co.summary).toMatch(new RegExp(`^${THIN_JAM_NOTE} · 콜 EV `));
    expect(co.chartInfo?.tags).toContain(THIN_JAM_NOTE);
    // the CO's 20bb jam (1.8% of hands) is a real one: graded
    const [co20] = pre("BB", "AhTd", 20, [["CO", "raise", 20], ["BB", "call"]]);
    expect(co20.grade).not.toBe("info");
  });

  it("gives every graded preflop decision a computed chart, and every other one a reason", () => {
    const deals = ["AsKd", "7c2d", "QhJh", "5s5d", "Ac4c", "KdTd", "9s8s", "JcJd"];
    const seats = ["UTG", "LJ", "CO", "BTN", "SB", "BB"];
    for (const [k, stack] of [80000, 44000, 28000, 16000, 8000].entries()) {
      for (const [j, seat] of seats.entries()) {
        const h: LoggedHand = { ...emptyHand(6), players: 9, seat, hole: parseCards(deals[(j + k) % deals.length]), stack };
        const before = seats.slice(0, j).filter((x) => x !== "SB" && x !== "BB");
        const opener = before.length ? before[before.length - 1] : null;
        h.steps = record(h, opener ? [[opener, "raise", stack >= 30000 ? 2.5 : 2], [seat, "call"]] : [[seat, "raise", 2.2]]);
        for (const d of analyseHand(h, { decisions: true, iterations: 200 }).decisions.filter((x) => x.street === "preflop")) {
          const info = d.decision.chartInfo!;
          if (d.decision.grade === "info" && !info.source) expect(d.decision.chart).toMatch(/^이 상황은 계산된 차트가 없어요 · /);
          else expect(["solver", "shortnash", "nash"]).toContain(info.source);
        }
      }
    }
  });

  it("plays heads-up in the right order", () => {
    const h: LoggedHand = { ...emptyHand(6), players: 2, seat: "SB", hole: parseCards("AhKh"), stack: 32000 };
    const { game } = replay(tableOf(h), []);
    expect(game.players[game.toAct!].seat).toBe("SB"); // the button acts first preflop
    h.steps = record(h, [["SB", "call"], ["BB", "check"]]);
    const after = replay(tableOf(h), h.steps).game;
    expect(after.street).toBe("flop");
    expect(after.players[after.toAct!].seat).toBe("BB"); // and last after the flop
  });
});
