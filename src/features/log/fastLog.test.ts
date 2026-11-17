import { describe, expect, it } from "vitest";
import { RANKS } from "../../poker/cards";
import {
  afterSave,
  backKey,
  blockOf,
  cancelEdit,
  classDone,
  cleanFastState,
  draftClass,
  draftOf,
  draftReady,
  fastHand,
  fastLevel,
  fastLineText,
  fastStats,
  freshDraft,
  keptAction,
  newDraft,
  nextSeat,
  pickRes,
  pickSuited,
  sessionOf,
  sessionText,
  SESSION_IDLE_MS,
  startEdit,
  switchUnit,
  tapBoardRank,
  tapBoardSuit,
  tapRank,
  typeDigit,
  undoTap,
  withFastResult,
  withSeat,
  withSpot,
  type FastDraft,
  type FastLevel,
  type FastState,
} from "./fastLog";
import {
  emptyHand,
  exportData,
  fastActed,
  fastActText,
  fastOnly,
  fastVerdictOf,
  handFacts,
  handLogStore,
  holeClass,
  holeGuessed,
  localDay,
  mergeImport,
  migrateStore,
  rememberedText,
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

describe("빠른 기록 v2: a hand saved without a decision, with its chips and board", () => {
  const LV5: FastLevel = { level: 5, guessed: false };
  /** The draft saved as the default screen saves it: no decision, the result, board and 지금 스택 at `lv`. */
  const saved = (d: FastDraft, lv = LV5, bbAnte = true, b: LoggedHand = base()) => {
    const h = fastHand(d, null, b, "mid", 9);
    return h && withFastResult(h, d, lv, bbAnte);
  };

  it("is a 빠른 기록 hand with no spot or preflop block, no verdict, complete as it is", () => {
    const h = fastHand(typed("BTN", "AKs"), null, { ...base(), quickPre: { stage: "deep", pinned: true, action: "open" }, fastSpot: "none" }, "mid", 9)!;
    expect(h).toMatchObject({ seat: "BTN", fast: true, result: null, net: null });
    expect(h).not.toHaveProperty("fastSpot");
    expect(h).not.toHaveProperty("quickPre");
    expect(holeClass(h)).toBe("AKs");
    expect([fastActed(h), fastVerdictOf(h), fastOnly(h), unfinished(h)]).toEqual([false, null, true, false]);
    // only my seat at the table and a complete class are needed
    expect(fastHand(typed("BTN", "AK"), null, base(), "mid", 9)).toBeNull();
    expect(fastHand(typed("UTG+2", "AKs"), null, base(), "mid", 6)).toBeNull();
    // the walk keeps being a decision (graded as 워크): a BB result-only hand isn't one
    expect(fastActed(fastHand(typed("BB", "72o"), undefined, base(), "mid", 9)!)).toBe(true);
    expect(fastVerdictOf(saved(typed("BB", "72o"))!)).toBeNull();
  });

  it("saves 폴드 by the seat, 워크, + / − in chips or bb, a chop, at the level given", () => {
    const fold = (seat: string, extra: Partial<FastDraft> = {}, lv = LV5, ante = true) => saved({ ...pickRes(typed(seat, "94o"), "fold"), ...extra }, lv, ante)!;
    expect([fold("CO").result, fold("CO").net]).toEqual(["fold", 0]);
    expect(fold("SB").net).toBe(-300);
    expect(fold("BB").net).toBe(-1200);
    expect(fold("BB", {}, LV5, false)).toMatchObject({ net: -600, bbAnte: false });
    expect(fold("BB", {}, { level: null, guessed: false })).toMatchObject({ result: "fold", net: null, level: null });
    expect(saved(pickRes(typed("BB", "94o"), "walk"))).toMatchObject({ result: "win", net: 300 });
    const win = saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" })!;
    expect(win).toMatchObject({ result: "win", net: 12000, level: 5 });
    expect(win).not.toHaveProperty("levelGuess");
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "-"), amount: "8", unit: "bb" })).toMatchObject({ result: "lose", net: -4800 });
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "0" })).toMatchObject({ result: "chop", net: 0 });
    // the start-time estimate is marked as one
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" }, { level: 9, guessed: true })).toMatchObject({ level: 9, levelGuess: true });
    // blocked: an amount without its sign, bb without a level
    expect(saved({ ...typed("BTN", "AKs"), amount: "12000" })).toBeNull();
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb" }, { level: null, guessed: false })).toBeNull();
    expect(blockOf({ ...typed("BTN", "AKs"), amount: "12000" }, 9, 5, true)).toBe("sign");
    expect(blockOf({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb" }, 9, null, true)).toBe("level");
    expect(blockOf(typed("BTN", "AK"), 9, 5, true)).toBe("class");
    expect(blockOf(typed("BTN", "AKs"), 9, 5, true)).toBeNull();
  });

  it("saves the board remembered with the 숫자만 marks, a typed card winning over the guessed hole cards", () => {
    const h = saved({ ...typed("BTN", "AKs"), board: [{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }] })!;
    expect(h.board).toHaveLength(3);
    expect(h.guess).toEqual({ hole: true, board: [1, 2] });
    expect(rememberedText(h)).toBe("K♥ 7 2");
    expect(fastOnly(h)).toBe(true);
    // the class guessed as A♠K♠; a K♠ typed on the board moves the guess, the board keeps every card
    const ks = saved({ ...typed("BTN", "AKs"), board: [{ r: R("K"), s: 0 }, { r: R("7") }, { r: R("2") }] })!;
    expect(ks.board[0]).toBe(R("K") * 4);
    expect(ks.hole).not.toContain(R("K") * 4);
    expect(holeClass(ks)).toBe("AKs");
    expect(ks.board).toHaveLength(3);
    // a board the class can't be dealt with is refused, not cut: AKs with A♠ A♦ K♥ K♣ out leaves no suited AK
    const none = { ...typed("BTN", "AKs"), board: [{ r: R("A"), s: 0 }, { r: R("A"), s: 2 }, { r: R("K"), s: 1 }, { r: R("K"), s: 3 }] };
    expect(saved(none)).toBeNull();
    expect(blockOf(none, 9, 5, true)).toBe("board");
  });

  it("keeps 지금 스택 as the hand's start stack (now − net), refused below zero", () => {
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "64200" })).toMatchObject({ stack: 52200 });
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb", stackNow: "107" })).toMatchObject({ net: 12000, stack: 52200 });
    expect(saved({ ...pickRes(typed("BB", "AKs"), "fold"), stackNow: "30000" })).toMatchObject({ net: -1200, stack: 31200 });
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "5000" })).toBeNull();
    expect(blockOf({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "5000" }, 9, 5, true)).toBe("stack");
    expect(saved(typed("BTN", "AKs"))?.stack).toBeNull();
  });

  it("comes back in the editor as it was typed, and saves the same hand untouched", () => {
    const d: FastDraft = { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "64200", board: [{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }] };
    const h = saved(d)!;
    const back = draftOf(h);
    expect(back).toMatchObject({ seat: "BTN", res: "+", amount: "12000", stackNow: "64200", board: d.board, level: 5, editing: h.id });
    expect(back).not.toHaveProperty("unit");
    const again = withFastResult(fastHand(back, null, h, "mid", 9)!, back, { level: back.level ?? null, guessed: !!back.levelGuess }, !back.noAnte)!;
    expect(again).toEqual(h);
    // in bb when exact there to 0.1bb, else in chips
    expect(draftOf(h, "bb")).toMatchObject({ unit: "bb", amount: "20", stackNow: "107" });
    const odd = saved({ ...pickRes(typed("BTN", "AKs"), "-"), amount: "12345" })!;
    expect(draftOf(odd, "bb")).toMatchObject({ res: "-", amount: "12345" });
    expect(draftOf(odd, "bb")).not.toHaveProperty("unit");
    // a fold, a chop, a hand without a result
    expect(draftOf(saved(pickRes(typed("BB", "94o"), "fold"))!)).toMatchObject({ res: "fold" });
    expect(draftOf(saved({ ...pickRes(typed("BB", "94o"), "+"), amount: "0" })!)).toMatchObject({ res: "+", amount: "0" });
    expect(draftOf(saved(typed("BB", "94o"))!)).not.toHaveProperty("res");
    // an old hand: no result fields, its level and ante only
    const old = fastHand(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
    expect(Object.keys(draftOf(old)).sort()).toEqual(["editing", "level", "opener", "players", "ranks", "seat", "spot", "stage", "suited"]);
  });

  it("keeps a corrected hand's decision while it still fits, drops it when it doesn't", () => {
    const call = fastHand(typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
    expect(keptAction(call, draftOf(call))).toBe("call");
    expect(keptAction(call, withSpot(draftOf(call), "none"))).toBeNull();
    const walk = fastHand(typed("BB", "72o"), undefined, base(), "mid", 9)!;
    expect(keptAction(walk, draftOf(walk))).toBeUndefined();
    expect(keptAction(walk, withSeat(draftOf(walk), "SB", 9))).toBeNull();
    expect(keptAction(saved(typed("BTN", "AKs"))!, typed("BTN", "AKs"))).toBeNull();
  });
});

