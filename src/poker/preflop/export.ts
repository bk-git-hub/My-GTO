import { ALL_HANDS, RANKS } from "../cards";
import { parseRange } from "../range";
import type { PreflopAction, PreflopKind, PreflopScenario, PreflopStage } from "../../data/sets/preflopTypes";
import type { EqrFit } from "./eqrFit";
import { comboWeights, ownReach, snapStrategy, type Valuation } from "./solve";
import { seatNames, type ActionInfo, type LineStep, type NodeInfo, type PreflopTree, type Verb } from "./tree";
import { MW_C_POS, SPR_ALPHA, SPR_SURPLUS, equityScaledSurplusVectors, surplusShrink, type ModelBParams, type PairwiseVectors } from "./value";

/**
 * From a solved preflop tree to the chart data of src/data/sets/preflopData.ts (§ numbers refer to the solver
 * design, which docs/preflop-solver.md carries). Pure: scripts/make-preflop.mjs runs the solves and calls this.
 *
 * Exported API
 * ------------
 * Scenario mapping (§6.4)
 *  - `classifyNode(tree, p)` / `classifyTree(tree)`: kind, id, Korean title, chip, public line, villain and the
 *    exported action (key, label with the stage's real size, color) of every tree action. Depends on the tree
 *    only, never on a strategy. The first matching row of §6.4 wins, with two additions made after the design:
 *      - every decision in a limped pot is `vsLimp` (checked before the vsShove and vs3bet rows, so the BB facing the
 *        SB's re-raise is `bb-iso-vs-sb-reraise`, not an "open vs 3-bet");
 *      - a cold player facing a non-all-in 3-bet with no callers (fold or jam only) is kind `vs3bet` with the generic
 *        id, title "<HERO> — <line> (콜드: 폴드·올인)" and the one action "콜드 올인".
 *  - `ladderGroup`: squeeze, vs4bet, vsShove and the cold vs3bet nodes form the size-ladder groups (§6.5).
 *
 * Export set and size ladder (§6.4, §6.5)
 *  - `LADDER_STEPS` (shares of dealt hands 0.1%, 0.2%, 0.5%, 1%), `BASE_THRESHOLD` (0.1%), `DATA_LIMITS`
 *    (PF-DATA-1's per-stage counts).
 *  - `exportSet(tree, classes, occ, steps)`: every rfi node, every other node at or above its threshold (its ladder
 *    group's, or 0.1%), and no node whose hero has an earlier decision that is not exported.
 *    That last rule never removes anything with these thresholds (occ only falls along a line, and an ancestor's
 *    threshold is never above its descendant's), but it keeps `reachFrom` complete whatever the thresholds are.
 *  - `countKinds`, `countProblems`, `chooseLadder`: the per-stage ladder steps, per group (squeeze, vs4bet, vsShove,
 *    cold vs3bet), the lowest that meet PF-DATA-1's counts. `raiseAll`: the gzip ladder's step over all stages,
 *    which the generator runs (it needs zlib). `thresholdsByKind`, `ladderThresholds`: the thresholds in %.
 *
 * Export (§4.4, §6.2, §6.5, §6.6)
 *  - `exportStage(input)`: the `PreflopStage`. Exported nodes are snapped to the 0.1 grid (snapStrategy); the hero's
 *    reach is the product of its earlier exported decisions' snapped frequencies (exactly what the UI computes from
 *    `reachFrom`), and hands out of reach are written as 0. Ranges are written by `rangeText`, which parseRange
 *    reads back exactly, so buildScenario's "earlier action takes first" fill reproduces the snapped values.
 *    Confidence follows §6.6: the stored (0.1pp) move of the sensitivity solves, lowered to 낮음 by PF-SANITY-5, -6,
 *    -7 or PF-TWOSTART, and capped at 보통 for vs3bet / vs4bet scenarios of stages of 55bb and more.
 *  - Draft runs (no sensitivity solves, no two-start solve, gates ignored, a capped schedule, or a two-start solve
 *    that failed its gates) are listed as drafts. Without sensitivity solves the move is 0 and never measured, so
 *    the badge is at most 보통 and the descriptions say so instead of claiming a measured move.
 *  - `rangeText(values)`: compact range text of a per-class vector of tenths.
 *
 * Sensitivity solves (§6.6)
 *  - `SENSITIVITY_VARIANTS`, `stageValuation(fit, features, variant?)`: the shipped model B valuation, or one of the
 *    five sensitivity variants (a) uncalibrated ×0.5, (b) ×1.5, (c) model B on 3 features, (d) Product's
 *    equity-scaled surplus form by position on every heads-up flop, (e) the old low-SPR rule SPR_ALPHA = 6.
 *
 * Checks on a stage's data (also usable on the committed file)
 *  - `decodeStage(stage)`: per scenario the hero's reach and the effective frequencies (buildScenario's fill).
 *  - `dataChecks(stage, limits?)`: PF-DATA-1. `stageSanity(stage)`: PF-SANITY-1..7. `stageBands(stage)`: PF-BANDS
 *    (published aggregates: printed warnings only, never targets).
 */

// ───────────── constants ─────────────

/** Korean stage labels of the shipped stages (main session decision 3; tree.ts's preset labels are older). */
export const STAGE_LABELS: Record<string, string> = {
  "100bb-2.2": "100bb · 오픈 2.2bb",
  "100bb-3": "100bb · 펍 사이즈 오픈 3bb",
  "55bb-2.2": "55bb · 오픈 2.2bb",
  "35bb-2": "35bb · 오픈 2bb",
};

/** Export order of the kinds within a stage. */
export const KIND_ORDER: readonly PreflopKind[] = ["rfi", "vsOpen", "vs3bet", "vs4bet", "squeeze", "vsLimp", "vsShove"];

/** Occ thresholds of the size ladder, as shares of dealt hands (§6.5). */
export const LADDER_STEPS: readonly number[] = [0.001, 0.002, 0.005, 0.01];
/** Every kind outside the ladder group (rfi, vsOpen, vsLimp, non-cold vs3bet) is exported from 0.1% of dealt hands. */
export const BASE_THRESHOLD = 0.001;

/** PF-DATA-1's per-stage counts. */
export interface DataLimits {
  rfi: number;
  vsOpen: [number, number];
  vsLimp: [number, number];
  /** At most this many of each other kind (cold vs3bet nodes count as vs3bet). */
  otherMax: number;
  total: number;
}

export const DATA_LIMITS: DataLimits = { rfi: 8, vsOpen: [30, 36], vsLimp: [1, 6], otherMax: 72, total: 180 };

/** §6.6 confidence: high below 8pp of movement, mid up to 20pp, low above. */
export const MOVE_HIGH = 8;
export const MOVE_MID = 20;
/** PF-TWOSTART: aggregates of scenarios with reach ≥ 1% must agree within 2pp. */
export const TWOSTART_MIN_REACH = 0.01;
export const TWOSTART_TOLERANCE = 0.02;

const VERB_KO: Record<Verb, string> = {
  fold: "폴드",
  check: "체크",
  call: "콜",
  limp: "림프",
  open: "오픈",
  iso: "레이즈",
  "3bet": "3벳",
  squeeze: "스퀴즈",
  reraise: "리레이즈",
  "4bet": "4벳",
  jam: "올인",
};

/** Sort rank of verbs in a line key (scenario order within a kind and hero). */
const VERB_RANK: Record<Verb, number> = { fold: 0, open: 1, limp: 2, check: 3, iso: 4, call: 5, "3bet": 6, squeeze: 7, reraise: 8, "4bet": 9, jam: 10 };

/** A size as the labels show it: at most one decimal ("15.18" → "15.2", "3" → "3"). */
export const fmtBb = (x: number) => String(Math.round(x * 10) / 10);

const round = (x: number, d: number) => {
  const k = 10 ** d;
  const v = Math.round(x * k) / k;
  return v === 0 ? 0 : v; // no -0 in the data
};

/** Seat ids as in nash.ts: lowercase, "+" → "p". */
const seatId = (name: string) => name.toLowerCase().replace("+", "p");

// ───────────── scenario mapping (§6.4) ─────────────

export interface ActionSpec {
  key: string;
  label: string;
  color: PreflopAction["color"];
}

