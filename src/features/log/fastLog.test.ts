import { describe, expect, it } from "vitest";
import { RANKS } from "../../poker/cards";
import {
  afterSave,
  cancelEdit,
  classDone,
  cleanFastState,
  draftClass,
  draftOf,
  draftReady,
  fastHand,
  fastStats,
  newDraft,
  nextSeat,
  pickSuited,
  sessionOf,
  sessionText,
  startEdit,
  tapRank,
  undoTap,
  withSeat,
  withSpot,
  type FastDraft,
  type FastState,
} from "./fastLog";
import {
  emptyHand,
  exportData,
  fastActText,
  fastVerdictOf,
  handFacts,
  holeClass,
  holeGuessed,
  mergeImport,
  migrateStore,
  resumable,
  sanitize,
  tableOf,
  tablePre,
  unfinished,
  type LoggedHand,
} from "./handLog";
import { preSteps } from "./quickPre";

const R = (k: string) => RANKS.indexOf(k);
/** A draft typed on the pad: "AJo", "K9s", "55". */
function typed(seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft {
  let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
  if (cls[2]) d = pickSuited(d, cls[2] === "s");
  return { ...d, ...extra };
}
const base = (at = 1_000_000): LoggedHand => ({ ...emptyHand(null), id: `h${at}`, createdAt: at, updatedAt: at });
const state = (draft: FastDraft, extra: Partial<FastState> = {}): FastState => ({ stage: "mid", players: 9, draft, parked: null, ...extra });

describe("빠른 기록: my seat moves on by itself", () => {
  /** The seats I sit in over `n` hands from `seat`. */
  const walk = (players: number, seat: string, n: number) => {
    const out = [seat];
    for (let i = 0; i < n; i++) out.push(nextSeat(players, out[out.length - 1]));
    return out;
  };
  it("goes one seat earlier each hand as the button moves clockwise, round the table", () => {
    expect(walk(9, "BTN", 9)).toEqual(["BTN", "CO", "HJ", "LJ", "UTG+2", "UTG+1", "UTG", "BB", "SB", "BTN"]);
    expect(walk(6, "BTN", 6)).toEqual(["BTN", "CO", "HJ", "UTG", "BB", "SB", "BTN"]);
    expect(walk(10, "BTN", 10)).toEqual(["BTN", "CO", "HJ", "LJ", "MP", "UTG+2", "UTG+1", "UTG", "BB", "SB", "BTN"]);
    // every table size comes back round to where it started
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10]) expect(walk(n, "BTN", n).at(-1)).toBe("BTN");
    // a seat not at this table: the button
    expect(nextSeat(6, "UTG+2")).toBe("BTN");
  });
});

describe("빠른 기록: the class on the rank pad", () => {
  it("takes two ranks in any order, a pair at once, suitedness for the rest; ⌫ undoes the last tap", () => {
    let d = tapRank(newDraft("BTN"), R("J"));
    expect(draftClass(d)).toBe("J");
    d = tapRank(d, R("A"));
    expect(draftClass(d)).toBe("AJ");
    expect(classDone(d)).toBe(false);
    expect(draftClass(pickSuited(d, false))).toBe("AJo");
    expect(draftClass(pickSuited(d, true))).toBe("AJs");
    expect(classDone(pickSuited(d, true))).toBe(true);
    // a pair is done with two taps; suitedness doesn't apply
    const p = tapRank(tapRank(newDraft("BTN"), R("5")), R("5"));
    expect([draftClass(p), classDone(p), pickSuited(p, true)]).toEqual(["55", true, p]);
    // ⌫: the suitedness, then the second rank, then the first
    let u = pickSuited(d, true);
    u = undoTap(u);
    expect(draftClass(u)).toBe("AJ");
    u = undoTap(u);
    expect(draftClass(u)).toBe("J");
    expect(draftClass(undoTap(u))).toBe("");
    // a third rank starts a new class
    expect(draftClass(tapRank(pickSuited(d, true), R("7")))).toBe("7");
    // but not while correcting a saved hand: a full class stays until ⌫ (a next hand typed into a correction by mistake)
    const fixing = { ...pickSuited(d, true), editing: "h1" };
    expect(tapRank(fixing, R("7"))).toBe(fixing);
    expect(draftClass(tapRank(undoTap(undoTap(fixing)), R("Q")))).toBe("QJ");
    expect(draftClass(tapRank({ ...d, editing: "h1" }, R("7")))).toBe("7");
  });

  it("keeps the opener only before me and the spot only where it can happen", () => {
    const d = withSpot({ ...typed("CO", "K9s"), opener: null }, "open");
    const opened = { ...d, opener: "HJ" };
    expect(draftReady(d, 9)).toBe(false);
    expect(draftReady(opened, 9)).toBe(true);
    // moving to a seat before the opener drops it; to UTG the open can't happen at all
    expect(withSeat(opened, "LJ", 9).opener).toBeNull();
    expect(withSeat(opened, "BTN", 9).opener).toBe("HJ");
    expect(withSeat(opened, "UTG", 9)).toMatchObject({ spot: "none", opener: null });
    // open ↔ shove keep the seat; any other spot drops it
    expect(withSpot(opened, "shove").opener).toBe("HJ");
    expect(withSpot(opened, "limp").opener).toBeNull();
    expect(draftReady(typed("BTN", "AJ"), 9)).toBe(false);
  });
});

