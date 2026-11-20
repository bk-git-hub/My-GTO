import { cardLabel, fullDeck, RANKS, SUITS, type Card } from "../../poker/cards";
import { evaluate } from "../../poker/evaluator";
import { parseRange } from "../../poker/range";
import { callPrice, legal, pot, type Game, type Street } from "../../play/engine";
import { equityVs, fullWeights } from "../../play/analysis";
import { COMBOS, handFeatures } from "../../play/handInfo";
import { reachOf } from "../../data/charts";
import { chartFor, firstInRaise } from "../../play/computedChart";
import { fallbackDecision } from "../../play/fallbackPolicy";
import { postflopMoves, type MoveOption } from "../../play/policy";
import { mulberry32 } from "../../poker/pushfold";
import { analyse, postflopSpot, preflopSpot, type Decision, type HeroMove, type PlayState } from "../../play/table";
import { holeGuessed, seatTags, tableOf, type LoggedHand } from "./handLog";
import { stageFor } from "./quickPre";
import { applyStep, baseStack, freshGame, positionsFor, raiseVerb, resolveStep, streetLines, type LogStep } from "./recorder";
import { cleanGuess } from "./suitGuess";

/**
 * Analysis of a recorded hand, replayed through the play engine with the real cards:
 * opponents' ranges narrowed by their actions (preflop by the computed chart of their spot at the
 * hand's stacks, src/play/computedChart.ts, and plain fallback rules where no chart covers it;
 * postflop by the hand-play bot rules), my estimated equity on each street, exact equity against
 * the hands I saw at showdown, my decisions graded (preflop against the computed chart, never the
 * hand-made pub chart), and the chip result.
 */

// ───────────── card text ─────────────

export interface ParsedCards {
  cards: Card[];
  /** A half-typed card at the end ("A" waiting for its suit). */
  pending: string;
  error: string | null;
}

/** "AdTd", "ad td", "10d 9c" → cards. Ranks A K Q J T 9…2 (10 = T), suits s h d c. */
export function parseCardText(text: string, max: number, taken: Card[] = []): ParsedCards {
  const t = text.replace(/[\s,]/g, "").replace(/10/g, "T");
  const cards: Card[] = [];
  let i = 0;
  while (i + 1 < t.length) {
    const r = RANKS.indexOf(t[i].toUpperCase());
    const su = SUITS.indexOf(t[i + 1].toLowerCase());
    if (r < 0) return { cards, pending: "", error: `'${t[i]}'는 랭크가 아니에요 (A K Q J T 9…2)` };
    if (su < 0) return { cards, pending: "", error: `'${t[i + 1]}'는 수트가 아니에요 (s h d c)` };
    const c = r * 4 + su;
    if (cards.includes(c)) return { cards, pending: "", error: `${cardLabel(c)}가 두 번 들어갔어요` };
    if (taken.includes(c)) return { cards, pending: "", error: `${cardLabel(c)}는 이미 다른 곳에 있어요` };
    cards.push(c);
    i += 2;
  }
  const pending = t.slice(i);
  if (pending && RANKS.indexOf(pending.toUpperCase()) < 0) return { cards, pending: "", error: `'${pending}'는 랭크가 아니에요 (A K Q J T 9…2)` };
  if (cards.length > max) return { cards: cards.slice(0, max), pending: "", error: `카드는 ${max}장까지예요` };
  return { cards, pending, error: null };
}

export const cardText = (cs: Card[]) => cs.map((c) => RANKS[c >> 2] + SUITS[c & 3]).join("");

// ───────────── dealing the real cards ─────────────

/**
 * A deck the engine deals the real cards from: it pops two hole cards per seat in seat order,
 * then the board. Unknown cards are filled from the rest of the deck (stable order).
 */
export function deckFor(seats: number, holes: (Card[] | undefined)[], board: Card[]): Card[] {
  const used = new Set<Card>([...holes.flatMap((h) => h ?? []), ...board]);
  const rest = fullDeck().filter((c) => !used.has(c));
  let k = 0;
  const seq: Card[] = [];
  for (let i = 0; i < seats; i++) seq.push(holes[i]?.[0] ?? rest[k++], holes[i]?.[1] ?? rest[k++]);
  for (let b = 0; b < 5; b++) seq.push(board[b] ?? rest[k++]);
  return [...rest.slice(k), ...seq.reverse()];
}

// ───────────── equity ─────────────

