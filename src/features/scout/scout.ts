import { createStore } from "../../state/store";

/**
 * 정보 수집 (scout): a fast per-hand log of what the OTHER players do, to build a pub-player model.
 *
 * Data model (stored under localStorage "mygto.scout"; exported as the same shape):
 *
 *   ScoutState   { v: 1, active: sessionId | null, sessions: ScoutSession[] }
 *   ScoutSession { id, started (ms), size (seats at the table, 2..10), mySeat (1..size | null),
 *                  occ: playerId | null per seat (index = seat - 1; null = empty seat) — who sits there NOW,
 *                  players: { [playerId]: ScoutPlayer }, hands: ScoutHand[], cur (index of the hand on screen) }
 *   ScoutPlayer  { id, seat, name ("" = none, shown as "3번 자리"), me? (the user) }
 *                  A player id stands for one person in one seat-occupancy: "새 사람" makes a new id, so
 *                  stats follow the person, not the seat. Ids are per session (no cross-session linking yet).
 *   ScoutHand    { id, no (1-based hand number), t (last edit ms), button (seat with the dealer button),
 *                  seats: [seat, playerId][] dealt in (sorted by seat),
 *                  acts: { [playerId]: Act } voluntary preflop action; missing = folded (BB: checked / walk),
 *                  called: playerIds that limped or raised and then CALLED a later raise (limp-call, raise-call),
 *                  sd: { [playerId]: { show, won? } } showdown: exact cards "Kh9h" or a class "K9s" / "AQo" / "77" / "AK",
 *                  street?: how far the hand went, note?, done? (closed with 다음 핸드) }
 *
 *   Act: "L" limp, or call of a raise ("BB" with no raise in front = check)
 *        "R" raise (open or iso)   "3" 3bet or more   "A" all-in
 * Positions are not stored: they follow from `button` and `seats` (see handOrder).
 */

export type Act = "L" | "R" | "3" | "A";
export type Street = "pre" | "flop" | "turn" | "river";
export const ACTS: readonly Act[] = ["L", "R", "3", "A"];
export const STREETS: readonly Street[] = ["pre", "flop", "turn", "river"];

export interface ScoutPlayer {
  id: string;
  seat: number;
  name: string;
  me?: boolean;
}

export interface Showdown {
  show: string;
  won?: boolean;
}

export interface ScoutHand {
  id: string;
  no: number;
  t: number;
  button: number;
  seats: [number, string][];
  acts: Record<string, Act>;
  called: string[];
  sd: Record<string, Showdown>;
  street?: Street;
  note?: string;
  done?: boolean;
}

export interface ScoutSession {
  id: string;
  started: number;
  size: number;
  mySeat: number | null;
  occ: (string | null)[];
  players: Record<string, ScoutPlayer>;
  hands: ScoutHand[];
  cur: number;
}

export interface ScoutState {
  v: 1;
  active: string | null;
  sessions: ScoutSession[];
}

export const TABLE_SIZES = [6, 7, 8, 9, 10] as const;
export const MAX_SESSIONS = 40;
export const MAX_HANDS = 1500;
const MAX_NAME = 16;
const MAX_NOTE = 200;
const MAX_SHOW = 12;

export const EMPTY_STATE: ScoutState = { v: 1, active: null, sessions: [] };

let idSeq = 0;
/** Short unique id: time + counter + random (no crypto needed). */
export function newId(): string {
  idSeq = (idSeq + 1) % 1296;
  return Date.now().toString(36) + idSeq.toString(36).padStart(2, "0") + Math.random().toString(36).slice(2, 6);
}

// ───────────── positions and the button ─────────────

