/**
 * Pure helpers for the solver chart viewer: board textures, report rows (sort, filter, weighted average),
 * action colors, routes and number formatting. No DOM, no React; tested in view.test.ts.
 */
import { ALL_HANDS, RANKS, SUITS, SUIT_SYMBOL, rankOf, suitOf, type Card, type HandClass } from "../../poker/cards";
import { COMBOS } from "../../play/handInfo";
import {
  parseBoardKey,
  type DecodedFlop,
  type DecodedNode,
  type FileEntry,
  type PackAction,
  type PackEntry,
  type ScenarioMeta,
} from "../../presolve/format";
import type { ActionKind, Player } from "../../solver/types";

// ───────────────────────── formatting ─────────────────────────

/** 0.613 → "61%" (digits = 0) or "61.3%". Non-finite → "–". */
export function pct(x: number, digits = 0): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "–";
}

/** Chip amounts: at most `digits` decimals, no trailing zeros (5.5, 97.5, 1.82 → "1.8"). */
export function fmtBb(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return "–";
  const m = 10 ** digits;
  const r = Math.round(x * m) / m;
  return String(Object.is(r, -0) ? 0 : r);
}

/** EV in bb with two decimals; NaN → "–". */
export function fmtEv(x: number): string {
  if (!Number.isFinite(x)) return "–";
  const s = x.toFixed(2);
  return s === "-0.00" ? "0.00" : s;
}

export function formatName(meta: ScenarioMeta): string {
  return meta.format === "cash" ? "캐시 6맥스" : "펍 토너먼트";
}

/** Starting stack from the id suffix ("srp-btn-bb-100" → 100), else null. */
export function startStack(packId: string): number | null {
  const m = /-(\d+)$/.exec(packId);
  return m ? Number(m[1]) : null;
}

export function playerName(meta: ScenarioMeta, p: Player): string {
  return meta.positions[p] ?? (p === 0 ? "OOP" : "IP");
}

// ───────────────────────── boards and textures ─────────────────────────

export type SuitTexture = "rainbow" | "twotone" | "monotone";
export type HighCard = "A" | "K" | "Q" | "J" | "T" | "low";

export interface Texture {
  suits: SuitTexture;
  /** At least two cards share a rank (trips included). */
  paired: boolean;
  trips: boolean;
  high: HighCard;
  /** Three distinct ranks inside a five-rank window (a straight is possible with two hole cards). */
  connected: boolean;
}

export function boardTexture(cards: Card[]): Texture {
  const flop = cards.slice(0, 3);
  const suitCounts = [0, 0, 0, 0];
  for (const c of flop) suitCounts[suitOf(c)]++;
  const maxSuit = Math.max(...suitCounts);
  const ranks = flop.map(rankOf).sort((a, b) => b - a);
  const distinct = [...new Set(ranks)];
  const top = ranks[0];
  const high: HighCard = top >= 8 ? (RANKS[top] as HighCard) : "low";
  let connected = false;
  if (distinct.length === 3) {
    const span = (rs: number[]) => Math.max(...rs) - Math.min(...rs);
    // The ace also plays low (A-2-3, A-3-5, ...).
    const low = distinct.map((r) => (r === 12 ? -1 : r));
    connected = span(distinct) <= 4 || span(low) <= 4;
  }
  return {
    suits: maxSuit === 3 ? "monotone" : maxSuit === 2 ? "twotone" : "rainbow",
    paired: distinct.length < ranks.length,
    trips: distinct.length === 1,
    high,
    connected,
  };
}

export function textureOfKey(key: string): Texture {
  return boardTexture(parseBoardKey(key));
}

const SUIT_LABEL: Record<SuitTexture, string> = { rainbow: "레인보우", twotone: "투톤", monotone: "모노톤" };

/** Short Korean tags for a board, e.g. ["레인보우", "A 하이"] or ["투톤", "페어드", "커넥티드"]. */
export function textureTags(t: Texture): string[] {
  const tags = [SUIT_LABEL[t.suits]];
  if (t.trips) tags.push("트립스");
  else if (t.paired) tags.push("페어드");
  if (t.connected) tags.push("커넥티드");
  tags.push(t.high === "low" ? "9 이하" : `${t.high} 하이`);
  return tags;
}

export type ChipGroup = "suit" | "pair" | "conn" | "high";

