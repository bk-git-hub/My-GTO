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
 * ante as well, so it is the shorter stack). The calibration queue's other heads-up pots (3-bet, 4-bet and limped pots,
 * an in-position caller) follow the same rules through huPotStack.
 *
 * Two sets of packs share the pipeline: SCENARIOS, the app's packs (the `packs-data` branch, served by a CDN and listed
 * by the solver page: the first three packs and the solver-chart packs of APP_QUEUE), and CAL_SCENARIOS, calibration
 * packs for the preflop solver's realization model (calibration/packs, a separate manifest the app never reads; they
 * start from ranges of check-only solver stages plus ghost combos, see CAL_SCENARIOS).
 */
import { getSet } from "../data/charts";
import { ALL_HANDS, type HandClass } from "../poker/cards";
import { parseRange, rangeToString, type Range } from "../poker/range";
import { COMBOS } from "../play/handInfo";
import { CASH_TABLE, PUB_TABLE } from "../play/engine";
import { openSize, STAGE_STACK } from "../play/policy";
import type { Player, SolverInput, SolverStreet, StreetSizes } from "../solver/types";
import { APP_RANGES, APP_STAGE_SOLVES } from "./appRanges";
import { CAL_RANGES, CAL_STAGE_SOLVES } from "./calRanges";
import { roundChips, type PackTier, type PlannedPack, type ScenarioMeta, type SpotTag } from "./format";

/**
 * Which manifest a pack belongs to. "app": the catalog on the `packs-data` branch (packs/manifest.json there, a v2
 * catalog with one index per pack, src/presolve/store.ts), served by a CDN pinned to a commit and listed by the app's
 * solver page. "calibration": calibration/packs/manifest.json on master, outside public/ (never deployed, never listed),
 * read by scripts/fit-realization.mjs only.
 */
export type PackSet = "app" | "calibration";

/**
 * Repo-relative directory of each set's manifest and flop files (scripts/presolve.mjs's default --out / --cal-out). The
 * app's is a checkout of the `packs-data` branch at packs-data/ (gitignored on master): `git worktree add packs-data
 * packs-data`, or the sparse checkout the presolve workflow makes.
 */
export const PACK_SET_DIRS: Record<PackSet, string> = { app: "packs-data/packs", calibration: "calibration/packs" };

/**
 * Where the app's packs were before the data branch: still deployed with the app (frozen, nothing writes it) for clients
 * of earlier releases and as the fallback of the three packs it holds, until it is removed (docs/solver-packs.md R2).
 */
export const LEGACY_APP_DIR = "public/packs";

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
  /**
   * App packs: the chart spot the pack solves, written into the catalog beside the meta (not in it, so the meta of the
   * first three packs stays byte-identical). The picker, AI 테이블 and hand review find packs by it.
   */
  spot?: SpotTag;
  /** Starting weights [OOP, IP], COMBOS-indexed (1326), from the charts' effective frequencies. */
  ranges: [Float32Array, Float32Array];
  /** Starting stack (bb) before the blinds, for reference. */
  startStack: number;
  /**
   * The presolve job's order (scripts/presolve.mjs, jobQueue in shard.ts): packs with a lower value are solved first,
   * packs with the same value are interleaved. 0 for the app's packs and the first two calibration packs, so their
   * order is as it always was; the calibration queue counts up from 1 in priority order. Not part of the pack: changing
   * it needs no version bump.
   */
  queue: number;
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

/**
 * Any heads-up flop of the 9-handed BB-ante game: who saw it, what each of them put in, and the blinds and ante of the
 * seats that folded (dead money).
 */
export interface HuSetup {
  /** Starting stack (bb) of every seat before posting. */
  start: number;
  /** The two seats [OOP, IP], as the charts name them ("BB", "SB", "BTN", "CO", "UTG", ...). */
  seats: [string, string];
  /** Each player's total bet when the flop comes (bb, the blind included): the open, 3-bet or 4-bet both called, 1 in a limped pot. */
  put: number;
  /** The BB's ante: dead money from the BB's stack, also when the BB folds. */
  bbAnte: number;
  sb?: number;
  bb?: number;
}

/**
 * Flop pot and effective stack of a heads-up pot: pot = 2 × put + the blinds of the seats that folded + the BB's ante;
 * each player has start − put behind, the BB also less its ante. A single raised pot where the BB calls is
 * srpPotStack's case: { seats: ["BB", opener], put: open }.
 */
