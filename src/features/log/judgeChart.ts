import type { HandClass } from "../../poker/cards";
import type { MoveOption } from "../../play/policy";
import { parseRange, type Range } from "../../poker/range";
import { NASH_STAGES } from "../../data/sets/nashData";
import { PREFLOP_STAGES } from "../../data/sets/preflopData";
import type { PreflopStage } from "../../data/sets/preflopTypes";
import { SHORT_NASH_STAGES } from "../../data/sets/shortNashData";
import type { PreStage } from "./quickPre";
import { positionsFor } from "./recorder";

/**
 * The charts 빠른 기록's 아재 judges my two cards by (ajae.ts ajaeTier): our own computed charts, not the hand-made
 * pub chart (hand play keeps that one). Per stage of the screen:
 * - 딥: the solver's 100bb stage with the pub-size 3bb open (100bb-3);
 * - 미들: the solver's 55bb stage (55bb-2.2);
 * - 숏: the short-stack open/jam equilibrium at 17bb (shortNash), as the solver has no stage that short yet;
 * - 푸시: the push/fold Nash at 10bb (nash).
 * Each gives, per seat first in, how often the seat raises or shoves the hand and how often it limps (the solver's SB
 * only), and how often the BB plays the hand (calls, 3-bets or shoves) facing the button's open (the SB's at a
 * heads-up table, where the SB is the button). The trash test's defense is one fixed spot, the solver's 55bb BB
 * against the HJ's open (TRASH_DEFENSE): see ajae.ts.
 *
 * Only the few spots it needs are parsed straight from the generated data (about twenty ranges, a few ms), once per
 * stage and kept; the full solver set (charts.ts getSet("solver"), 633 spots) is never built for it.
 * warmJudgeCharts parses them all ahead of the first hand. A seat of a table that is not 9-handed reads the 9-handed
 * seat with as many players behind it (judgeSeat). Pure apart from the cache.
 */

/** The 9-handed seats the charts are written for, in preflop order. */
const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const sid = (seat: string) => seat.toLowerCase().replace("+", "p");

/** The chart behind each stage of the screen (see above). */
export const JUDGE_SOURCE: Record<PreStage, { kind: "solver"; id: string } | { kind: "shortnash" | "nash"; stack: number }> = {
  deep: { kind: "solver", id: "100bb-3" },
  mid: { kind: "solver", id: "55bb-2.2" },
  short: { kind: "shortnash", stack: 17 },
  push: { kind: "nash", stack: 10 },
};

/** A solver spot by its stage and scenario ids. */
export interface SolverSpot {
  stage: string;
  scenario: string;
}

/** The trash test's defense: the solver's 55bb BB against the HJ's open (ajae.ts TRASH_STAGE). */
export const TRASH_DEFENSE: SolverSpot = { stage: "55bb-2.2", scenario: "bb-vs-hj-open" };

/** Per hand, a share 0~1 (a missing hand: 0). */
type Shares = Partial<Record<HandClass, number>>;

export interface JudgeChart {
  /** First in, per 9-handed seat (UTG..SB): how often the seat raises or shoves the hand. */
  raise: Record<string, Shares>;
  /** First in, per 9-handed seat: how often it limps the hand (only the solver's SB limps). */
  limp: Record<string, Shares>;
  /** The BB's call + 3-bet + shove share facing an open from the 9-handed seat (BTN, and SB for heads-up). */
  bbVs: Record<string, Shares>;
}

/**
 * Range strings of one decision, in action order, turned into per-action shares the way charts.ts builds a scenario:
 * each action takes its range's share of what the earlier ones left.
 */
function fill(ranges: string[]): Shares[] {
  const parsed: Range[] = ranges.map((r) => parseRange(r));
  const out: Shares[] = parsed.map(() => ({}));
  const left: Shares = {};
  parsed.forEach((r, i) => {
    for (const h of Object.keys(r)) {
      const f = Math.min(r[h], left[h] ?? 1);
      if (f <= 0) continue;
      out[i][h] = f;
      left[h] = (left[h] ?? 1) - f;
    }
  });
  return out;
}

const sum = (parts: Shares[]): Shares => {
  const out: Shares = {};
  for (const p of parts) for (const [h, f] of Object.entries(p)) out[h] = (out[h] ?? 0) + (f ?? 0);
  return out;
};

