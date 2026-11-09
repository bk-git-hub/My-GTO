import { describe, expect, it } from "vitest";
import { pot } from "../../play/engine";
import { emptyHand, handFacts, tableOf } from "./handLog";
import { amountLabel, applyStep, replay, sizeOptions, skipTo, streetLines, undoEcho, undoPartText, undoParts, undoSteps, upcoming, type LogStep, type TableInput } from "./recorder";

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
  it("keeps a bet typed in chips exact through the bb round trip (5,000 at 800/1600, not 5,008)", () => {
    // 5,000 / 1,600 = 3.125bb; rounding bb to two decimals used to turn it into 3.13bb = 5,008 chips.
    for (const [bbChips, chips] of [[1600, 5000], [1200, 5000], [1600, 3300], [2400, 7700], [600, 1850]]) {
      const t = table({ heroSeat: "BB", heroStack: 40 });
      const steps = record(t, [["CO", "raise", chips / bbChips], ["BB", "call"]]);
      const { game } = replay(t, steps);
      const chipsLabel = (x: number) => amountLabel(x, bbChips);
      expect(streetLines(game, chipsLabel)[0].actions).toEqual([`CO 오픈 ${chips.toLocaleString()}`, `BB(나) 콜 ${chips.toLocaleString()}`]);
    }
  });

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

describe("undoEcho: what one tap of 되돌리기 takes back", () => {
  /** The echo for steps, after checking it covers exactly the steps undoSteps drops. */
  const echo = (t: TableInput, steps: LogStep[], fmt = bb, tags?: Parameters<typeof undoEcho>[3]) => {
    const { game, applied } = replay(t, steps);
    expect(applied).toBe(steps.length);
    return undoEcho(game, steps, fmt, tags);
  };
  /** The same steps typed one by one (no seats skipped). */
  const byHand = (steps: LogStep[]): LogStep[] => steps.map(({ s, k, to }) => (to === undefined ? { s, k } : { s, k, to }));

  it("has nothing to say before the first action", () => {
    expect(echo(table(), [])).toBeNull();
  });

  it("names a single action, as the seat and the action word", () => {
    const t = table();
    expect(echo(t, [{ s: "UTG", k: "fold" }])).toBe("UTG 폴드");
    expect(echo(t, [{ s: "UTG", k: "fold" }, { s: "UTG+1", k: "fold" }])).toBe("UTG+1 폴드"); // typed one by one: one at a time
    expect(echo(t, [{ s: "UTG", k: "call" }])).toBe("UTG 림프 1bb");
  });

  it("gives a bet or raise its word and amount, in chips when the blinds are known", () => {
    const t = table();
    const open = byHand(record(t, [["CO", "raise", 2.5]]));
    expect(echo(t, open)).toBe("CO 오픈 2.5bb");
    expect(echo(t, open, (x) => amountLabel(x, 1600))).toBe("CO 오픈 4,000");
    expect(echo(t, [...open, { s: "BTN", k: "raise", to: 7.5 }])).toBe("BTN 3벳 7.5bb");
    const short = table({ heroSeat: "BTN", stacks: { CO: 8 } });
    expect(echo(short, byHand(record(short, [["CO", "raise", 8]])))).toBe("CO 오픈 8bb 올인");
  });

  it("puts the seats skipped before an action together with it: one tap takes them all back", () => {
    const t = table();
    const steps = record(t, [["CO", "raise", 2.5]]); // UTG..HJ folded by tapping CO
    expect(echo(t, steps)).toBe("UTG~HJ 5명 폴드 · CO 오픈 2.5bb");
    expect(undoSteps(steps)).toEqual([]);
  });

  it("counts a batch of folds filled in by 나머지 폴드 or a tapped seat", () => {
    const t = table();
    const open = record(t, [["CO", "raise", 2.5]]);
    const two = [...open, ...skipTo(replay(t, open).game, "BB")];
    expect(echo(t, two)).toBe("BTN, SB 폴드");
    const utg = record(t, [["UTG", "raise", 2.5]]);
    const seven = [...utg, ...skipTo(replay(t, utg).game, "BB")];
    expect(echo(t, seven)).toBe("UTG+1~SB 7명 폴드");
    // A fold of mine right after the skipped seats goes back with them: one run of folds.
    expect(echo(t, [...two, { s: "BB", k: "fold" }])).toBe("BTN~BB(나) 3명 폴드");
  });

  it("names the street when the undo goes back over the end of a street", () => {
    const t = table();
    const pre = record(t, [["CO", "raise", 2.5], ["SB", "call"], ["BB", "call"]]);
    expect(replay(t, pre).game.street).toBe("flop");
    expect(echo(t, pre)).toBe("프리플랍 BB(나) 콜 2.5bb");
    // Checks filled in on two streets (CO closing the flop, SB on the turn): one tap takes both back.
    const flop: LogStep[] = [...pre, { s: "SB", k: "check" }, { s: "BB", k: "check" }];
    const across: LogStep[] = [...flop, { s: "CO", k: "check", a: 1 }, { s: "SB", k: "check", a: 1 }];
    expect(replay(t, across).game.street).toBe("turn");
    expect(echo(t, across)).toBe("플랍 CO 체크 · 턴 SB 체크");
    expect(undoSteps(across)).toEqual(flop);
  });

  it("speaks of the last street of a finished hand without naming it", () => {
    const t = table({ heroSeat: "BTN", stacks: { CO: 8 } });
    const all = record(t, [["CO", "raise", 8], ["BTN", "call"], ["BB", "fold"]]);
    expect(replay(t, all).game.done).toBe(true);
    expect(echo(t, all)).toBe("SB, BB 폴드");
  });

  it("gives each run a shorter form for a narrow pill: the count for a run of seats, 프리 for the preflop", () => {
    const t = table();
    const steps = record(t, [["CO", "raise", 2.5]]);
    const parts = undoParts(replay(t, steps).game, steps, bb);
    expect(parts.map((p) => undoPartText(p))).toEqual(["UTG~HJ 5명 폴드", "CO 오픈 2.5bb"]);
    expect(parts.map((p) => undoPartText(p, { count: true }))).toEqual(["5명 폴드", "CO 오픈 2.5bb"]);
    expect(parts.map((p) => p.n)).toEqual([5, 1]);
    const open = record(t, [["CO", "raise", 2.5]]);
    const two = [...open, ...skipTo(replay(t, open).game, "BB")];
    expect(undoParts(replay(t, two).game, two, bb).map((p) => [undoPartText(p), undoPartText(p, { count: true })])).toEqual([["BTN, SB 폴드", "2명 폴드"]]);
    const pre = record(t, [["CO", "raise", 2.5], ["SB", "call"], ["BB", "call"]]);
    const [last] = undoParts(replay(t, pre).game, pre, bb);
    expect(undoPartText(last)).toBe("프리플랍 BB(나) 콜 2.5bb");
    expect(undoPartText(last, { count: true, short: true })).toBe("프리 BB(나) 콜 2.5bb");
    expect(undoParts(replay(t, []).game, [], bb)).toEqual([]);
  });

  it("tags the seats like the action lines in another player's hand", () => {
    const t = table({ heroSeat: "CO" });
    const tags = { hero: "(상대)", seats: { BB: "(나)" } };
    const steps = byHand(record(t, [["CO", "raise", 2.5], ["BB", "call"]]));
    expect(echo(t, steps.slice(0, 6), bb, tags)).toBe("CO(상대) 오픈 2.5bb"); // UTG..HJ fold, CO opens
    expect(echo(t, steps, bb, tags)).toBe("프리플랍 BB(나) 콜 2.5bb");
  });
});
