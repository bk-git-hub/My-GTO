/**
 * Solver content packs: the files the presolve pipeline writes under public/packs/ and the app reads.
 * See docs/solver-packs.md for the layout and the meaning of every field.
 *
 * Pure TypeScript with no DOM or Node APIs: the same module runs in the pipeline (Node) and in the app.
 * Binary arrays travel as unpadded base64 strings inside JSON.
 */
import { ALL_HANDS, cardFromString, cardToString, makeCard, rankOf, suitOf, type Card, type HandClass } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import type { ActionKind, Player, SolverInput, SolverStreet, StreetSizes } from "../solver/types";

// ───────────────────────── constants ─────────────────────────

/** Format version of the manifest and of every flop file. */
export const PACK_FORMAT = 1;
export const NUM_COMBOS = 1326;
/** Unordered 3-card flops in a 52-card deck: C(52, 3). */
export const RAW_FLOPS = 22100;
/** Paths in the manifest are relative to this directory (served from public/packs/). */
export const PACKS_DIR = "packs/";
export const MANIFEST_PATH = "packs/manifest.json";
/** Quantized 1.0 for strategies, reach and range weights. */
export const Q_MAX = 255;
/** EVs are stored in units of 1 / EV_SCALE bb (centi-bb). */
export const EV_SCALE = 100;
/** Int16 value that stands for "no EV" (NaN). */
export const EV_NAN = -32768;
export const EV_MAX = 32767;
/** A combo set is a 1326-bit bitmap: 166 bytes, 222 base64 characters. */
export const COMBO_BITMAP_BYTES = Math.ceil(NUM_COMBOS / 8);

// ───────────────────────── manifest types ─────────────────────────

export type PackTier = "free" | "pro";
export type GameFormat = "cash" | "pub";

/** The solve settings shared by every flop of a pack. Enough to rebuild the exact game tree. */
export interface ScenarioMeta {
  format: GameFormat;
  /** Seat names [OOP, IP], e.g. ["BB", "BTN"]. */
  positions: [string, string];
  /** Short Korean description of the preflop action, e.g. "BTN 2.5bb 오픈, BB 콜". */
  preflop?: string;
  /** Chips in the middle at the start of the flop (bb), dead money included. */
  pot: number;
  /** Effective stack behind at the start of the flop (bb). */
  stack: number;
  /** Bet and raise sizes per street, [OOP, IP]. All three streets are written out. */
  sizes: Record<SolverStreet, [StreetSizes, StreetSizes]>;
  raiseLimit: number;
  addAllIn: boolean;
  allInThreshold: number;
  minBet: number;
  /** Iteration cap per flop solve. */
  iterations: number;
  /** Exploitability target per flop solve (% of pot). */
  targetExploitability: number;
  /** Starting ranges [OOP, IP] in the src/poker/range.ts syntax ("22+, A2s+, KTo:0.5"). */
  ranges: [string, string];
  /**
   * Where the ranges came from, as chart refs "<set>/<stage>/<scenario>:<action>", e.g. "cash6/100bb/bb-vs-btn:call".
   * A calibration pack may name a solver stage the app doesn't ship yet (its ranges are in src/presolve/calRanges.ts).
   */
  rangeSources?: [string, string];
  /** Which flops the pack covers, e.g. "all-1755" or "subset-95". */
  flopSet?: string;
  /**
   * Calibration packs only: every hand class starts with at least this weight in both ranges (ghost combos, so hands
   * outside the source ranges get a measured EV). A class at exactly this weight is outside its source range.
   */
  ghostWeight?: number;
}

/** A node shown in every file's summary. The game tree is the same on every flop of a pack. */
export interface SummaryNodeDef {
  path: number[];
  player: Player;
  labels: string[];
  kinds: ActionKind[];
}

/** Per-flop aggregate kept in the manifest, so reports don't need to download the flop file. */
export interface FlopSummary {
  /** Raw equity share of each range against the other at the root (both run out to the river); sums to 1. */
  equity: [number, number];
  /** Range-average expected net (bb) of each player at the root under the solved strategies; sums to the pot. */
  ev: [number, number];
  /**
   * Overall action frequencies (reach-weighted, rounded to 0.001), one row per `PackEntry.summaryNodes` entry,
   * in the same order. null when the node isn't stored or its actor never gets there.
   */
  freq: (number[] | null)[];
}

export interface FileEntry {
  /** Relative to PACKS_DIR, e.g. "srp-btn-bb-100/v1/flop-AsKh7d.json". The file at a path never changes. */
  path: string;
  /** Lowercase hex sha256 of the exact file bytes. */
  sha256: string;
  bytes: number;
  /** Canonical board key (see `canonicalBoard`). */
  board: string;
  /** How many of the 22100 raw flops this file stands for (its suit-isomorphism class, plus any flops mapped onto it). */
  weight: number;
  /** % of pot. */
  exploitability: number;
  summary: FlopSummary;
}

export interface PackEntry {
  /** Scenario id, e.g. "srp-btn-bb-100". Lowercase words joined by "-". */
  id: string;
  title: string;
  /** Integer ≥ 1. New content of a pack is written under v<version>/. */
  version: number;
  tier: PackTier;
  scenario: ScenarioMeta;
  /** Nodes summarized in every `FileEntry.summary.freq` (the flop root and its first responses). */
  summaryNodes: SummaryNodeDef[];
  /** Git commit of src/solver that produced this version (lets the presolve job notice a solver change). */
  solverCommit?: string;
  files: FileEntry[];
}

