import { describe, expect, it } from "vitest";
import { pot } from "../../play/engine";
import { emptyHand, handFacts, tableOf } from "./handLog";
import { amountLabel, applyStep, replay, sizeOptions, skipTo, streetLines, undoSteps, upcoming, type LogStep, type TableInput } from "./recorder";

const table = (over: Partial<TableInput> = {}): TableInput => ({ heroSeat: "BB", heroStack: 40, stacks: {}, ...over });
const bb = (x: number) => amountLabel(x, null);

/** Record like the UI does: skip to a seat, then act. */
function record(t: TableInput, moves: [string, LogStep["k"], number?][]): LogStep[] {
  let steps: LogStep[] = [];
  for (const [seat, k, to] of moves) {
    const { game } = replay(t, steps);
    steps = [...steps, ...skipTo(game, seat), { s: seat, k, ...(to !== undefined ? { to } : {}) }];
    expect(replay(t, steps).applied, `${seat} ${k}`).toBe(steps.length);
  }
  return steps;
}

describe("action recorder", () => {
  it("CO opens, BTN 3-bets, BB (me) calls, CO folds", () => {
    const t = table();
    const steps = record(t, [["CO", "raise", 2.5], ["BTN", "raise", 7.5], ["BB", "call"], ["CO", "fold"]]);
    const { game } = replay(t, steps);
    expect(game.street).toBe("flop");
    // ante 1 + SB 0.5 dead + CO 2.5 dead + BTN 7.5 + BB 7.5
    expect(pot(game)).toBeCloseTo(19);
    expect(game.players[game.toAct!].seat).toBe("BB"); // BB first to act postflop with the SB out
    const pre = streetLines(game, bb)[0];
    expect(pre.actions).toEqual(["CO 오픈 2.5bb", "BTN 3벳 7.5bb", "BB(나) 콜 7.5bb", "CO 폴드"]);
  });

  it("UTG (me) opens and CO, SB, BB call: four players see the flop, SB acts first", () => {
    const t = table({ heroSeat: "UTG" });
    const steps = record(t, [["UTG", "raise", 2.5], ["CO", "call"], ["SB", "call"], ["BB", "call"]]);
    const { game } = replay(t, steps);
    expect(game.street).toBe("flop");
    expect(pot(game)).toBeCloseTo(11); // 4 × 2.5 + ante
    expect(upcoming(game)).toEqual(["SB", "BB", "UTG", "CO"]);
    // Flop: checks to me, I bet half pot, CO calls, rest fold.
    const flop = [...steps, ...skipTo(game, "UTG")];
    const g2 = replay(t, flop).game;
    expect(sizeOptions(g2).map((o) => o.label)).toEqual(["33%", "50%", "75%", "팟"]);
    const after = record(t, [["UTG", "raise", 2.5], ["CO", "call"], ["SB", "call"], ["BB", "call"], ["UTG", "raise", 5.5], ["CO", "call"], ["SB", "fold"], ["BB", "fold"]]);
    const g3 = replay(t, after).game;
    expect(g3.street).toBe("turn");
    expect(streetLines(g3, bb)[1].actions).toEqual(["SB 체크", "BB 체크", "UTG(나) 벳 5.5bb", "CO 콜 5.5bb", "SB 폴드", "BB 폴드"]);
  });

  it("handles a short stack's all-in and per-seat stacks", () => {
    const t = table({ heroSeat: "BTN", stacks: { CO: 8 } });
    const steps = record(t, [["CO", "raise", 8], ["BTN", "call"]]);
    expect(upcoming(replay(t, steps).game)).toEqual(["SB", "BB"]); // the blinds still act
    const all = record(t, [["CO", "raise", 8], ["BTN", "call"], ["BB", "fold"]]);
    const { game } = replay(t, all);
    expect(streetLines(game, bb)[0].actions).toEqual(["CO 오픈 8bb 올인", "BTN(나) 콜 8bb"]);
    expect(game.done).toBe(true); // all-in and called, the board runs out
  });

  it("undo removes the last action and the seats skipped before it", () => {
    const t = table();
    const steps = record(t, [["CO", "raise", 2.5]]);
    expect(steps.filter((s) => s.a).length).toBe(5); // UTG..HJ folded automatically
    expect(undoSteps(steps)).toEqual([]);
    const withSkip = [...steps, ...skipTo(replay(t, steps).game, "BB")];
    expect(undoSteps(withSkip)).toEqual(steps);
  });

  it("stops replaying at a step that no longer fits", () => {
    const t = table();
    const steps = record(t, [["CO", "raise", 2.5], ["BB", "call"]]);
    // BB was not to act first: the replay stops right there.
    expect(applyStep(replay(t, []).game, { s: "BB", k: "call" })).toBeNull();
    expect(replay(table({ heroSeat: "CO" }), steps).applied).toBe(steps.length);
  });

  it("puts the recorded streets into the coach facts", () => {
    const h = { ...emptyHand(6), seat: "BB", stack: 32000 }; // 40bb at 400/800
    h.steps = record(tableOf(h), [["CO", "raise", 2.5], ["BTN", "raise", 7.5], ["BB", "call"], ["CO", "fold"]]);
    const f = handFacts(h);
    expect(f).toContain("CO 오픈 2,000(2.5bb)");
    expect(f).toContain("BTN 3벳 6,000(7.5bb)");
    expect(f).toContain("→ 팟 15,200(19bb)");
  });
});
