import { fullDeck, shuffle, type Card } from "../poker/cards";
import { evaluate } from "../poker/evaluator";

export type Street = "preflop" | "flop" | "turn" | "river";
export type ActKind = "fold" | "check" | "call" | "bet" | "raise";

/** Seats in preflop action order (the last two are SB and BB), and whether the BB posts an ante. */
export interface TableDef {
  seats: string[];
  bbAnte: boolean;
}
/** Pub tournament: 9-handed, the BB pays a 1bb ante. */
export const PUB_TABLE: TableDef = { seats: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"], bbAnte: true };
/** 6-max cash: no ante. */
export const CASH_TABLE: TableDef = { seats: ["UTG", "HJ", "CO", "BTN", "SB", "BB"], bbAnte: false };
export const SEATS = PUB_TABLE.seats;

/** Postflop action order starts at the SB. Heads-up the SB is the button, so the BB acts first. */
const postflopOrder = (n: number) => (n === 2 ? [1, 0] : [n - 2, n - 1, ...Array.from({ length: n - 2 }, (_, i) => i)]);

export interface Player {
  seat: string;
  hero: boolean;
  hole: [Card, Card];
  /** Chips behind (bb). */
  stack: number;
  /** Live chips put in on this street. */
  streetBet: number;
  /** Live chips put in this hand (the BB ante is dead money, not counted here). */
  total: number;
  folded: boolean;
  allIn: boolean;
}

export interface LogEntry {
  street: Street;
  idx: number;
  seat: string;
  kind: ActKind | "post";
  /** For bet/raise/call: street bet after the action. For post: amount posted. */
  amount: number;
  allIn: boolean;
  potAfter: number;
}

export interface Payout {
  idx: number;
  amount: number;
}

export interface Game {
  startStack: number;
  players: Player[];
  board: Card[];
  deck: Card[];
  /** BB ante, dead money in the pot (0 without an ante). */
  dead: number;
  street: Street;
  currentBet: number;
  minRaise: number;
  /** Players who still have to act this round. */
  pending: number[];
  toAct: number | null;
  lastRaiser: number | null;
  preflopRaiser: number | null;
  log: LogEntry[];
  done: boolean;
  showdown: boolean;
  payouts: Payout[];
}

// Amounts are in bb. Round away float dust only: chip amounts typed in the hand log (5,000 at 800/1600 =
// 3.125bb) must survive the bb round trip, so this keeps six decimals rather than two.
const r1 = (x: number) => Math.round(x * 1e6) / 1e6;

export function pot(g: Game): number {
  return r1(g.dead + g.players.reduce((s, p) => s + p.total, 0));
}

/**
 * The pot seat `idx` plays for if it calls now: the dead money, and each player's chips up to idx's own total after
 * the call. A covering all-in's chips beyond my stack, and side pots between others above it, are not mine to win;
 * the call price and the call EV count only this. The same as pot(g) whenever I cover what I face.
 */
export function winnablePot(g: Game, idx: number): number {
  const me = g.players[idx];
  const cap = me.total + Math.max(0, toCall(g, idx));
  return r1(g.dead + g.players.reduce((s, p) => s + Math.min(p.total, cap), 0));
}

/** The equity seat `idx` needs to call (call ÷ the winnable pot after it), or null with nothing to call. */
export function callPrice(g: Game, idx: number): number | null {
  const call = toCall(g, idx);
  return call > 0 ? call / (winnablePot(g, idx) + call) : null;
}

/** `stacks` optionally overrides the starting stack (bb) per seat index. */
export function newGame(startStack: number, heroIdx: number, deck: Card[] = shuffle(fullDeck()), table: TableDef = PUB_TABLE, stacks?: number[]): Game {
  const d = deck.slice();
  const players: Player[] = table.seats.map((seat, i) => ({
    seat,
    hero: i === heroIdx,
    hole: [d.pop()!, d.pop()!],
    stack: stacks?.[i] ?? startStack,
    streetBet: 0,
    total: 0,
    folded: false,
    allIn: false,
  }));
  const g: Game = {
    startStack,
    players,
    board: [],
    deck: d,
    dead: 0,
    street: "preflop",
    currentBet: 0,
    minRaise: 1,
    pending: [],
    toAct: null,
    lastRaiser: null,
    preflopRaiser: null,
    log: [],
    done: false,
    showdown: false,
    payouts: [],
  };
  const sb = players.length - 2, bb = players.length - 1;
  if (table.bbAnte) {
    // BB ante: dead money, posted before the blind.
    const ante = Math.min(1, players[bb].stack);
    players[bb].stack = r1(players[bb].stack - ante);
    g.dead = ante;
  }
  post(g, sb, 0.5);
  post(g, bb, 1);
  g.currentBet = 1;
  g.pending = players.map((_, i) => i).filter((i) => canAct(g.players[i]));
  g.toAct = nextToAct(g, bb);
  return g;
}

function post(g: Game, idx: number, amount: number) {
  const p = g.players[idx];
  const a = Math.min(amount, p.stack);
  p.stack = r1(p.stack - a);
  p.streetBet = r1(p.streetBet + a);
  p.total = r1(p.total + a);
  if (p.stack <= 0) p.allIn = true;
  g.log.push({ street: g.street, idx, seat: p.seat, kind: "post", amount: a, allIn: p.allIn, potAfter: pot(g) });
}

const canAct = (p: Player) => !p.folded && !p.allIn;
const live = (g: Game) => g.players.filter((p) => !p.folded);

/** Next player after `from` (in table order for the street) who still has to act. */
function nextToAct(g: Game, from: number): number | null {
  const order = g.street === "preflop" ? g.players.map((_, i) => i) : postflopOrder(g.players.length);
  const start = order.indexOf(from);
  for (let k = 1; k <= order.length; k++) {
    const i = order[(start + k) % order.length];
    if (g.pending.includes(i)) return i;
  }
  return null;
}

export function toCall(g: Game, idx: number): number {
  const p = g.players[idx];
  return r1(Math.min(g.currentBet - p.streetBet, p.stack));
}

export interface Legal {
  canCheck: boolean;
  callAmount: number; // 0 if nothing to call
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number; // all-in
}

export function legal(g: Game, idx: number): Legal {
  const p = g.players[idx];
  const call = toCall(g, idx);
  const maxTo = r1(p.streetBet + p.stack);
  const minTo = r1(Math.min(maxTo, g.currentBet + g.minRaise));
  // Raising is pointless once nobody else can respond.
  const others = g.players.filter((q, i) => i !== idx && canAct(q)).length;
  return {
    canCheck: call <= 0,
    callAmount: Math.max(0, call),
    canRaise: maxTo > g.currentBet && others > 0,
    minRaiseTo: minTo,
    maxRaiseTo: maxTo,
  };
}

/** Apply an action for the player to act. `to` = street bet total for bet/raise. */
export function act(g0: Game, kind: "fold" | "check" | "call" | "raise", to?: number): Game {
  const g: Game = structuredClone(g0);
  const idx = g.toAct;
  if (idx === null || g.done) throw new Error("no one to act");
  const p = g.players[idx];
  const L = legal(g, idx);
  let logged: ActKind = kind === "raise" ? (g.currentBet > 0 ? "raise" : "bet") : kind;

  if (kind === "fold") {
    if (L.canCheck) logged = "check"; // folding with nothing to call is just a check
    else p.folded = true;
  } else if (kind === "check") {
    if (!L.canCheck) throw new Error("cannot check");
  } else if (kind === "call") {
    if (L.callAmount <= 0) logged = "check";
    else {
      p.stack = r1(p.stack - L.callAmount);
      p.streetBet = r1(p.streetBet + L.callAmount);
      p.total = r1(p.total + L.callAmount);
      if (p.stack <= 1e-9) { p.stack = 0; p.allIn = true; }
    }
  } else {
    if (!L.canRaise) {
      return act(g0, L.canCheck ? "check" : "call");
    }
    const target = r1(Math.max(L.minRaiseTo, Math.min(to ?? L.minRaiseTo, L.maxRaiseTo)));
    const add = r1(target - p.streetBet);
    p.stack = r1(p.stack - add);
    p.streetBet = target;
    p.total = r1(p.total + add);
    if (p.stack <= 1e-9) { p.stack = 0; p.allIn = true; }
    const raiseSize = r1(target - g.currentBet);
    if (raiseSize >= g.minRaise) g.minRaise = raiseSize;
    g.currentBet = Math.max(g.currentBet, target);
    g.lastRaiser = idx;
    if (g.street === "preflop") g.preflopRaiser = idx;
    // Everyone else who can still act must respond.
    g.pending = g.players.map((_, i) => i).filter((i) => i !== idx && canAct(g.players[i]));
  }
  g.pending = g.pending.filter((i) => i !== idx);
  g.log.push({ street: g.street, idx, seat: p.seat, kind: logged, amount: p.streetBet, allIn: p.allIn, potAfter: pot(g) });

  const alive = live(g);
  if (alive.length === 1) {
    finish(g, false);
    return g;
  }
  const next = nextToAct(g, idx);
  if (next !== null) {
    g.toAct = next;
    return g;
  }
  endRound(g);
  return g;
}

function endRound(g: Game) {
  const actors = live(g).filter((p) => !p.allIn);
  if (g.street === "river" || actors.length <= 1) {
    // Run the board out and show down.
    while (g.board.length < 5) g.board.push(g.deck.pop()!);
    finish(g, true);
    return;
  }
  const n = g.street === "preflop" ? 3 : 1;
  for (let k = 0; k < n; k++) g.board.push(g.deck.pop()!);
  g.street = g.street === "preflop" ? "flop" : g.street === "flop" ? "turn" : "river";
  for (const p of g.players) p.streetBet = 0;
  g.currentBet = 0;
  g.minRaise = 1;
  g.lastRaiser = null;
  g.pending = postflopOrder(g.players.length).filter((i) => canAct(g.players[i]));
  g.toAct = g.pending[0] ?? null;
  if (g.toAct === null) endRound(g);
}

/** Split the pot into main/side pots and pay the best hands. */
function finish(g: Game, showdown: boolean) {
  g.done = true;
  g.toAct = null;
  g.pending = [];
  g.showdown = showdown && live(g).length > 1;
  const payouts = new Map<number, number>();
  const pay = (i: number, x: number) => payouts.set(i, r1((payouts.get(i) ?? 0) + x));

  const alive = g.players.map((p, i) => ({ p, i })).filter(({ p }) => !p.folded);
  if (alive.length === 1) {
    pay(alive[0].i, pot(g));
  } else {
    const scores = new Map(alive.map(({ p, i }) => [i, evaluate([...p.hole, ...g.board])]));
    const levels = [...new Set(g.players.map((p) => p.total).filter((t) => t > 0))].sort((a, b) => a - b);
    let prev = 0;
    let first = true;
    for (const lvl of levels) {
      let slice = g.players.reduce((s, p) => s + Math.max(0, Math.min(p.total, lvl) - prev), 0);
      if (first) { slice += g.dead; first = false; }
      let eligible = alive.filter(({ p }) => p.total >= lvl).map(({ i }) => i);
      if (!eligible.length) eligible = alive.map(({ i }) => i); // chips above every live stack
      if (eligible.length && slice > 0) {
        const best = Math.max(...eligible.map((i) => scores.get(i)!));
        const winners = eligible.filter((i) => scores.get(i) === best);
        for (const w of winners) pay(w, slice / winners.length);
      }
      prev = lvl;
    }
  }
  g.payouts = [...payouts.entries()].map(([idx, amount]) => ({ idx, amount }));
  for (const { idx, amount } of g.payouts) g.players[idx].stack = r1(g.players[idx].stack + amount);
}

/** Hero's result in bb (chips after the hand minus the starting stack). */
export function heroNet(g: Game): number {
  const h = g.players.find((p) => p.hero)!;
  return r1(h.stack - g.startStack);
}
