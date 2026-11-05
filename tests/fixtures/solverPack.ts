/**
 * Synthetic solver packs, valid per src/presolve/format.ts, with plausible but NOT solved numbers: strategies and
 * EVs come from a hand-strength heuristic (handFeatures tiers). Used by the solver viewer's smoke test and to try
 * the viewer in a browser. Deterministic for a given seed.
 */
import { getSet } from "../../src/data/charts";
import { parseCards, type Card } from "../../src/poker/cards";
import { COMBOS, handFeatures, type Tier } from "../../src/play/handInfo";
import {
  NUM_COMBOS,
  canonicalBoard,
  decodeFlopFile,
  decodeRange,
  encodeFlopNode,
  encodeRange,
  flopClasses,
  packFilePath,
  summarizeFlop,
  summaryNodeDefs,
  type FileEntry,
  type FlopFile,
  type FlopNodeSource,
  type Manifest,
  type PackAction,
  type PackEntry,
  type ScenarioMeta,
} from "../../src/presolve/format";
import type { Player, StreetSizes } from "../../src/solver/types";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────── tree (same action rules as src/solver/tree.ts, flop only) ─────────

interface TreeCfg {
  pot: number;
  stack: number;
  sizes: [StreetSizes, StreetSizes];
  raiseLimit: number;
  addAllIn: boolean;
  allInThreshold: number;
  minBet: number;
}

interface GenNode {
  path: number[];
  player: Player;
  pot: number;
  bets: [number, number];
  stacks: [number, number];
  /** Bets and raises so far on the street. */
  n: number;
  inc: number;
  actions: PackAction[];
  children: (GenNode | null)[];
}

const EPS = 1e-9;
const fmt = (x: number) => String(Math.round(x * 10) / 10);

function legal(cfg: TreeCfg, s: Omit<GenNode, "actions" | "children" | "path">): Omit<PackAction, "next">[] {
  const i = s.player;
  const my = s.bets[i];
  const maxBet = Math.max(...s.bets);
  const stack = s.stacks[i];
  const sz = cfg.sizes[i];
  const call = maxBet - my;
  const out: Omit<PackAction, "next">[] = [];
  let allin = false;
  if (call <= EPS) {
    out.push({ kind: "check", to: 0, label: "체크" });
    for (const f of sz.bet) {
      const raw = f * s.pot;
      const amount = Math.max(cfg.minBet, raw);
      if (amount >= cfg.allInThreshold * stack || amount >= stack) allin = true;
      else out.push({ kind: "bet", to: my + amount, label: raw < cfg.minBet ? `벳 ${fmt(amount)}` : `벳 ${Math.round(f * 100)}%` });
    }
    if (cfg.addAllIn && stack > 0) allin = true;
  } else {
    out.push({ kind: "fold", to: 0, label: "폴드" });
    out.push({ kind: "call", to: maxBet, label: "콜" });
    if (s.n <= cfg.raiseLimit && stack > call + EPS && s.stacks[1 - i] > 0) {
      for (const f of sz.raise) {
        const to = Math.max(my + call + f * (s.pot + call), maxBet + s.inc);
        if (to - my >= cfg.allInThreshold * stack || to - my >= stack) allin = true;
        else out.push({ kind: "raise", to, label: `레이즈 ${fmt(to)}` });
      }
      if (cfg.addAllIn) allin = true;
    }
  }
  if (allin) out.push({ kind: "allin", to: my + stack, label: "올인" });
  return out;
}

