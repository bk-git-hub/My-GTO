import { cardLabel, handClassOf, type Card } from "../../poker/cards";
import { createStore } from "../../state/store";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import { actedPreflop, cleanPre, isStage, knownStage, preHasInfo, shoveCap, STAGE_LABEL, summaryOf, summaryOfGame, summaryText, tidyPre, type PreStage, type QuickPre } from "./quickPre";
import { amountLabel, positionsFor, POSITIONS, replay, streetLines, type LogStep, type StepKind, type TableInput } from "./recorder";

/**
 * Hands the user played at the pub, kept in this browser's localStorage only
 * (no server, no cost). Export/import as a JSON file is the backup.
 */

export type Result = "win" | "lose" | "chop" | "fold";
export const RESULT_LABEL: Record<Result, string> = { win: "이김", lose: "짐", chop: "찹", fold: "폴드" };

export const LOG_STREETS = ["preflop", "flop", "turn", "river"] as const;
export type LogStreet = (typeof LOG_STREETS)[number];
export const LOG_STREET_LABEL: Record<LogStreet, string> = { preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버" };

/** What an opponent showed down. */
export interface ShowdownNote {
  /** Nickname for the player ("빨간모자"), "" if unknown. */
  name: string;
  seat: string;
  cards: Card[];
  /** What they did with it: "올인 콜", "3벳" ... */
  did: string;
}

export interface LoggedHand {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Players dealt in (2~10). */
  players: number;
  /** The BB posts a BB-sized ante. */
  bbAnte: boolean;
  /** Blind level number (BLIND_LEVELS), null if not entered. */
  level: number | null;
  seat: string;
  hole: Card[];
  /** My chips at the start of the hand. */
  stack: number | null;
  note: string;
  result: Result | null;
  /** Chips won (+) or lost (−). */
  net: number | null;
  board: Card[];
  /** Every seat's actions, replayed through the play engine (see recorder.ts). */
  steps: LogStep[];
  /** Starting stacks in bb for seats that differ from mine. */
  stacks: Record<string, number>;
  /** Free-text notes per street (older hands were recorded this way). */
  actions: Record<LogStreet, string>;
  showdowns: ShowdownNote[];
  /** Jotted on the quick-record screen: it opens there again until actions are recorded on the table. */
  quick?: boolean;
  /**
   * The quick screen's preflop block (stage, my action, the open). Kept when the hand is carried on to
   * the table, where it becomes the first steps; from then on the steps are the record.
   */
  quickPre?: QuickPre;
}

interface LogState {
  hands: LoggedHand[];
  /** Level and table size of the last saved hand, so the next entry starts there. */
  lastLevel: number | null;
  lastPlayers?: number;
  /** Stack stage of the last hand that told one (tapped, or from its stack), for the quick screen's preflop block. */
  lastStage?: PreStage;
}

export const handLogStore = createStore<LogState>("mygto.handlog", { hands: [], lastLevel: null });

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function emptyHand(level: number | null = handLogStore.get().lastLevel): LoggedHand {
  const now = Date.now();
  return {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    players: handLogStore.get().lastPlayers ?? 9,
    bbAnte: true,
    level,
    seat: "",
    hole: [],
    stack: null,
    note: "",
    result: null,
    net: null,
    board: [],
    steps: [],
    stacks: {},
    actions: { preflop: "", flop: "", turn: "", river: "" },
    showdowns: [],
  };
}

export const emptyShowdown = (): ShowdownNote => ({ name: "", seat: "", cards: [], did: "" });

/** Something worth saving was entered. */
export function hasContent(h: LoggedHand): boolean {
  return h.hole.length > 0 || h.note.trim() !== "" || h.board.length > 0 || h.showdowns.length > 0 || h.steps.length > 0;
}

/**
 * A saved hand still holds something worth keeping: cards, a note or table actions, or, for a quick
 * hand, its seat, stack or result too (so clearing its cards to type them again doesn't drop the rest).
 */
export function worthKeeping(h: LoggedHand): boolean {
  return hasContent(h) || (h.quick === true && (h.seat !== "" || h.stack !== null || h.result !== null || preHasInfo(h.quickPre)));
}

/**
 * The card field holds cards that can be kept: it is clean (`cardsClean`: no typo or half-typed card,
 * otherwise `hole` is an older parse than what is on screen) and holds two cards or none. One card isn't a hand.
 */
const cardsUsable = (h: LoggedHand, cardsClean: boolean) => cardsClean && h.hole.length !== 1;

/**
 * What a quick hand on screen puts on file. While the card field is mid-edit (a typo, a half-typed card,
 * one card alone) its cards don't count: the ones on file stand in (none for a new hand), so the seat,
 * stack, result and note are still kept.
 */
export function quickCopy(stored: LoggedHand | null, shown: LoggedHand, cardsClean: boolean): LoggedHand {
  return cardsUsable(shown, cardsClean) ? shown : { ...shown, hole: stored ? stored.hole : [] };
}

/** Why a quick hand with nothing on file isn't saved yet, or null when it can be. */
export function memoBlocker(h: LoggedHand, cardsClean: boolean): string | null {
  if (hasContent(quickCopy(null, h, cardsClean))) return null;
  return cardsUsable(h, cardsClean) ? "카드 두 장이나 메모를 넣으면 바로 저장돼요" : "카드 두 장을 맞게 넣으면 저장돼요";
}

export type QuickSave = "none" | "save" | "delete";

/**
 * What the quick-record screen does with an edit: `stored` is the copy on file (null if none), `shown`
 * what the screen shows; a save writes quickCopy(stored, shown, cardsClean). A new hand is saved the
 * moment it has two clean cards or a note, and every later edit goes to the same hand, even while the
 * card field is mid-edit (the last good cards stay on file then). It is deleted only once nothing worth
 * keeping is left in it (untouched hands are never stored).
 */
export function quickSaveAction(stored: LoggedHand | null, shown: LoggedHand, cardsClean: boolean): QuickSave {
  const keep = quickCopy(stored, shown, cardsClean);
  if (!stored) return hasContent(keep) ? "save" : "none";
  if (!worthKeeping(keep)) return "delete";
  return sameHand(stored, keep) ? "none" : "save";
}

/**
 * Nothing on the quick screen is waiting to be written: it shows exactly the hand on file (or, with none
 * on file, nothing worth saving), so it can be left for the next hand or the table without losing an edit.
 */
export function quickSettled(stored: LoggedHand | null, shown: LoggedHand, cardsClean: boolean): boolean {
  if (!cardsClean) return false;
  return stored ? sameHand(stored, shown) : !hasContent(shown);
}

/** The same hand apart from when it was last saved (so re-checking an unchanged hand writes nothing). */
function sameHand(a: LoggedHand, b: LoggedHand): boolean {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  keys.delete("updatedAt");
  for (const k of keys) if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) return false;
  return true;
}

