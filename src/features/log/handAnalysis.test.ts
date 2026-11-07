import { describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { equityVsHand } from "../../poker/equity";
import { emptyHand, tableOf, type LoggedHand } from "./handLog";
import { analyseHand, deckFor, equityKnown, parseCardText, stageFor, SUIT_GUESS_NOTE } from "./handAnalysis";
import { replay, skipTo, type LogStep } from "./recorder";

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
    expect(parseCardText("Ax", 2).error).toMatch(/무늬/);
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
    expect(SUIT_GUESS_NOTE).toBe("무늬를 추정한 카드가 있어 플러시 관련 승률은 근사예요");
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
