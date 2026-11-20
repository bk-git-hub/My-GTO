import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { getSet } from "../data/charts";
import { act, callPrice, CASH_TABLE, heroNet, legal, newGame, pot, winnablePot } from "./engine";
import { handFeatures } from "./handInfo";
import { preflopDecision, STAGE_STACK, type PlayMode, type PreflopSpot } from "./policy";
import { analyse, heroAct, heroMoves, startHand, type PlayState } from "./table";
import { fullWeights } from "./analysis";

/** Chips on the table: stacks plus the pot while the hand runs, stacks only once it's paid out. */
const totalChips = (g: ReturnType<typeof newGame>) => g.players.reduce((s, p) => s + p.stack, 0) + (g.done ? 0 : pot(g));

describe("engine", () => {
  it("posts blinds and BB ante, starts with UTG", () => {
    const g = newGame(100, 0);
    expect(pot(g)).toBeCloseTo(2.5);
    expect(g.toAct).toBe(0);
    expect(g.players[8].stack).toBeCloseTo(98);
    expect(g.players[7].stack).toBeCloseTo(99.5);
  });

  it("everyone folds to the BB: BB wins blinds + ante", () => {
    let g = newGame(100, 0);
    for (let i = 0; i < 8; i++) g = act(g, "fold");
    expect(g.done).toBe(true);
    expect(g.players[8].stack).toBeCloseTo(100.5); // 98 + 2.5
  });

  it("all-in preflop runs out the board and keeps chips constant", () => {
    let g = newGame(10, 0);
    expect(totalChips(g)).toBeCloseTo(90);
    g = act(g, "raise", 10); // UTG shoves
    for (let i = 1; i < 8; i++) g = act(g, "fold");
    g = act(g, "call"); // BB calls (has 9 behind after the ante)
    expect(g.done).toBe(true);
    expect(g.board).toHaveLength(5);
    expect(totalChips(g)).toBeCloseTo(90);
  });

  it("prices a call by the pot I can win: a covering all-in's chips beyond my stack are not mine", () => {
    // 9-handed, the BTN has 50bb, the BB 10bb: the BTN jams, the rest fold to the BB
    let g = newGame(100, 8, undefined, undefined, [100, 100, 100, 100, 100, 100, 50, 100, 10]);
    for (let i = 0; i < 6; i++) g = act(g, "fold");
    g = act(g, "raise", 50);
    g = act(g, "fold"); // SB
    expect(pot(g)).toBeCloseTo(52.5); // 1 ante + 0.5 + 50 + 1
    // the BB can put in 9 more (10 less the ante): 9 of the BTN's 50 are contested
    expect(winnablePot(g, 8)).toBeCloseTo(11.5);
    expect(callPrice(g, 8)).toBeCloseTo(8 / 19.5, 9); // 41%, not 8 / 60.5 = 13%
    // with equal stacks the BB's ante still leaves the jammer's last bb uncontested
    let eq = newGame(18, 8);
    for (let i = 0; i < 5; i++) eq = act(eq, "fold");
    eq = act(eq, "raise", 18); // CO
    eq = act(eq, "fold");
    eq = act(eq, "fold");
    expect(winnablePot(eq, 8)).toBeCloseTo(19.5);
    expect(callPrice(eq, 8)).toBeCloseTo(16 / 35.5, 9);
  });

  it("counts side pots between others above my stack out of the price, and nothing when I cover", () => {
    // UTG 20bb jams, HJ (UTG+1 here) 60bb calls, the BB with 100bb decides: it covers both, the whole pot is its
    let g = newGame(100, 8, undefined, undefined, [20, 60, 100, 100, 100, 100, 100, 100, 100]);
    g = act(g, "raise", 20);
    g = act(g, "raise", 60); // UTG+1 shoves over it
    for (let i = 0; i < 6; i++) g = act(g, "fold");
    expect(winnablePot(g, 8)).toBeCloseTo(pot(g));
    // a 30bb BB in the same spot plays for 30 of each stack only: the 20, 30 of the 60, the blinds and the ante
    let s = newGame(100, 8, undefined, undefined, [20, 60, 100, 100, 100, 100, 100, 100, 30]);
    s = act(s, "raise", 20);
    s = act(s, "raise", 60);
    for (let i = 0; i < 6; i++) s = act(s, "fold");
    expect(pot(s)).toBeCloseTo(1 + 20 + 60 + 0.5 + 1);
    expect(winnablePot(s, 8)).toBeCloseTo(1 + 20 + 29 + 0.5 + 1); // the BB's own total after a call is 29 (30 less the ante)
    // nothing to call, no price
    let w = newGame(100, 8);
    for (let i = 0; i < 7; i++) w = act(w, "call");
    expect(callPrice(w, 8)).toBeNull();
    expect(winnablePot(w, 8)).toBeCloseTo(pot(w));
  });
});

