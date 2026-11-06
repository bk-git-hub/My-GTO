import { describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import {
  emptyHand,
  exportData,
  handFacts,
  handLogStore,
  handProgress,
  hasContent,
  memoBlocker,
  mergeImport,
  rememberSetup,
  RESUME_WINDOW_MS,
  resumable,
  stackBb,
  villainBook,
  type LoggedHand,
} from "./handLog";
import type { LogStep } from "./recorder";

const hand = (over: Partial<LoggedHand>): LoggedHand => ({ ...emptyHand(null), ...over });

describe("hand log", () => {
  it("lets the quick memo save two clean cards or a note, never a half-typed hand", () => {
    const cards = "카드 두 장을 맞게 넣으면 저장할 수 있어요";
    expect(memoBlocker(hand({}), true)).toBe("카드 두 장이나 메모를 넣으면 저장할 수 있어요");
    expect(memoBlocker(hand({ seat: "BTN", stack: 32000 }), true)).toBe("카드 두 장이나 메모를 넣으면 저장할 수 있어요");
    expect(memoBlocker(hand({ hole: parseCards("AdTd") }), true)).toBeNull();
    expect(memoBlocker(hand({ note: "BTN 올인 콜" }), true)).toBeNull();
    // "Ad": one card isn't a hand, even with a note
    expect(memoBlocker(hand({ hole: parseCards("Ad") }), true)).toBe(cards);
    expect(memoBlocker(hand({ hole: parseCards("Ad"), note: "짐" }), true)).toBe(cards);
    // "AdAd", "AdT", "AdTdK": the field is red or unfinished, so the hand on file isn't what is shown
    expect(memoBlocker(hand({ hole: parseCards("Ad") }), false)).toBe(cards);
    expect(memoBlocker(hand({ hole: parseCards("AdTd") }), false)).toBe(cards);
    expect(memoBlocker(hand({ note: "메모" }), false)).toBe(cards);
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
    // a quick memo saved without the table counts too: it was meant to be finished later
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
