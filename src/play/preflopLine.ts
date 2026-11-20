import type { Verb } from "../poker/preflop/tree";
import { chartSeat, chartSeats, seatId } from "./chartSeat";
import type { Game } from "./engine";

/**
 * A real preflop line (the engine's log of a hand, any table of 2–10 seats, any stacks) read the way the solver's tree
 * reads its own lines (src/poker/preflop/tree.ts, export.ts classifyNode), so that a decision of a recorded or played
 * hand finds its spot in the computed charts:
 *  - verbs: a call at no raise is a limp (only the SB's first-in limp is in the tree; any other sets otherLimp), the
 *    first raise is an open (an iso when the BB raises an SB limp), the second a 3-bet (a squeeze when the open has
 *    callers, a re-raise in a limped pot), the third a 4-bet, and any raise that is all-in or covers every live seat
 *    a jam;
 *  - the tree's limits: the first call of a jam closes the action (jamCalled), only the opener or a caller of the open
 *    calls a 3-bet and only once, only the opener 4-bets (not after callers or in a limped pot), nothing but a jam
 *    follows a 4-bet; a line past them is offTree ("cold" when it is a cold player acting behind a 3-bet);
 *  - the answer order after a re-raising jam (R1): live earlier raisers (most recent first), then seats with voluntary
 *    chips, then the cold ones, not the table's order. orderOk says every seat ahead of the hero in that order has
 *    already acted in the real log (otherwise the hero's decision is not the tree's).
 * Seats are chart seats (chartSeat.ts chartSeats). solverSpotId, shortNashSpotId and nashSpotId turn a line into the
 * spot id of the solver, short-stack and push/fold data, or the reason there is none. src/play/preflopLine.test.ts
 * replays every exported spot's own line through the engine and checks it maps back to its id. Pure.
 */

export interface LineStep {
  /** Chart seat. */
  seat: string;
  /** Index in the game's players. */
  idx: number;
  verb: Verb;
  /** Street total after a call or raise. */
  to?: number;
}

export interface PreflopLine {
  players: number;
  /** The decider's chart seat and table seat. */
  hero: string;
  heroSeat: string;
  /** Every preflop action so far (folds included), blinds left out. */
  steps: LineStep[];
  raises: number;
  opener?: string;
  threeBettor?: string;
  lastRaiser?: string;
  jammer?: string;
  /** Every raise in order, as chart seats. */
  raiseSeq: string[];
  /** Seats that called the open (raise 1), in order. */
  callers: string[];
  /** The SB limped first in (the tree's only limp); otherLimp: any other limp. */
  sbLimp: boolean;
  otherLimp: boolean;
  /** The decider faces an uncalled jam; jamFirstIn: that jam was raise 1. */
  facingJam: boolean;
  jamFirstIn: boolean;
  /** Someone already called a jam (the tree closes the action there). */
  jamCalled: boolean;
  heroActed: boolean;
  /** The decider faces an open and a non-jam 3-bet without having put chips in. */
  heroCold: boolean;
  orderOk: boolean;
  /** The line left the tree before this decision ("cold": a cold player acted behind a 3-bet). */
  offTree?: "cold" | "offTree";
  /** The first raise's size when it was not a jam, and whether the SB made it. */
  openTo?: number;
  openBySb: boolean;
  /** The last non-jam raise's size. */
  lastRaiseTo?: number;
  /** Every seat on the line could be read as a chart seat. */
  seatsOk: boolean;
}

const EPS = 1e-9;

