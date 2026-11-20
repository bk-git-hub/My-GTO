import { describe, expect, it } from "vitest";
import { getSet } from "../data/charts";
import { solverSetDefBuilt } from "../data/sets/preflop";
import { PREFLOP_STAGES } from "../data/sets/preflopData";
import { solverSpot } from "../data/sets/solverSpot";
import { positionsFor } from "../features/log/recorder";
import { fullDeck } from "../poker/cards";
import { JUDGE_SOURCE } from "../features/log/judgeChart";
import { chartTags, gradeVsChart } from "./chartGrade";
import { chartFor, COLD35_NOTE, COLD35_SQUEEZE_NOTE, effectiveStack, firstInJamShare, NOT_IN_35_NOTE, pickChart, PICK_FOR_STAGE, THIN_JAM_NOTE, type ChartForOptions, type ChartHit } from "./computedChart";
import { act, legal, newGame, type Game } from "./engine";

/** A game at `stack` (per-seat `stacks` optional), with `moves` played in table order (the seats between fold). */
function play(players: number, stack: number, moves: [string, "call" | "raise" | "jam" | "check", number?][], opts: { stacks?: number[]; ante?: boolean } = {}): Game {
  const seats = positionsFor(players);
  let g = newGame(stack, 0, fullDeck(), { seats, bbAnte: opts.ante ?? true }, opts.stacks);
  for (const [seat, k, to] of moves) {
    while (g.players[g.toAct!].seat !== seat) g = act(g, "fold");
    g = k === "jam" ? act(g, "raise", legal(g, g.toAct!).maxRaiseTo) : act(g, k, to);
  }
  return g;
}
/** The game with every seat before `seat` folded, `seat` to act. */
function upTo(g: Game, seat: string): Game {
  while (g.players[g.toAct!].seat !== seat) g = act(g, "fold");
  return g;
}
const hit = (g: Game, opts: ChartForOptions = {}): ChartHit => {
  const a = chartFor(g, g.toAct!, opts);
  if (!a.ok) throw new Error(a.text);
  return a;
};