/**
 * A hand jotted on the quick-record screen with nothing recorded on the table yet (no actions, board
 * or showdowns): it opens on the quick screen again, which shows everything it holds.
 */
export function isQuickHand(h: LoggedHand): boolean {
  return h.quick === true && h.steps.length === 0 && h.board.length === 0 && h.showdowns.length === 0;
}

/** Where a saved hand opens: the quick screen for a quick hand, the table flow for the rest. */
export const handRoute = (h: LoggedHand): string => (isQuickHand(h) ? `log/quick/${h.id}` : `log/${h.id}`);

export type LogView =
  | { kind: "new" }
  | { kind: "list" }
  | { kind: "players" }
  /** `id`: the saved quick hand to continue; null for a new one. */
  | { kind: "quick"; id: string | null }
  | { kind: "edit"; id: string };

/**
 * The screen a "#log/…" route shows: "" a new hand on the table, "list", "players", "quick" a new quick
 * hand, "quick/<id>" a quick hand to finish, "<id>" a hand on the table.
 */
export function logView(sub: string, hands: LoggedHand[]): LogView {
  if (sub === "" || sub === "new") return { kind: "new" };
  if (sub === "list" || sub === "players") return { kind: sub };
  if (sub === "quick") return { kind: "quick", id: null };
  if (sub.startsWith("quick/")) {
    const id = sub.slice("quick/".length);
    const h = hands.find((x) => x.id === id);
    // Recorded on the table since: it opens there. Deleted meanwhile: a new quick hand.
    if (h && !isQuickHand(h)) return { kind: "edit", id };
    return { kind: "quick", id: h ? id : null };
  }
  return { kind: "edit", id: sub };
}