function buildTree(cfg: TreeCfg, maxDepth: number): GenNode {
  const make = (path: number[], st: Omit<GenNode, "actions" | "children" | "path">): GenNode => {
    const acts = legal(cfg, st);
    const node: GenNode = { ...st, path, actions: [], children: [] };
    acts.forEach((a, k) => {
      const i = st.player, o = (1 - i) as Player;
      if (a.kind === "fold") {
        node.actions.push({ ...a, next: "fold" });
        node.children.push(null);
        return;
      }
      if (a.kind === "check") {
        if (i === 1) {
          node.actions.push({ ...a, next: "street" });
          node.children.push(null);
        } else {
          node.actions.push({ ...a, next: "action" });
          node.children.push(path.length < maxDepth ? make([...path, k], { ...st, player: o }) : null);
        }
        return;
      }
      const maxBet = Math.max(...st.bets);
      const add = a.to - st.bets[i];
      const bets: [number, number] = [st.bets[0], st.bets[1]];
      const stacks: [number, number] = [st.stacks[0], st.stacks[1]];
      bets[i] = a.to;
      if (a.kind === "call") {
        stacks[i] = stacks[o];
        node.actions.push({ ...a, next: stacks[o] <= EPS ? "allin-runout" : "street" });
        node.children.push(null);
        return;
      }
      stacks[i] = a.kind === "allin" ? 0 : stacks[i] - add;
      node.actions.push({ ...a, next: "action" });
      node.children.push(
        path.length < maxDepth
          ? make([...path, k], { player: o, pot: st.pot + add, bets, stacks, n: st.n + 1, inc: Math.max(st.inc, a.to - maxBet) })
          : null,
      );
    });
    return node;
  };
  return make([], { player: 0, pot: cfg.pot, bets: [0, 0], stacks: [cfg.stack, cfg.stack], n: 0, inc: cfg.minBet });
}

function walk(n: GenNode, f: (n: GenNode) => void) {
  f(n);
  for (const c of n.children) if (c) walk(c, f);
}

// ───────── heuristic strategies ─────────

type OpenMix = [check: number, small: number, large: number, allin: number];
type FaceMix = [fold: number, call: number, raise: number, allin: number];

const OOP_OPEN: Record<Tier, OpenMix> = {
  4: [0.45, 0.2, 0.33, 0.02],
  3: [0.7, 0.25, 0.05, 0],
  2.5: [0.4, 0.3, 0.28, 0.02],
  2: [0.86, 0.14, 0, 0],
  1.5: [0.62, 0.26, 0.12, 0],
  1: [0.9, 0.1, 0, 0],
  0: [0.84, 0.11, 0.05, 0],
};
const IP_OPEN: Record<Tier, OpenMix> = {
  4: [0.18, 0.3, 0.5, 0.02],
  3: [0.22, 0.62, 0.16, 0],
  2.5: [0.1, 0.4, 0.46, 0.04],
  2: [0.55, 0.45, 0, 0],
  1.5: [0.32, 0.46, 0.22, 0],
  1: [0.7, 0.3, 0, 0],
  0: [0.5, 0.36, 0.14, 0],
};
const FACE_BET: Record<Tier, FaceMix> = {
  4: [0, 0.5, 0.44, 0.06],
  3: [0, 0.86, 0.14, 0],
  2.5: [0.02, 0.55, 0.37, 0.06],
  2: [0.1, 0.85, 0.05, 0],
  1.5: [0.24, 0.6, 0.16, 0],
  1: [0.55, 0.45, 0, 0],
  0: [0.84, 0.05, 0.11, 0],
};
const FACE_RAISE: Record<Tier, FaceMix> = {
  4: [0, 0.4, 0.2, 0.4],
  3: [0.3, 0.65, 0.05, 0],
  2.5: [0.2, 0.5, 0.1, 0.2],
  2: [0.62, 0.38, 0, 0],
  1.5: [0.52, 0.38, 0.05, 0.05],
  1: [0.9, 0.1, 0, 0],
  0: [0.92, 0.03, 0.03, 0.02],
};
const EQ: Record<Tier, number> = { 0: 0.22, 1: 0.38, 1.5: 0.42, 2: 0.55, 2.5: 0.58, 3: 0.72, 4: 0.88 };

interface BoardInfo {
  cards: Card[];
  lowOrConnected: boolean;
  aceHigh: boolean;
  monotone: boolean;
  paired: boolean;
}

function boardInfo(cards: Card[]): BoardInfo {
  const ranks = cards.map((c) => c >> 2).sort((a, b) => b - a);
  const suits = new Set(cards.map((c) => c & 3));
  return {
    cards,
    lowOrConnected: ranks[0] <= 8 || ranks[0] - ranks[2] <= 4,
    aceHigh: ranks[0] === 12,
    monotone: suits.size === 1,
    paired: new Set(ranks).size < 3,
  };
}

