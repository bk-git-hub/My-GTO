import { handClassOf, type Card } from "../poker/cards";
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
import { chartFor, chartRaiseSizes, CONFIDENCE_KO, effectiveStack, firstInRaise, NO_CHART_TEXT, pickChart, type ChartAnswer } from "./computedChart";
import { fallbackDecision } from "./fallbackPolicy";
import type { HandFeatures } from "./handInfo";
import { foldOut, foldOutFacts, type FoldOut } from "./foldOut";
import type { PackMatch } from "./packMatch";
import { postflopRank } from "./packMatch";
import { comboOf, gradeAtNode, OFF_TEXT, type OffTree, type OracleSpot } from "./packOracle";
import { preflopLine } from "./preflopLine";
import { isGto, type SeatProfile } from "./profile";
import { adjustPostflop, adjustPreflop, classMass, stageOrder, type PreflopAdjustCtx } from "./profileAdjust";
import { lineStepOf, type SeatLineStep } from "./seatLine";

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
  /**
   * AI table: what the decision was judged by. "chart": a computed preflop chart (or the cash chart); "solver" /
   * "solverApprox": a heads-up flop pack, matched exactly or approximately; "model": the EV model against these AIs
   * (참고); "none": nothing.
   */
  source?: DecisionSource;
  /** AI table: the solver pack behind a flop grade. */
  pack?: PackDecision;
  /** AI table, preflop: how often every AI behind folds to my raise (foldOut.ts). */
  foldOut?: FoldOut;
  /** AI table, postflop: why the decision is 참고 ("멀티웨이는 솔버 없음 · 근사"). */
  reason?: string;
  /** AI table: a live opponent plays off the chart, and the grade (on the GTO chart, or the cash chart) leaves that out. */
  vsProfile?: true;
}

export type DecisionSource = "chart" | "solver" | "solverApprox" | "model" | "none";

export interface PackDecision {
  packId: string;
  title: string;
  level: "exact" | "approx";
  reasons: string[];
  path: number[];
  /** The node's actions ("체크", "벳 33%", "레이즈"), with their solver frequency for my combo and EV (bb; ×potScale when approximate). */
  labels: string[];
  freq: number[];
  ev: (number | null)[];
  /** The action I took (index into labels). */
  chosen: number;
  /** The EV lost against the best action, bb (approx: real bb, ≈), and as a share of the pot. */
  loss: number;
  lossPct: number;
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
  // ── AI table (핸드 플레이) only; hand review never sets these, so every function behaves as before without them. ──
  /** Each seat's profile, engine-index order; null for the hero. */
  profiles?: (SeatProfile | null)[];
  /** Per seat, the GTO chart step of each preflop decision (seatLine.ts), for the solver pack match. */
  lines?: SeatLineStep[][];
  /** What each AI action was based on, by game.log index. */
  srcs?: Record<number, AiSource>;
  /** Set once when the flop is dealt: the matched solver pack, or why packs aren't used. */
  post?: { match: PackMatch | null; failed?: LoadKey["kind"] };
  /** runBots stopped: this must load first (advance.ts loads it and runs the bots again). */
  needs?: LoadKey;
  /** A replay of an earlier spot of a hand ("다시 이 상황"): never recorded. */
  replay?: true;
}

/**
 * What an AI action was based on: a computed chart, the cash table's hand-made chart, the fallback rules, a solver pack
 * (exact or approximate), or the postflop rules. (Its profile on top of that is the seat's own, shown beside it.)
 */
export type AiSource = "chart" | "cashChart" | "fallback" | "solver" | "solverApprox" | "rule";

export type LoadKey = { kind: "manifest" } | { kind: "packs"; ids: string[] } | { kind: "flop"; path: string };

/** The AI table's postflop data (packOracle.ts createOracle over packSource.ts). Synchronous: what isn't loaded is `needs`. */
export interface PostflopOracle {
  needs(s: PlayState): LoadKey | null;
  match(s: PlayState): PackMatch | null;
  spot(s: PlayState, idx: number): OracleSpot | { off: OffTree } | null;
}

