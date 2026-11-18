import { RANKS } from "../../poker/cards";
import { createStore } from "../../state/store";
import { actsFor, isFastSpot, seatsBefore, spotsFor, VERDICT_MARK, type FastSpot, type VerdictKind } from "./fastVerdict";
import { fastActText, fastOnly, fastVerdictOf, holeClass, isOther, tidyHand, withHole, type LoggedHand } from "./handLog";
import { cleanPre, isStage, STAGE_LABEL, type PreAction, type PreStage } from "./quickPre";
import { buttonSeat, positionsFor, TABLE_SIZES } from "./recorder";
import { holeFromRanks } from "./suitGuess";

/**
 * 빠른 기록: every hand dealt to me, one decision each (seat, class, what happened before me, my action),
 * graded against the pub chart the moment the action is tapped. The editor's state (the stage, the
 * table size, the hand being typed) is kept in its own small store so a reload or a trip elsewhere
 * loses nothing; each saved hand is an ordinary LoggedHand (fast: true). Everything here is pure but
 * the stores.
 *
 * 남의 핸드 is the same screen in "other" mode: a hand someone else showed (their seat, their class, what
 * happened before them, their action), saved as an other-hand (kind "other") and judged against the same
 * chart as information about how pub players play. Its seat doesn't move on by itself (the player shown
 * varies), and it has its own editor store and its own today's list.
 */

/** Whose hands the screen takes: mine (빠른 기록) or other players' (남의 핸드). */
export type FastMode = "mine" | "other";
const kindFits = (h: Pick<LoggedHand, "kind">, mode: FastMode): boolean => isOther(h) === (mode === "other");

export interface FastDraft {
  seat: string;
  /** Rank indexes (cards.ts RANKS: 0 = 2 … 12 = A) in the order tapped: none, one or two. */
  ranks: number[];
  /** Suited or not, for two different ranks; null until picked. */
  suited: boolean | null;
  spot: FastSpot;
  /** Who opened or shoved before me (spot "open" / "shove"). */
  opener: string | null;
  /** The saved hand on screen to correct (its id), or null for a new hand. */
  editing: string | null;
  /** A hand being corrected keeps its own stage and table size (absent for a new hand: the session's). */
  stage?: PreStage;
  players?: number;
}

export interface FastState {
  /** The pub chart stage the verdicts use, for new hands. */
  stage: PreStage;
  /** Table size for new hands. */
  players: number;
  draft: FastDraft;
  /** The new hand put aside while a saved one is corrected. */
  parked: FastDraft | null;
}

export const fastStore = createStore<Partial<FastState>>("mygto.fast", {});
/** 남의 핸드's editor: its own hand being typed; the stage and table size follow 빠른 기록's (shareTable). */
export const fastOtherStore = createStore<Partial<FastState>>("mygto.fast.other", {});
export const storeFor = (mode: FastMode) => (mode === "other" ? fastOtherStore : fastStore);

/** A blank hand at `seat`, nothing happened before me yet. */
export const newDraft = (seat: string): FastDraft => ({ seat, ranks: [], suited: null, spot: "none", opener: null, editing: null });

/**
 * My seat next hand: the button moves one seat clockwise, so I move one place earlier in the preflop
 * order (BTN → CO → … → UTG → BB → SB → BTN). The button for a seat not at this table.
 */
export function nextSeat(players: number, seat: string): string {
  const seats = positionsFor(players);
  const i = seats.indexOf(seat);
  if (i < 0) return buttonSeat(players);
  return seats[(i - 1 + seats.length) % seats.length];
}

/** The table size and stage the draft is entered at: its own when correcting a saved hand, else the session's. */
export const draftPlayers = (s: Pick<FastState, "players" | "draft">): number => s.draft.players ?? s.players;
export const draftStage = (s: Pick<FastState, "stage" | "draft">): PreStage => s.draft.stage ?? s.stage;

// ───────────── the hand ─────────────

/**
 * A rank tapped: the first or second card; a third tap starts a new hand class. Not while a saved hand
 * is being corrected: there a third tap does nothing (⌫ first), so a next hand typed by mistake into the
 * correction can't overwrite the saved one.
 */
export function tapRank(d: FastDraft, r: number): FastDraft {
  if (!Number.isInteger(r) || r < 0 || r > 12) return d;
  if (d.editing && classDone(d)) return d;
  const ranks = d.ranks.length >= 2 ? [r] : [...d.ranks, r];
  return { ...d, ranks, suited: null };
}

/** ⌫: the suitedness first, then the last rank. */
export function undoTap(d: FastDraft): FastDraft {
  if (d.suited !== null) return { ...d, suited: null };
  return { ...d, ranks: d.ranks.slice(0, -1) };
}

