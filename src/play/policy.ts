import type { Card, HandClass } from "../poker/cards";
import { parseRange, type Range } from "../poker/range";
import { getSet, type HandStrategy, type Scenario, type Stage } from "../data/charts";
import { handFeatures, type HandFeatures } from "./handInfo";

/** A concrete move with its probability. `to` is the total street bet after a bet/raise. */
export interface MoveOption {
  kind: "fold" | "check" | "call" | "raise";
  to?: number;
  prob: number;
}

export const EARLY_SEATS = ["UTG", "UTG+1", "UTG+2"];
export const LATE_SEATS = ["HJ", "CO", "BTN", "SB"];

export function playStage(stageId: string): Stage {
  return getSet("yajasu").stages.find((s) => s.id === stageId)!;
}

/** Starting stack (bb) per chart stage. */
export const STAGE_STACK: Record<string, number> = { deep: 100, mid: 55, short: 17, push: 11 };
/** Open size (bb) for the "open" action per stage. */
const OPEN_SIZE: Record<string, number> = { deep: 3, mid: 2.5, short: 2, push: 2 };

/** What a preflop decision looks like to the chart lookup. */
export interface PreflopSpot {
  stageId: string;
  seat: string;
  /** Number of voluntary raises so far (0 = unopened). */
  raises: number;
  openerSeat?: string;
  /** Seat that made the last raise. */
  lastRaiserSeat?: string;
  /** I'm the player who opened. */
  iAmOpener: boolean;
  /** The current bet is someone's all-in. */
  facingAllIn: boolean;
  currentBet: number;
  myBet: number;
  myStack: number; // behind
  limpers: number;
}

/** Hand-class level strategy: for each class, the probability of each move. */
export interface PreflopDecision {
  scenario?: Scenario;
  label: string;
  moves: (h: HandClass) => MoveOption[];
}

function fromRanges(spec: { kind: MoveOption["kind"]; to?: number; range: Range }[], rest: MoveOption["kind"]) {
  return (h: HandClass): MoveOption[] => {
    let left = 1;
    const out: MoveOption[] = [];
    for (const s of spec) {
      const p = Math.min(s.range[h] ?? 0, left);
      if (p > 0) out.push({ kind: s.kind, to: s.to, prob: p });
      left -= p;
    }
    if (left > 1e-9) out.push({ kind: rest, prob: left });
    return out;
  };
}

function fromScenario(sc: Scenario, map: (key: string) => { kind: MoveOption["kind"]; to?: number }, rest: MoveOption["kind"]) {
  return (h: HandClass): MoveOption[] => {
    const st: HandStrategy = sc.strategy[h];
    const out: MoveOption[] = [];
    for (const a of sc.actions) {
      const p = st[a.key] ?? 0;
      if (p > 0) out.push({ ...map(a.key), prob: p });
    }
    if (st.fold > 1e-9) out.push({ kind: rest, prob: st.fold });
    return out;
  };
}

const R = (s: string) => parseRange(s);
const TIGHT_CONTINUE = R("QQ+, AKs, AKo");
const PREMIUM = R("KK+, AKs");

/** Find the chart scenario for this seat facing an open from `opener`. */
const SEAT_ORDER = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

function findVsOpen(stage: Stage, seat: string, opener: string): Scenario | undefined {
  // Opener acted after me (I limped, then got raised): no chart for that.
  if (SEAT_ORDER.indexOf(opener) > SEAT_ORDER.indexOf(seat)) return undefined;
  const vs = stage.scenarios.filter((s) => s.kind === "vsOpen");
  const mine = (s: Scenario) => (s.heroSeats ?? [s.hero]).includes(seat);
  const fits = (s: Scenario) => (s.villainSeats ?? [s.villain]).includes(opener);
  return (
    vs.find((s) => mine(s) && fits(s)) ??
    vs.find((s) => s.hero === "Hero" && fits(s)) ??
    // Same seat, different opener group: closest charted spot.
    vs.find((s) => mine(s))
  );
}

