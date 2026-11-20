import { getSet, type Scenario } from "../data/charts";
import { NASH } from "../data/sets/nash";
import { NASH_STAGES } from "../data/sets/nashData";
import { solverSource } from "../data/sets/preflop";
import { SHORT_NASH } from "../data/sets/shortNash";
import { SHORT_NASH_OPEN, SHORT_NASH_STAGES } from "../data/sets/shortNashData";
import { hasSolverStage, solverSpot, solverStageMeta } from "../data/sets/solverSpot";
import { ALL_HANDS, comboCount, type HandClass } from "../poker/cards";
import type { Game } from "./engine";
import type { MoveOption } from "./policy";
import { chartSeat, seatId } from "./chartSeat";
import { isNoChart, nashSpotId, preflopLine, shortNashSpotId, solverSpotId, type NoChartReason, type PreflopLine } from "./preflopLine";

/**
 * The computed chart of one preflop decision of a 9-handed-style tournament hand: hand review (복기), the opponents'
 * range narrowing, the play bots, the hero's grade and the coach facts all ask here. It reads exactly one chart, our
 * own: the solver at 100, 55 or 35bb, the short-stack open/re-jam equilibrium at 12–30bb, or push/fold Nash below
 * 12bb, by the effective stack at the decision (and, at 100bb, the open's size: the line's first raise, or my own
 * first-in raise when I open), and never the hand-made pub chart. A 30–45bb re-jam over an open the 35bb solver didn't
 * export reads the short-stack chart's 25bb, noted as an approximation, for the opener's call and the jammer's range
 * alike; a 30–45bb first-in jam it didn't export has no chart (the 25bb chart's calls of a first-in jam answer a jam
 * range its own equilibrium all but never takes). Solver spots are parsed one at a time (solverSpot.ts); the full
 * solver set is never built here. A line the charts don't cover gets a reason instead (NO_CHART_TEXT), never a
 * borrowed chart.
 */

export type ChartSource = "solver" | "shortnash" | "nash";