describe("빠른 기록 v2: the keypad's fields", () => {
  const done = typed("BTN", "AKs");
  it("takes 땄음 / 잃음 to the amount, 폴드 / 워크 drop it; digits go where the keypad is", () => {
    const won = pickRes(done, "+");
    expect(won).toMatchObject({ res: "+", focus: "result" });
    const typedIn = ["1", "2", "000"].reduce(typeDigit, won);
    expect(typedIn.amount).toBe("12000");
    expect(pickRes(typedIn, "fold")).not.toHaveProperty("amount");
    // 지금 스택 has its own text
    const st = ["6", "4", "2", "00"].reduce(typeDigit, { ...typedIn, focus: "stack" as const });
    expect([st.amount, st.stackNow]).toEqual(["12000", "64200"]);
    // the hand has the keypad: digits do nothing; an amount typed after 폴드 asks for its sign
    expect(typeDigit(done, "5")).toBe(done);
    expect(typeDigit({ ...done, res: "fold", focus: "result" }, "5")).toEqual({ ...done, focus: "result", amount: "5" });
    // the class not complete yet: the keypad is the hand's whatever the focus says
    expect(typeDigit({ ...typed("BTN", "AK"), focus: "result" }, "5").amount).toBeUndefined();
  });

  it("puts board ranks and the last card's suit, refusing what can't be dealt", () => {
    let d: FastDraft = { ...done, focus: "board" };
    d = tapBoardRank(d, R("K"));
    d = tapBoardSuit(d, 1);
    d = tapBoardRank(tapBoardRank(d, R("7")), R("2"));
    expect(d.board).toEqual([{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }]);
    // the suit again: back to the rank only; a card already there: refused
    expect(tapBoardSuit(d, 2).board?.[2]).toEqual({ r: R("2"), s: 2 });
    expect(tapBoardSuit(tapBoardSuit(d, 2), 2).board?.[2]).toEqual({ r: R("2") });
    const twoK = tapBoardRank(d, R("K"));
    expect(tapBoardSuit(twoK, 1)).toBe(twoK);
    // a fifth K counting the class's, and a sixth card: refused
    const kkk = [1, 2, 3].reduce((x) => tapBoardRank(x, R("K")), { ...done, board: [] } as FastDraft);
    expect(kkk.board).toHaveLength(3);
    expect(tapBoardRank(kkk, R("K"))).toBe(kkk);
    const five = [3, 4, 5].reduce((x, r) => tapBoardRank(x, r), d);
    expect(five.board).toHaveLength(5);
    expect(tapBoardRank(five, 6)).toBe(five);
  });

  it("walks ⌫ back through the field: the board's suit, its cards, the amount, its sign, the hand", () => {
    let d: FastDraft = { ...pickRes(done, "-"), amount: "48", board: [{ r: R("K"), s: 1 }], focus: "board" };
    d = backKey(d);
    expect(d.board).toEqual([{ r: R("K") }]);
    d = backKey(d);
    expect(d).not.toHaveProperty("board");
    d = backKey(d);
    expect(d.focus).toBe("result");
    d = backKey(backKey(d));
    expect(d).not.toHaveProperty("amount");
    d = backKey(d);
    expect(d).not.toHaveProperty("res");
    d = backKey(d);
    expect(d).not.toHaveProperty("focus");
    expect(draftClass(backKey(d))).toBe("AK");
    // 지금 스택 empties, then the board has the keypad
    expect(backKey(backKey({ ...done, stackNow: "5", focus: "stack" }))).toMatchObject({ focus: "board" });
  });

  it("turns the amounts into the other unit at the level, or keeps the digits without one when they fit", () => {
    const d: FastDraft = { ...pickRes(done, "+"), amount: "12345", stackNow: "64200" };
    expect(switchUnit(d, "bb", 5)).toMatchObject({ unit: "bb", amount: "20.6", stackNow: "107" });
    expect(switchUnit(switchUnit(d, "bb", 5), "chips", 5)).toMatchObject({ amount: "12360", stackNow: "64200" });
    expect(switchUnit(switchUnit(d, "bb", 5), "chips", 5)).not.toHaveProperty("unit");
    expect(switchUnit({ ...done, amount: "20" }, "bb", null)).toMatchObject({ unit: "bb", amount: "20" });
    const big = { ...done, amount: "12000" };
    expect(switchUnit(big, "bb", null)).toBe(big);
  });
});

