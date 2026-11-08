import { describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import {
  boardText,
  cleanStartClock,
  coachPrompt,
  deleteHand,
  emptyHand,
  estimatedLevel,
  exportData,
  handFacts,
  handHoleText,
  handLevelLabel,
  handLogStore,
  handRoute,
  heroTag,
  holeClass,
  holeLabel,
  isOther,
  isQuickHand,
  laterStart,
  levelEstimateAt,
  levelInfo,
  levelLabel,
  localDay,
  logView,
  mergeImport,
  migrateQuick,
  migrateStore,
  rememberSetup,
  resumable,
  sanitize,
  saveHand,
  seatName,
  seatTags,
  setTodayStart,
  stackBb,
  startClockFor,
  startMsOf,
  subjectLabel,
  subjectWord,
  tidyGuess,
  tidyHand,
  todayStart,
  withLevel,
  worthKeeping,
  type HandLogState,
  type LoggedHand,
  type StartClock,
} from "./handLog";
import { PUB_SCHEDULE } from "./levelClock";
import { preSteps } from "./quickPre";
import { replay, streetLines } from "./recorder";

const hand = (over: Partial<LoggedHand>): LoggedHand => ({ ...emptyHand(null), ...over });
const AdTd = parseCards("AdTd");
const T = new Date(2026, 10, 7, 21, 5).getTime(); // local 2026-11-07 21:05

/** A quick-record hand as the old app stored it (key order and all). */
const storedQuick = (over: Record<string, unknown> = {}) =>
  JSON.parse(
    JSON.stringify({
      id: "q-old",
      createdAt: T,
      updatedAt: T + 60_000,
      players: 9,
      bbAnte: true,
      level: 6,
      seat: "BB",
      hole: AdTd,
      stack: 32000,
      note: "CO 아재 오픈에 콜",
      result: null,
      net: null,
      board: [],
      steps: [],
      stacks: {},
      actions: { preflop: "", flop: "", turn: "", river: "" },
      showdowns: [],
      quick: true,
      quickPre: { stage: "mid", action: "call", openBb: 2.5, openerSeat: "CO" },
      ...over,
    }),
  ) as LoggedHand;

describe("moving quick hands onto the table record", () => {
  it("turns the preflop block into steps, drops the flag, keeps the block, cards and note", () => {
    const old = storedQuick();
    const moved = migrateQuick(old);
    expect("quick" in moved).toBe(false);
    expect(moved.steps).toEqual(preSteps({ heroSeat: "BB", heroStack: 40, stacks: {}, seats: undefined, bbAnte: true }, old.quickPre));
    expect(moved.steps.length).toBeGreaterThan(0);
    expect(moved.quickPre).toEqual(old.quickPre);
    expect(moved.hole).toEqual(AdTd);
    expect(moved.note).toBe(old.note);
    expect(moved.updatedAt).toBe(old.updatedAt);
    // the table reads it like the quick block did
    const pre = streetLines(replay({ heroSeat: "BB", heroStack: 40, stacks: {} }, moved.steps).game, (bb) => `${bb}bb`)[0].actions;
    expect(pre).toEqual(["CO 오픈 2.5bb", "BB(나) 콜 2.5bb"]);
    // idempotent, and old links still land on the table
    expect(migrateQuick(moved)).toBe(moved);
    expect(isQuickHand(moved)).toBe(false);
    expect(handRoute(moved)).toBe("log/q-old");
    expect(logView("quick/q-old", [moved])).toEqual({ kind: "edit", id: "q-old" });
  });

  it("handles the other quick shapes without losing anything", () => {
    // no block: only the flag goes
    const plain = migrateQuick(storedQuick({ quickPre: undefined, note: "" }));
    expect("quick" in plain).toBe(false);
    expect(plain.steps).toEqual([]);
    expect(plain.hole).toEqual(AdTd);
    // carried to the table already: its steps stay as they are
    const steps = [{ s: "UTG", k: "fold" as const }];
    const carried = migrateQuick(storedQuick({ steps }));
    expect(carried.steps).toEqual(steps);
    expect("quick" in carried).toBe(false);
    // a block the table can't take (who opened is missing): no steps, the block stays for the summary
    const loose = migrateQuick(storedQuick({ quickPre: { stage: "mid", action: "call", openBb: 2.5 } }));
    expect(loose.steps).toEqual([]);
    expect(loose.quickPre).toEqual({ stage: "mid", action: "call", openBb: 2.5 });
    expect("quick" in loose).toBe(false);
    // only a seat, stack and result left (its cards cleared to type again): the flag stays, so it is still kept
    const bare = storedQuick({ hole: [], note: "", quickPre: undefined, result: "win" });
    expect(migrateQuick(bare)).toBe(bare);
    expect(worthKeeping(bare)).toBe(true);
    // but with a block that makes steps, those steps keep it
    const pre = migrateQuick(storedQuick({ hole: [], note: "" }));
    expect(pre.steps.length).toBeGreaterThan(0);
    expect("quick" in pre).toBe(false);
    expect(worthKeeping(pre)).toBe(true);
    // a table hand is left alone
    const table = hand({ id: "t", seat: "BTN", hole: AdTd });
    expect(migrateQuick(table)).toBe(table);
  });

  it("runs as part of migrateStore, once", () => {
    const s: HandLogState = { hands: [storedQuick(), storedQuick({ id: "q2", quickPre: undefined })], lastLevel: 6 };
    const next = migrateStore(s, null)!;
    expect(next.hands.every((h) => !("quick" in h))).toBe(true);
    expect(migrateStore(next, null)).toBeNull();
    expect(migrateStore({ hands: [], lastLevel: null }, null)).toBeNull();
  });
});

describe("sanitize: the new fields", () => {
  it("keeps valid values", () => {
    const h = sanitize({
      ...storedQuick({ id: "o1", quick: undefined, quickPre: undefined }),
      kind: "other",
      seat: "CO",
      mySeat: "BB",
      hole: parseCards("Ks9s"),
      board: parseCards("Kd9d2s6c"),
      guess: { hole: true, board: [3, 0, 1, 2] },
      holeKind: "suited",
      levelGuess: true,
    })!;
    expect(h).toMatchObject({ kind: "other", mySeat: "BB", guess: { hole: true, board: [0, 1, 2, 3] }, holeKind: "suited", levelGuess: true });
    expect(sanitize(h)).toEqual(h);
  });

  it("drops malformed or contradictory values", () => {
    const base = storedQuick({ id: "m1", quick: undefined, quickPre: undefined });
    const s = (over: Record<string, unknown>) => sanitize({ ...base, ...over })!;
    expect("kind" in s({ kind: "mine" })).toBe(false);
    expect("kind" in s({ kind: "OTHER" })).toBe(false);
    // my seat only in another player's hand, a real seat, never theirs
    expect("mySeat" in s({ mySeat: "BTN" })).toBe(false);
    expect("mySeat" in s({ kind: "other", mySeat: "UTG+9" })).toBe(false);
    expect("mySeat" in s({ kind: "other", seat: "BB", mySeat: "BB" })).toBe(false);
    expect("mySeat" in s({ kind: "other", players: 6, mySeat: "UTG+2" })).toBe(false);
    // guesses: only cards that exist
    expect(s({ guess: { hole: "yes", board: [7, -1, 2, 2, "x"] } }).guess).toBeUndefined(); // no board dealt
    expect(s({ board: parseCards("Kd9d2s"), guess: { board: [7, -1, 2, 2, "x"] } }).guess).toEqual({ board: [2] });
    expect("guess" in s({ hole: parseCards("Ad"), guess: { hole: true } })).toBe(false);
    expect("guess" in s({ guess: "hole" })).toBe(false);
    // what was remembered has to go with a hole guess and agree with the cards
    expect("holeKind" in s({ holeKind: "suited" })).toBe(false);
    expect("holeKind" in s({ guess: { hole: true }, holeKind: "flush" })).toBe(false);
    expect("holeKind" in s({ hole: parseCards("AdTc"), guess: { hole: true }, holeKind: "suited" })).toBe(false);
    expect(s({ hole: parseCards("AdTc"), guess: { hole: true }, holeKind: "offsuit" }).holeKind).toBe("offsuit");
    expect("holeKind" in s({ hole: parseCards("7s7h"), guess: { hole: true }, holeKind: "suited" })).toBe(false);
    // an estimated level needs a level
    expect("levelGuess" in s({ levelGuess: "true" })).toBe(false);
    expect("levelGuess" in s({ level: null, levelGuess: true })).toBe(false);
  });

  it("cleans stored hands and the start time on load", () => {
    const junk: HandLogState = {
      hands: [
        { ...storedQuick({ id: "j1", quick: undefined, quickPre: undefined }), kind: "mine", guess: { hole: true }, holeKind: "nope" } as never,
        { ...storedQuick({ id: "j2", quick: undefined, quickPre: undefined }), mySeat: "CO" } as never,
        null as never,
      ],
      lastLevel: 6,
      startClock: { day: "2026-13-40", clock: "19:00" },
    };
    const next = migrateStore(junk, null)!;
    expect(next.hands.map((h) => h.id)).toEqual(["j1", "j2"]);
    expect(next.hands[0]).toMatchObject({ guess: { hole: true } });
    expect("kind" in next.hands[0] || "holeKind" in next.hands[0] || "mySeat" in next.hands[1]).toBe(false);
    expect("startClock" in next).toBe(false);
    expect(migrateStore(next, null)).toBeNull();
    // a valid start time is kept as it is
    const ok: HandLogState = { hands: [], lastLevel: null, startClock: { day: "2026-11-07", clock: "19:00" } };
    expect(migrateStore(ok, null)).toBeNull();
    // storage that isn't a hand list at all
    expect(migrateStore({ hands: "x" as never, lastLevel: null }, null)!.hands).toEqual([]);
  });
});

describe("backup", () => {
  const other = hand({
    id: "o1",
    kind: "other",
    seat: "CO",
    mySeat: "BTN",
    hole: parseCards("Ks9s"),
    guess: { hole: true },
    holeKind: "suited",
    level: 9,
    levelGuess: true,
  });
  const start: StartClock = { day: "2026-11-07", clock: "19:00" };

  it("exports and imports every new field and the start time", () => {
    const text = exportData([other], start);
    // a new marker: the previous app refuses the file instead of dropping kind, mySeat, guess…
    expect(JSON.parse(text)).toMatchObject({ kind: "pubaj-hand-log", version: 2, startClock: start });
    const r = mergeImport(text, []);
    expect(r.added).toBe(1);
    expect(r.hands[0]).toEqual(other);
    expect(r.startClock).toEqual(start);
    // no start time to export: the key is left out
    expect("startClock" in JSON.parse(exportData([other]))).toBe(false);
  });

  it("imports old files, and keeps the later start time", () => {
    const oldFile = JSON.stringify({ kind: "pubaz-hand-log", version: 1, exportedAt: "2026-10-01T10:00:00.000Z", hands: [{ id: "old1", createdAt: 1, players: 9, seat: "BTN", hole: AdTd, level: 6, note: "옛날 핸드" }] });
    const r = mergeImport(oldFile, [], start);
    expect(r.hands[0]).toMatchObject({ id: "old1", seat: "BTN", hole: AdTd, level: 6, note: "옛날 핸드", steps: [], board: [] });
    expect(isOther(r.hands[0])).toBe(false);
    expect(r.startClock).toEqual(start);
    const later = { day: "2026-11-08", clock: "18:30" };
    expect(mergeImport(exportData([], later), [], start).startClock).toEqual(later);
    expect(mergeImport(exportData([], start), [], later).startClock).toEqual(later);
    expect(mergeImport(JSON.stringify({ kind: "pubaz-hand-log", hands: [], startClock: { day: "x", clock: "y" } }), []).startClock).toBeUndefined();
    expect(laterStart(undefined, undefined)).toBeUndefined();
  });
});

describe("levels 1-30", () => {
  it("labels every level of the schedule, Lv26-30 included", () => {
    expect(levelLabel(26)).toBe("Lv26 · 50,000/100,000");
    expect(levelLabel(27)).toBe("Lv27 · 75,000/150,000");
    expect(levelLabel(30)).toBe("Lv30 · 200,000/400,000");
    expect(levelLabel(31)).toBe("레벨 모름");
    expect(levelLabel(null)).toBe("레벨 모름");
    expect(levelInfo(28)).toEqual({ sb: 100000, bb: 200000 });
    expect(stackBb({ stack: 3_000_000, level: 29 })).toBe(10);
    // one blind table: the quiz's and the clock's agree
    expect(BLIND_LEVELS).toHaveLength(30);
    expect(BLIND_LEVELS).toEqual(PUB_SCHEDULE.map((r) => [r.level, r.sb, r.bb]));
  });

  it("marks a level that came from the start time", () => {
    const h = withLevel(hand({}), 9, true);
    expect(h.levelGuess).toBe(true);
    expect(handLevelLabel(h)).toBe("Lv9 · 800/1,600 (추정)");
    const typed = withLevel(h, 10);
    expect("levelGuess" in typed).toBe(false);
    expect(handLevelLabel(typed)).toBe("Lv10 · 1,000/2,000");
    expect("levelGuess" in withLevel(h, null, true)).toBe(false);
    expect(handLevelLabel(hand({ level: null, levelGuess: true }))).toBe("레벨 모름");
  });
});

describe("the day's start time", () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

  it("reads the clock typed as the start that covers now, across midnight", () => {
    expect(startClockFor("19:00", at(7, 15))).toEqual({ day: "2026-11-07", clock: "19:00" });
    expect(startClockFor("7시", at(7, 15))).toEqual({ day: "2026-11-07", clock: "07:00" });
    expect(startClockFor("오후 7시", at(7, 15))).toEqual({ day: "2026-11-07", clock: "19:00" });
    // set after midnight: the tournament started the evening before
    expect(startClockFor("19:00", at(8, 1, 30))).toEqual({ day: "2026-11-07", clock: "19:00" });
    // a start just after midnight, set just before
    expect(startClockFor("00:30", at(7, 23, 30))).toEqual({ day: "2026-11-08", clock: "00:30" });
    // month end
    expect(startClockFor("19:00", new Date(2026, 11, 1, 0, 40).getTime())).toEqual({ day: "2026-11-30", clock: "19:00" });
    expect(startClockFor("abc", at(7, 15))).toBeNull();
    expect(localDay(at(7, 23, 59))).toBe("2026-11-07");
  });

  it("covers from 10 hours before the start to 14 hours after, then a new day needs a new start", () => {
    const s = { startClock: { day: "2026-11-07", clock: "19:00" } };
    expect(startMsOf(s.startClock)).toBe(at(7, 19));
    expect(todayStart(at(7, 9), s)).toBe("19:00");
    expect(todayStart(at(7, 8, 59), s)).toBeNull();
    expect(todayStart(at(7, 22), s)).toBe("19:00");
    expect(todayStart(at(8, 2, 30), s)).toBe("19:00"); // past midnight, same tournament
    expect(todayStart(at(8, 8, 59), s)).toBe("19:00");
    expect(todayStart(at(8, 9), s)).toBeNull();
    expect(todayStart(at(8, 19), s)).toBeNull(); // the next evening: set it again
    expect(todayStart(at(7, 20), {})).toBeNull();
    expect(cleanStartClock({ day: "2026-02-30", clock: "19:00" })).toBeUndefined();
    expect(cleanStartClock({ day: "2026-11-07", clock: "1900" })).toEqual({ day: "2026-11-07", clock: "19:00" });
  });

  it("estimates the level of a moment from it", () => {
    const s = { startClock: { day: "2026-11-07", clock: "19:00" } };
    // Lv1-3 (60 min), a 10-minute break, Lv4, Lv5: 21:05 is in Lv6
    const est = levelEstimateAt(T, s)!;
    expect(est).toMatchObject({ level: 6, phase: "level", startClock: "19:00" });
    expect(estimatedLevel(est)).toBe(6);
    // during the first break: the level just played
    expect(estimatedLevel(levelEstimateAt(at(7, 20, 5), s))).toBe(3);
    // after midnight it keeps counting
    expect(levelEstimateAt(at(8, 0, 30), s)!.level).toBeGreaterThan(14);
    // before the start, or with no start covering the moment
    expect(estimatedLevel(levelEstimateAt(at(7, 18, 30), s))).toBeNull();
    expect(levelEstimateAt(at(8, 19), s)).toBeNull();
    expect(levelEstimateAt(T, {})).toBeNull();
  });

  it("is stored with the hand log and cleared with null", () => {
    const g = globalThis as { localStorage?: unknown };
    const had = "localStorage" in g;
    const storage = g.localStorage;
    g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const before = handLogStore.get();
    try {
      expect(setTodayStart("19시", at(7, 15))).toBe(true);
      expect(handLogStore.get().startClock).toEqual({ day: "2026-11-07", clock: "19:00" });
      expect(todayStart(at(7, 20))).toBe("19:00");
      expect(setTodayStart("엉터리", at(7, 15))).toBe(false);
      expect(handLogStore.get().startClock).toEqual({ day: "2026-11-07", clock: "19:00" });
      // saving and deleting hands keep the rest of the store: the start time and the scout copy's note
      const flag = { at: 1, sig: "3:x", ids: ["scout-a-1"] };
      handLogStore.set({ ...handLogStore.get(), scoutImport: flag });
      expect(saveHand(hand({ id: "keep1", hole: AdTd }))).toBe(true);
      deleteHand("keep1");
      rememberSetup({ level: 7, players: 8 });
      expect(handLogStore.get()).toMatchObject({ startClock: { day: "2026-11-07", clock: "19:00" }, scoutImport: flag, lastLevel: 7, lastPlayers: 8 });
      // clearing takes off the start of that moment's day only
      expect(setTodayStart(null, at(7, 20))).toBe(true);
      expect("startClock" in handLogStore.get()).toBe(false);
      expect(setTodayStart("", at(7, 20))).toBe(true);
    } finally {
      handLogStore.set(before);
      if (had) g.localStorage = storage;
      else delete g.localStorage;
    }
  });
});

