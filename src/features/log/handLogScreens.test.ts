import { afterEach, describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { actionLine, emptyHand, freshHand, handLogStore, localDay, quickCopy, quickSaveAction, tableOf, tidyHand, unfinished, withBoard, withHole, type LoggedHand } from "./handLog";
import { levelStage, preSteps } from "./quickPre";

const initial = handLogStore.get();
afterEach(() => handLogStore.set(initial));
const hand = (over: Partial<LoggedHand> = {}): LoggedHand => ({ ...emptyHand(6), ...over });
const AsTs = parseCards("AsTs");

describe("what the screens need from a hand", () => {
  it("calls a hand 작성 중 until its result, the end of the action or the subject's fold", () => {
    expect(unfinished(hand({ hole: AsTs }))).toBe(true);
    expect(unfinished(hand({ seat: "BTN" }))).toBe(true);
    expect(unfinished(hand({ seat: "BTN", hole: AsTs }))).toBe(true);
    expect(unfinished(hand({ seat: "BTN", hole: AsTs, result: "lose" }))).toBe(false);
    expect(unfinished(hand({ seat: "BTN", hole: AsTs, net: 1200 }))).toBe(false);
    // folds to the BB: over
    const walk = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB"].map((s) => ({ s, k: "fold" as const }));
    expect(unfinished(hand({ seat: "BB", hole: AsTs, steps: walk }))).toBe(false);
    // I folded: nothing more of mine to write
    expect(unfinished(hand({ seat: "UTG", hole: AsTs, steps: [{ s: "UTG", k: "fold" }] }))).toBe(false);
  });

  it("puts the preflop in one line, from the quick block or from the table", () => {
    const o = hand({ kind: "other", seat: "CO", hole: AsTs, quickPre: { stage: "mid", pinned: true, action: "open", openBb: 2.5 } });
    expect(actionLine(o)).toBe("미들 · CO 오픈 2.5bb");
    const onTable = hand({ seat: "BB", hole: AsTs, stack: 32000, steps: preSteps(tableOf(hand({ seat: "BB", stack: 32000 })), { action: "call", openBb: 2.5, openerSeat: "CO" }) });
    expect(onTable.steps.length).toBeGreaterThan(0);
    expect(actionLine(onTable)).toBe("CO 2.5bb 오픈 → 콜");
    expect(actionLine(hand({ seat: "BB", hole: AsTs }))).toBe("");
  });

  it("starts a new hand at the level today's start time says (marked as estimated), else the last one", () => {
    const at = new Date(2026, 10, 7, 22, 5).getTime();
    handLogStore.set({ ...initial, hands: [], lastLevel: 4, startClock: { day: localDay(at), clock: "19:00" } });
    expect(freshHand("mine", at)).toMatchObject({ level: 9, levelGuess: true });
    expect(freshHand("other", at)).toMatchObject({ level: 9, levelGuess: true, kind: "other" });
    // before the start, or on another day: the last level, not estimated
    const before = freshHand("mine", new Date(2026, 10, 7, 18, 0).getTime());
    expect(before.level).toBe(4);
    expect("levelGuess" in before).toBe(false);
    handLogStore.set({ ...initial, hands: [], lastLevel: 4 });
    expect(freshHand("mine", at).level).toBe(4);
  });

  it("marks guessed hole cards with what was remembered, and clears the marks for typed cards", () => {
    const g = withHole(hand(), AsTs, true, "suited");
    expect(g).toMatchObject({ hole: AsTs, guess: { hole: true }, holeKind: "suited" });
    const exact = withHole(g, parseCards("AhTh"));
    expect("guess" in exact || "holeKind" in exact).toBe(false);
    // one card is no guessed hand
    expect("guess" in withHole(g, parseCards("As"), true, "suited")).toBe(false);
    // a pair keeps no suitedness
    expect("holeKind" in tidyHand(withHole(hand(), parseCards("7s7h"), true, "suited"))).toBe(false);
  });

  it("marks guessed board cards by index, and unmarks the ones typed exactly", () => {
    const flop = withBoard(hand({ hole: AsTs }), parseCards("Kh9h2d"), 0, true);
    expect(flop.guess).toEqual({ board: [0, 1, 2] });
    const turn = withBoard(flop, [...flop.board, ...parseCards("6c")], 3);
    expect(turn.guess).toEqual({ board: [0, 1, 2] });
    // fixing the second flop card exactly unmarks it alone
    const fixed = withBoard(turn, [flop.board[0], parseCards("9s")[0], flop.board[2], ...turn.board.slice(3)], 1);
    expect(fixed.guess).toEqual({ board: [0, 2] });
    // the hole marks are left alone
    expect(withBoard(withHole(hand(), AsTs, true, "suited"), parseCards("Kh9h2d"), 0, true).guess).toEqual({ hole: true, board: [0, 1, 2] });
  });

  it("keeps the guessed cards on file with their marks while the card field is mid-edit", () => {
    const stored = withHole(hand({ id: "s1", seat: "BTN" }), AsTs, true, "suited");
    const shown = { ...withHole(stored, []), note: "BB 콜" };
    expect(quickSaveAction(stored, shown, false)).toBe("save");
    expect(quickCopy(stored, shown, false)).toMatchObject({ hole: AsTs, guess: { hole: true }, holeKind: "suited", note: "BB 콜" });
    // exact cards on file stay unmarked
    const exact = hand({ id: "s2", hole: parseCards("AdTd") });
    const copy = quickCopy(exact, { ...exact, hole: [], note: "x" }, false);
    expect(copy.hole).toEqual(parseCards("AdTd"));
    expect("guess" in copy).toBe(false);
  });

  it("gives each level the stage its average stack usually plays at", () => {
    expect([1, 5, 6, 12, 13, 20, 21, 30].map(levelStage)).toEqual(["deep", "deep", "mid", "mid", "short", "short", "push", "push"]);
    expect(levelStage(null)).toBeNull();
    expect(levelStage(0)).toBeNull();
  });
});