describe("which chart", () => {
  it("picks by the effective stack, and at 100bb by the open's size", () => {
    const ids = (x: number, open?: { to: number; sb: boolean }) => pickChart(x, open).stageId;
    expect(ids(120)).toBe("100bb-3");
    expect(ids(100, { to: 2.5, sb: false })).toBe("100bb-2.2");
    expect(ids(100, { to: 3, sb: false })).toBe("100bb-3");
    expect(ids(100, { to: 3, sb: true })).toBe("100bb-2.2");
    expect(ids(100, { to: 3.5, sb: true })).toBe("100bb-3");
    expect(ids(74.9)).toBe("55bb-2.2");
    expect(ids(45)).toBe("55bb-2.2");
    expect(ids(44.9)).toBe("35bb-2");
    expect(ids(30)).toBe("35bb-2");
    expect(pickChart(29.9)).toMatchObject({ source: "shortnash", stageId: "25bb" });
    expect(pickChart(21)).toMatchObject({ source: "shortnash", stageId: "20bb", name: "숏스택 20bb" });
    expect(pickChart(12)).toMatchObject({ source: "shortnash", stageId: "12bb" });
    expect(pickChart(11.9)).toMatchObject({ source: "nash", stageId: "12bb" });
    expect(pickChart(3)).toMatchObject({ source: "nash", stageId: "4bb", name: "푸시폴드 4bb" });
  });

  it("reads the same chart per 빠른 기록 stage as the 아재 does", () => {
    for (const [stage, src] of Object.entries(JUDGE_SOURCE)) {
      const p = PICK_FOR_STAGE[stage as keyof typeof PICK_FOR_STAGE];
      expect(p.source, stage).toBe(src.kind);
      expect(p.stageId, stage).toBe(src.kind === "solver" ? src.id : `${src.stack}bb`);
    }
  });

  it("at 100bb picks a first-in open's stage by its own size, and every later decision by that open", () => {
    const co = upTo(play(9, 100, []), "CO");
    expect(hit(co, { ownRaise: 2.2 }).pick.stageId).toBe("100bb-2.2");
    expect(hit(co, { ownRaise: 2.5 }).pick.stageId).toBe("100bb-2.2");
    expect(hit(co, { ownRaise: 3 }).pick.stageId).toBe("100bb-3");
    // an open-jam is no open size; no raise yet (a fold or a limp) reads the pub-size stage
    expect(hit(co, { ownRaise: 100 }).pick.stageId).toBe("100bb-3");
    expect(hit(co).pick.stageId).toBe("100bb-3");
    // the SB's threshold is its own (3.25bb)
    const sb = upTo(play(9, 100, []), "SB");
    expect(hit(sb, { ownRaise: 3 }).pick.stageId).toBe("100bb-2.2");
    expect(hit(sb, { ownRaise: 3.5 }).pick.stageId).toBe("100bb-3");
    // the CO's own 2.2 open, then the BTN's 3-bet: still the 2.2bb-open stage
    const back = upTo(play(9, 100, [["CO", "raise", 2.2], ["BTN", "raise", 7]]), "CO");
    expect([hit(back).pick.stageId, hit(back).spotId]).toEqual(["100bb-2.2", "co-open-vs-btn-3bet"]);
    // ownRaise only counts first in: facing an open, the open decides
    const btn = upTo(play(9, 100, [["CO", "raise", 3]]), "BTN");
    expect(hit(btn, { ownRaise: 7 }).pick.stageId).toBe("100bb-3");
  });

  it("keeps a limped pot on the stage the SB's limp was read on, whatever the BB raises", () => {
    for (const to of [2.5, 4]) {
      const g = upTo(play(9, 100, [["SB", "call"], ["BB", "raise", to]]), "SB");
      expect([hit(g).pick.stageId, hit(g).spotId], `BB raise ${to}`).toEqual(["100bb-3", "sb-limp-vs-bb-iso"]);
    }
    // the BB's iso decision itself, with its own size
    const bb = upTo(play(9, 100, [["SB", "call"]]), "BB");
    expect(hit(bb, { ownRaise: 2.5 }).pick.stageId).toBe("100bb-3");
  });

  it("reads a 30–45bb re-jam over an open the 35bb solver left out on the short-stack chart's 25bb", () => {
    // HJ opens 2bb, the BTN jams 35bb: 35bb-2 exports only the BB's re-jam
    const hj = hit(upTo(play(9, 35, [["HJ", "raise", 2], ["BTN", "jam"]]), "HJ"));
    expect([hj.pick.source, hj.pick.stageId, hj.spotId]).toEqual(["shortnash", "25bb", "hj-open-vs-btn-jam"]);
    expect(hj.approx).toEqual([NOT_IN_35_NOTE, "유효스택 35bb → 25bb 차트"]);
    // what 35bb-2 does export stays on it
    expect(hit(upTo(play(9, 35, [["SB", "jam"]]), "BB"))).toMatchObject({ pick: { stageId: "35bb-2" }, spotId: "bb-vs-sb-jam" });
    expect(hit(upTo(play(9, 35, [["CO", "raise", 2], ["BB", "jam"]]), "CO"))).toMatchObject({ pick: { stageId: "35bb-2" }, spotId: "co-open-vs-bb-jam" });
  });

  it("has no chart for a 30–45bb first-in jam the 35bb solver left out (the 25bb calls answer a jam range of under 1%)", () => {
    for (const [bb, jammer, caller] of [[40, "CO", "BB"], [44, "CO", "BB"], [31, "UTG", "BTN"], [35, "BTN", "BB"]] as const) {
      const g = upTo(play(9, bb, [[jammer, "jam"]]), caller);
      expect(chartFor(g, g.toAct!), `${bb}bb ${caller} vs ${jammer}`).toMatchObject({ ok: false, reason: "rare", text: "이 상황은 계산된 차트가 없어요 · 솔버가 이 라인을 풀지 않았어요" });
    }
    // why: the 25bb equilibrium itself all but never jams first in
    for (const seat of ["UTG", "HJ", "CO", "BTN", "SB"]) expect(firstInJamShare(pickChart(25), seat), seat).toBeLessThan(0.01);
  });

  it("narrows a 30–45bb re-jam by the chart its call is graded on", () => {
    const btn = upTo(play(9, 35, [["HJ", "raise", 2]]), "BTN");
    // narrowing the BTN's jam: the 25bb re-jam range, the model the HJ's call of it is graded by
    const jam = hit(btn, { narrowing: true, ownRaise: 35 });
    expect([jam.pick.stageId, jam.spotId, jam.approx[0]]).toEqual(["25bb", "btn-vs-hj-open", NOT_IN_35_NOTE]);
    expect(jam.moves("88", 35)).toEqual([{ kind: "raise", to: 35, prob: 1 }]);
    // the 35bb solver jams nothing here (it 3-bets small): that is still the chart the BTN's own decision is graded on
    const own = hit(btn, { ownRaise: 35 });
    expect([own.pick.stageId, own.spotId]).toEqual(["35bb-2", "btn-vs-hj-open"]);
    expect(own.moves("88", 35).some((m) => m.to === 35)).toBe(false);
    // a 3-bet that isn't a jam, and the BB's re-jam (whose call 35bb-2 exports), stay on the solver
    expect(hit(btn, { narrowing: true, ownRaise: 7 }).pick.stageId).toBe("35bb-2");
    const bb = upTo(play(9, 35, [["CO", "raise", 2]]), "BB");
    expect(hit(bb, { narrowing: true, ownRaise: 35 })).toMatchObject({ pick: { stageId: "35bb-2" }, spotId: "bb-vs-co-open" });
  });

  it("says a line the export left out was not solved, not that it is rare", () => {
    // 100bb-2.2 exports no 4-bet jam
    const g = upTo(play(9, 100, [["UTG", "raise", 2.2], ["CO", "raise", 7], ["UTG", "jam"]]), "CO");
    expect(chartFor(g, g.toAct!)).toMatchObject({ ok: false, reason: "rare", text: "이 상황은 계산된 차트가 없어요 · 솔버가 이 라인을 풀지 않았어요" });
  });

  it("measures the effective stack against the seats that matter", () => {
    // UTG covers everyone first in; the BB's 30bb against a 100bb open is 30bb
    const stacks = [100, 100, 100, 100, 100, 100, 100, 100, 30];
    const g = play(9, 100, [["CO", "raise", 2.5]], { stacks });
    expect(effectiveStack(upTo(g, "BB"), 8)).toBe(30);
    expect(effectiveStack(upTo(g, "BTN"), 6)).toBe(100);
  });
});