/** Position names by players dealt in, in preflop action order (the last two are SB and BB). */
const POSITIONS: Record<number, string[]> = {
  2: ["SB", "BB"], // heads-up: the button is the SB
  3: ["BTN", "SB", "BB"],
  4: ["CO", "BTN", "SB", "BB"],
  5: ["HJ", "CO", "BTN", "SB", "BB"],
  6: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  7: ["UTG", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  8: ["UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  9: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  10: ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
};

export interface Seated {
  seat: number;
  pid: string;
  pos: string;
}

/**
 * The hand's players in preflop action order (UTG … BTN, SB, BB), each with its position.
 * If the button seat is not dealt in, the next dealt-in seat clockwise takes the button.
 */
export function handOrder(h: Pick<ScoutHand, "button" | "seats">): Seated[] {
  const seats = [...h.seats].sort((a, b) => a[0] - b[0]);
  const n = seats.length;
  if (n === 0) return [];
  if (n === 1) return [{ seat: seats[0][0], pid: seats[0][1], pos: "BTN" }];
  let b = seats.findIndex(([s]) => s >= h.button);
  if (b < 0) b = 0;
  // clockwise from the button: [BTN, SB, BB, UTG, ...]; heads-up [BTN/SB, BB]
  const cw = [...seats.slice(b), ...seats.slice(0, b)];
  const order = n === 2 ? cw : [...cw.slice(3), cw[0], cw[1], cw[2]];
  const names = POSITIONS[n] ?? POSITIONS[10].slice(-n);
  return order.map(([seat, pid], i) => ({ seat, pid, pos: names[i] ?? `${seat}` }));
}

/** The next occupied seat clockwise after `from` (1..size), or `from` when nobody else sits. */
export function nextOccupied(occupied: number[], from: number, size: number, dir: 1 | -1 = 1): number {
  const set = new Set(occupied);
  for (let k = 1; k <= size; k++) {
    const s = ((((from - 1 + dir * k) % size) + size) % size) + 1;
    if (set.has(s)) return s;
  }
  return from;
}

// ───────────── sessions and hands ─────────────

const seatsOf = (occ: (string | null)[]): [number, string][] =>
  occ.flatMap((pid, i) => (pid ? [[i + 1, pid] as [number, string]] : []));

function blankHand(no: number, button: number, seats: [number, string][]): ScoutHand {
  return { id: newId(), no, t: Date.now(), button, seats, acts: {}, called: [], sd: {} };
}

/** A fresh session: every seat occupied by a new unnamed player, hand #1 open with the button on seat 1. */
export function newSession(size = 9, mySeat: number | null = null): ScoutSession {
  const players: Record<string, ScoutPlayer> = {};
  const occ: string[] = [];
  for (let s = 1; s <= size; s++) {
    const id = newId();
    players[id] = { id, seat: s, name: "", ...(s === mySeat ? { me: true } : {}) };
    occ.push(id);
  }
  return { id: newId(), started: Date.now(), size, mySeat, occ, players, hands: [blankHand(1, 1, seatsOf(occ))], cur: 0 };
}

export const currentHand = (s: ScoutSession): ScoutHand => s.hands[Math.min(Math.max(s.cur, 0), s.hands.length - 1)];

/** True when nothing was entered for this player in the hand (so its seat may still change hands). */
const playerBlank = (h: ScoutHand, pid: string) => !h.acts[pid] && !h.sd[pid] && !h.called.includes(pid);

/** Nothing entered at all: no actions, showdowns, street or note. */
export const handBlank = (h: ScoutHand) => Object.keys(h.acts).length === 0 && Object.keys(h.sd).length === 0 && !h.street && !h.note;

/** A hand that counts for stats: closed with 다음 핸드, or the open one once something is entered. */
export const handCounts = (h: ScoutHand) => !!h.done || !handBlank(h);

function patchHand(s: ScoutSession, fn: (h: ScoutHand) => ScoutHand): ScoutSession {
  const i = Math.min(Math.max(s.cur, 0), s.hands.length - 1);
  const hands = s.hands.slice();
  hands[i] = { ...fn(hands[i]), t: Date.now() };
  return { ...s, cur: i, hands };
}

/**
 * Seat changes (size, empty seat, new person) reach the latest hand (even while an older one is on screen),
 * and only for seats with nothing entered yet; a seat with recorded actions keeps its player until 다음 핸드.
 */
function syncLatest(s: ScoutSession): ScoutSession {
  const last = s.hands.length - 1;
  const h = s.hands[last];
  const keep = h.seats.filter(([, pid]) => !playerBlank(h, pid));
  const keptSeats = new Set(keep.map(([seat]) => seat));
  const keptPids = new Set(keep.map(([, pid]) => pid));
  const add = seatsOf(s.occ).filter(([seat, pid]) => !keptSeats.has(seat) && !keptPids.has(pid));
  const seats = [...keep, ...add].sort((a, b) => a[0] - b[0]);
  const live = new Set(seats.map(([, pid]) => pid));
  const pick = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([pid]) => live.has(pid)));
  let button = h.button;
  if (!seats.some(([seat]) => seat === button) && seats.length) button = nextOccupied(seats.map(([x]) => x), button, Math.max(s.size, ...seats.map(([x]) => x)));
  const hands = s.hands.slice();
  hands[last] = { ...h, seats, button, acts: pick(h.acts), sd: pick(h.sd), called: h.called.filter((p) => live.has(p)) };
  return { ...s, hands };
}