export interface Manifest {
  v: 1;
  /** ISO 8601 time of the run that wrote this manifest. */
  generatedAt?: string;
  packs: PackEntry[];
}

// ───────────────────────── flop file types ─────────────────────────

/** What follows an action: another flop decision, the end of the street (turn comes), or the end of the hand. */
export type ChildKind = "action" | "street" | "fold" | "showdown" | "allin-runout";

export interface PackAction {
  kind: ActionKind;
  /** The actor's total bet on the street after the action (bb). 0 for fold and check. */
  to: number;
  label: string;
  next: ChildKind;
}

/** A COMBOS-indexed weight array: the set of combos with weight > 0, and their weights (Uint8, 255 = 1). */
export interface EncodedRange {
  combos: string;
  weights: string;
}

export interface FlopNode {
  /** Action indices from the flop root ([] = root, [0] = after OOP's first action, ...). */
  path: number[];
  player: Player;
  /** Chips in the middle, this street's bets included. */
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  actions: PackAction[];
  /** The actor's combos stored here (in range, not blocked by the board, reach > 0), as a bitmap. */
  combos: string;
  /** One Uint8 array per action, aligned with `combos`; each combo's values sum to 255. */
  strategy: string[];
  /**
   * One Int16 LE array per action, aligned with `combos`: the actor's EV (centi-bb, net from the start of the flop)
   * after taking the action. null for a fold: the value is the same for every combo, −(stack − stacks[player]).
   * EV_NAN marks a combo with no EV.
   */
  ev: (string | null)[];
  /** The actor's reach here relative to its starting weight (Uint8, 255 = 1), aligned with `combos`. Absent = all 1. */
  reach?: string;
}

export interface FlopFile {
  v: 1;
  /** Pack (scenario) id. */
  scenario: string;
  /** Pack version this file was written for. */
  version: number;
  /** Canonical board key. */
  board: string;
  pot: number;
  stack: number;
  iterations: number;
  /** % of pot. */
  exploitability: number;
  /** Starting ranges [OOP, IP], board-blocked combos removed. */
  ranges: [EncodedRange, EncodedRange];
  /** Flop action nodes. Prefix-closed: every stored node's parent is stored too. */
  nodes: FlopNode[];
}

// ───────────────────────── decoded types ─────────────────────────

export interface DecodedNode {
  path: number[];
  player: Player;
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  actions: PackAction[];
  /** COMBOS indices, ascending. */
  combos: Uint16Array;
  /** [action][i]: probability; each combo's values sum to exactly 1 when added in action order. */
  strategy: Float64Array[];
  /** [action][i]: the actor's EV (bb) after taking the action; NaN where unknown. */
  ev: Float32Array[];
  /** Reach relative to the starting weight (0..1), aligned with `combos`. */
  reach: Float32Array;
  /** Absolute reach: starting weight × relative reach, aligned with `combos`. */
  weight: Float32Array;
}

export interface DecodedFlop {
  scenario: string;
  version: number;
  board: Card[];
  boardKey: string;
  pot: number;
  stack: number;
  iterations: number;
  exploitability: number;
  /** Starting weights [OOP, IP], COMBOS-indexed. */
  ranges: [Float32Array, Float32Array];
  nodes: DecodedNode[];
  /** The stored node at `path`, or undefined. */
  node(path: number[]): DecodedNode | undefined;
}

// ───────────────────────── base64 and binary arrays ─────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 alphabet, no "=" padding. */
export function encodeBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64[v >> 18], B64[(v >> 12) & 63], B64[(v >> 6) & 63], B64[v & 63]);
  }
  if (n - i === 1) {
    const v = bytes[i] << 16;
    out.push(B64[v >> 18], B64[(v >> 12) & 63]);
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(B64[v >> 18], B64[(v >> 12) & 63], B64[(v >> 6) & 63]);
  }
  return out.join("");
}

/** Accepts padded or unpadded standard base64. */
export function decodeBase64(s: string): Uint8Array {
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61 /* = */) len--;
  if (len % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) throw new Error(`invalid base64 character at ${i}`);
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Values are rounded and clamped to 0..255. */
export function encodeUint8(values: ArrayLike<number>): string {
  const b = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(values[i]);
    b[i] = v > 255 ? 255 : v > 0 ? v : 0;
  }
  return encodeBase64(b);
}

export function decodeUint8(s: string): Uint8Array {
  return decodeBase64(s);
}

/** Little-endian Int16. Values are rounded and clamped to −32768..32767 (NaN becomes EV_NAN). */
export function encodeInt16(values: ArrayLike<number>): string {
  const b = new Uint8Array(values.length * 2);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < values.length; i++) {
    const r = Math.round(values[i]);
    dv.setInt16(i * 2, Number.isNaN(r) ? EV_NAN : r > 32767 ? 32767 : r < -32768 ? -32768 : r, true);
  }
  return encodeBase64(b);
}

