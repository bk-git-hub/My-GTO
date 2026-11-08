import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCards } from "../../poker/cards";
import { sanitizeState } from "../scout/scoutModel";
import { analyseHand } from "./handAnalysis";
import { emptyHand, handFacts, importScout, migrateStore, scoutImported, tableOf, textSig, type HandLogState, type LoggedHand } from "./handLog";
import { limpedSteps, scoutHandId, scoutToHands } from "./legacyScout";
import { replay } from "./recorder";

/**
 * "mygto.scout" as the scout screen stored it: a 9-seat session (I'm seat 3) and a 6-seat one, with a
 * few malformed bits the scout module's own sanitize drops (a hand without an id, a session with a
 * bad id, a showdown for a player not dealt in).
 */
const PLAYERS9 = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((seat) => [`pl0${seat}`, { id: `pl0${seat}`, seat, name: seat === 9 ? "빨간모자" : seat === 4 ? "안경" : "", ...(seat === 3 ? { me: true } : {}) }]),
);
const ALL9: [number, string][] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => [s, `pl0${s}`]);
const T0 = Date.UTC(2026, 10, 6, 11, 0); // 20:00 in Korea

const SCOUT = {
  v: 1,
  active: "sess9abc",
  sessions: [
    {
      id: "sess9abc",
      started: T0 - 3_600_000,
      size: 9,
      mySeat: 3,
      occ: ALL9.map(([, p]) => p),
      players: PLAYERS9,
      cur: 5,
      hands: [
        // Button on seat 1: seat 4 UTG … seat 9 CO, 1 BTN, 2 SB, 3 BB (me). UTG limps, CO raises, UTG calls.
        {
          id: "h1aaaa",
          no: 1,
          t: T0,
          button: 1,
          seats: ALL9,
          acts: { pl04: "L", pl09: "R" },
          called: ["pl04"],
          sd: { pl09: { show: "K9s", won: true }, pl04: { show: "QhJh" }, ghost: { show: "AsAd" } },
          street: "river",
          note: "CO 아재 리버 오래 고민",
          done: true,
        },
        // Button on seat 2: seat 5 UTG … 1 CO, 2 BTN, 3 SB (me), 4 BB. A limped pot: UTG, BTN and I limp, the BB checks.
        {
          id: "h2bbbb",
          no: 2,
          t: T0 + 120_000,
          button: 2,
          seats: ALL9,
          acts: { pl05: "L", pl02: "L", pl03: "L" },
          called: [],
          sd: { pl05: { show: "77" }, pl02: { show: "AK" } },
          street: "turn",
          done: true,
        },
        // Button on seat 3 (me, BTN): I open, the BB (seat 5) 3-bets, I call. My own show is not a hand to copy.
        {
          id: "h3cccc",
          no: 3,
          t: T0 + 240_000,
          button: 3,
          seats: ALL9,
          acts: { pl03: "R", pl05: "3" },
          called: ["pl03"],
          sd: { pl03: { show: "AhAd", won: true }, pl05: { show: "QQ" }, pl06: { show: "Zx" } },
          done: true,
        },
        // Seat 6 empty, 8 dealt in, button on seat 4: 8 UTG, 9 UTG+1, 1 LJ, 2 HJ, 3 CO (me), 4 BTN, 5 SB, 7 BB.
        {
          id: "h4dddd",
          no: 4,
          t: T0 + 360_000,
          button: 4,
          seats: ALL9.filter(([s]) => s !== 6),
          acts: { pl02: "A", pl07: "L" },
          called: [],
          sd: { pl02: { show: "Th9h" }, pl07: { show: "AQo", won: true } },
          done: true,
        },
        { no: 5, t: T0, button: 5, seats: ALL9, acts: {}, called: [], sd: { pl01: { show: "KK" } } },
        { id: "h6ffff", no: 5, t: T0 + 480_000, button: 5, seats: ALL9, acts: {}, called: [], sd: {} },
      ],
    },
    {
      id: "sess6xyz",
      started: T0 + 86_400_000,
      size: 6,
      mySeat: null,
      occ: ["q1aa", "q2aa", "q3aa", "q4aa", "q5aa", "q6aa"],
      players: Object.fromEntries([1, 2, 3, 4, 5, 6].map((seat) => [`q${seat}aa`, { id: `q${seat}aa`, seat, name: "" }])),
      cur: 0,
      // Button on seat 1: 4 UTG, 5 HJ, 6 CO, 1 BTN, 2 SB, 3 BB. UTG opens, the SB calls; UTG only ticked as the winner.
      hands: [
        {
          id: "s2h1",
          no: 1,
          t: T0 + 86_400_000,
          button: 1,
          seats: [1, 2, 3, 4, 5, 6].map((s) => [s, `q${s}aa`]),
          acts: { q4aa: "R", q2aa: "L" },
          called: [],
          sd: { q2aa: { show: "KK" }, q4aa: { show: "", won: true } },
          street: "flop",
        },
      ],
    },
    { id: "x", started: 0, size: 9, players: {}, occ: [], hands: [], cur: 0 },
  ],
};
const RAW = JSON.stringify(SCOUT);