export function setSize(s: ScoutSession, size: number): ScoutSession {
  size = Math.max(2, Math.min(10, Math.round(size)));
  const players = { ...s.players };
  const occ = s.occ.slice(0, size);
  for (let seat = occ.length + 1; seat <= size; seat++) {
    const id = newId();
    players[id] = { id, seat, name: "" };
    occ.push(id);
  }
  const mySeat = s.mySeat && s.mySeat <= size ? s.mySeat : null;
  return syncLatest(markMe({ ...s, size, occ, players, mySeat }));
}

/**
 * Flags the player in `mySeat` as me. A seated player elsewhere is not me; a player who was me and
 * is no longer seated stays me, so my own past hands never show up as an opponent's.
 */
function markMe(s: ScoutSession): ScoutSession {
  const mine = s.mySeat ? s.occ[s.mySeat - 1] : null;
  const seated = new Set(s.occ.filter((p): p is string => !!p));
  const players: Record<string, ScoutPlayer> = {};
  for (const [id, p] of Object.entries(s.players)) {
    const { me: _me, ...rest } = p;
    void _me;
    players[id] = id === mine || (p.me && !seated.has(id)) ? { ...rest, me: true } : rest;
  }
  return { ...s, players };
}

/** Whether the player is in any hand that counts (so they have stats to keep). */
export const hasHistory = (s: ScoutSession, pid: string | null | undefined): boolean =>
  !!pid && s.hands.some((h) => handCounts(h) && h.seats.some(([, p]) => p === pid));

/**
 * Sets my seat. If I already had a seat with recorded hands, this is a move: my player goes to the new
 * seat (keeping my history), my old seat becomes empty, and whoever sat in the new seat leaves it with
 * their stats intact. Otherwise (first pick, or fixing a pick before any hands) the seat's player is me.
 */
export function setMySeat(s: ScoutSession, seat: number | null): ScoutSession {
  const to = seat && seat >= 1 && seat <= s.size ? seat : null;
  const from = s.mySeat;
  const me = from ? s.occ[from - 1] : null;
  if (to && from && to !== from && me && s.players[me]?.me && hasHistory(s, me)) {
    const occ = s.occ.slice();
    occ[from - 1] = null;
    occ[to - 1] = me;
    const players = { ...s.players, [me]: { ...s.players[me], seat: to } };
    return syncLatest(markMe({ ...s, mySeat: to, occ, players }));
  }
  return syncLatest(markMe({ ...s, mySeat: to }));
}

export function renamePlayer(s: ScoutSession, pid: string, name: string): ScoutSession {
  const p = s.players[pid];
  if (!p) return s;
  return { ...s, players: { ...s.players, [pid]: { ...p, name: name.slice(0, MAX_NAME) } } };
}

/** "자리 바뀜/새 사람": a new unnamed player takes the seat (an empty seat gets someone too). */
export function newPerson(s: ScoutSession, seat: number): ScoutSession {
  if (seat < 1 || seat > s.size) return s;
  const id = newId();
  const occ = s.occ.slice();
  occ[seat - 1] = id;
  return syncLatest(markMe({ ...s, occ, players: { ...s.players, [id]: { id, seat, name: "" } } }));
}

/** Empties a seat, or seats a new player in an empty one. */
export function toggleEmpty(s: ScoutSession, seat: number): ScoutSession {
  if (seat < 1 || seat > s.size) return s;
  if (!s.occ[seat - 1]) return newPerson(s, seat);
  const occ = s.occ.slice();
  occ[seat - 1] = null;
  return syncLatest(markMe({ ...s, occ }));
}