describe("빠른 기록 v2: the editor state", () => {
  it("starts the next hand in the unit last used, clear of the result, board and focus", () => {
    const s = state({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb", board: [{ r: 3 }], focus: "board" }, { unit: "bb" });
    const h = fastHand(s.draft, null, base(), "mid", 9)!;
    expect(afterSave(s, h, [h]).draft).toEqual({ ...newDraft("CO"), unit: "bb" });
    expect(freshDraft({}, "CO")).toEqual(newDraft("CO"));
    expect(cancelEdit({ ...s, draft: { ...s.draft, editing: "x" } }).draft).toEqual({ ...newDraft("BTN"), unit: "bb" });
    // a correction opens in the unit shown
    const won = withFastResult(fastHand({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" }, null, base(), "mid", 9)!, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" }, { level: 5, guessed: false }, true)!;
    expect(startEdit(s, won).draft).toMatchObject({ unit: "bb", amount: "20" });
  });

  it("reads the stored state with the new fields kept when valid and dropped when not", () => {
    const at = 1_000;
    const good = cleanFastState({
      stage: "mid",
      players: 9,
      unit: "bb",
      view: "bb",
      actions: true,
      noAnte: true,
      levelPick: { level: 5, at },
      draft: { seat: "BB", ranks: [12, 11], suited: true, res: "walk", amount: "20.5", stackNow: "107", unit: "bb", board: [{ r: 11, s: 1 }, { r: 5 }], focus: "board" },
    });
    expect(good).toMatchObject({ unit: "bb", view: "bb", actions: true, noAnte: true, levelPick: { level: 5, at } });
    expect(good.draft).toMatchObject({ res: "walk", amount: "20.5", stackNow: "107", unit: "bb", board: [{ r: 11, s: 1 }, { r: 5 }], focus: "board" });
    expect(cleanFastState({ levelPick: { level: null, at } }).levelPick).toEqual({ level: null, at });
    const bad = cleanFastState({
      unit: "x",
      view: 1,
      actions: "yes",
      levelPick: { level: 99, at },
      draft: { seat: "CO", ranks: [12, 11], suited: true, res: "walk", amount: "12a", stackNow: "1.5", board: [{ r: 12 }, { r: 12 }, { r: 12 }, { r: 12 }, { r: 12 }], focus: "x", level: 5, levelGuess: true, noAnte: true },
    });
    expect(bad).toEqual(state({ seat: "CO", ranks: [12, 11], suited: true, spot: "none", opener: null, editing: null }));
    expect(cleanFastState({ draft: { seat: "CO", board: [{ r: 1, s: 0 }, { r: 1, s: 0 }] } }).draft).not.toHaveProperty("board");
    expect(cleanFastState({ draft: { seat: "CO", board: [1, 2, 3, 4, 5, 6].map((r) => ({ r })) } }).draft).not.toHaveProperty("board");
    expect(cleanFastState({ draft: { seat: "CO", amount: "20.5" } }).draft).not.toHaveProperty("amount");
    expect(cleanFastState({ levelPick: { level: 5 } })).not.toHaveProperty("levelPick");
    // a correction keeps its own level, the estimate's mark only with a level
    const fixing = cleanFastState({ draft: { seat: "CO", editing: "h1", level: 5, levelGuess: true, noAnte: true } }).draft;
    expect(fixing).toMatchObject({ level: 5, levelGuess: true, noAnte: true });
    expect(cleanFastState({ draft: { seat: "CO", editing: "h1", level: null, levelGuess: true } }).draft).toMatchObject({ level: null });
    expect(cleanFastState({ draft: { seat: "CO", editing: "h1", level: null, levelGuess: true } }).draft).not.toHaveProperty("levelGuess");
  });

  it("takes the level picked for the session, else the start time's estimate, never a stale last level", () => {
    const NOW = new Date(2026, 10, 7, 22, 5).getTime();
    const initial = handLogStore.get();
    try {
      handLogStore.set({ ...initial, hands: [], lastLevel: 12 });
      expect(fastLevel({}, [], NOW)).toEqual({ level: null, guessed: false, picked: false });
      expect(fastLevel({ levelPick: { level: 7, at: NOW - 60_000 } }, [], NOW)).toEqual({ level: 7, guessed: false, picked: true });
      // the pick lapses 12 hours after the later of the pick and the session's newest hand
      expect(fastLevel({ levelPick: { level: 7, at: NOW - SESSION_IDLE_MS - 1 } }, [], NOW).picked).toBe(false);
      expect(fastLevel({ levelPick: { level: 7, at: NOW - SESSION_IDLE_MS - 1 } }, [{ ...base(NOW - 60_000) }], NOW).picked).toBe(true);
      handLogStore.set({ ...initial, hands: [], lastLevel: 12, startClock: { day: localDay(NOW), clock: "19:00" } });
      expect(fastLevel({}, [], NOW)).toEqual({ level: 9, guessed: true, picked: false });
      expect(fastLevel({ levelPick: { level: null, at: NOW } }, [], NOW)).toEqual({ level: null, guessed: false, picked: true });
    } finally {
      handLogStore.set(initial);
    }
  });
});

describe("빠른 기록 v2: the copy text and the coach", () => {
  const NOW = new Date(2026, 10, 8, 23, 0).getTime();
  const at = (t: number, d: FastDraft, act: Parameters<typeof fastHand>[1] = null, lv = 5) => {
    const h = fastHand(d, act, base(t), "mid", 9)!;
    return withFastResult(h, d, { level: lv, guessed: false }, true)!;
  };

  it("adds the chips and the board to a hand's line, and leaves an old hand's line as it was", () => {
    const won = at(NOW - 10 * 60_000, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: [{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }] });
    expect(fastLineText(won)).toBe("22:50 BTN AKs +12,000 (+20bb) · 보드 K♥ 7 2");
    expect(fastLineText(at(NOW, pickRes(typed("CO", "72o"), "fold")))).toBe("23:00 CO 72o 폴드");
    expect(fastLineText(at(NOW, pickRes(typed("SB", "T4o"), "fold")))).toBe("23:00 SB T4o 폴드 −300 (−0.5bb)");
    expect(fastLineText(at(NOW, typed("HJ", "QJs")))).toBe("23:00 HJ QJs");
    const acted = at(NOW, { ...pickRes(typed("BTN", "AJo"), "+"), amount: "3000" }, "open");
    expect(fastLineText(acted)).toBe("23:00 미들 BTN AJo 오픈 ✓ 차트대로 · +3,000 (+5bb)");
  });

  it("copies the session's chips, the stack, the big pots, then every hand; the verdict line only with decisions", () => {
    const hands = [
      at(NOW - 10 * 60_000, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: [{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }] }),
      at(NOW - 20 * 60_000, pickRes(typed("SB", "T4o"), "fold")),
      at(NOW - 30 * 60_000, { ...pickRes(typed("HJ", "QJs"), "-"), amount: "4800", stackNow: "45200" }),
      at(NOW - 40 * 60_000, typed("CO", "K9s")),
    ];
    const lines = sessionText(hands).split("\n");
    expect(lines[0]).toMatch(/^PubAJ 빠른 기록 · 11월 8일 \(일\) · 4핸드 \(펍 토너먼트\)$/);
    expect(lines[1]).toBe("결과 +6,900칩 (+11.5bb) · 땄음 1 · 잃음 1 · 폴드 1 · 결과 없음 1");
    expect(lines[2]).toBe("스택 50,000 → 56,900 (지금 스택 기준)");
    expect(lines).not.toContain(expect.stringMatching(/^차트대로/));
    expect(sessionText(hands)).toContain("[큰 팟 · 10bb 이상]\n- 22:50 BTN AKs +12,000 (+20bb) · 보드 K♥ 7 2\n\n[전체 · 시간순]");
    expect(sessionText(hands)).toContain("1. 22:20 CO K9s\n2. 22:30 HJ QJs −4,800 (−8bb)\n3. 22:40 SB T4o 폴드 −300 (−0.5bb)\n4. 22:50 BTN AKs");
    // with a decision on some hand: the chart line after the chips
    const mixed = sessionText([...hands, at(NOW - 50 * 60_000, typed("BTN", "AJo"), "open")]).split("\n");
    expect(mixed[0]).toContain("(펍 토너먼트, 펍아재 차트 기준)");
    expect(mixed[3]).toBe("차트대로 1/1 (100%) · 섞는 핸드 0 · 오버플레이 0 · 언더플레이 0 · 차트 없음 0");
  });

  it("tells the coach the board as remembered, without the guessed suits as facts", () => {
    const h = at(NOW, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: [{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }] });
    const facts = handFacts(h);
    expect(facts).toContain("보드 (빠른 기록 · 기억나는 카드만, 숫자만 적힌 건 수트 모름): K♥ 7 2");
    expect(facts).toContain("결과: 이김 +12,000칩 (+20bb)");
    expect(facts).not.toContain("펍 차트 판정");
    // carried on to the table it is a table hand again, its board a table board
    expect(handFacts({ ...h, steps: [{ s: "UTG", k: "fold" }] })).toContain("보드: ");
  });

  it("stays complete with a board, and goes back to the table flow only with table actions", () => {
    const h = { ...at(NOW, { ...typed("BTN", "AKs"), board: [{ r: 3 }, { r: 4 }] }), updatedAt: Date.now() };
    expect([fastOnly(h), unfinished(h), resumable([h], Date.now())]).toEqual([true, false, null]);
    expect(fastOnly({ ...h, steps: [{ s: "UTG", k: "fold" }] })).toBe(false);
    expect(fastOnly({ ...h, showdowns: [{ name: "", seat: "CO", cards: [], did: "" }] })).toBe(false);
  });

  it("keeps the new hands through sanitize and the backup", () => {
    const h = at(NOW, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "64200", board: [{ r: R("K"), s: 1 }, { r: R("7") }] });
    expect(sanitize(JSON.parse(JSON.stringify(h)))).toEqual(h);
    expect(mergeImport(exportData([h]), []).hands[0]).toEqual(h);
    expect(migrateStore({ hands: [h], lastLevel: null }, null)).toBeNull();
  });
});