/** The preflop line up to now, as decision `idx` of game `g` sees it. */
export function preflopLine(g: Game, idx: number): PreflopLine {
  const n = g.players.length;
  const seats = g.players.map((p) => p.seat);
  const SB = n - 2, BB = n - 1;
  // Preflop the street bet is the hand's total: the most a seat can bet is what it has plus what it put in.
  const cap = g.players.map((p) => p.stack + p.total);
  const bet = new Array<number>(n).fill(0);
  for (const e of g.log) if (e.street === "preflop" && e.kind === "post") bet[e.idx] = e.amount;
  const blind = bet.slice();
  const pre = g.log.filter((e) => e.street === "preflop" && e.kind !== "post");
  const folded = new Array<boolean>(n).fill(false);
  const allIn = new Array<boolean>(n).fill(false);

  const raw: { idx: number; verb: Verb; to?: number }[] = [];
  let raises = 0;
  let opener = -1, threeBettor = -1, lastRaiser = -1, jammer = -1;
  const raiseSeq: number[] = [];
  const callers: number[] = [];
  let called3b = false, sbLimp = false, otherLimp = false;
  let jamOpen = false, jamCalled = false, jamFirstIn = false;
  let jamAt = -1;
  let queue: number[] = [];
  let offTree: PreflopLine["offTree"];
  let openTo: number | undefined, lastRaiseTo: number | undefined;
  let openBySb = false;
  const off = (why: "cold" | "offTree") => (offTree ??= why);

  pre.forEach((e, k) => {
    const i = e.idx;
    if (e.allIn) allIn[i] = true;
    if (e.kind === "fold") {
      folded[i] = true;
      raw.push({ idx: i, verb: "fold" });
      return;
    }
    if (e.kind === "check") {
      raw.push({ idx: i, verb: "check" });
      return;
    }
    if (e.kind === "call") {
      let verb: Verb = "call";
      if (jamOpen) jamCalled = true;
      else if (raises === 0) {
        verb = "limp";
        // The SB first in (everyone before it folded) is the tree's only limper.
        if (i === SB && n >= 2 && raw.every((r) => r.verb === "fold")) sbLimp = true;
        else otherLimp = true;
      } else if (raises === 1) callers.push(i);
      else if (raises === 2) {
        if (i === opener || callers.includes(i)) {
          if (called3b) off("offTree");
          called3b = true;
        } else off("cold");
      } else if (i !== threeBettor) off("offTree");
      bet[i] = e.amount;
      raw.push({ idx: i, verb, to: e.amount });
      return;
    }
    // A bet or raise.
    const to = e.amount;
    const covers = e.allIn || g.players.every((_, j) => j === i || folded[j] || to >= cap[j] - EPS);
    if (jamOpen) off("offTree"); // a bigger stack re-raising an all-in: no such line in the tree
    raises++;
    let verb: Verb;
    if (covers) verb = "jam";
    else if (raises === 1) verb = sbLimp && i === BB ? "iso" : "open";
    else if (raises === 2) verb = sbLimp ? "reraise" : callers.length ? "squeeze" : "3bet";
    else {
      verb = "4bet";
      if (raises > 3) off("offTree");
      else if (i !== opener) off(callers.includes(i) ? "offTree" : "cold");
      else if (callers.length || sbLimp) off("offTree");
    }
    if (raises === 1) {
      opener = i;
      openBySb = i === SB;
      if (!covers) openTo = to;
    }
    if (raises === 2) threeBettor = i;
    const prevRaises = raiseSeq.slice();
    lastRaiser = i;
    raiseSeq.push(i);
    if (!covers) lastRaiseTo = to;
    bet[i] = to;
    if (covers) {
      jamOpen = true;
      jammer = i;
      jamFirstIn = raises === 1;
      jamAt = k;
      // The seats still to answer, in the tree's order: table order after a first-in jam, R1's after a re-raising one.
      const base: number[] = [];
      for (let d = 1; d < n; d++) {
        const o = (i + d) % n;
        if (!folded[o] && !allIn[o]) base.push(o);
      }
      if (raises >= 2) {
        const raisers: number[] = [];
        for (let r = prevRaises.length - 1; r >= 0; r--) {
          const o = prevRaises[r];
          if (o !== i && base.includes(o) && !raisers.includes(o)) raisers.push(o);
        }
        const rest = base.filter((o) => !raisers.includes(o));
        const voluntary = rest.filter((o) => bet[o] > blind[o] + EPS);
        const cold = rest.filter((o) => !(bet[o] > blind[o] + EPS));
        queue = [...raisers, ...voluntary, ...cold];
      } else queue = base;
    }
    raw.push({ idx: i, verb, to });
  });

  // Seats ahead of the hero in the answer order must have answered already.
  let orderOk = true;
  if (jamOpen && !jamCalled) {
    const after = new Set(pre.slice(jamAt + 1).map((e) => e.idx));
    const k = queue.indexOf(idx);
    if (k > 0) orderOk = queue.slice(0, k).every((o) => after.has(o));
  }

  const involved = [...raw.filter((r) => r.verb !== "fold").map((r) => seats[r.idx]), seats[idx]];
  const map = chartSeats(seats, involved);
  const cs = (i: number) => map?.get(seats[i]) ?? chartSeat(seats, seats[i]);
  const heroActed = pre.some((e) => e.idx === idx);
  const facingJam = jamOpen && !jamCalled;
  return {
    players: n,
    hero: cs(idx),
    heroSeat: seats[idx],
    steps: raw.map((r) => ({ seat: cs(r.idx), idx: r.idx, verb: r.verb, ...(r.to !== undefined ? { to: r.to } : {}) })),
    raises,
    ...(opener >= 0 ? { opener: cs(opener) } : {}),
    ...(threeBettor >= 0 ? { threeBettor: cs(threeBettor) } : {}),
    ...(lastRaiser >= 0 ? { lastRaiser: cs(lastRaiser) } : {}),
    ...(jammer >= 0 && facingJam ? { jammer: cs(jammer) } : {}),
    raiseSeq: raiseSeq.map(cs),
    callers: callers.map(cs),
    sbLimp,
    otherLimp,
    facingJam,
    jamFirstIn: facingJam && jamFirstIn,
    jamCalled,
    heroActed,
    heroCold: raises === 2 && !facingJam && idx !== opener && !callers.includes(idx),
    orderOk,
    ...(offTree ? { offTree } : {}),
    ...(openTo !== undefined ? { openTo } : {}),
    openBySb,
    ...(lastRaiseTo !== undefined ? { lastRaiseTo } : {}),
    seatsOk: map !== null,
  };
}

