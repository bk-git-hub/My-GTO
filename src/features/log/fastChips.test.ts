import { describe, expect, it } from "vitest";
import { makeCard, parseCards, RANKS } from "../../poker/cards";
import {
  amountValue,
  bbText1,
  boardCards,
  canAddRank,
  chipSeries,
  chipsShort,
  convertText,
  draftResult,
  inBb,
  levelChip,
  marksOf,
  missedOf,
  netBoth,
  postedBy,
  sessionMoney,
  seriesAt,
  signedText,
  toChips,
  typeAmount,
  unitText,
  walkWin,
  type Unit,
} from "./fastChips";
import { emptyHand, type LoggedHand } from "./handLog";
import { holeFromRanks } from "./suitGuess";

const R = (k: string) => RANKS.indexOf(k);
const M = "−";
/** Types the keys one by one into an empty amount. */
const typeAll = (keys: string[], unit: Unit) => keys.reduce((t, k) => typeAmount(t, k, unit), "");

describe("빠른 기록 chips: what a seat posts", () => {
  it("is the small blind for the SB, the big blind plus the BB ante for the BB, nothing elsewhere", () => {
    // Lv5 300/600, BB ante 600
    expect(["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"].map((s) => postedBy(s, 5))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(postedBy("SB", 5)).toBe(300);
    expect(postedBy("BB", 5)).toBe(1200);
    expect(postedBy("BB", 5, false)).toBe(600);
    expect(postedBy("BB", 10)).toBe(4000);
    expect(walkWin(5)).toBe(300);
    // without a level a blind's cost is unknown; the other seats still post nothing
    expect([postedBy("SB", null), postedBy("BB", null), postedBy("CO", null), walkWin(null)]).toEqual([null, null, 0, null]);
    // the seat names are the same at every table size (heads-up the SB posts the small blind)
    for (const seat of ["SB", "BB"]) expect(postedBy(seat, 1)).toBe(seat === "SB" ? 100 : 400);
    expect(postedBy("MP", 1)).toBe(0);
  });
});

describe("빠른 기록 chips: typing an amount", () => {
  it("takes digits in chips: no decimal, at most 9 digits, a leading 0 gives way, 00/000 wait for a digit", () => {
    expect(typeAll(["1", "2", "000"], "chips")).toBe("12000");
    expect(typeAll([".", "5"], "chips")).toBe("5");
    expect(typeAll(["00", "000", "7"], "chips")).toBe("7");
    expect(typeAll(["0", "5"], "chips")).toBe("5");
    expect(typeAll(["0", "0"], "chips")).toBe("0");
    expect(typeAll(["1", "000", "000", "000"], "chips")).toBe("1000000");
    expect(typeAll(["123456789", "1"].flatMap((x) => x.split("")), "chips")).toBe("123456789");
  });

  it("takes bb with one decimal and up to 4 whole digits; 000 does nothing", () => {
    expect(typeAll(["2", "0", ".", "5"], "bb")).toBe("20.5");
    expect(typeAll(["2", "0", ".", "5", "5"], "bb")).toBe("20.5");
    expect(typeAll(["2", ".", "."], "bb")).toBe("2.");
    expect(typeAll([".", "5"], "bb")).toBe("0.5");
    expect(typeAll(["1", "000"], "bb")).toBe("1");
    expect(typeAll(["1", "00"], "bb")).toBe("100");
    expect(typeAll(["1", "2", "3", "4", "5"], "bb")).toBe("1234");
    expect(typeAll(["2", ".", "00"], "bb")).toBe("2.");
  });

  it("reads the text as chips at the level, and turns it into the other unit", () => {
    // a bare "0." is a decimal being typed (after a stray "."), not a chop
    expect([amountValue(""), amountValue("."), amountValue("0."), amountValue("0"), amountValue("5."), amountValue("20.5")]).toEqual([null, null, null, 0, 5, 20.5]);
    expect(draftResult({ res: "+", amount: "0.", unit: "bb", seat: "BTN", level: 5, bbAnte: true })).toEqual({ result: "win", net: null });
    expect(toChips("12000", "chips", null)).toBe(12000);
    expect(toChips("20.5", "bb", 5)).toBe(12300);
    expect(toChips("20", "bb", null)).toBeNull();
    expect(convertText("12345", "chips", "bb", 5)).toBe("20.6");
    expect(convertText("12000", "chips", "bb", 5)).toBe("20");
    expect(convertText("20.5", "bb", "chips", 5)).toBe("12300");
    // no level: the digits stay
    expect(convertText("20", "bb", "chips", null)).toBe("20");
    expect(convertText("", "chips", "bb", 5)).toBe("");
    expect([inBb(12000, 5), inBb(12345, 5), inBb(100, null)]).toEqual([20, 20.6, null]);
    // a bb amount typed to 0.1 comes back exactly at every level
    for (let lv = 1; lv <= 30; lv++) for (const t of ["0.1", "2.5", "17.3", "999.9"]) expect(convertText(convertText(t, "bb", "chips", lv), "chips", "bb", lv)).toBe(t);
  });

  it("toggles the unit of a typed amount by keeping its digits, never converting or rounding", () => {
    // "20" typed in chips and meant as bb is 20bb, never 0bb (본전); a second tap undoes it exactly
    expect(unitText("20", "bb")).toBe("20");
    expect(unitText(unitText("20", "bb")!, "chips")).toBe("20");
    expect(unitText("4850", "bb")).toBe("4850");
    expect(unitText("20.5", "bb")).toBe("20.5");
    // digits the other unit can't hold: refused (a conversion wouldn't come back the same)
    expect(unitText("12000", "bb")).toBeNull();
    expect(unitText("12345", "bb")).toBeNull();
    expect(unitText("20.5", "chips")).toBeNull();
    // a trailing "." is a decimal not typed yet
    expect(unitText("20.", "chips")).toBe("20");
    expect(unitText("0.", "chips")).toBe("");
    expect(unitText("", "bb")).toBe("");
  });

  it("formats amounts: signed chips or bb, both, short 만 units, the level chip", () => {
    expect(signedText(12000, "chips")).toBe("+12,000");
    expect(signedText(-12000, "chips")).toBe(`${M}12,000`);
    expect(signedText(0, "chips")).toBe("본전");
    expect(signedText(-1200, "bb", 5)).toBe(`${M}2bb`);
    expect(signedText(12300, "bb", 5)).toBe("+20.5bb");
    expect(signedText(12300, "bb", null)).toBe("+12,300");
    expect(netBoth(12000, 5)).toBe("+12,000 (+20bb)");
    expect(netBoth(-300, 5)).toBe(`${M}300 (${M}0.5bb)`);
    expect(netBoth(12000, null)).toBe("+12,000");
    expect(netBoth(0, 5)).toBe("본전");
    expect([chipsShort(9500), chipsShort(15000), chipsShort(100000), chipsShort(-800000)]).toEqual(["9,500", "1.5만", "10만", `${M}80만`]);
    expect(bbText1(20)).toBe("20bb");
    expect(bbText1(20.55)).toBe("20.6bb");
    expect([levelChip(5), levelChip(17), levelChip(26), levelChip(null), levelChip(99)]).toEqual(["Lv5 300/600", "Lv17 5,000/1만", "Lv26 5만/10만", "레벨 ?", "레벨 ?"]);
  });
});

describe("빠른 기록 chips: the draft's result", () => {
  const at = (x: Partial<Parameters<typeof draftResult>[0]>) => draftResult({ unit: "chips", seat: "BTN", level: 5, bbAnte: true, ...x });
  it("saves 폴드 as what the seat posted, 워크 as the small blind, a sign and amount as chips", () => {
    expect(at({})).toEqual({ result: null, net: null });
    expect(at({ amount: "12000" })).toEqual({ block: "sign" });
    expect(at({ res: "fold" })).toEqual({ result: "fold", net: 0 });
    expect(at({ res: "fold", seat: "SB" })).toEqual({ result: "fold", net: -300 });
    expect(at({ res: "fold", seat: "BB" })).toEqual({ result: "fold", net: -1200 });
    expect(at({ res: "fold", seat: "BB", bbAnte: false })).toEqual({ result: "fold", net: -600 });
    expect(at({ res: "fold", seat: "BB", level: null })).toEqual({ result: "fold", net: null });
    expect(at({ res: "fold", amount: "5000" })).toEqual({ result: "fold", net: 0 });
    expect(at({ res: "walk", seat: "BB" })).toEqual({ result: "win", net: 300 });
    expect(at({ res: "walk", seat: "CO" })).toEqual({ result: null, net: null });
    expect(at({ res: "+" })).toEqual({ result: "win", net: null });
    expect(at({ res: "-" })).toEqual({ result: "lose", net: null });
    expect(at({ res: "+", amount: "0" })).toEqual({ result: "chop", net: 0 });
    expect(at({ res: "+", amount: "12000" })).toEqual({ result: "win", net: 12000 });
    expect(at({ res: "-", amount: "4800" })).toEqual({ result: "lose", net: -4800 });
    expect(at({ res: "-", amount: "8", unit: "bb" })).toEqual({ result: "lose", net: -4800 });
    expect(at({ res: "+", amount: "20", unit: "bb", level: null })).toEqual({ block: "level" });
    expect(at({ res: "+", amount: "12000", level: null })).toEqual({ result: "win", net: 12000 });
  });
});

describe("빠른 기록 chips: the board remembered", () => {
  const hole = holeFromRanks(R("A"), R("K"), "suited", [])!;
  it("takes a rank while fewer than 4 of it are out, counting the class", () => {
    expect(canAddRank([], R("A"), [R("A"), R("K")])).toBe(true);
    expect(canAddRank([{ r: R("A") }, { r: R("A") }], R("A"), [R("A"), R("A")])).toBe(false);
    expect(canAddRank([{ r: R("A") }, { r: R("A") }], R("A"), [R("A"), R("K")])).toBe(true);
    expect(canAddRank([{ r: 1 }, { r: 2 }, { r: 3 }, { r: 4 }, { r: 5 }], 6, [])).toBe(false);
  });

  it("places typed suits as typed and guesses the rest as new suits, clear of the hole cards", () => {
    const b = boardCards([{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }], hole)!;
    expect(b.guessed).toEqual([1, 2]);
    expect(b.cards[0]).toBe(makeCard(R("K"), 1));
    // a rainbow flop: no suit twice, none of the hole cards
    expect(new Set(b.cards.map((c) => c & 3)).size).toBe(3);
    expect(b.cards.some((c) => hole.includes(c))).toBe(false);
    // a guessed card steers around a known card typed after it
    const c = boardCards([{ r: R("Q") }, { r: R("J"), s: 1 }, { r: R("T"), s: 2 }], [])!;
    expect(new Set(c.cards.map((x) => x & 3)).size).toBe(3);
    // a turn and river on top
    const five = boardCards([{ r: 1 }, { r: 5 }, { r: 9 }, { r: 3 }, { r: 3 }], hole)!;
    expect(five.cards).toHaveLength(5);
    expect(new Set(five.cards).size).toBe(5);
    // the same known card twice can't be placed
    expect(boardCards([{ r: 3, s: 0 }, { r: 3, s: 0 }], [])).toBeNull();
    // five of a rank can't be placed
    expect(boardCards([{ r: 3 }, { r: 3 }, { r: 3 }, { r: 3 }, { r: 3 }], [])).toBeNull();
  });

  it("comes back from a saved board as marks: a guessed card as its rank only", () => {
    const b = boardCards([{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }, { r: R("9"), s: 3 }], hole)!;
    expect(marksOf(b.cards, b.guessed)).toEqual([{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }, { r: R("9"), s: 3 }]);
    expect(marksOf(parseCards("AsKd"), undefined)).toEqual([
      { r: 12, s: 0 },
      { r: 11, s: 2 },
    ]);
  });
});

describe("빠른 기록 chips: the session", () => {
  const T = 1_800_000_000_000;
  let n = 0;
  const hand = (net: number | null, extra: Partial<LoggedHand> = {}): LoggedHand => {
    n++;
    return { ...emptyHand(5), id: `s${n}`, createdAt: T + n * 60_000, updatedAt: T + n * 60_000, fast: true, net, result: net === null ? null : net > 0 ? "win" : net < 0 ? "lose" : "fold", ...extra };
  };
  // the spec's fixture: SB fold, BB fold, a win, a hand without a result, a loss with 지금 스택 55,700 typed (stack 60,500)
  const fixture = () => [hand(-300, { result: "fold", seat: "SB" }), hand(-1200, { result: "fold", seat: "BB" }), hand(12000), hand(null), hand(-4800, { stack: 60500 })];

  it("adds the chips up, in bb at each hand's level, and counts the results", () => {
    const m = sessionMoney([...fixture(), hand(0, { result: "fold" }), hand(3000, { level: null })]);
    expect(m).toEqual({ chips: 8700, bb: 9.5, withResult: 6, noResult: 1, won: 2, lost: 1, folds: 3 });
    expect(sessionMoney([hand(null)]).bb).toBeNull();
  });

  it("runs from 0 without a stack on file, in chips and in bb", () => {
    const s = chipSeries(fixture().map((h) => ({ ...h, stack: null })), "chips")!;
    expect(s.absolute).toBe(false);
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0].map((p) => p.y)).toEqual([0, -300, -1500, 10500, 10500, 5700]);
    expect([s.start, s.end, s.min, s.max, s.unknown]).toEqual([0, 5700, -1500, 10500, 1]);
    const bb = chipSeries(fixture().map((h) => ({ ...h, stack: null })), "bb")!;
    expect(bb.unit).toBe("bb");
    expect(bb.segments[0].map((p) => Math.round(p.y * 10) / 10)).toEqual([0, -0.5, -2.5, 17.5, 17.5, 9.5]);
  });

  it("runs as real stacks from 지금 스택: back to the start, and a jump where a later stack disagrees", () => {
    const hs = fixture();
    const s = chipSeries(hs, "chips")!;
    expect(s.absolute).toBe(true);
    expect(s.segments[0].map((p) => p.y)).toEqual([50000, 49700, 48500, 60500, 60500, 55700]);
    expect(s.anchors).toEqual([{ x: 5, y: 55700 }]);
    expect([s.start, s.unknown]).toEqual([50000, 1]);
    // +2,000, then −1,000 with 지금 스택 50,000 typed (stack 51,000): a hand was missed
    const more = [...hs, hand(2000), hand(-1000, { stack: 51000 })];
    const j = chipSeries(more, "chips")!;
    expect(j.jumps).toEqual([{ x: 6, from: 57700, to: 51000 }]);
    expect(j.segments).toHaveLength(2);
    expect(j.segments[1]).toEqual([
      { x: 6, y: 51000 },
      { x: 7, y: 50000 },
    ]);
    expect(j.end).toBe(50000);
    expect([seriesAt(j, 6), seriesAt(j, 7), seriesAt(j, 0)]).toEqual([57700, 50000, 50000]);
    // the missed hands' chips: the jump; with the logged nets it is the stack's change (end − start)
    expect(missedOf(more)).toEqual({ chips: -6700, bb: -11.2 });
    expect(sessionMoney(more).chips + missedOf(more)!.chips).toBe(j.end - j.start);
    expect(missedOf(hs)).toBeNull();
    expect(missedOf(hs.map((h) => ({ ...h, stack: null })))).toBeNull();
    // in bb: each point at its hand's big blind
    const bb = chipSeries(hs, "bb")!;
    expect(bb.segments[0].map((p) => Math.round(p.y * 10) / 10)).toEqual([83.3, 82.8, 80.8, 100.8, 100.8, 92.8]);
  });

  it("takes a missing level from the hand before it (else after), chips when no hand has one, nothing without a result", () => {
    const hs = [hand(-600, { level: null, stack: 30000 }), hand(1200, { level: 5 }), hand(600, { level: null })];
    const s = chipSeries(hs, "bb")!;
    expect(s.segments[0].map((p) => Math.round(p.y * 10) / 10)).toEqual([50, 49, 51, 52]);
    const none = chipSeries([hand(1000, { level: null }), hand(-500, { level: null })], "bb")!;
    expect(none.unit).toBe("chips");
    expect(none.segments[0].map((p) => p.y)).toEqual([0, 1000, 500]);
    expect(chipSeries([hand(null), hand(null)], "chips")).toBeNull();
    expect(chipSeries([], "chips")).toBeNull();
    // a stack alone is enough
    expect(chipSeries([hand(null, { stack: 40000 })], "chips")?.segments[0]).toEqual([
      { x: 0, y: 40000 },
      { x: 1, y: 40000 },
    ]);
  });
});
