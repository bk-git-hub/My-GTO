import { describe, expect, it } from "vitest";
import { blindsBack, blindsDraft, blindsFill, blindsFocus, blindsKey, blindsOut, blindsShown, type BlindsDraft } from "./blindsEdit";
import { typeChips } from "./CalcSheet";
import {
  bbPart,
  blindsText,
  chipSeries,
  convertText,
  digitSlip,
  draftResult,
  handLv,
  inBb,
  levelChip,
  levelNear,
  missedOf,
  netBoth,
  postedBy,
  sessionMoney,
  signedText,
  stackAt,
  toChips,
  walkWin,
} from "./fastChips";
import { emptyHand, exportData, handLevelLabel, sanitize, stackBb, tidyHand, withBackup, withLevel, withLv, type LoggedHand } from "./handLog";
import { BLINDS_MAX, blindsOf, cleanBlinds, nextPubBlinds, PUB_SCHEDULE, sameBlinds, type Blinds } from "./levelClock";
import { cleanTourney, type Tourney } from "./tourney";

/** Lv4 of 야자수 새틀 (300/500, BB ante 500) typed by hand. */
const LV4: Blinds = { sb: 300, bb: 500, ante: 500 };
const B800: Blinds = { sb: 400, bb: 800, ante: 800 };
const T = 1_800_000_000_000;
const hand = (id: string, at: number, extra: Partial<LoggedHand> = {}): LoggedHand => ({ ...emptyHand(null), id, createdAt: at, updatedAt: at, seat: "BTN", fast: true, ...extra });

describe("직접 입력 blinds: the record (levelClock)", () => {
  it("keeps blinds only as whole chips with 1 ≤ SB ≤ BB and 0 ≤ ante, all within 8 digits", () => {
    expect(cleanBlinds(LV4)).toEqual(LV4);
    expect(cleanBlinds({ sb: 100, bb: 200, ante: 0 })).toEqual({ sb: 100, bb: 200, ante: 0 });
    expect(cleanBlinds({ sb: 200, bb: 200, ante: 200 })).toEqual({ sb: 200, bb: 200, ante: 200 });
    expect(cleanBlinds({ sb: BLINDS_MAX, bb: BLINDS_MAX, ante: BLINDS_MAX })).not.toBeNull();
    for (const bad of [
      { sb: 0, bb: 200, ante: 200 },
      { sb: 300, bb: 200, ante: 200 },
      { sb: 100, bb: 200.5, ante: 200 },
      { sb: 100, bb: 200, ante: -1 },
      { sb: "100", bb: 200, ante: 200 },
      { sb: 100, bb: BLINDS_MAX + 1, ante: 0 },
      { sb: 100, bb: 200 },
      null,
      "100/200",
      5,
    ])
      expect(cleanBlinds(bad)).toBeNull();
    // only the three fields come back
    expect(cleanBlinds({ ...LV4, level: 4 })).toEqual(LV4);
  });

  it("reads any Lv as blinds: a 야자수 새틀 level's row, typed blinds, or none", () => {
    expect(blindsOf(4)).toEqual(LV4);
    expect(blindsOf(B800)).toEqual(B800);
    expect(blindsOf(null)).toBeNull();
    expect(blindsOf(99)).toBeNull();
    expect(blindsOf({ sb: 900, bb: 800, ante: 0 })).toBeNull();
    expect(sameBlinds(LV4, { ...LV4 })).toBe(true);
    expect(sameBlinds(LV4, B800)).toBe(false);
    expect(sameBlinds(null, null)).toBe(true);
    expect(sameBlinds(LV4, null)).toBe(false);
  });

  it("offers the next step from the 야자수 새틀 ladder: the first row whose big blind is above", () => {
    expect(nextPubBlinds({ sb: 300, bb: 600, ante: 600 })).toEqual({ sb: 400, bb: 800, ante: 800 });
    expect(nextPubBlinds({ sb: 100, bb: 200, ante: 200 })).toEqual(blindsOf(2));
    // off the ladder: the next row up
    expect(nextPubBlinds({ sb: 350, bb: 700, ante: 0 })?.bb).toBe(800);
    expect(nextPubBlinds(null)).toEqual(blindsOf(1));
    const top = PUB_SCHEDULE[PUB_SCHEDULE.length - 1];
    expect(nextPubBlinds({ sb: top.sb, bb: top.bb, ante: top.ante })).toBeNull();
  });
});