/** Each hand's share of the pot with these cards known (exact from the flop on, Monte Carlo preflop). */
export function equityKnown(hands: Card[][], board: Card[], iterations = 20000): number[] {
  const dead = new Set([...hands.flat(), ...board]);
  const deck = fullDeck().filter((c) => !dead.has(c));
  const need = 5 - board.length;
  const shares = new Array<number>(hands.length).fill(0);
  const cards = new Int32Array(7);
  const run = new Array<Card>(5);
  for (let i = 0; i < board.length; i++) run[i] = board[i];
  let total = 0;
  const credit = () => {
    let best = -1, winners = 0;
    const scores = hands.map((h) => {
      cards[0] = h[0];
      cards[1] = h[1];
      for (let i = 0; i < 5; i++) cards[2 + i] = run[i];
      const s = evaluate(cards, 7);
      if (s > best) [best, winners] = [s, 1];
      else if (s === best) winners++;
      return s;
    });
    scores.forEach((s, i) => s === best && (shares[i] += 1 / winners));
    total++;
  };
  if (need === 0) credit();
  else if (need === 1) for (const c of deck) ((run[4] = c), credit());
  else if (need === 2) {
    for (let a = 0; a < deck.length; a++) for (let b = a + 1; b < deck.length; b++) ((run[3] = deck[a]), (run[4] = deck[b]), credit());
  } else {
    const d = deck.slice();
    for (let it = 0; it < iterations; it++) {
      for (let j = 0; j < need; j++) {
        const r = j + Math.floor(Math.random() * (d.length - j));
        [d[j], d[r]] = [d[r], d[j]];
        run[board.length + j] = d[j];
      }
      credit();
    }
  }
  return shares.map((s) => s / total);
}

// ───────────── ranges from actions ─────────────

/** Pub players limp wide; the charts never limp, so a limp narrows to this instead. */
const LIMP_RANGE = parseRange("22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K8o+, Q9o+, J9o+, T9o, 98o");

/** Stack depth (bb) → the stage the fallback rules size by (shared with the quick screen's preflop block). */
export { stageFor };

/**
 * Multiply seat idx's range by how likely each combo was to take step `st` (bot rules).
 * Tries the likelihoods in order and uses the first that leaves some range: e.g. a 4-bet to
 * 20bb when the chart only 4-bets all-in falls back to "any raise".
 */
function narrow(s: PlayState, idx: number, st: LogStep, boardKnown: boolean) {
  const g = s.game;
  if (st.k === "fold") return;
  const tries: ((i: number) => number)[] = [];
  if (g.street === "preflop") {
    const spot = preflopSpot(s, idx);
    // A first-in open picks the 100bb stage by its own size, as the hero's grade does (computedChart.ts stageOpen); a
    // 30–45bb re-jam over an open reads the chart the opener's call of it is graded by (ChartForOptions.narrowing).
    const ans = chartFor(g, idx, { stackUnknown: s.stackUnknown, narrowing: true, ...(st.k === "raise" && st.to !== undefined ? { ownRaise: st.to } : {}) });
    const chartLimps = ans.ok && ans.scenario.actions.some((a) => a.key === "limp");
    // Facing an all-in, a raise over it (isolating a shorter stack's jam) is a call of it: the charts only call there.
    const k = st.k === "raise" && spot.facingAllIn ? "call" : st.k;
    if (k === "call" && spot.raises === 0 && spot.seat !== "BB" && !chartLimps) {
      tries.push((i) => LIMP_RANGE[COMBOS[i].hand] ?? 0);
    } else {
      const allInTo = spot.myBet + spot.myStack;
      const isAllIn = k === "raise" && (st.to ?? 0) >= allInTo - 1e-9;
      const fallback = fallbackDecision(spot, firstInRaise(g, idx));
      const prob = (moves: MoveOption[], strict: boolean) =>
        moves.filter((o) => o.kind === k && (!strict || k !== "raise" || ((o.to ?? 0) >= allInTo - 1e-9) === isAllIn)).reduce((a, o) => a + o.prob, 0);
      if (ans.ok) {
        // The computed chart at these stacks; a hand its line never brings here takes the fallback rules, not the chart's fold.
        const sc = ans.scenario;
        const moves = (i: number) => {
          const h = COMBOS[i].hand;
          return reachOf(sc, h) > 0 ? ans.moves(h, allInTo, ans.sizeRatio) : fallback.moves(h);
        };
        tries.push((i) => prob(moves(i), true), (i) => prob(moves(i), false));
      }
      tries.push((i) => prob(fallback.moves(COMBOS[i].hand), true), (i) => prob(fallback.moves(COMBOS[i].hand), false));
    }
  } else {
    if (!boardKnown) return;
    const spot = postflopSpot(s, idx);
    const dead = new Set(g.board);
    tries.push((i) => {
      const c = COMBOS[i].cards;
      if (dead.has(c[0]) || dead.has(c[1])) return 0;
      return postflopMoves(handFeatures(c, g.board), spot)
        .filter((o) => o.kind === st.k)
        .reduce((a, o) => a + o.prob, 0);
    });
  }
  const w = s.ranges[idx];
  for (const likely of tries) {
    const next = new Float64Array(w.length);
    let before = 0, after = 0;
    for (let i = 0; i < w.length; i++) {
      if (!w[i]) continue;
      before += w[i];
      next[i] = w[i] * likely(i);
      after += next[i];
    }
    if (after > before * 1e-3) {
      w.set(next);
      return;
    }
  }
  // An action the model says never happens tells us nothing we can use: keep the range.
}

