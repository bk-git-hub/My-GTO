import { describe, expect, it } from "vitest";
import type { PreflopDecision } from "../../play/policy";
import { actLabel, actsFor, fastVerdict, seatsBefore, spotsFor, validInput, type FastInput } from "./fastVerdict";

const v = (i: Partial<FastInput> & Pick<FastInput, "seat" | "cls">) => fastVerdict({ stage: "mid", players: 9, spot: "none", ...i });
const text = (i: Partial<FastInput> & Pick<FastInput, "seat" | "cls">) => v(i).text;

describe("fastVerdict: unopened (RFI)", () => {
  it("opens and folds by the stage's open chart", () => {
    expect(v({ seat: "BTN", cls: "AJo", act: "open" })).toMatchObject({ kind: "ok", text: "✓ 차트대로", freq: 1, chart: "BTN 오픈 레인지 · 오픈 100%" });
    expect(text({ seat: "CO", cls: "72o", act: "fold" })).toBe("✓ 차트대로");
    expect(v({ seat: "CO", cls: "72o", act: "open" })).toMatchObject({ kind: "over", text: "⚠ 오버플레이 (차트: 폴드)", freq: 0 });
    // a limp or a shove with a folding hand is chips in where the chart folds
    expect(text({ seat: "CO", cls: "72o", act: "limp" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ seat: "CO", cls: "72o", act: "allin" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    // UTG opens AJo+ / KQo at the middle stage: KJo is an overplay there, but not on the button
    expect(text({ seat: "UTG", cls: "KJo", act: "open" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ seat: "BTN", cls: "KJo", act: "open" })).toBe("✓ 차트대로");
  });

  it("calls folding or limping an opening hand an underplay", () => {
    expect(v({ seat: "UTG", cls: "AJo", act: "fold" })).toMatchObject({ kind: "under", text: "▽ 언더플레이 (차트: 오픈)" });
    expect(text({ seat: "UTG", cls: "AJo", act: "limp" })).toBe("▽ 언더플레이 (차트: 오픈)");
  });

  it("follows the stage: deep opens wider from UTG than the middle stage", () => {
    expect(text({ stage: "deep", seat: "UTG", cls: "A4s", act: "open" })).toBe("✓ 차트대로");
    expect(text({ stage: "mid", seat: "UTG", cls: "A4s", act: "open" })).toBe("⚠ 오버플레이 (차트: 폴드)");
  });
});

describe("fastVerdict: facing an open", () => {
  it("looks up my seat's chart against that opener", () => {
    // HJ vs an UTG open (mid): 3-bet QQ+ AK, call 22-JJ AJs-AQs KQs JTs T9s
    expect(text({ seat: "HJ", cls: "K9s", spot: "open", opener: "UTG", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ seat: "HJ", cls: "K9s", spot: "open", opener: "UTG", act: "fold" })).toBe("✓ 차트대로");
    expect(text({ seat: "HJ", cls: "JJ", spot: "open", opener: "UTG", act: "call" })).toBe("✓ 차트대로");
    expect(text({ seat: "HJ", cls: "JJ", spot: "open", opener: "UTG", act: "3bet" })).toBe("⚠ 오버플레이 (차트: 콜)");
    expect(text({ seat: "HJ", cls: "AKo", spot: "open", opener: "UTG", act: "call" })).toBe("▽ 언더플레이 (차트: 3벳)");
    expect(text({ seat: "HJ", cls: "AKo", spot: "open", opener: "UTG", act: "3bet" })).toBe("✓ 차트대로");
    // the opener matters: BTN calls KQo against a CO open, not against UTG's (mid)
    expect(text({ seat: "BTN", cls: "KQo", spot: "open", opener: "CO", act: "call" })).toBe("✓ 차트대로");
    expect(text({ seat: "BTN", cls: "KQo", spot: "open", opener: "UTG", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(v({ seat: "BTN", cls: "KQo", spot: "open", opener: "CO", act: "call" }).chart).toBe("BTN vs CO 오픈 · 콜 100%");
  });

  it("grades UTG+1 against an UTG open at the middle stage", () => {
    expect(v({ seat: "UTG+1", cls: "QQ", spot: "open", opener: "UTG", act: "3bet" })).toMatchObject({ kind: "ok", chart: "UTG+1~LJ vs UTG·UTG+1 오픈 · 3벳 100%" });
    expect(text({ seat: "UTG+1", cls: "72o", spot: "open", opener: "UTG", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
  });

  it("uses the BB defense against each opener", () => {
    expect(v({ seat: "BB", cls: "K9o", spot: "open", opener: "UTG", act: "call" }).chart).toMatch(/^BB vs UTG 오픈 · 콜 100%/);
    expect(text({ seat: "BB", cls: "K9o", spot: "open", opener: "UTG", act: "call" })).toBe("✓ 차트대로");
    expect(text({ seat: "BB", cls: "72o", spot: "open", opener: "UTG", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ seat: "BB", cls: "K2o", spot: "open", opener: "BTN", act: "call" })).toBe("✓ 차트대로");
    expect(text({ seat: "BB", cls: "K2o", spot: "open", opener: "UTG", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
  });

  it("grades a 50/50 hand either way, and folding it as an underplay", () => {
    // BB vs HJ (mid): A5s 3-bets half the time and calls the rest
    const a5 = { seat: "BB", cls: "A5s", spot: "open" as const, opener: "HJ" };
    expect(v({ ...a5, act: "3bet" })).toMatchObject({ kind: "ok", freq: 0.5 });
    expect(v({ ...a5, act: "call" })).toMatchObject({ kind: "ok", freq: 0.5 });
    expect(v({ ...a5, act: "fold" }).text).toBe("▽ 언더플레이 (차트: 3벳 50%)");
    expect(v({ ...a5, act: "fold" }).chart).toBe("BB vs HJ 오픈 · 3벳 50% · 콜 50%");
  });

  it("calls a deep or middle-stack shove where the chart makes a small raise an overplay", () => {
    // mid: the chart 3-bets AKo to 7.5bb; a 55bb shove over the open is not that 3-bet
    expect(v({ seat: "HJ", cls: "AKo", spot: "open", opener: "UTG", act: "allin" })).toMatchObject({ kind: "over", text: "⚠ 오버플레이 (차트: 3벳)", freq: 0 });
    expect(text({ seat: "BB", cls: "AKo", spot: "open", opener: "UTG", act: "allin" })).toBe("⚠ 오버플레이 (차트: 3벳)");
    // a shove with a folding hand is still graded against the fold
    expect(text({ seat: "HJ", cls: "K9s", spot: "open", opener: "UTG", act: "allin" })).toBe("⚠ 오버플레이 (차트: 폴드)");
  });
});

describe("fastVerdict: an unopened shove at deep and middle stacks", () => {
  it("is an overplay of an opening hand, not the chart's open", () => {
    expect(v({ stage: "deep", seat: "CO", cls: "22", act: "allin" })).toMatchObject({ kind: "over", text: "⚠ 오버플레이 (차트: 오픈)" });
    expect(v({ stage: "mid", seat: "CO", cls: "KTo", act: "allin" })).toMatchObject({ kind: "over", text: "⚠ 오버플레이 (차트: 오픈)" });
    expect(text({ stage: "mid", seat: "UTG", cls: "AJo", act: "allin" })).toBe("⚠ 오버플레이 (차트: 오픈)");
    expect(text({ stage: "deep", seat: "BTN", cls: "AA", act: "allin" })).toBe("⚠ 오버플레이 (차트: 오픈)");
    expect(text({ stage: "deep", seat: "CO", cls: "72o", act: "allin" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    // the open itself is still by the chart
    expect(text({ stage: "deep", seat: "CO", cls: "22", act: "open" })).toBe("✓ 차트대로");
  });

  it("takes a shove for a raise that commits the stack anyway (a deep 4-bet) as the chart's raise", () => {
    expect(text({ stage: "deep", seat: "CO", cls: "KK", spot: "3bet", act: "allin" })).toBe("✓ 차트대로 · 차트는 4벳");
  });
});

describe("fastVerdict: short and push stacks", () => {
  it("grades opens and shoves by the short-stack chart (2bb open TT+ AQ+, else shove)", () => {
    expect(text({ stage: "short", seat: "CO", cls: "A5o", act: "allin" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "CO", cls: "A5o", act: "open" })).toBe("✓ 차트대로 · 차트는 올인");
    expect(text({ stage: "short", seat: "CO", cls: "A5o", act: "fold" })).toBe("▽ 언더플레이 (차트: 올인)");
    expect(text({ stage: "short", seat: "UTG", cls: "AA", act: "open" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "UTG", cls: "AA", act: "allin" })).toBe("✓ 차트대로 · 차트는 2bb 오픈");
    expect(text({ stage: "short", seat: "UTG", cls: "K9s", act: "allin" })).toBe("⚠ 오버플레이 (차트: 폴드)");
  });

  it("3-bets all-in over an open, and the BB also calls some against a late open", () => {
    expect(text({ stage: "short", seat: "CO", cls: "99", spot: "open", opener: "UTG", act: "allin" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "CO", cls: "KQo", spot: "open", opener: "UTG", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ stage: "short", seat: "BB", cls: "KTs", spot: "open", opener: "HJ", act: "call" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "BB", cls: "55", spot: "open", opener: "HJ", act: "allin" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "BB", cls: "55", spot: "open", opener: "HJ", act: "3bet" })).toBe("✓ 차트대로 · 차트는 3벳 올인");
    expect(text({ stage: "short", seat: "BB", cls: "55", spot: "open", opener: "HJ", act: "call" })).toBe("▽ 언더플레이 (차트: 3벳 올인)");
  });

  it("calls shoves by the shover's seat", () => {
    // vs UTG~LJ shove (short): call 99+ AQ+
    expect(text({ stage: "short", seat: "BB", cls: "TT", spot: "shove", opener: "UTG", act: "call" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "BB", cls: "88", spot: "shove", opener: "UTG", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ stage: "short", seat: "BB", cls: "AQo", spot: "shove", opener: "UTG", act: "fold" })).toBe("▽ 언더플레이 (차트: 콜)");
    // vs a late shove: 77+ ATo+
    expect(text({ stage: "short", seat: "BB", cls: "ATo", spot: "shove", opener: "BTN", act: "call" })).toBe("✓ 차트대로");
    expect(text({ stage: "push", seat: "SB", cls: "K2o", act: "allin" })).toBe("✓ 차트대로");
    expect(text({ stage: "push", seat: "UTG", cls: "44", act: "allin" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ stage: "push", seat: "BB", cls: "88", spot: "shove", opener: "BTN", act: "call" })).toBe("✓ 차트대로");
    // the middle stage has a chart for a short stack's shove; deep has none
    expect(text({ stage: "mid", seat: "BB", cls: "AJo", spot: "shove", opener: "CO", act: "call" })).toBe("✓ 차트대로");
    expect(v({ stage: "deep", seat: "BB", cls: "AJo", spot: "shove", opener: "CO", act: "call" }).kind).toBe("none");
  });
});

describe("fastVerdict: a 3-bet over my open", () => {
  it("uses the open-vs-3bet chart (the middle stage 4-bets all-in)", () => {
    expect(text({ seat: "CO", cls: "QQ", spot: "3bet", act: "allin" })).toBe("✓ 차트대로");
    expect(text({ seat: "CO", cls: "QQ", spot: "3bet", act: "3bet" })).toBe("✓ 차트대로 · 차트는 4벳 올인");
    expect(text({ seat: "CO", cls: "JJ", spot: "3bet", act: "call" })).toBe("✓ 차트대로");
    expect(text({ seat: "CO", cls: "98s", spot: "3bet", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ seat: "CO", cls: "AKo", spot: "3bet", act: "fold" })).toBe("▽ 언더플레이 (차트: 4벳 올인)");
    expect(text({ stage: "deep", seat: "CO", cls: "QQ", spot: "3bet", act: "3bet" })).toBe("✓ 차트대로");
    expect(text({ stage: "deep", seat: "CO", cls: "55", spot: "3bet", act: "call" })).toBe("✓ 차트대로");
  });

  it("short stacks 3-bet all-in: then it is a call or fold, and a shove back is a call", () => {
    expect(text({ stage: "short", seat: "CO", cls: "77", spot: "3bet", act: "call" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "CO", cls: "77", spot: "3bet", act: "allin" })).toBe("✓ 차트대로");
    expect(text({ stage: "short", seat: "CO", cls: "65s", spot: "3bet", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
  });
});

describe("fastVerdict: a cold 3-bet (someone's open, another's 3-bet, then me)", () => {
  it("continues with premiums only, not by the open-vs-3bet chart", () => {
    const cold = { stage: "deep" as const, seat: "BTN", spot: "cold3" as const };
    // the deep open-vs-3bet chart calls 55 and AQs; a cold 3-bet is folded with them
    expect(v({ ...cold, cls: "55", act: "fold" })).toMatchObject({ kind: "ok", text: "✓ 차트대로", chart: "4벳 이상에 대응 (KK+, AKs) · 폴드 100%" });
    expect(text({ ...cold, cls: "AQs", act: "fold" })).toBe("✓ 차트대로");
    expect(text({ ...cold, cls: "AQs", act: "call" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    expect(text({ ...cold, cls: "QQ", act: "call" })).toBe("✓ 차트대로");
    expect(text({ ...cold, cls: "KK", act: "allin" })).toBe("✓ 차트대로");
    expect(text({ ...cold, cls: "AKs", act: "fold" })).toBe("▽ 언더플레이 (차트: 4벳 올인)");
    // short stacks: the 3-bet is a shove, so call QQ+ AK or fold
    expect(text({ ...cold, stage: "short", cls: "AKo", act: "call" })).toBe("✓ 차트대로");
    expect(text({ ...cold, stage: "short", cls: "JJ", act: "allin" })).toBe("⚠ 오버플레이 (차트: 폴드)");
    // two seats before me, and the BB can have one
    expect(validInput({ ...cold, players: 9, seat: "UTG+1", cls: "AA", act: "call" })).toBe(false);
    expect(text({ ...cold, seat: "BB", cls: "AA", act: "allin" })).toBe("✓ 차트대로");
  });
});

describe("fastVerdict: no chart", () => {
  it("has no chart facing limps, and a walk has nothing to grade", () => {
    expect(v({ seat: "BTN", cls: "72o", spot: "limp", act: "call" })).toMatchObject({ kind: "none", text: "차트 없음 · 림프 팟", freq: null, chart: "" });
    expect(v({ seat: "BB", cls: "AA", spot: "limp", act: "open" }).kind).toBe("none");
    expect(v({ seat: "BB", cls: "72o", spot: "none" })).toMatchObject({ kind: "none", text: "워크" });
  });

  it("refuses spots that can't happen: an opener after me or me, an open before UTG, a choice the spot doesn't offer", () => {
    const bad: FastInput[] = [
      { stage: "mid", players: 9, seat: "HJ", cls: "AA", spot: "open", opener: "CO", act: "call" },
      { stage: "mid", players: 9, seat: "HJ", cls: "AA", spot: "open", opener: "HJ", act: "call" },
      { stage: "mid", players: 9, seat: "HJ", cls: "AA", spot: "open", act: "call" },
      { stage: "mid", players: 9, seat: "UTG", cls: "AA", spot: "open", opener: "BB", act: "call" },
      { stage: "mid", players: 9, seat: "HJ", cls: "AA", spot: "open", opener: "UTG", act: "limp" },
      { stage: "mid", players: 9, seat: "BB", cls: "AA", spot: "none", act: "open" },
      { stage: "mid", players: 9, seat: "BB", cls: "AA", spot: "3bet", act: "call" },
      { stage: "mid", players: 6, seat: "UTG+2", cls: "AA", act: "open", spot: "none" },
      { stage: "mid", players: 9, seat: "BTN", cls: "AA", spot: "none" },
    ];
    for (const i of bad) {
      expect(validInput(i)).toBe(false);
      expect(fastVerdict(i)).toMatchObject({ kind: "none", text: "차트 없음" });
    }
    expect(validInput({ stage: "mid", players: 9, seat: "BB", cls: "AA", spot: "open", opener: "SB", act: "call" })).toBe(true);
  });

  it("knows which seats act before mine, and which spots and choices each seat has", () => {
    expect(seatsBefore(9, "HJ")).toEqual(["UTG", "UTG+1", "UTG+2", "LJ"]);
    expect(seatsBefore(9, "BB")).toEqual(["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB"]);
    expect(seatsBefore(6, "UTG")).toEqual([]);
    expect(spotsFor(9, "UTG")).toEqual(["none", "3bet"]);
    // a cold 3-bet takes two seats before me
    expect(spotsFor(9, "UTG+1")).toEqual(["none", "limp", "open", "shove", "3bet"]);
    expect(spotsFor(9, "BB")).toEqual(["none", "limp", "open", "shove", "cold3"]);
    expect(spotsFor(9, "CO")).toEqual(["none", "limp", "open", "shove", "3bet", "cold3"]);
    expect(actsFor("cold3", "BB")).toEqual(["fold", "call", "3bet", "allin"]);
    expect(actLabel("cold3", "3bet", "BB")).toBe("4벳");
    expect(actsFor("none", "CO")).toEqual(["fold", "limp", "open", "allin"]);
    expect(actsFor("none", "BB")).toEqual([]);
    expect(actsFor("limp", "BTN")).toEqual(["fold", "call", "open", "allin"]);
    expect(actsFor("limp", "BB")).toEqual(["call", "open", "allin"]);
    expect(actsFor("open", "HJ")).toEqual(["fold", "call", "3bet", "allin"]);
    expect(actsFor("shove", "BB")).toEqual(["fold", "call"]);
    expect(actsFor("3bet", "CO")).toEqual(["fold", "call", "3bet", "allin"]);
    expect(actLabel("3bet", "3bet", "CO")).toBe("4벳");
    expect(actLabel("limp", "open", "BTN")).toBe("아이소");
    expect(actLabel("limp", "call", "BB")).toBe("체크");
    expect(actLabel("open", "3bet", "CO")).toBe("3벳");
  });
});

describe("fastVerdict: mixed frequencies", () => {
  // A made-up chart that opens 30%, calls 20% and folds the rest, to check the boundaries.
  const decide = (): PreflopDecision => ({
    label: "test",
    scenario: { title: "테스트" } as PreflopDecision["scenario"],
    moves: () => [
      { kind: "raise", to: 2.5, prob: 0.3 },
      { kind: "call", prob: 0.2 },
      { kind: "fold", prob: 0.5 },
    ],
  });
  const at = (act: FastInput["act"]) => fastVerdict({ stage: "mid", players: 9, seat: "BTN", cls: "K7o", spot: "none", act }, decide);

  it("calls 0 < f < 0.5 a mixed hand, f ≥ 0.5 by the chart", () => {
    expect(at("open")).toMatchObject({ kind: "mixed", text: "△ 섞는 핸드 (30%)", freq: 0.3 });
    expect(at("limp")).toMatchObject({ kind: "mixed", text: "△ 섞는 핸드 (20%)" });
    expect(at("fold")).toMatchObject({ kind: "ok", freq: 0.5 });
    // a middle-stack shove the chart never makes, though it opens 30%: an overplay
    expect(at("allin")).toMatchObject({ kind: "over", text: "⚠ 오버플레이 (차트: 폴드 50%)" });
    // a short stack's shove for that open: the open, its size named
    expect(fastVerdict({ stage: "short", players: 9, seat: "BTN", cls: "K7o", spot: "none", act: "allin" }, decide).text).toBe("△ 섞는 핸드 (30%) · 차트는 2bb 오픈");
    expect(at("open").chart).toBe("테스트 · 폴드 50% · 오픈 30% · 콜 20%");
  });
});
