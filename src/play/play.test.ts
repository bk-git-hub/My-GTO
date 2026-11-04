import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { act, CASH_TABLE, heroNet, newGame, pot } from "./engine";
import { handFeatures } from "./handInfo";
import { preflopDecision, type PlayMode, type PreflopSpot } from "./policy";
import { heroAct, heroMoves, startHand } from "./table";

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
});

describe("full hands with bots", () => {
  it("plays 375 random hands to the end without losing chips", () => {
    const runs: [PlayMode, string][] = [["pub", "deep"], ["pub", "mid"], ["pub", "short"], ["pub", "push"], ["cash", "100bb"]];
    for (const [mode, stage] of runs) {
      for (let n = 0; n < 75; n++) {
        let s = startHand(mode, stage);
        const start = s.game.startStack * s.game.players.length;
        let guard = 0;
        while (!s.game.done && guard++ < 60) {
          const moves = heroMoves(s);
          expect(moves.length).toBeGreaterThan(0);
          s = heroAct(s, moves[Math.floor(Math.random() * moves.length)]);
        }
        expect(s.game.done).toBe(true);
        const chips = s.game.players.reduce((a, p) => a + p.stack, 0);
        expect(chips).toBeCloseTo(start, 1);
        expect(Number.isFinite(heroNet(s.game))).toBe(true);
        for (const d of s.decisions) expect(d.options.length).toBeGreaterThan(0);
      }
    }
  }, 60000);
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