export function setButton(s: ScoutSession, seat: number): ScoutSession {
  return patchHand(s, (h) => ({ ...h, button: seat }));
}

/** Moves the button one dealt-in seat clockwise (dir 1) or back (dir -1). */
export function stepButton(s: ScoutSession, dir: 1 | -1): ScoutSession {
  const h = currentHand(s);
  const seated = h.seats.map(([seat]) => seat);
  const btn = handOrder(h).find((x) => x.pos === "BTN" || (h.seats.length === 2 && x.pos === "SB"))?.seat ?? h.button;
  return setButton(s, nextOccupied(seated, btn, Math.max(s.size, ...seated), dir));
}

const AGGRO: ReadonlySet<Act | undefined> = new Set<Act | undefined>(["R", "3", "A"]);
const RANK_OF: Record<Act, number> = { L: 0, R: 1, "3": 2, A: 3 };

/** Whether someone after `pid` in action order raised above `pid`'s own action (so "→콜" means something). */
export function raisedBehind(h: ScoutHand, pid: string): boolean {
  const order = handOrder(h);
  const i = order.findIndex((x) => x.pid === pid);
  const mine = h.acts[pid];
  if (i < 0 || !mine) return false;
  return order.slice(i + 1).some((x) => {
    const a = h.acts[x.pid];
    return a !== undefined && AGGRO.has(a) && RANK_OF[a] > RANK_OF[mine];
  });
}

/** Whether someone before `pid` in action order raised (the L button then means "콜"). */
export function raisedBefore(h: ScoutHand, pid: string): boolean {
  const order = handOrder(h);
  const i = order.findIndex((x) => x.pid === pid);
  return order.slice(0, Math.max(i, 0)).some((x) => AGGRO.has(h.acts[x.pid]));
}

/**
 * One tap on an action button. A new action replaces the old one. Tapping the lit L or R again marks
 * "→콜" (called a raise behind) when there is one, and the next tap clears it; otherwise it clears.
 */
export function tapAct(s: ScoutSession, pid: string, act: Act): ScoutSession {
  return patchHand(s, (h) => {
    const acts = { ...h.acts };
    let called = h.called.filter((p) => p !== pid);
    if (h.acts[pid] !== act) acts[pid] = act;
    else if ((act === "L" || act === "R") && !h.called.includes(pid) && raisedBehind(h, pid)) called = [...called, pid];
    else delete acts[pid];
    const next = { ...h, acts, called };
    // a "→콜" only stands while a raise behind it is still there
    return { ...next, called: called.filter((p) => raisedBehind(next, p)) };
  });
}

export function setShow(s: ScoutSession, pid: string, show: string | null): ScoutSession {
  return patchHand(s, (h) => {
    const sd = { ...h.sd };
    // emptied text keeps a lone "이김" tick; null removes the showdown
    if (show === null || (!show.trim() && !sd[pid]?.won)) delete sd[pid];
    else sd[pid] = { ...sd[pid], show: show.trim().slice(0, MAX_SHOW) };
    return { ...h, sd };
  });
}

export function toggleWon(s: ScoutSession, pid: string): ScoutSession {
  return patchHand(s, (h) => {
    const cur = h.sd[pid];
    return { ...h, sd: { ...h.sd, [pid]: { show: cur?.show ?? "", won: !cur?.won } } };
  });
}

export function setStreet(s: ScoutSession, street: Street | null): ScoutSession {
  return patchHand(s, (h) => {
    const { street: _old, ...rest } = h;
    void _old;
    return street && street !== h.street ? { ...rest, street } : rest;
  });
}

export function setNote(s: ScoutSession, note: string): ScoutSession {
  return patchHand(s, (h) => {
    const { note: _old, ...rest } = h;
    void _old;
    return note ? { ...rest, note: note.slice(0, MAX_NOTE) } : rest;
  });
}

/**
 * 다음 핸드: closes the hand on screen. From the latest hand it opens a new one with the button on the
 * next occupied seat and today's seating; from an older hand (after 이전 핸드) it just moves forward.
 */