/** Action probabilities for one combo at one node (sums to 1). */
function mix(node: GenNode, tier: Tier, b: BoardInfo, r: () => number): number[] {
  const acts = node.actions;
  const out = new Array<number>(acts.length).fill(0);
  const sized = acts.map((a, i) => (a.kind === "bet" || a.kind === "raise" ? i : -1)).filter((i) => i >= 0);
  const allinAt = acts.findIndex((a) => a.kind === "allin");
  const put = (i: number, w: number) => {
    if (i >= 0) out[i] += w;
  };
  const bigOr = (fallback: number) => (sized.length ? sized[sized.length - 1] : fallback);
  if (acts[0].kind === "check") {
    const m = [...(node.player === 0 ? OOP_OPEN : IP_OPEN)[tier]];
    if (node.player === 0) {
      const k = b.lowOrConnected ? 1.8 : b.aceHigh ? 0.7 : 1;
      m[1] *= k;
      m[2] *= k;
    } else {
      if (b.monotone) {
        m[1] *= 1.3;
        m[2] *= 0.5;
      }
      if (b.paired) {
        m[1] *= 1.5;
        m[0] *= 0.8;
      }
    }
    out[0] = m[0];
    put(sized.length ? sized[0] : allinAt, m[1]);
    put(bigOr(allinAt), m[2]);
    put(allinAt >= 0 ? allinAt : bigOr(-1), m[3]);
  } else {
    const m = [...(node.n >= 2 ? FACE_RAISE : FACE_BET)[tier]];
    const maxBet = Math.max(...node.bets);
    const facing = (maxBet - node.bets[node.player]) / Math.max(EPS, node.pot - (maxBet - node.bets[node.player]));
    if (facing > 0.6 && tier <= 2) m[0] *= 1.6;
    out[0] = m[0];
    out[1] = m[1];
    if (!sized.length && allinAt < 0) out[1] += m[2] + m[3];
    else {
      put(sized.length ? sized[0] : allinAt, m[2]);
      put(allinAt >= 0 ? allinAt : bigOr(1), m[3]);
    }
  }
  let s = 0;
  for (let a = 0; a < out.length; a++) {
    out[a] *= 0.55 + 0.9 * r();
    s += out[a];
  }
  for (let a = 0; a < out.length; a++) out[a] = s > 0 ? out[a] / s : 1 / out.length;
  // Real solver output is often pure: drop small slivers.
  let s2 = 0;
  for (let a = 0; a < out.length; a++) {
    if (out[a] < 0.06) out[a] = 0;
    s2 += out[a];
  }
  return s2 > 0 ? out.map((x) => x / s2) : out;
}

// ───────── packs ─────────

interface PackSpec {
  id: string;
  title: string;
  tier: "free" | "pro";
  meta: ScenarioMeta;
  boards: string[];
}

/** COMBOS-indexed weights of a chart ref "<set>/<stage>/<scenario>:<action>". */
function chartRange(ref: string): Float32Array {
  const [scenarioId, action] = ref.split(":");
  const [setId, stageId] = scenarioId.split("/");
  const sc = getSet(setId).stages.find((s) => s.id === stageId)?.scenarios.find((s) => s.id === scenarioId);
  if (!sc) throw new Error(`no chart ${scenarioId}`);
  const w = new Float32Array(NUM_COMBOS);
  COMBOS.forEach(({ hand }, i) => (w[i] = sc.strategy[hand][action] ?? 0));
  return w;
}

const sizes = (bet: number[], raise: number[]): [StreetSizes, StreetSizes] => [
  { bet, raise },
  { bet, raise },
];

function scenario(format: "cash" | "pub", pot: number, stack: number, addAllIn: boolean, preflop: string, rangeSources: [string, string]): ScenarioMeta {
  return {
    format,
    positions: ["BB", "BTN"],
    preflop,
    pot,
    stack,
    sizes: { flop: sizes([0.33, 0.75], [0.75]), turn: sizes([0.5, 1], [0.75]), river: sizes([0.5, 1], [0.75]) },
    raiseLimit: 2,
    addAllIn,
    allInThreshold: 0.67,
    minBet: 1,
    iterations: 1000,
    targetExploitability: 0.5,
    ranges: [`(synthetic) ${rangeSources[0]}`, `(synthetic) ${rangeSources[1]}`],
    rangeSources,
    flopSet: "synthetic-3",
  };
}