export interface NodeClass {
  node: number;
  kind: PreflopKind;
  id: string;
  /** A generic id ("<hero>-at-<line>") rather than one of the fixed patterns. */
  generic: boolean;
  /** A cold player facing a non-all-in 3-bet: kind vs3bet, fold or jam only. */
  cold: boolean;
  hero: string;
  villain?: string;
  villainSeats?: string[];
  chip: string;
  title: string;
  /** Public line with sizes, e.g. "CO 2.2 · BTN 콜" (with the fold of a seat that had put chips in, `shownSteps`); "" for
   *  a first-in node. */
  line: string;
  /** The same line for the description, with "bb" on sizes; "" for a first-in node. */
  sizedLine: string;
  /** The node has no fold (the BB facing an SB limp). */
  noFold: boolean;
  /** Per tree action of the node (tree order), the exported action; null for the fold. */
  actions: (ActionSpec | null)[];
  /** Export order of the non-fold actions as tree action indices: tree order, except a check goes last. */
  order: number[];
  /** Sort key within a kind and hero: the non-fold line as (seat, verb) pairs. */
  sortKey: number[];
}

/** The non-fold actions of the line: they make the generic id (§6.4) and the sort key. */
const publicSteps = (info: NodeInfo): LineStep[] => info.line.filter((l) => l.verb !== "fold");

/**
 * The line as titles, chips and descriptions show it: every non-fold action, and the fold of a seat that had already
 * put voluntary chips in (an opener or 3-bettor folding to a jam). Without that fold "CO 오픈 → SB 올인" would read as
 * if CO were still live beside the hero, while the hero's decision is in fact heads-up with CO's chips dead. Folds of
 * seats with no voluntary chips (the blinds' forced bets do not count) change nothing and stay out.
 */
function shownSteps(info: NodeInfo): LineStep[] {
  const invested = new Set<number>();
  const out: LineStep[] = [];
  for (const l of info.line) {
    if (l.verb !== "fold") {
      out.push(l);
      if (l.verb !== "check") invested.add(l.seat);
    } else if (invested.has(l.seat)) out.push(l);
  }
  return out;
}

const RAISE_VERBS: ReadonlySet<Verb> = new Set<Verb>(["open", "iso", "3bet", "squeeze", "reraise", "4bet"]);

/**
 * Classifies decision node p (§6.4 and the two additions in the header). Throws if a node matches no row, so a tree
 * change that creates a new kind of spot cannot slip into the data unnamed.
 */
export function classifyNode(tree: PreflopTree, p: number): NodeClass {
  const info = tree.nodes[p];
  const names = seatNames(tree.n);
  const SB = tree.sbSeat, BB = tree.bbSeat;
  const s = info.seat;
  const H = names[s], h = seatId(H);
  const steps = publicSteps(info);
  const nm = (seat: number) => names[seat];
  const id = (seat: number) => seatId(names[seat]);
  const noCallers = info.callers.length === 0;

  /** A fixed §6.4 pattern: kind, id, title, chip and the one villain. */
  type Fixed = { kind: PreflopKind; id: string; title: string; chip: string; villain: number };
  const fx = (kind: PreflopKind, i: string, t: string, c: string, v: number): Fixed => ({ kind, id: i, title: t, chip: c, villain: v });
  let fixed: Fixed | null = null;
  let kind: PreflopKind | null = null;
  let cold = false;
  let overcall = false;

  if (info.raises === 0 && !info.limped && s !== BB) {
    fixed = fx("rfi", `rfi-${h}`, s === SB ? "SB 퍼스트 인 레인지" : `${H} 오픈 레인지`, H, -1);
  } else if (info.limped) {
    // Every limped-pot decision: the SB limped, so only the SB and the BB are left.
    if (s === BB && info.raises === 0) fixed = fx("vsLimp", "bb-vs-sb-limp", "BB vs SB 림프", "BB vs SB 림프", SB);
    else if (s === SB && info.raises === 1 && !info.facingJam) fixed = fx("vsLimp", "sb-limp-vs-bb-iso", "SB 림프 vs BB 레이즈", "SB 림프 vs BB 레이즈", BB);
    else if (s === SB && info.raises === 1 && info.facingJam) fixed = fx("vsLimp", "sb-limp-vs-bb-jam", "SB 림프 vs BB 올인", "SB 림프 vs BB 올인", BB);
    else if (s === BB && info.raises === 2 && !info.facingJam) fixed = fx("vsLimp", "bb-iso-vs-sb-reraise", "BB 레이즈 후 vs SB 리레이즈", "BB vs SB 리레이즈", SB);
    else if (s === BB && info.raises === 2 && info.facingJam) fixed = fx("vsLimp", "bb-iso-vs-sb-jam", "BB 레이즈 후 vs SB 올인", "BB vs SB 올인", SB);
    else if (s === SB && info.raises === 3 && info.facingJam) fixed = fx("vsLimp", "sb-reraise-vs-bb-jam", "SB 리레이즈 후 vs BB 올인", "SB vs BB 올인", BB);
    else throw new Error(`limped-pot node ${p} (${nm(s)}, raises ${info.raises}) matches no vsLimp pattern`);
  } else if (info.raises === 1 && !info.facingJam && noCallers && !info.heroActed) {
    const o = info.opener;
    fixed = fx("vsOpen", `${h}-vs-${id(o)}-open`, `${H} vs ${nm(o)} 오픈`, `${H} vs ${nm(o)}`, o);
  } else if (info.facingJam && info.jamFirstIn && !info.heroActed) {
    const j = info.jammer;
    fixed = fx("vsShove", `${h}-vs-${id(j)}-jam`, `${H} vs ${nm(j)} 올인`, `${H} vs ${nm(j)}`, j);
  } else if (info.raises === 2 && !info.facingJam && s === info.opener && noCallers) {
    const t = info.threeBettor;
    fixed = fx("vs3bet", `${h}-open-vs-${id(t)}-3bet`, `${H} 오픈 후 vs ${nm(t)} 3벳`, `${H} vs ${nm(t)} 3벳`, t);
  } else if (info.raises === 2 && info.facingJam && s === info.opener && noCallers && info.jammer === info.threeBettor) {
    const j = info.jammer;
    fixed = fx("vs3bet", `${h}-open-vs-${id(j)}-jam`, `${H} 오픈 후 vs ${nm(j)} 3벳 올인`, `${H} vs ${nm(j)} 올인`, j);
  } else if (info.raises === 3 && !info.facingJam && s === info.threeBettor && noCallers && info.lastRaiser === info.opener) {
    const o = info.opener;
    fixed = fx("vs4bet", `${h}-3bet-vs-${id(o)}-4bet`, `${H} 3벳 후 vs ${nm(o)} 4벳`, `${H} vs ${nm(o)} 4벳`, o);
  } else if (info.raises === 3 && info.facingJam && s === info.threeBettor && noCallers && info.jammer === info.opener) {
    const o = info.opener;
    fixed = fx("vs4bet", `${h}-3bet-vs-${id(o)}-4bet-jam`, `${H} 3벳 후 vs ${nm(o)} 4벳 올인`, `${H} vs ${nm(o)} 4벳 올인`, o);
  } else if (
    info.raises === 4 &&
    info.facingJam &&
    s === info.opener &&
    noCallers &&
    info.jammer === info.threeBettor &&
    info.raiseSeq.length === 4 &&
    info.raiseSeq[0] === info.opener &&
    info.raiseSeq[1] === info.threeBettor &&
    info.raiseSeq[2] === info.opener
  ) {
    const t = info.threeBettor;
    fixed = fx("vs4bet", `${h}-4bet-vs-${id(t)}-jam`, `${H} 4벳 후 vs ${nm(t)} 5벳 올인`, `${H} vs ${nm(t)} 5벳 올인`, t);
  } else if (!noCallers) {
    kind = "squeeze";
    overcall = info.raises === 1 && !info.facingJam;
  } else if (info.raises === 2 && !info.facingJam && s !== info.opener) {
    kind = "vs3bet";
    cold = true;
  } else if (info.raises >= 3) kind = "vs4bet";
  else if (info.facingJam) kind = "vsShove";
  const k = fixed ? fixed.kind : kind;
  if (k === null) throw new Error(`node ${p} (${nm(s)}, raises ${info.raises}) matches no §6.4 row`);

  const generic = fixed === null;
  const shown = shownSteps(info);
  const titleLine = shown.map((l) => `${nm(l.seat)} ${VERB_KO[l.verb]}`).join(" → ");
  const chipLine = shown.map((l) => `${nm(l.seat)}${VERB_KO[l.verb]}`).join("·");
  // Seats still in that acted voluntarily, in order of their first action: the hero's opponents on this line.
  const opponents: number[] = [];
  for (const l of steps) if (l.seat !== s && info.active.includes(l.seat) && !opponents.includes(l.seat)) opponents.push(l.seat);
  let villainSeats: string[] | undefined;
  let villainName: string | undefined;
  let title: string;
  let chip: string;
  if (fixed) {
    title = fixed.title;
    chip = fixed.chip;
    if (fixed.villain >= 0) {
      villainSeats = [nm(fixed.villain)];
      villainName = nm(fixed.villain);
    }
  } else {
    villainSeats = opponents.map(nm);
    const v = info.lastRaiser >= 0 && info.lastRaiser !== s && info.active.includes(info.lastRaiser) ? info.lastRaiser : opponents[0];
    villainName = v === undefined ? undefined : nm(v);
    chip = chipLine;
    if (cold) title = `${H} — ${titleLine} (콜드: 폴드·올인)`;
    else if (k === "squeeze" && overcall && !info.heroActed) {
      // The common multiway spot reads better as "BB vs CO 오픈 + BTN 콜" (§6.4 titles).
      title = `${H} vs ${nm(info.opener)} 오픈 + ${info.callers.map(nm).join("·")} 콜`;
    } else title = `${H} — ${titleLine}`;
  }
  const genericId = `${h}-at-${steps.map((l) => `${id(l.seat)}-${l.verb}`).join("-")}`;

  const sbFirstIn = k === "rfi" && s === SB;
  const actions = info.actions.map((a) => actionSpec(a, { cold, overcall, sbFirstIn }));
  const nonFold = info.actions.map((_, i) => i).filter((i) => actions[i] !== null);
  const order = [...nonFold.filter((i) => info.actions[i].verb !== "check"), ...nonFold.filter((i) => info.actions[i].verb === "check")];
  const sortKey = steps.flatMap((l) => [l.seat, VERB_RANK[l.verb]]);

  return {
    node: p,
    kind: k,
    id: fixed ? fixed.id : genericId,
    generic,
    cold,
    hero: H,
    villain: villainName,
    villainSeats,
    chip,
    title,
    line: shown.map((l) => publicStep(l, nm)).join(" · "),
    sizedLine: shown.map((l) => (RAISE_VERBS.has(l.verb) ? `${nm(l.seat)} ${VERB_KO[l.verb]} ${fmtBb(l.to)}bb` : `${nm(l.seat)} ${VERB_KO[l.verb]}`)).join(" → "),
    noFold: tree.foldIdx[p] < 0,
    actions,
    order,
    sortKey,
  };
}