/** Board, street actions, showdowns or a chip result were filled in. */
export function hasDetail(h: LoggedHand): boolean {
  return (
    h.board.length > 0 ||
    h.steps.length > 0 ||
    h.showdowns.length > 0 ||
    h.net !== null ||
    LOG_STREETS.some((s) => h.actions[s].trim() !== "")
  );
}

/** Insert or update a hand. Returns false if the browser refused to store it (storage full). */
export function saveHand(h: LoggedHand): boolean {
  const prev = handLogStore.get();
  const saved: LoggedHand = { ...h, updatedAt: Date.now() };
  const others = prev.hands.filter((x) => x.id !== h.id);
  const hands = [saved, ...others].sort((a, b) => b.createdAt - a.createdAt);
  const ok = handLogStore.set({ hands, lastLevel: h.level ?? prev.lastLevel, lastPlayers: h.players, ...stageMemo(h, prev) });
  if (!ok) handLogStore.set(prev);
  else requestPersistence();
  return ok;
}

export function deleteHand(id: string): void {
  handLogStore.set((s) => ({ ...s, hands: s.hands.filter((h) => h.id !== id) }));
}

/** Keep the level, table size and stack stage of a hand not saved yet, so the next new hand starts there too. */
export function rememberSetup(h: Pick<LoggedHand, "level" | "players"> & Partial<Pick<LoggedHand, "stack" | "quickPre">>): void {
  const s = handLogStore.get();
  const lastLevel = h.level ?? s.lastLevel;
  const memo = stageMemo(h, s);
  if (s.lastLevel !== lastLevel || s.lastPlayers !== h.players || memo.lastStage !== s.lastStage) handLogStore.set({ ...s, lastLevel, lastPlayers: h.players, ...memo });
}

/** The stage to remember after this hand: the one it tells (tapped, or from its stack), else the one before. */
function stageMemo(h: Pick<LoggedHand, "level"> & Partial<Pick<LoggedHand, "stack" | "quickPre">>, s: LogState): { lastStage?: PreStage } {
  const stage = knownStage(h.quickPre, stackBb({ stack: h.stack ?? null, level: h.level })) ?? lastStage(s);
  return stage ? { lastStage: stage } : {};
}

/**
 * A quick hand after an edit, its preflop block kept in step with the rest (see tidyPre): an unpinned
 * stage follows the stack, an opener must be another seat at this table, an empty block goes away.
 */
export function tidyQuick(h: LoggedHand, last: PreStage | null = lastStage()): LoggedHand {
  const { quickPre: was, ...rest } = h;
  const quickPre = tidyPre(was, { bb: stackBb(h), seats: positionsFor(h.players), seat: h.seat, last });
  if (quickPre ? JSON.stringify(quickPre) === JSON.stringify(was) : !("quickPre" in h)) return h;
  return quickPre ? { ...rest, quickPre } : rest;
}

/** The stack stage last used, if any (a stored value that isn't one is ignored). */
export function lastStage(s: LogState = handLogStore.get()): PreStage | null {
  return isStage(s.lastStage) ? s.lastStage : null;
}

// ───────────── resuming ─────────────

export type HandProgress = "setup" | "hand" | LogStreet | "done";

/** How far the recording got: the first missing piece, the street the action is on, or done. */
export function handProgress(h: LoggedHand): HandProgress {
  if (!h.seat) return "setup";
  if (h.hole.length < 2) return "hand";
  const { game } = replay(tableOf(h), h.steps);
  return game.done ? "done" : game.street;
}

export const PROGRESS_LABEL: Record<HandProgress, string> = { setup: "테이블", hand: "핸드", ...LOG_STREET_LABEL, done: "끝" };

/** A hand left mid-way this long ago is no longer offered for resuming. */
export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * The hand to offer "이어서 기록" for: the most recently edited hand with something in it,
 * if it has no result yet, its action isn't over, and it was touched within the last 12 hours.
 */
export function resumable(hands: LoggedHand[], now: number): LoggedHand | null {
  let last: LoggedHand | null = null;
  for (const h of hands) if (hasContent(h) && (!last || h.updatedAt > last.updatedAt)) last = h;
  if (!last || now - last.updatedAt > RESUME_WINDOW_MS) return null;
  if (last.result !== null || last.net !== null) return null;
  return handProgress(last) === "done" ? null : last;
}

