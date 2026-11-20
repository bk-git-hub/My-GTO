import { handClassOf } from "../poker/cards";
import { describeStrategy } from "../data/charts";
import { act, CASH_TABLE, legal, newGame, pot, PUB_TABLE, toCall, winnablePot, type Game } from "./engine";
import { COMBOS, handFeatures } from "./handInfo";
import {
  openSize,
  postflopMoves,
  preflopDecision,
  sample,
  STAGE_STACK,
  threeBetSize,
  type MoveOption,
  type PlayMode,
  type PostflopSpot,
  type PreflopDecision,
  type PreflopSpot,
} from "./policy";
import { equityVs, fullWeights, rangeBreakdown, rangeShare, responseToBet, type Weights } from "./analysis";
import { AS_CALL_TAG, chartFacts, chartTags, chartText, gradeVsChart, groupFreqs, moveGroup } from "./chartGrade";
import { chartFor, chartRaiseSizes, CONFIDENCE_KO, firstInRaise, NO_CHART_TEXT, type ChartAnswer } from "./computedChart";
import { fallbackDecision } from "./fallbackPolicy";

export type Grade = "good" | "ok" | "mistake" | "info";

/** A decision's mark in the hand review: ✓ △ ✗, and the word 참고 where nothing was graded. */
export const GRADE_MARK: Record<Grade, string> = { good: "✓", ok: "△", mistake: "✗", info: "참고" };

export interface OptionEV {
  key: string;
  label: string;
  ev: number | null;
}

export interface Decision {
  street: Game["street"];
  board: Game["board"];
  pot: number;
  /**
   * Chips in `pot` I can't win if I call (bb): a covering all-in's chips beyond my stack, side pots above it. Omitted
   * when I cover what I face. The call price and the call EV count only the rest (engine.ts winnablePot).
   */
  sidePot?: number;
  toCall: number;
  reqEquity: number | null;
  spr: number;
  equity: number | null;
  chosen: string;
  chosenLabel: string;
  options: OptionEV[];
  grade: Grade;
  summary: string;
  chart?: string;
  /**
   * Preflop in a tournament hand: the computed chart behind the grade (computedChart.ts), or why there is none. The
   * hand review shows its tags; `facts` are the coach's lines about it.
   */
  chartInfo?: ChartInfo;
  villains: { seat: string; share: number; breakdown?: string }[];
}

export interface ChartInfo {
  /** "solver", "shortnash", "nash"; null when no computed chart covers the decision. */
  source: "solver" | "shortnash" | "nash" | null;
  /** "솔버 100bb". */
  name?: string;
  /** The data's stage id ("100bb-2.2", "55bb-2.2"; "17bb" for shortnash and nash). */
  stage?: string;
  /** The data's spot id ("btn-vs-co-open") and title ("BTN vs CO 오픈"). */
  spot?: string;
  title?: string;
  /** "높음", "중간", "낮음" (solver only). */
  confidence?: string;
  /** The close-call actions of my hand's cell. */
  close?: string[];
  approx: string[];
  /** Why a ✗ became △, or why there is no grade. */
  soft?: string;
  /** Why there is no chart: "림프 팟". */
  none?: string;
  /** The small tags under the decision. */
  tags: string[];
  facts: string[];
}

/**
 * The small tags under a decision of the hand review: the computed chart's (chartGrade.ts chartTags), then the chips
 * its 필요 leaves out when a covering all-in puts me all-in ("내 스택을 넘는 41bb 제외"), so the price reads against
 * the pot shown.
 */
export function decisionTags(d: Pick<Decision, "chartInfo" | "sidePot">): string[] {
  return [...(d.chartInfo?.tags ?? []), ...(d.sidePot ? [SIDE_POT_TEXT(d.sidePot)] : [])];
}

/** The decision was graded by a computed chart (a chart answered and gave a grade, not 참고). */
export const chartGraded = (d: Pick<Decision, "grade" | "chartInfo">): boolean => !!d.chartInfo?.source && d.grade !== "info";

export interface PlayState {
  mode: PlayMode;
  stageId: string;
  heroIdx: number;
  game: Game;
  ranges: Weights[];
  decisions: Decision[];
  /** What each bot's last preflop decision was based on (for the log). */
  botNotes: Record<number, string>;
  /** The hero's stack was not entered (a recorded hand): the review assumed 100bb. */
  stackUnknown?: boolean;
}

