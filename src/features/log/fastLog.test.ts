import { describe, expect, it } from "vitest";
import { makeCard, rankOf, RANKS, suitOf } from "../../poker/cards";
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
  pickBoardSlot,
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
    expect(fastVerdictOf(h)?.text).toBe("✓ 차트대로 · 솔버 55bb 기준");
    expect(fastActText(h)).toBe("오픈");
    // suited, a pair (no holeKind for a pair)
    expect(holeClass(fastHand(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!)).toBe("K8s");
    const pair = fastHand(typed("LJ", "55"), "fold", base(), "mid", 9)!;
    expect([holeClass(pair), pair.holeKind]).toEqual(["55", undefined]);
    // facing an open: the opener in the block; facing a shove: the open was an all-in
    const call = fastHand(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
    expect(call.quickPre).toEqual({ stage: "mid", pinned: true, action: "call", openerSeat: "UTG" });
    expect(fastActText(call)).toBe("UTG 오픈 → 콜");
    expect(fastVerdictOf(call)?.text).toBe("⚠ 오버플레이 (차트: 폴드) · 솔버 55bb 기준");
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
    const call = at(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call");
    expect(tablePre(call)).toBe(call.quickPre);
    // limps, a 3-bet and a fold facing an open have no place in the block: nothing is placed
    expect(tablePre(at(typed("BTN", "AJo", { spot: "limp" }), "open"))).toBeUndefined();
    expect(tablePre(at(typed("CO", "QQ", { spot: "3bet" }), "allin"))).toBeUndefined();
    const cold = at(typed("BTN", "QQ", { spot: "cold3" }), "call");
    expect([tablePre(cold), cold.fastSpot, fastActText(cold), fastVerdictOf(cold)?.kind]).toEqual([undefined, "cold3", "오픈·3벳 → 콜", "ok"]);
    expect(tablePre(at(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "fold"))).toBeUndefined();
  });

  it("is complete as it is: not 작성 중, never offered for 이어서 기록", () => {
    const h = { ...fastHand(typed("BTN", "AJo"), "open", base(), "mid", 9)!, updatedAt: Date.now() };
    expect(unfinished(h)).toBe(false);
    expect(resumable([h], Date.now())).toBeNull();
    // carried on to the table it is a table hand again
    expect(unfinished({ ...h, steps: preSteps(tableOf(h), h.quickPre) })).toBe(true);
  });

  it("tells the coach the decision and the verdict", () => {
    const h = fastHand(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
    expect(handFacts(h)).toContain("프리플랍 (빠른 기록, 내 결정 하나): 미들 구간 · HJ UTG 오픈 → 콜 · 차트 판정 ⚠ 오버플레이 (차트: 폴드) · 솔버 55bb 기준 (솔버 55bb HJ vs UTG 오픈 · 폴드 100%)");
  });
});