export function decodeInt16(s: string): Int16Array {
  const b = decodeBase64(s);
  if (b.length % 2) throw new Error("Int16 data has an odd byte count");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Int16Array(b.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** A set of COMBOS indices as a 1326-bit bitmap (bit i = byte i >> 3, bit i & 7, LSB first). Order and duplicates don't matter. */
export function encodeCombos(indices: ArrayLike<number>): string {
  const b = new Uint8Array(COMBO_BITMAP_BYTES);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (!Number.isInteger(i) || i < 0 || i >= NUM_COMBOS) throw new Error(`combo index out of range: ${i}`);
    b[i >> 3] |= 1 << (i & 7);
  }
  return encodeBase64(b);
}

/** Ascending COMBOS indices. */
export function decodeCombos(s: string): Uint16Array {
  const b = decodeBase64(s);
  if (b.length !== COMBO_BITMAP_BYTES) throw new Error(`combo bitmap must be ${COMBO_BITMAP_BYTES} bytes, got ${b.length}`);
  let n = 0;
  for (let i = 0; i < NUM_COMBOS; i++) if (b[i >> 3] & (1 << (i & 7))) n++;
  const out = new Uint16Array(n);
  let k = 0;
  for (let i = 0; i < NUM_COMBOS; i++) if (b[i >> 3] & (1 << (i & 7))) out[k++] = i;
  return out;
}

// ───────────────────────── quantization ─────────────────────────

/**
 * Per combo, turns action probabilities into integers 0..255 that sum to exactly 255 (largest remainder;
 * ties go to the lower action index). `strategy[a][i]` is action a's probability for combo i. Each combo is
 * normalized first; a combo with no positive probability becomes uniform.
 */
export function quantizeStrategy(strategy: ArrayLike<number>[]): Uint8Array[] {
  const A = strategy.length;
  const n = A ? strategy[0].length : 0;
  for (const s of strategy) if (s.length !== n) throw new Error("strategy arrays differ in length");
  const out = Array.from({ length: A }, () => new Uint8Array(n));
  const frac = new Float64Array(A);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let a = 0; a < A; a++) {
      const p = strategy[a][i];
      if (p > 0 && Number.isFinite(p)) sum += p;
    }
    let left = Q_MAX;
    for (let a = 0; a < A; a++) {
      const p = strategy[a][i];
      const x = sum > 0 ? (p > 0 && Number.isFinite(p) ? (p / sum) * Q_MAX : 0) : Q_MAX / A;
      const f = Math.min(Q_MAX, Math.floor(x));
      out[a][i] = f;
      frac[a] = x - f;
      left -= f;
    }
    while (left > 0) {
      let best = 0;
      for (let a = 1; a < A; a++) if (frac[a] > frac[best]) best = a;
      out[best][i]++;
      frac[best] = -1;
      left--;
    }
  }
  return out;
}

/**
 * Inverse of quantizeStrategy. Each combo's probabilities are q / Σq, except the last nonzero action, which
 * gets 1 minus the others, so adding them in action order gives exactly 1. A combo whose values are all 0
 * becomes uniform.
 */
export function dequantize(q: ArrayLike<number>[]): Float64Array[] {
  const A = q.length;
  const n = A ? q[0].length : 0;
  for (const s of q) if (s.length !== n) throw new Error("strategy arrays differ in length");
  const out = Array.from({ length: A }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    let total = 0, last = -1;
    for (let a = 0; a < A; a++) {
      total += q[a][i];
      if (q[a][i] > 0) last = a;
    }
    if (total <= 0) {
      for (let a = 0; a < A; a++) out[a][i] = 1 / A;
      continue;
    }
    let s = 0;
    for (let a = 0; a < A; a++) {
      if (a === last) continue;
      const p = q[a][i] / total;
      out[a][i] = p;
      s += p;
    }
    out[last][i] = 1 - s;
  }
  return out;
}

/** A 0..1 value (range weight, relative reach) as 0..255; anything above 0 stays at least 1. */
export function quantizeUnit(x: number): number {
  if (!(x > 0)) return 0;
  return Math.max(1, Math.min(Q_MAX, Math.round(x * Q_MAX)));
}

/** EV in bb → centi-bb Int16 value; NaN → EV_NAN; clamped to ±EV_MAX (±327.67 bb). */
export function quantizeEv(bb: number): number {
  if (Number.isNaN(bb)) return EV_NAN;
  const v = Math.round(bb * EV_SCALE);
  return v > EV_MAX ? EV_MAX : v < -EV_MAX ? -EV_MAX : v;
}

export function dequantizeEv(q: number): number {
  return q === EV_NAN ? NaN : q / EV_SCALE;
}