/** A hero choice as the UI offers it. */
export interface HeroMove {
  key: string;
  label: string;
  kind: "fold" | "check" | "call" | "raise";
  to?: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

// ───────────── spots ─────────────

export function preflopSpot(s: PlayState, idx: number): PreflopSpot {
  const g = s.game;
  const p = g.players[idx];
  const pre = g.log.filter((e) => e.street === "preflop" && e.kind !== "post");
  const raises = pre.filter((e) => e.kind === "raise" || e.kind === "bet");
  const last = raises[raises.length - 1];
  const firstRaiseAt = pre.findIndex((e) => e.kind === "raise" || e.kind === "bet");
  const limpers = (firstRaiseAt < 0 ? pre : pre.slice(0, firstRaiseAt)).filter((e) => e.kind === "call").length;
  return {
    mode: s.mode,
    stageId: s.stageId,
    seat: p.seat,
    raises: raises.length,
    openerSeat: raises[0]?.seat,
    lastRaiserSeat: last?.seat,
    iAmOpener: raises[0]?.idx === idx,
    facingAllIn: !!last && g.players[last.idx].allIn && g.currentBet > p.streetBet,
    currentBet: g.currentBet,
    myBet: p.streetBet,
    myStack: p.stack,
    limpers,
  };
}

export function postflopSpot(s: PlayState, idx: number, override?: Partial<PostflopSpot>): PostflopSpot {
  const g = s.game;
  const p = g.players[idx];
  const streetRaises = g.log.filter((e) => e.street === g.street && (e.kind === "bet" || e.kind === "raise")).length;
  return {
    board: g.board,
    pot: pot(g),
    toCall: toCall(g, idx),
    currentBet: g.currentBet,
    myBet: p.streetBet,
    myStack: p.stack,
    opponents: g.players.filter((q, i) => i !== idx && !q.folded).length,
    aggressor: g.preflopRaiser === idx,
    facingRaise: streetRaises >= 2,
    street: g.street as PostflopSpot["street"],
    style: s.mode === "cash" ? "reg" : "pub",
    ...override,
  };
}

// ───────────── bots ─────────────

/**
 * A tournament seat's preflop decision from the computed chart at its stacks (chart sizes, scaled by the real raise
 * over the chart's), or the fallback rules where the charts have no spot.
 */
export function computedDecision(s: PlayState, idx: number, ans: ChartAnswer = chartFor(s.game, idx, { stackUnknown: s.stackUnknown })): PreflopDecision {
  const spot = preflopSpot(s, idx);
  const allInTo = spot.myBet + spot.myStack;
  if (ans.ok) return { scenario: ans.scenario, label: `${ans.pick.name} · ${ans.scenario.title}`, moves: (h) => ans.moves(h, allInTo, ans.sizeRatio) };
  return fallbackDecision(spot, firstInRaise(s.game, idx));
}

function applyMove(s: PlayState, m: MoveOption): PlayState {
  const kind = m.kind === "check" ? "check" : m.kind;
  return { ...s, game: act(s.game, kind, m.to) };
}

/** Update a bot's range by how likely each combo was to take the move it took. */
function updateRange(s: PlayState, idx: number, likelihood: (combo: number) => number) {
  const w = s.ranges[idx];
  for (let i = 0; i < w.length; i++) if (w[i] > 0) w[i] *= likelihood(i);
}

const sameKind = (a: MoveOption["kind"], b: MoveOption["kind"]) => a === b;

function botTurn(s: PlayState): PlayState {
  const g = s.game;
  const idx = g.toAct!;
  const p = g.players[idx];
  if (g.street === "preflop") {
    const spot = preflopSpot(s, idx);
    const dec = s.mode === "pub" ? computedDecision(s, idx) : preflopDecision(spot);
    const move = sample(dec.moves(handClassOf(p.hole[0], p.hole[1])));
    const isAllIn = move.kind === "raise" && move.to !== undefined && move.to >= spot.myBet + spot.myStack - 1e-9;
    updateRange(s, idx, (i) => {
      const opts = dec.moves(COMBOS[i].hand);
      return opts
        .filter((o) => sameKind(o.kind, move.kind) && (move.kind !== "raise" || (o.to !== undefined && o.to >= spot.myBet + spot.myStack - 1e-9) === isAllIn))
        .reduce((a, o) => a + o.prob, 0);
    });
    s.botNotes[idx] = dec.label;
    return applyMove(s, move);
  }
  const spot = postflopSpot(s, idx);
  const move = sample(postflopMoves(handFeatures(p.hole, g.board), spot));
  const dead = new Set(g.board);
  updateRange(s, idx, (i) => {
    const c = COMBOS[i].cards;
    if (dead.has(c[0]) || dead.has(c[1])) return 0;
    return postflopMoves(handFeatures(c, g.board), spot)
      .filter((o) => sameKind(o.kind, move.kind))
      .reduce((a, o) => a + o.prob, 0);
  });
  return applyMove(s, move);
}

export function runBots(s0: PlayState): PlayState {
  let s = s0;
  let guard = 0;
  while (!s.game.done && s.game.toAct !== null && s.game.toAct !== s.heroIdx && guard++ < 200) s = botTurn(s);
  return s;
}

export const MODE_TABLE = { pub: PUB_TABLE, cash: CASH_TABLE } as const;

/** Deal a new hand. Cash mode has a single 100bb stage. */
export function startHand(mode: PlayMode, stageId: string, heroIdx?: number): PlayState {
  const table = MODE_TABLE[mode];
  const stage = mode === "cash" ? "100bb" : stageId;
  const hero = heroIdx ?? Math.floor(Math.random() * table.seats.length);
  const game = newGame(STAGE_STACK[stage], hero, undefined, table);
  const s: PlayState = { mode, stageId: stage, heroIdx: hero, game, ranges: game.players.map(() => fullWeights()), decisions: [], botNotes: {} };
  return runBots(s);
}

// ───────────── hero ─────────────

export function heroMoves(s: PlayState): HeroMove[] {
  const g = s.game;
  if (g.done || g.toAct !== s.heroIdx) return [];
  const idx = s.heroIdx;
  const p = g.players[idx];
  const L = legal(g, idx);
  const out: HeroMove[] = [];
  if (!L.canCheck) out.push({ key: "fold", label: "폴드", kind: "fold" });
  if (L.canCheck) out.push({ key: "check", label: "체크", kind: "check" });
  else out.push({ key: "call", label: `콜 ${r1(L.callAmount)}`, kind: "call" });
  if (!L.canRaise) return out;

  const allIn = L.maxRaiseTo;
  const sizes: { label: string; to: number }[] = [];
  const ans = g.street === "preflop" && s.mode === "pub" ? chartFor(g, idx, { stackUnknown: s.stackUnknown }) : null;
  if (ans?.ok) {
    // The chart's own raise sizes, scaled by the raise I face over the chart's.
    for (const r of chartRaiseSizes(ans, allIn)) if (r.to < allIn * 0.8) sizes.push({ label: `${r.word} ${r1(r.to)}`, to: r1(Math.max(r.to, L.minRaiseTo)) });
  } else if (g.street === "preflop") {
    const spot = preflopSpot(s, idx);
    const verb = spot.raises === 0 ? (p.seat === "BB" ? "레이즈" : "오픈") : spot.raises === 1 ? "3벳" : spot.raises === 2 ? "4벳" : "레이즈";
    const base =
      spot.raises === 0
        ? (p.seat === "BB" ? 4 : openSize(s.mode, s.stageId, p.seat)) + spot.limpers
        : spot.raises === 1
          ? threeBetSize(s.mode, p.seat, spot.openerSeat, g.currentBet)
          : g.currentBet * 2.3;
    if (base < allIn * 0.8) sizes.push({ label: `${verb} ${r1(base)}`, to: r1(Math.max(base, L.minRaiseTo)) });
  } else {
    const potNow = pot(g);
    if (L.canCheck) {
      for (const [frac, name] of [[0.33, "33%"], [0.66, "66%"], [1, "팟"]] as const) {
        const to = r1(Math.max(1, potNow * frac));
        if (to < allIn * 0.85) sizes.push({ label: `벳 ${name} (${to})`, to });
      }
    } else {
      const to = r1(Math.max(L.minRaiseTo, g.currentBet * 3));
      if (to < allIn * 0.85) sizes.push({ label: `레이즈 ${to}`, to });
    }
  }
  for (const sz of sizes) out.push({ key: `raise:${sz.to}`, label: sz.label, kind: "raise", to: sz.to });
  out.push({ key: "allin", label: `올인 ${r1(allIn)}`, kind: "raise", to: allIn });
  return out;
}

/** The offered moves plus the chosen one if it's a size the buttons don't have (copies, so labels can change). */
function withChosen(moves: HeroMove[], chosen: HeroMove): HeroMove[] {
  const out = moves.map((m) => ({ ...m }));
  if (!out.some((m) => m.key === chosen.key)) out.push({ ...chosen });
  return out;
}

/**
 * " · 콜 EV +2.1bb (에퀴티 30% vs 필요 41%)": facing an all-in, the call EV beside the grade, and the chips beyond my
 * stack it leaves out when the jam covers me (", 내 스택을 넘는 41bb 제외").
 */
function evNoteText(evCall: number, eq: number, reqEquity: number | null, sidePot?: number): string {
  const side = sidePot ? `, ${SIDE_POT_TEXT(sidePot)}` : "";
  return ` · 콜 EV ${evCall >= 0 ? "+" : ""}${r1(evCall)}bb (에퀴티 ${Math.round(eq * 100)}% vs 필요 ${Math.round((reqEquity ?? 0) * 100)}%${side})`;
}

/** The chips a call can't win, as the review and the coach say it: "내 스택을 넘는 41bb 제외". */
export const SIDE_POT_TEXT = (bb: number) => `내 스택을 넘는 ${r1(bb)}bb 제외`;

function gradeByEV(options: OptionEV[], chosen: string, potSize: number): Grade {
  const evs = options.filter((o) => o.ev !== null) as { key: string; ev: number }[];
  const mine = evs.find((o) => o.key === chosen);
  if (!mine || evs.length < 2) return "info";
  const best = Math.max(...evs.map((o) => o.ev));
  const diff = best - mine.ev;
  if (diff <= Math.max(0.15, potSize * 0.05)) return "good";
  if (diff <= Math.max(0.6, potSize * 0.15)) return "ok";
  return "mistake";
}

/** Grade a hero move against the chart (preflop) or the bot-response EV of each option (postflop). */
export function analyse(s: PlayState, move: HeroMove): Decision {
  const g = s.game;
  const idx = s.heroIdx;
  const hero = g.players[idx];
  const potNow = pot(g);
  const call = toCall(g, idx);
  // The pot a call plays for: chips beyond my own all-in (a covering jam's excess, side pots) aren't mine to win.
  const potWin = winnablePot(g, idx);
  const sidePot = r1(potNow - potWin);
  // Preflop, only players who already put money in voluntarily are in the pot.
  const acted = new Set(g.log.filter((e) => e.kind === "call" || e.kind === "raise" || e.kind === "bet").map((e) => e.idx));
  const villains = g.players
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => i !== idx && !p.folded && (g.street !== "preflop" || acted.has(i)));
  const dead = [...hero.hole, ...g.board];
  const ranges = villains.map(({ i }) => s.ranges[i]);
  const eq = ranges.length ? equityVs(hero.hole, g.board, ranges, 2500) : NaN;
  const reqEquity = call > 0 ? call / (potWin + call) : null;
  const effStack = villains.length ? Math.min(hero.stack, Math.max(...villains.map(({ p }) => p.stack))) : hero.stack;
  const spr = potNow > 0 ? effStack / potNow : 0;
  const base: Omit<Decision, "options" | "grade" | "summary"> = {
    street: g.street,
    board: g.board.slice(),
    pot: potNow,
    ...(sidePot > 0 ? { sidePot } : {}),
    toCall: call,
    reqEquity,
    spr,
    equity: Number.isFinite(eq) ? eq : null,
    chosen: move.key,
    chosenLabel: move.label,
    villains: villains.map(({ p, i }) => ({
      seat: p.seat,
      share: rangeShare(s.ranges[i], dead),
      breakdown: g.board.length ? rangeBreakdown(s.ranges[i], g.board, hero.hole) : undefined,
    })),
  };
  const options: OptionEV[] = [];
  const evCall = Number.isFinite(eq) ? eq * (potWin + call) - call : null;

