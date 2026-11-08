import { afterEach, describe, expect, it } from "vitest";
import { RANKS } from "../../poker/cards";
import {
  afterSave,
  cleanFastState,
  draftOf,
  fastHand,
  fastOtherStore,
  fastStats,
  fastStore,
  newDraft,
  pickSuited,
  sessionOf,
  sessionText,
  shareTable,
  startEdit,
  storeFor,
  tapRank,
  withSeat,
  type FastDraft,
  type FastState,
} from "./fastLog";
import { fastVerdict, theirWords } from "./fastVerdict";
import { emptyHand, fastActText, fastVerdictOf, freshHand, handFacts, holeClass, holeGuessed, isOther, type LoggedHand } from "./handLog";

const R = (k: string) => RANKS.indexOf(k);
function typed(seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft {
  let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
  if (cls[2]) d = pickSuited(d, cls[2] === "s");
  return { ...d, ...extra };
}
const base = (at = 1_000_000, kind: "mine" | "other" = "other"): LoggedHand => ({ ...emptyHand(null, kind), id: `h${at}`, createdAt: at, updatedAt: at });
const state = (draft: FastDraft, extra: Partial<FastState> = {}): FastState => ({ stage: "mid", players: 9, draft, parked: null, ...extra });
const theirs = (at: number, d: FastDraft, a: Parameters<typeof fastHand>[1], stage: "mid" | "short" = "mid") => fastHand(d, a, base(at), stage, 9, "other")!;

afterEach(() => {
  fastStore.set({});
  fastOtherStore.set({});
});

describe("남의 핸드: the verdict, worded from the player's side", () => {
  it("judges the player against the same chart: 차트보다 루즈 / 타이트 instead of 오버 / 언더플레이", () => {
    // BTN K9o open after folds: in the chart
    const btn = theirs(1, typed("BTN", "K9o"), "open");
    expect(fastVerdictOf(btn)?.text).toBe("✓ 차트대로");
    // BB 72o calling a CO open: looser than the chart
    const bb = theirs(2, typed("BB", "72o", { spot: "open", opener: "CO" }), "call");
    expect(fastVerdictOf(bb)).toMatchObject({ kind: "over", text: "⚠ 차트보다 루즈 (차트: 폴드)" });
    // CO limping AQo: tighter (more passive) than the chart's open
    const limp = theirs(3, typed("CO", "AQo"), "limp");
    expect(fastVerdictOf(limp)).toMatchObject({ kind: "under", text: "▽ 차트보다 타이트 (차트: 오픈)" });
    // the same hands of mine keep their own words
    const mine = fastHand(typed("BB", "72o", { spot: "open", opener: "CO" }), "call", base(4, "mine"), "mid", 9)!;
    expect(fastVerdictOf(mine)?.text).toBe("⚠ 오버플레이 (차트: 폴드)");
    // a limp pot: no chart, the same for both
    expect(fastVerdictOf(theirs(5, typed("BTN", "A5s", { spot: "limp" }), "open"))?.text).toBe("차트 없음 · 림프 팟");
  });

  it("only rewords: kind, chart and frequency stay the verdict's", () => {
    const v = fastVerdict({ stage: "mid", players: 9, seat: "UTG", cls: "K9o", spot: "none", act: "open" });
    expect(theirWords(v)).toEqual({ ...v, text: "⚠ 차트보다 루즈 (차트: 폴드)" });
    const ok = fastVerdict({ stage: "mid", players: 9, seat: "BTN", cls: "K9o", spot: "none", act: "open" });
    expect(theirWords(ok)).toEqual(ok);
    const mixed = { kind: "mixed" as const, text: "△ 섞는 핸드 (30%)", chart: "x", freq: 0.3 };
    expect(theirWords(mixed)).toEqual(mixed);
  });
});

describe("남의 핸드: saving", () => {
  it("saves another player's hand: kind other, fast, their seat and guessed cards, no seat of mine", () => {
    const h = fastHand(typed("BTN", "K9o"), "open", { ...freshHand("other", 1), mySeat: "CO" }, "mid", 9, "other")!;
    expect(h).toMatchObject({ kind: "other", fast: true, fastSpot: "none", seat: "BTN", players: 9, quickPre: { stage: "mid", pinned: true, action: "open" } });
    expect(isOther(h)).toBe(true);
    expect(h.mySeat).toBeUndefined();
    expect(holeClass(h)).toBe("K9o");
    expect(holeGuessed(h)).toBe(true);
    expect(h.holeKind).toBe("offsuit");
    expect(fastActText(h)).toBe("오픈");
    const call = theirs(2, typed("BB", "72o", { spot: "open", opener: "CO" }), "call");
    expect(call).toMatchObject({ kind: "other", seat: "BB", fastSpot: "open", quickPre: { openerSeat: "CO", action: "call" } });
    expect(fastActText(call)).toBe("CO 오픈 → 콜");
    // mine stays mine, even on a base marked other
    expect(isOther(fastHand(typed("BTN", "K9o"), "open", base(3), "mid", 9)!)).toBe(false);
  });

  it("tells the AI review it was the other player's decision, not mine", () => {
    const call = theirs(2, typed("BB", "72o", { spot: "open", opener: "CO" }), "call");
    const facts = handFacts(call);
    expect(facts).toContain("프리플랍 (빠른 기록, 상대 결정 하나): 미들 구간 · BB CO 오픈 → 콜 · 펍 차트 판정 ⚠ 차트보다 루즈 (차트: 폴드)");
    expect(facts).not.toContain("내 결정");
  });

  it("keeps the seat picked for the next hand (no moving on), with 폴드로 상대에게 again", () => {
    const s = state(typed("BTN", "K9o", { spot: "open", opener: "UTG" }));
    const h = theirs(1, s.draft, "call");
    expect(afterSave(s, h, [h], "other")).toEqual(state(newDraft("BTN")));
    // mine moves on
    expect(afterSave(s, fastHand(s.draft, "call", base(1, "mine"), "mid", 9)!, [], "mine").draft.seat).toBe("CO");
    // ten hands in a row from the BB: still the BB
    let cur = state(newDraft("BB"));
    for (let i = 0; i < 10; i++) {
      const x = theirs(10 + i, { ...typed(cur.draft.seat, "AKs"), spot: "open", opener: "CO" }, "3bet");
      cur = afterSave(cur, x, [x], "other");
    }
    expect(cur.draft.seat).toBe("BB");
    // a seat not at this table (a hand corrected at another size): the button
    const six = state(newDraft("BTN"), { players: 6 });
    expect(afterSave(six, theirs(30, typed("UTG+2", "AA"), "open"), [], "other").draft.seat).toBe("BTN");
  });

  it("corrects a saved one in place and gives back the hand put aside, at its seat", () => {
    const h = theirs(1, typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call");
    const typing = state(typed("SB", "A"));
    const s = startEdit(typing, h, "other");
    expect(s.draft).toEqual(draftOf(h));
    expect(s.parked).toEqual(typing.draft);
    const fixed = fastHand(s.draft, "fold", h, "mid", 9, "other")!;
    expect(fixed).toMatchObject({ id: h.id, kind: "other", createdAt: h.createdAt, quickPre: { action: "fold" } });
    expect(afterSave(s, fixed, [fixed], "other")).toEqual(typing);
    // the editors take only their own kind
    expect(startEdit(typing, h)).toBe(typing);
    const mine = fastHand(typed("HJ", "K9s"), "open", base(2, "mine"), "mid", 9)!;
    expect(startEdit(typing, mine, "other")).toBe(typing);
  });

  it("keeps today's lists apart: mine on 빠른 기록, others' on 남의 핸드", () => {
    const now = 10_000_000;
    const o1 = theirs(now - 60_000, typed("BTN", "K9o"), "open");
    const o2 = theirs(now - 120_000, typed("BB", "72o", { spot: "open", opener: "CO" }), "call");
    const m1 = fastHand(typed("CO", "AJo"), "open", base(now - 30_000, "mine"), "mid", 9)!;
    const hands = [m1, o1, o2];
    expect(sessionOf(hands, now).map((h) => h.id)).toEqual([m1.id]);
    expect(sessionOf(hands, now, "other").map((h) => h.id)).toEqual([o1.id, o2.id]);
    expect(fastStats(sessionOf(hands, now, "other"))).toMatchObject({ total: 2, graded: 2, by: { ok: 1, over: 1 }, okPct: 50 });
  });

  it("copies today's 남의 핸드 as their own summary", () => {
    const now = new Date(2026, 10, 8, 22, 0).getTime();
    const hands = [theirs(now - 60_000, typed("BB", "72o", { spot: "open", opener: "CO" }), "call"), theirs(now - 120_000, typed("BTN", "K9o"), "open"), theirs(now - 180_000, typed("CO", "AQo"), "limp")];
    const t = sessionText(hands, "other");
    expect(t.split("\n")[0]).toMatch(/^PubAJ 남의 핸드 · 11월 8일 \(일\) · 3핸드/);
    expect(t).toContain("차트대로 1/3 (33%) · 섞는 핸드 0 · 차트보다 루즈 1 · 차트보다 타이트 1 · 차트 없음 0");
    expect(t).toMatch(/\[차트보다 루즈\]\n- \d\d:\d\d 미들 BB 72o CO 오픈 → 콜 ⚠ 차트보다 루즈 \(차트: 폴드\)/);
    expect(t).toMatch(/\[차트보다 타이트\]\n- \d\d:\d\d 미들 CO AQo 림프 ▽ 차트보다 타이트 \(차트: 오픈\)/);
    expect(t).not.toContain("오버플레이");
    expect(t).not.toContain("빠른 기록");
  });
});

describe("남의 핸드: its editor", () => {
  it("has its own store, so a hand typed on one screen never shows on the other", () => {
    expect(storeFor("mine")).toBe(fastStore);
    expect(storeFor("other")).toBe(fastOtherStore);
    fastStore.set(state(typed("CO", "AJo")));
    expect(cleanFastState(fastOtherStore.get()).draft.ranks).toEqual([]);
  });

  it("takes 빠른 기록's table on a first visit and follows its stage and table size", () => {
    // a first visit: the stage and size given as the fallbacks
    expect(cleanFastState({}, "short", 6)).toEqual(state(newDraft("BTN"), { stage: "short", players: 6 }));
    // a stored size wins over the fallback; a bad fallback is 9
    expect(cleanFastState({ players: 8 }, "mid", 6).players).toBe(8);
    expect(cleanFastState({}, "mid", 42).players).toBe(9);
    // shared: the seat stays if the new table has it, else the button
    const s = state(typed("UTG+2", "AJo"));
    expect(shareTable(s, "deep", 9)).toEqual({ ...s, stage: "deep" });
    expect(shareTable(s, "short", 6)).toEqual(state(withSeat(s.draft, "BTN", 6), { stage: "short", players: 6 }));
    expect(shareTable(s, "short", 42)).toBe(s);
    // a hand being corrected keeps its own; the one put aside follows
    const h = theirs(1, typed("UTG+2", "K9s"), "open");
    const editing = startEdit(s, h, "other");
    const shared = shareTable(editing, "push", 6);
    expect(shared.draft).toEqual(editing.draft);
    expect(shared.parked?.seat).toBe("BTN");
  });

});