/** Why a decision has no computed chart. */
export type NoChartReason = "limp" | "cold" | "multiway" | "calledJam" | "order" | "rare" | "headsUp" | "offTree" | "seat";
export const NO_CHART_REASONS: ReadonlySet<string> = new Set<NoChartReason>(["limp", "cold", "multiway", "calledJam", "order", "rare", "headsUp", "offTree", "seat"]);
export const isNoChart = (x: string): x is NoChartReason => NO_CHART_REASONS.has(x);

/** The §6.4 generic id: the hero, then every non-fold step as seat and verb ("co-at-lj-open-hj-call"). */
const genericId = (l: PreflopLine) => `${seatId(l.hero)}-at-${l.steps.filter((s) => s.verb !== "fold").map((s) => `${seatId(s.seat)}-${s.verb}`).join("-")}`;

/** The guards every chart shares: the seats, any limp but the SB's, a called jam. */
function guards(l: PreflopLine): NoChartReason | null {
  if (!l.seatsOk) return "seat";
  if (l.otherLimp) return "limp";
  if (l.jamCalled) return "calledJam";
  return null;
}

/**
 * The solver spot id of the decision (export.ts classifyNode's rules, first match wins), or why there is none. A cold
 * player facing an open and a non-jam 3-bet gets none: the tree lets that seat only fold or jam (a tree artifact the quiz
 * never drills), which is not a chart to grade anyone by.
 */