export interface TextureChip {
  id: string;
  group: ChipGroup;
  label: string;
  test: (t: Texture) => boolean;
}

export const TEXTURE_CHIPS: readonly TextureChip[] = [
  { id: "rainbow", group: "suit", label: "레인보우", test: (t) => t.suits === "rainbow" },
  { id: "twotone", group: "suit", label: "투톤", test: (t) => t.suits === "twotone" },
  { id: "monotone", group: "suit", label: "모노톤", test: (t) => t.suits === "monotone" },
  { id: "paired", group: "pair", label: "페어드", test: (t) => t.paired },
  { id: "unpaired", group: "pair", label: "언페어드", test: (t) => !t.paired },
  { id: "connected", group: "conn", label: "커넥티드", test: (t) => t.connected },
  { id: "high-A", group: "high", label: "A 하이", test: (t) => t.high === "A" },
  { id: "high-K", group: "high", label: "K 하이", test: (t) => t.high === "K" },
  { id: "high-Q", group: "high", label: "Q 하이", test: (t) => t.high === "Q" },
  { id: "high-J", group: "high", label: "J 하이", test: (t) => t.high === "J" },
  { id: "high-T", group: "high", label: "T 하이", test: (t) => t.high === "T" },
  { id: "high-low", group: "high", label: "9 이하", test: (t) => t.high === "low" },
];

/** Chips in the same group are alternatives (OR); different groups must all hold (AND). No chips = everything. */
export function matchesTexture(t: Texture, selected: readonly string[]): boolean {
  const byGroup = new Map<ChipGroup, boolean>();
  for (const id of selected) {
    const chip = TEXTURE_CHIPS.find((c) => c.id === id);
    if (!chip) continue;
    byGroup.set(chip.group, (byGroup.get(chip.group) ?? false) || chip.test(t));
  }
  for (const ok of byGroup.values()) if (!ok) return false;
  return true;
}

export function toggleChip(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Card text for screen readers and titles: "A♠ K♥ 7♦". */
export function cardsText(cards: Card[]): string {
  return cards.map((c) => RANKS[rankOf(c)] + SUIT_SYMBOL[SUITS[suitOf(c)]]).join(" ");
}

// ───────────────────────── actions and colors ─────────────────────────

export const isAggressive = (kind: ActionKind): boolean => kind === "bet" || kind === "raise" || kind === "allin";

/** One fixed color per passive action kind; bets and raises get a warm color by size; all-in is dark red. */
export const KIND_COLOR: Record<"fold" | "check" | "call" | "allin", string> = {
  fold: "#5b6b80",
  check: "#22c55e",
  call: "#38bdf8",
  allin: "#9b1c2c",
};

/** Bet / raise colors from small to large: amber, orange, red, crimson. */
export const SIZE_COLORS = ["#f4a62a", "#f97316", "#ef4444", "#d6336c"] as const;

/** Size bucket of a bet or raise as a share of the pot: ≤ 40%, ≤ 70%, ≤ 110%, overbet. */
export function sizeBucket(frac: number): number {
  return frac <= 0.4 ? 0 : frac <= 0.7 ? 1 : frac <= 1.1 ? 2 : 3;
}

interface NodeChips {
  pot: number;
  bets: [number, number];
  player: Player;
}

/**
 * A bet's or raise's size as a share of the pot: a bet's amount over the pot, a raise's increment over the pot
 * after calling (the solver's raise convention). Without the node, a "벳 33%" label is read instead. null when unknown.
 */
export function actionFraction(a: Pick<PackAction, "kind" | "label"> & { to?: number }, node?: NodeChips): number | null {
  if (a.kind !== "bet" && a.kind !== "raise") return null;
  if (node && a.to !== undefined && node.pot > 0) {
    const my = node.bets[node.player];
    const maxBet = Math.max(node.bets[0], node.bets[1]);
    if (a.kind === "bet") return (a.to - my) / node.pot;
    const toCall = maxBet - my;
    return (a.to - maxBet) / (node.pot + toCall);
  }
  const m = /(\d+(?:\.\d+)?)%/.exec(a.label);
  return m ? Number(m[1]) / 100 : null;
}

/**
 * Colors for a node's actions, in order. Passive kinds and all-in have fixed colors; each bet or raise gets a size
 * color, and within one node every bet/raise gets a different (strictly warmer) color than the one before it.
 */
export function actionColors(actions: (Pick<PackAction, "kind" | "label"> & { to?: number })[], node?: NodeChips): string[] {
  let prev = -1;
  return actions.map((a) => {
    if (a.kind === "fold" || a.kind === "check" || a.kind === "call" || a.kind === "allin") return KIND_COLOR[a.kind];
    const frac = actionFraction(a, node);
    let b = frac === null ? prev + 1 : sizeBucket(frac);
    if (b <= prev) b = prev + 1;
    b = Math.min(b, SIZE_COLORS.length - 1);
    prev = b;
    return SIZE_COLORS[b];
  });
}

/** Horizontal color bands for a frequency mix, e.g. for a grid cell. Empty mix → null. */
export function mixGradient(freq: number[], colors: string[]): string | null {
  const total = freq.reduce((s, x) => s + (x > 0 ? x : 0), 0);
  if (!(total > 0)) return null;
  const stops: string[] = [];
  let at = 0;
  freq.forEach((f, a) => {
    if (!(f > 0)) return;
    const w = (f / total) * 100;
    const end = a === freq.length - 1 ? 100 : at + w;
    stops.push(`${colors[a]} ${round2(at)}% ${round2(Math.min(100, end))}%`);
    at += w;
  });
  if (stops.length === 1) return colors[freq.findIndex((f) => f > 0)];
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Index of the largest finite value (first on ties), −1 when there is none. */
export function argMax(xs: number[]): number {
  let best = -1;
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]) && (best < 0 || xs[i] > xs[best])) best = i;
  return best;
}

