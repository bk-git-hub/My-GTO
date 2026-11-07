import { describe, expect, it } from "vitest";
import { parseCards, rankOf, suitOf } from "../../poker/cards";
import { sanitizeState } from "../scout/scoutModel";
import { analyseHand } from "./handAnalysis";
import {
  emptyHand,
  EXPORT_KIND,
  exportData,
  freshHand,
  freshLevel,
  handFacts,
  handLogStore,
  holeClass,
  knownCards,
  levelEstimateAt,
  mergeImport,
  noRepeats,
  quickSaveAction,
  reguess,
  sanitize,
  setTodayStart,
  startFor,
  stepsThatFit,
  tableOf,
  tidyHand,
  unfinished,
  villainBook,
  withBoard,
  withHole,
  withLevel,
  worthKeeping,
  type HandLogState,
  type LoggedHand,
} from "./handLog";
import { scoutToHands } from "./legacyScout";
import { amountLabel, applyStep, freshGame, replay, resolveStep, streetLines, type LogStep } from "./recorder";
import { holeFromRanks } from "./suitGuess";

const hand = (over: Partial<LoggedHand>): LoggedHand => ({ ...emptyHand(null), id: "fx", createdAt: 1, updatedAt: 1, ...over });
const cards = (t: string) => parseCards(t);
const noDupes = (h: LoggedHand) => {
  const all = [...h.hole, ...h.board, ...h.showdowns.flatMap((s) => s.cards)];
  return new Set(all).size === all.length;
};
/** Runs `fn` with the hand log store set to `state` (in memory), then puts it back. */
function withStore<T>(state: Partial<HandLogState>, fn: () => T): T {
  const g = globalThis as { localStorage?: unknown };
  const had = "localStorage" in g;
  const storage = g.localStorage;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const before = handLogStore.get();
  handLogStore.set({ hands: [], lastLevel: null, ...state });
  try {
    return fn();
  } finally {
    handLogStore.set(before);
    if (had) g.localStorage = storage;
    else delete g.localStorage;
  }
}
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

/**
 * "mygto.scout" with one 9-seat hand: the button on seat 3 (me, BTN), I open, the BB (seat 5) 3-bets, I
 * call; I show AhAd and win, the BB shows QQ.
 */
function scoutFile(seats: number): string {
  const all = Array.from({ length: seats }, (_, i) => [i + 1, `pl0${i + 1}`] as [number, string]);
  return JSON.stringify({
    v: 1,
    active: "sess9abc",
    sessions: [
      {
        id: "sess9abc",
        started: at(6, 19),
        size: seats,
        mySeat: 3,
        occ: all.map(([, p]) => p),
        players: Object.fromEntries(all.map(([seat, p]) => [p, { id: p, seat, name: seat === 5 ? "안경" : seat === 3 ? "내닉" : "", ...(seat === 3 ? { me: true } : {}) }])),
        cur: 1,
        hands: [
          {
            id: "h3cccc",
            no: 1,
            t: at(6, 20),
            button: 3,
            seats: all,
            acts: { pl03: "R", pl05: "3" },
            called: ["pl03"],
            sd: { pl03: { show: "AhAd", won: true }, pl05: { show: "QQ" } },
            street: "river",
            done: true,
          },
        ],
      },
    ],
  });
}

