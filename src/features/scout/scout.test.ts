import { describe, expect, it } from "vitest";
import {
  currentHand,
  deleteHand,
  handOrder,
  mergeState,
  newPerson,
  newSession,
  nextHand,
  nextOccupied,
  parseShow,
  prevHand,
  sanitizeState,
  setButton,
  setMySeat,
  setShow,
  setSize,
  stepButton,
  tapAct,
  toggleEmpty,
  toggleWon,
  type Act,
  type ScoutSession,
  type ScoutState,
} from "./scout";
import { handFacts, pct, sessionStats } from "./stats";

/** The player id in a seat right now. */
const at = (s: ScoutSession, seat: number) => s.occ[seat - 1]!;
/** Applies actions by seat to the hand on screen. */
function acts(s: ScoutSession, list: [number, Act][]): ScoutSession {
  for (const [seat, a] of list) s = tapAct(s, at(s, seat), a);
  return s;
}

describe("positions and the button", () => {
  it("orders a 9-handed hand UTG … BTN, SB, BB from the button", () => {
    const s = setButton(newSession(9), 5);
    const order = handOrder(currentHand(s));
    expect(order.map((x) => `${x.pos}:${x.seat}`)).toEqual(["UTG:8", "UTG+1:9", "UTG+2:1", "LJ:2", "HJ:3", "CO:4", "BTN:5", "SB:6", "BB:7"]);
  });

  it("skips empty seats for positions and the button", () => {
    let s = newSession(9);
    s = toggleEmpty(s, 3);
    s = toggleEmpty(s, 7);
    s = setButton(s, 6);
    const order = handOrder(currentHand(s));
    expect(order).toHaveLength(7);
    expect(order.find((x) => x.pos === "SB")!.seat).toBe(8);
    expect(order.find((x) => x.pos === "BB")!.seat).toBe(9);
    // next hand: the button jumps over the empty seat 7
    s = nextHand(s);
    expect(currentHand(s).button).toBe(8);
    s = nextHand(nextHand(s)); // 8 → 9 → 1
    expect(currentHand(s).button).toBe(1);
    expect(nextOccupied([1, 2, 4, 5, 6, 8, 9], 2, 9)).toBe(4);
    expect(nextOccupied([1, 2, 4], 1, 9, -1)).toBe(4);
  });

  it("an empty button seat hands the button to the next dealt-in seat", () => {
    let s = newSession(6);
    s = setButton(s, 3);
    s = toggleEmpty(s, 3);
    expect(currentHand(s).button).toBe(4);
    expect(handOrder(currentHand(s)).find((x) => x.pos === "BTN")!.seat).toBe(4);
  });

  it("‹ › step the button over dealt-in seats", () => {
    let s = toggleEmpty(newSession(9), 2);
    s = setButton(s, 1);
    s = stepButton(s, 1);
    expect(currentHand(s).button).toBe(3);
    s = stepButton(s, -1);
    s = stepButton(s, -1);
    expect(currentHand(s).button).toBe(9);
  });

  it("heads-up: the button is the SB", () => {
    const order = handOrder({ button: 4, seats: [[2, "aaaa"], [4, "bbbb"]] });
    expect(order.map((x) => `${x.pos}:${x.seat}`)).toEqual(["SB:4", "BB:2"]);
  });
});

describe("tapping actions", () => {
  it("UTG limp, BTN raise, UTG call is three taps", () => {
    let s = setButton(newSession(9), 5); // UTG = seat 8, BTN = 5
    s = tapAct(s, at(s, 8), "L");
    s = tapAct(s, at(s, 5), "R");
    s = tapAct(s, at(s, 8), "L"); // again: → called the raise
    const h = currentHand(s);
    expect(h.acts).toEqual({ [at(s, 8)]: "L", [at(s, 5)]: "R" });
    expect(h.called).toEqual([at(s, 8)]);
    s = tapAct(s, at(s, 8), "L"); // and again: cleared
    expect(currentHand(s).acts[at(s, 8)]).toBeUndefined();
    expect(currentHand(s).called).toEqual([]);
  });

  it("tapping a lit action with no raise behind clears it; another action replaces it", () => {
    let s = newSession(9);
    s = tapAct(s, at(s, 2), "R");
    s = tapAct(s, at(s, 2), "R");
    expect(currentHand(s).acts).toEqual({});
    s = tapAct(s, at(s, 2), "L");
    s = tapAct(s, at(s, 2), "3");
    expect(currentHand(s).acts).toEqual({ [at(s, 2)]: "3" });
  });
});