/** 수딧 / 오프수트, for two different ranks. */
export function pickSuited(d: FastDraft, suited: boolean): FastDraft {
  if (d.ranks.length !== 2 || d.ranks[0] === d.ranks[1]) return d;
  return { ...d, suited };
}

/** Two ranks of which a pair or with suitedness picked: the class is complete. */
export const classDone = (d: Pick<FastDraft, "ranks" | "suited">): boolean => d.ranks.length === 2 && (d.ranks[0] === d.ranks[1] || d.suited !== null);

/** The class as typed so far, high card first: "", "A", "AJ" (suitedness to pick), "AJo", "AJs", "TT". */
export function draftClass(d: Pick<FastDraft, "ranks" | "suited">): string {
  if (!d.ranks.length) return "";
  const [hi, lo] = [...d.ranks].sort((a, b) => b - a);
  if (lo === undefined) return RANKS[hi];
  if (hi === lo) return RANKS[hi] + RANKS[lo];
  return RANKS[hi] + RANKS[lo] + (d.suited === null ? "" : d.suited ? "s" : "o");
}

// ───────────── the spot ─────────────

/** My seat changed: an opener no longer before me goes, and a spot that can't happen there falls back to 폴드로 나에게. */
export function withSeat(d: FastDraft, seat: string, players: number): FastDraft {
  if (!positionsFor(players).includes(seat)) return d;
  const spot = spotsFor(players, seat).includes(d.spot) ? d.spot : "none";
  const opener = d.opener && (spot === "open" || spot === "shove") && seatsBefore(players, seat).includes(d.opener) ? d.opener : null;
  return { ...d, seat, spot, opener };
}

/** What happened before me; the opener only goes with an open or a shove (and stays when moving between them). */
export function withSpot(d: FastDraft, spot: FastSpot): FastDraft {
  const keep = (spot === "open" || spot === "shove") && (d.spot === "open" || d.spot === "shove");
  return { ...d, spot, opener: keep ? d.opener : null };
}

/** Everything but my action is in: my seat at this table, the class, a spot that can happen there, its opener. */
export function draftReady(d: FastDraft, players: number): boolean {
  if (!positionsFor(players).includes(d.seat) || !classDone(d)) return false;
  if (!spotsFor(players, d.seat).includes(d.spot)) return false;
  if (d.spot === "open" || d.spot === "shove") return d.opener !== null && seatsBefore(players, d.seat).includes(d.opener);
  return true;
}

/**
 * The hand to save for the draft with my action (undefined only for a walk at the BB), on `base`: a
 * fresh hand (its id, time and level) or the saved one being corrected. Its cards come from the class
 * with guessed suits (holeFromRanks; marked guess.hole with holeKind), the stage, my action and the
 * opener go in the preflop block (so 테이블로 이어서 기록 can place them), the spot in `fastSpot`.
 * In "other" mode it is another player's hand (kind "other"): the seat, the cards and the action are
 * theirs, and my own seat is left out. Null when the draft isn't ready or the action doesn't fit the spot.
 */
export function fastHand(d: FastDraft, act: PreAction | undefined, base: LoggedHand, stage: PreStage, players: number, mode: FastMode = "mine"): LoggedHand | null {
  if (!draftReady(d, players)) return null;
  const acts = actsFor(d.spot, d.seat);
  if (act === undefined ? acts.length > 0 : !acts.includes(act)) return null;
  const [a, b] = d.ranks;
  const pair = a === b;
  const kind = pair || !d.suited ? "offsuit" : "suited";
  const hole = holeFromRanks(a, b, kind, []);
  if (!hole) return null;
  const facing = d.spot === "open" || d.spot === "shove";
  const seats = positionsFor(players);
  const quickPre = cleanPre({ stage, pinned: true, action: act, ...(d.spot === "shove" ? { openAllIn: true } : {}), ...(facing && d.opener ? { openerSeat: d.opener } : {}) }, seats);
  const { quickPre: _was, kind: _kind, mySeat: _my, ...rest } = base;
  void _was;
  void _kind;
  void _my;
  const h: LoggedHand = { ...rest, players, seat: d.seat, ...(quickPre ? { quickPre } : {}), fast: true, fastSpot: d.spot, ...(mode === "other" ? { kind: "other" as const } : {}) };
  return tidyHand(withHole(h, hole, true, pair ? undefined : kind));
}

/** A saved 빠른 기록 hand back in the editor, to correct it. */
export function draftOf(h: LoggedHand): FastDraft {
  const ranks = h.hole.length === 2 ? h.hole.map((c) => c >> 2) : [];
  const pair = ranks.length === 2 && ranks[0] === ranks[1];
  const suited = ranks.length === 2 && !pair ? h.holeKind === "suited" || (h.holeKind === undefined && (h.hole[0] & 3) === (h.hole[1] & 3)) : null;
  const spot = isFastSpot(h.fastSpot) ? h.fastSpot : "none";
  const opener = spot === "open" || spot === "shove" ? (h.quickPre?.openerSeat ?? null) : null;
  return { seat: h.seat, ranks, suited, spot, opener, editing: h.id, ...(h.quickPre?.stage ? { stage: h.quickPre.stage } : {}), players: h.players };
}