function publicStep(l: LineStep, nm: (s: number) => string): string {
  const who = nm(l.seat);
  if (l.verb === "open") return `${who} ${fmtBb(l.to)}`;
  if (RAISE_VERBS.has(l.verb)) return `${who} ${VERB_KO[l.verb]} ${fmtBb(l.to)}`;
  return `${who} ${VERB_KO[l.verb]}`;
}

function actionSpec(a: ActionInfo, ctx: { cold: boolean; overcall: boolean; sbFirstIn: boolean }): ActionSpec | null {
  const size = fmtBb(a.to);
  switch (a.verb) {
    case "fold":
      return null;
    case "call":
      return ctx.overcall ? { key: "overcall", label: "오버콜", color: "call" } : { key: "call", label: "콜", color: "call" };
    case "check":
      return { key: "check", label: "체크", color: "call" };
    case "limp":
      return { key: "limp", label: "림프", color: "call" };
    case "open":
      // The SB's first-in raise keeps the key "raise" (it sits next to 림프) but reads "오픈", as in cash6 and in every
      // later spot of its line ("SB 오픈 후 vs BB 3벳", "BB vs SB 오픈").
      return ctx.sbFirstIn ? { key: "raise", label: `오픈 ${size}bb`, color: "raise" } : { key: "open", label: `오픈 ${size}bb`, color: "raise" };
    case "iso":
      return { key: "raise", label: `레이즈 ${size}bb`, color: "raise" };
    case "3bet":
      return { key: "3bet", label: `3벳 ${size}bb`, color: "raise" };
    case "squeeze":
      return { key: "squeeze", label: `스퀴즈 ${size}bb`, color: "raise" };
    case "reraise":
      return { key: "raise", label: `리레이즈 ${size}bb`, color: "raise" };
    case "4bet":
      return { key: "4bet", label: `4벳 ${size}bb`, color: "raise" };
    case "jam":
      return { key: "shove", label: ctx.cold ? "콜드 올인" : "올인", color: "allin" };
  }
}

/** Every node classified; throws if two nodes would get the same id. */
export function classifyTree(tree: PreflopTree): NodeClass[] {
  const out: NodeClass[] = [];
  const seen = new Map<string, number>();
  for (let p = 0; p < tree.nodeCount; p++) {
    const c = classifyNode(tree, p);
    const prev = seen.get(c.id);
    if (prev !== undefined) throw new Error(`scenario id ${c.id} for nodes ${prev} and ${p}`);
    seen.set(c.id, p);
    out.push(c);
  }
  return out;
}

// ───────────── export set and size ladder (§6.4, §6.5) ─────────────

/**
 * The size-ladder groups (§6.5, main session decision 2): squeeze, vs4bet, vsShove and the cold vs3bet nodes. Each has
 * its own step, raised only as far as its own count needs: one shared step would have to reach 1% at 100bb just to
 * cut the 84 cold nodes (36 + 84 vs3bet > 72), which drops every vs4bet chart. `shared: true` moves them together.
 */
export type LadderGroup = "squeeze" | "vs4bet" | "vsShove" | "cold";
export const LADDER_GROUPS: readonly LadderGroup[] = ["squeeze", "vs4bet", "vsShove", "cold"];
/** Per group, an index into LADDER_STEPS. */
export type LadderSteps = Record<LadderGroup, number>;
export const LADDER_START: LadderSteps = { squeeze: 0, vs4bet: 0, vsShove: 0, cold: 0 };

export const ladderGroup = (c: NodeClass): LadderGroup | null =>
  c.cold ? "cold" : c.kind === "squeeze" || c.kind === "vs4bet" || c.kind === "vsShove" ? c.kind : null;

/** The occ threshold of node class c under the ladder steps, as a share of dealt hands. */
export function thresholdOf(c: NodeClass, steps: LadderSteps): number {
  const g = ladderGroup(c);
  return g ? LADDER_STEPS[steps[g]] : BASE_THRESHOLD;
}

export interface ExportSet {
  /** 1 for exported nodes. */
  exported: Uint8Array;
  /** Nodes that passed their threshold but were left out because a hero ancestor was not exported. */
  omitted: number[];
}

/**
 * The exported nodes under the ladder steps. Nodes are numbered in DFS pre-order, so every ancestor is decided
 * before its descendants.
 */
export function exportSet(tree: PreflopTree, classes: readonly NodeClass[], occ: ArrayLike<number>, steps: LadderSteps): ExportSet {
  const exported = new Uint8Array(tree.nodeCount);
  const omitted: number[] = [];
  for (let p = 0; p < tree.nodeCount; p++) {
    const c = classes[p];
    if (c.kind !== "rfi" && !(occ[p] >= thresholdOf(c, steps))) continue;
    let ok = true;
    const s = tree.seat[p];
    for (let q = tree.parent[p]; q >= 0; q = tree.parent[q]) if (tree.seat[q] === s && !exported[q]) ok = false;
    if (ok) exported[p] = 1;
    else omitted.push(p);
  }
  return { exported, omitted };
}

export type KindCounts = Record<PreflopKind, number> & { cold: number; total: number };

export function countKinds(classes: readonly NodeClass[], exported: Uint8Array): KindCounts {
  const c: KindCounts = { rfi: 0, vsOpen: 0, vs3bet: 0, vs4bet: 0, squeeze: 0, vsLimp: 0, vsShove: 0, cold: 0, total: 0 };
  for (let p = 0; p < classes.length; p++) {
    if (!exported[p]) continue;
    c[classes[p].kind]++;
    if (classes[p].cold) c.cold++;
    c.total++;
  }
  return c;
}

/** What breaks PF-DATA-1's counts; empty when they hold. */
export function countProblems(c: KindCounts, limits: DataLimits = DATA_LIMITS): string[] {
  const out: string[] = [];
  if (c.rfi !== limits.rfi) out.push(`rfi ${c.rfi} ≠ ${limits.rfi}`);
  if (c.vsOpen < limits.vsOpen[0] || c.vsOpen > limits.vsOpen[1]) out.push(`vsOpen ${c.vsOpen} outside ${limits.vsOpen.join("–")}`);
  if (c.vsLimp < limits.vsLimp[0] || c.vsLimp > limits.vsLimp[1]) out.push(`vsLimp ${c.vsLimp} outside ${limits.vsLimp.join("–")}`);
  for (const k of ["vs3bet", "vs4bet", "squeeze", "vsShove"] as const) if (c[k] > limits.otherMax) out.push(`${k} ${c[k]} > ${limits.otherMax}`);
  if (c.total > limits.total) out.push(`total ${c.total} > ${limits.total}`);
  return out;
}

