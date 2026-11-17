/**
 * Preflop scenarios the presolve pipeline solves on many flops (one pack per scenario).
 * See docs/solver-packs.md for the pack layout; scripts/presolve.mjs runs the solves.
 *
 * Pot and stack are derived from the same rules the play mode uses (src/play/engine.ts, policy.ts):
 *   - blinds 0.5 / 1, the SB folds and stays dead money in the pot;
 *   - 6-max cash: no ante, BTN opens 2.5bb (openSize("cash", ...)), 100bb deep;
 *   - pub tournament: the BB posts a 1bb ante (PUB_TABLE.bbAnte) on top of the blind, the mid stage opens
 *     2.5bb (openSize("pub", "mid", ...)) and starts at STAGE_STACK.mid = 55bb.
 * Single raised pot, BB calls: pot = 2 × open + SB + ante, effective stack = start − open − ante (the BB paid the
 * ante as well, so it is the shorter stack).
 *
 * Two sets of packs share the pipeline: SCENARIOS, the app's packs (public/packs, listed by the solver page), and
 * CAL_SCENARIOS, calibration packs for the preflop solver's realization model (calibration/packs, a separate manifest
 * the app never reads; they start from ranges of check-only solver stages plus ghost combos, see CAL_SCENARIOS).
 */
import { getSet } from "../data/charts";
import { ALL_HANDS, type HandClass } from "../poker/cards";
import { parseRange, rangeToString, type Range } from "../poker/range";
import { COMBOS } from "../play/handInfo";
import { CASH_TABLE, PUB_TABLE } from "../play/engine";
import { openSize, STAGE_STACK } from "../play/policy";
import type { SolverInput, SolverStreet, StreetSizes } from "../solver/types";
import { CAL_RANGES } from "./calRanges";
import { roundChips, type PackTier, type ScenarioMeta } from "./format";

/**
 * Which manifest a pack belongs to. "app": public/packs/manifest.json, deployed and listed by the app's solver page.
 * "calibration": calibration/packs/manifest.json, outside public/ (never deployed, never listed), read by
 * scripts/fit-realization.mjs only.
 */
export type PackSet = "app" | "calibration";

/** Repo-relative directory of each set's manifest and flop files (scripts/presolve.mjs's default --out / --cal-out). */
export const PACK_SET_DIRS: Record<PackSet, string> = { app: "public/packs", calibration: "calibration/packs" };

export interface PresolveScenario {
  /** Pack id, e.g. "srp-btn-bb-100". Unique across both sets. */
  id: string;
  set: PackSet;
  /** Korean pack title. */
  title: string;
  /** Pack version: bump it whenever anything that changes the numbers changes (sizes, ranges, targets, solver). */
  version: number;
  tier: PackTier;
  /** Everything written into the manifest's `scenario` block. */
  meta: ScenarioMeta;
  /** Starting weights [OOP, IP], COMBOS-indexed (1326), from the charts' effective frequencies. */
  ranges: [Float32Array, Float32Array];
  /** Starting stack (bb) before the blinds, for reference. */
  startStack: number;
}

// ───────────────────────── ranges from charts ─────────────────────────

/**
 * A chart ref "<set>/<stage>/<scenario>:<action>" as a hand-class range: the action's effective frequency
 * (`Scenario.strategy[hand][action]`, so an earlier action that takes a hand first is respected).
 */
export function chartRange(ref: string): Range {
  const m = /^([^/]+)\/([^/]+)\/([^:]+):(.+)$/.exec(ref);
  if (!m) throw new Error(`invalid chart ref: ${ref}`);
  const [, setId, stageId, scenarioId, action] = m;
  const set = getSet(setId);
  if (set.id !== setId) throw new Error(`unknown chart set: ${setId}`);
  const stage = set.stages.find((s) => s.id === stageId);
  if (!stage) throw new Error(`unknown stage: ${setId}/${stageId}`);
  const sc = stage.scenarios.find((s) => s.id === `${setId}/${stageId}/${scenarioId}`);
  if (!sc) throw new Error(`unknown scenario: ${setId}/${stageId}/${scenarioId}`);
  if (!sc.actions.some((a) => a.key === action)) throw new Error(`scenario ${sc.id} has no action ${action}`);
  const out: Range = {};
  for (const h of ALL_HANDS) {
    const f = sc.strategy[h][action] ?? 0;
    if (f > 0) out[h] = f;
  }
  return out;
}