function callRangeVsShove(stage: Stage, shover: string): { sc?: Scenario; range: Range } {
  const id = EARLY_SEATS.includes(shover) || shover === "LJ" ? "call-vs-early-shove" : "call-vs-late-shove";
  const sc =
    stage.scenarios.find((s) => s.id.endsWith(`/${id}`)) ?? stage.scenarios.find((s) => s.kind === "vsShove");
  return sc ? { sc, range: sc.ranges.call } : { range: TIGHT_CONTINUE };
}

export function preflopDecision(spot: PreflopSpot): PreflopDecision {
  const stage = playStage(spot.stageId);
  const allInTo = spot.myBet + spot.myStack;
  const cap = (x: number) => Math.min(x, allInTo);

  // Facing an all-in: call or fold.
  if (spot.facingAllIn) {
    const { sc, range } = spot.raises >= 2 && !spot.iAmOpener ? { sc: undefined, range: TIGHT_CONTINUE } : callRangeVsShove(stage, spot.lastRaiserSeat!);
    return { scenario: sc, label: sc?.title ?? "올인에 콜 (QQ+, AK)", moves: fromRanges([{ kind: "call", range }], "fold") };
  }

  if (spot.raises === 0) {
    if (spot.seat === "BB") {
      // Limped (or folded) to the BB: raise premiums, otherwise check.
      const to = cap(4 + spot.limpers);
      return { label: "BB 옵션", moves: fromRanges([{ kind: "raise", to, range: R("QQ+, AKs, AKo") }], "check") };
    }
    const sc = stage.scenarios.find((s) => s.kind === "rfi" && s.hero === spot.seat)!;
    const openTo = cap(OPEN_SIZE[spot.stageId] + spot.limpers);
    return {
      scenario: sc,
      label: sc.title,
      moves: fromScenario(sc, (k) => (k === "shove" ? { kind: "raise", to: allInTo } : { kind: "raise", to: k === "small" ? cap(2 + spot.limpers) : openTo }), "fold"),
    };
  }

  if (spot.raises === 1) {
    const sc = findVsOpen(stage, spot.seat, spot.openerSeat!);
    const threeBetTo = cap(spot.currentBet * (spot.seat === "SB" || spot.seat === "BB" ? 3.5 : 3));
    if (sc) {
      return {
        scenario: sc,
        label: sc.title,
        moves: fromScenario(sc, (k) => (k === "call" ? { kind: "call" } : k === "shove" ? { kind: "raise", to: allInTo } : { kind: "raise", to: threeBetTo }), "fold"),
      };
    }
    // Not charted: tight cold-call fallback.
    return {
      label: "차트에 없는 대응 (타이트 기본값)",
      moves: fromRanges(
        [
          { kind: "raise", to: threeBetTo, range: TIGHT_CONTINUE },
          { kind: "call", range: R("22-JJ, AJs-AQs, KQs, JTs") },
        ],
        "fold",
      ),
    };
  }

  // Facing a 3-bet or more.
  if (spot.raises === 2 && spot.iAmOpener) {
    const sc = stage.scenarios.find((s) => s.kind === "vs3bet");
    if (sc) {
      const fourTo = cap(spot.currentBet * 2.3);
      return {
        scenario: sc,
        label: sc.title,
        moves: fromScenario(sc, (k) => (k === "call" ? { kind: "call" } : k === "4bet" ? { kind: "raise", to: spot.stageId === "mid" ? allInTo : fourTo } : { kind: "raise", to: allInTo }), "fold"),
      };
    }
    const { sc: sv, range } = callRangeVsShove(stage, spot.lastRaiserSeat!);
    return { scenario: sv, label: "3벳에 대응", moves: fromRanges([{ kind: "raise", to: allInTo, range }], "fold") };
  }
  // Cold vs 3-bet, or facing a 4-bet+: continue only with premiums.
  return {
    label: "4벳 이상에 대응 (KK+, AKs)",
    moves: fromRanges([{ kind: "raise", to: allInTo, range: PREMIUM }, { kind: "call", range: R("QQ, AKo") }], "fold"),
  };
}