describe("hand features", () => {
  const f = (h: string, b: string) => handFeatures(parseCards(h), parseCards(b));
  it("classifies common holdings", () => {
    expect(f("AhKd", "Ks7c2d").tier).toBe(3); // top pair top kicker
    expect(f("Kh5d", "Ks7c2d").tier).toBe(2); // top pair weak kicker
    expect(f("7h7d", "Ks7c2d").tier).toBe(4); // set
    expect(f("AhQh", "Kh7h2d").tier).toBe(1.5); // nut flush draw
    expect(f("9h8h", "Th7h2d").tier).toBe(2.5); // flush + straight draw
    expect(f("9c8d", "Th7s2d").straightDraw).toBe("oesd");
    expect(f("QcJd", "8h4s2d").tier).toBe(0);
  });
});

describe("cash table", () => {
  it("6-max posts blinds only, starts with UTG, and the SB acts first postflop", () => {
    let g = newGame(100, 0, undefined, CASH_TABLE);
    expect(g.players.map((p) => p.seat)).toEqual(["UTG", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(pot(g)).toBeCloseTo(1.5);
    expect(g.dead).toBe(0);
    expect(g.toAct).toBe(0);
    for (let i = 0; i < 3; i++) g = act(g, "fold"); // UTG, HJ, CO
    g = act(g, "raise", 2.5); // BTN opens
    g = act(g, "call"); // SB
    g = act(g, "call"); // BB
    expect(g.street).toBe("flop");
    expect(pot(g)).toBeCloseTo(7.5);
    expect(g.toAct).toBe(4);
  });

  it("everyone folds to the BB: BB wins the blinds", () => {
    let g = newGame(100, 0, undefined, CASH_TABLE);
    for (let i = 0; i < 5; i++) g = act(g, "fold");
    expect(g.done).toBe(true);
    expect(g.players[5].stack).toBeCloseTo(100.5);
  });

  it("leaves a call of an all-in ungraded (the 6-max chart has no call chart), its call EV on the covered pot", () => {
    // The BB with 40bb against a 100bb UTG jam: 40 of the UTG's chips, the SB's 0.5 and its own 1 to win
    let g = newGame(100, 5, undefined, CASH_TABLE, [100, 100, 100, 100, 100, 40]);
    g = act(g, "raise", 100);
    for (let i = 0; i < 4; i++) g = act(g, "fold");
    const s: PlayState = { mode: "cash", stageId: "100bb", heroIdx: 5, game: g, ranges: g.players.map(() => fullWeights()), decisions: [], botNotes: {} };
    for (const kind of ["call", "fold"] as const) {
      const d = analyse(s, { key: kind, label: kind, kind });
      expect([d.grade, d.sidePot, d.toCall]).toEqual(["info", 60, 39]);
      expect(d.reqEquity).toBeCloseTo(39 / (41.5 + 39), 9);
      expect(d.summary).toContain(", 내 스택을 넘는 60bb 제외)");
    }
  });
});

describe("full hands with bots", () => {
  it("plays 450 random hands to the end without losing chips, the bots on the computed charts", () => {
    const pubTitles = new Set(getSet("pub").stages.flatMap((st) => st.scenarios.map((sc) => sc.title)));
    const runs: [PlayMode, string][] = [["pub", "deep"], ["pub", "mid"], ["pub", "35bb"], ["pub", "short"], ["pub", "push"], ["cash", "100bb"]];
    for (const [mode, stage] of runs) {
      for (let n = 0; n < 75; n++) {
        let s = startHand(mode, stage);
        expect(s.game.startStack).toBe(STAGE_STACK[stage]);
        const start = s.game.startStack * s.game.players.length;
        let guard = 0;
        while (!s.game.done && guard++ < 60) {
          const moves = heroMoves(s);
          expect(moves.length).toBeGreaterThan(0);
          // now and then a min-raise, which no chart makes, so the bots' fallback rules get played too
          const L = legal(s.game, s.heroIdx);
          const pick = Math.random() < 0.15 && L.canRaise ? { key: `raise:${L.minRaiseTo}`, label: `레이즈 ${L.minRaiseTo}`, kind: "raise" as const, to: L.minRaiseTo } : moves[Math.floor(Math.random() * moves.length)];
          s = heroAct(s, pick);
        }
        expect(s.game.done).toBe(true);
        const chips = s.game.players.reduce((a, p) => a + p.stack, 0);
        expect(chips).toBeCloseTo(start, 1);
        expect(Number.isFinite(heroNet(s.game))).toBe(true);
        for (const d of s.decisions) expect(d.options.length).toBeGreaterThan(0);
        for (const note of Object.values(s.botNotes)) expect(mode === "cash" || !pubTitles.has(note), note).toBe(true);
        if (mode === "pub")
          for (const d of s.decisions.filter((x) => x.street === "preflop")) expect(d.chartInfo, d.chosenLabel).toBeDefined();
      }
    }
  }, 120000);

  it("opens the bots at the chart's sizes", () => {
    // 100bb: the 3bb-open stage; 55bb: 2.2bb
    for (const [stage, size] of [["deep", 3], ["mid", 2.2]] as const) {
      let seen = false;
      for (let n = 0; n < 40 && !seen; n++) {
        const s = startHand("pub", stage, 8);
        const open = s.game.log.find((e) => e.kind === "raise" && e.seat !== "SB" && !e.allIn);
        if (open && s.game.log.filter((e) => e.kind === "raise").length === 1) {
          expect(open.amount).toBe(size);
          seen = true;
        }
      }
      expect(seen).toBe(true);
    }
  });
});

describe("cash preflop policy", () => {
  const spot = (o: Partial<PreflopSpot>): PreflopSpot => ({
    mode: "cash", stageId: "100bb", seat: "BTN", raises: 1, openerSeat: "CO", lastRaiserSeat: "CO",
    iAmOpener: false, facingAllIn: false, currentBet: 2.5, myBet: 0, myStack: 100, limpers: 0, ...o,
  });

  it("uses the 6-max charts and sizes", () => {
    const rfi = preflopDecision(spot({ seat: "CO", raises: 0, openerSeat: undefined, lastRaiserSeat: undefined, currentBet: 1 }));
    expect(rfi.label).toBe("CO 오픈");
    expect(rfi.moves("AA")).toEqual([{ kind: "raise", to: 2.5, prob: 1 }]);
    expect(preflopDecision(spot({})).label).toBe("BTN vs CO 오픈");
    const bb = preflopDecision(spot({ seat: "BB", openerSeat: "BTN", lastRaiserSeat: "BTN", myBet: 1, myStack: 99 }));
    expect(bb.moves("AA").find((m) => m.kind === "raise")?.to).toBe(11);
    const vs3 = preflopDecision(spot({ seat: "CO", raises: 2, iAmOpener: true, lastRaiserSeat: "BTN", currentBet: 7.5, myBet: 2.5, myStack: 97.5 }));
    expect(vs3.label).toBe("오픈 vs 3벳");
  });

  it("borrows a nearby chart for uncharted openers, but never a much wider one", () => {
    // BTN vs HJ: no chart, use BTN vs UTG (one seat tighter) rather than BTN vs CO.
    expect(preflopDecision(spot({ seat: "BTN", openerSeat: "HJ", lastRaiserSeat: "HJ" })).label).toBe("BTN vs UTG 오픈");
    expect(preflopDecision(spot({ seat: "BB", openerSeat: "HJ", lastRaiserSeat: "HJ", myBet: 1, myStack: 99 })).label).toBe("BB vs HJ 오픈");
    // SB vs UTG: the only SB chart is vs BTN, far too wide; fall back to the tight default.
    expect(preflopDecision(spot({ seat: "SB", openerSeat: "UTG", lastRaiserSeat: "UTG", myBet: 0.5, myStack: 99.5 })).scenario).toBeUndefined();
  });
});