describe("whose hand", () => {
  const other = hand({ kind: "other", seat: "CO", mySeat: "BB", hole: parseCards("Ks9s"), guess: { hole: true }, holeKind: "suited" });

  it("names the subject the same way everywhere", () => {
    expect(isOther(other)).toBe(true);
    expect(isOther(hand({}))).toBe(false);
    expect(emptyHand(null, "other").kind).toBe("other");
    expect("kind" in emptyHand(null)).toBe(false);
    expect([subjectLabel(other), heroTag(other), subjectWord(other, "핸드")]).toEqual(["상대", "(상대)", "상대 핸드"]);
    expect([subjectLabel(hand({})), heroTag(hand({})), subjectWord(hand({}), "핸드")]).toEqual(["나", "(나)", "내 핸드"]);
    expect(seatTags(other)).toEqual({ hero: "(상대)", seats: { BB: "(나)" } });
    expect(seatTags(hand({ kind: "other" }))).toEqual({ hero: "(상대)" });
    expect(seatTags(hand({ seat: "BB" }))).toEqual({ hero: "(나)" });
    expect([seatName(other, "CO"), seatName(other, "BB"), seatName(other, "BTN"), seatName(hand({ seat: "BB" }), "BB")]).toEqual(["CO(상대)", "BB(나)", "BTN", "BB(나)"]);
  });

  it("lists the subject's and my folds in another player's hand", () => {
    const h = { ...other, players: 9 };
    // CO opens, BTN folds, SB folds, BB (me) folds
    const t = { heroSeat: "CO", heroStack: null, stacks: {}, bbAnte: true };
    const steps = [
      { s: "UTG", k: "fold" as const, a: 1 as const },
      { s: "UTG+1", k: "fold" as const, a: 1 as const },
      { s: "UTG+2", k: "fold" as const, a: 1 as const },
      { s: "LJ", k: "fold" as const, a: 1 as const },
      { s: "HJ", k: "fold" as const, a: 1 as const },
      { s: "CO", k: "raise" as const, to: 2.5 },
      { s: "BTN", k: "fold" as const },
      { s: "SB", k: "fold" as const },
      { s: "BB", k: "fold" as const },
    ];
    const { game } = replay(t, steps);
    expect(streetLines(game, (bb) => `${bb}bb`, seatTags(h))[0].actions).toEqual(["CO(상대) 오픈 2.5bb", "BB(나) 폴드"]);
    // the default stays my own hand
    expect(streetLines(game, (bb) => `${bb}bb`)[0].actions).toEqual(["CO(나) 오픈 2.5bb"]);
    const facts = handFacts({ ...h, steps });
    expect(facts).toContain("CO(상대) 오픈 2.5bb, BB(나) 폴드");
    expect(facts).toContain("상대 자리: CO · 상대 핸드: K9s (수트 추정)");
    expect(facts).toContain("내 자리: BB");
    expect(coachPrompt(h).title).toBe("상대 핸드 리뷰 · CO K9s (수트 추정)");
    expect(coachPrompt(hand({ seat: "BTN", hole: AdTd })).title).toBe("기록 리뷰 · BTN A♦T♦");
  });

  it("offers to resume only hands of the kind asked for", () => {
    const now = T;
    const mine = hand({ id: "m", hole: AdTd, seat: "BTN", updatedAt: now - 60_000 });
    const theirs = hand({ id: "o", kind: "other", hole: AdTd, seat: "CO", updatedAt: now - 1000 });
    expect(resumable([mine, theirs], now)?.id).toBe("m");
    expect(resumable([mine, theirs], now, "other")?.id).toBe("o");
    expect(resumable([theirs], now)).toBeNull();
  });
});

