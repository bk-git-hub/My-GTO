import { parseCards, RANKS, type Card } from "../../poker/cards";
import { legal } from "../../play/engine";
import { handOrder, parseShow, raisedBefore, type Act, type ScoutHand, type ScoutSession, type ScoutState, type Seated } from "../scout/scoutModel";
import type { LoggedHand, Result, ShowdownNote } from "./handLog";
import { applyStep, freshGame, positionsFor, type LogStep } from "./recorder";
import { holeFromRanks, type HoleKind } from "./suitGuess";

/**
 * The old 정보 수집 (scout) records turned into other-hands for the hand log: one hand per player who
 * showed cards, with that player as the replay's hero (see LoggedHand.kind). Pure: the caller reads
 * "mygto.scout" (never writing it) and merges the result (handLog.ts importScout).
 */

/** Note prefix on every hand copied from the scout records. */
export const SCOUT_NOTE = "정보 수집에서 옮김";

/** Deterministic id of the other-hand for one showdown: the scout hand's id and the physical seat number. */
export const scoutHandId = (handId: string, seat: number) => `scout-${handId}-${seat}`;

const STREET_END: Record<string, string> = { pre: "프리플랍까지", flop: "플랍까지", turn: "턴까지", river: "리버까지" };

/** Seat i's first preflop action as words: "림프", "콜", "체크", "오픈", "레이즈" (over limps), "3벳", "올인". */
function actWord(h: ScoutHand, seated: Seated[], i: number, a: Act): string {
  const x = seated[i];
  if (a === "L") return raisedBefore(h, x.pid) ? "콜" : x.pos === "BB" ? "체크" : "림프";
  if (a === "R") return seated.slice(0, i).some((y) => h.acts[y.pid] === "L") ? "레이즈" : "오픈";
  return a === "3" ? "3벳" : "올인";
}

/** "UTG 림프 · BTN 레이즈 · UTG 콜": first actions in preflop order, then the calls of a later raise. */
export function scoutActionWords(h: ScoutHand): string[] {
  const seated = handOrder(h);
  const out: string[] = [];
  seated.forEach((x, i) => {
    const a = h.acts[x.pid];
    if (a) out.push(`${x.pos} ${actWord(h, seated, i, a)}`);
  });
  for (const x of seated) if (h.called.includes(x.pid) && h.acts[x.pid]) out.push(`${x.pos} 콜`);
  return out;
}

/**
 * Preflop steps for a limped pot only (every voluntary action a limp, a check or a call of no raise):
 * no bet size is needed. Any raise or all-in has no size in the scout record, so then there are no steps.
 * The seats that didn't act fold (the BB checks), marked as filled in. Empty when it doesn't replay.
 */
export function limpedSteps(h: ScoutHand, players: number, subject: string): LogStep[] {
  const seated = handOrder(h);
  if (!Object.keys(h.acts).length) return [];
  if (Object.values(h.acts).some((a) => a !== "L") || h.called.length) return [];
  const byPos = new Map(seated.map((x) => [x.pos, x]));
  let g = freshGame({ heroSeat: subject, heroStack: null, stacks: {}, seats: positionsFor(players), bbAnte: true });
  const steps: LogStep[] = [];
  while (!g.done && g.toAct !== null && g.street === "preflop") {
    const seat = g.players[g.toAct].seat;
    const x = byPos.get(seat);
    const L = legal(g, g.toAct);
    const acted = x ? h.acts[x.pid] === "L" : false;
    const st: LogStep = acted ? { s: seat, k: L.canCheck ? "check" : "call" } : { s: seat, k: L.canCheck ? "check" : "fold", a: 1 };
    const next = applyStep(g, st);
    if (!next) return [];
    g = next;
    steps.push(st);
  }
  // The subject has to be in when the preflop ends (they showed their cards).
  const me = g.players.find((p) => p.seat === subject);
  return !g.done && g.street !== "preflop" && me && !me.folded ? steps : [];
}

const exactCards = (show: string): Card[] | null => {
  const p = parseShow(show);
  return p.ok && p.exact ? parseCards(p.norm) : null;
};

