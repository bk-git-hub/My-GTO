/**
 * Turns one solved flop into a pack file (docs/solver-packs.md): walks the flop-street action nodes of a
 * Solution, quantizes each actor's strategy, action EVs and reach with format.ts, keeps every node with at most
 * two actions on its path plus deeper ones while the file stays under the size target, and builds the
 * manifest summary (root equity, root EV, action frequencies at the summary nodes).
 *
 * Pure TypeScript (no Node APIs), so it can also run in a Web Worker.
 */
import { type Card } from "../poker/cards";
import { evaluate } from "../poker/evaluator";
import { COMBOS } from "../play/handInfo";
import type { PathStep, Player, Solution, SolutionNode, SolverInput } from "../solver/types";
import {
  COMBO_CLASS,
  NUM_COMBOS,
  PACK_FORMAT,
  boardKey,
  canonicalBoard,
  decodeFlopFile,
  encodeClassRange,
  encodeClassRoot,
  encodeFlopNode,
  encodeRange,
  summarizeFlop,
  summaryNodeDefs,
  validateFlopFile,
  type ChildKind,
  type FlopFile,
  type FlopNode,
  type FlopSummary,
  type PackAction,
  type SummaryNodeDef,
} from "./format";

/** Aim for files below this many bytes (UTF-8 JSON) before gzip. */
export const TARGET_BYTES = 60_000;
/** Never write a file above this. */
export const MAX_BYTES = 96_000;

export interface ExtractMeta {
  /** Pack (scenario) id. */
  scenario: string;
  /** Pack version. */
  version: number;
}

export interface ExtractOptions {
  /** Nodes with at most this many actions on their path are always stored (the summary uses them). Default 2. */
  summaryDepth?: number;
  /** Deeper nodes are added while the file stays below this. Default TARGET_BYTES. */
  targetBytes?: number;
  /** Compute the root equity by enumerating every runout (about a second for chart-sized ranges). Default true. */
  equity?: boolean;
  /**
   * What the file holds (ScenarioMeta.storage). Default: the action nodes. "rootClasses": no nodes, only the starting
   * ranges per class (ClassRange) and the per-class root (FlopFile.rootClasses), the calibration queue's slim files.
   */
  storage?: "rootClasses";
}

export interface ExtractResult {
  file: FlopFile;
  /** JSON.stringify(file): the exact text to write. */
  json: string;
  /** UTF-8 byte length of `json`. */
  bytes: number;
  /** Canonical board key (= file.board). */
  board: string;
  /** % of pot. */
  exploitability: number;
  /** For FileEntry.summary, built against `summaryNodes`. */
  summary: FlopSummary;
  /** The summary template of this flop (the same on every flop of a pack). */
  summaryNodes: SummaryNodeDef[];
  /** True when the file is above MAX_BYTES: the pipeline must not write it. */
  tooBig: boolean;
  stats: {
    /** Flop action nodes the extractor looked at. */
    visited: number;
    stored: number;
    /** Deeper nodes left out for the size budget. */
    leftOut: number;
  };
}

// ───────────────────────── helpers ─────────────────────────

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;

const round = (x: number, digits: number): number => {
  const m = 10 ** digits;
  return Math.round(x * m) / m;
};

/** What follows an action, from the child the solver reports. */
export function childKind(child: SolutionNode): ChildKind {
  if (child.kind === "terminal") return child.terminal === "fold" ? "fold" : "showdown";
  if (child.kind === "chance") return child.stacks[0] <= 1e-9 && child.stacks[1] <= 1e-9 ? "allin-runout" : "street";
  return "action";
}

const steps = (path: number[]): PathStep[] => path.map((action) => ({ action }));

function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

/**
 * Per combo of `me`, the opponent weight it can face: Σ opp − opp holding either of its cards + opp holding the
 * same combo (inclusion–exclusion). Combos touching the board get 0.
 */
export function compatibleWeights(board: Card[], opp: ArrayLike<number>): Float64Array {
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const byCard = new Float64Array(52);
  let total = 0;
  for (let i = 0; i < NUM_COMBOS; i++) {
    const w = opp[i];
    if (!(w > 0)) continue;
    const [a, b] = COMBOS[i].cards;
    if (dead[a] || dead[b]) continue;
    total += w;
    byCard[a] += w;
    byCard[b] += w;
  }
  const out = new Float64Array(NUM_COMBOS);
  for (let i = 0; i < NUM_COMBOS; i++) {
    const [a, b] = COMBOS[i].cards;
    if (dead[a] || dead[b]) continue;
    const same = opp[i] > 0 ? opp[i] : 0;
    out[i] = Math.max(0, total - byCard[a] - byCard[b] + same);
  }
  return out;
}