const byId = (hands: LoggedHand[]) => Object.fromEntries(hands.map((h) => [h.id, h]));
const emptyState = (): HandLogState => ({ hands: [], lastLevel: null });

describe("copying the old scout records into other-hands", () => {
  const made = scoutToHands(sanitizeState(JSON.parse(RAW)));
  const h = byId(made);

  it("makes one other-hand per player who showed readable cards, never one for me", () => {
    expect(made.map((x) => x.id).sort()).toEqual(
      ["scout-h1aaaa-9", "scout-h1aaaa-4", "scout-h2bbbb-5", "scout-h2bbbb-2", "scout-h3cccc-5", "scout-h4dddd-2", "scout-h4dddd-7", "scout-s2h1-2"].sort(),
    );
    expect(scoutHandId("h1aaaa", 9)).toBe("scout-h1aaaa-9");
    for (const x of made) {
      expect(x.kind).toBe("other");
      expect(x.level).toBeNull();
      expect(x.stack).toBeNull();
      expect(x.board).toEqual([]);
      expect(x.hole).toHaveLength(2);
      expect(x.note.startsWith("정보 수집에서 옮김")).toBe(true);
    }
  });

  it("puts the subject in the hero's place: their position, their cards, my seat beside", () => {
    const co = h["scout-h1aaaa-9"];
    expect(co).toMatchObject({ players: 9, seat: "CO", mySeat: "BB", result: "win", createdAt: SCOUT.sessions[0].hands[0].t, steps: [] });
    // K9s: suits guessed (suited), clear of the QhJh shown in the same hand
    expect(co.hole).toEqual(parseCards("Ks9s"));
    expect(co.guess).toEqual({ hole: true });
    expect(co.holeKind).toBe("suited");
    expect(co.note).toBe("정보 수집에서 옮김 · 닉 빨간모자 · UTG 림프 · CO 레이즈 · UTG 콜 · 리버까지 · 메모 CO 아재 리버 오래 고민");
    expect(co.showdowns).toEqual([{ name: "안경", seat: "UTG", cards: parseCards("QhJh"), did: "" }]);

    const utg = h["scout-h1aaaa-4"];
    expect(utg).toMatchObject({ seat: "UTG", hole: parseCards("QhJh"), result: "lose", mySeat: "BB" });
    expect("guess" in utg || "holeKind" in utg).toBe(false);
    expect(utg.showdowns).toEqual([{ name: "빨간모자", seat: "CO", cards: [], did: "K9s 보여줌 · 이김" }]);
  });

  it("builds preflop steps only for a limped pot (no sizes needed)", () => {
    const utg = h["scout-h2bbbb-5"];
    expect(utg).toMatchObject({ seat: "UTG", mySeat: "SB", hole: parseCards("7s7h"), guess: { hole: true } });
    expect("holeKind" in utg).toBe(false); // a pair has no suitedness
    expect(utg.steps.map((s) => `${s.s} ${s.k}${s.a ? "*" : ""}`)).toEqual([
      "UTG call",
      "UTG+1 fold*",
      "UTG+2 fold*",
      "LJ fold*",
      "HJ fold*",
      "CO fold*",
      "BTN call",
      "SB call",
      "BB check*",
    ]);
    const { game, applied } = replay(tableOf(utg), utg.steps);
    expect(applied).toBe(utg.steps.length);
    expect(game.street).toBe("flop");
    const btn = h["scout-h2bbbb-2"];
    expect(btn).toMatchObject({ seat: "BTN", hole: parseCards("AsKh"), holeKind: "unknown", result: null });
    expect(btn.note).toBe("정보 수집에서 옮김 · UTG 림프 · BTN 림프 · SB 림프 · 턴까지");
    // any raise or all-in: no sizes in the record, so no steps
    expect(h["scout-h1aaaa-9"].steps).toEqual([]);
    expect(h["scout-h4dddd-7"].steps).toEqual([]);
  });

  it("keeps my show and unreadable text as showdown words, and seats a short table by who was dealt in", () => {
    const bb = h["scout-h3cccc-5"];
    expect(bb).toMatchObject({ seat: "BB", mySeat: "BTN", hole: parseCards("QsQh"), result: "lose" });
    expect(bb.note).toBe("정보 수집에서 옮김 · BTN 오픈 · BB 3벳 · BTN 콜");
    expect(bb.showdowns).toEqual([
      { name: "", seat: "BTN", cards: parseCards("AhAd"), did: "이김" },
      { name: "", seat: "UTG", cards: [], did: "Zx 보여줌" },
    ]);
    // 8 dealt in: the 8-handed positions
    const hj = h["scout-h4dddd-2"];
    expect(hj).toMatchObject({ players: 8, seat: "HJ", mySeat: "CO", hole: parseCards("Th9h"), result: "lose" });
    const bb8 = h["scout-h4dddd-7"];
    expect(bb8).toMatchObject({ players: 8, seat: "BB", hole: parseCards("AsQh"), holeKind: "offsuit", result: "win" });
    expect(bb8.note).toBe("정보 수집에서 옮김 · HJ 올인 · BB 콜");
    // no seat of mine in that session; the lone "이김" tick still says who won
    const sb = h["scout-s2h1-2"];
    expect(sb).toMatchObject({ players: 6, seat: "SB", hole: parseCards("KsKh"), result: "lose" });
    expect("mySeat" in sb).toBe(false);
    expect(sb.showdowns).toEqual([{ name: "", seat: "UTG", cards: [], did: "이김" }]);
    expect(sb.note).toBe("정보 수집에서 옮김 · UTG 오픈 · SB 콜 · 플랍까지");
  });

  it("gives limpedSteps nothing to build when the subject isn't in or nobody acted", () => {
    const st = sanitizeState(JSON.parse(RAW));
    const h2 = st.sessions[0].hands[1];
    expect(limpedSteps(h2, 9, "UTG+1")).toEqual([]); // UTG+1 folded: no steps for a player who didn't play
    expect(limpedSteps({ ...h2, acts: {} }, 9, "BB")).toEqual([]);
  });

  it("replays and analyses an other-hand for the subject, with their tag and mine", () => {
    const utg = h["scout-h2bbbb-5"];
    const a = analyseHand(utg, { iterations: 300 });
    expect(a.applied).toBe(utg.steps.length);
    expect(a.streets[0].actions).toEqual(["UTG(상대) 림프 1", "BTN 림프 1", "SB(나) 림프 1", "BB 체크"]);
    expect(a.suitGuess).toEqual({ hole: true, board: [] });
    expect(a.streets[0].suitGuessed).toBe(true);
    const facts = handFacts(utg);
    expect(facts).toContain("다른 플레이어(상대)의 핸드");
    expect(facts).toContain("상대 자리: UTG · 상대 핸드: 77 (수트 추정)");
    expect(facts).toContain("내 자리: SB (같은 테이블에서 지켜봄)");
    expect(facts).toContain("UTG(상대) 림프 1bb, BTN 림프 1bb, SB(나) 림프 1bb, BB 체크");
    expect(facts).toContain("플러시 관련 승률은 근사");
  });
});