export function nextHand(s: ScoutSession): ScoutSession {
  const i = Math.min(Math.max(s.cur, 0), s.hands.length - 1);
  const hands = s.hands.slice();
  hands[i] = { ...hands[i], done: true };
  if (i < hands.length - 1) return { ...s, hands, cur: i + 1 };
  const h = hands[i];
  const seats = seatsOf(s.occ);
  const btn = handOrder(h).find((x) => x.pos === "BTN" || (h.seats.length === 2 && x.pos === "SB"))?.seat ?? h.button;
  const button = nextOccupied(seats.map(([x]) => x), btn, s.size);
  hands.push(blankHand(h.no + 1, button, seats));
  // keep the stored session bounded: drop the oldest hands
  const over = Math.max(0, hands.length - MAX_HANDS);
  return { ...s, hands: hands.slice(over), cur: hands.length - 1 - over };
}

/**
 * Deletes the hand on screen (e.g. an empty one from a stray 다음 핸드 tap). Not the latest, open hand.
 * Later hands are renumbered; if the next one is the open, still-blank hand, it takes over the deleted
 * hand's button, so the button is back where it should be.
 */
export function deleteHand(s: ScoutSession): ScoutSession {
  const i = Math.min(Math.max(s.cur, 0), s.hands.length - 1);
  if (i >= s.hands.length - 1) return s;
  const gone = s.hands[i];
  const now = Date.now();
  const hands = s.hands.filter((_, j) => j !== i).map((h, j) => (j < i ? h : { ...h, no: h.no - 1, t: now }));
  const last = hands.length - 1;
  if (i === last && handBlank(hands[last])) {
    const seated = hands[last].seats.map(([x]) => x);
    const button = seated.includes(gone.button) ? gone.button : nextOccupied(seated, gone.button, Math.max(s.size, ...seated));
    hands[last] = { ...hands[last], button };
  }
  return { ...s, hands, cur: i };
}

export function prevHand(s: ScoutSession): ScoutSession {
  return { ...s, cur: Math.max(0, Math.min(s.cur, s.hands.length - 1) - 1) };
}

// ───────────── showdown text ─────────────

const RANK_CHARS = "23456789TJQKA";
const SUIT_CHARS = "shdc";

export type ParsedShow = { ok: true; norm: string; cls: string; exact: boolean } | { ok: false; partial: boolean };

/**
 * Shown cards as typed: exact cards ("Kh9h", "kh 9h", "10h9h") or a hand class ("K9s", "AQo", "77", "AK" = suit unknown).
 * `norm` is the tidy form to store, `cls` the hand class ("K9s").
 */
export function parseShow(text: string): ParsedShow {
  const t = text.replace(/[\s,]/g, "").replace(/10/g, "T");
  if (!t) return { ok: false, partial: true };
  const up = (c: string) => c.toUpperCase();
  const rk = (c: string) => RANK_CHARS.indexOf(up(c));
  // class: two ranks + optional s/o
  const m = /^([2-9tjqka])([2-9tjqka])([so]?)$/i.exec(t);
  if (m) {
    let [a, b] = [up(m[1]), up(m[2])];
    const suf = m[3].toLowerCase();
    if (rk(b) > rk(a)) [a, b] = [b, a];
    if (a === b) return suf ? { ok: false, partial: false } : { ok: true, norm: a + b, cls: a + b, exact: false };
    return { ok: true, norm: a + b + suf, cls: a + b + suf, exact: false };
  }
  // exact: rank+suit, rank+suit
  const e = /^([2-9tjqka])([shdc])([2-9tjqka])([shdc])$/i.exec(t);
  if (e) {
    const c1 = up(e[1]) + e[2].toLowerCase();
    const c2 = up(e[3]) + e[4].toLowerCase();
    if (c1 === c2) return { ok: false, partial: false };
    const [hi, lo] = rk(c2[0]) > rk(c1[0]) ? [c2, c1] : [c1, c2];
    const cls = hi[0] === lo[0] ? hi[0] + lo[0] : hi[0] + lo[0] + (hi[1] === lo[1] ? "s" : "o");
    return { ok: true, norm: hi + lo, cls, exact: true };
  }
  // still typing? (a prefix of either form)
  const partial = /^[2-9tjqka]([shdc]([2-9tjqka][shdc]?)?|[2-9tjqka])?$/i.test(t) && t.length < 4;
  return { ok: false, partial };
}

/** The suit characters of an exact show, for coloring ("Kh9h" → h, h). */
export const SHOW_SUITS = SUIT_CHARS;