export interface LadderChoice {
  /** The steps reached (the last ones tried when `ok` is false). */
  steps: LadderSteps;
  ok: boolean;
  set: ExportSet;
  counts: KindCounts;
  /** What still breaks the counts (empty when ok). */
  problems: string[];
}

/**
 * Main session decision 2: from `start`, raise ladder groups one step at a time until the stage meets PF-DATA-1's
 * counts. Per group (default): a group whose own kind is over the limit moves up (the cold nodes when vs3bet is over);
 * if only the total is over, every group below the top step moves up. With `shared`, all groups move together.
 * rfi, vsOpen, vsLimp and non-cold vs3bet never move. Deterministic: the same occ gives the same steps.
 */
export function chooseLadder(
  tree: PreflopTree,
  classes: readonly NodeClass[],
  occ: ArrayLike<number>,
  options: { limits?: DataLimits; shared?: boolean; start?: LadderSteps } = {},
): LadderChoice {
  const limits = options.limits ?? DATA_LIMITS;
  const top = LADDER_STEPS.length - 1;
  const steps: LadderSteps = { ...(options.start ?? LADDER_START) };
  if (options.shared) {
    const m = Math.max(...LADDER_GROUPS.map((g) => steps[g]));
    for (const g of LADDER_GROUPS) steps[g] = m;
  }
  for (;;) {
    const set = exportSet(tree, classes, occ, steps);
    const counts = countKinds(classes, set.exported);
    const problems = countProblems(counts, limits);
    if (!problems.length) return { steps, ok: true, set, counts, problems };
    const over = (g: LadderGroup) => counts[g === "cold" ? "vs3bet" : g] > limits.otherMax;
    let raise = options.shared ? [...LADDER_GROUPS] : LADDER_GROUPS.filter(over);
    if (!raise.length && counts.total > limits.total) raise = [...LADDER_GROUPS];
    raise = raise.filter((g) => steps[g] < top);
    if (!raise.length) return { steps, ok: false, set, counts, problems };
    for (const g of raise) steps[g]++;
  }
}

/** Every group one step up (capped at the top step): the gzip ladder's move. Null when all are at the top. */
export function raiseAll(steps: LadderSteps): LadderSteps | null {
  const top = LADDER_STEPS.length - 1;
  if (LADDER_GROUPS.every((g) => steps[g] >= top)) return null;
  const out = { ...steps };
  for (const g of LADDER_GROUPS) out[g] = Math.min(top, out[g] + 1);
  return out;
}

/**
 * occThresholdByKind in % of dealt hands. vs3bet gets the threshold of its non-cold nodes, the lowest, which every
 * vs3bet scenario meets; the cold nodes' own threshold is the "cold" group's (`ladderThresholds`).
 */
export function thresholdsByKind(steps: LadderSteps): Record<PreflopKind, number> {
  const base = round(BASE_THRESHOLD * 100, 4);
  const lad = (g: LadderGroup) => round(LADDER_STEPS[steps[g]] * 100, 4);
  return { rfi: base, vsOpen: base, vs3bet: base, vs4bet: lad("vs4bet"), squeeze: lad("squeeze"), vsLimp: base, vsShove: lad("vsShove") };
}

/** Per ladder group, its threshold in % of dealt hands. */
export function ladderThresholds(steps: LadderSteps): Record<LadderGroup, number> {
  return Object.fromEntries(LADDER_GROUPS.map((g) => [g, round(LADDER_STEPS[steps[g]] * 100, 4)])) as Record<LadderGroup, number>;
}

// ───────────── range text ─────────────

const HAND_INDEX = new Map(ALL_HANDS.map((hand, i) => [hand, i]));

/**
 * Compact range text of a per-class vector (ALL_HANDS order) whose entries are multiples of 0.1, e.g.
 * "TT+, 99:0.5, A2s+, KTs-K6s:0.3". One token per run of equal values: pairs top-down, then suited and offsuit hands
 * by high card. parseRange reads it back to exactly the same numbers (k/10 and Number("0.k") are the same double).
 */
export function rangeText(values: ArrayLike<number>): string {
  if (values.length !== ALL_HANDS.length) throw new Error(`a range needs ${ALL_HANDS.length} values`);
  const val = (hand: string) => values[HAND_INDEX.get(hand)!];
  const levels = [...new Set(Array.from(values).filter((v) => v > 0))].sort((a, b) => b - a);
  const parts: string[] = [];
  for (const v of levels) {
    const suffix = v === 1 ? "" : `:${v}`;
    const pair = (r: number) => RANKS[r] + RANKS[r];
    for (const run of runsOf(desc(13), (r) => val(pair(r)) === v)) {
      const hi = run[0], lo = run[run.length - 1];
      parts.push((run.length === 1 ? pair(hi) : hi === 12 ? `${pair(lo)}+` : `${pair(hi)}-${pair(lo)}`) + suffix);
    }
    for (const kind of ["s", "o"]) {
      for (let hi = 12; hi >= 1; hi--) {
        const name = (k: number) => RANKS[hi] + RANKS[k] + kind;
        for (const run of runsOf(desc(hi), (k) => val(name(k)) === v)) {
          const top = run[0], low = run[run.length - 1];
          parts.push((run.length === 1 ? name(top) : top === hi - 1 ? `${name(low)}+` : `${name(top)}-${name(low)}`) + suffix);
        }
      }
    }
  }
  return parts.join(", ");
}

/** n−1 down to 0. */
const desc = (n: number) => Array.from({ length: n }, (_, i) => n - 1 - i);