// ───────────── saving, correcting ─────────────

/** The newest 빠른 기록 hand of the mode's kind. */
const newestFast = (hands: LoggedHand[], mode: FastMode): LoggedHand | null =>
  hands.reduce<LoggedHand | null>((b, h) => (h.fast === true && kindFits(h, mode) && (!b || h.createdAt > b.createdAt) ? h : b), null);

/**
 * The editor after `saved` went on file (`hands` is the log with it): a new hand clears the editor for
 * the next one at the next seat. A corrected hand gives back the new hand that was put aside; if it was
 * the newest one, the next seat follows its (maybe corrected) seat. In "other" mode the seat stays where
 * it was picked (the next hand shown is anybody's): a new hand starts at the same seat.
 */
export function afterSave(s: FastState, saved: LoggedHand, hands: LoggedHand[], mode: FastMode = "mine"): FastState {
  if (mode === "other") {
    const seat = positionsFor(s.players).includes(saved.seat) ? saved.seat : buttonSeat(s.players);
    return { ...s, draft: s.draft.editing ? (s.parked ?? newDraft(seat)) : newDraft(seat), parked: null };
  }
  if (!s.draft.editing) return { ...s, draft: newDraft(nextSeat(s.players, saved.seat)), parked: null };
  const back = s.parked ?? newDraft(nextSeat(s.players, saved.seat));
  const latest = newestFast(hands, mode)?.id === saved.id;
  return { ...s, draft: latest ? withSeat(back, nextSeat(s.players, saved.seat), s.players) : back, parked: null };
}

/** A saved hand opened in the editor (되돌리기, or tapped in the list): the new hand on screen is put aside. Only a hand still just a 빠른 기록, of the mode's kind. */
export function startEdit(s: FastState, h: LoggedHand, mode: FastMode = "mine"): FastState {
  if (!fastOnly(h) || !kindFits(h, mode)) return s;
  return { ...s, draft: draftOf(h), parked: s.draft.editing ? s.parked : s.draft };
}

/** Back to the new hand put aside (the corrected hand stays as it was saved). */
export function cancelEdit(s: FastState): FastState {
  return { ...s, draft: s.parked ?? newDraft(buttonSeat(s.players)), parked: null };
}

/** The hands `ids` were deleted: a correction of one of them gives way to the new hand put aside. The same state otherwise. */
export function forgetHands(s: FastState, ids: Iterable<string>): FastState {
  const gone = new Set(ids);
  return s.draft.editing && gone.has(s.draft.editing) ? cancelEdit(s) : s;
}

/**
 * The stage and table size set on one of the two screens, for the other one too (both are the same
 * table): its new hand moves to the button only if its seat isn't at a table that size. A hand being
 * corrected keeps its own.
 */
export function shareTable(s: FastState, stage: PreStage, players: number): FastState {
  if (!isSize(players)) return s;
  const fit = (d: FastDraft) => (d.editing ? d : withSeat(d, positionsFor(players).includes(d.seat) ? d.seat : buttonSeat(players), players));
  return { ...s, stage, players, draft: fit(s.draft), parked: s.parked ? fit(s.parked) : null };
}

// ───────────── stored state ─────────────

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const isSize = (x: unknown): x is number => typeof x === "number" && TABLE_SIZES.includes(x);

function cleanDraft(x: unknown, players: number): FastDraft {
  const r = obj(x);
  const editing = typeof r.editing === "string" && r.editing ? r.editing : null;
  const own = editing && isSize(r.players) ? r.players : null;
  const n = own ?? players;
  const seat = typeof r.seat === "string" && positionsFor(n).includes(r.seat) ? r.seat : buttonSeat(n);
  const ranks = (Array.isArray(r.ranks) ? r.ranks : []).filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 12).slice(0, 2);
  const suited = ranks.length === 2 && ranks[0] !== ranks[1] && typeof r.suited === "boolean" ? r.suited : null;
  const d = withSpot({ seat, ranks, suited, spot: "none", opener: null, editing }, isFastSpot(r.spot) ? r.spot : "none");
  const withOpener = typeof r.opener === "string" ? { ...d, opener: r.opener } : d;
  const placed = withSeat(withOpener, seat, n);
  return { ...placed, ...(editing && isStage(r.stage) ? { stage: r.stage } : {}), ...(own ? { players: own } : {}) };
}