  if (g.street === "preflop" && s.mode === "pub") return analyseComputed(s, move, base, evCall, eq, reqEquity);
  if (g.street === "preflop") {
    const spot = preflopSpot(s, idx);
    const dec = preflopDecision(spot);
    const opts = dec.moves(handClassOf(hero.hole[0], hero.hole[1]));
    const allInTo = spot.myBet + spot.myStack;
    const freqOf = (m: HeroMove) =>
      opts
        .filter((o) => {
          if (m.kind === "fold") return o.kind === "fold";
          if (m.kind === "check" || m.kind === "call") return o.kind === "call" || o.kind === "check";
          const oAll = o.kind === "raise" && (o.to ?? 0) >= allInTo - 1e-9;
          return o.kind === "raise" && oAll === (m.key === "allin");
        })
        .reduce((a, o) => a + o.prob, 0);
    const chartText = dec.scenario
      ? `${dec.scenario.title}: ${describeStrategy(dec.scenario, dec.scenario.strategy[handClassOf(hero.hole[0], hero.hole[1])])}`
      : dec.label;
    const moves = withChosen(heroMoves(s), move);
    for (const m of moves) options.push({ key: m.key, label: `${m.label} (차트 ${Math.round(freqOf(m) * 100)}%)`, ev: null });
    if (spot.facingAllIn && evCall !== null) {
      options.forEach((o) => {
        if (o.key === "fold") o.ev = 0;
        if (o.key === "call") o.ev = r1(evCall);
      });
    }
    const f = freqOf(move);
    const best = Math.max(...moves.map(freqOf));
    // (Facing an all-in the 6-max cash chart has no call chart, so that grade is always 참고: no ✓ or ✗ beside the call EV.)
    const grade: Grade = !dec.scenario ? "info" : f >= 0.5 || (f > 0 && f >= best - 1e-9) ? "good" : f >= 0.2 ? "ok" : "mistake";
    const evNote = spot.facingAllIn && evCall !== null ? evNoteText(evCall, eq, reqEquity, base.sidePot) : "";
    return { ...base, options, grade, chart: chartText, summary: `차트 기준 ${move.label} 빈도 ${Math.round(f * 100)}%${evNote}` };
  }