/** Chip amounts in pack files are rounded to 0.001 bb. */
export function roundChips(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ───────────────────────── cards, boards, combos ─────────────────────────

const sortBoard = (cards: Card[]): Card[] => cards.slice().sort((x, y) => rankOf(y) - rankOf(x) || suitOf(x) - suitOf(y));

/** Board key: cards from high rank to low, equal ranks in suit order s h d c, e.g. "AhKd7c", "KsKh7d". */
export function boardKey(cards: Card[]): string {
  if (new Set(cards).size !== cards.length) throw new Error("board has a repeated card");
  return sortBoard(cards).map(cardToString).join("");
}

/** Inverse of boardKey: 3 to 5 distinct cards, and the key must already be in canonical order. */
export function parseBoardKey(key: string): Card[] {
  if (!/^([2-9TJQKA][shdc]){3,5}$/.test(key)) throw new Error(`invalid board key: ${key}`);
  const cards: Card[] = [];
  for (let i = 0; i < key.length; i += 2) cards.push(cardFromString(key.slice(i, i + 2)));
  if (boardKey(cards) !== key) throw new Error(`board key not in canonical order: ${key}`);
  return cards;
}

const SUIT_PERMS: number[][] = (() => {
  const out: number[][] = [];
  const rec = (p: number[]) => {
    if (p.length === 4) return void out.push(p);
    for (let s = 0; s < 4; s++) if (!p.includes(s)) rec([...p, s]);
  };
  rec([]);
  return out;
})();

/**
 * The suit-isomorphic representative of a board: of the 24 suit relabelings, the one whose sorted cards
 * (rank high to low, then suit) have the smallest suit sequence. Rainbow AK7 → "AsKh7d", monotone → all spades.
 * `suitMap[rawSuit]` is the canonical suit; map a combo with `mapComboSuits(i, suitMap)` to find its row.
 */
export function canonicalBoard(cards: Card[]): { cards: Card[]; key: string; suitMap: number[] } {
  let best: Card[] | null = null;
  let bestPerm = SUIT_PERMS[0];
  for (const perm of SUIT_PERMS) {
    const mapped = sortBoard(cards.map((c) => makeCard(rankOf(c), perm[suitOf(c)])));
    if (best === null) {
      best = mapped;
      continue;
    }
    for (let i = 0; i < mapped.length; i++) {
      const d = suitOf(mapped[i]) - suitOf(best[i]);
      if (d < 0) {
        best = mapped;
        bestPerm = perm;
      }
      if (d !== 0) break;
    }
  }
  const out = best ?? [];
  return { cards: out, key: boardKey(out), suitMap: bestPerm.slice() };
}

export interface FlopClass {
  key: string;
  cards: Card[];
  /** Raw flops in this suit-isomorphism class. */
  weight: number;
}

let flopClassCache: readonly FlopClass[] | null = null;

/** The 1755 suit-isomorphism classes of flops, high boards first; weights sum to 22100. */
export function flopClasses(): readonly FlopClass[] {
  if (flopClassCache) return flopClassCache;
  const m = new Map<string, FlopClass>();
  for (let a = 0; a < 52; a++)
    for (let b = a + 1; b < 52; b++)
      for (let c = b + 1; c < 52; c++) {
        const { key, cards } = canonicalBoard([a, b, c]);
        const e = m.get(key);
        if (e) e.weight++;
        else m.set(key, { key, cards, weight: 1 });
      }
  const list = [...m.values()].sort((x, y) => {
    for (let i = 0; i < 3; i++) {
      const d = rankOf(y.cards[i]) - rankOf(x.cards[i]) || suitOf(x.cards[i]) - suitOf(y.cards[i]);
      if (d) return d;
    }
    return 0;
  });
  flopClassCache = list;
  return list;
}

const COMBO_AT = (() => {
  const t = new Int16Array(52 * 52).fill(-1);
  COMBOS.forEach(({ cards: [a, b] }, i) => {
    t[a * 52 + b] = i;
    t[b * 52 + a] = i;
  });
  return t;
})();

/** COMBOS index of a two-card hand (either order). */
export function comboIndex(a: Card, b: Card): number {
  const i = a >= 0 && a < 52 && b >= 0 && b < 52 ? COMBO_AT[a * 52 + b] : -1;
  if (i < 0) throw new Error(`not a combo: ${a}, ${b}`);
  return i;
}

/** "AhKd", "AsAh": the cards of COMBOS[index] as stored there (higher rank first). */
export function comboString(index: number): string {
  const [a, b] = COMBOS[index].cards;
  return cardToString(a) + cardToString(b);
}

/** The combo with each suit replaced by suitMap[suit]. */
export function mapComboSuits(index: number, suitMap: number[]): number {
  const [a, b] = COMBOS[index].cards;
  return comboIndex(makeCard(rankOf(a), suitMap[suitOf(a)]), makeCard(rankOf(b), suitMap[suitOf(b)]));
}

export function invertSuitMap(suitMap: number[]): number[] {
  const inv = [0, 0, 0, 0];
  suitMap.forEach((to, from) => (inv[to] = from));
  return inv;
}

// ───────────────────────── paths ─────────────────────────

const SCENARIO_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** "srp-btn-bb-100/v1/flop-AsKh7d.json", relative to PACKS_DIR. */
export function packFilePath(scenarioId: string, version: number, board: string | Card[]): string {
  if (!SCENARIO_ID.test(scenarioId)) throw new Error(`invalid scenario id: ${scenarioId}`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`invalid pack version: ${version}`);
  const key = typeof board === "string" ? boardKey(parseBoardKey(board)) : boardKey(board);
  return `${scenarioId}/v${version}/flop-${key}.json`;
}

/** Map key of a node path: "" for the root, "0.2" for action 0 then action 2. */
export function pathKey(path: number[]): string {
  return path.join(".");
}

const comparePaths = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

// ───────────────────────── ranges and nodes ─────────────────────────

const deadMask = (board: Card[]): Uint8Array => {
  const m = new Uint8Array(52);
  for (const c of board) m[c] = 1;
  return m;
};

/** COMBOS-indexed weights (0..1) → EncodedRange. Combos touching `board` are dropped. */
export function encodeRange(weights: ArrayLike<number>, board: Card[] = []): EncodedRange {
  if (weights.length !== NUM_COMBOS) throw new Error(`range needs ${NUM_COMBOS} weights`);
  const dead = deadMask(board);
  const idx: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < NUM_COMBOS; i++) {
    const [a, b] = COMBOS[i].cards;
    if (!(weights[i] > 0) || dead[a] || dead[b]) continue;
    idx.push(i);
    w.push(quantizeUnit(weights[i]));
  }
  return { combos: encodeCombos(idx), weights: encodeUint8(w) };
}