describe("stats", () => {
  it("counts VPIP, PFR, limp, limp-call and 3bet", () => {
    let s = setButton(newSession(9), 5); // order: 8 9 1 2 3 4 5(BTN) 6(SB) 7(BB)
    // hand 1: UTG(8) limp, BTN(5) raise, UTG calls
    s = acts(s, [[8, "L"], [5, "R"], [8, "L"]]);
    s = nextHand(s); // button → 6: order 9 1 2 3 4 5 6(BTN) 7(SB) 8(BB)
    // hand 2: seat 9 raises, seat 2 3bets, BB(8) calls
    s = acts(s, [[9, "R"], [2, "3"], [8, "L"]]);
    s = nextHand(s);
    const st = sessionStats(s);
    const p = (seat: number) => st.find((x) => x.seat === seat)!;
    expect(p(8)).toMatchObject({ hands: 2, opps: 2, vpip: 2, pfr: 0, limp: 1, limpCall: 1, threeOpps: 2, three: 0 });
    expect(p(5)).toMatchObject({ hands: 2, vpip: 1, pfr: 1, threeOpps: 1, three: 0 });
    expect(p(2)).toMatchObject({ hands: 2, vpip: 1, pfr: 1, threeOpps: 1, three: 1 });
    expect(p(9)).toMatchObject({ vpip: 1, pfr: 1, threeOpps: 0 });
    expect(p(1)).toMatchObject({ hands: 2, opps: 2, vpip: 0 });
    // the open hand #3 has nothing entered yet: not counted
    expect(p(1).hands).toBe(2);
    // sorted by VPIP
    expect(st[0].seat).toBe(8);
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBeNull();
  });

  it("the BB checking is not VPIP; the SB completing is a limp", () => {
    let s = setButton(newSession(6), 1); // order 4 5 6 1(BTN) 2(SB) 3(BB)
    s = acts(s, [[4, "L"], [2, "L"], [3, "L"]]);
    const f = handFacts(currentHand(s));
    expect(f.get(at(s, 3))).toMatchObject({ pos: "BB", opp: true, vpip: false, limp: false });
    expect(f.get(at(s, 2))).toMatchObject({ pos: "SB", vpip: true, limp: true });
    expect(f.get(at(s, 4))).toMatchObject({ pos: "UTG", vpip: true, limp: true });
  });

  it("the BB calling a raise is VPIP; an all-in over a raise is a 3bet", () => {
    let s = setButton(newSession(6), 1);
    s = acts(s, [[5, "R"], [2, "A"], [3, "L"]]);
    const f = handFacts(currentHand(s));
    expect(f.get(at(s, 3))).toMatchObject({ vpip: true, pfr: false, threeOpp: true, three: false });
    expect(f.get(at(s, 2))).toMatchObject({ vpip: true, pfr: true, three: true });
    expect(f.get(at(s, 5))).toMatchObject({ pfr: true, threeOpp: false, three: false });
  });

  it("a walk: the BB gets the hand but no VPIP chance; a closed all-fold hand counts", () => {
    let s = setButton(newSession(6), 1);
    s = nextHand(s); // nothing entered, closed with 다음 핸드 = everyone folded to the BB
    const st = sessionStats(s);
    const bb = st.find((x) => x.seat === 3)!;
    expect(bb).toMatchObject({ hands: 1, opps: 0, vpip: 0 });
    const utg = st.find((x) => x.seat === 4)!;
    expect(utg).toMatchObject({ hands: 1, opps: 1, vpip: 0 });
  });

  it("me is left out; a new person in a seat starts fresh stats", () => {
    let s = setMySeat(newSession(6), 2);
    s = acts(s, [[2, "R"], [4, "L"]]);
    const old4 = at(s, 4);
    s = newPerson(s, 4); // seat 4 has an action this hand: the change waits for the next hand
    expect(currentHand(s).seats.find(([seat]) => seat === 4)![1]).toBe(old4);
    s = nextHand(s);
    expect(currentHand(s).seats.find(([seat]) => seat === 4)![1]).toBe(at(s, 4));
    s = acts(s, [[5, "L"], [4, "R"]]); // button 2: seat 4 is the BB and raises the limper
    const st = sessionStats(s);
    expect(st.some((x) => x.seat === 2)).toBe(false);
    const fours = st.filter((x) => x.seat === 4);
    expect(fours).toHaveLength(2);
    expect(fours.find((x) => x.pid === old4)).toMatchObject({ hands: 1, vpip: 1, pfr: 0, seated: false });
    expect(fours.find((x) => x.pid !== old4)).toMatchObject({ hands: 1, vpip: 1, pfr: 1, seated: true });
  });

  it("a new person in a seat with nothing entered takes it in the open hand", () => {
    let s = newSession(6);
    s = acts(s, [[1, "R"]]);
    s = newPerson(s, 4);
    expect(currentHand(s).seats.find(([seat]) => seat === 4)![1]).toBe(at(s, 4));
    s = setSize(s, 5);
    expect(currentHand(s).seats.map(([seat]) => seat)).toEqual([1, 2, 3, 4, 5]);
  });

  it("lists showdowns with position and result", () => {
    let s = setButton(newSession(9), 5);
    s = acts(s, [[5, "R"]]);
    s = setShow(s, at(s, 5), "k9s");
    s = toggleWon(s, at(s, 5));
    s = nextHand(s);
    const p = sessionStats(s).find((x) => x.seat === 5)!;
    expect(p.shows).toEqual([{ no: 1, pos: "BTN", show: "K9s", cls: "K9s", won: true, act: "R" }]);
  });
});