/**
 * Range-average expected net of player p at a node: Σ_h w(h) × compat(h) × ev(h) / Σ_h w(h) × compat(h), i.e.
 * weighted by how often each pair of hands occurs. The two players' values sum to the pot.
 */
export function rangeAverageEv(node: SolutionNode, p: Player): number {
  const w = node.ranges[p];
  const cs = compatibleWeights(node.board, node.ranges[1 - p]);
  let s = 0, W = 0;
  for (let i = 0; i < NUM_COMBOS; i++) {
    const k = w[i] * cs[i];
    if (!(k > 0) || Number.isNaN(node.ev[p][i])) continue;
    s += k * node.ev[p][i];
    W += k;
  }
  return W > 0 ? s / W : NaN;
}

/**
 * Raw all-in equity of each range against the other on a flop, both run out to the river: every turn and river
 * card, every compatible pair of hands, weighted by w0 × w1. Returns [OOP share, IP share] (sums to 1).
 */
export function rangeEquity(board: Card[], w0: ArrayLike<number>, w1: ArrayLike<number>): [number, number] {
  if (board.length !== 3) throw new Error("rangeEquity needs a flop");
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const list = (w: ArrayLike<number>) => {
    const idx: number[] = [];
    for (let i = 0; i < NUM_COMBOS; i++) {
      const [a, b] = COMBOS[i].cards;
      if (w[i] > 0 && !dead[a] && !dead[b]) idx.push(i);
    }
    return idx;
  };
  const L = [list(w0), list(w1)];
  const c1 = L.map((l) => Int32Array.from(l, (i) => COMBOS[i].cards[0]));
  const c2 = L.map((l) => Int32Array.from(l, (i) => COMBOS[i].cards[1]));
  const wt = [Float64Array.from(L[0], (i) => w0[i]), Float64Array.from(L[1], (i) => w1[i])];
  // For the same-combo correction: weight of combo i in range 1.
  const w1At = new Float64Array(NUM_COMBOS);
  L[1].forEach((i, k) => (w1At[i] = wt[1][k]));
  const str = [new Float64Array(L[0].length), new Float64Array(L[1].length)];
  const ord = [new Int32Array(L[0].length), new Int32Array(L[1].length)];
  const cards = new Int32Array(7);
  cards[0] = board[0];
  cards[1] = board[1];
  cards[2] = board[2];
  const live = [0, 0];
  const less = new Float64Array(52), lessEq = new Float64Array(52), all = new Float64Array(52);
  let num = 0, den = 0;
  for (let t = 0; t < 52; t++) {
    if (dead[t]) continue;
    for (let r = t + 1; r < 52; r++) {
      if (dead[r]) continue;
      cards[3] = t;
      cards[4] = r;
      for (let p = 0; p < 2; p++) {
        const n = L[p].length;
        let m = 0;
        for (let k = 0; k < n; k++) {
          const a = c1[p][k], b = c2[p][k];
          if (a === t || a === r || b === t || b === r) continue;
          cards[5] = a;
          cards[6] = b;
          str[p][k] = evaluate(cards, 7);
          ord[p][m++] = k;
        }
        const s = str[p];
        ord[p].subarray(0, m).sort((x, y) => s[x] - s[y]);
        live[p] = m;
      }
      const m0 = live[0], m1 = live[1];
      less.fill(0);
      lessEq.fill(0);
      all.fill(0);
      let tot = 0, accL = 0, accLE = 0;
      for (let j = 0; j < m1; j++) {
        const k = ord[1][j];
        const w = wt[1][k];
        tot += w;
        all[c1[1][k]] += w;
        all[c2[1][k]] += w;
      }
      let pl = 0, ple = 0;
      for (let j = 0; j < m0; j++) {
        const h = ord[0][j];
        const s = str[0][h];
        while (pl < m1 && str[1][ord[1][pl]] < s) {
          const k = ord[1][pl++];
          const w = wt[1][k];
          accL += w;
          less[c1[1][k]] += w;
          less[c2[1][k]] += w;
        }
        while (ple < m1 && str[1][ord[1][ple]] <= s) {
          const k = ord[1][ple++];
          const w = wt[1][k];
          accLE += w;
          lessEq[c1[1][k]] += w;
          lessEq[c2[1][k]] += w;
        }
        const a = c1[0][h], b = c2[0][h];
        const same = w1At[L[0][h]];
        const win = accL - less[a] - less[b];
        const winTie = accLE - lessEq[a] - lessEq[b] + same; // the same combo ties and was subtracted twice
        const compat = tot - all[a] - all[b] + same;
        const w = wt[0][h];
        num += w * (win + 0.5 * (winTie - win));
        den += w * compat;
      }
    }
  }
  if (!(den > 0)) return [NaN, NaN];
  const e0 = num / den;
  return [e0, 1 - e0];
}

