import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RANKS } from "../../poker/cards";
import { cleanFastState, fastHand, fastOtherStore, fastStore, newDraft, pickSuited, startEdit, tapRank, type FastDraft } from "./fastLog";
import {
  allPicked,
  deleteHands,
  emptyHand,
  handLogStore,
  livePicks,
  pickAll,
  putAside,
  removeHands,
  restoreHands,
  resumeOffer,
  toggleId,
  undoDeletion,
  type LoggedHand,
} from "./handLog";
import { closeUndoOffer, deleteWithUndo, dismissUndo, UNDO_MS, undoLast, undoNote } from "./undoDelete";

const initial = handLogStore.get();
// The stores write to localStorage: a small one in memory, so a write reports success as in the browser.
const g = globalThis as { localStorage?: unknown };
const had = "localStorage" in g;
const was = g.localStorage;
beforeAll(() => {
  const mem = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
});
afterAll(() => {
  if (had) g.localStorage = was;
  else delete g.localStorage;
});
afterEach(() => {
  handLogStore.set(initial);
  fastStore.set({});
  fastOtherStore.set({});
  const n = undoNote();
  if (n) dismissUndo(n.key);
});

/** Five hands, newest first, as the log keeps them. */
const H = (id: string, at: number, over: Partial<LoggedHand> = {}): LoggedHand => ({ ...emptyHand(6), id, createdAt: at, updatedAt: at, ...over });
const log = () => [H("e", 50), H("d", 40, { kind: "other" }), H("c", 30), H("b", 20), H("a", 10)];
const ids = (hs: LoggedHand[]) => hs.map((h) => h.id);
const R = (k: string) => RANKS.indexOf(k);
function typed(seat: string, cls: string): FastDraft {
  let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
  if (cls[2]) d = pickSuited(d, cls[2] === "s");
  return d;
}

describe("deleting hands, pure", () => {
  it("takes out only the hands asked for, the rest untouched and in order", () => {
    const hands = log();
    const { hands: kept, removed } = removeHands(hands, ["d", "b"]);
    expect(ids(kept)).toEqual(["e", "c", "a"]);
    // the very same objects: nothing else is touched
    expect(kept[0]).toBe(hands[0]);
    expect(removed).toEqual([
      { hand: hands[1], before: "c" },
      { hand: hands[3], before: "a" },
    ]);
    // ids not on file: nothing removed
    expect(removeHands(hands, ["zz"])).toEqual({ hands, removed: [] });
  });

  it("puts them back exactly where they were: same ids, times, content and order", () => {
    const hands = log();
    for (const pick of [["d", "b"], ["e"], ["a"], ["c", "b"], ["e", "d", "c", "b", "a"], ["e", "a"]]) {
      const { hands: kept, removed } = removeHands(hands, pick);
      expect(restoreHands(kept, removed)).toEqual(hands);
    }
  });

  it("keeps hands saved in the meantime, and never doubles a hand already back", () => {
    const hands = log();
    const { hands: kept, removed } = removeHands(hands, ["c", "b"]);
    const fresh = H("n", 60);
    const back = restoreHands([fresh, ...kept], removed);
    expect(ids(back)).toEqual(["n", "e", "d", "c", "b", "a"]);
    // 되돌리기 twice: the same log
    expect(restoreHands(back, removed)).toEqual(back);
  });

  it("falls back to the time order when the hand it stood before is gone too", () => {
    const hands = log();
    const first = removeHands(hands, ["c"]);
    // "b" (the hand c stood before) went too, in another delete
    const second = removeHands(first.hands, ["b"]);
    expect(ids(restoreHands(second.hands, first.removed))).toEqual(["e", "d", "c", "a"]);
    // the oldest, with nothing after it: last
    const last = removeHands(hands, ["a"]);
    expect(ids(restoreHands(last.hands, last.removed))).toEqual(ids(hands));
  });
});