/** EncodedRange → COMBOS-indexed weights (0..1). */
export function decodeRange(r: EncodedRange): Float32Array {
  const idx = decodeCombos(r.combos);
  const w = decodeUint8(r.weights);
  if (w.length !== idx.length) throw new Error("range weights don't match its combos");
  const out = new Float32Array(NUM_COMBOS);
  for (let j = 0; j < idx.length; j++) out[idx[j]] = w[j] / Q_MAX;
  return out;
}

/** What the pipeline hands to encodeFlopNode for one node. Per-combo inputs are COMBOS-indexed (like SolutionNode). */
export interface FlopNodeSource {
  path: number[];
  player: Player;
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  actions: PackAction[];
  /** The actor's starting weights (0 for board-blocked combos). */
  start: ArrayLike<number>;
  /** The actor's absolute reach at this node (SolutionNode.ranges[player]). */
  reach: ArrayLike<number>;
  /** Per action (SolutionNode.strategy). */
  strategy: ArrayLike<number>[];
  /** Per action, the actor's EV (bb) after taking it (the child's SolutionNode.ev[player]). Ignored for folds; may be null there. */
  ev: (ArrayLike<number> | null)[];
  /** Drop combos whose relative reach is below this. Default 0.5 / 255 (they would quantize to 0). */
  minReach?: number;
}

export function encodeFlopNode(src: FlopNodeSource): FlopNode {
  const A = src.actions.length;
  if (src.strategy.length !== A || src.ev.length !== A) throw new Error("strategy and ev need one entry per action");
  const minReach = src.minReach ?? 0.5 / Q_MAX;
  const idx: number[] = [];
  const reachQ: number[] = [];
  for (let i = 0; i < NUM_COMBOS; i++) {
    const s = src.start[i];
    if (!(s > 0)) continue;
    const r = Math.min(1, src.reach[i] / s);
    if (!(r > 0) || r < minReach) continue;
    idx.push(i);
    reachQ.push(quantizeUnit(r));
  }
  const strategy = quantizeStrategy(src.strategy.map((arr) => idx.map((i) => arr[i])));
  const ev = src.actions.map((a, k) => {
    if (a.kind === "fold") return null;
    const arr = src.ev[k];
    if (!arr) throw new Error(`action ${k} (${a.label}) needs an EV array`);
    return encodeInt16(idx.map((i) => quantizeEv(arr[i])));
  });
  const node: FlopNode = {
    path: src.path.slice(),
    player: src.player,
    pot: roundChips(src.pot),
    bets: [roundChips(src.bets[0]), roundChips(src.bets[1])],
    stacks: [roundChips(src.stacks[0]), roundChips(src.stacks[1])],
    actions: src.actions.map((a) => ({ kind: a.kind, to: roundChips(a.to), label: a.label, next: a.next })),
    combos: encodeCombos(idx),
    strategy: strategy.map(encodeUint8),
    ev,
  };
  if (reachQ.some((q) => q !== Q_MAX)) node.reach = encodeUint8(reachQ);
  return node;
}

/** `stack` is the file's starting stack (for fold EVs); `start` the actor's starting weights (for `weight`). */
export function decodeFlopNode(node: FlopNode, stack: number, start?: ArrayLike<number>): DecodedNode {
  const combos = decodeCombos(node.combos);
  const n = combos.length;
  const A = node.actions.length;
  if (node.strategy.length !== A || node.ev.length !== A) throw new Error(`node ${pathKey(node.path)}: one strategy and ev entry per action`);
  const q = node.strategy.map(decodeUint8);
  for (const s of q) if (s.length !== n) throw new Error(`node ${pathKey(node.path)}: strategy length ≠ combos`);
  const strategy = dequantize(q);
  const foldEv = 0 - roundChips(stack - node.stacks[node.player]); // 0 - x keeps 0 from turning into -0
  const ev = node.ev.map((s) => {
    const out = new Float32Array(n);
    if (s === null) return out.fill(foldEv);
    const raw = decodeInt16(s);
    if (raw.length !== n) throw new Error(`node ${pathKey(node.path)}: ev length ≠ combos`);
    for (let j = 0; j < n; j++) out[j] = dequantizeEv(raw[j]);
    return out;
  });
  const reach = new Float32Array(n).fill(1);
  if (node.reach !== undefined) {
    const r = decodeUint8(node.reach);
    if (r.length !== n) throw new Error(`node ${pathKey(node.path)}: reach length ≠ combos`);
    for (let j = 0; j < n; j++) reach[j] = r[j] / Q_MAX;
  }
  const weight = new Float32Array(n);
  for (let j = 0; j < n; j++) weight[j] = (start ? start[combos[j]] : 1) * reach[j];
  return {
    path: node.path.slice(),
    player: node.player,
    pot: node.pot,
    bets: [node.bets[0], node.bets[1]],
    stacks: [node.stacks[0], node.stacks[1]],
    actions: node.actions.map((a) => ({ ...a })),
    combos,
    strategy,
    ev,
    reach,
    weight,
  };
}

