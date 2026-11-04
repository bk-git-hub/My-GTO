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

/** pub: 9-handed pub tournament with BB ante. cash: 6-max 100bb cash game. */
export type PlayMode = "pub" | "cash";
/** Chart set each mode's bots play from. */
export const MODE_SET: Record<PlayMode, string> = { pub: "pub", cash: "cash6" };

export function playStage(mode: PlayMode, stageId: string): Stage {
  const set = getSet(MODE_SET[mode]);
  return set.stages.find((s) => s.id === stageId) ?? set.stages[0];
}

/** Starting stack (bb) per chart stage. */
export const STAGE_STACK: Record<string, number> = { deep: 100, mid: 55, short: 17, push: 11, "100bb": 100 };
/** Open size (bb) for the "open" action per pub stage. */
const OPEN_SIZE: Record<string, number> = { deep: 3, mid: 2.5, short: 2, push: 2 };

/** First-in raise size (bb), before adding 1bb per limper. Cash: 2.5bb, 3bb from the SB. */
export function openSize(mode: PlayMode, stageId: string, seat: string): number {
  if (mode === "cash") return seat === "SB" ? 3 : 2.5;
  return OPEN_SIZE[stageId] ?? 2.5;
}

/** 3-bet size (total bb) over an open of `currentBet`. Cash: 3x in position, 4.4x from the blinds (3x BB vs SB). */
export function threeBetSize(mode: PlayMode, seat: string, opener: string | undefined, currentBet: number): number {
  const blinds = seat === "SB" || seat === "BB";
  if (mode === "cash") return currentBet * (blinds && opener !== "SB" ? 4.4 : 3);
  return currentBet * (blinds ? 3.5 : 3);
}

/** What a preflop decision looks like to the chart lookup. */
export interface PreflopSpot {
  mode: PlayMode;
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

/** Find the chart scenario for this seat facing an open from `opener`. `seats` is the preflop order. */
function findVsOpen(stage: Stage, seats: string[], seat: string, opener: string): Scenario | undefined {
  const o = seats.indexOf(opener);
  // Opener acted after me (I limped, then got raised): no chart for that.
  if (o > seats.indexOf(seat)) return undefined;
  const vs = stage.scenarios.filter((s) => s.kind === "vsOpen");
  const mine = (s: Scenario) => (s.heroSeats ?? [s.hero]).includes(seat);
  const openers = (s: Scenario) => s.villainSeats ?? (s.villain ? [s.villain] : []);
  const exact = vs.find((s) => mine(s) && openers(s).includes(opener)) ?? vs.find((s) => s.hero === "Hero" && openers(s).includes(opener));
  if (exact) return exact;
  // Uncharted opener: borrow my seat's chart against the closest opener. A chart against an earlier
  // opener is only a bit tight; one against a later (wider) opener is too loose beyond one seat.
  let best: Scenario | undefined;
  let bestD = Infinity;
  for (const s of vs.filter(mine)) {
    for (const v of openers(s)) {
      const i = seats.indexOf(v);
      if (i < 0) continue;
      const d = i <= o ? o - i : i - o === 1 ? 1.5 : Infinity;
      if (d < bestD) [best, bestD] = [s, d];
    }
  }
  return best;
}

function callRangeVsShove(stage: Stage, shover: string): { sc?: Scenario; range: Range } {
  const id = EARLY_SEATS.includes(shover) || shover === "LJ" ? "call-vs-early-shove" : "call-vs-late-shove";
  const sc =
    stage.scenarios.find((s) => s.id.endsWith(`/${id}`)) ?? stage.scenarios.find((s) => s.kind === "vsShove");
  return sc ? { sc, range: sc.ranges.call } : { range: TIGHT_CONTINUE };
}

export function preflopDecision(spot: PreflopSpot): PreflopDecision {
  const stage = playStage(spot.mode, spot.stageId);
  const seats = getSet(MODE_SET[spot.mode]).positions;
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
    const openTo = cap(openSize(spot.mode, spot.stageId, spot.seat) + spot.limpers);
    return {
      scenario: sc,
      label: sc.title,
      moves: fromScenario(sc, (k) => (k === "shove" ? { kind: "raise", to: allInTo } : { kind: "raise", to: k === "small" ? cap(2 + spot.limpers) : openTo }), "fold"),
    };
  }

  if (spot.raises === 1) {
    const sc = findVsOpen(stage, seats, spot.seat, spot.openerSeat!);
    const threeBetTo = cap(threeBetSize(spot.mode, spot.seat, spot.openerSeat, spot.currentBet));
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
  /** Bot tendencies. Defaults to "pub". */
  style?: BotStyle;
}

/**
 * pub: 펍아재. Value-heavy, sticky with any pair, few bluffs.
 * reg: cash regular. C-bets and barrels more, semi-bluffs draws, folds weak hands to bets.
 */
export type BotStyle = "pub" | "reg";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Hand-strength rules for bots (and for predicting how they answer hero's bets). */
export function postflopMoves(f: HandFeatures, s: PostflopSpot): MoveOption[] {
  const reg = s.style === "reg";
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
    if (reg && s.aggressor && !multi) {
      // Regulars c-bet small more often and keep barrelling some air and draws.
      if (s.street === "flop" && t <= 2) p = Math.min(0.75, p + 0.15);
      if (s.street === "turn" && t <= 1.5) p = Math.max(p, t === 1.5 ? 0.5 : 0.3);
    }
    if (reg && t === 1.5) p = Math.max(p, 0.4);
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
  if (reg) {
    // Regulars give up weak showdown value, and raise some draws and air as bluffs.
    if (t === 2) call *= 0.85;
    else if (t === 1) call *= 0.55;
    else if (t === 1.5) raise = s.street === "river" ? 0 : 0.12;
    else if (t === 0) [call, raise] = [0.02, s.street === "river" ? 0.03 : 0.06];
  }
  if (s.facingRaise && t <= 2.5) {
    // Pub players still call raises fairly often; regulars much less.
    call *= reg ? (t >= 2 ? 0.65 : 0.35) : t >= 2 ? 0.8 : 0.6;
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