/** Hand-class range → COMBOS-indexed weights (every combo of a class gets the class frequency). */
export function rangeWeights(range: Range): Float32Array {
  const w = new Float32Array(COMBOS.length);
  COMBOS.forEach((c, i) => (w[i] = range[c.hand as HandClass] ?? 0));
  return w;
}

/** Σ weights: weighted combos out of 1326. */
export function weightedCombos(w: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s;
}

// ───────────────────────── pot and stack ─────────────────────────

export interface SrpSetup {
  /** Starting stack (bb) of both players before posting. */
  start: number;
  /** The opener's raise to (bb). */
  open: number;
  /** Dead money the BB posts on top of the blind (pub BB ante); 0 without an ante. */
  bbAnte: number;
  sb?: number;
  bb?: number;
}

/** Flop pot and effective stack of a single raised pot where the BB calls an open and the SB folded. */
export function srpPotStack(s: SrpSetup): { pot: number; stack: number } {
  const sb = s.sb ?? 0.5;
  if (!(s.open > (s.bb ?? 1))) throw new Error("the open must be bigger than the big blind");
  const pot = 2 * s.open + sb + s.bbAnte;
  const stack = Math.min(s.start - s.open, s.start - s.open - s.bbAnte);
  return { pot: roundChips(pot), stack: roundChips(stack) };
}

// ───────────────────────── tree presets ─────────────────────────

const both = (oop: StreetSizes, ip: StreetSizes = oop): [StreetSizes, StreetSizes] => [
  { bet: [...oop.bet], raise: [...oop.raise] },
  { bet: [...ip.bet], raise: [...ip.raise] },
];

export type TreeSettings = Pick<ScenarioMeta, "sizes" | "raiseLimit" | "addAllIn" | "allInThreshold" | "minBet">;

/**
 * The presolve tree for single raised pots, simplified like the default trees of commercial trainers:
 *   flop   OOP checks (no donk bet) and may raise a bet by 60% of the pot after calling (the check-raise);
 *          IP bets 33% or 75% and can't re-raise;
 *   turn   both players bet 66%, no raises;   river  the same.
 * No all-in button (addAllIn false): a bet of at least 67% of the stack still becomes the all-in.
 *
 * A full flop tree multiplies every flop line by 49 turn × 48 river cards, so each extra turn or river size costs
 * far more than a flop size. Measured on the first 200 priority flops (estimateMemory) and on one core of the
 * 4-core dev machine:
 *   cash 100bb (679 / 604 combos on AsKh7d): 1.58–1.78 GB (RSS ~15% more), ~5.5 s per iteration;
 *   pub 55bb (532 / 420 combos):             1.20–1.36 GB.
 * Alternatives that were measured: with an OOP donk bet but no raises at all (1.3 GB for cash) the solver donks
 * about half the time, because IP can't raise a donk: a tree artifact, not a lesson. Flop raises for both players
 * plus turn raises would need 3.5–8 GB per flop.
 */
export const TREE_SRP: TreeSettings = {
  sizes: {
    flop: [
      { bet: [], raise: [0.6] },
      { bet: [0.33, 0.75], raise: [] },
    ],
    turn: both({ bet: [0.66], raise: [] }),
    river: both({ bet: [0.66], raise: [] }),
  },
  raiseLimit: 1,
  addAllIn: false,
  allInThreshold: 0.67,
  minBet: 1,
};

function copySizes(sizes: Record<SolverStreet, [StreetSizes, StreetSizes]>): Record<SolverStreet, [StreetSizes, StreetSizes]> {
  const out = {} as Record<SolverStreet, [StreetSizes, StreetSizes]>;
  for (const st of ["flop", "turn", "river"] as const) out[st] = both(sizes[st][0], sizes[st][1]);
  return out;
}