function solverStage(id: string): PreflopStage {
  const st = PREFLOP_STAGES.find((s) => s.id === id);
  if (!st) throw new Error(`no solver stage ${id}`);
  return st;
}

/** One solver spot's shares: its raises and shoves, and its limps. */
function solverSpot(st: PreflopStage, id: string): { raise: Shares; limp: Shares } {
  const sc = st.scenarios.find((s) => s.id === id);
  if (!sc) return { raise: {}, limp: {} };
  const parts = fill(sc.actions.map((a) => a.range));
  return { raise: sum(parts.filter((_, i) => sc.actions[i].key !== "limp")), limp: sum(parts.filter((_, i) => sc.actions[i].key === "limp")) };
}

function build(stage: PreStage): JudgeChart {
  const src = JUDGE_SOURCE[stage];
  const raise: Record<string, Shares> = {};
  const limp: Record<string, Shares> = {};
  const bbVs: Record<string, Shares> = {};
  const first = POS.slice(0, 8);
  if (src.kind === "solver") {
    const st = solverStage(src.id);
    for (const seat of first) ({ raise: raise[seat], limp: limp[seat] } = solverSpot(st, `rfi-${sid(seat)}`));
    // facing an open, a call is playing the hand too
    for (const opener of ["BTN", "SB"]) {
      const s = solverSpot(st, `bb-vs-${sid(opener)}-open`);
      bbVs[opener] = sum([s.raise, s.limp]);
    }
  } else if (src.kind === "shortnash") {
    const st = SHORT_NASH_STAGES.find((s) => s.stack === src.stack)!;
    for (const seat of first) {
      raise[seat] = sum(fill([st.open[seat], st.jam[seat]]));
      limp[seat] = {};
    }
    // the shortNash set's BB facing an open: re-jam first, then flat
    for (const opener of ["BTN", "SB"]) bbVs[opener] = sum(fill([st.reJam.BB[opener], st.bbCall[opener]]));
  } else {
    const st = NASH_STAGES.find((s) => s.stack === src.stack)!;
    for (const seat of first) {
      raise[seat] = sum(fill([st.push[seat]]));
      limp[seat] = {};
    }
    for (const opener of ["BTN", "SB"]) bbVs[opener] = sum(fill([st.call.BB[opener]]));
  }
  return { raise, limp, bbVs };
}

const built = new Map<PreStage, JudgeChart>();
const defenses = new Map<string, Shares>();

/** The stage's judge chart, parsed the first time it is asked for. */
export function judgeChart(stage: PreStage): JudgeChart {
  let c = built.get(stage);
  if (!c) built.set(stage, (c = build(stage)));
  return c;
}

/** A solver spot's non-fold share per hand (a call is playing the hand), parsed the first time it is asked for. */
function defense(spot: SolverSpot): Shares {
  const key = `${spot.stage}/${spot.scenario}`;
  let d = defenses.get(key);
  if (!d) {
    const s = solverSpot(solverStage(spot.stage), spot.scenario);
    defenses.set(key, (d = sum([s.raise, s.limp])));
  }
  return d;
}

/** Parse every stage's chart and the trash defense now (FastView, while idle), so the first hand typed doesn't wait. */
export function warmJudgeCharts(): void {
  for (const st of Object.keys(JUDGE_SOURCE) as PreStage[]) judgeChart(st);
  defense(TRASH_DEFENSE);
}

/**
 * The 9-handed seat that plays like `seat` at a table of `players`: the one with as many players behind it (a
 * 6-handed UTG is the LJ, a 7-handed UTG the UTG+2; the 10-handed UTG and UTG+1 both read UTG, its MP the UTG+2).
 * A seat the table doesn't have stays as it is.
 */
export function judgeSeat(players: number, seat: string): string {
  const seats = positionsFor(players);
  const i = seats.indexOf(seat);
  if (i < 0) return seat;
  return POS[Math.max(0, POS.length - seats.length + i)];
}

/** How often `seat` raises or shoves `cls` first in at the stage (the BB: 0). */
export const raiseShare = (stage: PreStage, players: number, seat: string, cls: HandClass): number => judgeChart(stage).raise[judgeSeat(players, seat)]?.[cls] ?? 0;