describe("이전 핸드", () => {
  it("goes back to fix a hand and 다음 핸드 returns without making a new one", () => {
    let s = newSession(9);
    s = nextHand(nextHand(s));
    expect(s.hands).toHaveLength(3);
    s = prevHand(s);
    expect(currentHand(s).no).toBe(2);
    s = tapAct(s, at(s, 4), "R");
    expect(s.hands[1].acts[at(s, 4)]).toBe("R");
    s = nextHand(s);
    expect(s.hands).toHaveLength(3);
    expect(currentHand(s).no).toBe(3);
    expect(prevHand(prevHand(prevHand(s))).cur).toBe(0);
  });
});

describe("showdown text", () => {
  it("reads classes and exact cards", () => {
    expect(parseShow("K9s")).toEqual({ ok: true, norm: "K9s", cls: "K9s", exact: false });
    expect(parseShow("9ks")).toMatchObject({ ok: true, norm: "K9s" });
    expect(parseShow("aqo")).toMatchObject({ ok: true, norm: "AQo", cls: "AQo" });
    expect(parseShow("77")).toMatchObject({ ok: true, norm: "77", cls: "77" });
    expect(parseShow("AK")).toMatchObject({ ok: true, norm: "AK", cls: "AK" });
    expect(parseShow("Kh9h")).toEqual({ ok: true, norm: "Kh9h", cls: "K9s", exact: true });
    expect(parseShow("9hkh")).toMatchObject({ ok: true, norm: "Kh9h" });
    expect(parseShow("10s 10d")).toMatchObject({ ok: true, norm: "TsTd", cls: "TT" });
    expect(parseShow("AsKd")).toMatchObject({ cls: "AKo" });
  });

  it("rejects nonsense and flags half-typed text", () => {
    expect(parseShow("77s")).toEqual({ ok: false, partial: false });
    expect(parseShow("KhKh")).toEqual({ ok: false, partial: false });
    expect(parseShow("Kx")).toEqual({ ok: false, partial: false });
    expect(parseShow("K")).toEqual({ ok: false, partial: true });
    expect(parseShow("Kh")).toEqual({ ok: false, partial: true });
    expect(parseShow("Kh9")).toEqual({ ok: false, partial: true });
    expect(parseShow("")).toEqual({ ok: false, partial: true });
  });
});