function runsOf(idx: number[], hit: (i: number) => boolean): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  for (const i of idx) {
    if (hit(i)) cur.push(i);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

// ───────────── sensitivity valuations (§6.6) ─────────────

export type SensitivityVariant = "a" | "b" | "c" | "d" | "e";

export const SENSITIVITY_VARIANTS: readonly { id: SensitivityVariant; label: string }[] = [
  { id: "a", label: "uncalibrated priors ×0.5 (c off-context, multiway c_pos and u, α_mw)" },
  { id: "b", label: "uncalibrated priors ×1.5" },
  { id: "c", label: "model B on 3 features" },
  { id: "d", label: "equity-scaled surplus form (5 features) by position on HU flops" },
  { id: "e", label: "old low-SPR rule (SPR_ALPHA = 6)" },
];

/** The fields of EQR_FIT the valuations read. */
export type FitForValuation = Pick<EqrFit, "alpha" | "cFit" | "thetaO" | "thetaI" | "kappa3" | "kappa4" | "alternatives">;

/**
 * Heads-up flop vectors of variant (d): Product's equity-scaled surplus form, Φ_O = R_O(h)·e − (R_I(x) − 1)·(1 − e),
 * by position (O acts first and uses rO of its class, I uses rI of its class), with model B's SPR shrink
 * s = min(1, SPR / SPR_SURPLUS) applied to the surplus part: R → 1 + s·(R − 1). The vectors depend on the SPR only,
 * so they are shared between terminals of equal SPR.
 */
export function productFormHu(rO: ArrayLike<number>, rI: ArrayLike<number>, sprSurplus = SPR_SURPLUS): (tree: PreflopTree, t: number) => PairwiseVectors {
  const cache = new Map<number, PairwiseVectors>();
  const N = rO.length;
  return (tree, t) => {
    const s = surplusShrink(tree.termSpr[t], sprSurplus);
    let v = cache.get(s);
    if (!v) {
      const ro = new Float64Array(N), ri = new Float64Array(N);
      for (let h = 0; h < N; h++) {
        // At s = 1 the fitted vectors themselves, not 1 + (R − 1), which can differ in the last bit.
        ro[h] = s === 1 ? rO[h] : 1 + s * (rO[h] - 1);
        ri[h] = s === 1 ? rI[h] : 1 + s * (rI[h] - 1);
      }
      v = equityScaledSurplusVectors(ro, ri);
      cache.set(s, v);
    }
    return v;
  };
}

/** The shipped valuation (variant omitted) or one of the five sensitivity variants of §6.6. */
export function stageValuation(fit: FitForValuation, features: Float64Array, variant?: SensitivityVariant): Valuation {
  const base: ModelBParams = { alpha: fit.alpha, cFit: fit.cFit, thetaO: fit.thetaO, thetaI: fit.thetaI, kappa3: fit.kappa3, kappa4: fit.kappa4 };
  // (a), (b): every parameter that no pack calibrates: c outside (SRP, IP aggressor), the multiway c_pos, the
  // multiway u term and α_mw (whose prior is α).
  const scaled = (k: number): ModelBParams => ({ ...base, cDerivedScale: k, mwCPos: MW_C_POS * k, mwUScale: k, alphaMw: fit.alpha * k });
  switch (variant) {
    case undefined:
      return { kind: "modelB", params: base, features };
    case "a":
      return { kind: "modelB", params: scaled(0.5), features };
    case "b":
      return { kind: "modelB", params: scaled(1.5), features };
    case "c": {
      const m = fit.alternatives.modelB3;
      return { kind: "modelB", params: { ...base, alpha: m.alpha, cFit: m.cFit, thetaO: m.thetaO, thetaI: m.thetaI }, features };
    }
    case "d": {
      const pf = fit.alternatives.product5;
      return { kind: "modelB", params: base, features, hu: productFormHu(pf.rO, pf.rI) };
    }
    case "e":
      return { kind: "modelB", params: { ...base, sprAlpha: 6 }, features };
  }
}

// ───────────── decoding a stage's data (what the UI sees) ─────────────

export interface DecodedScenario {
  scenario: PreflopScenario;
  /** The hero's reach per class (ALL_HANDS order): the product of the reachFrom actions' range values. */
  rho: Float64Array;
  /** Effective frequency per action key (buildScenario's fill), and the fold remainder. */
  freq: Record<string, Float64Array>;
  fold: Float64Array;
  /** Raw range values per action key, as parsed. */
  raw: Record<string, Float64Array>;
}

const toVector = (text: string) => {
  const r = parseRange(text);
  return Float64Array.from(ALL_HANDS, (hand) => r[hand] ?? 0);
};

/**
 * Per scenario, the reach and effective frequencies the app derives from the data: reach from `reachFrom`
 * (Π of the referenced actions' range values), frequencies by buildScenario's fill (each action takes
 * min(range, what is left), in order; fold gets the rest). A broken reference throws.
 */
export function decodeStage(stage: PreflopStage): Map<string, DecodedScenario> {
  const out = new Map<string, DecodedScenario>();
  const raws = new Map<string, Record<string, Float64Array>>();
  for (const sc of stage.scenarios) {
    const raw: Record<string, Float64Array> = {};
    for (const a of sc.actions) raw[a.key] = toVector(a.range);
    raws.set(sc.id, raw);
  }
  for (const sc of stage.scenarios) {
    const rho = new Float64Array(ALL_HANDS.length).fill(1);
    for (const ref of sc.reachFrom ?? []) {
      const [id, key] = ref.split(":");
      const r = raws.get(id)?.[key];
      if (!r) throw new Error(`${sc.id}: reachFrom ${ref} names no exported action`);
      for (let h = 0; h < rho.length; h++) rho[h] *= r[h];
    }
    const raw = raws.get(sc.id)!;
    const freq: Record<string, Float64Array> = {};
    const fold = new Float64Array(ALL_HANDS.length);
    for (const a of sc.actions) freq[a.key] = new Float64Array(ALL_HANDS.length);
    for (let h = 0; h < ALL_HANDS.length; h++) {
      let left = 1;
      for (const a of sc.actions) {
        const f = Math.min(raw[a.key][h], left);
        freq[a.key][h] = f;
        left -= f;
      }
      fold[h] = Math.max(0, left);
    }
    out.set(sc.id, { scenario: sc, rho, freq, fold, raw });
  }
  return out;
}

const CW = comboWeights();
const CW_SUM = 1326;

/** Per action key and "fold": the share of the hero's reaching range in % (reach-relative, §6.3). */
export function reachShares(d: DecodedScenario): Record<string, number> {
  let den = 0;
  const num: Record<string, number> = { fold: 0 };
  for (const a of d.scenario.actions) num[a.key] = 0;
  for (let h = 0; h < ALL_HANDS.length; h++) {
    const w = CW[h] * d.rho[h];
    den += w;
    for (const a of d.scenario.actions) num[a.key] += w * d.freq[a.key][h];
    num.fold += w * d.fold[h];
  }
  for (const k of Object.keys(num)) num[k] = den > 0 ? (num[k] / den) * 100 : 0;
  return num;
}

/** Share of all 1326 combos, in %, that reach the node and play (do not fold). */
function playsOfAll(d: DecodedScenario): number {
  let x = 0;
  for (let h = 0; h < ALL_HANDS.length; h++) x += CW[h] * d.rho[h] * (1 - d.fold[h]);
  return (x / CW_SUM) * 100;
}

/** Share of all combos, in %, taking one of `keys`. */
function shareOfAll(d: DecodedScenario, keys: string[]): number {
  let x = 0;
  for (let h = 0; h < ALL_HANDS.length; h++) for (const k of keys) x += CW[h] * d.rho[h] * (d.freq[k]?.[h] ?? 0);
  return (x / CW_SUM) * 100;
}

// ───────────── PF-DATA-1, PF-SANITY, PF-BANDS on a stage's data ─────────────

/** PF-DATA-1 (§5.2): what is wrong with a stage's data; empty when it passes. */
export function dataChecks(stage: PreflopStage, limits: DataLimits = DATA_LIMITS): string[] {
  const out: string[] = [];
  const counts: KindCounts = { rfi: 0, vsOpen: 0, vs3bet: 0, vs4bet: 0, squeeze: 0, vsLimp: 0, vsShove: 0, cold: 0, total: 0 };
  const ids = new Set<string>();
  for (const sc of stage.scenarios) {
    counts[sc.kind]++;
    counts.total++;
    if (ids.has(sc.id)) out.push(`duplicate id ${sc.id}`);
    ids.add(sc.id);
    if (sc.kind !== "rfi" && !(sc.occ >= stage.occThresholdByKind[sc.kind])) out.push(`${sc.id}: occ ${sc.occ} below ${stage.occThresholdByKind[sc.kind]}`);
  }
  for (const k of KIND_ORDER) if (!(stage.occThreshold <= stage.occThresholdByKind[k])) out.push(`occThreshold ${stage.occThreshold} above ${k}'s`);
  out.push(...countProblems(counts, limits));
  const byId = new Map(stage.scenarios.map((s) => [s.id, s]));
  for (const sc of stage.scenarios) {
    for (const ref of sc.reachFrom ?? []) {
      const [id, key] = ref.split(":");
      const t = byId.get(id);
      if (!t) out.push(`${sc.id}: reachFrom ${ref} is not exported`);
      else if (t.hero !== sc.hero) out.push(`${sc.id}: reachFrom ${ref} has hero ${t.hero}`);
      else if (!t.actions.some((a) => a.key === key)) out.push(`${sc.id}: reachFrom ${ref} names no action of ${id}`);
    }
    for (const a of sc.actions) {
      try {
        parseRange(a.range);
      } catch (e) {
        out.push(`${sc.id}:${a.key} does not parse (${(e as Error).message})`);
      }
    }
  }
  if (out.length) return out;
  for (const d of decodeStage(stage).values()) {
    for (let h = 0; h < ALL_HANDS.length; h++) {
      let sum = 0;
      for (const a of d.scenario.actions) sum += d.raw[a.key][h];
      if (sum > 1 + 1e-9) out.push(`${d.scenario.id} ${ALL_HANDS[h]}: frequencies sum to ${sum}`);
      if (!(d.rho[h] > 0) && sum !== 0) out.push(`${d.scenario.id} ${ALL_HANDS[h]}: out of reach but has frequencies`);
    }
  }
  return out;
}

/** The pairs of PF-SANITY-2's monotone chains, [better, worse]. */
export function monotoneChains(): [string, string][] {
  const out: [string, string][] = [];
  for (let r = 12; r >= 1; r--) out.push([RANKS[r] + RANKS[r], RANKS[r - 1] + RANKS[r - 1]]);
  for (let hi = 12; hi >= 1; hi--) for (let lo = hi - 1; lo >= 0; lo--) out.push([RANKS[hi] + RANKS[lo] + "s", RANKS[hi] + RANKS[lo] + "o"]);
  const ladder = (hands: string[]) => {
    for (let i = 0; i + 1 < hands.length; i++) out.push([hands[i], hands[i + 1]]);
  };
  ladder(["AKo", "AQo", "AJo", "ATo"]);
  ladder(["KQo", "KJo", "KTo"]);
  ladder(["QJo", "QTo"]);
  return out;
}

/**
 * The pairs of PF-SANITY-7's kicker chains, [better, worse]: Ax ≥ Kx with the same kicker 2–9 (suited and offsuit),
 * and in every row the higher kicker ≥ the next lower one (suited and offsuit), except below A6 in the ace row, where
 * the wheel aces may rightly play more than A6–A9. A strong player rejects a chart that breaks these at a glance, and
 * the realization fit is known to (no weak-king feature; the weak-ace and broadway coefficients are poorly identified),
 * so they warn and badge the spot instead of failing like PF-SANITY-2.
 */
export function kickerChains(): [string, string][] {
  const out: [string, string][] = [];
  for (const sfx of ["s", "o"]) for (let k = 0; k <= 7; k++) out.push([RANKS[12] + RANKS[k] + sfx, RANKS[11] + RANKS[k] + sfx]);
  for (const sfx of ["s", "o"])
    for (let hi = 12; hi >= 2; hi--)
      for (let lo = hi - 1; lo >= 1; lo--) {
        if (hi === 12 && lo - 1 <= 3) continue; // A6x vs A5x and below: the wheel aces
        out.push([RANKS[hi] + RANKS[lo] + sfx, RANKS[hi] + RANKS[lo - 1] + sfx]);
      }
  return out;
}

export interface SanityReport {
  /** Checks whose data test fails (PF-SANITY-1 above 2pp, -2, -3). */
  fails: string[];
  warns: string[];
  /** Scenarios flagged by PF-SANITY-5 (cold call in % of all hands) and PF-SANITY-6 (shares of the reaching range,
   *  %); both are badged 낮음. */
  sanity5: { id: string; callPct: number }[];
  sanity6: { id: string; jamPct: number; fourBetPct: number }[];
  /** Scenarios flagged by PF-SANITY-7 with their worst pair (plays, 0..1); badged 낮음. */
  sanity7: { id: string; better: string; worse: string; pBetter: number; pWorse: number }[];
}

const EP_OPENERS = new Set(["UTG", "UTG+1", "UTG+2", "LJ"]);

/** PF-SANITY-1..6 (§5.2) on a stage's data, as the app sees it. Scenarios are found by their §6.4 ids. */
export function stageSanity(stage: PreflopStage, decoded = decodeStage(stage)): SanityReport {
  const rep: SanityReport = { fails: [], warns: [], sanity5: [], sanity6: [], sanity7: [] };
  const get = (id: string) => decoded.get(id);
  const rfi = stage.scenarios.filter((s) => s.kind === "rfi");
  const seats = rfi.map((s) => s.hero);
  const f1 = (x: number) => x.toFixed(1);
  // PF-SANITY-1: RFI (open + jam, not fold) rises UTG → BTN.
  const rfiTotals = rfi.filter((s) => s.hero !== "SB").map((s) => ({ seat: s.hero, v: playsOfAll(get(s.id)!) }));
  for (let j = 1; j < rfiTotals.length; j++)
    for (let i = 0; i < j; i++) {
      const gap = rfiTotals[i].v - rfiTotals[j].v;
      const msg = `PF-SANITY-1 RFI ${rfiTotals[j].seat} ${f1(rfiTotals[j].v)} < ${rfiTotals[i].seat} ${f1(rfiTotals[i].v)}`;
      if (gap > 2) rep.fails.push(msg);
      else if (gap > 0.5) rep.warns.push(msg);
    }
  // PF-SANITY-2: monotone chains on "plays" in RFI and BB defense, tolerance 0.15.
  const chainIds = [...rfi.map((s) => s.id), ...stage.scenarios.filter((s) => s.kind === "vsOpen" && s.hero === "BB").map((s) => s.id)];
  const chains = monotoneChains();
  for (const id of chainIds) {
    const d = get(id)!;
    for (const [a, b] of chains) {
      const ia = HAND_INDEX.get(a)!, ib = HAND_INDEX.get(b)!;
      const pa = 1 - d.fold[ia], pb = 1 - d.fold[ib];
      if (pa < pb - 0.15 - 1e-9) rep.fails.push(`PF-SANITY-2 ${id}: ${a} plays ${pa.toFixed(2)} < ${b} ${pb.toFixed(2)}`);
    }
  }
  // PF-SANITY-7 (warning): the kicker chains on the same spots and tolerance; a spot with a hit is badged 낮음 and
  // names its worst pair (the largest gap; the first in chain order on a tie).
  const kickers = kickerChains();
  for (const id of chainIds) {
    const d = get(id)!;
    let worst: SanityReport["sanity7"][number] | null = null;
    let hits = 0;
    for (const [a, b] of kickers) {
      const pa = 1 - d.fold[HAND_INDEX.get(a)!], pb = 1 - d.fold[HAND_INDEX.get(b)!];
      if (!(pa < pb - 0.15 - 1e-9)) continue;
      hits++;
      if (!worst || pb - pa > worst.pWorse - worst.pBetter + 1e-12) worst = { id, better: a, worse: b, pBetter: pa, pWorse: pb };
    }
    if (worst) {
      rep.warns.push(`PF-SANITY-7 ${id}: ${hits} kicker pair(s) inverted, worst ${worst.better} plays ${worst.pBetter.toFixed(2)} < ${worst.worse} ${worst.pWorse.toFixed(2)}`);
      rep.sanity7.push(worst);
    }
  }
  // PF-SANITY-3: BB defense rises with the opener's seat; BB vs SB ≥ BB vs BTN − 2pp.
  const bbDef = seats.map((o) => ({ seat: o, d: get(`bb-vs-${seatId(o)}-open`) })).filter((x) => x.d).map((x) => ({ seat: x.seat, v: playsOfAll(x.d!) }));
  const lp = bbDef.filter((x) => x.seat !== "SB");
  for (let j = 1; j < lp.length; j++)
    for (let i = 0; i < j; i++)
      if (lp[j].v < lp[i].v - 2) rep.fails.push(`PF-SANITY-3 BB defense vs ${lp[j].seat} ${f1(lp[j].v)} < vs ${lp[i].seat} ${f1(lp[i].v)}`);
  const vsSb = bbDef.find((x) => x.seat === "SB"), vsBtn = bbDef.find((x) => x.seat === "BTN");
  if (vsSb && vsBtn && vsSb.v < vsBtn.v - 2) rep.fails.push(`PF-SANITY-3 BB defense vs SB ${f1(vsSb.v)} < vs BTN ${f1(vsBtn.v)} − 2`);
  // PF-SANITY-4: 3-bet % (3-bet or jam) vs an opener rises EP → LP for BTN, SB and BB.
  for (const hero of ["BTN", "SB", "BB"]) {
    const xs = seats
      .filter((o) => seats.indexOf(o) < (hero === "BB" ? seats.length : seats.indexOf(hero)))
      .map((o) => ({ seat: o, d: get(`${seatId(hero)}-vs-${seatId(o)}-open`) }))
      .filter((x) => x.d)
      .map((x) => ({ seat: x.seat, v: shareOfAll(x.d!, ["3bet", "shove"]) }));
    for (let j = 1; j < xs.length; j++)
      for (let i = 0; i < j; i++) if (xs[j].v < xs[i].v - 2) rep.warns.push(`PF-SANITY-4 ${hero} 3-bet vs ${xs[j].seat} ${f1(xs[j].v)} < vs ${xs[i].seat} ${f1(xs[i].v)}`);
  }
  // PF-SANITY-5: a non-blind cold call vs a UTG–LJ open is at most 10% of all hands.
  for (const sc of stage.scenarios) {
    if (sc.kind !== "vsOpen" || sc.hero === "SB" || sc.hero === "BB" || !sc.villain || !EP_OPENERS.has(sc.villain)) continue;
    const v = shareOfAll(get(sc.id)!, ["call"]);
    if (v > 10) {
      rep.warns.push(`PF-SANITY-5 ${sc.id}: cold call ${f1(v)}% of all hands`);
      rep.sanity5.push({ id: sc.id, callPct: v });
    }
  }
  // PF-SANITY-6 (≥ 55bb): the opener's 4-bet jam share is at most the small 4-bet share + 2pp. Only scenarios with
  // both actions: a cold vs3bet node has no small 4-bet, so the check says nothing about it.
  if (stage.stack >= 55) {
    for (const sc of stage.scenarios) {
      if (sc.kind !== "vs3bet" || !sc.actions.some((a) => a.key === "4bet") || !sc.actions.some((a) => a.key === "shove")) continue;
      const sh = reachShares(get(sc.id)!);
      if (sh.shove > sh["4bet"] + 2) {
        rep.warns.push(`PF-SANITY-6 ${sc.id}: jam ${f1(sh.shove)}% > small 4-bet ${f1(sh["4bet"])}% + 2`);
        rep.sanity6.push({ id: sc.id, jamPct: sh.shove, fourBetPct: sh["4bet"] });
      }
    }
  }
  return rep;
}

export interface Band {
  name: string;
  value: number;
  lo: number;
  hi: number;
  ok: boolean;
}

/** PF-BANDS (§5.4): loose published aggregates, printed next to the result. Warnings only, never targets. */
export function stageBands(stage: PreflopStage, decoded = decodeStage(stage)): Band[] {
  const specs: [string, string, (d: DecodedScenario) => number, number, number][] = [
    ["RFI UTG", "rfi-utg", playsOfAll, 14, 17],
    ["RFI HJ", "rfi-hj", playsOfAll, 25, 27],
    ["RFI CO", "rfi-co", playsOfAll, 32, 35],
    ["RFI BTN", "rfi-btn", playsOfAll, 45, 50],
    ["SB VPIP (first in)", "rfi-sb", playsOfAll, 60, 100],
    ["BB vs BTN defense", "bb-vs-btn-open", playsOfAll, 75, 100],
    ["3-bet UTG+1 vs UTG", "utgp1-vs-utg-open", (d) => shareOfAll(d, ["3bet", "shove"]), 5, 7],
    ["3-bet HJ vs UTG", "hj-vs-utg-open", (d) => shareOfAll(d, ["3bet", "shove"]), 5, 7],
  ];
  const out: Band[] = [];
  for (const [name, id, f, lo, hi] of specs) {
    const d = decoded.get(id);
    if (!d) continue;
    const value = round(f(d), 1);
    out.push({ name, value, lo, hi, ok: value >= lo && value <= hi });
  }
  return out;
}

// ───────────── export (§4.4, §6.2, §6.5, §6.6) ─────────────

export interface StageMetrics {
  /** Per node: share of dealt hands in which its line occurs. */
  occ: ArrayLike<number>;
  /** Per node: reach-weighted local regret, bb. */
  localRegret: ArrayLike<number>;
  gainMbb: number[];
  nashConvMbb: number;
  /** Largest per-seat gain against the snapped profile of this export set, mbb/hand. */
  snappedGainMbb: number;
  ev: number[];
  evSum: number;
  /** PF-FROZEN, share of dealt hands. */
  frozenOcc: number;
  negativeShares: number;
}

export interface StageExportInput {
  id: string;
  label: string;
  tree: PreflopTree;
  /** σ̄, edgeCount·N. */
  strategy: Float64Array;
  classes: readonly NodeClass[];
  exported: Uint8Array;
  /** The ladder steps the export set was built with (for occThresholdByKind). */
  ladder: LadderSteps;
  iterations: number;
  metrics: StageMetrics;
  /** Per node, pp moved in the sensitivity solves; null when they were not run (draft). */
  moves: ArrayLike<number> | null;
  /** Nodes PF-TWOSTART flagged; null when it was not run (draft). */
  twoStartFlags: ReadonlySet<number> | null;
  /** The gates were ignored (--ignore-gates): a draft. */
  gatesIgnored?: boolean;
  /** The solves ran on a capped schedule (--iterations below §4.6's): a draft, whatever the gates said. */
  iterationsCapped?: boolean;
  /** PF-TWOSTART's second solve did not pass its own gates, so its comparison proves nothing: a draft. */
  twoStartFailed?: boolean;
  fit: Pick<EqrFit, "sha256" | "packs">;
  equityTable: string;
}

export interface StageExport {
  stage: PreflopStage;
  /** σ̄ with the exported nodes snapped to the 0.1 grid. */
  snapped: Float64Array;
  /** The node of each scenario, in scenario order. */
  nodes: number[];
  /** Why this is a draft ("sensitivity", "twostart", "gates", "iterations", "twostartGates"); empty for a release
   *  export. */
  draft: string[];
  sanity: SanityReport;
  /** Scenario ids PF-TWOSTART flagged. */
  twoStart: string[];
}

const CONFIDENCE_KO = { high: "높음", mid: "보통", low: "낮음" } as const;

/** The exported nodes in scenario order: kind, hero seat, line, node. */
export function scenarioOrder(tree: PreflopTree, classes: readonly NodeClass[], exported: Uint8Array): number[] {
  const nodes: number[] = [];
  for (let p = 0; p < tree.nodeCount; p++) if (exported[p]) nodes.push(p);
  const cmpKey = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  return nodes.sort(
    (a, b) =>
      KIND_ORDER.indexOf(classes[a].kind) - KIND_ORDER.indexOf(classes[b].kind) ||
      tree.seat[a] - tree.seat[b] ||
      cmpKey(classes[a].sortKey, classes[b].sortKey) ||
      a - b,
  );
}

export function exportStage(input: StageExportInput): StageExport {
  const { tree, classes, exported, strategy, metrics } = input;
  const cfg = tree.cfg;
  const N = ALL_HANDS.length;
  if (strategy.length !== tree.edgeCount * N) throw new Error("strategy must be edgeCount·169");
  const nodes = scenarioOrder(tree, classes, exported);
  const snapped = snapStrategy(tree, strategy, nodes, N);
  const draft: string[] = [];
  if (!input.moves) draft.push("sensitivity");
  if (!input.twoStartFlags) draft.push("twostart");
  if (input.gatesIgnored) draft.push("gates");
  if (input.iterationsCapped) draft.push("iterations");
  if (input.twoStartFailed) draft.push("twostartGates");

  if (cfg.allinOrder !== "priority") throw new Error("only the priority all-in order ships");
  const rho = new Float64Array(N);
  const scenarios: PreflopScenario[] = nodes.map((p) => {
    const c = classes[p];
    ownReach(tree, snapped, p, N, rho);
    // The hero's earlier decisions, root first. exportSet guarantees they are exported.
    const chain: string[] = [];
    let x = p;
    while (x > 0) {
      const q = tree.parent[x];
      if (tree.seat[q] === tree.seat[p]) {
        if (!exported[q]) throw new Error(`node ${p}: hero ancestor ${q} is not exported`);
        const spec = classes[q].actions[tree.nodes[x].parentAction];
        if (!spec) throw new Error(`node ${p}: the hero folded at ${q}`);
        chain.push(`${classes[q].id}:${spec.key}`);
      }
      x = q;
    }
    const reachFrom = chain.reverse();
    let reachW = 0;
    for (let h = 0; h < N; h++) reachW += CW[h] * rho[h];
    const e0 = tree.actStart[p];
    const actions: PreflopAction[] = c.order.map((a) => {
      const spec = c.actions[a]!;
      const v = new Float64Array(N);
      for (let h = 0; h < N; h++) v[h] = rho[h] > 0 ? snapped[(e0 + a) * N + h] : 0;
      return { key: spec.key, label: spec.label, color: spec.color, range: rangeText(v) };
    });
    const sc: PreflopScenario = {
      id: c.id,
      kind: c.kind,
      hero: c.hero,
      ...(c.villain !== undefined ? { villain: c.villain } : {}),
      ...(c.villainSeats && c.villainSeats.length ? { villainSeats: c.villainSeats } : {}),
      chip: c.chip,
      title: c.title,
      description: "",
      line: c.line,
      ...(reachFrom.length ? { reachFrom } : {}),
      reachPct: round((reachW / CW_SUM) * 100, 1),
      ...(c.noFold ? { noFold: true as const } : {}),
      occ: round(metrics.occ[p] * 100, 3),
      regret: round(metrics.localRegret[p], 4),
      confidence: "high",
      move: 0,
      actions,
    };
    return sc;
  });

  const stage: PreflopStage = {
    id: input.id,
    label: input.label,
    description: stageDescription(tree, draft),
    stack: cfg.S,
    open: cfg.open,
    sizes: {
      sbRaise: cfg.sbRaise,
      iso: cfg.iso,
      ip3: cfg.ip3,
      blind3: cfg.blind3,
      bbVsSb3: cfg.bbVsSb3,
      sqzPerCallerIP: cfg.sqzPerCallerIP,
      sqzPerCallerBlind: cfg.sqzPerCallerBlind,
      fourIP: cfg.fourIP,
      fourOOP: cfg.fourOOP,
      limpReraise: cfg.limpReraise,
      jamMax: cfg.jamMax,
    },
    tree: { cold4: cfg.cold4, allinOrder: "priority" },
    iterations: input.iterations,
    occThreshold: round(BASE_THRESHOLD * 100, 4),
    occThresholdByKind: thresholdsByKind(input.ladder),
    brGainMbb: metrics.gainMbb.map((g) => round(g, 3)),
    nashConvMbb: round(metrics.nashConvMbb, 3),
    snappedGainMbb: round(metrics.snappedGainMbb, 3),
    ev: metrics.ev.map((e) => round(e, 4)),
    diag: { evSum: round(metrics.evSum, 4), frozenOccPct: round(metrics.frozenOcc * 100, 3), negativeShares: metrics.negativeShares },
    model: {
      id: "modelB-5f",
      fitHash: input.fit.sha256,
      sprAlpha: SPR_ALPHA,
      sprSurplus: SPR_SURPLUS,
      packs: Object.fromEntries(Object.entries(input.fit.packs).map(([k, v]) => [k, { version: v.version, flops: v.flops }])),
    },
    equityTable: input.equityTable,
    scenarios,
  };

  // §6.6 confidence, after the checks that read the exported data.
  const sanity = stageSanity(stage);
  const s5 = new Map(sanity.sanity5.map((x) => [x.id, x.callPct])), s6 = new Set(sanity.sanity6.map((x) => x.id));
  const s7 = new Map(sanity.sanity7.map((x) => [x.id, x]));
  const measured = input.moves !== null;
  const twoStart: string[] = [];
  scenarios.forEach((sc, i) => {
    const p = nodes[i];
    const c = classes[p];
    // The badge follows the stored move (0.1pp), the number the data and the description show, so a stored 8.0 is
    // never 높음 whatever the raw value was.
    const move = input.moves ? round(input.moves[p], 1) : 0;
    const flagged2 = input.twoStartFlags?.has(p) ?? false;
    if (flagged2) twoStart.push(sc.id);
    let conf: PreflopScenario["confidence"] = move < MOVE_HIGH ? "high" : move <= MOVE_MID ? "mid" : "low";
    // Without the sensitivity solves nothing was measured: a draft is never 높음.
    if (!measured && conf === "high") conf = "mid";
    const reasons: string[] = [];
    const callPct = s5.get(sc.id);
    if (callPct !== undefined) reasons.push(`EP 오픈에 콜드콜이 전체 핸드의 ${fmtPct(callPct)}%라 확인이 필요해요.`);
    if (s6.has(sc.id)) reasons.push("4벳 올인이 작은 4벳보다 많아요.");
    const k7 = s7.get(sc.id);
    if (k7)
      reasons.push(`더 좋은 핸드를 덜 플레이하는 칸이 있어요 (예: ${k7.better} ${fmtPct(k7.pBetter * 100)}%, ${k7.worse} ${fmtPct(k7.pWorse * 100)}%). 실현율 모델의 알려진 왜곡이에요.`);
    if (flagged2) reasons.push("다른 시작점에서 풀면 액션 비율이 2%p 넘게 달라져요.");
    if (reasons.length) conf = "low";
    const fourBetRule = cfg.S >= 55 && (sc.kind === "vs3bet" || sc.kind === "vs4bet");
    if (fourBetRule && conf === "high") conf = "mid";
    sc.confidence = conf;
    sc.move = move;
    sc.description = scenarioDescription(c, tree, {
      conf,
      move,
      measured,
      fourBetRule,
      fourBetSplit: sc.actions.some((a) => a.key === "4bet") && sc.actions.some((a) => a.key === "shove"),
      reasons,
    });
  });
  return { stage, snapped, nodes, draft, sanity, twoStart };
}

const fmtPct = (x: number) => String(Math.round(x));

function stageDescription(tree: PreflopTree, draft: string[]): string {
  const c = tree.cfg;
  const parts = [
    `모두 ${fmtBb(c.S)}bb. 오픈 ${fmtBb(c.open)}bb, SB는 림프·오픈 ${fmtBb(c.sbRaise)}bb, 3벳 IP ${fmtBb(c.ip3)}배·블라인드 ${fmtBb(c.blind3)}배, 4벳 ${fmtBb(c.fourIP)}~${fmtBb(c.fourOOP)}배.`,
  ];
  if (c.S <= c.jamMax) parts.push("퍼스트 인 올인과 3벳 올인도 있어요.");
  parts.push("서로 최선인 균형 근사(착취 아님).");
  if (c.cold4 === "none") parts.push("3벳 뒤 콜드 올인 없음.");
  if (draft.length) parts.push(`초안이에요: ${draftText(draft)} 전이라 신뢰도는 임시예요.`);
  return parts.join(" ");
}

function draftText(draft: string[]): string {
  const ko: Record<string, string> = {
    sensitivity: "민감도 풀이",
    twostart: "두 출발점 검사",
    gates: "수렴 검사 통과",
    iterations: "정식 반복 횟수 풀이",
    twostartGates: "두 출발점 풀이의 수렴",
  };
  return draft.map((d) => ko[d] ?? d).join("·");
}

/** "이" after a final consonant, "가" after a vowel (the last Hangul syllable of `word` decides). */
function subjectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 !== 0 ? "이" : "가";
}

