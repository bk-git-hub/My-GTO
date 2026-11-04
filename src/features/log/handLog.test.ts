import { describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { emptyHand, exportData, handFacts, mergeImport, stackBb, villainBook, type LoggedHand } from "./handLog";

const hand = (over: Partial<LoggedHand>): LoggedHand => ({ ...emptyHand(null), ...over });

describe("hand log", () => {
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