describe("빠른 기록: the saved hand", () => {
  it("is a LoggedHand of mine with the class as guessed cards, the block for the table and the spot", () => {
    const h = fastHand(typed("BTN", "AJo"), "open", base(), "mid", 9)!;
    expect(h).toMatchObject({ seat: "BTN", players: 9, fast: true, fastSpot: "none", note: "", result: null, quickPre: { stage: "mid", pinned: true, action: "open" } });
    expect(h.kind).toBeUndefined();
    expect(holeGuessed(h)).toBe(true);
    expect(h.holeKind).toBe("offsuit");
    expect(holeClass(h)).toBe("AJo");
    expect(fastVerdictOf(h)?.text).toBe("✓ 차트대로");
    expect(fastActText(h)).toBe("오픈");
    // suited, a pair (no holeKind for a pair)
    expect(holeClass(fastHand(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!)).toBe("K9s");
    const pair = fastHand(typed("LJ", "55"), "fold", base(), "mid", 9)!;
    expect([holeClass(pair), pair.holeKind]).toEqual(["55", undefined]);
    // facing an open: the opener in the block; facing a shove: the open was an all-in
    const call = fastHand(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
    expect(call.quickPre).toEqual({ stage: "mid", pinned: true, action: "call", openerSeat: "UTG" });
    expect(fastActText(call)).toBe("UTG 오픈 → 콜");
    expect(fastVerdictOf(call)?.text).toBe("⚠ 오버플레이 (차트: 폴드)");
    const shove = fastHand(typed("BB", "TT", { spot: "shove", opener: "UTG" }), "call", base(), "short", 9)!;
    expect(shove.quickPre).toEqual({ stage: "short", pinned: true, action: "call", openAllIn: true, openerSeat: "UTG" });
    // a walk at the BB has no action
    const walk = fastHand(typed("BB", "72o"), undefined, base(), "mid", 9)!;
    expect([walk.quickPre, fastActText(walk), fastVerdictOf(walk)?.text]).toEqual([{ stage: "mid", pinned: true }, "워크", "워크"]);
  });

  it("refuses a draft that isn't ready or an action the spot doesn't offer", () => {
    expect(fastHand(typed("BTN", "AJ"), "open", base(), "mid", 9)).toBeNull();
    expect(fastHand(typed("HJ", "K9s", { spot: "open" }), "call", base(), "mid", 9)).toBeNull();
    expect(fastHand(typed("BTN", "AJo"), "call", base(), "mid", 9)).toBeNull();
    expect(fastHand(typed("BTN", "AJo"), undefined, base(), "mid", 9)).toBeNull();
    expect(fastHand(typed("BB", "AJo"), "open", base(), "mid", 9)).toBeNull();
  });

  it("goes onto the table only where the block can place it", () => {
    const at = (d: FastDraft, a: Parameters<typeof fastHand>[1]) => fastHand(d, a, base(), "mid", 9)!;
    const open = at(typed("BTN", "AJo"), "open");
    expect(preSteps(tableOf(open), tablePre(open)).map((s) => s.s)).toEqual(["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"]);
    const call = at(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call");
    expect(tablePre(call)).toBe(call.quickPre);
    // limps, a 3-bet and a fold facing an open have no place in the block: nothing is placed
    expect(tablePre(at(typed("BTN", "AJo", { spot: "limp" }), "open"))).toBeUndefined();
    expect(tablePre(at(typed("CO", "QQ", { spot: "3bet" }), "allin"))).toBeUndefined();
    const cold = at(typed("BTN", "QQ", { spot: "cold3" }), "call");
    expect([tablePre(cold), cold.fastSpot, fastActText(cold), fastVerdictOf(cold)?.kind]).toEqual([undefined, "cold3", "오픈·3벳 → 콜", "ok"]);
    expect(tablePre(at(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "fold"))).toBeUndefined();
  });

  it("is complete as it is: not 작성 중, never offered for 이어서 기록", () => {
    const h = { ...fastHand(typed("BTN", "AJo"), "open", base(), "mid", 9)!, updatedAt: Date.now() };
    expect(unfinished(h)).toBe(false);
    expect(resumable([h], Date.now())).toBeNull();
    // carried on to the table it is a table hand again
    expect(unfinished({ ...h, steps: preSteps(tableOf(h), h.quickPre) })).toBe(true);
  });

  it("tells the coach the decision and the verdict", () => {
    const h = fastHand(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
    expect(handFacts(h)).toContain("프리플랍 (빠른 기록, 내 결정 하나): 미들 구간 · HJ UTG 오픈 → 콜 · 펍 차트 판정 ⚠ 오버플레이 (차트: 폴드) (HJ vs EP 오픈 · 폴드 100%)");
  });
});

describe("빠른 기록: saving, 되돌리기 and corrections as state", () => {
  it("moves on to the next seat with a clear hand after a save", () => {
    const s = state(typed("BTN", "AJo"));
    const h = fastHand(s.draft, "open", base(), "mid", 9)!;
    expect(afterSave(s, h, [h])).toEqual(state(newDraft("CO")));
  });

  it("opens a saved hand in the editor and puts the new one aside; saving it gives that one back", () => {
    const h1 = fastHand(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call", base(1), "mid", 9)!;
    // 되돌리기 right after: the next hand (LJ, nothing typed) goes aside
    const next = state(newDraft("LJ"));
    const editing = startEdit(next, h1);
    expect(editing.draft).toMatchObject({ seat: "HJ", ranks: [R("K"), R("9")], suited: true, spot: "open", opener: "UTG", editing: h1.id, stage: "mid", players: 9 });
    expect(editing.parked).toEqual(newDraft("LJ"));
    // corrected to a fold and saved: back to the next hand
    const fixed = fastHand(editing.draft, "fold", h1, "mid", 9)!;
    expect(fixed.id).toBe(h1.id);
    expect(fixed.createdAt).toBe(1);
    expect(fastVerdictOf(fixed)?.text).toBe("✓ 차트대로");
    expect(afterSave(editing, fixed, [fixed])).toEqual(state(newDraft("LJ")));
    // its seat corrected (it was really the LJ): the next seat follows
    const moved = fastHand(withSeat(editing.draft, "LJ", 9), "fold", h1, "mid", 9)!;
    expect(afterSave(editing, moved, [moved]).draft.seat).toBe("UTG+2");
    // 취소: the new hand back, the saved one untouched
    expect(cancelEdit(editing)).toEqual(state(newDraft("LJ")));
  });

  it("corrects an older hand without moving the seat of the hand being typed", () => {
    const old = fastHand(typed("BTN", "AJo"), "open", base(1), "mid", 9)!;
    const newer = fastHand(typed("CO", "72o"), "fold", base(2), "mid", 9)!;
    const typing = state(typed("HJ", "QQ"));
    const s = startEdit(typing, old);
    const fixed = fastHand(s.draft, "limp", old, "mid", 9)!;
    expect(afterSave(s, fixed, [newer, fixed]).draft).toEqual(typing.draft);
    // a second hand opened while correcting keeps the first new hand aside
    expect(startEdit(s, newer).parked).toEqual(typing.draft);
  });

  it("only opens hands still just a 빠른 기록 (one carried on to the table opens on the table)", () => {
    const h = fastHand(typed("BTN", "AJo"), "open", base(), "mid", 9)!;
    const s = state(newDraft("CO"));
    expect(startEdit(s, { ...h, steps: preSteps(tableOf(h), h.quickPre) })).toBe(s);
    expect(draftOf(h).suited).toBe(false);
  });

  it("reads the stored editor state back with valid fields only", () => {
    expect(cleanFastState(undefined, "deep")).toEqual(state(newDraft("BTN"), { stage: "deep" }));
    expect(cleanFastState({ stage: "short", players: 6, draft: { seat: "CO", ranks: [12, 9], suited: true, spot: "open", opener: "UTG" } })).toEqual(
      state({ seat: "CO", ranks: [12, 9], suited: true, spot: "open", opener: "UTG", editing: null }, { stage: "short", players: 6 }),
    );
    // junk: a seat not at the table, ranks out of range, an opener after me, a spot that can't happen
    expect(cleanFastState({ stage: "x", players: 42, draft: { seat: "MP", ranks: [99, 3, 3, 3], suited: "yes", spot: "open", opener: "BTN" }, parked: { seat: "CO" } })).toEqual(
      state({ seat: "BTN", ranks: [3, 3], suited: null, spot: "open", opener: null, editing: null }),
    );
    expect(cleanFastState({ draft: { seat: "UTG", spot: "limp" } }).draft.spot).toBe("none");
  });
});

describe("빠른 기록: today's hands", () => {
  const H = 60 * 60 * 1000;
  const at = (t: number, d: FastDraft, a: Parameters<typeof fastHand>[1]) => fastHand(d, a, base(t), "mid", 9)!;
  const NOW = new Date(2026, 10, 8, 23, 0).getTime();
  const hands = [
    at(NOW - 10 * 60_000, typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call"),
    at(NOW - 20 * 60_000, typed("LJ", "55"), "fold"),
    at(NOW - 30 * 60_000, typed("CO", "72o"), "fold"),
    at(NOW - 40 * 60_000, typed("BTN", "AJo"), "open"),
    at(NOW - 50 * 60_000, typed("BTN", "AJo", { spot: "limp" }), "call"),
    // yesterday's session, and a hand that isn't a 빠른 기록
    at(NOW - 20 * H, typed("BTN", "AA"), "open"),
    { ...base(NOW - 5 * 60_000), seat: "BTN" },
  ];

  it("is the run of 빠른 기록 hands back to a 6-hour pause, none once the newest is over 12 hours old", () => {
    expect(sessionOf(hands, NOW).map((h) => h.createdAt)).toEqual([10, 20, 30, 40, 50].map((m) => NOW - m * 60_000));
    expect(sessionOf(hands, NOW + 13 * H)).toEqual([]);
    expect(sessionOf([], NOW)).toEqual([]);
  });

  it("counts the verdicts, 차트대로 out of the hands with a chart", () => {
    expect(fastStats(sessionOf(hands, NOW))).toEqual({ total: 5, by: { ok: 2, mixed: 0, over: 1, under: 1, none: 1 }, graded: 4, okPct: 50 });
  });

  it("copies as short text: the counts, overplays and underplays first, then every hand", () => {
    const t = sessionText(sessionOf(hands, NOW));
    const lines = t.split("\n");
    expect(lines[0]).toMatch(/^PubAJ 빠른 기록 · 11월 8일 \(일\) · 5핸드/);
    expect(lines[1]).toBe("차트대로 2/4 (50%) · 섞는 핸드 0 · 오버플레이 1 · 언더플레이 1 · 차트 없음 1");
    expect(t).toContain("[오버플레이]\n- 22:50 미들 HJ K9s UTG 오픈 → 콜 ⚠ 오버플레이 (차트: 폴드)");
    expect(t).toContain("[언더플레이]\n- 22:40 미들 LJ 55 폴드 ▽ 언더플레이 (차트: 오픈)");
    expect(t).toContain("[전체 · 시간순]\n1. 22:10 미들 BTN AJo 림프 → 콜 차트 없음 · 림프 팟\n2. 22:20 미들 BTN AJo 오픈 ✓ 차트대로");
    expect(sessionText([])).toBe("");
  });
});

describe("빠른 기록: on file and in the backup", () => {
  const h = fastHand(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call", base(5), "mid", 9)!;

  it("keeps the flag and the spot through sanitize, export and import", () => {
    expect(sanitize(JSON.parse(JSON.stringify(h)))).toEqual(h);
    const { hands } = mergeImport(exportData([h]), []);
    expect(hands[0]).toMatchObject({ fast: true, fastSpot: "open", quickPre: { openerSeat: "UTG", action: "call" } });
    expect(fastVerdictOf(hands[0])?.text).toBe("⚠ 오버플레이 (차트: 폴드)");
    // a bad flag or spot goes; a spot without the flag goes
    expect(sanitize({ ...h, fast: "yes" })).not.toHaveProperty("fast");
    expect(sanitize({ ...h, fast: "yes" })).not.toHaveProperty("fastSpot");
    expect(sanitize({ ...h, fastSpot: "river" })).toMatchObject({ fast: true });
    expect(sanitize({ ...h, fastSpot: "river" })).not.toHaveProperty("fastSpot");
    const { fast: _f, ...noFlag } = h;
    void _f;
    expect(sanitize(noFlag)).not.toHaveProperty("fastSpot");
  });

  it("is left alone by the load-time migration, and cleaned when stored wrong", () => {
    expect(migrateStore({ hands: [h], lastLevel: null }, null)).toBeNull();
    const fixed = migrateStore({ hands: [{ ...h, fastSpot: "nope" as never }], lastLevel: null }, null);
    expect(fixed?.hands[0]).not.toHaveProperty("fastSpot");
  });
});