export function huPotStack(s: HuSetup): { pot: number; stack: number } {
  const sb = s.sb ?? 0.5, bb = s.bb ?? 1;
  const [o, i] = s.seats;
  if (o === i) throw new Error(`a heads-up pot needs two seats, got ${o} twice`);
  const inSb = s.seats.includes("SB"), inBb = s.seats.includes("BB");
  if (!(s.put >= (inBb ? bb : inSb ? sb : 0)) || !(s.put > 0)) throw new Error(`put ${s.put} is below a blind of ${s.seats.join(" / ")}`);
  if (!inBb && !(s.put > bb)) throw new Error("without the BB in the pot, someone must have raised: put must be above the big blind");
  const pot = 2 * s.put + (inSb ? 0 : sb) + (inBb ? 0 : bb) + s.bbAnte;
  const stack = Math.min(...s.seats.map((seat) => s.start - s.put - (seat === "BB" ? s.bbAnte : 0)));
  if (!(stack > 0)) throw new Error(`no stack behind at the flop (start ${s.start}, put ${s.put})`);
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

/**
 * The calibration tree for pots where OOP raised last preflop (the SB's open, a blind's 3-bet, a 4-bet out of position,
 * the CO's open the BTN flats): TREE_SRP with the roles swapped, so the aggressor keeps its betting.
 *   flop   OOP bets 33% or 75%, IP may raise it by 60% of the pot after calling;
 *          after OOP checks, IP bets 50% and OOP may raise that by 60% (the check-raise);
 *          one raise per street (raiseLimit 1), so nobody re-raises;
 *   turn and river: as TREE_SRP, one 66% bet each, no raises; no all-in button (allInThreshold as TREE_SRP).
 * Without the check-raise of IP's 50% bet, IP could bet any two cards into a check it can't be raised from (the
 * artifact that dropped the donk tree, see TREE_SRP); with it the flop is TREE_SRP's mirror plus IP's one bet size.
 * A deep flop holds about 1.4 times TREE_SRP's action nodes (198,948 against 142,106 at 100bb; with `compress`, see
 * queuePack, its largest flop needs 1,928 MB, 3.6% under the job's --max-mb 2000: a size added here would get the deep
 * OOP-raiser pots' rainbow flops skipped on every run, which calibration.test.ts catches).
 */
export const TREE_OOP_AGGR: TreeSettings = {
  sizes: {
    flop: [
      { bet: [0.33, 0.75], raise: [0.6] },
      { bet: [0.5], raise: [0.6] },
    ],
    turn: both({ bet: [0.66], raise: [] }),
    river: both({ bet: [0.66], raise: [] }),
  },
  raiseLimit: 1,
  addAllIn: false,
  allInThreshold: 0.67,
  minBet: 1,
};

/**
 * The calibration tree for a limped pot (the SB completes, the BB checks): nobody has the initiative, so both players
 * bet 50% on the flop and may raise the other's bet by 60%; turn and river as TREE_SRP.
 */
export const TREE_LIMP: TreeSettings = {
  sizes: {
    flop: both({ bet: [0.5], raise: [0.6] }),
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
  const input: SolverInput = { board: board.slice(), ranges: [sc.ranges[0], sc.ranges[1]], pot: sc.meta.pot, stack: sc.meta.stack, ...treeInput(sc.meta) };
  // Only packs that record it solve with 16-bit storage; the others' input is what it always was.
  if (sc.meta.compress) input.compress = true;
  return input;
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
  /** A single raised pot the BB calls (SrpSetup), or any heads-up pot (HuSetup, whose seats must be `positions`). */
  setup: SrpSetup | HuSetup;
  /** Chart refs [OOP, IP]; a calibration pack may join several refs of one line with LINE_SEP (lineRange). */
  rangeSources: [string, string];
  /** The ranges [OOP, IP] when they don't come from the app's charts (default: chartRange of each rangeSource). */
  ranges?: [Range, Range];
  /** Calibration packs: raise every hand class of both ranges to at least this weight (ghost combos, withGhosts). */
  ghostWeight?: number;
  /** Calibration packs: per player, only the classes this range holds get ghosts (lineReach; undefined: every class). */
  ghostReach?: [Range | undefined, Range | undefined];
  /** Calibration packs: ScenarioMeta.compress, storage and aggressor (written into the meta only when set). */
  compress?: boolean;
  storage?: ScenarioMeta["storage"];
  aggressor?: ScenarioMeta["aggressor"];
  /** PresolveScenario.queue (default 0). */
  queue?: number;
  set?: PackSet;
  /** PresolveScenario.spot. */
  spot?: SpotTag;
  tree: TreeSettings;
  iterations: number;
  targetExploitability: number;
  flopSet: string;
}

function build(d: ScenarioDef): PresolveScenario {
  if ("seats" in d.setup && d.setup.seats.join() !== d.positions.join()) throw new Error(`${d.id}: setup seats ${d.setup.seats} ≠ positions ${d.positions}`);
  const { pot, stack } = "seats" in d.setup ? huPotStack(d.setup) : srpPotStack(d.setup);
  const src = d.ranges ?? [chartRange(d.rangeSources[0]), chartRange(d.rangeSources[1])];
  const g = d.ghostWeight, reach = d.ghostReach ?? [undefined, undefined];
  const [r0, r1] = g === undefined ? src : [withGhosts(src[0], g, reach[0]), withGhosts(src[1], g, reach[1])];
  const text = (p: 0 | 1) => (g === undefined ? rangeToString(src[p]) : ghostRangeString(src[p], g, reach[p]));
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
  // The same for the keys of the calibration queue: the first two calibration packs have none of them.
  if (d.compress !== undefined) meta.compress = d.compress;
  if (d.storage !== undefined) meta.storage = d.storage;
  if (d.aggressor !== undefined) meta.aggressor = d.aggressor;
  const set = d.set ?? "app";
  const sc: PresolveScenario = { id: d.id, set, title: d.title, version: d.version, tier: d.tier, meta, ranges: [rangeWeights(r0), rangeWeights(r1)], startStack: d.setup.start, queue: d.queue ?? 0 };
  if (d.spot) sc.spot = { ...d.spot };
  return sc;
}

const CASH_OPEN = openSize("cash", "100bb", "BTN"); // 2.5
const PUB_MID_OPEN = openSize("pub", "mid", "BTN"); // 2.5
const PUB_MID_OPEN_UTG = openSize("pub", "mid", "UTG"); // 2.5
const PUB_MID_START = STAGE_STACK.mid; // 55

/** The app's first three packs (complete; on the data branch since it exists). */
const LEGACY_SCENARIOS: PresolveScenario[] = [
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
    spot: { chart: "cash6", stage: "100bb", stack: 100, pot: "srp", raiser: "BTN", caller: "BB" },
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
    spot: { chart: "pub", stage: "mid", stack: PUB_MID_START, pot: "srp", raiser: "BTN", caller: "BB" },
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
    spot: { chart: "pub", stage: "mid", stack: PUB_MID_START, pot: "srp", raiser: "UTG", caller: "BB" },
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
 *
 * So the floor is the smallest weight the packs' Uint8 encoding (k/255) keeps apart from zero with room: 2/255 ≈ 0.0078,
 * which shifts the real classes about as little as 0.005 does (well under the 0.02 floor's 0.025) and still decodes to
 * a nonzero weight.
 *
 * The shift grows with the ghosts' share of a range, so in the calibration queue a player whose range comes from a line
 * of two decisions (the caller of a 3-bet or a 4-bet, the 4-bettor) gets ghosts only on the classes that reach its last
 * decision (lineReach): the hands it opened (or 3-bet), not the ones it never holds there. Ghosting every class would
 * make ghosts 15% and 12% of the 100bb-3 4-bet pot's ranges (4% and 5% of hands) and 11% / 8% of the 100bb one's. On
 * their first flop (Qs8h5h, against a no-ghost solve to 0.1% of the pot) that moved the real classes' pot share by
 * 0.037 OOP / 0.046 IP (100bb-3) and 0.029 / 0.034 (100bb), +0.02 to +0.05 signed; 1/255 on every class still moved it
 * 0.017 / 0.023 and 0.013 / 0.018; ghosts on the reaching classes only (5% and 1% of the ranges) move it 0.008 / 0.013
 * and 0.008 / 0.009, +0.001 to +0.009 signed, against 0.004 / 0.002 and 0.007 / 0.005 of convergence noise at the
 * packs' 0.5% target (0.009 / 0.012 and 0.013 / 0.011 on the rainbow Qs8h5d). A one-decision line (the BB facing an
 * open, the opener, the 3-bettor, the limper) reaches its decision with every class, so the running packs and every
 * single raised pot keep ghosts on all 169. The most they weigh then is 8% of the BTN's flat of the 100bb CO open (8% of
 * hands): there 2/255 moves the real classes 0.011 / 0.010 against a no-ghost solve at the same target, 1/255 0.006 /
 * 0.005, so the floor stays one number for every pack.
 */
export const GHOST_WEIGHT = 2 / 255;

/**
 * `range` with every hand class raised to at least `floor`; with `reach`, only the classes `reach` holds (the classes
 * that get to the player's last decision of its line, lineReach): the others stay out.
 */
export function withGhosts(range: Range, floor: number = GHOST_WEIGHT, reach?: Range): Range {
  const out = {} as Range;
  for (const h of ALL_HANDS) out[h] = reach && !((reach[h] ?? 0) > 0) ? (range[h] ?? 0) : Math.max(range[h] ?? 0, floor);
  return out;
}

/**
 * The range string of withGhosts(range, floor, reach): the source range as rangeToString writes it, then every class
 * outside it (and in `reach`, when given) at exactly `floor` (rangeToString rounds to 0.01 and drops weights below 0.005,
 * so it can't write a small floor). The source's classes keep their weight: a source weight below the floor would need
 * the merged form, so it throws, and so does a source class `reach` does not hold.
 */
export function ghostRangeString(range: Range, floor: number = GHOST_WEIGHT, reach?: Range): string {
  const ghosts: string[] = [];
  for (const h of ALL_HANDS) {
    const w = range[h] ?? 0;
    const reaches = !reach || (reach[h] ?? 0) > 0;
    if (w > 0 && w < floor) throw new Error(`${h} has weight ${w}, below the ghost floor ${floor}`);
    if (w > 0 && !reaches) throw new Error(`${h} is in the range but not in the classes that reach its decision`);
    if (!(w > 0) && reaches) ghosts.push(`${h}:${floor}`);
  }
  return [rangeToString(range), ...ghosts].filter(Boolean).join(", ");
}

/** A calibration pack's source range (src/presolve/calRanges.ts, generated by scripts/cal-ranges.mjs). */
export function calRange(ref: string): Range {
  const text = CAL_RANGES[ref];
  if (text === undefined) throw new Error(`no calibration range for ${ref}; rerun scripts/cal-ranges.mjs`);
  return parseRange(text);
}

/** Joins the refs of one preflop line in a range source: "solver/100bb-2.2/rfi-btn:open × solver/100bb-2.2/btn-open-vs-bb-3bet:call". */
export const LINE_SEP = " × ";

/**
 * The range a player brings to the flop along a preflop line: the product of its own actions' frequencies, one ref per
 * action (`one` reads a ref, e.g. calRange). The others' actions on the line don't depend on this player's hand, so they
 * don't enter (card removal aside, as everywhere in the charts). The refs are snapped to tenths, so a product is an exact
 * number of hundredths, which it is snapped to (and written exactly by rangeToString); a ref off the tenths throws.
 */
export function lineRange(source: string, one: (ref: string) => Range): Range {
  const parts = source.split(LINE_SEP);
  if (parts.length === 1) return one(source);
  // rangeToString (the meta's range strings) writes hundredths: a product of three tenths would be rounded.
  if (parts.length > 2) throw new Error(`${source}: a line of ${parts.length} refs has a product in thousandths, which the range strings can't write`);
  const rs = parts.map((ref) => {
    const r = one(ref);
    for (const h of ALL_HANDS) if (Math.abs((r[h] ?? 0) * 10 - Math.round((r[h] ?? 0) * 10)) > 1e-9) throw new Error(`${ref}: ${h} at ${r[h]} is not snapped to tenths`);
    return r;
  });
  const out: Range = {};
  for (const h of ALL_HANDS) {
    const v = rs.reduce((prod, r) => prod * (r[h] ?? 0), 1);
    if (v > 0) out[h] = Math.round(v * 100) / 100;
  }
  return out;
}

/**
 * The classes that get to the player's last decision of a line: the product of its refs but the last (lineRange), or
 * undefined for a one-ref line, whose decision every class gets to (the BB facing an open, the opener, the 3-bettor).
 * The calibration packs' ghost combos go on these classes only (withGhosts): a hand the player never holds at the
 * decision (the BTN's 72o when it calls a 3-bet, a hand it never opens) has no fold boundary to measure.
 */
export function lineReach(source: string, one: (ref: string) => Range): Range | undefined {
  const parts = source.split(LINE_SEP);
  return parts.length === 1 ? undefined : lineRange(parts.slice(0, -1).join(LINE_SEP), one);
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

// ───────────────────────── the calibration queue ─────────────────────────

/**
 * The heads-up pots of the queue, per shipped stage (QUEUE names them as <kind> and the stage's tag). "srp-hj-bb" is only
 * in the app's queue (APP_QUEUE).
 */
type QueueKind = "srp-btn-bb" | "srp-co-bb" | "srp-utg-bb" | "srp-hj-bb" | "srp-sb-bb" | "srp-co-btn" | "3bp-bb-btn" | "3bp-btn-co" | "3bp-sb-btn" | "3bp-bb-sb" | "4bp-co-btn" | "lp-sb-bb";

/** The shipped solver stages the queue calibrates and the tag of their pack ids. */
const QUEUE_STAGES: Record<string, string> = { "100bb-2.2": "100", "55bb-2.2": "55", "35bb-2": "35", "100bb-3": "100-o3" };

interface QueueSpot {
  positions: [string, string];
  /** Each player's total bet at the flop (bb). */
  put: number;
  /** [OOP, IP] spots of the stage ("<scenario>:<action>"), joined with LINE_SEP along a line. */
  spots: [string, string];
  aggressor: Player | null;
  tree: TreeSettings;
  /** Korean, for the title: the pot. */
  pot: string;
  /** Korean, for the preflop description: the line. */
  line: string;
  /** Korean, for an app pack's title: who raised and who called ("HJ 오픈 vs BB 콜", "BB 3벳 vs BTN 콜"). */
  short: string;
}

/**
 * The pots of one shipped stage, with the stage's own sizes (calRanges.ts records them; the tests check every put against
 * the chart line it comes from). A player's flop range is the product of its own actions along the line (lineRange): the
 * caller of a 3-bet brings its open × its call of the 3-bet, the 3-bettor its 3-bet range.
 */
function queueSpots(stage: string, solves: Record<string, { open: number; sizes?: Record<string, number> }> = CAL_STAGE_SOLVES): Record<QueueKind, QueueSpot> {
  const st = solves[stage];
  if (!st?.sizes) throw new Error(`no sizes recorded for stage ${stage}; rerun scripts/cal-ranges.mjs`);
  const z = st.sizes;
  const open = st.open, sbRaise = z.sbRaise;
  const ip3 = roundChips(z.ip3 * open), blind3 = roundChips(z.blind3 * open), bbVsSb3 = roundChips(z.bbVsSb3 * sbRaise), four = roundChips(z.fourOOP * ip3);
  const x = LINE_SEP;
  const vsBb = (seat: string, spot: string): QueueSpot => ({
    positions: ["BB", seat],
    put: open,
    spots: [`bb-vs-${spot}-open:call`, `rfi-${spot}:open`],
    aggressor: 1,
    tree: TREE_SRP,
    pot: `${seat} vs BB 싱글 레이즈드 팟`,
    line: `${seat} ${open}bb 오픈, 나머지 폴드, BB 콜`,
    short: `${seat} 오픈 vs BB 콜`,
  });
  return {
    "srp-btn-bb": vsBb("BTN", "btn"),
    "srp-co-bb": vsBb("CO", "co"),
    "srp-utg-bb": vsBb("UTG", "utg"),
    "srp-hj-bb": vsBb("HJ", "hj"),
    "srp-sb-bb": {
      positions: ["SB", "BB"],
      put: sbRaise,
      spots: ["rfi-sb:raise", "bb-vs-sb-open:call"],
      aggressor: 0,
      tree: TREE_OOP_AGGR,
      pot: "SB vs BB 싱글 레이즈드 팟 (SB 오픈)",
      line: `나머지 폴드, SB ${sbRaise}bb 오픈, BB 콜`,
      short: "SB 오픈 vs BB 콜",
    },
    "srp-co-btn": {
      positions: ["CO", "BTN"],
      put: open,
      spots: ["rfi-co:open", "btn-vs-co-open:call"],
      aggressor: 0,
      tree: TREE_OOP_AGGR,
      pot: "CO 오픈 vs BTN 콜 싱글 레이즈드 팟",
      line: `CO ${open}bb 오픈, BTN 콜, 블라인드 폴드`,
      short: "CO 오픈 vs BTN 콜",
    },
    "3bp-bb-btn": {
      positions: ["BB", "BTN"],
      put: blind3,
      spots: ["bb-vs-btn-open:3bet", `rfi-btn:open${x}btn-open-vs-bb-3bet:call`],
      aggressor: 0,
      tree: TREE_OOP_AGGR,
      pot: "BB 3벳 vs BTN 콜 3벳 팟",
      line: `BTN ${open}bb 오픈, SB 폴드, BB 3벳 ${blind3}bb, BTN 콜`,
      short: "BB 3벳 vs BTN 콜",
    },
    "3bp-btn-co": {
      positions: ["CO", "BTN"],
      put: ip3,
      spots: [`rfi-co:open${x}co-open-vs-btn-3bet:call`, "btn-vs-co-open:3bet"],
      aggressor: 1,
      tree: TREE_SRP,
      pot: "BTN 3벳 vs CO 콜 3벳 팟",
      line: `CO ${open}bb 오픈, BTN 3벳 ${ip3}bb, 블라인드 폴드, CO 콜`,
      short: "BTN 3벳 vs CO 콜",
    },
    "3bp-sb-btn": {
      positions: ["SB", "BTN"],
      put: blind3,
      spots: ["sb-vs-btn-open:3bet", `rfi-btn:open${x}btn-open-vs-sb-3bet:call`],
      aggressor: 0,
      tree: TREE_OOP_AGGR,
      pot: "SB 3벳 vs BTN 콜 3벳 팟",
      line: `BTN ${open}bb 오픈, SB 3벳 ${blind3}bb, BB 폴드, BTN 콜`,
      short: "SB 3벳 vs BTN 콜",
    },
    "3bp-bb-sb": {
      positions: ["SB", "BB"],
      put: bbVsSb3,
      spots: [`rfi-sb:raise${x}sb-open-vs-bb-3bet:call`, "bb-vs-sb-open:3bet"],
      aggressor: 1,
      tree: TREE_SRP,
      pot: "BB 3벳 vs SB 콜 3벳 팟",
      line: `나머지 폴드, SB ${sbRaise}bb 오픈, BB 3벳 ${bbVsSb3}bb, SB 콜`,
      short: "BB 3벳 vs SB 콜",
    },
    "4bp-co-btn": {
      positions: ["CO", "BTN"],
      put: four,
      spots: [`rfi-co:open${x}co-open-vs-btn-3bet:4bet`, `btn-vs-co-open:3bet${x}btn-3bet-vs-co-4bet:call`],
      aggressor: 0,
      tree: TREE_OOP_AGGR,
      pot: "CO 4벳 vs BTN 콜 4벳 팟",
      line: `CO ${open}bb 오픈, BTN 3벳 ${ip3}bb, 블라인드 폴드, CO 4벳 ${four}bb, BTN 콜`,
      short: "CO 4벳 vs BTN 콜",
    },
    "lp-sb-bb": {
      positions: ["SB", "BB"],
      put: 1,
      spots: ["rfi-sb:limp", "bb-vs-sb-limp:check"],
      aggressor: null,
      tree: TREE_LIMP,
      pot: "SB 림프 vs BB 체크 림프 팟",
      line: "나머지 폴드, SB 림프, BB 체크",
      short: "SB 림프 vs BB 체크",
    },
  };
}

/**
 * The calibration queue, in the order the presolve job solves it (PresolveScenario.queue 1, 2, ...), after the two short
 * stage packs. Every pack is a heads-up flop of a shipped stage of the solver chart, with that stage's own ranges and
 * sizes and ghost combos on both sides, so a refit sees the context, SPR and opponent range the chart applies the model
 * to (docs/solver-packs.md "The calibration queue" gives each pack's purpose and cost). The pots with an IP raiser come
 * first, because scripts/fit-realization.mjs can read them today (its form is the IP-aggressor pot, and it refuses the
 * others until a fit with c and u per context exists):
 *   1–7    the main stage (100bb, 2.2bb opens) and the SPR curve of its BTN vs BB pot (35bb 5.8, 55bb 8.8, 100bb 16.4,
 *          next to the running 2.2 and 3.1): opener ranges vs the BB, the IP 3-bettor, the BB's 3-bet of the SB;
 *   8–13   the IP-raiser 3-bet pots of the other stages (SPR 1.7–4.4), for the low-SPR α rule;
 *   14–20  the opener series vs the BB of the other stages;
 * then the pots with an OOP raiser and the limped pots, in the same order of value:
 *   21–26  the main stage: the blinds' 3-bets, the SB's open, the small 4-bet pot, the IP caller, the limped pot;
 *   27–33  the OOP-raiser 3-bet and 4-bet pots of the other stages (SPR 1.5–3.9): α and the 4-bet / jam split;
 *   34–41  the SB's opens, the IP callers and the limped pots of the other stages.
 * At 35bb the BTN flats the CO's open with 0.9% of hands, so that pot is not in the queue.
 */
const QUEUE: [QueueKind, string][] = [
  // Pots with an IP raiser, which scripts/fit-realization.mjs reads today (its form is the IP-aggressor pot).
  ["srp-btn-bb", "35bb-2"],
  ["srp-btn-bb", "100bb-2.2"],
  ["srp-utg-bb", "100bb-2.2"],
  ["srp-co-bb", "100bb-2.2"],
  ["3bp-btn-co", "100bb-2.2"],
  ["srp-btn-bb", "55bb-2.2"],
  ["3bp-bb-sb", "100bb-2.2"],
  ["3bp-btn-co", "55bb-2.2"],
  ["3bp-bb-sb", "55bb-2.2"],
  ["3bp-btn-co", "100bb-3"],
  ["3bp-bb-sb", "100bb-3"],
  ["3bp-btn-co", "35bb-2"],
  ["3bp-bb-sb", "35bb-2"],
  ["srp-utg-bb", "55bb-2.2"],
  ["srp-co-bb", "55bb-2.2"],
  ["srp-utg-bb", "35bb-2"],
  ["srp-co-bb", "35bb-2"],
  ["srp-btn-bb", "100bb-3"],
  ["srp-utg-bb", "100bb-3"],
  ["srp-co-bb", "100bb-3"],
  // Pots with an OOP raiser and limped pots: the fit refuses them until it has c and u per context.
  ["3bp-bb-btn", "100bb-2.2"],
  ["srp-sb-bb", "100bb-2.2"],
  ["3bp-sb-btn", "100bb-2.2"],
  ["4bp-co-btn", "100bb-2.2"],
  ["srp-co-btn", "100bb-2.2"],
  ["lp-sb-bb", "100bb-2.2"],
  ["3bp-bb-btn", "55bb-2.2"],
  ["3bp-sb-btn", "55bb-2.2"],
  ["3bp-bb-btn", "100bb-3"],
  ["4bp-co-btn", "100bb-3"],
  ["3bp-sb-btn", "100bb-3"],
  ["3bp-bb-btn", "35bb-2"],
  ["3bp-sb-btn", "35bb-2"],
  ["srp-sb-bb", "55bb-2.2"],
  ["srp-co-btn", "55bb-2.2"],
  ["lp-sb-bb", "55bb-2.2"],
  ["srp-sb-bb", "35bb-2"],
  ["lp-sb-bb", "35bb-2"],
  ["srp-sb-bb", "100bb-3"],
  ["srp-co-btn", "100bb-3"],
  ["lp-sb-bb", "100bb-3"],
];

/**
 * One pack of the queue. Like the short-stage packs (calPack) it starts from pinned chart ranges (calRanges.ts) with
 * ghost combos (on the classes that reach each player's last decision, lineReach), 300 iterations at most and 0.5% of
 * the pot; unlike them it
 *   - solves with 16-bit storage (`compress`): with (nearly) every combo in both ranges a deep flop needs up to 3.8 GB
 *     in Float32 on a rainbow board, over the job's --max-mb 2000 and a quarter of a 16 GB runner; compressed every flop
 *     of the queue fits in 1.93 GB (calibration.test.ts pins it under 1.95e9: a bigger tree would push the deep
 *     OOP-raiser pots' rainbow flops over --max-mb, and they would be skipped every run), at about 13% more time per
 *     iteration (docs/solver.md);
 *   - writes slim files (`storage: "rootClasses"`): the ranges per class and each class's root EV for both players, all
 *     that scripts/fit-realization.mjs reads, about 2.5 KB a flop instead of 55;
 *   - records the preflop aggressor, and an OOP aggressor gets TREE_OOP_AGGR (a limped pot TREE_LIMP).
 */
function queuePack(kind: QueueKind, stage: string, queue: number): ScenarioDef {
  const tag = QUEUE_STAGES[stage];
  if (tag === undefined) throw new Error(`stage ${stage} is not in the queue's stages`);
  const st = CAL_STAGE_SOLVES[stage];
  const q = queueSpots(stage)[kind];
  const sources = q.spots.map((spot) => spot.split(LINE_SEP).map((s) => `solver/${stage}/${s}`).join(LINE_SEP)) as [string, string];
  return {
    id: `cal-${kind}-${tag}`,
    title: `보정용 ${q.pot} (솔버 ${st.stack}bb · 오픈 ${st.open}bb)`,
    version: 1,
    tier: "free",
    format: "pub",
    positions: q.positions,
    preflop: `9인 모두 ${st.stack}bb, ${q.line} (BB 앤티 1bb)`,
    setup: { start: st.stack, seats: q.positions, put: q.put, bbAnte: 1 },
    rangeSources: sources,
    ranges: [lineRange(sources[0], calRange), lineRange(sources[1], calRange)],
    ghostWeight: GHOST_WEIGHT,
    ghostReach: [lineReach(sources[0], calRange), lineReach(sources[1], calRange)],
    compress: true,
    storage: "rootClasses",
    aggressor: q.aggressor,
    queue,
    set: "calibration",
    tree: q.tree,
    iterations: 300,
    targetExploitability: 0.5,
    flopSet: "priority",
  };
}

// ───────────────────────── the app queue ─────────────────────────

/** The app's solver-chart pots: what a 9-handed BB-ante pub tournament player meets most heads-up. */
export type AppKind = "srp-utg-bb" | "srp-hj-bb" | "srp-co-bb" | "srp-btn-bb" | "srp-sb-bb" | "3bp-bb-btn" | "3bp-btn-co" | "3bp-sb-btn";

/** The shipped solver stages the app's packs come from and the tag of their pack ids. */
export const APP_STAGES: Record<string, string> = { "55bb-2.2": "55", "35bb-2": "35", "100bb-2.2": "100" };

/** An app pack's source range (src/presolve/appRanges.ts, generated by scripts/cal-ranges.mjs --app). */
export function appRange(ref: string): Range {
  const text = APP_RANGES[ref];
  if (text === undefined) throw new Error(`no app range for ${ref}; rerun scripts/cal-ranges.mjs --app`);
  return parseRange(text);
}

/**
 * The app's solver-chart packs, in the order the presolve job solves them (PresolveScenario.queue below 0, so before
 * every calibration pack; the app's first three packs and the first calibration packs are 0, the calibration queue 1–41):
 *   −3  the single raised pots against the BB at 55bb and 35bb (the spots met most often), interleaved;
 *   −2  the 3-bet pots BB vs BTN, BTN vs CO, SB vs BTN at 55bb and 35bb;
 *   −1  all eight at 100bb.
 * `queue` is only the order: moving a pack needs no version bump (docs/solver-packs.md "The app queue").
 */
export const APP_QUEUE: [AppKind, string, number][] = [
  ["srp-utg-bb", "55bb-2.2", -3],
  ["srp-hj-bb", "55bb-2.2", -3],
  ["srp-co-bb", "55bb-2.2", -3],
  ["srp-btn-bb", "55bb-2.2", -3],
  ["srp-sb-bb", "55bb-2.2", -3],
  ["3bp-bb-btn", "55bb-2.2", -2],
  ["3bp-btn-co", "55bb-2.2", -2],
  ["3bp-sb-btn", "55bb-2.2", -2],
  ["srp-utg-bb", "35bb-2", -3],
  ["srp-hj-bb", "35bb-2", -3],
  ["srp-co-bb", "35bb-2", -3],
  ["srp-btn-bb", "35bb-2", -3],
  ["srp-sb-bb", "35bb-2", -3],
  ["3bp-bb-btn", "35bb-2", -2],
  ["3bp-btn-co", "35bb-2", -2],
  ["3bp-sb-btn", "35bb-2", -2],
  ["srp-utg-bb", "100bb-2.2", -1],
  ["srp-hj-bb", "100bb-2.2", -1],
  ["srp-co-bb", "100bb-2.2", -1],
  ["srp-btn-bb", "100bb-2.2", -1],
  ["srp-sb-bb", "100bb-2.2", -1],
  ["3bp-bb-btn", "100bb-2.2", -1],
  ["3bp-btn-co", "100bb-2.2", -1],
  ["3bp-sb-btn", "100bb-2.2", -1],
];

/**
 * One app pack: a heads-up flop of a shipped stage of the solver chart, with the stage's own ranges (pinned in
 * appRanges.ts; a player's flop range is the product of its own actions along the line, lineRange) and sizes. Full flop
 * files like the first three packs (every flop node at depth ≤ 2, viewable), 300 iterations at most, 0.5% of the pot,
 * no ghost combos. An IP raiser gets TREE_SRP (the first packs' tree), an OOP raiser TREE_OOP_AGGR (the queue's tree, so
 * the 3-bettor or the SB keeps its betting). The SB's open is solved with 16-bit storage: its Float32 rainbow flops need
 * more than the job's --max-mb 2000 at 55bb and 100bb.
 */
function appPack(kind: AppKind, stage: string, queue: number): ScenarioDef {
  const tag = APP_STAGES[stage];
  if (tag === undefined) throw new Error(`stage ${stage} is not an app stage`);
  const st = APP_STAGE_SOLVES[stage];
  if (!st) throw new Error(`no app ranges for stage ${stage}; rerun scripts/cal-ranges.mjs --app`);
  const q = queueSpots(stage, APP_STAGE_SOLVES)[kind];
  const sources = q.spots.map((spot) => spot.split(LINE_SEP).map((s) => `solver/${stage}/${s}`).join(LINE_SEP)) as [string, string];
  const agg = q.aggressor as Player;
  // The chart's lowest confidence among the spots of both lines (an open × its call of the 3-bet: both spots count).
  const RANK = { low: 0, mid: 1, high: 2 } as const;
  let confidence: "high" | "mid" | "low" = "high";
  for (const part of q.spots.flatMap((spot) => spot.split(LINE_SEP))) {
    const c = st.confidence?.[part.split(":")[0]];
    if (!c) throw new Error(`no chart confidence for ${part} at ${stage}; rerun scripts/cal-ranges.mjs --app`);
    if (RANK[c] < RANK[confidence]) confidence = c;
  }
  return {
    id: `sv-${kind}-${tag}`,
    title: `${q.short} · ${st.stack}bb`,
    version: 1,
    tier: "free",
    format: "pub",
    positions: q.positions,
    preflop: `${q.line} (9인 모두 ${st.stack}bb, BB 앤티 1bb)`,
    setup: { start: st.stack, seats: q.positions, put: q.put, bbAnte: 1 },
    rangeSources: sources,
    ranges: [lineRange(sources[0], appRange), lineRange(sources[1], appRange)],
    ...(kind === "srp-sb-bb" ? { compress: true } : {}),
    aggressor: agg,
    queue,
    spot: { chart: "solver", stage, stack: st.stack, pot: kind.startsWith("3bp") ? "3bp" : "srp", raiser: q.positions[agg], caller: q.positions[1 - agg], confidence },
    tree: q.tree,
    iterations: 300,
    targetExploitability: 0.5,
    flopSet: "priority",
  };
}

/** The app's packs: the first three, then the solver-chart packs of APP_QUEUE. */
export const SCENARIOS: PresolveScenario[] = [...LEGACY_SCENARIOS, ...APP_QUEUE.map(([kind, stage, queue]) => build(appPack(kind, stage, queue)))];

/** The app packs the code defines that have no file yet, for the catalog's `planned` list (the picker's 준비 중). */
export function plannedPacks(withFiles: ReadonlySet<string>): PlannedPack[] {
  return SCENARIOS.filter((sc) => !withFiles.has(sc.id)).map((sc) => {
    const p: PlannedPack = { id: sc.id, title: sc.title, pot: sc.meta.pot, stack: sc.meta.stack };
    if (sc.spot) p.spot = { ...sc.spot };
    return p;
  });
}

/**
 * Calibration packs (calibration/packs, never listed by the app). First the two short-stage packs: the realization model
 * of the preflop solver at SPR 2–3, where it decides the short stages' BB defense (docs/preflop-solver.md), from the
 * short stages' draft solve with the shipped fit (calRanges.ts), with ghost combos on both sides. Then the calibration
 * queue (QUEUE), solved one pack after the other in priority order.
 */
export const CAL_SCENARIOS: PresolveScenario[] = [build(calPack(20)), build(calPack(15)), ...QUEUE.map(([kind, stage], i) => build(queuePack(kind, stage, i + 1)))];

/** Every pack of both sets, the app's first. */
export const ALL_SCENARIOS: PresolveScenario[] = [...SCENARIOS, ...CAL_SCENARIOS];

export function getScenario(id: string): PresolveScenario {
  const sc = ALL_SCENARIOS.find((s) => s.id === id);
  if (!sc) throw new Error(`unknown presolve scenario: ${id} (known: ${ALL_SCENARIOS.map((s) => s.id).join(", ")})`);
  return sc;
}