// ───────────── the replay ─────────────

const NEED: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface StreetView {
  street: Street;
  /** Board on this street, if all of it is known. */
  board: Card[] | null;
  /** Pot (bb) when the street starts and when its action ends. */
  potStart: number;
  potEnd: number;
  /** Actions on the street, as text. */
  actions: string[];
  /** Seats still in when the street starts, and when its action ends. */
  live: string[];
  endLive: string[];
  /** Pot shares (0~1) of the players whose cards are known, live at the street start. */
  known: { seat: string; cards: Card[]; equity: number }[];
  /** My estimated equity against live opponents' narrowed ranges (at my first decision on the street, else at its start). */
  estimate: number | null;
  /** Cards with guessed suits are in play by this street (my hole cards, or a guessed board card dealt): its numbers are approximate. */
  suitGuessed: boolean;
}

export interface HeroDecision {
  street: Street;
  step: LogStep;
  /** What I did ("콜", "3벳", "벳"…) and the street total it came to, in bb (exact, for display in chips). */
  verb: string;
  amount: number | null;
  decision: Decision;
  /** My pot share against the opponents' real cards at that moment (only the known ones). */
  actual: number | null;
  /** All live opponents' cards were known, so `actual` is the true number. */
  actualComplete: boolean;
  /** Graded with guessed suits in play (see StreetView.suitGuessed). */
  suitGuessed: boolean;
}

/** What the UI says when guessed suits are in play: the hand class and ranks are real, the suits picked. */
export const SUIT_GUESS_NOTE = "수트를 추정한 카드가 있어 플러시 관련 승률은 근사예요";

export interface HandAnalysis {
  game: Game;
  applied: number;
  streets: StreetView[];
  decisions: HeroDecision[];
  /** Hero's result in bb, when the cards needed to settle the pot are known. */
  heroNet: number | null;
  /** Opponents still in at a showdown (their cards settle the pot). */
  showdownSeats: string[];
  /** Hero to act now: estimated equity and what a call needs. */
  current: { equity: number | null; need: number | null } | null;
  /**
   * Which cards had guessed suits (LoggedHand.guess, limited to the cards on the hand): the subject's
   * hole cards and board indexes. Null when every suit is known. Equity and grades from a street where
   * they are in play (StreetView.suitGuessed) are approximate: say SUIT_GUESS_NOTE.
   */
  suitGuess: { hole: boolean; board: number[] } | null;
}

function heroMoveFor(g: Game, st: LogStep): HeroMove {
  const idx = g.toAct!;
  const L = legal(g, idx);
  if (st.k === "fold") return { key: "fold", label: "폴드", kind: "fold" };
  if (st.k === "check") return { key: "check", label: "체크", kind: "check" };
  const p = g.players[idx];
  if (st.k === "call") return { key: "call", label: `콜 ${r1(Math.min(g.currentBet, p.streetBet + p.stack))}`, kind: "call" };
  const to = Math.min(st.to ?? L.minRaiseTo, L.maxRaiseTo);
  if (to >= L.maxRaiseTo - 1e-9) return { key: "allin", label: `올인 ${r1(L.maxRaiseTo)}`, kind: "raise", to: L.maxRaiseTo };
  return { key: `raise:${r1(to)}`, label: `${raiseVerb(g)} ${r1(to)}`, kind: "raise", to };
}