/** A hand left with "＋ 새 핸드" on purpose: not offered for resuming again this session. */
let asideId: string | null = null;
export function putAside(id: string): void {
  asideId = id;
}

/** The hand the new-hand screen offers to pick up again, if any. */
export function resumeOffer(hands: LoggedHand[], now: number): LoggedHand | null {
  const r = resumable(hands, now);
  return r && r.id !== asideId ? r : null;
}

let persistAsked = false;
/** Ask the browser not to evict our storage under pressure (best effort, no prompt on most browsers). */
function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* not supported */
  }
}

// ───────────── formatting ─────────────

export function levelInfo(level: number | null): { sb: number; bb: number } | null {
  const row = BLIND_LEVELS.find(([lv]) => lv === level);
  return row ? { sb: row[1], bb: row[2] } : null;
}

export function levelLabel(level: number | null): string {
  const info = levelInfo(level);
  return info ? `Lv${level} · ${info.sb.toLocaleString()}/${info.bb.toLocaleString()}` : "레벨 모름";
}

/** My stack in big blinds, if both the stack and the level are known. */
export function stackBb(h: Pick<LoggedHand, "stack" | "level">): number | null {
  const info = levelInfo(h.level);
  if (!info || h.stack === null || !(h.stack > 0)) return null;
  return Math.round((h.stack / info.bb) * 10) / 10;
}

export const cardsText = (cs: Card[]) => cs.map(cardLabel).join(" ");

/** The recorder's view of this hand's table. */
export function tableOf(h: LoggedHand): TableInput {
  return { heroSeat: h.seat, heroStack: stackBb(h), stacks: h.stacks, seats: positionsFor(h.players), bbAnte: h.bbAnte };
}

/** Board cards dealt on a street (flop 3, turn 1, river 1). */
export function streetBoard(board: Card[], street: string): Card[] {
  if (street === "flop") return board.slice(0, 3);
  if (street === "turn") return board.slice(3, 4);
  if (street === "river") return board.slice(4, 5);
  return [];
}

/** My all-in this hand as a preflop street total in bb (see shoveCap), if my stack is known. */
export const shoveBb = (h: LoggedHand): number | null => shoveCap(stackBb(h), h.seat, h.bbAnte);

/**
 * The hand's preflop is still what the quick block says: no table steps, or only the seats before me
 * (the folds the block filled in, when my own action didn't fit the table).
 */
function blockSays(h: LoggedHand): boolean {
  return !!h.quickPre && (!h.steps.length || !actedPreflop(replay(tableOf(h), h.steps).game, h.seat));
}

/**
 * The preflop as one line for the past hands ("CO 2.5bb 오픈 → 콜"), for a hand jotted with the quick
 * screen's preflop block: from the block, or once the table has my own preflop action, from the table.
 * The stage leads when the hand has no stack in bb to show ("숏 · CO 올인").
 */
export function quickPreLine(h: LoggedHand): string {
  if (!h.quickPre) return "";
  if (!blockSays(h)) {
    const s = summaryOfGame(replay(tableOf(h), h.steps).game, h.seat, shoveBb(h));
    return s ? summaryText(s) : "";
  }
  const s = summaryOf(h.quickPre, h.seat, shoveBb(h));
  const stage = stackBb(h) === null && h.quickPre.stage ? STAGE_LABEL[h.quickPre.stage] : "";
  return [stage, s ? summaryText(s) : ""].filter(Boolean).join(" · ");
}

export function holeText(cs: Card[]): string {
  if (cs.length === 2) return `${cardsText(cs)} (${handClassOf(cs[0], cs[1])})`;
  return cs.length ? cardsText(cs) : "모름";
}