describe("the probe hands", () => {
  it("BTN A5s vs a CO 2.5bb open at 100bb: the 2.2bb-open chart, 3-bet", () => {
    const h = hit(upTo(play(9, 100, [["CO", "raise", 2.5]]), "BTN"));
    expect([h.pick.stageId, h.spotId]).toEqual(["100bb-2.2", "btn-vs-co-open"]);
    expect(h.scenario.strategy.A5s["3bet"]).toBe(1);
    expect(h.confidence).toBe("high");
    expect(h.approx).toEqual([]);
  });

  it("6-handed UTG at 55bb is the LJ", () => {
    const h = hit(newGame(55, 0, fullDeck(), { seats: positionsFor(6), bbAnte: true }));
    expect([h.pick.stageId, h.spotId]).toEqual(["55bb-2.2", "rfi-lj"]);
  });

  it("CO 99 behind an LJ open and an HJ call at 55bb squeezes", () => {
    const h = hit(upTo(play(9, 55, [["LJ", "raise", 2.2], ["HJ", "call"]]), "CO"));
    expect(h.spotId).toBe("co-at-lj-open-hj-call");
    expect(h.scenario.strategy["99"].squeeze).toBe(1);
  });

  it("BB 76s against a BTN 2bb open at 20bb calls by the short-stack chart", () => {
    const h = hit(upTo(play(9, 20, [["BTN", "raise", 2]]), "BB"));
    expect([h.pick.source, h.pick.stageId, h.spotId]).toEqual(["shortnash", "20bb", "bb-vs-btn-open"]);
    expect(h.scenario.strategy["76s"].call).toBeGreaterThan(0.5);
    expect(h.confidence).toBeNull();
  });

  it("only shows a short-stack call of a first-in jam its equilibrium all but never makes (under 1%)", () => {
    // 25bb: every seat jams first in under 1% of hands
    const co25 = hit(upTo(play(9, 25, [["CO", "jam"]]), "BB"));
    expect([co25.spotId, co25.refOnly, co25.confidence]).toEqual(["call-bb-vs-co", THIN_JAM_NOTE, "low"]);
    expect(co25.confidenceNote).toBe("숏스택 25bb 균형에서 CO의 퍼스트 인 올인은 0%뿐");
    const graded = gradeVsChart(co25, "A9o", { kind: "call" }, 25);
    expect(graded).toMatchObject({ grade: "info", soft: THIN_JAM_NOTE });
    expect(chartTags(co25, graded)).toEqual(["신뢰도 낮음", THIN_JAM_NOTE]);
    // 20bb: the UTG jams 0.8%, the CO 1.8%
    expect(firstInJamShare(pickChart(20), "UTG")).toBeLessThan(0.01);
    expect(hit(upTo(play(9, 20, [["UTG", "jam"]]), "BB")).refOnly).toBe(THIN_JAM_NOTE);
    expect(firstInJamShare(pickChart(20), "CO")).toBeGreaterThan(0.01);
    const co20 = hit(upTo(play(9, 20, [["CO", "jam"]]), "BB"));
    expect([co20.refOnly, co20.confidence]).toEqual([undefined, null]);
    // 17bb and push/fold: real jam ranges, graded
    expect(hit(upTo(play(9, 17, [["UTG", "jam"]]), "BB")).refOnly).toBeUndefined();
    expect(hit(upTo(play(9, 10, [["UTG", "jam"]]), "BB")).refOnly).toBeUndefined();
  });

  it("an 11bb push and its call by the push/fold chart", () => {
    const h = hit(upTo(play(9, 11, [["CO", "jam"]]), "BB"));
    expect([h.pick.source, h.spotId]).toEqual(["nash", "call-bb-vs-co"]);
  });
});