/**
 * EV differences up to this many bb at a node count as ties: EVs are stored in 0.01 bb steps and the solve is
 * a few tenths of a percent of the pot from equilibrium, where mixed actions have equal EVs.
 */
export function evTolerance(pot: number): number {
  return Math.max(0.05, 0.005 * pot);
}

/**
 * The action to mark as best: the highest EV, but actions within `tol` of it are tied and the most frequent of
 * them wins (then the higher EV, then the earlier action). −1 when no EV is known.
 */
export function bestAction(ev: number[], freq: number[], tol: number): number {
  const top = argMax(ev);
  if (top < 0) return -1;
  let best = top;
  for (let a = 0; a < ev.length; a++) {
    if (a === best || !Number.isFinite(ev[a]) || ev[a] < ev[top] - tol) continue;
    const fa = freq[a] ?? 0, fb = freq[best] ?? 0;
    if (fa > fb || (fa === fb && ev[a] > ev[best])) best = a;
  }
  return best;
}

// ───────────────────────── report ─────────────────────────

/** What a report column's number is: the share of bets, raises and all-ins, or the share of folds. */
export type ReportMetric = "bet" | "fold";

export interface ReportColumn {
  /** summaryNodes index of the decision. */
  node: number;
  player: Player;
  metric: ReportMetric;
  /** The decision in a few words, for the header: "첫 액션", "체크 받고", "vs 벳 33%". */
  context: string;
  /** For OOP's answer to an IP bet: that bet's label ("벳 33%"). */
  vs?: string;
}

export interface ReportColumns {
  /**
   * The OOP decisions the OOP column can show, in tree order: its first action when that includes a bet, then
   * its answer to each IP bet after checking (fold share). Never empty when the pack has a root node.
   */
  oop: ReportColumn[];
  /** IP's decision after OOP checks (bet share); null if missing. */
  ip: ReportColumn | null;
}

const samePath = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function reportColumns(pack: PackEntry): ReportColumns {
  const defs = pack.summaryNodes;
  const at = (path: number[]) => defs.findIndex((d) => samePath(d.path, path));
  const rootIdx = at([]);
  const root = defs[rootIdx];
  const checkIdx = root ? root.kinds.indexOf("check") : -1;
  const ipIdx = checkIdx < 0 ? -1 : at([checkIdx]);
  const ipDef = defs[ipIdx];
  const oop: ReportColumn[] = [];
  // A root without a bet (e.g. a tree where OOP only checks) says nothing; OOP's real decision is facing the c-bet.
  if (root && root.kinds.some(isAggressive)) oop.push({ node: rootIdx, player: root.player, metric: "bet", context: "첫 액션" });
  ipDef?.kinds.forEach((k, b) => {
    if (!isAggressive(k)) return;
    const n = at([checkIdx, b]);
    if (n >= 0 && defs[n].kinds.includes("fold"))
      oop.push({ node: n, player: defs[n].player, metric: "fold", context: `vs ${ipDef.labels[b]}`, vs: ipDef.labels[b] });
  });
  if (!oop.length && root) oop.push({ node: rootIdx, player: root.player, metric: "bet", context: "첫 액션" });
  return { oop, ip: ipDef ? { node: ipIdx, player: ipDef.player, metric: "bet", context: "체크 받고" } : null };
}