/** The stored editor state with valid fields only; `stage` and `size` are the fallbacks for a first visit. */
export function cleanFastState(x: unknown, stage: PreStage = "mid", size = 9): FastState {
  const r = obj(x);
  const players = isSize(r.players) ? r.players : isSize(size) ? size : 9;
  const draft = cleanDraft(r.draft ?? {}, players);
  const parked = r.parked && draft.editing ? cleanDraft(r.parked, players) : null;
  return { stage: isStage(r.stage) ? r.stage : stage, players, draft, parked: parked && !parked.editing ? parked : null };
}

// ───────────── today's hands ─────────────

/** A pause this long between two 빠른 기록 hands ends a session. */
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
/** The newest hand this long ago: no session is on. */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

/**
 * Today's session: the 빠른 기록 hands of the mode's kind (mine, or other players') back from the newest
 * until a 6-hour pause, newest first; none if the newest is over 12 hours old.
 */
export function sessionOf(hands: LoggedHand[], now: number, mode: FastMode = "mine"): LoggedHand[] {
  const fast = hands.filter((h) => h.fast === true && kindFits(h, mode)).sort((a, b) => b.createdAt - a.createdAt);
  if (!fast.length || now - fast[0].createdAt > SESSION_IDLE_MS) return [];
  const out = [fast[0]];
  for (let i = 1; i < fast.length && out[out.length - 1].createdAt - fast[i].createdAt <= SESSION_GAP_MS; i++) out.push(fast[i]);
  return out;
}

export interface FastStats {
  total: number;
  by: Record<VerdictKind, number>;
  /** Hands with a chart for the spot (all but 차트 없음). */
  graded: number;
  /** 차트대로 out of `graded`, 0~100, null with none graded. */
  okPct: number | null;
}

export function fastStats(hands: LoggedHand[]): FastStats {
  const by: Record<VerdictKind, number> = { ok: 0, mixed: 0, over: 0, under: 0, none: 0 };
  for (const h of hands) by[fastVerdictOf(h)?.kind ?? "none"]++;
  const graded = hands.length - by.none;
  return { total: hands.length, by, graded, okPct: graded ? Math.round((by.ok / graded) * 100) : null };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** One hand as a line: "21:05 미들 CO K9o 오픈 ⚠ 오버플레이 (차트: 폴드)" (another player's: "⚠ 차트보다 루즈 (차트: 폴드)"). */
export function fastLineText(h: LoggedHand): string {
  const v = fastVerdictOf(h);
  const stage = h.quickPre?.stage ? STAGE_LABEL[h.quickPre.stage] : "";
  const act = fastActText(h);
  // A walk says so once.
  return [clock(h.createdAt), stage, h.seat, holeClass(h), act, v && v.text !== act ? v.text : ""].filter(Boolean).join(" ");
}

/**
 * "오늘 요약 복사": the session in short text, overplays and underplays first, for asking Claude later. In
 * "other" mode the hands are other players' (남의 핸드): looser and tighter than the chart first.
 */
export function sessionText(hands: LoggedHand[], mode: FastMode = "mine"): string {
  if (!hands.length) return "";
  const s = fastStats(hands);
  const other = mode === "other";
  const [over, under] = other ? ["차트보다 루즈", "차트보다 타이트"] : ["오버플레이", "언더플레이"];
  const old = [...hands].sort((a, b) => a.createdAt - b.createdAt);
  const day = new Date(old[0].createdAt).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  const lines = [
    other ? `PubAJ 남의 핸드 · ${day} · ${s.total}핸드 (펍 토너먼트에서 본 다른 사람 핸드, 펍아재 차트 기준)` : `PubAJ 빠른 기록 · ${day} · ${s.total}핸드 (펍 토너먼트, 펍아재 차트 기준)`,
    `차트대로 ${s.by.ok}/${s.graded}${s.okPct !== null ? ` (${s.okPct}%)` : ""} · 섞는 핸드 ${s.by.mixed} · ${over} ${s.by.over} · ${under} ${s.by.under} · 차트 없음 ${s.by.none}`,
  ];
  const kind = (k: VerdictKind) => old.filter((h) => fastVerdictOf(h)?.kind === k);
  for (const [k, title] of [["over", over], ["under", under]] as const) {
    const xs = kind(k);
    if (xs.length) lines.push("", `[${title}]`, ...xs.map((h) => `- ${fastLineText(h)}`));
  }
  lines.push("", "[전체 · 시간순]", ...old.map((h, i) => `${i + 1}. ${fastLineText(h)}`));
  return lines.join("\n");
}

/** The verdict mark for a list row ("–" for a hand without one). */
export const markOf = (h: LoggedHand): string => VERDICT_MARK[fastVerdictOf(h)?.kind ?? "none"];