/** The tree settings of a scenario as SolverInput fields (copies; all three streets written out). */
export function treeInput(meta: TreeSettings): Required<Pick<SolverInput, "sizes" | "raiseLimit" | "addAllIn" | "allInThreshold" | "minBet">> {
  return { sizes: copySizes(meta.sizes), raiseLimit: meta.raiseLimit, addAllIn: meta.addAllIn, allInThreshold: meta.allInThreshold, minBet: meta.minBet };
}

/** The solver input for one flop of a scenario. */
export function solverInput(sc: PresolveScenario, board: number[]): SolverInput {
  return { board: board.slice(), ranges: [sc.ranges[0], sc.ranges[1]], pot: sc.meta.pot, stack: sc.meta.stack, ...treeInput(sc.meta) };
}

// ───────────────────────── scenarios ─────────────────────────

interface ScenarioDef {
  id: string;
  title: string;
  version: number;
  tier: PackTier;
  format: ScenarioMeta["format"];
  positions: [string, string];
  preflop: string;
  setup: SrpSetup;
  /** Chart refs [OOP, IP]. */
  rangeSources: [string, string];
  /** The ranges [OOP, IP] when they don't come from the app's charts (default: chartRange of each rangeSource). */
  ranges?: [Range, Range];
  /** Calibration packs: raise every hand class of both ranges to at least this weight (ghost combos, withGhosts). */
  ghostWeight?: number;
  set?: PackSet;
  tree: TreeSettings;
  iterations: number;
  targetExploitability: number;
  flopSet: string;
}

function build(d: ScenarioDef): PresolveScenario {
  const { pot, stack } = srpPotStack(d.setup);
  const src = d.ranges ?? [chartRange(d.rangeSources[0]), chartRange(d.rangeSources[1])];
  const g = d.ghostWeight;
  const [r0, r1] = g === undefined ? src : [withGhosts(src[0], g), withGhosts(src[1], g)];
  const text = (p: 0 | 1) => (g === undefined ? rangeToString(src[p]) : ghostRangeString(src[p], g));
  const meta: ScenarioMeta = {
    format: d.format,
    positions: [d.positions[0], d.positions[1]],
    preflop: d.preflop,
    pot,
    stack,
    sizes: copySizes(d.tree.sizes),
    raiseLimit: d.tree.raiseLimit,
    addAllIn: d.tree.addAllIn,
    allInThreshold: d.tree.allInThreshold,
    minBet: d.tree.minBet,
    iterations: d.iterations,
    targetExploitability: d.targetExploitability,
    ranges: [text(0), text(1)],
    rangeSources: [d.rangeSources[0], d.rangeSources[1]],
    flopSet: d.flopSet,
  };
  // Only calibration packs carry the key, so the app packs' meta stays byte-identical to their manifest entries.
  if (d.ghostWeight !== undefined) meta.ghostWeight = d.ghostWeight;
  const set = d.set ?? "app";
  return { id: d.id, set, title: d.title, version: d.version, tier: d.tier, meta, ranges: [rangeWeights(r0), rangeWeights(r1)], startStack: d.setup.start };
}

const CASH_OPEN = openSize("cash", "100bb", "BTN"); // 2.5
const PUB_MID_OPEN = openSize("pub", "mid", "BTN"); // 2.5
const PUB_MID_OPEN_UTG = openSize("pub", "mid", "UTG"); // 2.5
const PUB_MID_START = STAGE_STACK.mid; // 55