/** Share of a frequency row taken by bets, raises and all-ins. NaN for a missing row. */
export function betShare(freq: number[] | null | undefined, kinds: ActionKind[]): number {
  return shareOf(freq, kinds, "bet");
}

/** Share of a frequency row taken by the metric's action kinds. NaN for a missing row. */
export function shareOf(freq: number[] | null | undefined, kinds: ActionKind[], metric: ReportMetric): number {
  if (!freq) return NaN;
  let s = 0;
  freq.forEach((f, a) => {
    if (metric === "fold" ? kinds[a] === "fold" : isAggressive(kinds[a])) s += f;
  });
  return s;
}

export interface ReportRow {
  entry: FileEntry;
  board: Card[];
  texture: Texture;
  /** Frequency rows of the chosen OOP column's and the IP column's decisions. */
  oop: number[] | null;
  ip: number[] | null;
  /** The columns' numbers (their metric's share); NaN when missing. */
  oopStat: number;
  ipStat: number;
  /** OOP's raw equity share at the root. */
  equity: number;
  /** OOP's root EV (bb). */
  ev: number;
}

/** One row per file; the OOP column is `reportColumns(pack).oop[oopChoice]` (the first one when out of range). */
export function reportRows(pack: PackEntry, oopChoice = 0): ReportRow[] {
  const cols = reportColumns(pack);
  const oc = cols.oop[oopChoice] ?? cols.oop[0] ?? null;
  const ic = cols.ip;
  const kindsOf = (c: ReportColumn | null) => (c ? pack.summaryNodes[c.node].kinds : []);
  const rows: ReportRow[] = [];
  for (const entry of pack.files) {
    let board: Card[];
    try {
      board = parseBoardKey(entry.board);
    } catch {
      continue;
    }
    const oop = oc ? entry.summary.freq[oc.node] ?? null : null;
    const ip = ic ? entry.summary.freq[ic.node] ?? null : null;
    rows.push({
      entry,
      board,
      texture: boardTexture(board),
      oop,
      ip,
      oopStat: oc ? shareOf(oop, kindsOf(oc), oc.metric) : NaN,
      ipStat: ic ? shareOf(ip, kindsOf(ic), ic.metric) : NaN,
      equity: entry.summary.equity[0],
      ev: entry.summary.ev[0],
    });
  }
  return rows;
}

export type SortKey = "board" | "weight" | "oop" | "ip" | "equity";

export interface SortState {
  key: SortKey;
  desc: boolean;
}

/** High boards first (rank by rank), then rainbow < two-tone < monotone. */
export function compareBoards(a: Card[], b: Card[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = rankOf(b[i]) - rankOf(a[i]);
    if (d) return d;
  }
  const order: Record<SuitTexture, number> = { rainbow: 0, twotone: 1, monotone: 2 };
  return order[boardTexture(a).suits] - order[boardTexture(b).suits];
}

/** Sorted copy. Missing values (NaN) always go last; ties keep board order. */
export function sortRows(rows: readonly ReportRow[], sort: SortState): ReportRow[] {
  const val = (r: ReportRow): number =>
    sort.key === "weight" ? r.entry.weight : sort.key === "oop" ? r.oopStat : sort.key === "ip" ? r.ipStat : r.equity;
  return rows.slice().sort((x, y) => {
    if (sort.key === "board") return sort.desc ? compareBoards(x.board, y.board) : -compareBoards(x.board, y.board);
    const a = val(x), b = val(y);
    const na = Number.isNaN(a), nb = Number.isNaN(b);
    if (na || nb) return na === nb ? compareBoards(x.board, y.board) : na ? 1 : -1;
    return (sort.desc ? b - a : a - b) || compareBoards(x.board, y.board);
  });
}