describe("notes on the chart", () => {
  it("rates the 35bb vs-open, overcall and squeeze spots of non-blind seats low", () => {
    const h = hit(upTo(play(9, 35, [["HJ", "raise", 2]]), "BTN"));
    expect([h.pick.stageId, h.spotId, h.confidence, h.confidenceNote]).toEqual(["35bb-2", "btn-vs-hj-open", "low", COLD35_NOTE]);
    const bb = hit(upTo(play(9, 35, [["HJ", "raise", 2]]), "BB"));
    expect(bb.confidenceNote).toBeUndefined();
    // BTN behind a UTG+1 open and an HJ call: 높음 in the data, the same cold4 "none" tree
    const sq = hit(upTo(play(9, 35, [["UTG+1", "raise", 2], ["HJ", "call"]]), "BTN"));
    expect([sq.spotId, sq.scenario.kind, sq.confidence, sq.confidenceNote]).toEqual(["btn-at-utgp1-open-hj-call", "squeeze", "low", COLD35_SQUEEZE_NOTE]);
    // the SB keeps the data's rating, and 55bb is untouched
    const sb = hit(upTo(play(9, 35, [["UTG+1", "raise", 2], ["BTN", "call"]]), "SB"));
    expect([sb.spotId, sb.confidence, sb.confidenceNote]).toEqual(["sb-at-utgp1-open-btn-call", "high", undefined]);
    expect(hit(upTo(play(9, 55, [["LJ", "raise", 2.2], ["CO", "call"]]), "BTN")).confidenceNote).toBeUndefined();
  });

  it("notes any table but 9-handed, and never says 근사 twice", () => {
    expect(hit(upTo(newGame(100, 0, fullDeck(), { seats: positionsFor(3), bbAnte: true }), "BTN")).approx).toEqual(["3인 테이블 근사"]);
    expect(hit(newGame(55, 0, fullDeck(), { seats: positionsFor(6), bbAnte: true })).approx).toEqual(["6인 테이블 근사"]);
    expect(hit(newGame(100, 0, fullDeck(), { seats: positionsFor(10), bbAnte: true })).approx).toEqual(["10인 테이블 근사"]);
    expect(hit(newGame(100, 0, fullDeck(), { seats: positionsFor(9), bbAnte: true })).approx).toEqual([]);
    const g10 = upTo(play(10, 70, [["CO", "raise", 3]]), "BTN");
    const h = hit(g10);
    const tags = chartTags(h, gradeVsChart(h, "72o", { kind: "fold" }, legal(g10, g10.toAct!).maxRaiseTo));
    expect(tags.filter((t) => t.includes("근사"))).toEqual(["10인 테이블 근사"]);
    expect(tags.some((t) => t.startsWith("근사:"))).toBe(false);
  });

  it("says where it only approximates: the stack, the open's size, unequal stacks, no ante", () => {
    const h = hit(upTo(play(9, 70, [["CO", "raise", 3]]), "BTN"));
    expect(h.approx).toEqual(["유효스택 70bb → 55bb 차트", "오픈 3bb · 차트 2.2bb"]);
    expect(h.sizeNote).toBe("오픈 3bb · 차트 2.2bb");
    expect(h.sizeRatio).toBeCloseTo(3 / 2.2);
    const uneven = hit(upTo(play(9, 100, [["CO", "raise", 2.2]], { stacks: [100, 100, 100, 100, 100, 100, 160, 100, 100] }), "BTN"));
    expect(uneven.approx).toContain("스택이 달라 근사");
    const noAnte = hit(play(9, 100, [], { ante: false }));
    expect(noAnte.refOnly).toBe("앤티 없는 판이라 참고만");
    expect(chartFor(newGame(100, 0, fullDeck()), 0, { stackUnknown: true })).toMatchObject({ ok: true, approx: ["스택 모름 · 100bb로 가정"] });
  });

  it("has no chart heads-up deep, for another seat's limp, or for a 55bb first-in jam", () => {
    expect(chartFor(newGame(100, 0, fullDeck(), { seats: positionsFor(2), bbAnte: true }), 0)).toMatchObject({ ok: false, reason: "headsUp", text: "이 상황은 계산된 차트가 없어요 · 헤즈업 딥스택" });
    expect(chartFor(upTo(play(9, 100, [["UTG", "call"], ["CO", "raise", 3]]), "BB"), 8)).toMatchObject({ ok: false, reason: "limp" });
    expect(chartFor(upTo(play(9, 55, [["CO", "jam"]]), "BB"), 8)).toMatchObject({ ok: false, reason: "offTree" });
  });

  it("never builds the full solver set", () => {
    expect(solverSetDefBuilt()).toBe(false);
  });
});

// Last: it builds the full set to compare.
describe("one spot at a time", () => {
  it("gives the same Scenario as the full set for a sample of every kind", () => {
    const set = getSet("solver");
    for (const st of PREFLOP_STAGES) {
      const kinds = new Set<string>();
      for (const sc of st.scenarios) {
        if (kinds.has(sc.kind) && !sc.reachFrom) continue;
        kinds.add(sc.kind);
        const full = set.stages.find((x) => x.id === st.id)!.scenarios.find((x) => x.id === `solver/${st.id}/${sc.id}`)!;
        expect(solverSpot(st.id, sc.id)!.scenario, `${st.id}/${sc.id}`).toEqual(full);
      }
    }
  });
});