describe("known cards win over guessed ones", () => {
  // 무늬 모름: A K suited, guessed as A♠K♠
  const guessedAKs = () => withHole(hand({ seat: "BTN" }), holeFromRanks(12, 11, "suited", [])!, true, "suited");

  it("moves a guessed hole card off a real flop card, keeping what was remembered", () => {
    const h = guessedAKs();
    expect(h.hole).toEqual(cards("AsKs"));
    // the real flop comes with A♠: the exact field takes it (only known cards block it) …
    expect(knownCards(h)).toEqual([]);
    const next = tidyHand(withBoard(h, cards("As7d2c"), 0));
    // … the flop stays as typed, and the hole is guessed again: AK suited, without A♠
    expect(next.board).toEqual(cards("As7d2c"));
    expect(next.hole).not.toContain(cards("As")[0]);
    expect(holeClass(next)).toBe("AKs");
    expect(suitOf(next.hole[0])).toBe(suitOf(next.hole[1]));
    expect(next.guess).toEqual({ hole: true });
    expect(next.holeKind).toBe("suited");
    expect(noDupes(next)).toBe(true);
    // nothing clashes any more: the same object comes back
    expect(tidyHand(next)).toBe(next);
  });

  it("moves the guess off a hand shown down", () => {
    const h = tidyHand({ ...guessedAKs(), showdowns: [{ name: "", seat: "BB", cards: cards("KsQs"), did: "" }] });
    expect(h.showdowns[0].cards).toEqual(cards("KsQs"));
    expect(h.hole).not.toContain(cards("Ks")[0]);
    expect(holeClass(h)).toBe("AKs");
    expect(noDupes(h)).toBe(true);
  });

  it("moves a guessed flop off the real hole cards, keeping its texture", () => {
    // flop 9 7 2 two-tone (K9 share a suit) by ranks, then the real hole cards are typed
    const base = withBoard(hand({ seat: "CO" }), cards("Ks9s2h"), 0, true);
    expect(base.guess).toEqual({ board: [0, 1, 2] });
    const next = tidyHand(withHole(base, cards("KsQs")));
    expect(next.hole).toEqual(cards("KsQs"));
    expect(next.board.map(rankOf)).toEqual(cards("Ks9s2h").map(rankOf));
    expect(next.board).not.toContain(cards("Ks")[0]);
    // still two-tone, K and 9 sharing the suit
    const s = next.board.map(suitOf);
    expect(s[0]).toBe(s[1]);
    expect(s[2]).not.toBe(s[0]);
    expect(next.guess).toEqual({ board: [0, 1, 2] });
    expect(noDupes(next)).toBe(true);
  });

  it("moves a guessed turn off a card typed later, as the same kind of card", () => {
    // exact flop, turn guessed as a new suit (9♣ say), then a showdown shows that very card
    const flop = withBoard(hand({ seat: "CO", hole: cards("AhKh") }), cards("Qd7d2s"), 0);
    const turn = withBoard(flop, [...flop.board, cards("9c")[0]], 3, true);
    const next = tidyHand({ ...turn, showdowns: [{ name: "", seat: "BB", cards: cards("9c9h"), did: "" }] });
    expect(next.board.slice(0, 3)).toEqual(cards("Qd7d2s"));
    expect(rankOf(next.board[3])).toBe(rankOf(cards("9c")[0]));
    expect(next.board[3]).not.toBe(cards("9c")[0]);
    // no flush card invented on a two-diamond flop
    expect(suitOf(next.board[3])).not.toBe(suitOf(cards("Qd")[0]));
    expect(noDupes(next)).toBe(true);
  });

  it("never stores a known card twice (imports, older versions)", () => {
    const h = hand({ hole: cards("AhKh"), board: cards("Qd7dAh9c"), showdowns: [{ name: "", seat: "BB", cards: cards("KhQh"), did: "" }] });
    const fixed = noRepeats(h);
    expect(fixed.hole).toEqual(cards("AhKh"));
    expect(fixed.board).toEqual(cards("Qd7d"));
    expect(fixed.showdowns[0].cards).toEqual([]);
    expect(noRepeats(fixed)).toBe(fixed);
    expect(noDupes(sanitize(JSON.parse(JSON.stringify(h)))!)).toBe(true);
    // a hand without repeats comes back as it is, and so does one with no guess
    const clean = hand({ hole: cards("AhKh"), board: cards("Qd7d2c") });
    expect(tidyHand(clean)).toBe(clean);
    expect(reguess(clean)).toBe(clean);
  });
});