describe("importScout / migrateStore", () => {
  it("adds the hands once and notes it; the same text again does nothing", () => {
    const first = importScout(emptyState(), RAW, 1000)!;
    expect(first.hands).toHaveLength(8);
    expect(first.scoutImport).toEqual({ at: 1000, sig: textSig(RAW), ids: expect.arrayContaining(["scout-h1aaaa-9", "scout-s2h1-2"]) });
    expect(first.scoutImport!.ids).toHaveLength(8);
    expect(scoutImported(first)).toBe(8);
    expect(scoutImported(emptyState())).toBe(0);
    // newest first, like every save
    expect(first.hands.map((x) => x.createdAt)).toEqual([...first.hands.map((x) => x.createdAt)].sort((a, b) => b - a));
    expect(importScout(first, RAW, 2000)).toBeNull();
    expect(migrateStore(first, RAW, 2000)).toBeNull();
    // nothing stored under the scout key: nothing to do
    expect(importScout(emptyState(), null)).toBeNull();
    expect(importScout(emptyState(), "")).toBeNull();
  });

  it("never brings back a deleted hand nor overwrites an edited one when the scout text changes", () => {
    const first = importScout(emptyState(), RAW, 1000)!;
    const edited = { ...first.hands.find((x) => x.id === "scout-h1aaaa-9")!, note: "내가 고친 메모", level: 7 };
    const kept = first.hands.filter((x) => x.id !== "scout-h2bbbb-5" && x.id !== edited.id);
    const mine = { ...emptyHand(6), id: "mine1", hole: parseCards("AdTd"), seat: "BTN" };
    const state: HandLogState = { ...first, hands: [edited, mine, ...kept] };
    // one more scout hand recorded since
    const more = structuredClone(SCOUT);
    more.sessions[1].hands.push({ id: "s2h2", no: 2, t: T0 + 90_000_000, button: 2, seats: [1, 2, 3, 4, 5, 6].map((s) => [s, `q${s}aa`] as [number, string]), acts: {}, called: [], sd: { q5aa: { show: "A5s" } } } as never);
    const raw2 = JSON.stringify(more);
    const next = importScout(state, raw2, 3000)!;
    const ids = next.hands.map((x) => x.id);
    expect(ids).toContain("scout-s2h2-5");
    expect(ids).not.toContain("scout-h2bbbb-5");
    expect(next.hands.find((x) => x.id === edited.id)).toEqual(edited);
    expect(next.hands.find((x) => x.id === "mine1")).toEqual(mine);
    expect(next.hands).toHaveLength(state.hands.length + 1);
    expect(next.scoutImport!.ids).toHaveLength(9);
    expect(next.scoutImport!.sig).toBe(textSig(raw2));
    // and again: nothing
    expect(importScout(next, raw2, 4000)).toBeNull();
    // a re-run with the flag lost (a restored backup): ids already in the log are skipped
    const { scoutImport: _f, ...noFlag } = next;
    void _f;
    const again = importScout(noFlag, raw2, 5000)!;
    expect(again.hands.map((x) => x.id).sort()).toEqual([...ids, "scout-h2bbbb-5"].sort());
  });

  it("notes unreadable scout text without adding anything, and treats a broken flag as not run", () => {
    const bad = importScout(emptyState(), "{not json", 1000)!;
    expect(bad.hands).toEqual([]);
    expect(bad.scoutImport).toEqual({ at: 1000, sig: textSig("{not json"), ids: [] });
    expect(importScout(bad, "{not json", 2000)).toBeNull();
    const broken = { ...emptyState(), scoutImport: { sig: 5, ids: "x" } as never };
    expect(importScout(broken, RAW, 1000)!.hands).toHaveLength(8);
  });
});