// ───────────────────────── extraction ─────────────────────────

interface Visit {
  path: number[];
  sn: SolutionNode;
  /** Joint relative reach mass: how often both players get here, roughly. */
  mass: number;
}

/**
 * Build the pack file of one solved flop. `input.board` must be the canonical board of its suit class
 * (`canonicalBoard`), since files are stored under canonical keys and combos are not remapped here.
 */
export function extractFlop(input: SolverInput, solution: Solution, meta: ExtractMeta, opts: ExtractOptions = {}): ExtractResult {
  const board = Array.from(input.board);
  if (board.length !== 3) throw new Error("extractFlop needs a flop solve");
  const key = boardKey(board);
  if (canonicalBoard(board).key !== key) throw new Error(`board ${key} is not canonical (${canonicalBoard(board).key}); solve the canonical board`);
  const summaryDepth = opts.summaryDepth ?? 2;
  const targetBytes = opts.targetBytes ?? TARGET_BYTES;

  const root = solution.node([]);
  if (root.kind !== "action" || root.street !== "flop") throw new Error("the solve must start with a flop decision");
  const start: [Float32Array, Float32Array] = [root.ranges[0], root.ranges[1]];
  if (opts.storage === "rootClasses") return extractRootClasses(input, solution, meta, opts, key, start);
  const startMass = [sum(start[0]), sum(start[1])];

  let visited = 0;
  const encode = (v: Visit): FlopNode => {
    visited++;
    const sn = v.sn;
    const p = sn.player!;
    const acts = sn.actions!;
    const actions: PackAction[] = [];
    const ev: (Float32Array | null)[] = [];
    acts.forEach((a, k) => {
      const child = solution.node(steps([...v.path, k]));
      const next = childKind(child);
      actions.push({ kind: a.kind, to: a.to, label: a.label, next });
      ev.push(next === "fold" ? null : child.ev[p]);
    });
    return encodeFlopNode({
      path: v.path,
      player: p,
      pot: sn.pot,
      bets: sn.bets,
      stacks: sn.stacks,
      actions,
      start: start[p],
      reach: sn.ranges[p],
      strategy: sn.strategy!,
      ev,
    });
  };
  const children = (v: Visit, node: FlopNode): Visit[] =>
    node.actions.flatMap((a, k) => {
      if (a.next !== "action") return [];
      const path = [...v.path, k];
      const sn = solution.node(steps(path));
      if (sn.kind !== "action" || sn.street !== "flop") return [];
      const mass = (sum(sn.ranges[0]) / startMass[0]) * (sum(sn.ranges[1]) / startMass[1]);
      return [{ path, sn, mass }];
    });

  // Every node up to summaryDepth, breadth first.
  const stored: FlopNode[] = [];
  let frontier: Visit[] = [{ path: [], sn: root, mass: 1 }];
  const deeper: Visit[] = [];
  while (frontier.length) {
    const next: Visit[] = [];
    for (const v of frontier) {
      const node = encode(v);
      stored.push(node);
      for (const c of children(v, node)) (c.path.length <= summaryDepth ? next : deeper).push(c);
    }
    frontier = next;
  }

  const file: FlopFile = {
    v: PACK_FORMAT,
    scenario: meta.scenario,
    version: meta.version,
    board: key,
    pot: input.pot,
    stack: input.stack,
    iterations: solution.iterations,
    exploitability: round(solution.exploitability, 3),
    ranges: [encodeRange(start[0], board), encodeRange(start[1], board)],
    nodes: stored,
  };
  // Deeper nodes by reach mass while the file stays under the target (each stored node's parent is stored).
  let bytes = byteLength(JSON.stringify(file));
  let leftOut = 0;
  while (deeper.length) {
    let bi = 0;
    for (let i = 1; i < deeper.length; i++) if (deeper[i].mass > deeper[bi].mass) bi = i;
    const v = deeper.splice(bi, 1)[0];
    if (!(v.mass > 0)) {
      leftOut += 1 + deeper.length;
      break;
    }
    const node = encode(v);
    const add = byteLength(JSON.stringify(node)) + 1;
    if (bytes + add > targetBytes) {
      leftOut += 1 + deeper.length;
      break;
    }
    stored.push(node);
    bytes += add;
    deeper.push(...children(v, node));
  }
  file.nodes = stored.sort((a, b) => a.path.length - b.path.length || a.path.join(".").localeCompare(b.path.join("."), "en", { numeric: true }));

  const errs = validateFlopFile(file);
  if (errs.length) throw new Error(`invalid pack file for ${key}: ${errs.slice(0, 5).join("; ")}`);
  const json = JSON.stringify(file);
  bytes = byteLength(json);

  const decoded = decodeFlopFile(file);
  const summaryNodes = summaryNodeDefs(decoded, summaryDepth);
  const equity = opts.equity === false ? ([NaN, NaN] as [number, number]) : rangeEquity(board, start[0], start[1]);
  const summary = summarizeFlop(decoded, summaryNodes, { equity, ev: [rangeAverageEv(root, 0), rangeAverageEv(root, 1)] });

  return {
    file,
    json,
    bytes,
    board: key,
    exploitability: file.exploitability,
    summary,
    summaryNodes,
    tooBig: bytes > MAX_BYTES,
    stats: { visited, stored: stored.length, leftOut },
  };
}