export function decodeFlopFile(file: FlopFile): DecodedFlop {
  if (file.v !== PACK_FORMAT) throw new Error(`unsupported pack file version ${file.v}`);
  const board = parseBoardKey(file.board);
  const ranges: [Float32Array, Float32Array] = [decodeRange(file.ranges[0]), decodeRange(file.ranges[1])];
  const nodes = file.nodes.map((n) => decodeFlopNode(n, file.stack, ranges[n.player]));
  const byPath = new Map(nodes.map((n) => [pathKey(n.path), n] as const));
  return {
    scenario: file.scenario,
    version: file.version,
    board,
    boardKey: file.board,
    pot: file.pot,
    stack: file.stack,
    iterations: file.iterations,
    exploitability: file.exploitability,
    ranges,
    nodes,
    node: (path) => byPath.get(pathKey(path)),
  };
}

/** Structural checks on a flop file. Returns the problems found (empty = valid). */
export function validateFlopFile(file: FlopFile): string[] {
  const errs: string[] = [];
  if (file.v !== PACK_FORMAT) errs.push(`v must be ${PACK_FORMAT}`);
  if (!SCENARIO_ID.test(file.scenario)) errs.push(`invalid scenario id ${file.scenario}`);
  let dead: Uint8Array = new Uint8Array(52);
  try {
    const board = parseBoardKey(file.board);
    if (board.length !== 3) errs.push("board must be a flop");
    dead = deadMask(board);
  } catch (e) {
    errs.push((e as Error).message);
  }
  if (!(file.pot > 0) || !(file.stack >= 0)) errs.push("pot must be > 0 and stack ≥ 0");
  const inRange: [Set<number>, Set<number>] = [new Set(), new Set()];
  file.ranges.forEach((r, p) => {
    try {
      const w = decodeRange(r);
      w.forEach((x, i) => {
        if (x > 0) {
          inRange[p].add(i);
          const [a, b] = COMBOS[i].cards;
          if (dead[a] || dead[b]) errs.push(`range ${p}: ${comboString(i)} touches the board`);
        }
      });
    } catch (e) {
      errs.push(`range ${p}: ${(e as Error).message}`);
    }
  });
  const byPath = new Map<string, FlopNode>();
  for (const node of file.nodes) {
    const key = pathKey(node.path);
    if (byPath.has(key)) errs.push(`duplicate node ${key}`);
    byPath.set(key, node);
  }
  if (!byPath.has("")) errs.push("missing root node");
  for (const node of file.nodes) {
    const key = pathKey(node.path);
    const at = `node "${key}"`;
    if (node.path.length) {
      const parent = byPath.get(pathKey(node.path.slice(0, -1)));
      const via = parent?.actions[node.path[node.path.length - 1]];
      if (!parent) errs.push(`${at}: parent not stored`);
      else if (!via) errs.push(`${at}: parent has no such action`);
      else if (via.next !== "action") errs.push(`${at}: parent action leads to ${via.next}`);
      else if (parent.player === node.player) errs.push(`${at}: same player acts twice in a row`);
    } else if (node.player !== 0) errs.push("root must be OOP (player 0)");
    const A = node.actions.length;
    if (A < 1) errs.push(`${at}: needs at least one action`); // one: e.g. a tree where OOP may only check
    if (node.strategy.length !== A || node.ev.length !== A) {
      errs.push(`${at}: one strategy and ev entry per action`);
      continue;
    }
    let combos: Uint16Array;
    try {
      combos = decodeCombos(node.combos);
    } catch (e) {
      errs.push(`${at}: ${(e as Error).message}`);
      continue;
    }
    const n = combos.length;
    for (const c of combos) if (!inRange[node.player].has(c)) {
      errs.push(`${at}: ${comboString(c)} is not in the actor's range`);
      break;
    }
    try {
      const q = node.strategy.map(decodeUint8);
      if (q.some((s) => s.length !== n)) errs.push(`${at}: strategy length ≠ combos`);
      else
        for (let j = 0; j < n; j++) {
          let s = 0;
          for (let a = 0; a < A; a++) s += q[a][j];
          if (s !== Q_MAX) {
            errs.push(`${at}: ${comboString(combos[j])} strategy sums to ${s}, not ${Q_MAX}`);
            break;
          }
        }
      node.ev.forEach((s, a) => {
        if (node.actions[a].kind === "fold") {
          if (s !== null) errs.push(`${at}: fold EV must be null`);
        } else if (s === null) errs.push(`${at}: action ${a} has no EV`);
        else if (decodeInt16(s).length !== n) errs.push(`${at}: action ${a} ev length ≠ combos`);
      });
      if (node.reach !== undefined && decodeUint8(node.reach).length !== n) errs.push(`${at}: reach length ≠ combos`);
    } catch (e) {
      errs.push(`${at}: ${(e as Error).message}`);
    }
  }
  return errs;
}

