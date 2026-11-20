import { describe, expect, it } from "vitest";
import { isColdSpot } from "../data/sets/preflop";
import { PREFLOP_STAGES } from "../data/sets/preflopData";
import { getSet } from "../data/charts";
import { NASH_STAGES } from "../data/sets/nashData";
import { fullDeck } from "../poker/cards";
import { positionsFor } from "../features/log/recorder";
import { chartSeat, chartSeats } from "./chartSeat";
import { act, legal, newGame, type Game } from "./engine";
import { nashSpotId, preflopLine, shortNashSpotId, solverSpotId } from "./preflopLine";

const SEATS9 = positionsFor(9);
const table = (players: number, ante = true) => ({ seats: positionsFor(players), bbAnte: ante });
const seatOf = (g: Game) => g.players[g.toAct!].seat;

/**
 * Replay a line in table order: the seats between two actions fold, and the line stops early when it would skip the
 * hero (the tree's R1 order lets a seat act before the hero that table order puts after it). Returns the game at the
 * hero's turn and whether every step of the line was played.
 */
function replayLine(stack: number, hero: string, parts: { seat: string; k: "fold" | "call" | "check" | "raise" | "jam"; to?: number }[], players = 9): { g: Game; complete: boolean } {
  const seats = positionsFor(players);
  let g = newGame(stack, seats.indexOf(hero), fullDeck(), table(players));
  let complete = true;
  for (const p of parts) {
    while (!g.done && seatOf(g) !== p.seat) {
      if (seatOf(g) === hero) {
        complete = false;
        break;
      }
      g = act(g, "fold");
    }
    if (!complete) break;
    if (g.done) throw new Error(`hand over before ${p.seat}`);
    if (p.k === "jam") g = act(g, "raise", legal(g, g.toAct!).maxRaiseTo);
    else g = act(g, p.k, p.to);
  }
  while (complete && !g.done && seatOf(g) !== hero) g = act(g, "fold");
  if (g.done || seatOf(g) !== hero) throw new Error(`hero ${hero} never acts`);
  return { g, complete };
}

/** A data line ("CO 2.2 · BTN 3벳 6.6 · CO 올인", "SB 림프 · BB 레이즈 3.5") as steps. */
function parseLine(line: string): { seat: string; k: "fold" | "call" | "check" | "raise" | "jam"; to?: number }[] {
  if (!line) return [];
  return line.split(" · ").map((part) => {
    const [seat, ...rest] = part.split(" ");
    const words = rest.join(" ");
    const num = Number(rest[rest.length - 1]);
    if (words === "폴드") return { seat, k: "fold" as const };
    if (words === "체크") return { seat, k: "check" as const };
    if (words === "콜" || words === "림프") return { seat, k: "call" as const };
    if (words === "올인") return { seat, k: "jam" as const };
    if (Number.isFinite(num)) return { seat, k: "raise" as const, to: num };
    throw new Error(`can't read ${part}`);
  });
}

describe("solver round trip: every exported spot's own line maps back to its id", () => {
  for (const st of PREFLOP_STAGES) {
    it(`${st.id}: ${st.scenarios.length} spots`, () => {
      const order: string[] = [];
      for (const sc of st.scenarios) {
        const { g, complete } = replayLine(st.stack, sc.hero, parseLine(sc.line));
        const got = solverSpotId(preflopLine(g, g.toAct!));
        // A cold seat behind a non-jam 3-bet only folds or jams in the tree: never a chart to grade by.
        if (complete) expect(got, `${sc.id} · ${sc.line}`).toBe(isColdSpot(sc) ? "cold" : sc.id);
        else {
          // the tree asked a seat before the hero that table order asks after it
          expect(got, `${sc.id} · ${sc.line}`).toBe("order");
          order.push(sc.id);
        }
      }
      // Every spot whose line needs R1's order: a drift in the tree or the mapper shows here.
      expect(order).toEqual(R1_ONLY[st.id] ?? []);
    });
  }
});

/** The spots only R1's answer order reaches (an earlier raiser folds to a jam before a seat ahead of it in table order). */
const R1_ONLY: Record<string, string[]> = {
  "100bb-2.2": ["btn-at-btn-open-sb-3bet-bb-jam"],
  "100bb-3": ["btn-at-btn-open-sb-3bet-bb-jam"],
};