describe("직접 입력 blinds: the chip maths take any Lv", () => {
  it("gives exactly the schedule's numbers for the same blinds typed by hand", () => {
    for (const seat of ["UTG", "SB", "BB"]) expect(postedBy(seat, LV4)).toBe(postedBy(seat, 4));
    expect(postedBy("BB", LV4, false)).toBe(postedBy("BB", 4, false));
    expect(walkWin(LV4)).toBe(walkWin(4));
    expect(toChips("20.5", "bb", LV4)).toBe(toChips("20.5", "bb", 4));
    expect(convertText("12345", "chips", "bb", LV4)).toBe(convertText("12345", "chips", "bb", 4));
    expect(inBb(12800, LV4)).toBe(25.6);
    expect(signedText(-1000, "bb", LV4)).toBe(signedText(-1000, "bb", 4));
    expect(netBoth(12800, LV4)).toBe(netBoth(12800, 4));
    expect(bbPart(12800, LV4, true)).toBe("+25.6bb");
    const d = { res: "fold" as const, unit: "chips" as const, seat: "BB", bbAnte: true };
    expect(draftResult({ ...d, level: LV4 })).toEqual(draftResult({ ...d, level: 4 }));
  });

  it("counts a BB's fold with the 앤티 typed (0: none), and nothing without blinds", () => {
    expect(postedBy("BB", { sb: 100, bb: 200, ante: 200 })).toBe(400);
    expect(postedBy("BB", { sb: 100, bb: 200, ante: 0 })).toBe(200);
    expect(postedBy("BB", { sb: 100, bb: 200, ante: 300 })).toBe(500);
    expect(postedBy("SB", { sb: 100, bb: 200, ante: 200 })).toBe(100);
    expect(postedBy("SB", null)).toBeNull();
  });

  it("names the chip by the blinds: the pair (앤티 = BB), another 앤티 in brackets, 노앤티, 블라인드 ?", () => {
    expect(levelChip(5)).toBe("Lv5 300/600");
    expect(levelChip(null)).toBe("레벨 ?");
    expect(levelChip(B800, true)).toBe("400/800");
    expect(levelChip({ sb: 400, bb: 800, ante: 500 }, true)).toBe("400/800 (500)");
    expect(levelChip({ sb: 400, bb: 800, ante: 0 }, true)).toBe("400/800 노앤티");
    expect(levelChip({ sb: 5000, bb: 10000, ante: 10000 }, true)).toBe("5,000/1만");
    expect(levelChip(null, true)).toBe("블라인드 ?");
    expect(blindsText(B800)).toBe("400/800 · 앤티 800");
    expect(blindsText({ sb: 400, bb: 800, ante: 0 })).toBe("400/800 · 앤티 없음");
  });

  it("reads a hand's own blinds before its level, and its level as before without them", () => {
    expect(handLv({ level: 5 })).toBe(5);
    expect(handLv({ level: null })).toBeNull();
    expect(handLv({ level: null, blinds: B800 })).toEqual(B800);
  });

  it("adds up bb hand by hand at each hand's own blinds, 직접 입력 and 야자수 새틀 mixed", () => {
    const hs = [
      hand("a", T, { level: null, blinds: { sb: 100, bb: 200, ante: 200 }, result: "win", net: 2000 }),
      hand("b", T + 1, { level: null, blinds: B800, result: "lose", net: -1600 }),
      hand("c", T + 2, { level: 5, result: "win", net: 600 }),
    ];
    expect(sessionMoney(hs)).toMatchObject({ chips: 1000, bb: 10 - 2 + 1 });
    const s = chipSeries(hs, "bb", null)!;
    expect(s.unit).toBe("bb");
    expect(s.end).toBeCloseTo(9);
    // a 칩 업데이트 between hands is counted at the blinds around it
    expect(levelNear(hs, T + 1)).toEqual(B800);
  });

  it("is byte for byte what it was for hands without blinds (old data)", () => {
    const hs = [
      hand("a", T, { level: 5, result: "win", net: 12000, stack: 50000, fastStack: true }),
      hand("b", T + 1, { level: 6, result: "fold", net: -1600 }),
      hand("c", T + 2, { level: null, result: "lose", net: -3000 }),
      hand("d", T + 3, { level: 9, result: null, net: null, stack: 70000 }),
    ];
    const run = () => JSON.stringify([sessionMoney(hs), chipSeries(hs, "bb", 50000), chipSeries(hs, "chips", 50000), missedOf(hs, 50000), stackAt(hs, 50000, [])]);
    const before = run();
    // the same hands with `blinds: undefined` keys (never stored, but a spread can leave one) give the same
    const same = hs.map((h) => ({ ...h, blinds: undefined }));
    expect(JSON.stringify([sessionMoney(same), chipSeries(same, "bb", 50000), chipSeries(same, "chips", 50000), missedOf(same, 50000), stackAt(same, 50000, [])])).toBe(before);
    expect(sessionMoney(hs)).toMatchObject({ chips: 7400, bb: 20 - 2 });
  });

  it("flags a stack with a 0 too many or too few: 3× or more, a third or less", () => {
    expect(digitSlip(150000, 50000)).toBe(true);
    expect(digitSlip(16000, 50000)).toBe(true);
    expect(digitSlip(61800, 49000)).toBe(false);
    expect(digitSlip(61800, null)).toBe(false);
    expect(digitSlip(0, 50000)).toBe(false);
  });
});