describe("a level corrected after actions are recorded", () => {
  const fmt9 = (bb: number) => amountLabel(bb, 1600);
  const fmt11 = (bb: number) => amountLabel(bb, 2500);

  it("keeps every chip amount that was typed", () => {
    // Lv9 (800/1600) estimated: CO opens to 5,000, the BB 3-bets to 12,000, the BB's stack is 20,000
    const h = hand({ level: 9, levelGuess: true, seat: "BTN", stack: 40000, stacks: { BB: 20000 / 1600 } });
    const steps: LogStep[] = [
      ...["UTG", "UTG+1", "UTG+2", "LJ", "HJ"].map((s): LogStep => ({ s, k: "fold", a: 1 })),
      { s: "CO", k: "raise", to: 5000 / 1600 },
      { s: "BTN", k: "fold" },
      { s: "SB", k: "fold" },
      { s: "BB", k: "raise", to: 12000 / 1600 },
    ];
    const lv9 = { ...h, steps };
    expect(streetLines(replay(tableOf(lv9), steps).game, fmt9)[0].actions).toEqual(["CO 오픈 5,000", "BTN(나) 폴드", "BB 3벳 12,000"]);
    const lv11 = withLevel(lv9, 11);
    expect(lv11.levelGuess).toBeUndefined();
    expect(streetLines(replay(tableOf(lv11), lv11.steps).game, fmt11)[0].actions).toEqual(["CO 오픈 5,000", "BTN(나) 폴드", "BB 3벳 12,000"]);
    expect(Math.round(lv11.stacks.BB * 2500)).toBe(20000);
    // from 레벨 모름 the amounts were typed in bb: they stay in bb
    const unknown = { ...lv9, level: null };
    expect(withLevel(unknown, 9).steps).toEqual(steps);
  });

  it("keeps an all-in an all-in when the real level gives shorter stacks", () => {
    // 32,000 chips, level unknown (100bb assumed): CO opens, I 3-bet, CO 4-bets, I shove, CO calls
    const h = hand({ level: null, seat: "BTN", stack: 32000, hole: cards("AhAd") });
    const t = tableOf(h);
    let g = freshGame(t);
    const steps: LogStep[] = [];
    const push = (st: LogStep) => {
      g = applyStep(g, st)!;
      expect(g).not.toBeNull();
      steps.push(st);
    };
    for (const s of ["UTG", "UTG+1", "UTG+2", "LJ", "HJ"]) push({ s, k: "fold", a: 1 });
    push({ s: "CO", k: "raise", to: 2.5 });
    push({ s: "BTN", k: "raise", to: 8 });
    push({ s: "SB", k: "fold" });
    push({ s: "BB", k: "fold" });
    push({ s: "CO", k: "raise", to: 22 });
    push({ s: "BTN", k: "raise", to: 100, all: 1 });
    push({ s: "CO", k: "call" });
    const recorded = { ...h, steps };
    expect(replay(tableOf(recorded), steps).game.done).toBe(true);
    // the real level is Lv9: 32,000 is 20bb. The 4-bet is CO's whole stack now, my shove calls it
    const real = withLevel(recorded, 9);
    const r = replay(tableOf(real), real.steps);
    expect(r.game.done).toBe(true);
    expect(r.game.showdown).toBe(true);
    expect(r.game.players.every((p) => p.folded || p.allIn)).toBe(true);
    // the one step that no longer fits (CO's call of a shove that became a call) is reported, not hidden
    expect(stepsThatFit(real)).toBe(steps.length - 1);
  });

  it("replays an all-in mark as the whole stack, and a shove the stack can't raise as a call", () => {
    const t = { heroSeat: "CO", heroStack: 10, stacks: {} };
    let g = freshGame(t);
    for (const s of ["UTG", "UTG+1", "UTG+2", "LJ", "HJ"]) g = applyStep(g, { s, k: "fold" })!;
    expect(resolveStep(g, { s: "CO", k: "raise", to: 100, all: 1 })).toEqual({ k: "raise", to: 10 });
    g = applyStep(g, { s: "CO", k: "raise", to: 10, all: 1 })!;
    g = applyStep(g, { s: "BTN", k: "fold" })!;
    g = applyStep(g, { s: "SB", k: "fold" })!;
    // the BB covers less than the shove: its "all-in" is a call
    const short = { ...t, stacks: { BB: 6 } };
    let s2 = freshGame(short);
    for (const s of ["UTG", "UTG+1", "UTG+2", "LJ", "HJ"]) s2 = applyStep(s2, { s, k: "fold" })!;
    s2 = applyStep(s2, { s: "CO", k: "raise", to: 10, all: 1 })!;
    s2 = applyStep(s2, { s: "BTN", k: "fold" })!;
    s2 = applyStep(s2, { s: "SB", k: "fold" })!;
    expect(resolveStep(s2, { s: "BB", k: "raise", to: 30, all: 1 })).toEqual({ k: "call" });
    // a plain raise that can't be made still doesn't fit
    expect(resolveStep(s2, { s: "BB", k: "raise", to: 3 })).toBeNull();
    expect(sanitize({ id: "x", steps: [{ s: "CO", k: "raise", to: 9, all: 1 }, { s: "BTN", k: "call", all: 1 }] })!.steps).toEqual([
      { s: "CO", k: "raise", to: 9, all: 1 },
      { s: "BTN", k: "call" },
    ]);
  });
});