export function filterRows(rows: readonly ReportRow[], chips: readonly string[]): ReportRow[] {
  return chips.length ? rows.filter((r) => matchesTexture(r.texture, chips)) : rows.slice();
}

/** A sort header tap: the same key flips direction, a new key starts descending (board starts high to low). */
export function nextSort(cur: SortState, key: SortKey): SortState {
  return cur.key === key ? { key, desc: !cur.desc } : { key, desc: true };
}

export interface ReportAverage {
  count: number;
  weight: number;
  oop: number[] | null;
  ip: number[] | null;
  oopStat: number;
  ipStat: number;
  equity: number;
  ev: number;
}

/** Weighted mean of a row field over the rows that have it. */
function wMean(rows: readonly ReportRow[], get: (r: ReportRow) => number): number {
  let s = 0, w = 0;
  for (const r of rows) {
    const v = get(r);
    if (!Number.isFinite(v)) continue;
    s += v * r.entry.weight;
    w += r.entry.weight;
  }
  return w > 0 ? s / w : NaN;
}

function wMeanRow(rows: readonly ReportRow[], get: (r: ReportRow) => number[] | null): number[] | null {
  let out: number[] | null = null;
  let w = 0;
  for (const r of rows) {
    const v = get(r);
    if (!v) continue;
    if (!out) out = new Array<number>(v.length).fill(0);
    if (v.length !== out.length) continue;
    v.forEach((x, i) => (out![i] += x * r.entry.weight));
    w += r.entry.weight;
  }
  return out && w > 0 ? out.map((x) => x / w) : null;
}

/** Averages over `rows` weighted by each file's `weight` (how many raw flops it stands for). */
export function weightedAverage(rows: readonly ReportRow[]): ReportAverage {
  return {
    count: rows.length,
    weight: rows.reduce((s, r) => s + r.entry.weight, 0),
    oop: wMeanRow(rows, (r) => r.oop),
    ip: wMeanRow(rows, (r) => r.ip),
    oopStat: wMean(rows, (r) => r.oopStat),
    ipStat: wMean(rows, (r) => r.ipStat),
    equity: wMean(rows, (r) => r.equity),
    ev: wMean(rows, (r) => r.ev),
  };
}

/** Suit-isomorphism classes of the flop (format.ts `flopClasses()`); a pack with fewer files maps the rest onto them. */
const FLOP_CLASSES = 1755;

/** What a file's `weight` counts besides the board itself, in Korean, for the report and the flop view. */
export function weightScope(pack: PackEntry): string {
  return pack.files.length < FLOP_CLASSES ? "수트만 다른 플랍과, 아직 계산 안 된 비슷한 플랍 포함" : "수트만 다른 플랍 포함";
}

/** Weighted average frequency row of one summary node (`PackEntry.summaryNodes` index) over `rows`. */
export function averageNodeFreq(rows: readonly ReportRow[], node: number): number[] | null {
  return wMeanRow(rows, (r) => r.entry.summary.freq[node] ?? null);
}

// ───────────────────────── lines and nodes ─────────────────────────

export interface LineStep {
  /** Path of the node where the action was taken. */
  at: number[];
  player: Player;
  who: string;
  action: PackAction;
}

/** The actions along `path` as far as the stored nodes go. */
export function lineSteps(flop: DecodedFlop, path: number[], meta: ScenarioMeta): LineStep[] {
  const out: LineStep[] = [];
  for (let i = 0; i < path.length; i++) {
    const node = flop.node(path.slice(0, i));
    const action = node?.actions[path[i]];
    if (!node || !action) break;
    out.push({ at: path.slice(0, i), player: node.player, who: playerName(meta, node.player), action });
  }
  return out;
}

/** "BB 체크 → BTN 벳 33%"; the empty line is "플랍 시작". */
export function describeLine(flop: DecodedFlop, path: number[], meta: ScenarioMeta): string {
  const steps = lineSteps(flop, path, meta);
  return steps.length ? steps.map((s) => `${s.who} ${s.action.label}`).join(" → ") : "플랍 시작";
}

export type PathTarget =
  | { kind: "node"; node: DecodedNode }
  /** The line ends the flop (fold, street end, all-in run-out, showdown) or its next node isn't stored. */
  | { kind: "end"; parent: DecodedNode; action: PackAction; index: number }
  | { kind: "invalid" };