  // Postflop
  const heads = villains.length === 1;
  const moves = withChosen(heroMoves(s), move);
  for (const m of moves) {
    let ev: number | null = null;
    if (m.kind === "fold") ev = 0;
    else if (m.kind === "check") ev = Number.isFinite(eq) ? eq * potNow : null;
    else if (m.kind === "call") ev = evCall;
    else if (m.to !== undefined) {
      // Hero bets or raises to m.to. Villains respond by the bot rules.
      const invest = m.to - hero.streetBet;
      let allFold = 1;
      const cont: Weights[] = [];
      for (const { p, i } of villains) {
        const r = responseToBet(s.ranges[i], g.board, hero.hole, {
          board: g.board,
          pot: potNow + invest,
          toCall: Math.min(m.to - p.streetBet, p.stack),
          currentBet: m.to,
          myBet: p.streetBet,
          myStack: p.stack,
          opponents: villains.length,
          aggressor: g.preflopRaiser === i,
          facingRaise: call > 0,
          street: g.street as PostflopSpot["street"],
          style: s.mode === "cash" ? "reg" : "pub",
        });
        allFold *= r.foldProb;
        cont.push(r.cont);
      }
      const eqc = equityVs(hero.hole, g.board, cont, 1500);
      if (Number.isFinite(eqc)) {
        const v = villains[0].p;
        const callAmt = Math.min(m.to - v.streetBet, v.stack);
        const finalPot = potNow + invest + callAmt; // one caller (approximation when multiway)
        ev = allFold * potNow + (1 - allFold) * (eqc * finalPot - invest);
      } else ev = allFold * potNow - (1 - allFold) * invest;
      if (!heads) m.label += " ≈";
    }
    options.push({ key: m.key, label: m.label, ev: ev === null ? null : r1(ev) });
  }
  const grade = gradeByEV(options, move.key, potNow);
  const best = options.filter((o) => o.ev !== null).sort((a, b) => b.ev! - a.ev!)[0];
  const eqText = Number.isFinite(eq) ? `에퀴티 ${Math.round(eq * 100)}%` : "";
  const reqText = reqEquity !== null ? ` vs 필요 ${Math.round(reqEquity * 100)}%${base.sidePot ? ` (${SIDE_POT_TEXT(base.sidePot)})` : ""}` : "";
  const summary = `${eqText}${reqText} · EV가 가장 높은 선택: ${best ? `${best.label} (${best.ev! >= 0 ? "+" : ""}${best.ev}bb)` : "-"}`;
  return { ...base, options, grade, summary };
}