describe("sanitize and import merge", () => {
  it("drops broken parts and keeps the good ones", () => {
    const good = newSession(9);
    const bad = { ...newSession(9), id: "!!", size: 99 };
    const broken = JSON.parse(JSON.stringify({ v: 1, active: "nope", sessions: [good, bad, null, 5, { id: "abcd1234", size: 7 }] }));
    broken.sessions[0].hands[0].acts = { [good.occ[0]!]: "R", zzzz: "R", [good.occ[1]!]: "X" };
    broken.sessions[0].hands[0].note = "x".repeat(500);
    const st = sanitizeState(broken);
    expect(st.sessions.map((s) => s.id)).toEqual([good.id, "abcd1234"]);
    expect(st.sessions[0].hands[0].acts).toEqual({ [good.occ[0]!]: "R" });
    expect(st.sessions[0].hands[0].note).toHaveLength(200);
    // a session with no hands gets an open one so the screen always has a hand
    expect(st.sessions[1].hands).toHaveLength(1);
    expect(st.sessions[1].size).toBe(7);
    expect(st.active).toBe("abcd1234");
    expect(sanitizeState(null)).toEqual({ v: 1, active: null, sessions: [] });
    expect(sanitizeState({ sessions: "x" })).toEqual({ v: 1, active: null, sessions: [] });
  });

  it("survives a JSON round trip unchanged", () => {
    let s = setButton(newSession(9), 5);
    s = acts(s, [[8, "L"], [5, "R"], [8, "L"]]);
    s = setShow(s, at(s, 5), "Kh9h");
    s = nextHand(s);
    const st: ScoutState = { v: 1, active: s.id, sessions: [s] };
    expect(sanitizeState(JSON.parse(JSON.stringify(st)))).toEqual(st);
  });

  it("merges by id: new sessions and hands added, the later edit wins", () => {
    let a = newSession(9);
    a = nextHand(tapAct(a, at(a, 1), "R"));
    const base: ScoutState = { v: 1, active: a.id, sessions: [a] };
    // the other copy: hand 1 edited later, one hand more, plus a whole other session
    let b: ScoutSession = JSON.parse(JSON.stringify(a));
    b.hands[0] = { ...b.hands[0], acts: { [at(b, 1)]: "3" }, t: b.hands[0].t + 1000 };
    b = tapAct(b, at(b, 2), "L");
    b.hands[1] = { ...b.hands[1], t: b.hands[1].t + 1000 };
    b = nextHand(b);
    const other = newSession(6);
    const { state, sessions, hands } = mergeState(base, { v: 1, active: other.id, sessions: [b, other] });
    expect(sessions).toBe(1);
    expect(hands).toBe(2); // hand 1 edited later, hand 2 entered there (the open hand 3 and the blank session don't count)
    const merged = state.sessions.find((s) => s.id === a.id)!;
    expect(merged.hands.map((h) => h.no)).toEqual([1, 2, 3]);
    expect(merged.hands[0].acts[at(a, 1)]).toBe("3");
    expect(state.active).toBe(a.id);
    // merging the same thing again adds nothing
    const again = mergeState(state, { v: 1, active: null, sessions: [b, other] });
    expect(again.sessions + again.hands).toBe(0);
    expect(again.state).toEqual(state);
  });
});