// ───────────── sanitize, import, export ─────────────

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
const num = (x: unknown, lo: number, hi: number): number | null => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x) : null);
const ID = /^[a-z0-9]{4,32}$/i;
const id = (x: unknown) => (typeof x === "string" && ID.test(x) ? x : null);

function cleanHand(x: unknown, players: Record<string, ScoutPlayer>): ScoutHand | null {
  if (!isObj(x)) return null;
  const hid = id(x.id);
  const no = num(x.no, 1, 1e6);
  if (!hid || no === null) return null;
  const seats: [number, string][] = [];
  if (Array.isArray(x.seats))
    for (const p of x.seats) {
      if (!Array.isArray(p)) continue;
      const seat = num(p[0], 1, 10);
      const pid = id(p[1]);
      if (seat !== null && pid && players[pid] && !seats.some(([s2, p2]) => s2 === seat || p2 === pid)) seats.push([seat, pid]);
    }
  seats.sort((a, b) => a[0] - b[0]);
  const dealt = new Set(seats.map(([, p]) => p));
  const acts: Record<string, Act> = {};
  if (isObj(x.acts)) for (const [pid, a] of Object.entries(x.acts)) if (dealt.has(pid) && (ACTS as readonly unknown[]).includes(a)) acts[pid] = a as Act;
  const called = Array.isArray(x.called) ? [...new Set(x.called.filter((p): p is string => typeof p === "string" && !!acts[p]))] : [];
  const sd: Record<string, Showdown> = {};
  if (isObj(x.sd))
    for (const [pid, v] of Object.entries(x.sd)) {
      if (!dealt.has(pid) || !isObj(v)) continue;
      sd[pid] = { show: str(v.show, MAX_SHOW), ...(v.won === true ? { won: true } : {}) };
    }
  const h: ScoutHand = { id: hid, no, t: num(x.t, 0, 1e15) ?? 0, button: num(x.button, 1, 10) ?? seats[0]?.[0] ?? 1, seats, acts, called, sd };
  if ((STREETS as readonly unknown[]).includes(x.street)) h.street = x.street as Street;
  const note = str(x.note, MAX_NOTE);
  if (note) h.note = note;
  if (x.done === true) h.done = true;
  return h;
}

export function cleanSession(x: unknown): ScoutSession | null {
  if (!isObj(x)) return null;
  const sid = id(x.id);
  if (!sid) return null;
  const size = num(x.size, 2, 10) ?? 9;
  const players: Record<string, ScoutPlayer> = {};
  if (isObj(x.players))
    for (const [pid, p] of Object.entries(x.players)) {
      if (!ID.test(pid) || !isObj(p)) continue;
      const seat = num(p.seat, 1, 10);
      if (seat === null) continue;
      players[pid] = { id: pid, seat, name: str(p.name, MAX_NAME), ...(p.me === true ? { me: true } : {}) };
    }
  const occ: (string | null)[] = [];
  for (let i = 0; i < size; i++) {
    const pid = Array.isArray(x.occ) ? id(x.occ[i]) : null;
    occ.push(pid && players[pid] && !occ.includes(pid) ? pid : null);
  }
  const seen = new Set<string>();
  let hands = (Array.isArray(x.hands) ? x.hands : [])
    .map((h) => cleanHand(h, players))
    .filter((h): h is ScoutHand => !!h && !seen.has(h.id) && !!seen.add(h.id));
  if (hands.length > MAX_HANDS) hands = hands.slice(-MAX_HANDS);
  if (!hands.length) hands = [blankHand(1, 1, seatsOf(occ))];
  const mySeat = num(x.mySeat, 1, size);
  const cur = num(x.cur, 0, hands.length - 1) ?? hands.length - 1;
  return { id: sid, started: num(x.started, 0, 1e15) ?? 0, size, mySeat, occ, players, hands, cur };
}