/** Structural checks on a manifest. Returns the problems found (empty = valid). */
export function validateManifest(m: Manifest): string[] {
  const errs: string[] = [];
  if (m.v !== PACK_FORMAT) errs.push(`v must be ${PACK_FORMAT}`);
  const ids = new Set<string>();
  for (const p of m.packs) {
    const at = `pack ${p.id}`;
    if (!SCENARIO_ID.test(p.id)) errs.push(`${at}: invalid id`);
    if (ids.has(p.id)) errs.push(`${at}: duplicate id`);
    ids.add(p.id);
    if (!Number.isInteger(p.version) || p.version < 1) errs.push(`${at}: invalid version`);
    if (p.tier !== "free" && p.tier !== "pro") errs.push(`${at}: invalid tier`);
    const boards = new Set<string>();
    let weight = 0;
    for (const f of p.files) {
      const fat = `${at} ${f.path}`;
      const mm = /^([a-z0-9-]+)\/v(\d+)\/flop-([2-9TJQKAshdc]+)\.json$/.exec(f.path);
      if (!mm || mm[1] !== p.id || Number(mm[2]) < 1 || Number(mm[2]) > p.version || mm[3] !== f.board)
        errs.push(`${fat}: path must be ${p.id}/v<1..${p.version}>/flop-${f.board}.json`);
      if (boards.has(f.board)) errs.push(`${fat}: duplicate board`);
      boards.add(f.board);
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) errs.push(`${fat}: sha256 must be 64 lowercase hex characters`);
      if (!Number.isInteger(f.bytes) || f.bytes <= 0) errs.push(`${fat}: invalid byte count`);
      if (!(f.weight > 0)) errs.push(`${fat}: weight must be > 0`);
      weight += f.weight;
      if (f.summary.freq.length !== p.summaryNodes.length) errs.push(`${fat}: summary has ${f.summary.freq.length} rows, pack defines ${p.summaryNodes.length}`);
      else
        f.summary.freq.forEach((row, i) => {
          if (row && row.length !== p.summaryNodes[i].labels.length) errs.push(`${fat}: summary row ${i} has the wrong action count`);
        });
    }
    if (weight > RAW_FLOPS) errs.push(`${at}: file weights add up to ${weight} > ${RAW_FLOPS}`);
  }
  return errs;
}

// ───────────────────────── viewer helpers ─────────────────────────

const weightAt = (node: DecodedNode, j: number, start?: ArrayLike<number>): number =>
  start ? start[node.combos[j]] * node.reach[j] : node.weight[j];

/** Overall action frequencies at a node, weighted by each combo's absolute reach (or `start` × relative reach). */
export function nodeActionTotals(node: DecodedNode, start?: ArrayLike<number>): number[] {
  const A = node.actions.length;
  const tot = new Array<number>(A).fill(0);
  let W = 0;
  for (let j = 0; j < node.combos.length; j++) {
    const w = weightAt(node, j, start);
    W += w;
    for (let a = 0; a < A; a++) tot[a] += w * node.strategy[a][j];
  }
  return W > 0 ? tot.map((x) => x / W) : tot;
}

export interface HandAggregate {
  /** Stored combos of this class at the node. */
  combos: number;
  /** Σ absolute reach of those combos. */
  weight: number;
  /** Per action, reach-weighted frequency (all 0 when weight is 0). */
  freq: number[];
  /** Per action, reach-weighted EV (bb); NaN when unknown. */
  ev: number[];
  /** Reach-weighted EV of the node itself (Σ freq × action EV per combo); NaN when unknown. */
  evNode: number;
}

/** Per hand class (all 169, keyed like ALL_HANDS), action frequencies and EVs weighted by combo reach × starting weight. */
export function aggregateByHandClass(node: DecodedNode, start?: ArrayLike<number>): Record<HandClass, HandAggregate> {
  const A = node.actions.length;
  type Acc = { combos: number; w: number; f: number[]; evS: number[]; evW: number[]; nodeS: number; nodeW: number };
  const acc = new Map<HandClass, Acc>();
  for (const h of ALL_HANDS)
    acc.set(h, { combos: 0, w: 0, f: new Array(A).fill(0), evS: new Array(A).fill(0), evW: new Array(A).fill(0), nodeS: 0, nodeW: 0 });
  for (let j = 0; j < node.combos.length; j++) {
    const g = acc.get(COMBOS[node.combos[j]].hand)!;
    const w = weightAt(node, j, start);
    g.combos++;
    g.w += w;
    let nodeEv = 0;
    for (let a = 0; a < A; a++) {
      const p = node.strategy[a][j];
      const e = node.ev[a][j];
      g.f[a] += w * p;
      if (!Number.isNaN(e)) {
        g.evS[a] += w * e;
        g.evW[a] += w;
      }
      nodeEv += p > 0 ? p * e : 0;
    }
    if (!Number.isNaN(nodeEv)) {
      g.nodeS += w * nodeEv;
      g.nodeW += w;
    }
  }
  const out = {} as Record<HandClass, HandAggregate>;
  for (const [h, g] of acc)
    out[h] = {
      combos: g.combos,
      weight: g.w,
      freq: g.f.map((x) => (g.w > 0 ? x / g.w : 0)),
      ev: g.evS.map((x, a) => (g.evW[a] > 0 ? x / g.evW[a] : NaN)),
      evNode: g.nodeW > 0 ? g.nodeS / g.nodeW : NaN,
    };
  return out;
}

export interface ComboRow {
  /** COMBOS index. */
  index: number;
  /** "AhKd". */
  cards: string;
  hand: HandClass;
  /** Relative reach (0..1). */
  reach: number;
  /** Absolute reach (starting weight × relative reach). */
  weight: number;
  freq: number[];
  /** Per action EV (bb); NaN when unknown. */
  ev: number[];
  /** Σ freq × action EV; NaN when unknown. */
  evNode: number;
}