describe("fixes from review", () => {
  it("deleting a stray empty hand puts the button back and renumbers", () => {
    let s = setButton(newSession(6), 1);
    s = acts(s, [[4, "L"]]);
    s = nextHand(nextHand(s)); // a double tap: #2 closed empty, #3 open with the button two seats on
    expect(currentHand(s)).toMatchObject({ no: 3, button: 3 });
    s = prevHand(s);
    s = deleteHand(s);
    expect(s.hands.map((h) => h.no)).toEqual([1, 2]);
    expect(s.cur).toBe(1);
    expect(currentHand(s)).toMatchObject({ no: 2, button: 2 });
    expect(sessionStats(s).find((x) => x.seat === 3)!.hands).toBe(1);
    // the open latest hand cannot be deleted
    expect(deleteHand(s)).toBe(s);
  });

  it("moving my seat keeps my history mine and the old occupant's stats theirs", () => {
    let s = setMySeat(newSession(9), 6);
    const me = at(s, 6);
    const red = at(s, 2);
    s = acts(s, [[6, "R"], [2, "L"]]);
    s = nextHand(s);
    s = setMySeat(s, 2); // I moved to seat 2
    expect(at(s, 2)).toBe(me);
    expect(s.occ[5]).toBeNull();
    expect(s.players[me].me).toBe(true);
    expect(s.players[red].me).toBeUndefined();
    s = acts(s, [[2, "R"]]);
    s = nextHand(s);
    const st = sessionStats(s);
    expect(st.some((x) => x.pid === me)).toBe(false);
    expect(st.find((x) => x.pid === red)).toMatchObject({ hands: 1, vpip: 1, seated: false });
    // the hand on screen has me once, in seat 2, and nobody in the emptied seat 6
    expect(currentHand(s).seats.filter(([, p]) => p === me)).toEqual([[2, me]]);
    expect(currentHand(s).seats.some(([seat]) => seat === 6)).toBe(false);
  });

  it("a me player who leaves the table stays me; picking a seat before any hands just re-flags", () => {
    let s = setMySeat(newSession(6), 3);
    s = setMySeat(s, 5); // fixing the pick: nothing recorded yet
    expect(s.players[at(s, 3)].me).toBeUndefined();
    expect(s.players[at(s, 5)].me).toBe(true);
    const me = at(s, 5);
    s = acts(s, [[5, "R"]]);
    s = nextHand(s);
    s = toggleEmpty(s, 5); // I left the seat
    expect(s.players[me].me).toBe(true);
    expect(sessionStats(s).some((x) => x.pid === me)).toBe(false);
  });

  it("seat changes made while an older hand is on screen reach the open hand", () => {
    let s = newSession(6);
    s = acts(s, [[1, "L"]]);
    s = nextHand(s);
    s = prevHand(s);
    const old6 = at(s, 6);
    s = toggleEmpty(s, 5);
    s = newPerson(s, 6);
    expect(s.cur).toBe(0);
    s = nextHand(s);
    const h = currentHand(s);
    expect(h.seats.map(([seat]) => seat)).toEqual([1, 2, 3, 4, 6]);
    expect(h.seats.find(([seat]) => seat === 6)![1]).not.toBe(old6);
  });

  it("a →콜 goes away when the raise behind it is cleared", () => {
    let s = setButton(newSession(6), 1); // order 4 5 6 1(BTN) 2 3
    s = acts(s, [[4, "L"], [1, "R"], [4, "L"]]);
    expect(currentHand(s).called).toEqual([at(s, 4)]);
    s = acts(s, [[1, "R"]]); // the raise was a mistake
    expect(currentHand(s).called).toEqual([]);
    expect(sessionStats(nextHand(s)).find((x) => x.seat === 4)).toMatchObject({ limp: 1, limpCall: 0 });
  });

  it("an opener's 4bet is not a 3bet; a limp-reraise is a limp and a 3bet", () => {
    let s = setButton(newSession(6), 1); // order 4(UTG) 5(HJ) 6(CO) 1(BTN) 2(SB) 3(BB)
    // CO opens, BTN 3bets, CO 4bets: both tapped 3벳+
    let f = handFacts(currentHand(acts(s, [[6, "3"], [1, "3"]])));
    expect(f.get(at(s, 6))).toMatchObject({ pfr: true, threeOpp: false, three: false });
    expect(f.get(at(s, 1))).toMatchObject({ threeOpp: true, three: true });
    // UTG limps, BTN isolates, UTG re-raises
    f = handFacts(currentHand(acts(s, [[4, "3"], [1, "R"]])));
    expect(f.get(at(s, 4))).toMatchObject({ vpip: true, limp: true, pfr: true, threeOpp: true, three: true });
    expect(f.get(at(s, 5))).toMatchObject({ threeOpp: false });
    expect(f.get(at(s, 1))).toMatchObject({ pfr: true, threeOpp: false, three: false });
    expect(f.get(at(s, 2))).toMatchObject({ threeOpp: true, three: false });
    // an open-shove is a raise, not a 3bet
    f = handFacts(currentHand(acts(s, [[5, "A"]])));
    expect(f.get(at(s, 5))).toMatchObject({ pfr: true, three: false, threeOpp: false });
    s = acts(s, [[5, "A"], [1, "A"]]);
    expect(handFacts(currentHand(s)).get(at(s, 1))).toMatchObject({ three: true });
  });
});