describe("the level estimate follows the moment a hand is saved", () => {
  const starts = { startClock: { day: "2026-11-07", clock: "19:00" } };

  it("takes the level for the first save, not for when the screen opened", () => {
    withStore(starts, () => {
      const opened = freshHand("mine", at(7, 19, 30));
      expect(opened).toMatchObject({ level: 2, levelGuess: true });
      // saved an hour later (20:30): Lv5 by the clock
      const saved = freshLevel({ ...opened, createdAt: at(7, 20, 30) }, at(7, 20, 30));
      expect(saved).toMatchObject({ level: 5, levelGuess: true });
      expect(levelEstimateAt(at(7, 20, 30))!.level).toBe(5);
      // a level the user picked, or 레벨 모름 on purpose, stays
      expect(freshLevel({ ...opened, level: 3, levelGuess: undefined }, at(7, 20, 30)).level).toBe(3);
      expect(freshLevel({ ...opened, level: null, levelGuess: undefined }, at(7, 20, 30), true).level).toBeNull();
      // no level at all, and no declining: the estimate fills it
      expect(freshLevel({ ...opened, level: null, levelGuess: undefined }, at(7, 20, 30))).toMatchObject({ level: 5, levelGuess: true });
      const same = freshLevel(saved, at(7, 20, 30));
      expect(same).toBe(saved);
    });
  });
});

describe("start times are kept per day", () => {
  it("sets the start of the hand's day, and a later day never replaces it", () => {
    withStore({}, () => {
      const hand2205 = at(6, 22, 5);
      // set on the night (Nov 6, 19:30): 19:00 that day
      expect(setTodayStart("19:00", at(6, 19, 30))).toBe(true);
      expect(levelEstimateAt(hand2205)!.level).toBe(9);
      // filling in that hand the next afternoon: set from the hand, the start stays Nov 6's
      expect(setTodayStart("19:00", hand2205)).toBe(true);
      expect(startFor(hand2205)).toEqual({ day: "2026-11-06", clock: "19:00" });
      // the next night's start (Nov 7, 18:30) is added beside it
      expect(setTodayStart("18:30", at(7, 20))).toBe(true);
      expect(levelEstimateAt(hand2205)!.level).toBe(9);
      expect(startFor(at(7, 20))).toEqual({ day: "2026-11-07", clock: "18:30" });
      expect(handLogStore.get().startClocks).toEqual([
        { day: "2026-11-06", clock: "19:00" },
        { day: "2026-11-07", clock: "18:30" },
      ]);
      // past midnight still belongs to the night before
      expect(startFor(at(8, 1, 30))).toEqual({ day: "2026-11-07", clock: "18:30" });
      // clearing takes off only the day asked about
      expect(setTodayStart(null, at(7, 20))).toBe(true);
      expect(startFor(at(7, 20))).toBeNull();
      expect(startFor(hand2205)).toEqual({ day: "2026-11-06", clock: "19:00" });
    });
  });

  it("carries every day's start through a backup", () => {
    const days = [
      { day: "2026-11-06", clock: "19:00" },
      { day: "2026-11-07", clock: "18:30" },
    ];
    const text = exportData([], days[1], days);
    const r = mergeImport(text, [], undefined, [{ day: "2026-11-01", clock: "20:00" }]);
    expect(r.startClocks).toEqual([{ day: "2026-11-01", clock: "20:00" }, ...days]);
    expect(r.startClock).toEqual(days[1]);
  });
});

describe("another player's hand collected for its range", () => {
  const range = (over: Partial<LoggedHand> = {}) =>
    hand({ kind: "other", seat: "CO", hole: cards("Kh9h"), quickPre: { stage: "mid", action: "open", openBb: 2.5 }, ...over });

  it("is complete as it is: only table actions left mid-way are 작성 중", () => {
    expect(unfinished(range())).toBe(false);
    expect(unfinished(range({ quickPre: undefined, note: "UTG 림프 콜" }))).toBe(false);
    expect(unfinished(range({ quickPre: undefined }))).toBe(true);
    expect(unfinished(range({ hole: [] }))).toBe(true);
    // carried on to the table and left on the flop: 작성 중
    const t = range();
    const steps: LogStep[] = [
      ...["UTG", "UTG+1", "UTG+2", "LJ", "HJ"].map((s): LogStep => ({ s, k: "fold", a: 1 })),
      { s: "CO", k: "raise", to: 2.5 },
      { s: "BTN", k: "fold" },
      { s: "SB", k: "fold" },
      { s: "BB", k: "call" },
    ];
    expect(unfinished({ ...t, steps })).toBe(true);
    // mine are unchanged: no result and the action not over is 작성 중
    expect(unfinished({ ...t, kind: undefined })).toBe(true);
    expect(unfinished({ ...t, kind: undefined, steps })).toBe(true);
  });

  it("keeps a hand on file when its cards are cleared to be typed again", () => {
    for (const kind of [undefined, "other" as const]) {
      const stored = hand({ kind, seat: "BTN", stack: 32000, result: "win", hole: cards("AdTd"), quickPre: { action: "open", openBb: 2.5 } });
      expect(quickSaveAction(stored, { ...stored, hole: [] }, true)).toBe("save");
      expect(worthKeeping(hand({ kind, quickPre: { action: "call" } }))).toBe(true);
      expect(worthKeeping(hand({ kind: "other", mySeat: "BB" }))).toBe(true);
      // emptied out: deleted
      expect(quickSaveAction(hand({ kind, hole: cards("AdTd") }), hand({ kind }), true)).toBe("delete");
    }
    // a new hand still needs two cards or a note before it is first saved
    expect(quickSaveAction(null, hand({ seat: "BTN", stack: 32000 }), true)).toBe("none");
  });
});