/** Estimated equity of the hero against the live opponents who are in the pot. */
function estimate(s: PlayState, hero: Card[], board: Card[], iterations: number): number | null {
  const g = s.game;
  const acted = new Set(g.log.filter((e) => e.kind === "call" || e.kind === "raise" || e.kind === "bet").map((e) => e.idx));
  const villains = g.players.map((p, i) => ({ p, i })).filter(({ p, i }) => i !== s.heroIdx && !p.folded && (g.street !== "preflop" || acted.has(i)));
  if (!villains.length) return null;
  const eq = equityVs(hero, board, villains.map(({ i }) => s.ranges[i]), iterations);
  return Number.isFinite(eq) ? eq : null;
}

/**
 * The equity and EV estimates are Monte Carlo. Seed them from the hand so the same hand always
 * shows the same numbers and grades: Math.random is swapped for a seeded generator while this
 * synchronous function runs, then restored.
 */
export function analyseHand(h: LoggedHand, opts: { decisions?: boolean; iterations?: number } = {}): HandAnalysis {
  const saved = Math.random;
  let seed = 2166136261;
  for (const ch of `${h.id}:${h.steps.length}:${h.board.join()}`) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  Math.random = mulberry32(seed >>> 0);
  try {
    return analyseHandSeeded(h, opts);
  } finally {
    Math.random = saved;
  }
}