describe("guessed suits", () => {
  it("labels the class as remembered", () => {
    const g = (hole: string, holeKind?: "suited" | "offsuit" | "unknown") => hand({ hole: parseCards(hole), guess: { hole: true }, ...(holeKind ? { holeKind } : {}) });
    expect(holeLabel(g("AsTs", "suited"))).toBe("ATs (수트 추정)");
    expect(holeLabel(g("AsTh", "offsuit"))).toBe("ATo (수트 추정)");
    expect(holeLabel(g("AsTh", "unknown"))).toBe("AT (수트 추정)");
    expect(holeLabel(g("TsAh"))).toBe("AT (수트 추정)");
    expect(holeLabel(g("7s7h"))).toBe("77 (수트 추정)");
    expect(holeClass(g("AsTh", "unknown"))).toBe("AT");
    expect(holeLabel(hand({ hole: AdTd }))).toBe("ATs");
    expect(holeLabel(hand({}))).toBe("");
    expect(handHoleText(g("AsTs", "suited"))).toBe("ATs (수트 추정)");
    expect(handHoleText(hand({ hole: AdTd }))).toBe("A♦ T♦ (ATs)");
    expect(boardText(hand({ board: parseCards("Kd9d2s6c"), guess: { board: [0, 1, 2] } }))).toBe("K♦ 9♦ 2♠ 6♣ (플랍 수트 추정)");
    expect(boardText(hand({ board: parseCards("Kd9d2s") }))).toBe("K♦ 9♦ 2♠");
  });

  it("tidies a whole hand after an edit: guesses, my seat, an estimated level", () => {
    const h = hand({ kind: "other", players: 9, seat: "CO", mySeat: "BB", hole: parseCards("Ks9s"), guess: { hole: true }, holeKind: "suited", level: 9, levelGuess: true });
    expect(tidyHand(h)).toBe(h);
    expect("mySeat" in tidyHand({ ...h, seat: "BB" })).toBe(false); // the subject moved onto my seat
    expect("mySeat" in tidyHand({ ...h, players: 6, seat: "CO", mySeat: "UTG+2" })).toBe(false);
    expect("mySeat" in tidyHand({ ...h, kind: undefined })).toBe(false);
    expect("levelGuess" in tidyHand({ ...h, level: null })).toBe(false);
    expect("guess" in tidyHand({ ...h, hole: [] })).toBe(false);
  });

  it("keeps the markers in step with the cards", () => {
    const h = hand({ hole: parseCards("AsTs"), board: parseCards("Kd9d2s6c"), guess: { hole: true, board: [3] }, holeKind: "suited" });
    expect(tidyGuess(h)).toBe(h);
    // the turn card removed: its marker goes
    expect(tidyGuess({ ...h, board: h.board.slice(0, 3) }).guess).toEqual({ hole: true });
    // the hole cards cleared: the hole marker and what was remembered go
    const cleared = tidyGuess({ ...h, hole: [], board: [] });
    expect("guess" in cleared || "holeKind" in cleared).toBe(false);
    // exact suits typed that contradict "suited"
    expect("holeKind" in tidyGuess({ ...h, hole: parseCards("AsTh") })).toBe(false);
  });
});