describe("my own cards in another player's hand", () => {
  it("are never an opponent's showdown", () => {
    const h = hand({ kind: "other", seat: "BB", mySeat: "BTN", hole: cards("QsQh"), showdowns: [{ name: "", seat: "BTN", cards: cards("AhAd"), did: "이김" }, { name: "안경", seat: "UTG", cards: cards("KcKd"), did: "" }] });
    const book = villainBook([h]);
    expect(book.map((b) => b.name)).toEqual(["안경"]);
    const facts = handFacts(h);
    expect(facts).toContain("쇼다운: 나 BTN A♥ A♦ (AA) — 이김");
    expect(facts).not.toContain("다른 플레이어 BTN");
  });

  it("from the old scout records too", () => {
    const made = scoutToHands(sanitizeState(JSON.parse(scoutFile(9))));
    expect(made.length).toBeGreaterThan(0);
    // the BB's QQ hand: my AA at the BTN is on it for the equity, but never as an opponent
    const bb = made.find((h) => h.seat === "BB")!;
    expect(bb.mySeat).toBe("BTN");
    expect(bb.showdowns.find((s) => s.seat === "BTN")).toMatchObject({ name: "", cards: cards("AhAd") });
    expect(villainBook(made).flatMap((b) => b.entries.map((e) => e.showdown.seat))).not.toContain("BTN");
  });
});

describe("preflop equity against the hand left in", () => {
  it("is measured against the seats still in when the preflop ends", () => {
    for (const [seat, hole] of [
      ["CO", "AhKd"],
      ["BTN", "AsTs"],
    ] as const) {
      const h = hand({ seat, hole: cards(hole), stack: null, level: null });
      const order = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB"];
      const steps: LogStep[] = [];
      for (const s of order) {
        if (s === seat) steps.push({ s, k: "raise", to: 2.5 });
        else steps.push({ s, k: "fold", ...(order.indexOf(s) < order.indexOf(seat) ? { a: 1 as const } : {}) });
      }
      steps.push({ s: "BB", k: "call" });
      const a = analyseHand({ ...h, steps, board: cards("9c5d2h") });
      const pre = a.streets.find((v) => v.street === "preflop")!;
      expect(pre.estimate).not.toBeNull();
      expect(pre.estimate!).toBeGreaterThan(0.5);
    }
  });
});

describe("backups", () => {
  it("get a marker the previous app refuses, and old files still import", () => {
    const h = hand({ kind: "other", seat: "CO", hole: cards("Kh9h"), guess: { hole: true }, holeKind: "suited" });
    const file = JSON.parse(exportData([h]));
    expect(file.kind).toBe(EXPORT_KIND);
    expect(file.kind).not.toBe("pubaz-hand-log");
    expect(mergeImport(exportData([h]), []).hands[0]).toMatchObject({ kind: "other", guess: { hole: true }, holeKind: "suited" });
    const old = JSON.stringify({ kind: "pubaz-hand-log", version: 1, hands: [{ id: "o1", seat: "BTN", hole: cards("AdTd") }] });
    expect(mergeImport(old, []).added).toBe(1);
  });

  it("read the old 정보 수집 data file back as other-hands", () => {
    const raw = scoutFile(9);
    const r = mergeImport(raw, []);
    expect(r.added).toBeGreaterThan(0);
    expect(r.hands.every((h) => h.kind === "other" && h.id.startsWith("scout-"))).toBe(true);
    // already in the log: not added again, and never overwritten
    const edited = r.hands.map((h, i) => (i === 0 ? { ...h, note: "고침" } : h));
    const again = mergeImport(raw, edited);
    expect(again.added).toBe(0);
    expect(again.hands).toEqual(edited);
    expect(() => mergeImport(JSON.stringify({ kind: "something" }), [])).toThrow("PubAJ 핸드 기록 백업 파일이 아니에요.");
  });
});