export const SCENARIOS: PresolveScenario[] = [
  build({
    id: "srp-btn-bb-100",
    title: "BTN vs BB 싱글 레이즈드 팟 (캐시 100bb)",
    // v1 started with solver aa7f7fa. The later solver commits (input checks, typed-array tree, suit orbits,
    // opt-in 16-bit storage) leave the numbers in place: Qs8h5h re-solved at fba9dd1 took the same 80 iterations
    // and differs by 0.03% of strategy (reach-weighted, at most 0.4% for any combo) and ≤ 0.001 bb of EV, so the
    // presolve's "solver changed since v1" note needs no bump. Bump it if a solver change does move them.
    version: 1,
    tier: "free",
    format: "cash",
    positions: ["BB", "BTN"],
    preflop: `BTN ${CASH_OPEN}bb 오픈, SB 폴드, BB 콜`,
    setup: { start: STAGE_STACK["100bb"], open: CASH_OPEN, bbAnte: CASH_TABLE.bbAnte ? 1 : 0 },
    rangeSources: ["cash6/100bb/bb-vs-btn:call", "cash6/100bb/rfi-btn:raise"],
    tree: TREE_SRP,
    iterations: 300,
    targetExploitability: 0.5,
    flopSet: "priority",
  }),
  build({
    id: `pub-srp-btn-bb-${PUB_MID_START}`,
    title: `BTN vs BB 싱글 레이즈드 팟 (펍 토너먼트 미들 ${PUB_MID_START}bb)`,
    // v2: the BB's calling range widened (56828e8, pub BB defense); v1 was solved against the old one.
    version: 2,
    tier: "free",
    format: "pub",
    positions: ["BB", "BTN"],
    preflop: `BTN ${PUB_MID_OPEN}bb 오픈, SB 폴드, BB 콜 (BB 앤티 1bb)`,
    setup: { start: PUB_MID_START, open: PUB_MID_OPEN, bbAnte: PUB_TABLE.bbAnte ? 1 : 0 },
    rangeSources: ["pub/mid/bb-vs-btn:call", "pub/mid/rfi-btn:open"],
    tree: TREE_SRP,
    iterations: 300,
    targetExploitability: 0.5,
    flopSet: "priority",
  }),
  build({
    id: `pub-srp-utg-bb-${PUB_MID_START}`,
    title: `UTG vs BB 싱글 레이즈드 팟 (펍 토너먼트 미들 ${PUB_MID_START}bb)`,
    // A tight opener against a wide BB call (the chart's 12% UTG open, 46% BB call): the two BTN packs only show
    // realization against wide ranges, and the preflop solver's realization model (docs/preflop-solver.md §3.7)
    // needs to see how dominated hands such as Q7s and A4o do against a strong range.
    version: 1,
    tier: "free",
    format: "pub",
    positions: ["BB", "UTG"],
    preflop: `UTG ${PUB_MID_OPEN_UTG}bb 오픈, 나머지 폴드, BB 콜 (BB 앤티 1bb)`,
    setup: { start: PUB_MID_START, open: PUB_MID_OPEN_UTG, bbAnte: PUB_TABLE.bbAnte ? 1 : 0 },
    rangeSources: ["pub/mid/bb-vs-utg:call", "pub/mid/rfi-utg:open"],
    tree: TREE_SRP,
    iterations: 300,
    targetExploitability: 0.5,
    flopSet: "priority",
  }),
];

// ───────────────────────── calibration packs ─────────────────────────

/**
 * The ghost-combo floor of the calibration packs: every hand class starts with at least this weight on both sides,
 * so the classes just outside a range (the BB's folds and jams next to its calls, the BTN's folds and jams next to its
 * opens) get a measured flop EV too. A refit can then place the fold boundary from measured EVs instead of
 * extrapolating the model. A class at exactly this weight is a ghost: the source ranges are snapped to tenths.
 *
 * Ghosts are real combos to the solver, so they also shift the real hands' numbers. Measured on cal-srp-btn-bb-15
 * Qs8h5h (the BTN's 12.6% open is the range ghosts dilute most), both solves at 0.13–0.14% of the pot, against no
 * ghosts: this floor moves OOP's real classes' pot share by 0.025 on average (+0.019 signed: OOP realizes more against
 * an IP range padded with hands it would not open) and IP's by 0.009; a 0.005 floor by 0.007 (+0.005) and 0.002. The
 * convergence noise at the packs' 0.5% target is 0.003 (OOP) and 0.005 (IP). At 20bb (6% ghosts on IP) the 0.02 floor
 * differs from 0.005 by 0.007 / 0.002. The cost does not depend on the floor (every combo is in both ranges either
 * way), and ghostRangeString writes any floor exactly.
 */
export const GHOST_WEIGHT = 0.02;