describe("picking hands in 지난 기록 (편집)", () => {
  it("toggles one, picks all of the tab or none, and drops picks deleted elsewhere", () => {
    expect(toggleId([], "a")).toEqual(["a"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
    const shown = ["e", "d", "c"];
    expect(allPicked([], shown)).toBe(false);
    expect(allPicked(["c", "d", "e"], shown)).toBe(true);
    expect(allPicked([], [])).toBe(false);
    // 전체 선택: the rest of the tab added; again: the tab's picks cleared (others' kept)
    expect(pickAll(["d"], shown)).toEqual(["d", "e", "c"]);
    expect(pickAll(["x", "e", "d", "c"], shown)).toEqual(["x"]);
    // in log order, gone ones dropped
    expect(livePicks(["a", "zz", "e"], log())).toEqual(["e", "a"]);
  });
});

describe("deleting hands in the store, with 되돌리기", () => {
  it("deletes from the log only, and brings back the very same hands", () => {
    const hands = log();
    handLogStore.set({ ...initial, hands, lastLevel: 7, startClock: { day: "2026-11-08", clock: "19:00" } });
    const d = deleteHands(["c", "a"])!;
    expect(ids(handLogStore.get().hands)).toEqual(["e", "d", "b"]);
    expect(handLogStore.get()).toMatchObject({ lastLevel: 7, startClock: { day: "2026-11-08", clock: "19:00" } });
    expect(deleteHands(["zz"])).toBeNull();
    expect(undoDeletion(d)).toBe(true);
    expect(handLogStore.get().hands).toEqual(hands);
  });

  it("lets go of the hand put aside from 이어서 while it is deleted, and back with 되돌리기", () => {
    const now = Date.now();
    const mid = H("mid", now - 60_000, { seat: "BTN", hole: [48, 44] });
    handLogStore.set({ ...initial, hands: [mid] });
    putAside("mid");
    expect(resumeOffer([mid], now)).toBeNull();
    const d = deleteHands(["mid"])!;
    expect(d.aside).toBe("mid");
    expect(resumeOffer(handLogStore.get().hands, now)).toBeNull();
    undoDeletion(d);
    // still put aside, as before the delete
    expect(resumeOffer(handLogStore.get().hands, now)).toBeNull();
    putAside("");
  });

  it("deleteWithUndo: the toast's note, 되돌리기 once, and a correction on screen let go of", () => {
    const now = Date.now();
    const mine = fastHand(typed("CO", "AJo"), "open", H("f1", now - 1000), "mid", 9)!;
    const theirs = fastHand(typed("BTN", "K9o"), "open", H("o1", now - 2000, { kind: "other" }), "mid", 9, "other")!;
    const hands = [mine, theirs, ...log()];
    handLogStore.set({ ...initial, hands });
    // each screen is correcting its hand, a new hand put aside
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: typed("HJ", "Q"), parked: null }, mine));
    fastOtherStore.set(startEdit({ stage: "mid", players: 9, draft: typed("SB", "7"), parked: null }, theirs, "other"));

    expect(deleteWithUndo(["o1", "c"], now)).toBe(2);
    expect(ids(handLogStore.get().hands)).toEqual(["f1", "e", "d", "b", "a"]);
    expect(undoNote()).toMatchObject({ text: "2개 삭제했어요", until: now + UNDO_MS });
    // 남의 핸드 is back on its new hand; 빠른 기록's correction (another hand) is untouched
    expect(cleanFastState(fastOtherStore.get()).draft).toMatchObject({ seat: "SB", editing: null });
    expect(cleanFastState(fastStore.get()).draft.editing).toBe("f1");

    expect(undoLast(now)).toBe(true);
    expect(handLogStore.get().hands).toEqual(hands);
    expect(undoNote()).toMatchObject({ text: "되돌렸어요", deletion: null });
    // nothing left to undo
    expect(undoLast(now)).toBe(false);
    expect(handLogStore.get().hands).toEqual(hands);
    expect(deleteWithUndo(["zz"])).toBe(0);
  });

  it("leaves an editor never opened as it was (its first visit keeps its own defaults)", () => {
    handLogStore.set({ ...initial, hands: log() });
    deleteWithUndo(["a"]);
    expect(fastStore.get()).toEqual({});
    expect(fastOtherStore.get()).toEqual({});
  });

  it("closes a note only when its own time is up", () => {
    handLogStore.set({ ...initial, hands: log() });
    deleteWithUndo(["a"]);
    const first = undoNote()!;
    deleteWithUndo(["b"]);
    const second = undoNote()!;
    dismissUndo(first.key);
    expect(undoNote()).toBe(second);
    dismissUndo(second.key);
    expect(undoNote()).toBeNull();
  });

  it("closes the 되돌리기 offer once a new hand is saved, but not a note without the button", () => {
    handLogStore.set({ ...initial, hands: log() });
    deleteWithUndo(["a"]);
    closeUndoOffer();
    expect(undoNote()).toBeNull();
    // the deleted hand stays deleted, and there is nothing left to undo
    expect(ids(handLogStore.get().hands)).toEqual(["e", "d", "c", "b"]);
    expect(undoLast()).toBe(false);
    deleteWithUndo(["b"]);
    expect(undoLast()).toBe(true);
    const done = undoNote()!;
    expect(done.deletion).toBeNull();
    closeUndoOffer();
    expect(undoNote()).toBe(done);
  });
});