/** What a route path points at: a stored node, the end of the flop after the last action, or nothing valid. */
export function resolvePath(flop: DecodedFlop, path: number[]): PathTarget {
  const node = flop.node(path);
  if (node) return { kind: "node", node };
  if (!path.length) return { kind: "invalid" };
  const parent = flop.node(path.slice(0, -1));
  const index = path[path.length - 1];
  const action = parent?.actions[index];
  if (!parent || !action) return { kind: "invalid" };
  return { kind: "end", parent, action, index };
}

/** Where an action leads, for the sub-label of its button. */
export function nextHint(action: PackAction, childStored: boolean, meta: ScenarioMeta, actor: Player): string {
  switch (action.next) {
    case "action":
      return childStored ? `→ ${playerName(meta, (1 - actor) as Player)} 결정` : "저장 안 됨";
    case "street":
      return "→ 턴";
    case "fold":
      return "핸드 종료";
    case "showdown":
      return "쇼다운";
    case "allin-runout":
      return "올인 런아웃";
  }
}

/** Effective stack behind at a node. */
export function effectiveStack(node: { stacks: [number, number] }): number {
  return Math.min(node.stacks[0], node.stacks[1]);
}

/** Chips the actor must add to call (0 when not facing a bet). */
export function toCall(node: { bets: [number, number]; player: Player }): number {
  return Math.max(0, Math.max(node.bets[0], node.bets[1]) - node.bets[node.player]);
}

// ───────────────────────── ranges by hand class ─────────────────────────

/** Combos of each hand class that don't touch the board. */
export function unblockedCounts(board: Card[]): Record<HandClass, number> {
  const dead = new Set(board);
  const out = {} as Record<HandClass, number>;
  for (const h of ALL_HANDS) out[h] = 0;
  for (const { cards, hand } of COMBOS) if (!dead.has(cards[0]) && !dead.has(cards[1])) out[hand]++;
  return out;
}

export interface ClassWeight {
  /** Unblocked combos of the class. */
  combos: number;
  /** Σ weight over those combos. */
  weight: number;
  /** weight / combos (0..1). */
  frac: number;
}

/** A COMBOS-indexed range summarized per hand class (all 169). */
export function rangeByClass(weights: ArrayLike<number>, board: Card[]): Record<HandClass, ClassWeight> {
  const counts = unblockedCounts(board);
  const dead = new Set(board);
  const sums = {} as Record<HandClass, number>;
  for (const h of ALL_HANDS) sums[h] = 0;
  COMBOS.forEach(({ cards, hand }, i) => {
    if (!dead.has(cards[0]) && !dead.has(cards[1])) sums[hand] += weights[i] > 0 ? weights[i] : 0;
  });
  const out = {} as Record<HandClass, ClassWeight>;
  for (const h of ALL_HANDS) out[h] = { combos: counts[h], weight: sums[h], frac: counts[h] ? sums[h] / counts[h] : 0 };
  return out;
}

/** Σ weights (combos in range, counting partial weights). */
export function rangeSize(weights: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < weights.length; i++) if (weights[i] > 0) s += weights[i];
  return s;
}

// ───────────────────────── routes ─────────────────────────

export interface SolverRoute {
  packId?: string;
  board?: string;
  path: number[];
  /** The path segment was present but not a list of action indices. */
  badPath: boolean;
}

/** "srp-btn-bb-100/AsKh7d/0.1" → { packId, board, path: [0, 1] } (the part after "solver/"). */
export function parseRoute(sub: string): SolverRoute {
  const [packId = "", board = "", p = ""] = sub.split("/");
  let path: number[] = [];
  let badPath = false;
  if (p) {
    const parts = p.split(".");
    if (parts.every((x) => /^\d{1,2}$/.test(x))) path = parts.map(Number);
    else badPath = true;
  }
  return { packId: packId || undefined, board: board || undefined, path, badPath };
}

export function routeOf(packId?: string, board?: string, path: number[] = []): string {
  if (!packId) return "solver";
  if (!board) return `solver/${packId}`;
  return path.length ? `solver/${packId}/${board}/${path.join(".")}` : `solver/${packId}/${board}`;
}