export const SYNTHETIC_SPECS: PackSpec[] = [
  {
    id: "srp-btn-bb-100",
    title: "BTN vs BB 싱글 레이즈드 팟 (100bb)",
    tier: "free",
    meta: scenario("cash", 5.5, 97.5, false, "BTN 2.5bb 오픈, BB 콜", ["cash6/100bb/bb-vs-btn:call", "cash6/100bb/rfi-btn:raise"]),
    boards: ["AsKh7d", "Th9h7c", "7s7h2d"],
  },
  {
    id: "pub-srp-btn-bb-40",
    title: "펍 미들 BTN vs BB 싱글 레이즈드 팟 (40bb)",
    tier: "pro",
    meta: scenario("pub", 6.5, 36.5, true, "BTN 2.5bb 오픈, BB 콜 (BB 앤티)", ["pub/mid/bb-vs-btn:call", "pub/mid/rfi-btn:open"]),
    boards: ["KsQh3d", "Js8s3s", "6s5h4d"],
  },
];

const cmpPath = (a: number[], b: number[]) => {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** Depth-3 nodes are candidates only when reached through a raise (the format's "deeper nodes"). */
const candidate = (n: GenNode, parent: GenNode | null) =>
  n.path.length <= 2 || (parent !== null && parent.actions[n.path[n.path.length - 1]].kind === "raise");

/** The format's size target: deeper nodes are added only while the file stays under it. */
const SIZE_TARGET = 60 * 1024;

function buildFlop(spec: PackSpec, rawBoard: string, seed: number) {
  const r = rng(seed);
  const { cards: board, key } = canonicalBoard(parseCards(rawBoard));
  const info = boardInfo(board);
  const dead = new Set(board);
  const sources0 = spec.meta.rangeSources!;
  const start: [Float32Array, Float32Array] = [chartRange(sources0[0]), chartRange(sources0[1])];
  for (const w of start) COMBOS.forEach(({ cards }, i) => (dead.has(cards[0]) || dead.has(cards[1])) && (w[i] = 0));
  const startQ: [Float32Array, Float32Array] = [decodeRange(encodeRange(start[0], board)), decodeRange(encodeRange(start[1], board))];
  const tiers = COMBOS.map(({ cards }) => (dead.has(cards[0]) || dead.has(cards[1]) ? 0 : handFeatures(cards, board).tier));
  const eq = tiers.map((t) => Math.min(0.97, Math.max(0.03, EQ[t] + (r() - 0.5) * 0.1)));

  const m = spec.meta;
  const tree = buildTree(
    { pot: m.pot, stack: m.stack, sizes: m.sizes.flop, raiseLimit: m.raiseLimit, addAllIn: m.addAllIn, allInThreshold: m.allInThreshold, minBet: m.minBet },
    3,
  );
  const strat = new Map<string, Float32Array[]>();
  const evs = new Map<string, (Float32Array | null)[]>();
  walk(tree, (node) => {
    const A = node.actions.length;
    const s = node.actions.map(() => new Float32Array(NUM_COMBOS));
    const e = node.actions.map((a) => (a.kind === "fold" ? null : new Float32Array(NUM_COMBOS)));
    const p = node.player;
    const call = Math.max(...node.bets) - node.bets[p];
    const foldEv = -(m.stack - node.stacks[p]);
    for (let c = 0; c < NUM_COMBOS; c++) {
      if (!(startQ[p][c] > 0)) continue;
      const mx = mix(node, tiers[c] as Tier, info, r);
      for (let a = 0; a < A; a++) s[a][c] = mx[a];
      const top = mx.indexOf(Math.max(...mx));
      const value = eq[c] * (node.pot + call) - (m.stack - node.stacks[p] + call);
      const anchor = node.actions[top].kind === "fold" ? foldEv : value;
      for (let a = 0; a < A; a++) {
        const arr = e[a];
        if (arr) arr[c] = anchor - (mx[top] - mx[a]) * 0.12 * node.pot + (r() - 0.5) * 0.04;
      }
    }
    strat.set(node.path.join("."), s);
    evs.set(node.path.join("."), e);
  });

  const sources: FlopNodeSource[] = [];
  const visit = (node: GenNode, parent: GenNode | null) => {
    if (!candidate(node, parent)) return;
    const p = node.player;
    const reach = startQ[p].slice();
    for (let i = 0; i < node.path.length; i++) {
      const anc = node.path.slice(0, i);
      // The actor's own earlier decisions are every other step back from this node.
      if ((node.path.length - i) % 2 === 0) {
        const s = strat.get(anc.join("."))![node.path[i]];
        for (let c = 0; c < NUM_COMBOS; c++) reach[c] *= s[c];
      }
    }
    sources.push({
      path: node.path,
      player: p,
      pot: node.pot,
      bets: node.bets,
      stacks: node.stacks,
      actions: node.actions,
      start: startQ[p],
      reach,
      strategy: strat.get(node.path.join("."))!,
      ev: evs.get(node.path.join("."))!,
    });
    node.children.forEach((c) => c && visit(c, node));
  };
  visit(tree, null);
  sources.sort((a, b) => cmpPath(a.path, b.path));

  const encoded = sources.map(encodeFlopNode);
  const nodes = encoded.filter((n) => n.path.length <= 2);
  let size = JSON.stringify(nodes).length + 1500;
  for (const n of encoded) {
    if (n.path.length <= 2) continue;
    const add = JSON.stringify(n).length + 1;
    if (size + add > SIZE_TARGET) break;
    nodes.push(n);
    size += add;
  }

  const file: FlopFile = {
    v: 1,
    scenario: spec.id,
    version: 1,
    board: key,
    pot: m.pot,
    stack: m.stack,
    iterations: 600 + Math.floor(r() * 400),
    exploitability: Math.round((0.25 + r() * 0.25) * 100) / 100,
    ranges: [encodeRange(start[0], board), encodeRange(start[1], board)],
    nodes,
  };

  // Root numbers for the manifest summary.
  const rootS = strat.get("")!, rootE = evs.get("")!;
  let w0 = 0, eq0 = 0, ev0 = 0, w1 = 0, eq1 = 0;
  for (let c = 0; c < NUM_COMBOS; c++) {
    if (startQ[0][c] > 0) {
      w0 += startQ[0][c];
      eq0 += startQ[0][c] * eq[c];
      let v = 0;
      rootS.forEach((s, a) => (v += s[c] * (rootE[a]?.[c] ?? 0)));
      ev0 += startQ[0][c] * v;
    }
    if (startQ[1][c] > 0) {
      w1 += startQ[1][c];
      eq1 += startQ[1][c] * eq[c];
    }
  }
  const e0 = eq0 / w0, e1 = eq1 / w1;
  const equity0 = e0 / (e0 + e1);
  const oopEv = Math.min(m.pot, Math.max(0, ev0 / w0));
  return { file, key, root: { equity: [equity0, 1 - equity0] as [number, number], ev: [oopEv, m.pot - oopEv] as [number, number] } };
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SyntheticPacks {
  manifest: Manifest;
  /** Every flop file: path relative to packs/, and its exact JSON text. */
  files: { path: string; json: string }[];
  flops: Map<string, FlopFile>;
}

/** Builds the packs of SYNTHETIC_SPECS (or `specs`). */
export async function buildSyntheticPacks(specs: PackSpec[] = SYNTHETIC_SPECS, seed = 7): Promise<SyntheticPacks> {
  const weights = new Map(flopClasses().map((c) => [c.key, c.weight] as const));
  const enc = new TextEncoder();
  const files: SyntheticPacks["files"] = [];
  const flops = new Map<string, FlopFile>();
  const packs: PackEntry[] = [];
  let k = 0;
  for (const spec of specs) {
    const entries: FileEntry[] = [];
    let defs: PackEntry["summaryNodes"] | null = null;
    for (const raw of spec.boards) {
      const { file, key, root } = buildFlop(spec, raw, seed * 1000 + k++);
      const decoded = decodeFlopFile(file);
      defs ??= summaryNodeDefs(decoded);
      const json = JSON.stringify(file);
      const bytes = enc.encode(json);
      const path = packFilePath(spec.id, 1, key);
      files.push({ path, json });
      flops.set(path, file);
      entries.push({
        path,
        sha256: await sha256(bytes),
        bytes: bytes.length,
        board: key,
        weight: weights.get(key) ?? 1,
        exploitability: file.exploitability,
        summary: summarizeFlop(decoded, defs, root),
      });
    }
    packs.push({ id: spec.id, title: spec.title, version: 1, tier: spec.tier, scenario: spec.meta, summaryNodes: defs ?? [], files: entries });
  }
  return { manifest: { v: 1, generatedAt: "2026-11-05T00:00:00Z", packs }, files, flops };
}