function analyseHandSeeded(h: LoggedHand, opts: { decisions?: boolean; iterations?: number }): HandAnalysis {
  const { decisions: grade = false, iterations = 3000 } = opts;
  const cache = new Map<string, number[]>();
  const exact = (hands: Card[][], board: Card[]) => {
    const key = `${hands.map((x) => x.join(",")).join("|")}/${board.join(",")}`;
    if (!cache.has(key)) cache.set(key, equityKnown(hands, board));
    return cache.get(key)!;
  };
  const seats = positionsFor(h.players);
  const heroIdx = seats.indexOf(h.seat);
  const heroCards = h.hole.length === 2 ? h.hole : null;
  const known = new Map<string, Card[]>();
  for (const sd of h.showdowns) if (sd.seat && sd.seat !== h.seat && sd.cards.length === 2) known.set(sd.seat, sd.cards);
  const holes = seats.map((seat, i) => (i === heroIdx ? (heroCards ?? undefined) : known.get(seat)));
  const t = { ...tableOf(h), deck: deckFor(seats.length, holes, h.board) };
  const game0 = freshGame(t);
  let s: PlayState = { mode: "pub", stageId: stageFor(baseStack(t)), heroIdx, game: game0, ranges: game0.players.map(() => fullWeights()), decisions: [], botNotes: {}, stackUnknown: t.heroStack === null };

  const boardOn = (street: Street) => (h.board.length >= NEED[street] ? h.board.slice(0, NEED[street]) : null);
  const holeGuess = heroCards !== null && holeGuessed(h);
  const boardGuess = (cleanGuess(h.guess)?.board ?? []).filter((i) => i < h.board.length);
  /** Guessed suits are in play by this street. */
  const guessedBy = (street: Street) => holeGuess || boardGuess.some((i) => i < NEED[street]);
  const views: StreetView[] = [];
  const decisions: HeroDecision[] = [];

  const knownLive = (g: Game) =>
    g.players
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => !p.folded && (i === heroIdx ? heroCards : known.get(p.seat)))
      .map(({ p, i }) => ({ seat: p.seat, cards: i === heroIdx ? heroCards! : known.get(p.seat)! }));

  const open = (g: Game) => {
    const board = boardOn(g.street);
    const cards = knownLive(g);
    const shares = board && cards.length >= 2 ? exact(cards.map((c) => c.cards), board) : null;
    views.push({
      street: g.street,
      board,
      potStart: pot(g),
      potEnd: pot(g),
      actions: [],
      live: g.players.filter((p) => !p.folded).map((p) => p.seat),
      endLive: [],
      known: shares ? cards.map((c, k) => ({ ...c, equity: shares[k] })) : [],
      estimate: null,
      suitGuessed: guessedBy(g.street),
    });
  };
  const stillIn = (g: Game) => g.players.filter((p) => !p.folded).map((p) => p.seat);

  open(s.game);
  let applied = 0;
  for (const st of h.steps) {
    const g = s.game;
    if (g.done || g.toAct === null || g.players[g.toAct].seat !== st.s) break;
    const idx = g.toAct;
    const board = boardOn(g.street);
    const view = views[views.length - 1];
    // What the step does here: an all-in marker as the seat's whole stack, a shove the stack can't raise as a call.
    const r = resolveStep(g, st);
    if (!r) break;
    const eff: LogStep = { s: st.s, ...r };
    if (idx === heroIdx && heroCards && board) {
      if (view.estimate === null) view.estimate = estimate(s, heroCards, board, iterations);
      if (grade) {
        const move = heroMoveFor(g, eff);
        const decision = analyse(s, move);
        const cards = knownLive(g);
        const liveVillains = g.players.filter((p, i) => i !== heroIdx && !p.folded).length;
        const shares = cards.length >= 2 ? exact(cards.map((c) => c.cards), board) : null;
        const me = g.players[idx];
        decisions.push({
          street: g.street,
          step: st,
          verb: move.label.split(" ")[0],
          amount: eff.k === "call" ? Math.min(g.currentBet, me.streetBet + me.stack) : eff.k === "raise" ? (move.to ?? null) : null,
          decision,
          actual: shares ? shares[cards.findIndex((c) => c.seat === h.seat)] : null,
          actualComplete: cards.length - 1 === liveVillains,
          suitGuessed: guessedBy(g.street),
        });
      }
    } else if (idx !== heroIdx) narrow(s, idx, eff, !!board);
    const next = applyStep(g, st);
    if (!next) break;
    s = { ...s, game: next };
    applied++;
    if (!next.done && next.street !== g.street) {
      views[views.length - 1].endLive = stillIn(next);
      open(next);
    }
  }
  views[views.length - 1].endLive = stillIn(s.game);

  // An all-in before the river runs the board out: show those streets too.
  const g = s.game;
  if (g.done && g.showdown) {
    for (const street of ["flop", "turn", "river"] as Street[]) {
      if (views.some((v) => v.street === street) || NEED[street] <= NEED[views[views.length - 1].street]) continue;
      const board = boardOn(street);
      const cards = knownLive(g);
      const shares = board && cards.length >= 2 ? exact(cards.map((c) => c.cards), board) : null;
      const live = g.players.filter((p) => !p.folded).map((p) => p.seat);
      views.push({ street, board, potStart: pot(g), potEnd: pot(g), actions: [], live, endLive: live, known: shares ? cards.map((c, k) => ({ ...c, equity: shares[k] })) : [], estimate: null, suitGuessed: guessedBy(street) });
    }
  }

  // Actions and pot at the end of each street, from the full log.
  for (const line of streetLines(g, (bb) => `${r1(bb)}`, seatTags(h))) {
    const v = views.find((x) => x.street === line.street);
    if (v) [v.actions, v.potEnd] = [line.actions, line.pot];
  }
  // Streets where I never decided against anyone who had acted: estimate at the street start.
  // (Cheap enough for the few streets a hand has; ranges are as narrowed at the end, an approximation.)
  // Preflop every seat is dealt in at the start, so it is measured against the seats still in when the
  // preflop action ends (the folded ones don't contest the pot), with the ranges their actions left.
  for (const v of views) {
    if (v.estimate === null && heroCards && v.board && v.live.includes(h.seat) && v.live.length > 1 && heroIdx >= 0) {
      const against = (v.street === "preflop" ? v.endLive : v.live).filter((x) => x !== h.seat);
      if (!against.length) continue;
      const eq = equityVs(heroCards, v.board, against.map((x) => s.ranges[seats.indexOf(x)]), iterations);
      v.estimate = Number.isFinite(eq) ? eq : null;
    }
  }

  const live = g.players.map((p, i) => ({ p, i })).filter(({ p }) => !p.folded);
  const showdownSeats = g.done && g.showdown ? live.filter(({ i }) => i !== heroIdx).map(({ p }) => p.seat) : [];
  let heroNet: number | null = null;
  if (g.done && heroIdx >= 0) {
    const allKnown = live.every(({ p, i }) => (i === heroIdx ? heroCards : known.get(p.seat)));
    if (!g.showdown || (allKnown && h.board.length === 5)) heroNet = r1(g.players[heroIdx].stack - baseStack(t));
  }

  let current: HandAnalysis["current"] = null;
  if (!g.done && g.toAct === heroIdx && heroIdx >= 0) {
    const board = boardOn(g.street);
    current = {
      equity: heroCards && board ? estimate(s, heroCards, board, iterations) : null,
      // The price of a call against the pot I can win (a covering all-in's chips beyond my stack left out).
      need: callPrice(g, heroIdx),
    };
  }
  const suitGuess = holeGuess || boardGuess.length ? { hole: holeGuess, board: boardGuess } : null;
  return { game: g, applied, streets: views, decisions, heroNet, showdownSeats, current, suitGuess };
}