/** `range` with every hand class raised to at least `floor`. */
export function withGhosts(range: Range, floor: number = GHOST_WEIGHT): Range {
  const out = {} as Range;
  for (const h of ALL_HANDS) out[h] = Math.max(range[h] ?? 0, floor);
  return out;
}

/**
 * The range string of withGhosts(range, floor): the source range as rangeToString writes it, then every class outside
 * it at exactly `floor` (rangeToString rounds to 0.01 and drops weights below 0.005, so it can't write a small floor).
 * The source's classes keep their weight: a source weight below the floor would need the merged form, so it throws.
 */
export function ghostRangeString(range: Range, floor: number = GHOST_WEIGHT): string {
  const ghosts: string[] = [];
  for (const h of ALL_HANDS) {
    const w = range[h] ?? 0;
    if (w > 0 && w < floor) throw new Error(`${h} has weight ${w}, below the ghost floor ${floor}`);
    if (!(w > 0)) ghosts.push(`${h}:${floor}`);
  }
  return [rangeToString(range), ...ghosts].filter(Boolean).join(", ");
}

/** A calibration pack's source range (src/presolve/calRanges.ts, generated by scripts/cal-ranges.mjs). */
export function calRange(ref: string): Range {
  const text = CAL_RANGES[ref];
  if (text === undefined) throw new Error(`no calibration range for ${ref}; rerun scripts/cal-ranges.mjs`);
  return parseRange(text);
}

/**
 * The 9-handed BB-ante short stages' own single raised pot: BTN opens 2bb, the SB folds, the BB calls. Pot
 * 2 × 2 + 0.5 + 1 = 5.5; the stack is start − 3 (open and ante), so SPR 17 / 5.5 ≈ 3.1 at 20bb and 12 / 5.5 ≈ 2.2 at
 * 15bb, where nothing calibrated the realization model before (the app's packs are at SPR 7.9 and 17.7).
 * The tree is TREE_SRP, the app packs' tree, so the low-SPR rows differ from the deep ones in stack depth and ranges
 * only. At these stacks it ends in an all-in sooner (allInThreshold): the check-raise of a 75% bet is an all-in, and so
 * is the turn bet after a 75% flop bet is called.
 */
function calPack(start: 20 | 15): ScenarioDef {
  const stageId = `${start}bb-2`;
  const sources: [string, string] = [`solver/${stageId}/bb-vs-btn-open:call`, `solver/${stageId}/rfi-btn:open`];
  return {
    id: `cal-srp-btn-bb-${start}`,
    title: `보정용 BTN vs BB 싱글 레이즈드 팟 (솔버 ${start}bb)`,
    version: 1,
    tier: "free",
    format: "pub",
    positions: ["BB", "BTN"],
    preflop: `9인 모두 ${start}bb, BTN 2bb 오픈, SB 폴드, BB 콜 (BB 앤티 1bb)`,
    setup: { start, open: 2, bbAnte: 1 },
    rangeSources: sources,
    ranges: [calRange(sources[0]), calRange(sources[1])],
    ghostWeight: GHOST_WEIGHT,
    set: "calibration",
    tree: TREE_SRP,
    iterations: 300,
    targetExploitability: 0.5,
    flopSet: "priority",
  };
}

/**
 * Calibration packs (calibration/packs, never listed by the app): the realization model of the preflop solver at
 * SPR 1–4, where it decides the short stages' BB defense (docs/preflop-solver.md). The ranges are the short stages'
 * own, from their draft solve with the shipped fit (calRanges.ts), with ghost combos on both sides.
 */
export const CAL_SCENARIOS: PresolveScenario[] = [build(calPack(20)), build(calPack(15))];

/** Every pack of both sets, the app's first. */
export const ALL_SCENARIOS: PresolveScenario[] = [...SCENARIOS, ...CAL_SCENARIOS];

export function getScenario(id: string): PresolveScenario {
  const sc = ALL_SCENARIOS.find((s) => s.id === id);
  if (!sc) throw new Error(`unknown presolve scenario: ${id} (known: ${ALL_SCENARIOS.map((s) => s.id).join(", ")})`);
  return sc;
}