describe("the hand log module on load", () => {
  const g = globalThis as { localStorage?: unknown };
  const had = "localStorage" in g;
  const saved = g.localStorage;
  afterEach(() => {
    if (had) g.localStorage = saved;
    else delete g.localStorage;
    vi.resetModules();
  });

  /** A localStorage stand-in that records every write. */
  function fakeStorage(init: Record<string, string>) {
    const data = new Map(Object.entries(init));
    const writes: string[] = [];
    g.localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(k);
        data.set(k, v);
      },
      removeItem: (k: string) => {
        writes.push(k);
        data.delete(k);
      },
    };
    return { data, writes };
  }

  it("copies the scout records and moves quick hands once, never writing the scout key", async () => {
    const quick = { id: "q1", createdAt: T0, updatedAt: T0, players: 9, bbAnte: true, level: 6, seat: "BB", hole: parseCards("AdTd"), stack: 32000, note: "", result: null, net: null, board: [], steps: [], stacks: {}, actions: { preflop: "", flop: "", turn: "", river: "" }, showdowns: [], quick: true, quickPre: { stage: "mid", action: "call", openBb: 2.5, openerSeat: "CO" } };
    const { data, writes } = fakeStorage({ "mygto.scout": RAW, "mygto.handlog": JSON.stringify({ hands: [quick], lastLevel: 6 }) });
    vi.resetModules();
    const mod = await import("./handLog");
    expect(writes).toEqual(["mygto.handlog"]);
    expect(data.get("mygto.scout")).toBe(RAW);
    const st = mod.handLogStore.get();
    expect(st.hands).toHaveLength(9);
    const q = st.hands.find((x) => x.id === "q1")!;
    expect("quick" in q).toBe(false);
    expect(q.steps.length).toBeGreaterThan(0);
    expect(q.quickPre).toEqual(quick.quickPre);
    expect(mod.exportLegacyScout()).toBe(RAW);
    // the next start: nothing to do, nothing written
    vi.resetModules();
    writes.length = 0;
    await import("./handLog");
    expect(writes).toEqual([]);
  });

  it("writes nothing when there is nothing to move", async () => {
    const { writes } = fakeStorage({ "mygto.handlog": JSON.stringify({ hands: [], lastLevel: null }) });
    vi.resetModules();
    const mod = await import("./handLog");
    expect(writes).toEqual([]);
    expect(mod.exportLegacyScout()).toBeNull();
  });
});