// ───────────────────────── Postflop ─────────────────────────

export interface PostflopSpot {
  board: Card[];
  pot: number; // including all bets on the table
  toCall: number;
  currentBet: number;
  myBet: number;
  myStack: number;
  opponents: number; // still in the hand
  aggressor: boolean; // I was the last preflop raiser
  facingRaise: boolean;
  street: "flop" | "turn" | "river";
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Pub-style rules: value-heavy, sticky with pairs, few bluffs. */
export function postflopMoves(f: HandFeatures, s: PostflopSpot): MoveOption[] {
  const allInTo = s.myBet + s.myStack;
  const betTo = (frac: number) => Math.min(allInTo, Math.max(1, Math.round(s.pot * frac * 10) / 10));
  const raiseTo = Math.min(allInTo, Math.round(s.currentBet * 3 * 10) / 10);
  const multi = s.opponents >= 2;
  const t = f.tier;

  if (s.toCall <= 0) {
    let p = 0, frac = 0.5;
    if (t === 4) [p, frac] = [0.7, 0.66];
    else if (t === 3) [p, frac] = [0.6, 0.5];
    else if (t === 2.5) [p, frac] = [0.55, 0.66];
    else if (t === 2) [p, frac] = [s.aggressor && !multi && s.street === "flop" ? 0.45 : 0.25, 0.33];
    else if (t === 1.5) [p, frac] = [0.3, 0.5];
    else if (t === 1) [p, frac] = [s.aggressor && !multi && s.street === "flop" ? 0.35 : 0.1, 0.33];
    else [p, frac] = [s.aggressor && !multi && s.street === "flop" ? 0.4 : 0.08, 0.33];
    if (multi && t <= 2) p /= 2;
    // Low SPR: strong hands just get it in.
    const to = t >= 3 && s.myStack <= s.pot * 1.2 ? allInTo : betTo(frac);
    const out: MoveOption[] = [
      { kind: "raise", to, prob: p },
      { kind: "check", prob: 1 - p },
    ];
    return out.filter((m) => m.prob > 0);
  }

  const req = s.toCall / (s.pot + s.toCall);
  let call = 0, raise = 0;
  if (t === 4) [call, raise] = [0.65, 0.35];
  else if (t === 3) [call, raise] = req > 0.4 ? [0.7, 0.05] : [0.85, 0.1];
  else if (t === 2.5) [call, raise] = [0.7, 0.2];
  else if (t === 2) call = s.street === "river" ? (req <= 0.25 ? 0.6 : 0.3) : req <= 0.3 ? 0.75 : 0.35;
  else if (t === 1.5) call = s.street === "river" ? 0 : req <= 0.3 ? 0.75 : 0.4;
  else if (t === 1) call = req <= 0.25 ? 0.55 : 0.25; // stations: bottom pair / ace high hang on
  else [call, raise] = [0.05, 0.03];
  if (s.facingRaise && t <= 2.5) {
    // Pub players still call raises fairly often.
    call *= t >= 2 ? 0.8 : 0.6;
    raise *= 0.3;
  }
  // Can't raise if calling already puts me all-in.
  if (s.toCall >= s.myStack) {
    call = clamp01(call + raise);
    raise = 0;
  }
  call = clamp01(call);
  raise = clamp01(Math.min(raise, 1 - call));
  const fold = clamp01(1 - call - raise);
  return [
    { kind: "raise" as const, to: raiseTo <= s.currentBet ? allInTo : raiseTo, prob: raise },
    { kind: "call" as const, prob: call },
    { kind: "fold" as const, prob: fold },
  ].filter((m) => m.prob > 0);
}

export function postflopMovesFor(hole: Card[], s: PostflopSpot): MoveOption[] {
  return postflopMoves(handFeatures(hole, s.board), s);
}

export function sample(moves: MoveOption[]): MoveOption {
  let x = Math.random();
  for (const m of moves) {
    x -= m.prob;
    if (x <= 0) return m;
  }
  return moves[moves.length - 1];
}