export interface TableCtx {
  oracle?: PostflopOracle | null;
}

/** A hero choice as the UI offers it. */
export interface HeroMove {
  key: string;
  label: string;
  kind: "fold" | "check" | "call" | "raise";
  to?: number;
  /** At a solver pack node: the node's action index. */
  ai?: number;
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
  // The AI table: every seat plays the regular's rules, its profile adds the pub character (profileAdjust.ts).
  const table = s.profiles
    ? {
        lastToAct: !g.players.some((q, i) => i !== idx && !q.folded && !q.allIn && postflopRank(g, i) > postflopRank(g, idx)),
      }
    : {};
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
    style: s.profiles || s.mode === "cash" ? "reg" : "pub",
    ...table,
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

/**
 * A bot's range after its move: each combo's weight times how likely it was to take the move. Copy on write: the old
 * state's ranges stay as they were, so a snapshot taken before (다시 이 상황) remains valid.
 */
function narrowed(s: PlayState, idx: number, likelihood: (combo: number) => number): Weights[] {
  const w = s.ranges[idx].slice();
  for (let i = 0; i < w.length; i++) if (w[i] > 0) w[i] *= likelihood(i);
  const ranges = s.ranges.slice();
  ranges[idx] = w;
  return ranges;
}

const sameKind = (a: MoveOption["kind"], b: MoveOption["kind"]) => a === b;

/** The profile-adjustment context of seat `idx`'s preflop decision (profileAdjust.ts). */
function adjustCtx(s: PlayState, idx: number, spot: PreflopSpot, ans: ChartAnswer | null, base: PreflopDecision): PreflopAdjustCtx {
  const scenario = ans?.ok ? ans.scenario : base.scenario;
  const order = s.mode === "cash" ? stageOrder("cash") : stageOrder(ans?.pick ?? pickChart(effectiveStack(s.game, idx)));
  return { w: classMass(s.ranges[idx]), ...(scenario ? { scenario } : {}), facingRaise: spot.raises >= 1, allInTo: spot.myBet + spot.myStack, order };
}

/**
 * Seat `idx`'s preflop decision: the chart's (`base`: the computed chart in a tournament, the 6-max chart in cash, or the
 * fallback rules) and as the seat plays it with its profile (`dec`; `base` itself for GTO or no profile).
 */
export function botPreflop(s: PlayState, idx: number): { dec: PreflopDecision; base: PreflopDecision; ans: ChartAnswer | null; spot: PreflopSpot } {
  const spot = preflopSpot(s, idx);
  const ans = s.mode === "pub" ? chartFor(s.game, idx, { stackUnknown: s.stackUnknown }) : null;
  const base = s.mode === "pub" ? computedDecision(s, idx, ans!) : preflopDecision(spot);
  const prof = s.profiles?.[idx];
  const dec = isGto(prof) ? base : adjustPreflop(base, prof, adjustCtx(s, idx, spot, ans, base));
  return { dec, base, ans, spot };
}

/** The AI table's records of a seat's action: its GTO line step (preflop) and what the action was based on. */
function recorded(s: PlayState, idx: number, step: SeatLineStep | null, src: AiSource): PlayState {
  if (!s.profiles) return s;
  const lines = step ? (s.lines ?? s.game.players.map(() => [])).map((l, i) => (i === idx ? [...l, step] : l)) : s.lines;
  return { ...s, ...(lines ? { lines } : {}), srcs: { ...s.srcs, [s.game.log.length - 1]: src } };
}

/** A solver pack node's actions as moves, every action listed (probability 0 included). */
const nodeMoves = (sp: OracleSpot, freq: (i: number) => number): MoveOption[] =>
  sp.actions.map((a, i) => ({ kind: a.kind, ...(a.kind === "raise" ? { to: a.to } : {}), prob: freq(i), ai: i }));

/** The postflop rules' moves put on a pack node's actions: a bet on the nearest size, a raise on the node's raise. */
function onNode(heur: MoveOption[], sp: OracleSpot): MoveOption[] {
  const out = nodeMoves(sp, () => 0);
  const at = (k: MoveOption["kind"]) => sp.actions.findIndex((a) => a.kind === k);
  const facing = at("call") >= 0;
  for (const m of heur) {
    let i: number;
    if (m.kind === "raise") {
      const raises = sp.actions.map((a, j) => ({ a, j })).filter(({ a }) => a.kind === "raise");
      const d = (to: number) => Math.abs(Math.log((m.to ?? to) / to));
      i = raises.length ? raises.reduce((b, r) => (d(r.a.to) < d(b.a.to) ? r : b)).j : at(facing ? "call" : "check");
    } else if (m.kind === "fold") i = at("fold") >= 0 ? at("fold") : at("check");
    else i = at(m.kind) >= 0 ? at(m.kind) : at(m.kind === "check" ? "call" : "check");
    if (i >= 0) out[i].prob += m.prob;
  }
  return out;
}

/**
 * Seat `idx`'s postflop moves for any hole cards, and what they are based on: on the AI table at a matched solver pack
 * node the pack's row (the rules put on the node's actions for a combo the pack doesn't hold), elsewhere the postflop
 * rules; then the seat's profile. The bot's own move and every narrowing of its range read this one function, so they
 * always agree. Without profiles (hand review): exactly the postflop rules.
 */
export function postflopMover(s: PlayState, idx: number, ctx?: TableCtx): (cards: [Card, Card]) => { moves: MoveOption[]; src: AiSource } {
  const g = s.game;
  const spot = postflopSpot(s, idx);
  if (!s.profiles) return (cards) => ({ moves: postflopMoves(handFeatures(cards, g.board), spot), src: "rule" });
  const prof = s.profiles[idx];
  const gto = isGto(prof);
  const facingBet = spot.toCall > 0;
  const ps = ctx?.oracle ? ctx.oracle.spot(s, idx) : null;
  const pack = ps && "source" in ps ? ps : null;
  return (cards) => {
    let f: HandFeatures | null = null;
    const feat = () => (f ??= handFeatures(cards, g.board));
    let moves: MoveOption[];
    let src: AiSource = "rule";
    const row = pack ? pack.row(comboOf(cards)) : null;
    if (pack && row) {
      moves = nodeMoves(pack, (i) => row.freq[i] ?? 0);
      src = pack.level === "exact" ? "solver" : "solverApprox";
    } else moves = pack ? onNode(postflopMoves(feat(), spot), pack) : postflopMoves(feat(), spot);
    if (!gto) moves = adjustPostflop(moves, prof, { tier: feat().tier, facingBet });
    moves = moves.filter((m) => m.prob > 1e-9);
    if (!moves.length) moves = [{ kind: facingBet ? "fold" : "check", prob: 1 }];
    return { moves, src };
  };
}

/** Seat `idx`'s postflop moves with these hole cards (postflopMover). */
export const botPostflopMoves = (s: PlayState, idx: number, cards: [Card, Card], ctx?: TableCtx): MoveOption[] => postflopMover(s, idx, ctx)(cards).moves;

function botTurn(s: PlayState, ctx?: TableCtx): PlayState {
  const g = s.game;
  const idx = g.toAct!;
  const p = g.players[idx];
  if (g.street === "preflop") {
    const { dec, base, ans, spot } = botPreflop(s, idx);
    const allInTo = spot.myBet + spot.myStack;
    const move = sample(dec.moves(handClassOf(p.hole[0], p.hole[1])));
    const isAllIn = move.kind === "raise" && move.to !== undefined && move.to >= allInTo - 1e-9;
    const ranges = narrowed(s, idx, (i) => {
      const opts = dec.moves(COMBOS[i].hand);
      return opts
        .filter((o) => sameKind(o.kind, move.kind) && (move.kind !== "raise" || (o.to !== undefined && o.to >= allInTo - 1e-9) === isAllIn))
        .reduce((a, o) => a + o.prob, 0);
    });
    const next = { ...applyMove(s, move), ranges, botNotes: { ...s.botNotes, [idx]: dec.label } };
    if (!s.profiles) return next;
    const scenario = ans?.ok ? ans.scenario : s.mode === "cash" ? base.scenario : undefined;
    return recorded(next, idx, lineStepOf(base, scenario, move, allInTo), !scenario ? "fallback" : s.mode === "cash" ? "cashChart" : "chart");
  }
  const mover = postflopMover(s, idx, ctx);
  const own = mover(p.hole);
  const move = sample(own.moves);
  const dead = new Set(g.board);
  const ranges = narrowed(s, idx, (i) => {
    const c = COMBOS[i].cards;
    if (dead.has(c[0]) || dead.has(c[1])) return 0;
    // At a pack node by the exact action (a 33% and a 75% bet narrow differently), elsewhere by kind.
    const ms = mover(c).moves;
    return (move.ai !== undefined ? ms.filter((o) => o.ai === move.ai) : ms.filter((o) => sameKind(o.kind, move.kind))).reduce((a, o) => a + o.prob, 0);
  });
  return recorded({ ...applyMove(s, move), ranges }, idx, null, own.src);
}

/**
 * Let the bots act until the hero is to act or the hand ends. On the AI table with an oracle, the matched solver pack
 * is set once when the flop is dealt, and the run stops with `needs` when data must load first (before any bot acts,
 * and once more before the hero acts), so a bot or the hero never plays a pack spot on the rules by accident.
 */
export function runBots(s0: PlayState, ctx?: TableCtx): PlayState {
  let s = s0.needs ? { ...s0, needs: undefined } : s0;
  const o = s.profiles ? ctx?.oracle : null;
  let guard = 0;
  while (!s.game.done && s.game.toAct !== null && guard++ < 200) {
    if (o) {
      if (s.game.street === "flop" && s.post === undefined) {
        const n = o.needs(s);
        if (n) return { ...s, needs: n };
        // A malformed pack never stops a hand: it goes on with the approximate rules, marked as a failed load.
        let post: PlayState["post"];
        try {
          post = { match: o.match(s) };
        } catch {
          post = { match: null, failed: "manifest" };
        }
        s = { ...s, post };
      }
      const n = o.needs(s);
      if (n) return { ...s, needs: n };
    }
    if (s.game.toAct === s.heroIdx) break;
    s = botTurn(s, ctx);
  }
  return s;
}

export const MODE_TABLE = { pub: PUB_TABLE, cash: CASH_TABLE } as const;

export interface StartOptions {
  /** The AI table: each seat's profile (engine order, null for the hero). */
  profiles?: (SeatProfile | null)[];
  ctx?: TableCtx;
}

/** Deal a new hand. Cash mode has a single 100bb stage. */
export function startHand(mode: PlayMode, stageId: string, heroIdx?: number, opts?: StartOptions): PlayState {
  const table = MODE_TABLE[mode];
  const stage = mode === "cash" ? "100bb" : stageId;
  const hero = heroIdx ?? Math.floor(Math.random() * table.seats.length);
  const game = newGame(STAGE_STACK[stage], hero, undefined, table);
  const s: PlayState = { mode, stageId: stage, heroIdx: hero, game, ranges: game.players.map(() => fullWeights()), decisions: [], botNotes: {} };
  if (opts?.profiles) {
    const profiles = game.players.map((_, i) => (i === hero ? null : (opts.profiles![i] ?? null)));
    return runBots({ ...s, profiles, lines: game.players.map(() => []), srcs: {} }, opts.ctx);
  }
  return runBots(s);
}

// ───────────── hero ─────────────

/**
 * The hero's buttons at a solver pack node (AI table): the node's actions in real chips, plus 올인 (off the tree unless
 * the tree's own action is all-in). Null where the hero isn't at a pack node, or at OOP's root, where the tree only
 * checks (the real game's buttons stay; that decision is 참고).
 */
export function packSpotOf(s: PlayState, ctx?: TableCtx, idx: number = s.heroIdx): OracleSpot | null {
  if (!s.profiles || !ctx?.oracle || s.game.street === "preflop") return null;
  const sp = ctx.oracle.spot(s, idx);
  return sp && "source" in sp ? sp : null;
}

export function heroMoves(s: PlayState, ctx?: TableCtx): HeroMove[] {
  const g = s.game;
  if (g.done || g.toAct !== s.heroIdx) return [];
  const idx = s.heroIdx;
  const p = g.players[idx];
  const L = legal(g, idx);
  const out: HeroMove[] = [];
  const sp = packSpotOf(s, ctx);
  if (sp && !sp.oopRoot) {
    sp.actions.forEach((a, i) => {
      if (a.kind === "raise" && !L.canRaise) return;
      const allIn = a.kind === "raise" && a.to >= L.maxRaiseTo - 1e-9;
      const key = a.kind === "raise" ? (allIn ? "allin" : `raise:${a.to}`) : a.kind;
      out.push({ key, label: a.label, kind: a.kind, ...(a.kind === "raise" ? { to: allIn ? L.maxRaiseTo : Math.max(a.to, L.minRaiseTo) } : {}), ai: i });
    });
    if (L.canRaise && !out.some((m) => m.key === "allin")) out.push({ key: "allin", label: `올인 ${r1(L.maxRaiseTo)}`, kind: "raise", to: L.maxRaiseTo });
    return out;
  }
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

/**
 * Grade a hero move against the chart (preflop) or the bot-response EV of each option (postflop). On the AI table
 * (`s.profiles`): preflop as always against the GTO chart, tagged when opponents play otherwise, with the all-fold
 * note; a heads-up flop decision at a matched solver pack against the pack (analysePack); every other postflop decision
 * is 참고, with the EV model against these AIs and the reason no solver applies.
 */
export function analyse(s: PlayState, move: HeroMove, ctx?: TableCtx): Decision {
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

  if (g.street === "preflop" && s.mode === "pub") {
    const d = analyseComputed(s, move, base, evCall, eq, reqEquity);
    return s.profiles ? tablePreflop(s, move, d) : d;
  }
  if (g.street === "preflop" && s.profiles) return tablePreflop(s, move, analyseCash(s, move, base, options, evCall, eq, reqEquity));
  if (g.street === "preflop") return analyseCash(s, move, base, options, evCall, eq, reqEquity);
  let reason: string | null = null;
  if (s.profiles) {
    const r = analysePack(s, move, base, ctx);
    if ("decision" in r) return r.decision;
    reason = r.reason;
  }
  return analysePostflop(s, move, base, options, evCall, eq, reqEquity, villains, reason, ctx);
}

/** The cash table's preflop grade against the hand-made 6-max chart. */
function analyseCash(s: PlayState, move: HeroMove, base: Omit<Decision, "options" | "grade" | "summary">, options: OptionEV[], evCall: number | null, eq: number, reqEquity: number | null): Decision {
  const g = s.game;
  const idx = s.heroIdx;
  const hero = g.players[idx];
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

/**
 * A postflop decision by the EV of each option against the villains' replies: the bot rules (hand review), or on the
 * AI table each AI's own moves (postflopMover: solver pack rows, profiles) on the state after my bet, graded 참고 with
 * `reason` first.
 */
function analysePostflop(
  s: PlayState,
  move: HeroMove,
  base: Omit<Decision, "options" | "grade" | "summary">,
  options: OptionEV[],
  evCall: number | null,
  eq: number,
  reqEquity: number | null,
  villains: { p: Game["players"][number]; i: number }[],
  reason: string | null,
  ctx?: TableCtx,
): Decision {
  const g = s.game;
  const idx = s.heroIdx;
  const hero = g.players[idx];
  const potNow = pot(g);
  const call = toCall(g, idx);
  const heads = villains.length === 1;
  const moves = withChosen(heroMoves(s, ctx), move);
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
      const after: PlayState | null = s.profiles ? { ...s, game: act(g, "raise", m.to) } : null;
      for (const { p, i } of villains) {
        const mover = after ? postflopMover(after, i, ctx) : null;
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
        }, mover ? (cards) => mover(cards).moves : undefined);
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
  const best = options.filter((o) => o.ev !== null).sort((a, b) => b.ev! - a.ev!)[0];
  const eqText = Number.isFinite(eq) ? `에퀴티 ${Math.round(eq * 100)}%` : "";
  const reqText = reqEquity !== null ? ` vs 필요 ${Math.round(reqEquity * 100)}%${base.sidePot ? ` (${SIDE_POT_TEXT(base.sidePot)})` : ""}` : "";
  const bestText = best ? `${best.label} (${best.ev! >= 0 ? "+" : ""}${best.ev}bb)` : "-";
  if (reason !== null) {
    const summary = `${reason} · ${eqText}${reqText} · EV가 가장 높은 선택 (이 AI들 기준 ≈): ${bestText}`;
    return { ...base, options, grade: "info", summary, source: "model", reason };
  }
  const grade = gradeByEV(options, move.key, potNow);
  const summary = `${eqText}${reqText} · EV가 가장 높은 선택: ${bestText}`;
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

/** The AI table's tag under a preflop grade when an opponent plays off the chart. */
export const VS_PROFILE_TAG = "채점: GTO 차트 기준 · 상대 성향 미반영";

/**
 * The chart's main move with my hand at the AI table's preflop decision, when it is a raise: its size (the computed
 * chart in a tournament, the hand-made chart in cash), so the all-fold note can say what folding or calling gave up.
 */
function chartMainRaise(s: PlayState): number | undefined {
  const g = s.game;
  const idx = s.heroIdx;
  const p = g.players[idx];
  const allInTo = p.streetBet + p.stack;
  const cls = handClassOf(p.hole[0], p.hole[1]);
  let ms: MoveOption[];
  if (s.mode === "pub") {
    const ans = chartFor(g, idx, { stackUnknown: s.stackUnknown });
    if (!ans.ok) return undefined;
    ms = ans.moves(cls, allInTo, ans.sizeRatio);
  } else {
    const dec = preflopDecision(preflopSpot(s, idx));
    if (!dec.scenario) return undefined;
    ms = dec.moves(cls);
  }
  const fr = groupFreqs(ms, allInTo);
  const main = (["allin", "raise", "call", "fold"] as const).reduce((b, k) => (fr[k] > fr[b] + 1e-9 ? k : b), "fold" as "allin" | "raise" | "call" | "fold");
  if (main !== "raise" && main !== "allin") return undefined;
  return ms.filter((m) => m.kind === "raise").sort((a, b) => b.prob - a.prob)[0]?.to;
}

/**
 * An AI-table preflop decision (the tournament's computed chart or the cash chart): the grade as always, its source,
 * the "상대 성향 미반영" mark when a live opponent isn't GTO and the decision was graded on a chart, and for a raise of
 * mine (or a hand whose chart mostly raises) the all-fold note when a responder isn't GTO.
 */
function tablePreflop(s: PlayState, move: HeroMove, d: Decision): Decision {
  const g = s.game;
  const idx = s.heroIdx;
  const others = g.players.map((_, i) => i).filter((i) => i !== idx && !g.players[i].folded);
  const offChart = others.some((i) => !isGto(s.profiles?.[i]));
  const charted = s.mode === "pub" ? !!d.chartInfo?.source : d.grade !== "info";
  const out: Decision = { ...d, source: charted ? "chart" : "none" };
  if (offChart && charted) {
    out.vsProfile = true;
    if (d.chartInfo) out.chartInfo = { ...d.chartInfo, tags: [...d.chartInfo.tags, VS_PROFILE_TAG] };
  }
  if (!offChart) return out;
  const L = legal(g, idx);
  if (!L.canRaise) return out;
  const own = move.kind === "raise" && move.to !== undefined ? move.to : undefined;
  const chartTo = own === undefined ? chartMainRaise(s) : undefined;
  const raiseTo = own ?? (chartTo === undefined ? undefined : Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, chartTo)));
  if (raiseTo === undefined) return out;
  const fo = foldOut(
    g,
    idx,
    raiseTo,
    s.ranges,
    (g2, i) => {
      const r = botPreflop({ ...s, game: g2 }, i);
      return { dec: r.dec, gto: r.base, fellBack: s.mode === "pub" ? !r.ans?.ok : !r.base.scenario };
    },
    own === undefined,
  );
  if (fo) out.foldOut = fo;
  return out;
}

const pctText = (x: number) => `${Math.round(x * 100)}%`;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** A pack action's short name in summaries: "체크", "벳 33%", "레이즈", "콜", "폴드". */
const shortAction = (a: OracleSpot["actions"][number]) => (a.kind === "raise" ? (/^벳/.test(a.packLabel) ? a.packLabel : a.packLabel.includes("올인") ? "올인" : "레이즈") : a.label.split(" ")[0]);

/** Why an AI-table postflop decision has no solver grade, for the hero's spot. */
function noPackReason(s: PlayState): string {
  const g = s.game;
  // Multiway first: the solver is heads-up only, whatever the packs hold.
  const foldedPre = new Set(g.log.filter((e) => e.street === "preflop" && e.kind === "fold").map((e) => e.idx));
  const sawFlop = g.players.filter((_, i) => !foldedPre.has(i)).length;
  if (sawFlop >= 3) return "멀티웨이는 솔버 없음 · 근사";
  if (g.street !== "flop" && s.post?.match) return "턴부터는 솔버 없음 · 근사";
  if (s.post?.failed) return "솔버 팩을 못 열어서 근사";
  const l = preflopLine(g, s.heroIdx);
  if (l.raises >= 2) return "3벳 팟은 솔버 팩 없음 · 근사";
  if (l.raises === 0) return "림프 팟은 솔버 팩 없음 · 근사";
  return "이 자리·스택은 솔버 팩 없음 · 근사";
}

/**
 * A heads-up flop decision at a matched solver pack: the pack's frequency and EV of each option for my combo, graded
 * on EV (packOracle.ts gradeAtNode). Anything the pack can't judge returns the reason instead (the decision is then 참고).
 */
function analysePack(s: PlayState, move: HeroMove, base: Omit<Decision, "options" | "grade" | "summary">, ctx?: TableCtx): { decision: Decision } | { reason: string } {
  const g = s.game;
  const hero = g.players[s.heroIdx];
  const ps = ctx?.oracle ? ctx.oracle.spot(s, s.heroIdx) : null;
  if (!ps) return { reason: noPackReason(s) };
  if ("off" in ps) return { reason: `솔버 트리 밖 (${OFF_TEXT[ps.off]}) · 근사` };
  if (ps.oopRoot) return { reason: `솔버 트리엔 ${hero.seat} 리드가 없어요 (체크만)` };
  const combo = comboOf(hero.hole);
  const row = ps.row(combo);
  if (!row) return { reason: ps.inRange(combo) ? "솔버는 이 핸드로 여기 안 와요 · 근사" : "팩 레인지 밖 핸드 · 근사" };
  const indexOf = (m: HeroMove) => m.ai ?? ps.actions.findIndex((a) => a.kind === m.kind && (a.kind !== "raise" || Math.abs(a.to - (m.to ?? 0)) < 0.011));
  const chosen = indexOf(move);
  if (chosen < 0) return { reason: `솔버 트리 밖 (${move.key === "allin" ? "올인" : "다른 크기"}) · 근사` };
  const pg = gradeAtNode(ps, combo, chosen);
  if (!pg) return { reason: "팩 레인지 밖 핸드 · 근사" };
  const approx = ps.level === "approx";
  const scale = approx ? ps.potScale : 1;
  const evs = row.ev.map((x) => (Number.isFinite(x) ? r2(x * scale) : null));
  const options: OptionEV[] = withChosen(heroMoves(s, ctx), move).map((m) => {
    const i = indexOf(m);
    if (i < 0) return { key: m.key, label: `${m.label} (트리 밖)`, ev: null };
    return { key: m.key, label: `${m.label} (솔버 ${pctText(row.freq[i])})${approx ? " ≈" : ""}`, ev: evs[i] === null ? null : r1(evs[i]!) };
  });
  const labels = ps.actions.map(shortAction);
  const freqText = labels.map((l, i) => `${l}: ${pctText(row.freq[i])}`).join(" · ");
  const lossText = approx ? `손실 팟의 ${pctText(pg.lossPct)} (근사)` : `손실 ${r1(pg.loss)}bb`;
  const summary = `솔버 기준 ${freqText} · 고른 선택 ${lossText}`;
  const pack: PackDecision = {
    packId: ps.packId,
    title: ps.title,
    level: ps.level,
    reasons: ps.reasons,
    path: ps.path,
    labels,
    freq: row.freq.slice(),
    ev: evs,
    chosen,
    loss: r2(pg.loss * scale),
    lossPct: pg.lossPct,
  };
  return { decision: { ...base, options, grade: pg.grade, summary, source: approx ? "solverApprox" : "solver", pack } };
}

/** The hero's preflop decision as a GTO line step (seatLine.ts): the chart the grade reads. */
function heroLineStep(s: PlayState, move: HeroMove): SeatLineStep {
  const g = s.game;
  const idx = s.heroIdx;
  const spot = preflopSpot(s, idx);
  const allInTo = spot.myBet + spot.myStack;
  if (s.mode === "pub") {
    const own = move.kind === "raise" && move.to !== undefined ? move.to : undefined;
    const ans = chartFor(g, idx, { stackUnknown: s.stackUnknown, ...(own !== undefined ? { ownRaise: own } : {}) });
    return lineStepOf(computedDecision(s, idx, ans), ans.ok ? ans.scenario : undefined, move, allInTo);
  }
  const dec = preflopDecision(spot);
  return lineStepOf(dec, dec.scenario, move, allInTo);
}

export function heroAct(s: PlayState, move: HeroMove, ctx?: TableCtx): PlayState {
  const decision = analyse(s, move, ctx);
  const game = act(s.game, move.kind, move.to);
  let next: PlayState = { ...s, game, decisions: [...s.decisions, decision] };
  if (s.profiles && s.game.street === "preflop") {
    const step = heroLineStep(s, move);
    next = { ...next, lines: (s.lines ?? s.game.players.map(() => [])).map((l, i) => (i === s.heroIdx ? [...l, step] : l)) };
  }
  return runBots(next, ctx);
}

/**
 * The AI table's extra stats keys of a graded decision: "table:pre" and "table:pre:<stage>" for a computed-chart
 * preflop grade, "table:solver" and "table:solver:exact" / "table:solver:approx" for a solver pack grade.
 */
export function tableKeys(d: Pick<Decision, "grade" | "street" | "chartInfo" | "source">, stage: string): string[] {
  if (d.grade === "info") return [];
  if (d.street === "preflop" && chartGraded(d)) return ["table:pre", `table:pre:${stage}`];
  if (d.source === "solver") return ["table:solver", "table:solver:exact"];
  if (d.source === "solverApprox") return ["table:solver", "table:solver:approx"];
  return [];
}

export { foldOutFacts };