describe("직접 입력 blinds: the editor (blindsEdit)", () => {
  const type = (d: BlindsDraft, keys: string[]) => keys.reduce(blindsKey, d);

  it("types into BB first, the first key replacing it; SB and 앤티 follow BB until typed", () => {
    let d = blindsDraft(B800);
    expect(d.focus).toBe("bb");
    expect(blindsShown(d)).toMatchObject({ sb: 400, bb: 800, ante: 800, autoSb: true, autoAnte: true });
    d = type(d, ["1", "0", "000"]);
    expect(blindsShown(d)).toMatchObject({ sb: 5000, bb: 10000, ante: 10000, autoSb: true, autoAnte: true });
    expect(blindsOut(d)).toEqual({ blinds: { sb: 5000, bb: 10000, ante: 10000 } });
    // nothing set yet: empty, BB asked first
    const empty = blindsDraft(null);
    expect(blindsOut(empty)).toEqual({ why: "bb" });
    expect(blindsOut(type(empty, ["2", "0", "0"]))).toEqual({ blinds: { sb: 100, bb: 200, ante: 200 } });
    // an odd BB: SB rounds down
    expect(blindsShown(type(empty, ["5", "0", "5"])).sb).toBe(252);
  });

  it("makes SB or 앤티 its own once tapped and typed; 0 in 앤티 is no ante", () => {
    let d = type(blindsDraft(null), ["8", "0", "0"]);
    d = type(blindsFocus(d, "ante"), ["5", "0", "0"]);
    expect(blindsOut(d)).toEqual({ blinds: { sb: 400, bb: 800, ante: 500 } });
    d = type(blindsFocus(d, "ante"), ["0"]);
    expect(blindsOut(d)).toEqual({ blinds: { sb: 400, bb: 800, ante: 0 } });
    expect(blindsShown(d).autoAnte).toBe(false);
    d = type(blindsFocus(d, "sb"), ["3", "0", "0"]);
    expect(blindsOut(d)).toEqual({ blinds: { sb: 300, bb: 800, ante: 0 } });
    // BB changed later: SB and 앤티 typed stay
    d = type(blindsFocus(d, "bb"), ["1", "000"]);
    expect(blindsOut(d)).toEqual({ blinds: { sb: 300, bb: 1000, ante: 0 } });
    // blinds whose SB and 앤티 don't follow the rule open as their own
    expect(blindsShown(blindsDraft({ sb: 300, bb: 800, ante: 500 }))).toMatchObject({ autoSb: false, autoAnte: false });
  });

  it("refuses SB over BB, and an empty BB or SB, saying why", () => {
    let d = type(blindsDraft(null), ["8", "0", "0"]);
    d = type(blindsFocus(d, "sb"), ["9", "0", "0"]);
    expect(blindsOut(d)).toEqual({ why: "sbBig" });
    d = blindsBack(blindsBack(blindsBack(d)));
    expect(blindsOut(d)).toEqual({ why: "sb" });
  });

  it("takes ⌫ off the focused field's last digit (a following field becomes its own from what it showed)", () => {
    let d = blindsDraft(B800);
    d = blindsBack(d);
    expect(blindsShown(d)).toMatchObject({ bb: 80, sb: 40, ante: 80 });
    d = blindsBack(blindsFocus(d, "ante"));
    expect(blindsShown(d)).toMatchObject({ bb: 80, ante: 8, autoAnte: false });
    // at most 8 digits a field; 000 on nothing does nothing
    expect(blindsShown(type(blindsDraft(null), ["000"])).bb).toBeNull();
    expect(blindsShown(type(blindsDraft(null), ["9", "9", "9", "9", "9", "9", "9", "9", "9"])).bb).toBe(99_999_999);
  });

  it("fills all three from 다음 ▸ (applied only with 적용)", () => {
    const next = nextPubBlinds(B800)!;
    expect(blindsOut(blindsFill(next))).toEqual({ blinds: next });
  });

  it("types a chip count calculator style: at most 9 digits, a leading 0 gives way, 000 not on nothing", () => {
    expect(["6", "1", "8", "0", "0"].reduce(typeChips, "")).toBe("61800");
    expect(typeChips("", "000")).toBe("");
    expect(typeChips("0", "5")).toBe("5");
    expect(typeChips("50", "000")).toBe("50000");
    expect(typeChips("123456789", "1")).toBe("123456789");
    expect(typeChips("12", ".")).toBe("12");
  });
});

