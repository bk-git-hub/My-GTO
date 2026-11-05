import { cardLabel, handClassOf, type Card } from "../../poker/cards";
import { createStore } from "../../state/store";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
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

/** 9-handed pub seats. */
export const LOG_SEATS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

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
}

interface LogState {
  hands: LoggedHand[];
  /** Level and table size of the last saved hand, so the next entry starts there. */
  lastLevel: number | null;
  lastPlayers?: number;
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
  const ok = handLogStore.set({ hands, lastLevel: h.level ?? prev.lastLevel, lastPlayers: h.players });
  if (!ok) handLogStore.set(prev);
  else requestPersistence();
  return ok;
}

export function deleteHand(id: string): void {
  handLogStore.set((s) => ({ ...s, hands: s.hands.filter((h) => h.id !== id) }));
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
  };
}

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
  if (loaded.hands.some((h) => !Array.isArray(h.steps) || !h.stacks || !h.actions || typeof h.players !== "number")) {
    handLogStore.set({ ...loaded, hands: loaded.hands.map((h) => sanitize(h)).filter((h): h is LoggedHand => h !== null) });
  }
}