describe("빠른 기록: saving, 되돌리기 and corrections as state", () => {
  it("moves on to the next seat with a clear hand after a save", () => {
    const s = state(typed("BTN", "AJo"));
    const h = fastHand(s.draft, "open", base(), "mid", 9)!;
    expect(afterSave(s, h, [h])).toEqual(state(newDraft("CO")));
  });

  it("opens a saved hand in the editor and puts the new one aside; saving it gives that one back", () => {
    const h1 = fastHand(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call", base(1), "mid", 9)!;
    // 되돌리기 right after: the next hand (LJ, nothing typed) goes aside
    const next = state(newDraft("LJ"));
    const editing = startEdit(next, h1);
    expect(editing.draft).toMatchObject({ seat: "HJ", ranks: [R("K"), R("8")], suited: true, spot: "open", opener: "UTG", editing: h1.id, stage: "mid", players: 9 });
    expect(editing.parked).toEqual(newDraft("LJ"));
    // corrected to a fold and saved: back to the next hand
    const fixed = fastHand(editing.draft, "fold", h1, "mid", 9)!;
    expect(fixed.id).toBe(h1.id);
    expect(fixed.createdAt).toBe(1);
    expect(fastVerdictOf(fixed)?.text).toBe("✓ 차트대로 · 솔버 55bb 기준");
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
    at(NOW - 10 * 60_000, typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call"),
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
    expect(t).toContain("[오버플레이]\n- 22:50 미들 HJ K8s UTG 오픈 → 콜 ⚠ 오버플레이 (차트: 폴드) · 솔버 55bb 기준");
    expect(t).toContain("[언더플레이]\n- 22:40 미들 LJ 55 폴드 ▽ 언더플레이 (차트: 오픈)");
    expect(t).toContain("[전체 · 시간순]\n1. 22:10 미들 BTN AJo 림프 → 콜 차트 없음 · 림프 팟\n2. 22:20 미들 BTN AJo 오픈 ✓ 차트대로");
    expect(sessionText([])).toBe("");
  });
});

describe("빠른 기록: on file and in the backup", () => {
  const h = fastHand(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call", base(5), "mid", 9)!;

  it("keeps the flag and the spot through sanitize, export and import", () => {
    expect(sanitize(JSON.parse(JSON.stringify(h)))).toEqual(h);
    const { hands } = mergeImport(exportData([h]), []);
    expect(hands[0]).toMatchObject({ fast: true, fastSpot: "open", quickPre: { openerSeat: "UTG", action: "call" } });
    expect(fastVerdictOf(hands[0])?.text).toBe("⚠ 오버플레이 (차트: 폴드) · 솔버 55bb 기준");
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

  it("keeps a hand's tournament and the tournaments through sanitize, the backup and the load-time cleanup", () => {
    const th: LoggedHand = { ...h, tourney: "t-abc" };
    expect(sanitize(JSON.parse(JSON.stringify(th)))).toEqual(th);
    for (const bad of ["", 5, "x".repeat(70)]) expect(sanitize({ ...h, tourney: bad })).not.toHaveProperty("tourney");
    expect(migrateStore({ hands: [th], lastLevel: null }, null)).toBeNull();
    expect(migrateStore({ hands: [{ ...h, tourney: 5 as never }], lastLevel: null }, null)?.hands[0]).not.toHaveProperty("tourney");
    const t = { id: "t-abc", createdAt: 1, updatedAt: 1, activeAt: 1, name: "수요일", memo: "", start: 1, startSet: true as const, startStack: 50000 };
    expect(migrateStore({ hands: [th], lastLevel: null, tourneys: [t] }, null)).toBeNull();
    const cleaned = migrateStore({ hands: [th], lastLevel: null, tourneys: [t, { id: "" }, { ...t, id: "t-2", startStack: -1 }] as never }, null);
    // the same time made: by id
    expect(cleaned?.tourneys?.map((x) => [x.id, x.startStack])).toEqual([
      ["t-2", null],
      ["t-abc", 50000],
    ]);
    expect(migrateStore({ hands: [], lastLevel: null, tourneys: "x" as never }, null)).not.toHaveProperty("tourneys");
    // the backup: the file carries them (same marker and version); importing merges them, the later edited winning
    const file = exportData([th], undefined, undefined, [t]);
    expect(JSON.parse(file)).toMatchObject({ kind: "pubaj-hand-log", version: 2, tourneys: [t] });
    expect(JSON.parse(exportData([h]))).not.toHaveProperty("tourneys");
    const m = mergeImport(file, [], undefined, undefined, [{ ...t, name: "older", updatedAt: 0 }]);
    expect(m.hands[0].tourney).toBe("t-abc");
    expect(m.tourneys).toEqual([t]);
    expect(mergeImport(file, [], undefined, undefined, [{ ...t, name: "mine, newer", updatedAt: 9 }]).tourneys[0].name).toBe("mine, newer");
    expect(mergeImport(exportData([h]), [], undefined, undefined, [t]).tourneys).toEqual([t]);
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
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb", stackNow: "107", stackUnit: "bb" })).toMatchObject({ net: 12000, stack: 52200 });
    // each field in its own unit: the pot in bb, the stack counted in chips
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb", stackNow: "64200" })).toMatchObject({ net: 12000, stack: 52200, fastUnit: "bb" });
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "107", stackUnit: "bb" })).toMatchObject({ net: 12000, stack: 52200 });
    expect(saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "107", stackUnit: "bb" })).not.toHaveProperty("fastUnit");
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
    // the amount in the unit it was typed in, whatever the toggle says now; 지금 스택 in its unit when exact there to 0.1bb
    expect(draftOf(h, "bb")).toMatchObject({ amount: "12000" });
    expect(draftOf(h, "bb")).not.toHaveProperty("unit");
    expect(draftOf(h, "chips", "bb")).toMatchObject({ amount: "12000", stackNow: "107", stackUnit: "bb" });
    const inBb = saved({ ...pickRes(typed("BTN", "AKs"), "-"), amount: "8", unit: "bb" })!;
    expect(inBb).toMatchObject({ net: -4800, fastUnit: "bb" });
    expect(draftOf(inBb, "chips")).toMatchObject({ res: "-", amount: "8", unit: "bb" });
    expect(withFastResult(fastHand(draftOf(inBb), null, inBb, "mid", 9)!, draftOf(inBb), { level: 5, guessed: false }, true)).toEqual(inBb);
    const odd = saved({ ...pickRes(typed("BTN", "AKs"), "-"), amount: "12345" })!;
    expect(draftOf(odd, "chips", "bb")).toMatchObject({ res: "-", amount: "12345" });
    expect(draftOf(odd, "chips", "bb")).not.toHaveProperty("unit");
    // a hand without an amount takes the unit asked for, for an amount typed now
    expect(draftOf(saved(pickRes(typed("BTN", "94o"), "fold"))!, "bb")).toMatchObject({ unit: "bb" });
    // a fold, a chop, a hand without a result
    expect(draftOf(saved(pickRes(typed("BB", "94o"), "fold"))!)).toMatchObject({ res: "fold" });
    expect(draftOf(saved({ ...pickRes(typed("BB", "94o"), "+"), amount: "0" })!)).toMatchObject({ res: "+", amount: "0" });
    expect(draftOf(saved(typed("BB", "94o"))!)).not.toHaveProperty("res");
    // a fold that cost more than the blind it posted (typed as a loss): it comes back as the loss it was
    const sbLoss = { ...saved({ ...pickRes(typed("SB", "T4o"), "-"), amount: "900" })!, result: "fold" as const };
    expect(draftOf(sbLoss)).toMatchObject({ res: "-", amount: "900" });
    expect(draftOf({ ...sbLoss, net: -300 })).toMatchObject({ res: "fold" });
    expect(draftOf({ ...sbLoss, net: -300 })).not.toHaveProperty("amount");
    // corrected without touching a ranks-only board: the hand's own cards and guesses stay exactly, even
    // guessed suits other than a fresh guess would pick (as the table flow may have re-picked them)
    const k72 = saved({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: [{ r: R("K") }, { r: R("7") }, { r: R("2") }] })!;
    const other = (c: number) => makeCard(rankOf(c), [0, 1, 2, 3].find((x) => x !== suitOf(c) && !k72.hole.includes(makeCard(rankOf(c), x)))!);
    const kept = { ...k72, board: k72.board.map(other) };
    expect(kept.board).not.toEqual(k72.board);
    const edited = { ...draftOf(kept), amount: "15000" };
    const fixed = withFastResult(fastHand(edited, null, kept, "mid", 9)!, edited, LV5, true)!;
    expect(fixed.net).toBe(15000);
    expect([fixed.board, fixed.guess]).toEqual([kept.board, kept.guess]);
    // an old hand: no result fields, its level and ante only (the sheet opens on 스택 for a result typed now)
    const old = fastHand(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
    expect(Object.keys(draftOf(old)).sort()).toEqual(["editing", "focus", "level", "opener", "players", "ranks", "seat", "spot", "stage", "suited"]);
    expect(draftOf(old).focus).toBe("stack");
  });

  it("keeps a corrected hand's decision while it still fits, drops it when it doesn't", () => {
    const call = fastHand(typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call", base(), "mid", 9)!;
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
  it("takes 수익 / 손실 to the amount, 폴드 / 워크 drop it; digits go where the keypad is", () => {
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

  it("puts a suit remembered late on the card whose slot was tapped, not the last one", () => {
    const k72: FastDraft = { ...done, focus: "board", board: [{ r: R("K") }, { r: R("7") }, { r: R("2") }] };
    // the K's slot: the suit row goes to it
    const atK = pickBoardSlot(k72, 0);
    expect(atK).toMatchObject({ focus: "board", boardAt: 0 });
    expect(tapBoardSuit(atK, 1).board).toEqual([{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }]);
    // tapped again: back to the rank only
    expect(tapBoardSuit(tapBoardSuit(atK, 1), 1).board).toEqual(k72.board);
    // the last card's slot, or an empty one: the suit row on the last card (no boardAt kept)
    expect(pickBoardSlot(atK, 2)).not.toHaveProperty("boardAt");
    expect(pickBoardSlot(atK, 4)).not.toHaveProperty("boardAt");
    expect(tapBoardSuit(pickBoardSlot(atK, 4), 2).board?.[2]).toEqual({ r: R("2"), s: 2 });
    // from another field: the keypad comes to the board with it
    expect(pickBoardSlot({ ...k72, focus: "result" }, 1)).toMatchObject({ focus: "board", boardAt: 1 });
    // a new rank or ⌫: the suit row back on the last card
    expect(tapBoardRank(atK, R("9"))).not.toHaveProperty("boardAt");
    expect(backKey(atK)).not.toHaveProperty("boardAt");
    // a card already on the board, whichever slot: refused
    const twoK: FastDraft = { ...k72, board: [{ r: R("K") }, { r: R("K"), s: 1 }, { r: R("2") }], boardAt: 0 };
    expect(tapBoardSuit(twoK, 1)).toBe(twoK);
    // the stored state keeps a valid target only
    expect(cleanFastState({ draft: { ...k72, boardAt: 1 } }).draft.boardAt).toBe(1);
    expect(cleanFastState({ draft: { ...k72, boardAt: 2 } }).draft).not.toHaveProperty("boardAt");
    expect(cleanFastState({ draft: { ...k72, boardAt: "x" } }).draft).not.toHaveProperty("boardAt");
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
    // 지금 스택 empties, then the sheet closes (the keypad back on the hand, the class kept)
    const shut = backKey(backKey({ ...done, stackNow: "5", focus: "stack" }));
    expect(shut).not.toHaveProperty("focus");
    expect(draftClass(shut)).toBe("AKs");
    // an empty board goes back to the result: 금액 with a sign or an amount on the draft, else 스택
    expect(backKey({ ...done, focus: "board" })).toMatchObject({ focus: "stack" });
    expect(backKey({ ...pickRes(done, "+"), focus: "board" })).toMatchObject({ focus: "result" });
    // an action waiting for its result goes with the sheet
    expect(backKey({ ...done, focus: "stack", act: "open" })).not.toHaveProperty("act");
  });

  it("switches only the field the keypad types into, keeping its digits (refused where they can't stay)", () => {
    // "20" typed in chips, meant as bb: the toggle relabels it, never rounds it to 0 (본전); back again exactly
    const meant: FastDraft = { ...pickRes(done, "+"), amount: "20" };
    expect(switchUnit(meant, "bb")).toMatchObject({ unit: "bb", amount: "20" });
    expect(switchUnit(switchUnit(meant, "bb"), "chips")).toEqual(meant);
    // the other field keeps its unit and its digits: a pot in bb, the stack counted in chips
    const both: FastDraft = { ...pickRes(done, "-"), amount: "4850", stackNow: "31234" };
    const potBb = switchUnit(both, "bb");
    expect(potBb).toMatchObject({ unit: "bb", amount: "4850", stackNow: "31234" });
    expect(potBb).not.toHaveProperty("stackUnit");
    expect(switchUnit(potBb, "chips")).toEqual(both);
    const small: FastDraft = { ...both, stackNow: "107", focus: "stack" };
    const stackBb = switchUnit(small, "bb");
    expect(stackBb).toMatchObject({ amount: "4850", stackNow: "107", stackUnit: "bb" });
    expect(stackBb).not.toHaveProperty("unit");
    expect(switchUnit(stackBb, "chips")).toEqual(small);
    // five digits can't be bb, a decimal can't be chips: refused, the draft as it was
    expect(switchUnit({ ...both, focus: "stack" }, "bb")).toEqual({ ...both, focus: "stack" });
    const big: FastDraft = { ...pickRes(done, "+"), amount: "12000" };
    expect(switchUnit(big, "bb")).toBe(big);
    const half: FastDraft = { ...pickRes(done, "+"), amount: "20.5", unit: "bb" };
    expect(switchUnit(half, "chips")).toBe(half);
    // the same unit, or nothing typed: only the unit
    expect(switchUnit(meant, "chips")).toBe(meant);
    expect(switchUnit(pickRes(done, "+"), "bb")).toMatchObject({ unit: "bb" });
  });
});

describe("빠른 기록 v2: the editor state", () => {
  it("starts the next hand in the unit last used, clear of the result, board and focus", () => {
    const s = state({ ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb", board: [{ r: 3 }], focus: "board" }, { unit: "bb" });
    const h = fastHand(s.draft, null, base(), "mid", 9)!;
    expect(afterSave(s, h, [h]).draft).toEqual({ ...newDraft("CO"), unit: "bb" });
    expect(afterSave({ ...s, stackUnit: "bb" }, h, [h]).draft).toEqual({ ...newDraft("CO"), unit: "bb", stackUnit: "bb" });
    expect(freshDraft({}, "CO")).toEqual(newDraft("CO"));
    expect(cancelEdit({ ...s, draft: { ...s.draft, editing: "x" } }).draft).toEqual({ ...newDraft("BTN"), unit: "bb" });
    // a correction opens the amount in the unit it was typed in (chips here), 지금 스택 in the stack's unit when exact
    const typedIn = { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", stackNow: "64200" };
    const won = withFastResult(fastHand(typedIn, null, base(), "mid", 9)!, typedIn, { level: 5, guessed: false }, true)!;
    expect(startEdit(s, won).draft).toMatchObject({ amount: "12000", stackNow: "64200" });
    expect(startEdit(s, won).draft).not.toHaveProperty("unit");
    // the calculator sheet types stacks in chips: a correction opens 지금 스택 in chips whatever the old toggle says
    expect(startEdit({ ...s, stackUnit: "bb" }, won).draft).toMatchObject({ amount: "12000", stackNow: "64200", focus: "result" });
    expect(startEdit({ ...s, stackUnit: "bb" }, won).draft).not.toHaveProperty("stackUnit");
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

  it("keeps the tournament a level was picked in, when it is an id", () => {
    expect(cleanFastState({ levelPick: { level: 7, at: 5, t: "t-1" } }).levelPick).toEqual({ level: 7, at: 5, t: "t-1" });
    expect(cleanFastState({ levelPick: { level: 7, at: 5, t: 3 } }).levelPick).toEqual({ level: 7, at: 5 });
    expect(cleanFastState({ levelPick: { level: null, at: 5, t: "" } }).levelPick).toEqual({ level: null, at: 5 });
  });

  it("takes the level picked for the session (moved on by the schedule), else the start time's estimate, never a stale last level", () => {
    const NOW = new Date(2026, 10, 7, 22, 5).getTime();
    const initial = handLogStore.get();
    try {
      handLogStore.set({ ...initial, hands: [], lastLevel: 12 });
      expect(fastLevel({}, [], NOW)).toEqual({ level: null, guessed: false, picked: false });
      expect(fastLevel({ levelPick: { level: 7, at: NOW - 60_000 } }, [], NOW)).toEqual({ level: 7, guessed: false, picked: true });
      // a pick is "this level is on now": the schedule moves it on from the pick (an estimate once past it)
      const MIN = 60_000;
      expect(fastLevel({ levelPick: { level: 2, at: NOW - 19 * MIN } }, [], NOW)).toEqual({ level: 2, guessed: false, picked: true });
      expect(fastLevel({ levelPick: { level: 2, at: NOW - 25 * MIN } }, [], NOW)).toEqual({ level: 3, guessed: true, picked: true });
      // Lv3, then the 10-minute break (still Lv3's blinds), then Lv4
      expect(fastLevel({ levelPick: { level: 3, at: NOW - 25 * MIN } }, [], NOW)).toEqual({ level: 3, guessed: false, picked: true });
      expect(fastLevel({ levelPick: { level: 3, at: NOW - 31 * MIN } }, [], NOW)).toEqual({ level: 4, guessed: true, picked: true });
      // 12-minute levels from Lv15
      expect(fastLevel({ levelPick: { level: 15, at: NOW - 13 * MIN } }, [], NOW).level).toBe(16);
      // a clock behind the pick: the level picked
      expect(fastLevel({ levelPick: { level: 7, at: NOW + 60_000 } }, [], NOW)).toEqual({ level: 7, guessed: false, picked: true });
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
    expect(fastLineText(acted)).toBe("23:00 미들 BTN AJo 오픈 ✓ 차트대로 · 솔버 55bb 기준 · +3,000 (+5bb)");
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
    expect(lines[1]).toBe("결과 +6,900칩 (+11.5bb) · 수익 1 · 손실 1 · 폴드 1 · 결과 없음 1");
    expect(lines[2]).toBe("스택 50,000 → 56,900 (지금 스택 기준)");
    expect(lines).not.toContain(expect.stringMatching(/^차트대로/));
    expect(sessionText(hands)).toContain("[큰 팟 · 10bb 이상]\n- 22:50 BTN AKs +12,000 (+20bb) · 보드 K♥ 7 2\n\n[전체 · 시간순]");
    expect(sessionText(hands)).toContain("1. 22:20 CO K9s\n2. 22:30 HJ QJs −4,800 (−8bb)\n3. 22:40 SB T4o 폴드 −300 (−0.5bb)\n4. 22:50 BTN AKs");
    // 지금 스택 disagreeing with the count (a hand missed): the result is the stack's change, split
    const missed = [...hands, at(NOW - 5 * 60_000, { ...pickRes(typed("CO", "55"), "-"), amount: "1000", stackNow: "50000" })];
    const ml = sessionText(missed).split("\n");
    expect(ml[1]).toBe("결과 0칩 (0bb) (기록한 핸드 +5,900칩 · 빠진 핸드 −5,900칩) · 수익 1 · 손실 2 · 폴드 1 · 결과 없음 1");
    expect(ml[2]).toBe("스택 50,000 → 50,000 (지금 스택 기준)");
    // with a decision on some hand: the chart line after the chips
    const mixed = sessionText([...hands, at(NOW - 50 * 60_000, typed("BTN", "AJo"), "open")]).split("\n");
    expect(mixed[0]).toContain("(펍 토너먼트, 펍아재 차트 기준)");
    expect(mixed[3]).toBe("차트대로 1/1 (100%) · 섞는 핸드 0 · 오버플레이 0 · 언더플레이 0 · 차트 없음 0");
  });

  it("names the tournament and its start in the copy, the stack from its start stack, and its memo", () => {
    const hands = [at(NOW - 10 * 60_000, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" }), at(NOW - 20 * 60_000, pickRes(typed("SB", "T4o"), "fold"))];
    const info = { title: "수요일 펍", when: "11월 8일 (일) 19:00 시작", startStack: 50000, memo: "테이블 3\n옆자리 공격적" };
    const lines = sessionText(hands, "mine", info).split("\n");
    expect(lines[0]).toBe("PubAJ 빠른 기록 · 수요일 펍 · 11월 8일 (일) 19:00 시작 · 2핸드 (펍 토너먼트)");
    expect(lines[1]).toBe("메모: 테이블 3 / 옆자리 공격적");
    expect(lines[2]).toBe("결과 +11,700칩 (+19.5bb) · 수익 1 · 손실 0 · 폴드 1 · 결과 없음 0");
    expect(lines[3]).toBe("시작 스택 50,000 → 지금 61,700");
    // 지금 스택 lower than the count: the result is the stack's change from the start stack
    const missed = [...hands, at(NOW - 5 * 60_000, { ...pickRes(typed("CO", "55"), "-"), amount: "1000", stackNow: "58000" })];
    const ml = sessionText(missed, "mine", info).split("\n");
    expect(ml[2]).toMatch(/^결과 \+8,000칩 \(\+13\.3bb\) \(기록한 핸드 \+10,700칩 · 빠진 핸드 −2,700칩\)/);
    expect(ml[3]).toBe("시작 스택 50,000 → 지금 58,000");
    // no start stack, no memo: the lines as before after the first
    const plain = sessionText(missed, "mine", { ...info, startStack: null, memo: "" }).split("\n");
    expect(plain[0]).toContain("· 수요일 펍 · 11월 8일 (일) 19:00 시작 ·");
    expect(plain.slice(1)).toEqual(sessionText(missed).split("\n").slice(1));
    // without a tournament: exactly as it always was
    expect(sessionText(hands).split("\n")[0]).toBe("PubAJ 빠른 기록 · 11월 8일 (일) · 2핸드 (펍 토너먼트)");
    expect(sessionText(hands, "other", info).split("\n")[0]).toBe("PubAJ 남의 핸드 · 수요일 펍 · 11월 8일 (일) 19:00 시작 · 2핸드 (펍 토너먼트에서 본 다른 사람 핸드, 펍아재 차트 기준)");
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
    // an amount typed in bb keeps its unit; a bad one, or one off a 빠른 기록 hand, is dropped
    const b = at(NOW, { ...pickRes(typed("BTN", "AKs"), "-"), amount: "8", unit: "bb" });
    expect(b.fastUnit).toBe("bb");
    expect(sanitize(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(mergeImport(exportData([b]), []).hands[0]).toEqual(b);
    expect(migrateStore({ hands: [b], lastLevel: null }, null)).toBeNull();
    expect(sanitize({ ...b, fastUnit: "chips" })).not.toHaveProperty("fastUnit");
    expect(migrateStore({ hands: [{ ...b, fastUnit: "x" as never }], lastLevel: null }, null)?.hands[0]).not.toHaveProperty("fastUnit");
    const { fast: _f, ...notFast } = b;
    void _f;
    expect(sanitize(notFast)).not.toHaveProperty("fastUnit");
  });
});