/**
 * The slim file of a calibration pack (`storage: "rootClasses"`): the starting ranges per class and the per-class root
 * (each class's root EV for both players, OOP's root frequencies), no action nodes: what scripts/fit-realization.mjs
 * reads, in about 2 KB. The manifest summary keeps the solver's root equity and EVs; with no nodes it has no frequency
 * rows. The ranges must give every combo of a class the same weight (chart ranges do).
 */
function extractRootClasses(
  input: SolverInput,
  solution: Solution,
  meta: ExtractMeta,
  opts: ExtractOptions,
  key: string,
  start: [Float32Array, Float32Array],
): ExtractResult {
  const board = Array.from(input.board);
  const root = solution.node([]);
  const acts = root.actions!;
  const actions: PackAction[] = acts.map((a, k) => ({ kind: a.kind, to: a.to, label: a.label, next: childKind(solution.node([{ action: k }])) }));
  const file: FlopFile = {
    v: PACK_FORMAT,
    scenario: meta.scenario,
    version: meta.version,
    board: key,
    pot: input.pot,
    stack: input.stack,
    iterations: solution.iterations,
    exploitability: round(solution.exploitability, 3),
    ranges: [encodeClassRange(start[0], board), encodeClassRange(start[1], board)],
    nodes: [],
    rootClasses: encodeClassRoot({ board, start, ev: root.ev, actions, strategy: root.strategy! }),
  };
  const errs = validateFlopFile(file);
  if (errs.length) throw new Error(`invalid pack file for ${key}: ${errs.slice(0, 5).join("; ")}`);
  const json = JSON.stringify(file);
  const bytes = byteLength(json);
  const decoded = decodeFlopFile(file);
  const summaryNodes = summaryNodeDefs(decoded, opts.summaryDepth ?? 2);
  const equity = opts.equity === false ? ([NaN, NaN] as [number, number]) : rangeEquity(board, start[0], start[1]);
  const summary = summarizeFlop(decoded, summaryNodes, { equity, ev: [rangeAverageEv(root, 0), rangeAverageEv(root, 1)] });
  return { file, json, bytes, board: key, exploitability: file.exploitability, summary, summaryNodes, tooBig: bytes > MAX_BYTES, stats: { visited: 0, stored: 0, leftOut: 0 } };
}

/**
 * A manifest summary rebuilt from a stored file alone, for a file that has no manifest entry (e.g. the job
 * stopped between writing the file and the manifest). Inputs are quantized, so the root EV is within ~0.01 bb
 * of the solver's and the equity within ~0.002 of the exact ranges'. IP's EV is the pot minus OOP's.
 */
export function summarizeFile(file: FlopFile, summaryDepth = 2): { summary: FlopSummary; summaryNodes: SummaryNodeDef[] } {
  const flop = decodeFlopFile(file);
  const summaryNodes = summaryNodeDefs(flop, summaryDepth);
  const cs = compatibleWeights(flop.board, flop.ranges[1]);
  let s = 0, W = 0;
  const add = (c: number, ev: number) => {
    const k = flop.ranges[0][c] * cs[c];
    if (k > 0 && !Number.isNaN(ev)) {
      s += k * ev;
      W += k;
    }
  };
  const root = flop.node([]);
  if (root)
    root.combos.forEach((c, j) => {
      let ev = 0;
      root.actions.forEach((_, a) => (ev += root.strategy[a][j] > 0 ? root.strategy[a][j] * root.ev[a][j] : 0));
      add(c, ev);
    });
  else if (flop.rootClasses) for (let c = 0; c < NUM_COMBOS; c++) add(c, flop.rootClasses.ev[0][COMBO_CLASS[c]]);
  else throw new Error(`${file.board}: no root node`);
  const ev0 = W > 0 ? s / W : NaN;
  const equity = rangeEquity(flop.board, flop.ranges[0], flop.ranges[1]);
  return { summary: summarizeFlop(flop, summaryNodes, { equity, ev: [ev0, file.pot - ev0] }), summaryNodes };
}