/** Plain-text summary for the AI coach. */
export function handFacts(h: LoggedHand): string {
  const bb = stackBb(h);
  const info = levelInfo(h.level);
  const lines = [
    "게임: 홀덤펍 토너먼트 · 9인 · BB 앤티(BB가 BB 금액만큼 앤티) · 시작 50,000 · 사용자가 실제로 친 핸드를 기록한 것",
    `레벨: ${levelLabel(h.level)}`,
    `내 자리: ${h.seat || "모름"} · 내 핸드: ${holeText(h.hole)}`,
    `내 스택: ${h.stack !== null ? `${h.stack.toLocaleString()}칩` : "모름"}${bb !== null ? ` (${bb}bb)` : ""}`,
  ];
  if (h.board.length) lines.push(`보드: ${cardsText(h.board)}`);
  if (h.quickPre && blockSays(h)) {
    const s = summaryOf(h.quickPre, h.seat, shoveBb(h));
    const stage = h.quickPre.stage ? `${STAGE_LABEL[h.quickPre.stage]} 구간` : "";
    lines.push(`프리플랍 (빠른 기록, 금액은 bb): ${[stage, s ? summaryText(s) : ""].filter(Boolean).join(" · ")}`);
  }
  if (h.steps.length) {
    const t = tableOf(h);
    const others = Object.entries(h.stacks).filter(([seat]) => seat !== h.seat);
    const both = (bb: number) => (info ? `${amountLabel(bb, info.bb)}(${Math.round(bb * 10) / 10}bb)` : amountLabel(bb, null));
    lines.push(
      `시작 스택: 다른 자리는 ${t.heroStack === null ? "모름(100bb로 가정)" : "나와 같음"}${others.length ? `, 예외 ${others.map(([seat, bb]) => `${seat} ${both(bb)}`).join(", ")}` : ""}`,
      "액션 기록 (금액은 그 스트리트에서 낸 총액, 언급 없는 자리는 폴드):",
    );
    const { game } = replay(t, h.steps);
    for (const l of streetLines(game, both)) {
      const cards = streetBoard(h.board, l.street);
      lines.push(`- ${LOG_STREET_LABEL[l.street as LogStreet]}${cards.length ? ` [${cardsText(cards)}]` : ""}: ${l.actions.join(", ") || "액션 없음"} → 팟 ${both(l.pot)}`);
    }
  }
  for (const st of LOG_STREETS) if (h.actions[st].trim()) lines.push(`${LOG_STREET_LABEL[st]} 메모: ${h.actions[st].trim()}`);
  for (const sd of h.showdowns) {
    const who = [sd.name.trim() || "상대", sd.seat].filter(Boolean).join(" ");
    lines.push(`쇼다운: ${who} ${sd.cards.length ? holeText(sd.cards) : "카드 모름"}${sd.did.trim() ? ` — ${sd.did.trim()}` : ""}`);
  }
  const result = [h.result ? RESULT_LABEL[h.result] : "", h.net !== null ? `${h.net > 0 ? "+" : ""}${h.net.toLocaleString()}칩${info && h.net ? ` (${h.net > 0 ? "+" : ""}${Math.round((h.net / info.bb) * 10) / 10}bb)` : ""}` : ""]
    .filter(Boolean)
    .join(" ");
  if (result) lines.push(`결과: ${result}`);
  if (h.note.trim()) lines.push(`메모: ${h.note.trim()}`);
  return lines.join("\n");
}

// ───────────── opponents ─────────────

export interface VillainEntry {
  hand: LoggedHand;
  showdown: ShowdownNote;
}

/** Showdowns grouped by opponent nickname, most-seen first. Unnamed ones go under "이름 없음". */
export function villainBook(hands: LoggedHand[]): { name: string; entries: VillainEntry[] }[] {
  const byName = new Map<string, VillainEntry[]>();
  for (const hand of hands) {
    for (const showdown of hand.showdowns) {
      const name = showdown.name.trim() || "이름 없음";
      byName.set(name, [...(byName.get(name) ?? []), { hand, showdown }]);
    }
  }
  return [...byName.entries()]
    .map(([name, entries]) => ({ name, entries }))
    .sort((a, b) => (a.name === "이름 없음" ? 1 : b.name === "이름 없음" ? -1 : b.entries.length - a.entries.length));
}

export function knownNames(hands: LoggedHand[]): string[] {
  return [...new Set(hands.flatMap((h) => h.showdowns.map((s) => s.name.trim())).filter(Boolean))].sort();
}

// ───────────── backup ─────────────

/** File marker. Keeps the app's old name (PubAZ) so earlier backups still import. */
const EXPORT_KIND = "pubaz-hand-log";