export interface ChartPick {
  source: ChartSource;
  /** The data's stage id: "100bb-3", "55bb-2.2", "35bb-2"; "17bb" for shortnash and nash. */
  stageId: string;
  /** The chart's stack, bb. */
  stack: number;
  /** Its first-in open, bb (nash: 0, it only pushes). */
  open: number;
  /** "솔버 100bb", "숏스택 17bb", "푸시폴드 10bb". */
  name: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function solverPick(id: string): ChartPick {
  const m = solverStageMeta(id);
  return { source: "solver", stageId: id, stack: m.stack, open: m.open, name: `솔버 ${m.stack}bb` };
}
const shortPick = (stack: number): ChartPick => ({ source: "shortnash", stageId: `${stack}bb`, stack, open: SHORT_NASH_OPEN, name: `숏스택 ${stack}bb` });
const nashPick = (stack: number): ChartPick => ({ source: "nash", stageId: `${stack}bb`, stack, open: 0, name: `푸시폴드 ${stack}bb` });

/** The short-stack stages the review reads (its 10bb stage is below the push/fold line). */
const SHORT_STACKS = SHORT_NASH_STAGES.map((s) => s.stack).filter((s) => s >= 12);
const NASH_STACKS = NASH_STAGES.map((s) => s.stack);
const nearest = (list: number[], x: number) => list.reduce((b, s) => (Math.abs(s - x) < Math.abs(b - x) - 1e-9 ? s : b), list[0]);

/**
 * The chart for an effective stack of `effBb` (and, from 75bb, the line's first raise): 100bb from 75bb (the 2.2bb-open
 * stage when the open is under 2.6bb, the SB's under 3.25bb; otherwise, and with no raise yet, the 3bb-open stage, the
 * pub's size), 55bb from 45bb, 35bb from 30bb, the short-stack chart's nearest stack from 12bb (25 up to 30bb), and
 * the push/fold chart's nearest whole stack below (4bb at the least).
 */
export function pickChart(effBb: number, open?: { to: number; sb: boolean }): ChartPick {
  const eff = Number.isFinite(effBb) && effBb > 0 ? effBb : 100;
  if (eff >= 75) return solverPick(open && open.to < (open.sb ? 3.25 : 2.6) ? "100bb-2.2" : "100bb-3");
  if (eff >= 45) return solverPick("55bb-2.2");
  if (eff >= 30) return solverPick(hasSolverStage("35bb-2") ? "35bb-2" : "55bb-2.2");
  if (eff >= 12) return shortPick(nearest(SHORT_STACKS, eff));
  return nashPick(nearest(NASH_STACKS, Math.max(4, Math.round(eff))));
}

/** The chart behind each stage of 빠른 기록's screen (judgeChart.ts JUDGE_SOURCE): a pinned stage reads this one. */
export const PICK_FOR_STAGE: Record<"deep" | "mid" | "short" | "push", ChartPick> = {
  deep: solverPick("100bb-3"),
  mid: solverPick("55bb-2.2"),
  short: shortPick(17),
  push: nashPick(10),
};

/** Every seat's starting stack (bb): what it has plus what it put in, and the BB's ante. Preflop only. */
export function startStacks(g: Game): number[] {
  const n = g.players.length;
  return g.players.map((p, i) => p.stack + p.total + (i === n - 1 ? g.dead : 0));
}

/** The seats whose stacks matter to decision `idx`: the jammer it faces, else the live seats with voluntary chips, else every live seat. */
function relevantSeats(g: Game, idx: number, l: PreflopLine): number[] {
  const live = g.players.map((_, i) => i).filter((i) => i !== idx && !g.players[i].folded);
  if (l.facingJam) {
    const j = [...g.log].reverse().find((e) => e.street === "preflop" && (e.kind === "raise" || e.kind === "bet"));
    if (j) return [j.idx];
  }
  const voluntary = new Set(l.steps.filter((s) => s.verb !== "fold" && s.verb !== "check").map((s) => s.idx));
  const inv = live.filter((i) => voluntary.has(i));
  return inv.length ? inv : live;
}

/** The effective stack (bb) of decision `idx`: my starting stack or the largest of the relevant opponents', whichever is less. */
export function effectiveStack(g: Game, idx: number, l: PreflopLine = preflopLine(g, idx)): number {
  const st = startStacks(g);
  const opp = relevantSeats(g, idx, l);
  return opp.length ? Math.min(st[idx], Math.max(...opp.map((i) => st[i]))) : st[idx];
}

export const NO_CHART_TEXT: Record<NoChartReason, string> = {
  limp: "림프 팟",
  cold: "3벳 뒤 콜드 액션",
  multiway: "콜러가 여럿인 팟",
  calledJam: "올인에 이미 콜이 나왔어요",
  order: "올인 뒤 액션 순서가 차트와 달라요",
  rare: "솔버가 이 라인을 풀지 않았어요",
  headsUp: "헤즈업 딥스택",
  offTree: "이 스택 차트에 없는 상황",
  seat: "자리를 차트에 맞출 수 없어요",
};
export const NO_CHART_HEAD = "이 상황은 계산된 차트가 없어요";
export const CONFIDENCE_KO = { high: "높음", mid: "중간", low: "낮음" } as const;
/**
 * The 35bb override of a non-blind seat's vs-open, overcall and squeeze spots (docs/preflop-solver.md: the cold4 "none"
 * tree, the weakest charts of the set; `confidence` can't see why): the cold seats behind a 3-bet or squeeze may only
 * fold, so the 3-bet gains fold equity it wouldn't have and the flat loses out.
 */
export const COLD35_NOTE = "35bb 차트는 3벳 뒤 콜드 자리가 폴드만 하는 트리라 콜드콜이 거의 없어요";
export const COLD35_SQUEEZE_NOTE = "35bb 차트는 스퀴즈 뒤 콜드 자리가 폴드만 하는 트리라 오버콜이 적고 스퀴즈가 많아요";
/** A 30–45bb re-jam over an open the 35bb solver didn't export, read on the short-stack chart's 25bb instead. */
export const NOT_IN_35_NOTE = "솔버 35bb엔 없는 라인";
/**
 * A call of a short-stack first-in jam whose jammer's equilibrium jam range is under THIN_JAM of all hands (UTG, HJ
 * and the SB at 20bb, every seat at 25bb): the call chart answers a jam its own equilibrium all but never makes, a
 * leftover of the solving method (openjam.ts), so it is shown for reference only.
 */
export const THIN_JAM = 0.01;
export const THIN_JAM_NOTE = "균형에선 거의 안 나오는 올인이라 참고만";
export const NO_ANTE_NOTE = "앤티 없는 판이라 참고만";
/** Under a hand review's preflop decisions. */
export const CHART_FOOTER = "프리플랍은 앱이 직접 계산한 차트로 채점해요 (칩EV, ICM 미반영)";

export interface ChartHit {
  ok: true;
  pick: ChartPick;
  spotId: string;
  scenario: Scenario;
  /** The solver's confidence of the spot (null for shortnash and nash). */
  confidence: "high" | "mid" | "low" | null;
  /** Why the confidence was overridden. */
  confidenceNote?: string;
  /** Where the chart only approximates this hand, each a short tag ("유효스택 70bb → 55bb 차트", "6인 테이블 근사"). */
  approx: string[];
  /** The approx tag about the raise size I face ("오픈 3bb · 차트 2.2bb"), when there is one. */
  sizeNote?: string;
  /** The decision faces an uncalled all-in: any chips in are a call of it. */
  facingJam: boolean;
  /** The chart is shown for reference only, not graded by. */
  refOnly?: string;
  /** The real last raise over the chart's (1 when there is none to compare). */
  sizeRatio: number;
  /** The effective stack, bb. */
  eff: number;
  /** The chart's moves with a hand class: sizes from the action labels times `scale`, a shove (or 올인) to `allInTo`. */
  moves(cls: HandClass, allInTo: number, scale?: number): MoveOption[];
}

export interface ChartMiss {
  ok: false;
  reason: NoChartReason;
  /** "이 상황은 계산된 차트가 없어요 · 림프 팟". */
  text: string;
  pick?: ChartPick;
  eff?: number;
}

export type ChartAnswer = ChartHit | ChartMiss;

const miss = (reason: NoChartReason, pick?: ChartPick, eff?: number): ChartMiss => ({ ok: false, reason, text: `${NO_CHART_HEAD} · ${NO_CHART_TEXT[reason]}`, ...(pick ? { pick } : {}), ...(eff !== undefined ? { eff } : {}) });

/** The last raise size of a data line ("CO 2.2 · BTN 3벳 6.6 · CO 올인" → 6.6), or undefined. */
function lastLineSize(line: string): number | undefined {
  let out: number | undefined;
  for (const part of line.split(" · ")) {
    const t = part.trim().split(" ");
    const x = Number(t[t.length - 1]);
    if (t.length >= 2 && Number.isFinite(x) && /\d/.test(t[t.length - 1])) out = x;
  }
  return out;
}

const SIZE_VERB = ["", "오픈", "3벳", "4벳"];

/** An action key's move, by the rules of the charts' keys (judgeChart.ts solverChart): sizes from the label. */
function moveOf(key: string, label: string, allInTo: number, scale: number): Omit<MoveOption, "prob"> {
  if (key === "call" || key === "overcall" || key === "limp") return { kind: "call" };
  if (key === "check") return { kind: "check" };
  if (key === "shove" || label.includes("올인")) return { kind: "raise", to: allInTo };
  const size = Number(/([\d.]+)bb/.exec(label)?.[1] ?? NaN);
  return { kind: "raise", to: Number.isFinite(size) ? Math.min(allInTo, r1(size * scale)) : allInTo };
}

function scenarioOf(pick: ChartPick, spotId: string): { scenario: Scenario; line: string; confidence: ChartHit["confidence"] } | null {
  if (pick.source === "solver") {
    const hit = solverSpot(pick.stageId, spotId);
    return hit ? { scenario: hit.scenario, line: hit.line, confidence: hit.confidence } : null;
  }
  const stage = getSet(pick.source).stages.find((s) => s.id === pick.stageId);
  const scenario = stage?.scenarios.find((s) => s.id === `${pick.source}/${pick.stageId}/${spotId}`);
  if (!scenario) return null;
  // The short-stack chart's opens are 2bb; its other raises and every push are all-in.
  const line = pick.source === "shortnash" && scenario.kind === "vsOpen" ? `${scenario.villain} ${SHORT_NASH_OPEN}` : "";
  return { scenario, line, confidence: null };
}

export interface ChartForOptions {
  /** Read this chart whatever the stacks (빠른 기록's pinned stage). */
  pin?: ChartPick;
  /** The hero's stack was not entered: the review assumed 100bb. */
  stackUnknown?: boolean;
  /**
   * The raise this decision makes (bb, street total), when grading or narrowing a raise: a first-in open picks the 100bb
   * stage by its own size, as every later decision of the hand does by that open. A jam is no open size.
   */
  ownRaise?: number;
  /**
   * The chart is read to narrow this seat's range by its move (`ownRaise`), not to grade it: a 30–45bb re-jam over an
   * open whose call the 35bb solver didn't export reads the short-stack chart's 25bb re-jam range, the same model the
   * opener's call of it is then graded by, so that call's EV and its grade come from one model.
   */
  narrowing?: boolean;
}

/**
 * The open that picks the 100bb stage: the line's first raise (not a jam), or with no raise yet my own first-in raise.
 * None in the SB's limped pot: both stages raise the limp alike, so the BB's raise size must not switch the stage the
 * limp itself was read on.
 */
function stageOpen(g: Game, idx: number, l: PreflopLine, ownRaise: number | undefined): { to: number; sb: boolean } | undefined {
  if (l.sbLimp) return undefined;
  if (l.openTo !== undefined) return { to: l.openTo, sb: l.openBySb };
  if (l.raises > 0 || ownRaise === undefined) return undefined;
  const p = g.players[idx];
  if (ownRaise >= p.stack + p.total - 1e-9) return undefined;
  return { to: ownRaise, sb: idx === g.players.length - 2 };
}

const spotIdOf = (pick: ChartPick, l: PreflopLine) => (pick.source === "solver" ? solverSpotId(l) : pick.source === "shortnash" ? shortNashSpotId(l) : nashSpotId(l));

/** The share of all hands (by combos) `seat` jams first in on this short-stack chart, or null without its spot. */
export function firstInJamShare(pick: ChartPick, seat: string): number | null {
  const rfi = pick.source === "shortnash" ? scenarioOf(pick, `rfi-${seatId(seat)}`) : null;
  if (!rfi) return null;
  let sum = 0;
  for (const h of ALL_HANDS) sum += comboCount(h) * (rfi.scenario.strategy[h]?.shove ?? 0);
  return sum / 1326;
}

/** Decision `idx` jams with `raise` (bb, street total). */
const isJam = (g: Game, idx: number, raise: number | undefined) => raise !== undefined && raise >= g.players[idx].stack + g.players[idx].total - 1e-9;

/** The computed chart of decision `idx` (the player to act, preflop), or why there is none. */
export function chartFor(g: Game, idx: number, opts: ChartForOptions = {}): ChartAnswer {
  const l = preflopLine(g, idx);
  const st = startStacks(g);
  const eff = effectiveStack(g, idx, l);
  let pick = opts.pin ?? pickChart(eff, stageOpen(g, idx, l, opts.ownRaise));
  // Heads-up the SB has the button and plays the flop in position; the solver's SB plays it out of position.
  if (l.players === 2 && pick.source === "solver") return miss("headsUp", pick, eff);
  let id = spotIdOf(pick, l);
  if (isNoChart(id)) return miss(id, pick, eff);
  let found = scenarioOf(pick, id);
  const approx: string[] = [];
  // The 35bb solver exports few all-in lines (only the BB's re-jam over an open and its call of the SB's jam). A
  // 30–45bb re-jam over an open it left out reads the short-stack chart's 25bb, whose re-jam range is a real one: the
  // opener's call of it, and (narrowing) the jammer's range, so the call EV and the grade come from one model. A
  // first-in jam it left out stays without a chart: the 25bb chart's calls answer a jam range its own equilibrium all
  // but never takes (under 1% of hands), leftovers of the solving method, not answers to a real jam.
  const sn = shortPick(nearest(SHORT_STACKS, 25));
  if (!found && pick.stageId === "35bb-2" && l.facingJam && !l.jamFirstIn) {
    const sid = shortNashSpotId(l);
    const alt = isNoChart(sid) ? null : scenarioOf(sn, sid);
    if (alt) {
      [pick, id, found] = [sn, sid, alt];
      approx.push(NOT_IN_35_NOTE);
    }
  }
  if (found && opts.narrowing && pick.stageId === "35bb-2" && isJam(g, idx, opts.ownRaise) && l.raises === 1 && !l.facingJam && !l.sbLimp && l.callers.length === 0 && !l.heroActed && l.opener) {
    // The jammer's re-jam over a lone open: when the opener's call of it isn't in the 35bb export (graded on 25bb
    // above), its range is the 25bb re-jam range too.
    const sid = shortNashSpotId(l);
    const alt = isNoChart(sid) || solverSpot(pick.stageId, `${seatId(l.opener)}-open-vs-${seatId(l.hero)}-jam`) ? null : scenarioOf(sn, sid);
    if (alt) {
      [pick, id, found] = [sn, sid, alt];
      approx.push(NOT_IN_35_NOTE);
    }
  }
  // A first-in jam deeper than the tree's jam cap (40bb) is no line of it at all, not one the export left out.
  const deepJam = l.raises >= 1 && l.openTo === undefined && pick.stack > 40;
  if (!found) return miss(l.callers.length >= 2 ? "multiway" : pick.source === "solver" && !deepJam ? "rare" : "offTree", pick, eff);
  const { scenario, line } = found;
  let confidence = found.confidence;
  let confidenceNote: string | undefined;
  if (pick.stageId === "35bb-2" && (scenario.kind === "vsOpen" || scenario.kind === "squeeze") && l.hero !== "SB" && l.hero !== "BB") {
    confidence = "low";
    confidenceNote = scenario.kind === "vsOpen" ? COLD35_NOTE : COLD35_SQUEEZE_NOTE;
  }
  // A short-stack call of a first-in jam its equilibrium all but never makes: low confidence, for reference only.
  const jamShare = pick.source === "shortnash" && scenario.kind === "vsShove" && scenario.villain ? firstInJamShare(pick, scenario.villain) : null;
  const thinJam = jamShare !== null && jamShare < THIN_JAM;
  if (thinJam) {
    confidence = "low";
    confidenceNote = `${pick.name} 균형에서 ${scenario.villain}의 퍼스트 인 올인은 ${r1(jamShare * 100)}%뿐`;
  }

  if (opts.stackUnknown) approx.push("스택 모름 · 100bb로 가정");
  // 100bb stands for anything deeper.
  if (!(pick.stack === 100 && eff >= 100) && Math.abs(eff - pick.stack) > 0.15 * pick.stack) approx.push(`유효스택 ${r1(eff)}bb → ${pick.stack}bb 차트`);
  const chartSize = l.facingJam || l.raises === 0 ? undefined : lastLineSize(line);
  let sizeRatio = 1;
  let sizeNote: string | undefined;
  if (chartSize !== undefined && l.lastRaiseTo !== undefined) {
    sizeRatio = l.lastRaiseTo / chartSize;
    if (sizeRatio >= 1.2 - 1e-9 || sizeRatio <= 0.8 + 1e-9) {
      const verb = l.sbLimp && l.raises === 1 ? "레이즈" : (SIZE_VERB[l.raises] ?? "레이즈");
      sizeNote = `${verb} ${r1(l.lastRaiseTo)}bb · 차트 ${r1(chartSize)}bb`;
      approx.push(sizeNote);
    }
  }
  const opp = relevantSeats(g, idx, l).map((i) => st[i]);
  const stacks = [st[idx], ...opp];
  if (Math.max(...stacks) > 1.25 * Math.min(...stacks)) approx.push("스택이 달라 근사");
  // Every chart is 9-handed: another table size is read seat by seat (chartSeat.ts).
  if (l.players !== 9) approx.push(`${l.players}인 테이블 근사`);

  const cache = new Map<string, MoveOption[]>();
  const moves = (cls: HandClass, allInTo: number, scale = 1): MoveOption[] => {
    const key = `${cls}|${allInTo}|${scale}`;
    const had = cache.get(key);
    if (had) return had;
    const s = scenario.strategy[cls];
    const out: MoveOption[] = [];
    let left = 1;
    for (const a of scenario.actions) {
      const p = s?.[a.key] ?? 0;
      if (p <= 1e-9) continue;
      out.push({ ...moveOf(a.key, a.label, allInTo, scale), prob: p });
      left -= p;
    }
    // The BB facing an SB limp can't fold: what is left checks.
    if (left > 1e-9) out.push({ kind: scenario.noFold ? "check" : "fold", prob: left });
    cache.set(key, out);
    return out;
  };

  return {
    ok: true,
    pick,
    spotId: id,
    scenario,
    confidence,
    ...(confidenceNote ? { confidenceNote } : {}),
    approx,
    ...(sizeNote ? { sizeNote } : {}),
    facingJam: l.facingJam,
    ...(g.dead === 0 ? { refOnly: NO_ANTE_NOTE } : thinJam ? { refOnly: THIN_JAM_NOTE } : {}),
    sizeRatio,
    eff,
    moves,
  };
}

/**
 * The raise buttons the chart offers at this decision: each non-all-in raise of the spot, its word ("오픈", "3벳",
 * "스퀴즈") and size (bb, times the real raise over the chart's, so a 3-bet over a 3bb open is sized off 3bb).
 */
export function chartRaiseSizes(hit: ChartHit, allInTo: number): { word: string; to: number }[] {
  const out: { word: string; to: number }[] = [];
  for (const a of hit.scenario.actions) {
    const m = moveOf(a.key, a.label, allInTo, hit.sizeRatio);
    if (m.kind !== "raise" || m.to === undefined || m.to >= allInTo - 1e-9) continue;
    if (out.some((o) => o.to === m.to)) continue;
    out.push({ word: a.label.replace(/[\d.]+bb/, "").trim() || "레이즈", to: m.to });
  }
  return out;
}

/**
 * How often the seat of decision `idx` raises each hand first in, in the chart of these stacks: the fallback rules'
 * iso over limpers (fallbackPolicy.ts). Undefined for the BB, or when the chart has no such spot.
 */
export function firstInRaise(g: Game, idx: number): ((h: HandClass) => number) | undefined {
  const seats = g.players.map((p) => p.seat);
  const seat = chartSeat(seats, seats[idx]);
  if (seat === "BB") return undefined;
  const pick = pickChart(effectiveStack(g, idx));
  const found = scenarioOf(pick, pick.source === "nash" ? `push-${seatId(seat)}` : `rfi-${seatId(seat)}`);
  if (!found) return undefined;
  const sc = found.scenario;
  const keys = sc.actions.filter((a) => a.key !== "limp").map((a) => a.key);
  return (h) => keys.reduce((x, k) => x + (sc.strategy[h]?.[k] ?? 0), 0);
}

/** The "차트 출처" of the charts behind some decisions, each once, for the coach. */
export function chartSourceText(sources: Iterable<ChartSource>): string {
  const set = new Set(sources);
  const parts: string[] = [];
  if (set.has("solver")) parts.push(`솔버: ${solverSource()}`);
  if (set.has("shortnash")) parts.push(`숏스택: ${SHORT_NASH.source}`);
  if (set.has("nash")) parts.push(`푸시폴드: ${NASH.source}`);
  return parts.join(" / ");
}