/**
 * A tournament preflop decision graded against its computed chart (chartGrade.ts): the chart's frequency of each
 * option, the grade with its tags and the coach facts; facing an all-in the call EV too (counting only the chips my
 * stack can win), which the grade never contradicts (by more than 1bb, or by 2 points of equity against the price).
 * No chart: "info", with the reason, and the facing-all-in call EV as always.
 */
function analyseComputed(s: PlayState, move: HeroMove, base: Omit<Decision, "options" | "grade" | "summary">, evCall: number | null, eq: number, reqEquity: number | null): Decision {
  const g = s.game;
  const idx = s.heroIdx;
  const hero = g.players[idx];
  const spot = preflopSpot(s, idx);
  const allInTo = spot.myBet + spot.myStack;
  const cls = handClassOf(hero.hole[0], hero.hole[1]);
  // A first-in open picks the 100bb stage by its own size (computedChart.ts stageOpen).
  const ownRaise = move.kind === "raise" && move.to !== undefined ? move.to : undefined;
  const ans = chartFor(g, idx, { stackUnknown: s.stackUnknown, ...(ownRaise !== undefined ? { ownRaise } : {}) });
  const moves = withChosen(heroMoves(s), move);
  const evNote = spot.facingAllIn && evCall !== null ? evNoteText(evCall, eq, reqEquity, base.sidePot) : "";
  const options: OptionEV[] = [];
  const withEv = () => {
    if (spot.facingAllIn && evCall !== null)
      options.forEach((o) => {
        if (o.key === "fold") o.ev = 0;
        if (o.key === "call") o.ev = r1(evCall);
      });
  };
  if (!ans.ok) {
    for (const m of moves) options.push({ key: m.key, label: m.label, ev: null });
    withEv();
    const none = NO_CHART_TEXT[ans.reason];
    // The summary says "계산된 차트 없음 · <why>"; the coach line only adds how to judge instead.
    const chartInfo: ChartInfo = { source: null, none, approx: [], tags: [], facts: ["차트 없이 팟 오즈와 원리로만 판단"] };
    return { ...base, options, grade: "info", chart: ans.text, chartInfo, summary: `계산된 차트 없음 · ${none}${evNote}` };
  }
  // Facing an all-in, the call EV, equity and price shown next to the grade: the grade may not contradict them
  // (chartGrade.ts numbersContradict).
  const nums = spot.facingAllIn && evCall !== null && reqEquity !== null ? { ev: r1(evCall), equity: eq, need: reqEquity } : undefined;
  const cg = gradeVsChart(ans, cls, move, allInTo, nums);
  const freq = groupFreqs(ans.moves(cls, allInTo), allInTo);
  for (const m of moves) {
    const f = m.key === move.key ? cg.freq : freq[moveGroup(m, allInTo)];
    options.push({ key: m.key, label: `${m.label} (차트 ${Math.round(f * 100)}%)`, ev: null });
  }
  withEv();
  const chartInfo: ChartInfo = {
    source: ans.pick.source,
    name: ans.pick.name,
    stage: ans.pick.stageId,
    spot: ans.spotId,
    title: ans.scenario.title,
    ...(ans.confidence ? { confidence: CONFIDENCE_KO[ans.confidence] } : {}),
    ...(cg.close ? { close: cg.close } : {}),
    approx: ans.approx,
    ...(cg.soft ? { soft: cg.soft } : {}),
    tags: chartTags(ans, cg),
    facts: chartFacts(ans, cls, cg),
  };
  const head =
    cg.grade === "info" && cg.soft
      ? cg.soft
      : `차트 기준 ${move.label} 빈도 ${Math.round(cg.freq * 100)}%${cg.asCall ? ` · ${AS_CALL_TAG}` : ""}${cg.near && cg.freq < 0.5 ? " · EV 거의 같은 선택" : ""}${cg.soft ? ` · ${cg.soft}` : ""}`;
  return { ...base, options, grade: cg.grade, chart: chartText(ans, cls), chartInfo, summary: `${head}${evNote}` };
}

export function heroAct(s: PlayState, move: HeroMove): PlayState {
  const decision = analyse(s, move);
  const game = act(s.game, move.kind, move.to);
  return runBots({ ...s, game, decisions: [...s.decisions, decision] });
}