export function solverSpotId(l: PreflopLine): string | NoChartReason {
  const g = guards(l);
  if (g) return g;
  if (!l.orderOk) return "order";
  if (l.offTree) return l.offTree;
  const H = l.hero, h = seatId(H);
  const id = (s: string | undefined) => seatId(s ?? "");
  const noCallers = l.callers.length === 0;
  if (l.raises === 0 && !l.sbLimp) return H === "BB" ? "offTree" : `rfi-${h}`;
  if (l.sbLimp) {
    if (H === "BB" && l.raises === 0) return "bb-vs-sb-limp";
    if (H === "SB" && l.raises === 1) return l.facingJam ? "sb-limp-vs-bb-jam" : "sb-limp-vs-bb-iso";
    if (H === "BB" && l.raises === 2) return l.facingJam ? "bb-iso-vs-sb-jam" : "bb-iso-vs-sb-reraise";
    if (H === "SB" && l.raises === 3 && l.facingJam) return "sb-reraise-vs-bb-jam";
    return "offTree";
  }
  if (l.raises === 1 && !l.facingJam && noCallers && !l.heroActed) return `${h}-vs-${id(l.opener)}-open`;
  if (l.facingJam && l.jamFirstIn && !l.heroActed) return `${h}-vs-${id(l.jammer)}-jam`;
  if (l.raises === 2 && !l.facingJam && H === l.opener && noCallers) return `${h}-open-vs-${id(l.threeBettor)}-3bet`;
  if (l.raises === 2 && l.facingJam && H === l.opener && noCallers && l.jammer === l.threeBettor) return `${h}-open-vs-${id(l.jammer)}-jam`;
  if (l.raises === 3 && !l.facingJam && H === l.threeBettor && noCallers && l.lastRaiser === l.opener) return `${h}-3bet-vs-${id(l.opener)}-4bet`;
  if (l.raises === 3 && l.facingJam && H === l.threeBettor && noCallers && l.jammer === l.opener) return `${h}-3bet-vs-${id(l.opener)}-4bet-jam`;
  const rs = l.raiseSeq;
  if (l.raises === 4 && l.facingJam && H === l.opener && noCallers && l.jammer === l.threeBettor && rs.length === 4 && rs[0] === l.opener && rs[1] === l.threeBettor && rs[2] === l.opener)
    return `${h}-4bet-vs-${id(l.threeBettor)}-jam`;
  if (l.heroCold) return "cold";
  return genericId(l);
}

/**
 * The short-stack chart's spot (shortNash.ts): first in, facing one non-jam open, the opener facing a re-jam, or
 * calling a first-in jam; anything else is off its tree.
 */
export function shortNashSpotId(l: PreflopLine): string | NoChartReason {
  const g = guards(l);
  if (g) return g;
  if (l.sbLimp) return "limp";
  if (l.offTree) return l.offTree;
  const H = l.hero, h = seatId(H);
  const noCallers = l.callers.length === 0;
  if (l.raises === 0) return H === "BB" ? "offTree" : `rfi-${h}`;
  if (l.raises === 1 && !l.facingJam && noCallers && !l.heroActed) return `${h}-vs-${seatId(l.opener!)}-open`;
  if (l.raises === 2 && l.facingJam && H === l.opener && noCallers && l.jammer === l.threeBettor) return `${h}-open-vs-${seatId(l.jammer!)}-jam`;
  if (l.facingJam && l.jamFirstIn && !l.heroActed) return `call-${h}-vs-${seatId(l.jammer!)}`;
  return "offTree";
}

/** The push/fold chart's spot (nash.ts): a push first in, or a call of a first-in push. */
export function nashSpotId(l: PreflopLine): string | NoChartReason {
  const g = guards(l);
  if (g) return g;
  if (l.sbLimp) return "limp";
  const H = l.hero, h = seatId(H);
  if (l.raises === 0) return H === "BB" ? "offTree" : `push-${h}`;
  if (l.facingJam && l.jamFirstIn && !l.heroActed) return `call-${h}-vs-${seatId(l.jammer!)}`;
  return "offTree";
}