/** These sentences are matched by src/data/preflopData.test.ts; keep them in step. */
export const FOUR_BET_SPLIT_TEXT = "작은 4벳과 4벳 올인의 배분은 낮은 SPR 가정에 민감해요.";
export const LOW_SPR_CAP_TEXT = "3벳·4벳 팟은 낮은 SPR 가정에 민감해서 신뢰도를 보통까지만 줘요.";

function scenarioDescription(
  c: NodeClass,
  tree: PreflopTree,
  o: { conf: PreflopScenario["confidence"]; move: number; measured: boolean; fourBetRule: boolean; fourBetSplit: boolean; reasons: string[] },
): string {
  const parts: string[] = [];
  if (c.sizedLine) parts.push(`${c.sizedLine}.`);
  else parts.push(tree.seat[c.node] === 0 ? "가장 먼저 액션해요." : "앞에서 모두 폴드했어요.");
  if (c.noFold) {
    // Name only the actions this node has: the 100bb and 55bb BB has no jam over a limp.
    const info = tree.nodes[c.node];
    const alts = c.order.filter((a) => info.actions[a].verb !== "check").map((a) => VERB_KO[info.actions[a].verb]).join("·");
    parts.push(`BB는 폴드하지 않아요: ${alts}${subjectParticle(alts)} 아니면 체크해요.`);
  }
  if (c.cold) parts.push("3벳 뒤 콜드 자리는 폴드나 올인만 해요 (트리 제약: 콜·작은 4벳 없음).");
  // The 55bb+ cap on vs3bet / vs4bet: the split sentence only where the hero has both a small 4-bet and a jam;
  // elsewhere (cold, call-or-jam and vs-4-bet spots) the plain reason for the cap.
  if (o.fourBetRule) parts.push(o.fourBetSplit ? FOUR_BET_SPLIT_TEXT : LOW_SPR_CAP_TEXT);
  const badge = `신뢰도 ${CONFIDENCE_KO[o.conf]}`;
  if (!o.measured) parts.push(`${badge}(초안): 민감도 풀이를 아직 안 해서 움직임은 재지 않았어요.`);
  else if (o.move < 1) parts.push(`${badge}: 실현율 가정을 바꿔 풀어도 이 차트는 거의 안 움직여요.`);
  else parts.push(`${badge}: 실현율 가정을 바꿔 풀면 이 차트가 약 ${fmtBb(o.move)}%p 움직여요.`);
  parts.push(...o.reasons);
  return parts.join(" ");
}

// ───────────── sensitivity and two-start comparisons (§5.4, §6.6) ─────────────

/**
 * §6.6 move at node p: the ρ-weighted mean total-variation distance between two strategies' action distributions,
 * in pp, with ρ the main solve's own (raw) reach. `rho` is that reach, per class.
 */
export function moveAt(tree: PreflopTree, main: Float64Array, other: Float64Array, p: number, rho: ArrayLike<number>, cw: ArrayLike<number> = CW): number {
  const N = rho.length, e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0;
  let num = 0, den = 0;
  for (let h = 0; h < N; h++) {
    const w = cw[h] * rho[h];
    if (!(w > 0)) continue;
    let tv = 0;
    for (let a = 0; a < A; a++) tv += Math.abs(main[(e0 + a) * N + h] - other[(e0 + a) * N + h]);
    num += w * tv * 0.5;
    den += w;
  }
  return den > 0 ? (num / den) * 100 : 0;
}