/** The subject's two cards from what they showed: exact cards, or a class with guessed suits. */
function holeOf(show: string, taken: Card[]): { hole: Card[]; guessed: boolean; holeKind?: HoleKind } | null {
  const p = parseShow(show);
  if (!p.ok) return null;
  if (p.exact) return { hole: parseCards(p.norm), guessed: false };
  const r1 = RANKS.indexOf(p.norm[0]);
  const r2 = RANKS.indexOf(p.norm[1]);
  const suffix = p.norm[2];
  const kind: HoleKind = suffix === "s" ? "suited" : suffix === "o" ? "offsuit" : "unknown";
  const hole = holeFromRanks(r1, r2, kind, taken, []);
  if (!hole) return null;
  // A pair has no suitedness to remember.
  return r1 === r2 ? { hole, guessed: true } : { hole, guessed: true, holeKind: kind };
}

/** The other-hands one scout hand holds: one per player (not me) whose shown cards can be read. */
export function scoutHandToHands(session: ScoutSession, h: ScoutHand): LoggedHand[] {
  const seated = handOrder(h);
  const players = seated.length;
  if (players < 2 || players > 10) return [];
  const posOf = new Map(seated.map((x) => [x.pid, x]));
  const shows = Object.entries(h.sd).filter(([pid, sd]) => posOf.has(pid) && parseShow(sd.show).ok);
  if (!shows.length) return [];
  const me = seated.find((x) => session.players[x.pid]?.me);
  const actions = scoutActionWords(h);
  const at = h.t > 0 ? h.t : session.started;
  const out: LoggedHand[] = [];
  for (const [pid, sd] of shows) {
    const x = posOf.get(pid)!;
    if (session.players[pid]?.me) continue; // my own cards belong in my own hand log
    // Everyone else at the showdown: exact cards go on the hand; a class or a lone "이김" tick goes in words.
    const others = Object.entries(h.sd).filter(([p, o]) => p !== pid && posOf.has(p) && (o.show.trim() !== "" || o.won));
    const taken = others.flatMap(([, o]) => exactCards(o.show) ?? []);
    const got = holeOf(sd.show, taken);
    if (!got) continue;
    // A typo can repeat a card already placed: then those cards stay in words only.
    const used = new Set<Card>(got.hole);
    const showdowns: ShowdownNote[] = others.map(([p, o]) => {
      let cards = exactCards(o.show);
      if (cards && cards.some((c) => used.has(c))) cards = null;
      cards?.forEach((c) => used.add(c));
      const parsed = parseShow(o.show);
      const shown = cards ? "" : parsed.ok ? `${parsed.norm} 보여줌` : o.show.trim() ? `${o.show.trim()} 보여줌` : "";
      // My own show stays at my seat (mySeat) for the equity, without a name: it is never an opponent's (myShowdown).
      const name = session.players[p]?.me ? "" : (session.players[p]?.name ?? "");
      return { name, seat: posOf.get(p)!.pos, cards: cards ?? [], did: [shown, o.won ? "이김" : ""].filter(Boolean).join(" · ") };
    });
    const result: Result | null = sd.won ? "win" : others.some(([, o]) => o.won) ? "lose" : null;
    const name = session.players[pid]?.name.trim() ?? "";
    const note = [SCOUT_NOTE, name && `닉 ${name}`, ...actions, h.street ? STREET_END[h.street] : "", h.note ? `메모 ${h.note}` : ""].filter(Boolean).join(" · ");
    const hand: LoggedHand = {
      id: scoutHandId(h.id, x.seat),
      createdAt: at,
      updatedAt: at,
      players,
      bbAnte: true,
      level: null,
      seat: x.pos,
      hole: got.hole,
      stack: null,
      note,
      result,
      net: null,
      board: [],
      steps: limpedSteps(h, players, x.pos),
      stacks: {},
      actions: { preflop: "", flop: "", turn: "", river: "" },
      showdowns,
      kind: "other",
      ...(me && me.pos !== x.pos ? { mySeat: me.pos } : {}),
      ...(got.guessed ? { guess: { hole: true as const } } : {}),
      ...(got.holeKind ? { holeKind: got.holeKind } : {}),
    };
    out.push(hand);
  }
  return out;
}

/** Every other-hand the scout records hold, oldest session first. */
export function scoutToHands(state: ScoutState): LoggedHand[] {
  return state.sessions.flatMap((s) => s.hands.flatMap((h) => scoutHandToHands(s, h)));
}
