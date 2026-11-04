import { handClassOf } from "../poker/cards";
import { describeStrategy } from "../data/charts";
import { act, legal, newGame, pot, SEATS, toCall, type Game } from "./engine";
import { COMBOS, handFeatures } from "./handInfo";
import {
  postflopMoves,
  preflopDecision,
  sample,
  STAGE_STACK,
  type MoveOption,
  type PostflopSpot,
  type PreflopSpot,
} from "./policy";
import { equityVs, fullWeights, rangeBreakdown, rangeShare, responseToBet, type Weights } from "./analysis";

export type Grade = "good" | "ok" | "mistake" | "info";

export interface OptionEV {
  key: string;
  label: string;
  ev: number | null;
}

export interface Decision {
  street: Game["street"];
  board: Game["board"];
  pot: number;
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
  villains: { seat: string; share: number; breakdown?: string }[];
}

export interface PlayState {
  stageId: string;
  heroIdx: number;
  game: Game;
  ranges: Weights[];
  decisions: Decision[];
  /** What each bot's last preflop decision was based on (for the log). */
  botNotes: Record<number, string>;
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

function preflopSpot(s: PlayState, idx: number): PreflopSpot {
  const g = s.game;
  const p = g.players[idx];
  const pre = g.log.filter((e) => e.street === "preflop" && e.kind !== "post");
  const raises = pre.filter((e) => e.kind === "raise" || e.kind === "bet");
  const last = raises[raises.length - 1];
  const firstRaiseAt = pre.findIndex((e) => e.kind === "raise" || e.kind === "bet");
  const limpers = (firstRaiseAt < 0 ? pre : pre.slice(0, firstRaiseAt)).filter((e) => e.kind === "call").length;
  return {
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

function postflopSpot(s: PlayState, idx: number, override?: Partial<PostflopSpot>): PostflopSpot {
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
    ...override,
  };
}

// ───────────── bots ─────────────

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
    const dec = preflopDecision(spot);
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

export function startHand(stageId: string, heroIdx = Math.floor(Math.random() * SEATS.length)): PlayState {
  const game = newGame(STAGE_STACK[stageId], heroIdx);
  const s: PlayState = { stageId, heroIdx, game, ranges: SEATS.map(() => fullWeights()), decisions: [], botNotes: {} };
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
  if (g.street === "preflop") {
    const spot = preflopSpot(s, idx);
    const verb = spot.raises === 0 ? (p.seat === "BB" ? "레이즈" : "오픈") : spot.raises === 1 ? "3벳" : spot.raises === 2 ? "4벳" : "레이즈";
    const base =
      spot.raises === 0
        ? (s.stageId === "deep" ? 3 : s.stageId === "mid" ? 2.5 : 2) + spot.limpers
        : spot.raises === 1
          ? g.currentBet * (p.seat === "SB" || p.seat === "BB" ? 3.5 : 3)
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

function analyse(s: PlayState, move: HeroMove): Decision {
  const g = s.game;
  const idx = s.heroIdx;
  const hero = g.players[idx];
  const potNow = pot(g);
  const call = toCall(g, idx);
  // Preflop, only players who already put money in voluntarily are in the pot.
  const acted = new Set(g.log.filter((e) => e.kind === "call" || e.kind === "raise" || e.kind === "bet").map((e) => e.idx));
  const villains = g.players
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => i !== idx && !p.folded && (g.street !== "preflop" || acted.has(i)));
  const dead = [...hero.hole, ...g.board];
  const ranges = villains.map(({ i }) => s.ranges[i]);
  const eq = ranges.length ? equityVs(hero.hole, g.board, ranges, 2500) : NaN;
  const reqEquity = call > 0 ? call / (potNow + call) : null;
  const effStack = villains.length ? Math.min(hero.stack, Math.max(...villains.map(({ p }) => p.stack))) : hero.stack;
  const spr = potNow > 0 ? effStack / potNow : 0;
  const base: Omit<Decision, "options" | "grade" | "summary"> = {
    street: g.street,
    board: g.board.slice(),
    pot: potNow,
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
  const evCall = Number.isFinite(eq) ? eq * (potNow + call) - call : null;

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
    const moves = heroMoves(s);
    for (const m of moves) options.push({ key: m.key, label: `${m.label} (차트 ${Math.round(freqOf(m) * 100)}%)`, ev: null });
    if (spot.facingAllIn && evCall !== null) {
      options.forEach((o) => {
        if (o.key === "fold") o.ev = 0;
        if (o.key === "call") o.ev = evCall;
      });
    }
    const f = freqOf(move);
    const best = Math.max(...moves.map(freqOf));
    const grade: Grade = !dec.scenario ? "info" : f >= 0.5 || (f > 0 && f >= best - 1e-9) ? "good" : f >= 0.2 ? "ok" : "mistake";
    const evNote = spot.facingAllIn && evCall !== null ? ` · 콜 EV ${evCall >= 0 ? "+" : ""}${r1(evCall)}bb (에퀴티 ${Math.round(eq * 100)}% vs 필요 ${Math.round((reqEquity ?? 0) * 100)}%)` : "";
    return { ...base, options, grade, chart: chartText, summary: `차트 기준 ${move.label} 빈도 ${Math.round(f * 100)}%${evNote}` };
  }

  // Postflop
  const heads = villains.length === 1;
  const moves = heroMoves(s);
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
  const reqText = reqEquity !== null ? ` vs 필요 ${Math.round(reqEquity * 100)}%` : "";
  const summary = `${eqText}${reqText} · EV가 가장 높은 선택: ${best ? `${best.label} (${best.ev! >= 0 ? "+" : ""}${best.ev}bb)` : "-"}`;
  return { ...base, options, grade, summary };
}

export function heroAct(s: PlayState, move: HeroMove): PlayState {
  const decision = analyse(s, move);
  const game = act(s.game, move.kind, move.to);
  return runBots({ ...s, game, decisions: [...s.decisions, decision] });
}