/** How often `seat` limps `cls` first in at the stage (only the SB, at the solver's stages). */
export const limpShare = (stage: PreStage, players: number, seat: string, cls: HandClass): number => judgeChart(stage).limp[judgeSeat(players, seat)]?.[cls] ?? 0;

/** How often the BB plays `cls` (calls, 3-bets or shoves) facing the open of `opener` (the button, or the heads-up SB). */
export const bbPlayShare = (stage: PreStage, players: number, opener: string, cls: HandClass): number => judgeChart(stage).bbVs[judgeSeat(players, opener)]?.[cls] ?? 0;

/** How often the hero of a solver spot plays `cls` (calls, raises or shoves): the trash test's BB (TRASH_DEFENSE). */
export const trashDefenseShare = (spot: SolverSpot, cls: HandClass): number => defense(spot)[cls] ?? 0;

// ───────────── 빠른 기록's verdict at 딥 and 미들 ─────────────

/** A solver chart for one decision, as 빠른 기록's verdict (fastVerdict.ts) reads it. */
export interface SolverChart {
  /** "솔버 100bb", "솔버 55bb": the chart the verdict names. */
  name: string;
  /** The spot's title in the solver set: "BTN 오픈 레인지", "BB vs HJ 오픈". */
  title: string;
  /** The chart's moves with the hand: a limp as a call, the open, the SB's raise and a 3-bet as raises to their size. */
  moves: (cls: HandClass) => MoveOption[];
}

const solverCharts = new Map<string, Omit<SolverChart, "moves"> & { parts: Shares[]; kinds: Omit<MoveOption, "prob">[] }>();

/**
 * The solver's chart for my decision at the stage, first in (no `opener`) or facing one open from `opener`: the
 * stage's solver spot (deep: 100bb-3, middle: 55bb-2.2), my seat and the opener's read as the 9-handed seats with as
 * many players behind them (judgeSeat). Null at the short and push stages, for the BB first in, and for a spot the
 * solver didn't export: the verdict keeps the pub chart there. A 10-handed UTG+1 facing the UTG reads the 9-handed UTG+1.
 * `allInTo` is my whole stack, a shove's size. Each spot is parsed once.
 */
export function solverChart(stage: PreStage, players: number, seat: string, opener: string | undefined, allInTo: number): SolverChart | null {
  const src = JUDGE_SOURCE[stage];
  if (src.kind !== "solver") return null;
  const by = opener === undefined ? undefined : judgeSeat(players, opener);
  let me = judgeSeat(players, seat);
  // 10-handed, UTG and UTG+1 both read UTG: facing the UTG's open, the UTG+1 is the seat after it (only then: a seat
  // facing an open from behind it is no spot, and finds no solver chart)
  const seats = positionsFor(players);
  if (opener !== undefined && me === by && seats.indexOf(opener) < seats.indexOf(seat)) me = POS[POS.indexOf(me) + 1];
  if (by === undefined && me === "BB") return null;
  const id = by === undefined ? `rfi-${sid(me)}` : `${sid(me)}-vs-${sid(by)}-open`;
  const key = `${src.id}/${id}`;
  let c = solverCharts.get(key);
  if (!c) {
    const st = solverStage(src.id);
    const sc = st.scenarios.find((s) => s.id === id);
    if (!sc) return null;
    const size = (label: string) => Number(/([\d.]+)bb/.exec(label)?.[1] ?? NaN);
    c = {
      name: `솔버 ${st.stack}bb`,
      title: sc.title,
      parts: fill(sc.actions.map((a) => a.range)),
      kinds: sc.actions.map((a): Omit<MoveOption, "prob"> => (a.key === "call" || a.key === "limp" ? { kind: "call" } : { kind: "raise", to: Number.isFinite(size(a.label)) ? size(a.label) : Infinity })),
    };
    solverCharts.set(key, c);
  }
  const { parts, kinds } = c;
  const moves = (cls: HandClass): MoveOption[] => {
    const out: MoveOption[] = [];
    let left = 1;
    parts.forEach((p, i) => {
      const f = p[cls] ?? 0;
      if (f <= 0) return;
      const k = kinds[i];
      out.push({ ...k, ...(k.to !== undefined ? { to: Math.min(k.to, allInTo) } : {}), prob: f });
      left -= f;
    });
    if (left > 1e-9) out.push({ kind: "fold", prob: left });
    return out;
  };
  return { name: c.name, title: c.title, moves };
}