describe("직접 입력 blinds: hands and tournaments on file", () => {
  it("keeps a hand's blinds only while it has no schedule level, and only valid ones", () => {
    const h = hand("a", T, { level: null, blinds: B800 });
    expect(tidyHand(h)).toEqual(h);
    expect(tidyHand({ ...h, level: 5 })).not.toHaveProperty("blinds");
    expect(tidyHand({ ...h, blinds: { sb: 900, bb: 800, ante: 0 } })).not.toHaveProperty("blinds");
    expect(sanitize(JSON.parse(JSON.stringify(h)))).toMatchObject({ level: null, blinds: B800 });
    expect(sanitize({ ...h, level: 5 })).not.toHaveProperty("blinds");
    expect(sanitize({ ...h, blinds: "400/800" })).not.toHaveProperty("blinds");
    // an old hand: no blinds key at all
    expect(sanitize(JSON.parse(JSON.stringify(hand("o", T, { level: 5 }))))).not.toHaveProperty("blinds");
  });

  it("sets typed blinds on a hand as its level (rescaling bets as levels do), and a level picked later drops them", () => {
    const base = hand("a", T, { level: 5, levelGuess: true, stacks: { BTN: 50 }, steps: [] });
    const c = withLv(base, B800);
    expect(c).toMatchObject({ level: null, blinds: B800 });
    expect(c).not.toHaveProperty("levelGuess");
    // a stack of 50bb at 600 is 30,000 chips: 37.5bb at 800
    expect(c.stacks.BTN).toBeCloseTo(37.5);
    const back = withLevel(c, 5);
    expect(back).toMatchObject({ level: 5 });
    expect(back).not.toHaveProperty("blinds");
    expect(back.stacks.BTN).toBeCloseTo(50);
    expect(withLv(c, null)).not.toHaveProperty("blinds");
  });

  it("labels a hand's blinds and counts its stack in bb at them", () => {
    expect(handLevelLabel({ level: null, blinds: B800 })).toBe("블라인드 400/800 · 앤티 800 (직접 입력)");
    expect(handLevelLabel({ level: null, blinds: { sb: 400, bb: 800, ante: 0 } })).toBe("블라인드 400/800 · 앤티 없음 (직접 입력)");
    expect(handLevelLabel({ level: 5 })).toBe("Lv5 · 300/600");
    expect(stackBb({ stack: 40000, level: null, blinds: B800 })).toBe(50);
    expect(stackBb({ stack: 40000, level: null })).toBeNull();
  });

  it("keeps a tournament's structure only as 직접 입력, its blinds only with it and valid", () => {
    const rec = (extra: Partial<Tourney> = {}): Tourney => ({ id: "t-1", createdAt: T, updatedAt: T, activeAt: T, name: "", memo: "", start: T, startStack: 30000, ...extra });
    const c = rec({ structure: "custom", blinds: B800 });
    expect(cleanTourney(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(cleanTourney(rec({ structure: "custom" }))).toEqual(rec({ structure: "custom" }));
    expect(cleanTourney({ ...rec(), structure: "pub" })).not.toHaveProperty("structure");
    expect(cleanTourney({ ...rec(), blinds: B800 })).not.toHaveProperty("blinds");
    expect(cleanTourney({ ...rec({ structure: "custom" }), blinds: { sb: 1, bb: 0, ante: 0 } })).not.toHaveProperty("blinds");
    // an old record: as it was
    expect(cleanTourney(rec())).toEqual(rec());
  });

  it("carries the blinds through a backup, and an old backup's hands load as they were", () => {
    const hs = [hand("a", T, { level: null, blinds: B800, result: "win", net: 1600 }), hand("b", T + 1, { level: 5 })];
    const t: Tourney = { id: "t-1", createdAt: T, updatedAt: T, activeAt: T, name: "", memo: "", start: T, startStack: 30000, structure: "custom", blinds: B800 };
    const text = exportData(hs, undefined, undefined, [t]);
    expect(JSON.parse(text).version).toBe(2);
    const { next } = withBackup({ hands: [], lastLevel: null }, text);
    expect(next.hands.find((h) => h.id === "a")).toMatchObject({ level: null, blinds: B800 });
    expect(next.hands.find((h) => h.id === "b")).not.toHaveProperty("blinds");
    expect(next.tourneys?.[0]).toMatchObject({ structure: "custom", blinds: B800 });
  });
});