describe("short-stack and push/fold round trips", () => {
  it("every shortNash 17bb spot", () => {
    const data = new Set(getSet("shortnash").stages.find((s) => s.id === "17bb")!.scenarios.map((s) => s.id.replace("shortnash/17bb/", "")));
    const want: string[] = [];
    const got: string[] = [];
    const ask = (hero: string, parts: Parameters<typeof replayLine>[2]) => got.push(shortNashSpotId(preflopLine(replayLine(17, hero, parts).g, SEATS9.indexOf(hero))) as string);
    for (const me of SEATS9.slice(0, 8)) {
      want.push(`rfi-${id(me)}`);
      ask(me, []);
    }
    for (const me of SEATS9.slice(1)) {
      for (const o of SEATS9.slice(0, SEATS9.indexOf(me)).filter((s) => s !== "BB")) {
        want.push(`${id(me)}-vs-${id(o)}-open`, `call-${id(me)}-vs-${id(o)}`);
        ask(me, [{ seat: o, k: "raise", to: 2 }]);
        ask(me, [{ seat: o, k: "jam" }]);
      }
    }
    for (const o of SEATS9.slice(0, 8)) {
      for (const j of SEATS9.slice(SEATS9.indexOf(o) + 1)) {
        want.push(`${id(o)}-open-vs-${id(j)}-jam`);
        ask(o, [{ seat: o, k: "raise", to: 2 }, { seat: j, k: "jam" }]);
      }
    }
    expect(got).toEqual(want);
    // every spot of the stage, and only those
    expect(new Set(want)).toEqual(data);
  });

  it("every nash 10bb spot", () => {
    expect(NASH_STAGES.some((s) => s.stack === 10)).toBe(true);
    for (const me of SEATS9.slice(0, 8)) expect(nashSpotId(preflopLine(replayLine(10, me, []).g, SEATS9.indexOf(me)))).toBe(`push-${id(me)}`);
    for (const me of SEATS9.slice(1))
      for (const j of SEATS9.slice(0, SEATS9.indexOf(me)))
        expect(nashSpotId(preflopLine(replayLine(10, me, [{ seat: j, k: "jam" }]).g, SEATS9.indexOf(me)))).toBe(`call-${id(me)}-vs-${id(j)}`);
    // a min-raise is not a push/fold line
    expect(nashSpotId(preflopLine(replayLine(10, "BB", [{ seat: "CO", k: "raise", to: 2 }]).g, 8))).toBe("offTree");
  });
});

const id = (s: string) => s.toLowerCase().replace("+", "p");

describe("seats of other tables", () => {
  it("reads each seat as the 9-handed seat with as many players behind it", () => {
    expect(chartSeat(positionsFor(6), "UTG")).toBe("LJ");
    expect(chartSeat(positionsFor(7), "UTG")).toBe("UTG+2");
    expect(chartSeat(positionsFor(10), "UTG+1")).toBe("UTG");
    expect(chartSeat(positionsFor(10), "MP")).toBe("UTG+2");
    // 10-handed, the UTG+1 facing the UTG's open moves up one
    expect(chartSeats(positionsFor(10), ["UTG", "UTG+1"])?.get("UTG+1")).toBe("UTG+1");
  });

  it("maps whole lines at other tables", () => {
    const six = newGame(55, 0, fullDeck(), table(6));
    expect(solverSpotId(preflopLine(six, 0))).toBe("rfi-lj");
    const { g } = replayLine(100, "UTG+1", [{ seat: "UTG", k: "raise", to: 2.2 }], 10);
    expect(solverSpotId(preflopLine(g, 1))).toBe("utgp1-vs-utg-open");
  });
});

describe("lines with no spot, and why", () => {
  it("an SB limp is the BB's limped-pot spot; any other limp is a limp pot", () => {
    expect(solverSpotId(preflopLine(replayLine(100, "BB", [{ seat: "SB", k: "call" }]).g, 8))).toBe("bb-vs-sb-limp");
    // the mockup hand: UTG limps, CO raises, the BB decides
    expect(solverSpotId(preflopLine(replayLine(40, "BB", [{ seat: "UTG", k: "call" }, { seat: "CO", k: "raise", to: 3 }]).g, 8))).toBe("limp");
  });

  it("two callers, a cold player behind a 3-bet, a called jam", () => {
    const multi = replayLine(100, "BB", [{ seat: "UTG", k: "raise", to: 2.2 }, { seat: "HJ", k: "call" }, { seat: "BTN", k: "call" }]);
    expect(solverSpotId(preflopLine(multi.g, 8))).toBe("bb-at-utg-open-hj-call-btn-call"); // looked up; the data has none
    const cold = replayLine(100, "BTN", [{ seat: "HJ", k: "raise", to: 2.2 }, { seat: "CO", k: "raise", to: 6.6 }]);
    expect(solverSpotId(preflopLine(cold.g, 6))).toBe("cold");
    const called = replayLine(30, "BB", [{ seat: "CO", k: "jam" }, { seat: "BTN", k: "call" }]);
    expect(solverSpotId(preflopLine(called.g, 8))).toBe("calledJam");
    // a cold call of a 3-bet takes the line off the tree for everyone after it
    const coldCall = replayLine(100, "BB", [{ seat: "HJ", k: "raise", to: 2.2 }, { seat: "CO", k: "raise", to: 6.6 }, { seat: "BTN", k: "call" }]);
    expect(solverSpotId(preflopLine(coldCall.g, 8))).toBe("cold");
  });

  it("knows an effective jam that is not the raiser's whole stack", () => {
    // UTG has 200bb and raises to 60: everyone else has 50, so it is a jam
    let g = newGame(50, 8, fullDeck(), table(9), [200, 50, 50, 50, 50, 50, 50, 50, 50]);
    g = act(g, "raise", 60);
    for (let i = 1; i < 8; i++) g = act(g, "fold");
    const l = preflopLine(g, 8);
    expect(l.facingJam && l.jamFirstIn).toBe(true);
    expect(solverSpotId(l)).toBe("bb-vs-utg-jam");
  });
});