/** One row per stored combo at the node (COMBOS order, i.e. grid order), optionally only one hand class. */
export function comboRows(node: DecodedNode, start?: ArrayLike<number>, hand?: HandClass): ComboRow[] {
  const A = node.actions.length;
  const rows: ComboRow[] = [];
  for (let j = 0; j < node.combos.length; j++) {
    const index = node.combos[j];
    const h = COMBOS[index].hand;
    if (hand !== undefined && h !== hand) continue;
    const freq: number[] = [];
    const ev: number[] = [];
    let evNode = 0;
    for (let a = 0; a < A; a++) {
      const p = node.strategy[a][j];
      const e = node.ev[a][j];
      freq.push(p);
      ev.push(e);
      evNode += p > 0 ? p * e : 0;
    }
    rows.push({ index, cards: comboString(index), hand: h, reach: node.reach[j], weight: weightAt(node, j, start), freq, ev, evNode });
  }
  return rows;
}

const round = (x: number, digits: number): number => {
  const m = 10 ** digits;
  return Math.round(x * m) / m;
};

/** The stored nodes with at most `maxDepth` actions on their path, root first: the template for every file's summary. */
export function summaryNodeDefs(flop: DecodedFlop, maxDepth = 2): SummaryNodeDef[] {
  return flop.nodes
    .filter((n) => n.path.length <= maxDepth)
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((n) => ({ path: n.path.slice(), player: n.player, labels: n.actions.map((a) => a.label), kinds: n.actions.map((a) => a.kind) }));
}

/** A file's manifest summary. `root` holds the root equity and EV, which the pipeline takes from the solver. */
export function summarizeFlop(
  flop: DecodedFlop,
  defs: SummaryNodeDef[],
  root: { equity: [number, number]; ev: [number, number] },
): FlopSummary {
  const freq = defs.map((d) => {
    const node = flop.node(d.path);
    if (!node) return null;
    if (node.player !== d.player || node.actions.map((a) => a.label).join("|") !== d.labels.join("|"))
      throw new Error(`node "${pathKey(d.path)}" doesn't match the pack's summary template`);
    let W = 0;
    for (const w of node.weight) W += w;
    return W > 0 ? nodeActionTotals(node).map((x) => round(x, 3)) : null;
  });
  return {
    equity: [round(root.equity[0], 4), round(root.equity[1], 4)],
    ev: [round(root.ev[0], 2), round(root.ev[1], 2)],
    freq,
  };
}

// ───────────────────────── lines and turn starts ─────────────────────────

/**
 * Both players' absolute reach (COMBOS-indexed) after following `line` from the flop root: starting weight ×
 * each player's own action probabilities along the line. Every step must start at a stored node.
 */
export function rangesAfter(flop: DecodedFlop, line: number[]): [Float32Array, Float32Array] {
  const r: [Float32Array, Float32Array] = [flop.ranges[0].slice(), flop.ranges[1].slice()];
  const p = new Float64Array(NUM_COMBOS);
  for (let i = 0; i < line.length; i++) {
    const node = flop.node(line.slice(0, i));
    if (!node) throw new Error(`no stored node at "${pathKey(line.slice(0, i))}"`);
    const a = line[i];
    if (!Number.isInteger(a) || a < 0 || a >= node.actions.length) throw new Error(`no action ${a} at "${pathKey(node.path)}"`);
    if (i < line.length - 1 && node.actions[a].next !== "action")
      throw new Error(`"${node.actions[a].label}" at "${pathKey(node.path)}" ends the flop`);
    p.fill(0);
    for (let j = 0; j < node.combos.length; j++) p[node.combos[j]] = node.strategy[a][j];
    const w = r[node.player];
    for (let c = 0; c < NUM_COMBOS; c++) w[c] *= p[c];
  }
  return r;
}

export interface TurnStart {
  /** Chips in the middle when the turn is dealt (bb). */
  pot: number;
  /** Effective stack behind (bb). 0 after an all-in call. */
  stack: number;
  /** [OOP, IP] absolute weights, COMBOS-indexed. Combos blocked by the turn card are the solver's to skip. */
  ranges: [Float32Array, Float32Array];
  next: ChildKind;
}

/** The spot at the start of the turn after a flop line that ends the street ("street" or "allin-runout"). */
export function turnStart(flop: DecodedFlop, line: number[]): TurnStart {
  if (!line.length) throw new Error("the line is empty");
  const node = flop.node(line.slice(0, -1));
  if (!node) throw new Error(`no stored node at "${pathKey(line.slice(0, -1))}"`);
  const act = node.actions[line[line.length - 1]];
  if (!act) throw new Error(`no action ${line[line.length - 1]} at "${pathKey(node.path)}"`);
  if (act.next !== "street" && act.next !== "allin-runout") throw new Error(`"${act.label}" doesn't end the flop street`);
  const p = node.player;
  const put = Math.max(0, act.to - node.bets[p]);
  const stacks = [node.stacks[0], node.stacks[1]];
  stacks[p] -= put;
  return {
    pot: roundChips(node.pot + put),
    stack: roundChips(Math.max(0, Math.min(stacks[0], stacks[1]))),
    ranges: rangesAfter(flop, line),
    next: act.next,
  };
}

/** Tree settings of a pack, for a live turn solve that must match the presolved tree. */
export function treeSettings(meta: ScenarioMeta): Required<Pick<SolverInput, "sizes" | "raiseLimit" | "addAllIn" | "allInThreshold" | "minBet">> {
  return {
    sizes: meta.sizes,
    raiseLimit: meta.raiseLimit,
    addAllIn: meta.addAllIn,
    allInThreshold: meta.allInThreshold,
    minBet: meta.minBet,
  };
}