/** Whatever came out of storage or a file, made safe to render: bad parts dropped, sizes capped. */
export function sanitizeState(x: unknown): ScoutState {
  if (!isObj(x)) return EMPTY_STATE;
  const seen = new Set<string>();
  let sessions = (Array.isArray(x.sessions) ? x.sessions : [])
    .map(cleanSession)
    .filter((s): s is ScoutSession => !!s && !seen.has(s.id) && !!seen.add(s.id));
  if (sessions.length > MAX_SESSIONS) sessions = [...sessions].sort((a, b) => a.started - b.started).slice(-MAX_SESSIONS);
  const active = typeof x.active === "string" && sessions.some((s) => s.id === x.active) ? x.active : (sessions[sessions.length - 1]?.id ?? null);
  return { v: 1, active, sessions };
}

/**
 * Merges imported data into ours by id: unknown sessions are added; in a session both have,
 * hands are joined by id (the later edit wins), players joined (our names win unless empty),
 * and our seating stays.
 */
/** `hands` counts recorded hands added or replaced by a later edit. */
export function mergeState(ours: ScoutState, theirs: ScoutState): { state: ScoutState; sessions: number; hands: number } {
  let addedSessions = 0;
  let addedHands = 0;
  const sessions = ours.sessions.map((s) => ({ ...s }));
  for (const t of theirs.sessions) {
    const i = sessions.findIndex((s) => s.id === t.id);
    if (i < 0) {
      sessions.push(t);
      addedSessions++;
      addedHands += t.hands.filter(handCounts).length;
      continue;
    }
    const o = sessions[i];
    const players = { ...t.players };
    for (const [pid, p] of Object.entries(o.players)) players[pid] = p.name || !t.players[pid] ? p : { ...p, name: t.players[pid].name };
    const byId = new Map(o.hands.map((h) => [h.id, h]));
    for (const h of t.hands) {
      const mine = byId.get(h.id);
      if (!mine || h.t > mine.t) {
        if (handCounts(h)) addedHands++;
        byId.set(h.id, h);
      }
    }
    const curId = o.hands[o.cur]?.id;
    const hands = [...byId.values()].sort((a, b) => a.no - b.no || a.t - b.t).slice(-MAX_HANDS);
    const cur = Math.max(0, hands.findIndex((h) => h.id === curId));
    sessions[i] = { ...o, players, hands, cur };
  }
  sessions.sort((a, b) => a.started - b.started);
  const capped = sessions.slice(-MAX_SESSIONS);
  const active = ours.active && capped.some((s) => s.id === ours.active) ? ours.active : (capped[capped.length - 1]?.id ?? null);
  return { state: { v: 1, active, sessions: capped }, sessions: addedSessions, hands: addedHands };
}

/** The export file's content. */
export function exportJson(st: ScoutState): string {
  return JSON.stringify({ app: "pubaj-scout", v: 1, exported: new Date().toISOString(), active: st.active, sessions: st.sessions });
}

// ───────────── the store ─────────────

export const SCOUT_KEY = "mygto.scout";
export const scoutStore = createStore<ScoutState>(SCOUT_KEY, EMPTY_STATE);

// Sanitize what was loaded; keep a copy of the raw text first if cleaning changes anything.
(() => {
  const loaded = scoutStore.get();
  const clean = sanitizeState(loaded);
  if (JSON.stringify(clean) === JSON.stringify(loaded)) return;
  try {
    const raw = localStorage.getItem(SCOUT_KEY);
    if (raw) localStorage.setItem(SCOUT_KEY + ".bak", raw);
  } catch {
    /* no storage */
  }
  if (loaded !== EMPTY_STATE) scoutStore.set(clean);
})();

/** The active session, or null before the first one. */
export function activeSession(st: ScoutState): ScoutSession | null {
  return st.sessions.find((s) => s.id === st.active) ?? null;
}

/** Applies `fn` to the active session. Returns false if storage refused the write. */
export function updateActive(fn: (s: ScoutSession) => ScoutSession): boolean {
  return scoutStore.set((st) => ({ ...st, sessions: st.sessions.map((s) => (s.id === st.active ? fn(s) : s)) }));
}

/** Starts a new session (same table size and my seat as the last one) and makes it active. */
export function startSession(size?: number, mySeat?: number | null): boolean {
  const last = activeSession(scoutStore.get());
  const s = newSession(size ?? last?.size ?? 9, mySeat !== undefined ? mySeat : (last?.mySeat ?? null));
  return scoutStore.set((st) => {
    const sessions = [...st.sessions, s].slice(-MAX_SESSIONS);
    return { ...st, active: s.id, sessions };
  });
}
