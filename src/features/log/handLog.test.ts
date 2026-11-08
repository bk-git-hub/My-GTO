import { describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import {
  emptyHand,
  exportData,
  handFacts,
  handLogStore,
  handProgress,
  handRoute,
  hasContent,
  isQuickHand,
  logView,
  memoBlocker,
  mergeImport,
  lastStage,
  quickCopy,
  quickPreLine,
  quickSaveAction,
  quickSettled,
  rememberSetup,
  RESUME_WINDOW_MS,
  resumable,
  saveHand,
  stackBb,
  tableOf,
  tidyQuick,
  villainBook,
  worthKeeping,
  type LoggedHand,
  type QuickSave,
} from "./handLog";
import { preSteps } from "./quickPre";
import type { LogStep } from "./recorder";

const hand = (over: Partial<LoggedHand>): LoggedHand => ({ ...emptyHand(null), ...over });
const CREATED = Date.UTC(2026, 10, 6, 9, 0);

describe("hand log", () => {
  it("lets a new quick hand be saved with two clean cards or a note, never with a half-typed hand alone", () => {
    const cards = "카드 두 장을 맞게 넣으면 저장돼요";
    expect(memoBlocker(hand({}), true)).toBe("카드 두 장이나 메모를 넣으면 바로 저장돼요");
    expect(memoBlocker(hand({ seat: "BTN", stack: 32000 }), true)).toBe("카드 두 장이나 메모를 넣으면 바로 저장돼요");
    expect(memoBlocker(hand({ hole: parseCards("AdTd") }), true)).toBeNull();
    expect(memoBlocker(hand({ note: "BTN 올인 콜" }), true)).toBeNull();
    // "Ad": one card isn't a hand
    expect(memoBlocker(hand({ hole: parseCards("Ad") }), true)).toBe(cards);
    // "AdAd", "AdT", "AdTdK": the field is red or unfinished, so its cards aren't what is shown
    expect(memoBlocker(hand({ hole: parseCards("Ad") }), false)).toBe(cards);
    expect(memoBlocker(hand({ hole: parseCards("AdTd") }), false)).toBe(cards);
    // a note is kept all the same (the cards wait for the field)
    expect(memoBlocker(hand({ hole: parseCards("Ad"), note: "짐" }), true)).toBeNull();
    expect(memoBlocker(hand({ note: "메모" }), false)).toBeNull();
  });

  it("converts my chips to bb with the level's big blind", () => {
    expect(stackBb({ stack: 34000, level: 6 })).toBe(42.5); // Lv6 400/800
    expect(stackBb({ stack: 34000, level: null })).toBeNull();
    expect(stackBb({ stack: null, level: 6 })).toBeNull();
  });

  it("writes the facts the coach needs", () => {
    const h = hand({
      level: 6,
      seat: "BTN",
      hole: parseCards("AsQd"),
      stack: 34000,
      result: "lose",
      net: -34000,
      showdowns: [{ name: "빨간모자", seat: "BB", cards: parseCards("Kh9h"), did: "올인 콜" }],
    });
    const f = handFacts(h);
    expect(f).toContain("Lv6 · 400/800");
    expect(f).toContain("내 자리: BTN");
    expect(f).toContain("(AQo)");
    expect(f).toContain("34,000칩 (42.5bb)");
    expect(f).toContain("빨간모자 BB");
    expect(f).toContain("(K9s) — 올인 콜");
    expect(f).toContain("결과: 짐 -34,000칩 (-42.5bb)");
  });

  it("groups showdowns by nickname, unnamed last", () => {
    const sd = (name: string) => ({ name, seat: "", cards: [], did: "" });
    const book = villainBook([
      hand({ id: "a", showdowns: [sd("빨간모자"), sd("")] }),
      hand({ id: "b", showdowns: [sd(" 빨간모자 "), sd("안경")] }),
    ]);
    expect(book.map((b) => [b.name, b.entries.length])).toEqual([["빨간모자", 2], ["안경", 1], ["이름 없음", 1]]);
  });

  it("round-trips an export and merges by the newer edit", () => {
    const old = hand({ id: "x", updatedAt: 100, note: "old" });
    const keep = hand({ id: "y", updatedAt: 500, note: "mine is newer" });
    const file = exportData([hand({ id: "x", updatedAt: 200, note: "new" }), hand({ id: "y", updatedAt: 300, note: "stale" }), hand({ id: "z", note: "added" })]);
    const r = mergeImport(file, [old, keep]);
    expect(r.added).toBe(1);
    expect(r.updated).toBe(1);
    const byId = Object.fromEntries(r.hands.map((h) => [h.id, h.note]));
    expect(byId).toEqual({ x: "new", y: "mine is newer", z: "added" });
  });

  it("keeps the quick-record mark through a backup, and only a real one", () => {
    const file = exportData([hand({ id: "q", quick: true, hole: parseCards("AdTd") }), hand({ id: "t", hole: parseCards("KhKs") })]);
    const r = mergeImport(file, []);
    const byId = Object.fromEntries(r.hands.map((h) => [h.id, h]));
    expect(byId.q.quick).toBe(true);
    expect("quick" in byId.t).toBe(false);
    const odd = JSON.stringify({ kind: "pubaz-hand-log", version: 1, hands: [{ id: "x", quick: "yes" }] });
    expect("quick" in mergeImport(odd, []).hands[0]).toBe(false);
  });

  it("cleans up bad records and rejects other files", () => {
    const file = JSON.stringify({
      kind: "pubaz-hand-log",
      version: 1,
      hands: [{ id: "q", hole: [3, 99, -1, "x", 7, 8], result: "boom", actions: { flop: "bet" } }, { note: "no id" }, null],
    });
    const r = mergeImport(file, []);
    expect(r.hands).toHaveLength(1);
    expect(r.hands[0].hole).toEqual([3, 7]);
    expect(r.hands[0].result).toBeNull();
    expect(r.hands[0].actions).toEqual({ preflop: "", flop: "bet", turn: "", river: "" });
    expect(() => mergeImport("not json", [])).toThrow(/읽을 수 없어요/);
    expect(() => mergeImport(JSON.stringify({ hands: [] }), [])).toThrow(/백업 파일이 아니에요/);
  });
});

describe("new hands and resuming", () => {
  const NOW = 1_800_000_000_000;
  // 9-handed, me on the BTN: everyone folds to me, I open, the SB folds, the BB calls.
  const toFlop: LogStep[] = [
    ...["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO"].map((s): LogStep => ({ s, k: "fold", a: 1 })),
    { s: "BTN", k: "raise", to: 2.5 },
    { s: "SB", k: "fold" },
    { s: "BB", k: "call" },
  ];
  const recording = (over: Partial<LoggedHand> = {}) =>
    hand({ seat: "BTN", hole: parseCards("AdTd"), level: 6, stack: 32000, steps: toFlop, updatedAt: NOW - 60_000, ...over });

  it("a table setup alone is not worth saving", () => {
    expect(hasContent(hand({ seat: "BB", players: 6, level: 6, stack: 32000, bbAnte: false, stacks: { BTN: 20 } }))).toBe(false);
    expect(hasContent(hand({ hole: parseCards("Ad") }))).toBe(true);
    expect(hasContent(hand({ note: "BTN 아재 블러프" }))).toBe(true);
    expect(hasContent(hand({ note: "   " }))).toBe(false);
  });

  it("knows how far a hand was recorded", () => {
    expect(handProgress(hand({}))).toBe("setup");
    expect(handProgress(hand({ seat: "BTN", hole: parseCards("Ad") }))).toBe("hand");
    expect(handProgress(recording({ steps: [] }))).toBe("preflop");
    expect(handProgress(recording())).toBe("flop");
    // the BB folds instead: the hand is over
    expect(handProgress(recording({ steps: [...toFlop.slice(0, -1), { s: "BB", k: "fold" }] }))).toBe("done");
  });

  it("offers the last hand left mid-way", () => {
    const older = recording({ id: "old", updatedAt: NOW - 3_600_000 });
    expect(resumable([recording({ id: "last" }), older], NOW)?.id).toBe("last");
    // a hand jotted down without the table counts too: it was meant to be finished later
    expect(resumable([hand({ id: "memo", hole: parseCards("KhKs"), updatedAt: NOW - 1000 })], NOW)?.id).toBe("memo");
  });

  it("doesn't offer hands that are finished, empty or stale", () => {
    expect(resumable([], NOW)).toBeNull();
    expect(resumable([recording({ result: "win" })], NOW)).toBeNull();
    expect(resumable([recording({ net: -2400 })], NOW)).toBeNull();
    expect(resumable([recording({ steps: [...toFlop.slice(0, -1), { s: "BB", k: "fold" }] })], NOW)).toBeNull();
    expect(resumable([recording({ updatedAt: NOW - RESUME_WINDOW_MS - 1 })], NOW)).toBeNull();
    expect(resumable([hand({ seat: "BB", updatedAt: NOW })], NOW)).toBeNull();
    // an empty hand left behind by an older version doesn't hide the one being recorded
    expect(resumable([hand({ id: "empty", seat: "BB", updatedAt: NOW }), recording({ id: "real" })], NOW)?.id).toBe("real");
    // only the most recent hand is considered: once a newer hand is finished, an older one isn't brought back
    expect(resumable([recording({ id: "abandoned", updatedAt: NOW - 7_200_000 }), recording({ id: "done", result: "lose" })], NOW)).toBeNull();
  });

  it("remembers the level and table size of a hand not saved yet", () => {
    const before = handLogStore.get();
    rememberSetup({ level: 9, players: 6 });
    expect(emptyHand().level).toBe(9);
    expect(emptyHand().players).toBe(6);
    rememberSetup({ level: null, players: 6 });
    expect(emptyHand().level).toBe(9); // "레벨 모름" keeps the last known level
    handLogStore.set(before);
  });
});

describe("quick record", () => {
  // A fixed createdAt: two hands built a millisecond apart must still count as the same hand.
  const quick = (over: Partial<LoggedHand> = {}) => hand({ id: "q1", quick: true, level: 6, createdAt: CREATED, ...over });
  const AdTd = parseCards("AdTd");

  it("saves a new hand the moment it has two clean cards or a note", () => {
    expect(quickSaveAction(null, quick({ hole: AdTd }), true)).toBe("save");
    expect(quickSaveAction(null, quick({ note: "BB 아재 올인" }), true)).toBe("save");
    // nothing worth keeping yet: a seat, a stack, a result alone are not stored
    expect(quickSaveAction(null, quick({}), true)).toBe("none");
    expect(quickSaveAction(null, quick({ seat: "BTN", stack: 32000, result: "lose" }), true)).toBe("none");
    expect(quickSaveAction(null, quick({ note: "   " }), true)).toBe("none");
    // one card isn't a hand, even with a seat
    expect(quickSaveAction(null, quick({ hole: parseCards("Ad"), seat: "BTN" }), true)).toBe("none");
  });

  it("saves every later edit to the same hand, and nothing when nothing changed", () => {
    const stored = quick({ hole: AdTd, updatedAt: 100 });
    for (const patch of [{ seat: "BTN" }, { level: 7 }, { bbAnte: false }, { stack: 32000 }, { result: "lose" as const }, { note: "짐" }, { hole: parseCards("AdTc") }, { players: 6 }]) {
      expect(quickSaveAction(stored, { ...stored, ...patch }, true)).toBe("save");
    }
    // opening it again, or the card field re-reporting "clean", writes nothing
    expect(quickSaveAction(stored, { ...stored, updatedAt: 999 }, true)).toBe("none");
    expect(quickSaveAction(stored, JSON.parse(JSON.stringify(stored)), true)).toBe("none");
  });

  it("keeps saving the other fields while the card field shows a typo or a half-typed card", () => {
    const stored = quick({ hole: AdTd, seat: "BTN" });
    // "AdT", "AdTdK", "AdAd", "Ad": the cards on file stay as they are, nothing to write
    expect(quickSaveAction(stored, { ...stored, hole: parseCards("Ad") }, false)).toBe("none");
    expect(quickSaveAction(stored, { ...stored }, false)).toBe("none");
    expect(quickSaveAction(stored, { ...stored, hole: [] }, false)).toBe("none");
    expect(quickSaveAction(stored, { ...stored, hole: parseCards("Ad") }, true)).toBe("none");
    // a seat, result or note typed meanwhile is saved, with the cards on file
    const shown = { ...stored, seat: "CO", result: "lose" as const, note: "BB 3벳 올인 콜" };
    expect(quickSaveAction(stored, shown, false)).toBe("save");
    expect(quickCopy(stored, shown, false)).toEqual({ ...shown, hole: AdTd });
    expect(quickCopy(stored, { ...shown, hole: parseCards("Ad") }, true).hole).toEqual(AdTd);
    // a clean field is taken as it is
    expect(quickCopy(stored, { ...shown, hole: parseCards("KsQs") }, true).hole).toEqual(parseCards("KsQs"));
    // a new hand with a note is saved without the unfinished cards
    expect(quickSaveAction(null, quick({ hole: parseCards("Ad"), note: "메모" }), false)).toBe("save");
    expect(quickCopy(null, quick({ hole: parseCards("Ad"), note: "메모" }), false).hole).toEqual([]);
    // without one it waits for the cards
    expect(quickSaveAction(null, quick({ hole: parseCards("Ad"), seat: "BTN" }), false)).toBe("none");
  });

  it("follows a stray key after the cards: the seat, result and note still reach the file", () => {
    // AdTd, then a stray K ("AdTdK", still green), then BTN, 짐 and a note
    let onFile: LoggedHand | null = null;
    const step = (shown: LoggedHand, clean: boolean) => {
      const act = quickSaveAction(onFile, shown, clean);
      if (act === "save") onFile = quickCopy(onFile, shown, clean);
      if (act === "delete") onFile = null;
      return act;
    };
    let shown = quick({ hole: AdTd });
    expect(step(shown, true)).toBe("save");
    expect(step(shown, false)).toBe("none"); // the K
    shown = { ...shown, seat: "BTN" };
    expect(step(shown, false)).toBe("save");
    shown = { ...shown, result: "lose" };
    expect(step(shown, false)).toBe("save");
    shown = { ...shown, note: "BTN 오픈, BB 3벳 올인 콜" };
    expect(step(shown, false)).toBe("save");
    expect(onFile).toMatchObject({ hole: AdTd, seat: "BTN", result: "lose", note: "BTN 오픈, BB 3벳 올인 콜" });
    // AdTd, then ⌫⌫ ("Ad"), then a note: the note is kept with AdTd
    onFile = null;
    shown = quick({ hole: AdTd });
    step(shown, true);
    shown = { ...shown, hole: parseCards("Ad") };
    expect(step(shown, true)).toBe("none");
    shown = { ...shown, note: "카드는 나중에 고치기" };
    expect(step(shown, true)).toBe("save");
    expect(onFile).toMatchObject({ hole: AdTd, note: "카드는 나중에 고치기" });
  });

  it("keeps a hand whose cards are cleared to be typed again, while its seat, stack or result is in", () => {
    const stored = quick({ hole: AdTd, seat: "CO", stack: 32000, result: "win" });
    expect(quickSaveAction(stored, { ...stored, hole: [] }, true)).toBe("save");
    for (const patch of [{ seat: "CO" }, { stack: 32000 }, { result: "win" as const }, { note: "x" }]) {
      expect(quickSaveAction(quick({ hole: AdTd, ...patch }), quick({ ...patch }), true)).toBe("save");
    }
    expect(worthKeeping(quick({ seat: "CO" }))).toBe(true);
    // the same for a hand recorded on the table, mine or another player's: anything typed into it keeps it
    expect(worthKeeping(hand({ seat: "CO", stack: 32000 }))).toBe(true);
    expect(worthKeeping(hand({ seat: "CO", hole: AdTd }))).toBe(true);
    // the level alone doesn't: every new hand starts with one
    expect(worthKeeping(hand({ level: 6 }))).toBe(false);
  });

  it("deletes the hand again once nothing worth keeping is left in it", () => {
    expect(quickSaveAction(quick({ hole: AdTd }), quick({}), true)).toBe("delete");
    expect(quickSaveAction(quick({ note: "x" }), quick({ note: "" }), true)).toBe("delete");
    expect(quickSaveAction(quick({ seat: "BTN" }), quick({}), true)).toBe("delete");
    // with no cards on file, an unfinished card field doesn't keep it either
    expect(quickSaveAction(quick({ note: "x" }), quick({ hole: parseCards("Ad") }), false)).toBe("delete");
  });

  it("follows the keypad: saved on the fourth tap, kept while backspacing, deleted when empty", () => {
    // (cards, clean) as the card field reports them, tap by tap
    const taps: [string, boolean][] = [["", false], ["Ad", true], ["Ad", false], ["AdTd", true], ["AdTd", false], ["AdTd", true], ["Ad", false], ["Ad", true], ["", false], ["", true]];
    let onFile: LoggedHand | null = null;
    const acts: QuickSave[] = [];
    for (const [cs, clean] of taps) {
      const next = quick({ hole: parseCards(cs) });
      const act = quickSaveAction(onFile, next, clean);
      acts.push(act);
      if (act === "save") onFile = quickCopy(onFile, next, clean);
      if (act === "delete") onFile = null;
    }
    expect(acts).toEqual(["none", "none", "none", "save", "none", "none", "none", "none", "none", "delete"]);
  });

  it("can be left only once everything on screen is on file", () => {
    const stored = quick({ hole: AdTd, seat: "BTN", updatedAt: 100 });
    expect(quickSettled(stored, { ...stored, updatedAt: 200 }, true)).toBe(true);
    // a note that didn't reach the file (storage full), a card field mid-edit, one card
    expect(quickSettled(stored, { ...stored, note: "짐" }, true)).toBe(false);
    expect(quickSettled(stored, stored, false)).toBe(false);
    expect(quickSettled(stored, { ...stored, hole: parseCards("Ad") }, true)).toBe(false);
    // nothing on file: fine while there is nothing worth saving
    expect(quickSettled(null, quick({ seat: "BTN" }), true)).toBe(true);
    expect(quickSettled(null, quick({ hole: AdTd }), true)).toBe(false);
  });

  it("opens every saved hand in the table flow (the quick screen is gone)", () => {
    const q = quick({ id: "q1", hole: AdTd });
    expect(isQuickHand(q)).toBe(true);
    expect(handRoute(q)).toBe("log/q1");
    expect(handRoute(hand({ id: "t1", seat: "BTN", hole: AdTd }))).toBe("log/t1");
    expect(handRoute(hand({ id: "o1", kind: "other", seat: "CO", hole: AdTd }))).toBe("log/o1");
  });

  it("maps #log routes to screens", () => {
    const q = quick({ id: "q1", hole: AdTd });
    const played = hand({ id: "p1", quick: true, hole: AdTd, steps: [{ s: "UTG", k: "fold" }] });
    const other = hand({ id: "o1", kind: "other", seat: "CO", hole: AdTd });
    const hands = [q, played, other];
    expect(logView("", hands)).toEqual({ kind: "new" });
    expect(logView("new", hands)).toEqual({ kind: "new" });
    expect(logView("list", hands)).toEqual({ kind: "list", filter: "all" });
    expect(logView("list/mine", hands)).toEqual({ kind: "list", filter: "mine" });
    expect(logView("list/other", hands)).toEqual({ kind: "list", filter: "other" });
    expect(logView("players", hands)).toEqual({ kind: "players" });
    // 남의 핸드 is the 빠른 기록 screen in other mode; an old "other/<id>" address opens that hand in the
    // table flow (another player's or one of mine), or the entry screen when it is gone
    expect(logView("other", hands)).toEqual({ kind: "other" });
    expect(logView("other/o1", hands)).toEqual({ kind: "edit", id: "o1" });
    expect(logView("other/q1", hands)).toEqual({ kind: "edit", id: "q1" });
    expect(logView("other/gone", hands)).toEqual({ kind: "other" });
    // the old quick-record links: the new hand, or that hand in the table flow
    expect(logView("quick", hands)).toEqual({ kind: "new" });
    expect(logView("quick/q1", hands)).toEqual({ kind: "edit", id: "q1" });
    expect(logView("quick/p1", hands)).toEqual({ kind: "edit", id: "p1" });
    expect(logView("quick/gone", hands)).toEqual({ kind: "new" });
    // "<id>" is always the table flow
    expect(logView("q1", hands)).toEqual({ kind: "edit", id: "q1" });
    expect(logView("o1", hands)).toEqual({ kind: "edit", id: "o1" });
  });

  it("offers a quick hand for resuming like any other", () => {
    const NOW = 1_800_000_000_000;
    const q = quick({ id: "q1", hole: AdTd, updatedAt: NOW - 60_000 });
    expect(resumable([q], NOW)?.id).toBe("q1");
    expect(resumable([{ ...q, result: "lose" }], NOW)).toBeNull();
  });
});

describe("quick record: the preflop block", () => {
  // A fixed createdAt: two hands built a millisecond apart must still count as the same hand.
  const quick = (over: Partial<LoggedHand> = {}) => hand({ id: "qp", quick: true, level: 6, createdAt: CREATED, ...over });
  const AdTd = parseCards("AdTd");
  const call = { stage: "mid" as const, action: "call" as const, openBb: 2.5, openerSeat: "CO" };

  it("goes through a backup, and hands without it (or with a broken one) load as before", () => {
    const file = exportData([
      quick({ id: "a", hole: AdTd, seat: "BB", quickPre: call }),
      quick({ id: "b", hole: AdTd, seat: "SB", quickPre: { stage: "deep", pinned: true, action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3.5 } }),
      hand({ id: "c", hole: AdTd }),
    ]);
    const byId = Object.fromEntries(mergeImport(file, []).hands.map((h) => [h.id, h]));
    expect(byId.a.quickPre).toEqual(call);
    expect(byId.b.quickPre).toEqual({ stage: "deep", pinned: true, action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3.5 });
    expect("quickPre" in byId.c).toBe(false);
    const odd = JSON.stringify({
      kind: "pubaz-hand-log",
      version: 1,
      hands: [
        { id: "x", quickPre: "call" },
        { id: "y", quickPre: { stage: "mid" } },
        { id: "z", players: 6, quickPre: { action: "call", openerSeat: "UTG+2", openBb: "2.5", threeBetX: 99 } },
      ],
    });
    const r = Object.fromEntries(mergeImport(odd, []).hands.map((h) => [h.id, h]));
    expect("quickPre" in r.x).toBe(false);
    expect("quickPre" in r.y).toBe(false);
    // UTG+2 isn't a seat 6-handed; a size has to be a number
    expect(r.z.quickPre).toEqual({ action: "call" });
  });

  it("keeps a quick hand alive like its seat or result do, but doesn't create one", () => {
    expect(hasContent(quick({ quickPre: call }))).toBe(false);
    expect(quickSaveAction(null, quick({ seat: "BB", quickPre: call }), true)).toBe("none");
    // cards cleared to be typed again: the preflop is kept with the hand
    expect(worthKeeping(quick({ quickPre: call }))).toBe(true);
    expect(quickSaveAction(quick({ hole: AdTd, quickPre: call }), quick({ quickPre: call }), true)).toBe("save");
    expect(worthKeeping(hand({ quickPre: call }))).toBe(true);
    // an edit in the block is saved; the same block again writes nothing
    const stored = quick({ hole: AdTd, seat: "BB", quickPre: call, updatedAt: 1 });
    expect(quickSaveAction(stored, { ...stored, quickPre: { ...call, openBb: 3 } }, true)).toBe("save");
    expect(quickSaveAction(stored, JSON.parse(JSON.stringify(stored)), true)).toBe("none");
  });

  it("follows the stack, seat and table size as they are edited", () => {
    // 32,000 at Lv6 = 40bb: mid; 80,000 = 100bb: deep
    const h = quick({ seat: "BB", stack: 32000, quickPre: { stage: "short", action: "call", openerSeat: "CO" } });
    expect(tidyQuick(h, null).quickPre).toEqual({ stage: "mid", action: "call", openerSeat: "CO" });
    expect(tidyQuick({ ...h, stack: 80000 }, null).quickPre?.stage).toBe("deep");
    // tapped: the stage sticks
    expect(tidyQuick({ ...h, stack: 80000, quickPre: { stage: "short", pinned: true, action: "call" } }, null).quickPre?.stage).toBe("short");
    // my seat moved onto the opener's
    expect(tidyQuick({ ...h, seat: "CO" }, null).quickPre).toEqual({ stage: "mid", action: "call" });
    // the action cleared: the block goes, key and all
    const cleared = tidyQuick({ ...h, quickPre: { stage: "mid", openerSeat: "CO" } }, null);
    expect("quickPre" in cleared).toBe(false);
    expect("quickPre" in tidyQuick({ ...h, quickPre: undefined }, null)).toBe(false);
    // nothing to change: the same hand comes back
    const settled = tidyQuick(h, null);
    expect(tidyQuick(settled, null)).toBe(settled);
  });

  it("remembers the stage for the next hand like the level", () => {
    const before = handLogStore.get();
    // saveHand reverts when the browser refuses to store: give it storage that takes anything.
    const g = globalThis as { localStorage?: unknown };
    const hadStorage = "localStorage" in g;
    const storage = g.localStorage;
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    try {
      handLogStore.set({ ...before, hands: [], lastStage: undefined });
      expect(lastStage()).toBeNull();
      // from the stack of a hand not saved yet
      rememberSetup({ level: 6, players: 9, stack: 8000 }); // 10bb
      expect(lastStage()).toBe("push");
      // a tapped stage
      rememberSetup({ level: 6, players: 9, stack: null, quickPre: { stage: "deep", pinned: true } });
      expect(lastStage()).toBe("deep");
      // a hand that doesn't tell keeps the one before
      rememberSetup({ level: 6, players: 9, stack: null });
      expect(lastStage()).toBe("deep");
      saveHand(quick({ id: "s1", hole: AdTd, stack: 32000 }));
      expect(lastStage()).toBe("mid");
      saveHand(quick({ id: "s2", hole: AdTd }));
      expect(lastStage()).toBe("mid");
      // junk in storage is ignored
      handLogStore.set({ ...handLogStore.get(), lastStage: "huge" as never });
      expect(lastStage()).toBeNull();
    } finally {
      handLogStore.set(before);
      if (hadStorage) g.localStorage = storage;
      else delete g.localStorage;
    }
  });

  it("names the preflop in the past hands, from the block and then from the table's steps", () => {
    const h = quick({ seat: "BB", hole: AdTd, stack: 32000, quickPre: call });
    expect(quickPreLine(h)).toBe("CO 2.5bb 오픈 → 콜");
    expect(quickPreLine(quick({ seat: "UTG", hole: AdTd, stack: 32000, quickPre: { stage: "mid", action: "open", openBb: 2.5 } }))).toBe("UTG 오픈 2.5bb");
    expect(quickPreLine(quick({ seat: "SB", hole: AdTd, stack: 80000, quickPre: { stage: "deep", action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3 } }))).toBe("BTN 3bb → 3벳 9bb");
    // no stack shown on the row: the stage leads
    expect(quickPreLine(quick({ seat: "CO", hole: AdTd, quickPre: { stage: "short", pinned: true, action: "allin" } }))).toBe("숏 · CO 올인");
    expect(quickPreLine(quick({ seat: "CO", quickPre: { stage: "short", pinned: true } }))).toBe("숏");
    // carried on to the table: the steps are the record (here the same line)
    const played = { ...h, steps: preSteps(tableOf(h), h.quickPre) };
    expect(played.steps.length).toBeGreaterThan(0);
    expect(isQuickHand(played)).toBe(false);
    expect(quickPreLine(played)).toBe("CO 2.5bb 오픈 → 콜");
    // and once the table says otherwise, the table wins
    const changed = { ...played, steps: [...played.steps.slice(0, -1), { s: "BB", k: "raise" as const, to: 10 }] };
    expect(quickPreLine(changed)).toBe("CO 2.5bb → 3벳 10bb");
    // a hand without the block shows nothing new
    expect(quickPreLine(hand({ seat: "BB", hole: AdTd }))).toBe("");
    // the table only got the folds before me (the opener sits after me): the block still says it
    const after = quick({ seat: "CO", hole: AdTd, stack: 32000, quickPre: { stage: "mid", action: "call", openBb: 2.5, openerSeat: "BTN" } });
    const folded = { ...after, steps: preSteps(tableOf(after), after.quickPre) };
    expect(folded.steps.length).toBeGreaterThan(0);
    expect(quickPreLine(folded)).toBe("BTN 2.5bb 오픈 → 콜");
    expect(handFacts(folded)).toContain("빠른 기록, 금액은 bb): 미들 구간 · BTN 2.5bb 오픈 → 콜");
    // the BB's shove: the ante is dead money, so it reads as the table records it (12bb stack, 11bb in)
    expect(quickPreLine(quick({ seat: "BB", hole: AdTd, stack: 9600, quickPre: { stage: "short", action: "allin", openBb: 2, openerSeat: "BTN" } }))).toBe("BTN 2bb → 올인 11bb");
  });

  it("tells the coach what the block says while there are no table steps", () => {
    const f = handFacts(quick({ seat: "BB", hole: AdTd, stack: 32000, quickPre: call }));
    expect(f).toContain("프리플랍 (빠른 기록, 금액은 bb): 미들 구간 · CO 2.5bb 오픈 → 콜");
    const h = quick({ seat: "BB", hole: AdTd, stack: 32000, quickPre: call });
    expect(handFacts({ ...h, steps: preSteps(tableOf(h), h.quickPre) })).not.toContain("빠른 기록");
  });
});