export function exportData(hands: LoggedHand[]): string {
  return JSON.stringify({ kind: EXPORT_KIND, version: 1, exportedAt: new Date().toISOString(), hands }, null, 1);
}

const isCard = (x: unknown): x is Card => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 52;
const cardList = (x: unknown, max: number): Card[] => (Array.isArray(x) ? x.filter(isCard).slice(0, max) : []);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Coerce one imported record into a LoggedHand, or null if it has no usable id. */
function sanitize(x: unknown): LoggedHand | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const created = num(r.createdAt) ?? Date.now();
  const actions = (r.actions && typeof r.actions === "object" ? r.actions : {}) as Record<string, unknown>;
  const result = str(r.result);
  const players = num(r.players);
  const size = players !== null && POSITIONS[players] ? players : 9;
  const seats = new Set(positionsFor(size));
  return {
    id,
    createdAt: created,
    updatedAt: num(r.updatedAt) ?? created,
    players: size,
    bbAnte: typeof r.bbAnte === "boolean" ? r.bbAnte : true,
    level: num(r.level),
    seat: str(r.seat),
    hole: cardList(r.hole, 2),
    stack: num(r.stack),
    note: str(r.note),
    result: result in RESULT_LABEL ? (result as Result) : null,
    net: num(r.net),
    board: cardList(r.board, 5),
    steps: (Array.isArray(r.steps) ? r.steps : []).flatMap((x): LogStep[] => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const k = str(o.k) as StepKind;
      if (!seats.has(str(o.s)) || !["fold", "check", "call", "raise"].includes(k)) return [];
      const to = num(o.to);
      return [{ s: str(o.s), k, ...(to !== null ? { to } : {}), ...(o.a ? { a: 1 as const } : {}) }];
    }),
    stacks: Object.fromEntries(
      Object.entries(r.stacks && typeof r.stacks === "object" ? (r.stacks as Record<string, unknown>) : {}).filter(
        ([seat, v]) => seats.has(seat) && typeof v === "number" && v > 0,
      ),
    ) as Record<string, number>,
    actions: { preflop: str(actions.preflop), flop: str(actions.flop), turn: str(actions.turn), river: str(actions.river) },
    showdowns: (Array.isArray(r.showdowns) ? r.showdowns : []).map((s) => {
      const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      return { name: str(o.name), seat: str(o.seat), cards: cardList(o.cards, 2), did: str(o.did) };
    }),
    ...(r.quick === true ? { quick: true } : {}),
    ...withPre(cleanPre(r.quickPre, positionsFor(size))),
  };
}

const withPre = (quickPre: QuickPre | undefined) => (quickPre ? { quickPre } : {});

/**
 * Merge an exported file into the current hands. A hand already here is replaced
 * only if the file's copy was edited more recently. Throws with a readable message.
 */
export function mergeImport(text: string, current: LoggedHand[]): { hands: LoggedHand[]; added: number; updated: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("백업 파일을 읽을 수 없어요. PubAJ에서 내보낸 파일인지 확인해 주세요.");
  }
  const d = data as { kind?: unknown; hands?: unknown };
  if (!d || d.kind !== EXPORT_KIND || !Array.isArray(d.hands)) throw new Error("PubAJ 핸드 기록 백업 파일이 아니에요.");
  const byId = new Map(current.map((h) => [h.id, h]));
  let added = 0, updated = 0;
  for (const raw of d.hands) {
    const h = sanitize(raw);
    if (!h) continue;
    const mine = byId.get(h.id);
    if (!mine) added++;
    else if (h.updatedAt > mine.updatedAt) updated++;
    else continue;
    byId.set(h.id, h);
  }
  return { hands: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt), added, updated };
}

// Hands saved by an earlier version lack newer fields; fill them in once on load.
{
  const loaded = handLogStore.get();
  const preOff = (h: LoggedHand) => h.quickPre !== undefined && JSON.stringify(cleanPre(h.quickPre, positionsFor(h.players))) !== JSON.stringify(h.quickPre);
  if (loaded.hands.some((h) => !Array.isArray(h.steps) || !h.stacks || !h.actions || typeof h.players !== "number" || preOff(h))) {
    handLogStore.set({ ...loaded, hands: loaded.hands.map((h) => sanitize(h)).filter((h): h is LoggedHand => h !== null) });
  }
}
