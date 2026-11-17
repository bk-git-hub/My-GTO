import type { TableSetup } from "../pushfold";
import type { OpenJamSetup } from "../openjam";

/**
 * Preflop action tree for the 9-handed, BB-ante preflop solver (§ numbers refer to the solver design,
 * which docs/preflop-solver.md will carry).
 *
 * The tree is built once per stage and handed to the solver as flat typed arrays (hot path) plus
 * per-node and per-terminal metadata objects (export, scenario mapping, tests).
 *
 * Exported API
 * ------------
 * Configuration
 *  - `StageConfig`: every size and switch of one tree (§2.0).
 *  - `STAGE_PRESETS` / `stageConfig(id, overrides?)`: the stages of §1.2
 *    ("100bb-2.2", "100bb-3", "55bb-2.2", "35bb-2" optional, "25bb-2" check only).
 *  - `pushFoldConfig(setup)`: mode "pushfold", the game of `solvePushFold` for the same `TableSetup`.
 *  - `openJamConfig(setup)`: mode "openjam", the game of `solveOpenJam` (valuation "oneSided").
 *  - `openOr3BetConfig(overrides?)`: the small 100bb test tree of §5.1 (no cold calls, overcalls,
 *    squeezes, SB limps or cold jams).
 *
 * Seats
 *  - Seats are 0..n-1 in preflop order; SB = n-2, BB = n-1 (`blindSeats(n)`), never literals.
 *  - `postRank(seat, n)`: postflop acting order, 0 acts first (SB, BB, then 0..n-3; heads-up the BB
 *    acts first). `seatNames(n)`: display names in preflop order.
 *
 * Tree (`buildTree(cfg): PreflopTree`)
 *  - Decision nodes are numbered 0..nodeCount-1 in DFS pre-order (node 0 is the root, so a child
 *    always has a larger index than its parent). Nodes with a single legal action are collapsed (R7).
 *  - Node i owns the edges actStart[i] .. actStart[i+1]-1, contiguous and in display order. A
 *    solver can therefore keep one Float64Array(edgeCount * classes) for regrets and strategy sums
 *    and address node i's action a at (actStart[i] + a) * classes.
 *  - Per node: `seat`, `actStart`, `foldIdx` (local index of F, -1 when there is no fold), `raisesAt`,
 *    `depth`, `parent`, `parentEdge`; `maxDepth` sizes per-depth scratch vectors.
 *  - Per edge: `actKey` (ACT codes of F/C/X/L/R/J), `actTo` (the actor's total bet after the action,
 *    ante excluded), `child`: >= 0 is a decision node, < 0 is the terminal ~child (`isTerminal`,
 *    `terminalOf`).
 *  - Per terminal, in DFS order: `termKind` (TERM.WIN / ALLIN / FLOP), `termParentEdge`, `termPot`
 *    (P = Σ T_s), `termCommit[t*n + s]` (T_s = bet + the ante for the BB), `termNLive`,
 *    `termSeats[t*4 + k]` (live seats in postflop order, -1 padded; the winner for WIN),
 *    `termPotType` (POT codes, NO_POT unless FLOP), `termAggressor` (-1 in a limped pot or when not a
 *    flop), `termSpr` (flop SPR, else 0), `termAllinPot` (P' = P - refund for ALLIN, else P),
 *    `termRefund` / `termRefundSeat` (uncalled chips returned at an all-in, -1 when none),
 *    `termFrozen` / `termFrozenRaisers` (how many seats with voluntary chips, and how many of them
 *    raisers, the first call of a jam folded out under R1: PF-FROZEN, PF-TREE-2).
 *  - `terminalNets(tree, t, shares, out)`: the §3 chip accounting. Folded seats get -T_s, a WIN gives
 *    the winner P - T_w, an ALLIN gives share·P' + refund - T_s, a FLOP gives share·P - T_s. `shares`
 *    are per live seat in `termSeats` order (all-in equities, or flop pot shares).
 *  - Metadata: `nodes[i]: NodeInfo` (actor, actions with key/to/verb, the public line, bets, opener,
 *    threeBettor, callers, limped, raiseSeq, the jam being faced) and `terms[t]: TermInfo` (the same
 *    plus the closing caller, the jammer and the folded-out seats). `lineText(line, n)` renders a line.
 *  - `treeCounts(tree)`: node, edge and terminal counts by kind, as snapshotted in tree.test.ts.
 */

// ───────────── configuration (§2.0, §1.2) ─────────────

export interface StageConfig {
  /** Seats, 2..9 (9 for every shipped stage; fewer only in tests). */
  players: number;
  /** Starting stack of every seat, in bb. The BB's live stack is S - ante. */
  S: number;
  sb: number;
  bb: number;
  /** BB ante: dead money paid from the BB's stack. */
  ante: number;
  /** First-in raise size (total bb) for UTG..BTN. */
  open: number;
  /** The SB's first-in raise size. */
  sbRaise: number;
  /** The BB's raise size over an SB limp. */
  iso: number;
  /** 3-bet multipliers of r_open: in position, from the blinds, and the BB against an SB open. */
  ip3: number;
  blind3: number;
  bbVsSb3: number;
  /** Extra r_open per cold caller in a squeeze, IP and from the blinds. */
  sqzPerCallerIP: number;
  sqzPerCallerBlind: number;
  /** 4-bet multipliers of the 3-bet when the 4-bettor is IP / OOP postflop. */
  fourIP: number;
  fourOOP: number;
  /** The SB's re-raise over the BB's iso, as a multiple of the iso. */
  limpReraise: number;
  /** Jams below the 4-bet level exist only when the jam is at most this many bb. */
  jamMax: number;
  /** A non-all-in raise must leave at least this SPR after a call, otherwise it becomes a jam. */
  minSprAfterCall: number;
  /** Most players to see a flop; the BB may make it one more. */
  maxFlop: number;
  /** Test and ablation switches; every shipped stage has them all on. */
  coldCall: boolean;
  overcall: boolean;
  squeeze: boolean;
  sbLimp: boolean;
  /** "jam": a cold player behind a 3-bet may jam (R5). "none": it may only fold. */
  cold4: "none" | "jam";
  /** "priority": R1's answer order for re-raising jams. "table": the old rule, for PF-ABLATE only. */
  allinOrder: "priority" | "table";
  /** "full" is the solver's tree; "pushfold" and "openjam" reproduce the reference solvers' games. */
  mode: "full" | "pushfold" | "openjam";
  /** The heads-up flop kernel the valuation uses (§3.4). The tree itself does not read it. */
  valuation: "modelB" | "oneSided" | "equity";
}

export type StageId = "100bb-2.2" | "100bb-3" | "55bb-2.2" | "35bb-2" | "25bb-2";

export interface StagePreset {
  id: StageId;
  /** Korean label shown in the chart set ("" for the stage that is solved but never shipped). */
  label: string;
  /** required: the generator fails without it; optional: dropped with a warning if a gate fails;
   *  check: solved only for the PF-OVERLAP comparison with shortNash 25bb. */
  status: "required" | "optional" | "check";
  cfg: StageConfig;
}

/** Everything the §1.2 stages share. */
const SHIPPED_BASE = {
  players: 9,
  sb: 0.5,
  bb: 1,
  ante: 1,
  ip3: 3,
  bbVsSb3: 3,
  sqzPerCallerIP: 1,
  sqzPerCallerBlind: 1.25,
  fourIP: 2.3,
  fourOOP: 2.5,
  limpReraise: 3,
  jamMax: 40,
  minSprAfterCall: 1,
  maxFlop: 3,
  coldCall: true,
  overcall: true,
  squeeze: true,
  sbLimp: true,
  cold4: "jam",
  allinOrder: "priority",
  mode: "full",
  valuation: "modelB",
} as const satisfies Omit<StageConfig, "S" | "open" | "sbRaise" | "iso" | "blind3">;

const stage = (S: number, open: number, sbRaise: number, iso: number, blind3: number): StageConfig => ({ ...SHIPPED_BASE, S, open, sbRaise, iso, blind3 });

export const STAGE_PRESETS: readonly StagePreset[] = [
  { id: "100bb-2.2", label: "100bb · 2.2bb 오픈", status: "required", cfg: stage(100, 2.2, 3, 3.5, 4) },
  // The pub size: blind 3-bets are play mode's pub threeBetSize (3.5x), not 4x.
  { id: "100bb-3", label: "100bb · 3bb 오픈 (펍 사이즈)", status: "required", cfg: stage(100, 3, 3.5, 3.5, 3.5) },
  { id: "55bb-2.2", label: "55bb · 2.2bb 오픈", status: "required", cfg: stage(55, 2.2, 3, 3.5, 4) },
  { id: "35bb-2", label: "35bb · 2bb 오픈", status: "optional", cfg: stage(35, 2, 2.5, 3, 4) },
  { id: "25bb-2", label: "", status: "check", cfg: stage(25, 2, 2.5, 3, 4) },
];

/** A fresh copy of a stage's config, with optional overrides (ablations, the cold4 fallback). */
export function stageConfig(id: StageId, overrides: Partial<StageConfig> = {}): StageConfig {
  const p = STAGE_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown stage ${id}`);
  return { ...p.cfg, ...overrides };
}

/**
 * The tree of solvePushFold for the same setup: first in F/J, then F/C in table order, the first call
 * closes. The size fields are never read in this mode; they keep the 100bb-2.2 values.
 */
export function pushFoldConfig(setup: TableSetup): StageConfig {
  const { players, stack: S, sb, bb, bbAnte: ante } = setup;
  return stageConfig("100bb-2.2", { players, S, sb, bb, ante, mode: "pushfold", valuation: "equity" });
}

/**
 * The tree of solveOpenJam for the same setup. bbRealization is a valuation input (the "oneSided"
 * kernel), not part of the tree. Sizes other than the open are never read in this mode.
 */
export function openJamConfig(setup: Omit<OpenJamSetup, "bbRealization">): StageConfig {
  const { players, stack: S, sb, bb, bbAnte: ante, open } = setup;
  return stageConfig("100bb-2.2", { players, S, sb, bb, ante, open, mode: "openjam", valuation: "oneSided" });
}

/**
 * The small "open or 3-bet" test tree of §5.1 (PF-ZERO-1, PF-DET-1): 100bb / 2.2, where the only
 * flat is the BB's. SB limps and cold jams are off too, which is the 188-node prototype tree the
 * design quotes. PF-CONS-1 (a) turns coldCall, overcall and squeeze back on through `overrides`.
 */
export function openOr3BetConfig(overrides: Partial<StageConfig> = {}): StageConfig {
  return stageConfig("100bb-2.2", { coldCall: false, overcall: false, squeeze: false, sbLimp: false, cold4: "none", ...overrides });
}

// ───────────── seats ─────────────

export const blindSeats = (players: number) => ({ SB: players - 2, BB: players - 1 });

/**
 * Postflop acting order, 0 acting first. For n >= 3: SB, BB, then seats 0..n-3 in table order.
 * Heads-up the SB has the button, so it acts last postflop.
 */
export function postRank(seat: number, players: number): number {
  const SB = players - 2;
  const BB = players - 1;
  if (players === 2) return seat === BB ? 0 : 1;
  return seat === SB ? 0 : seat === BB ? 1 : seat + 2;
}

const SEAT_NAMES: Record<number, string[]> = {
  2: ["SB", "BB"],
  3: ["BTN", "SB", "BB"],
  4: ["CO", "BTN", "SB", "BB"],
  5: ["HJ", "CO", "BTN", "SB", "BB"],
  6: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  7: ["UTG", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  8: ["UTG", "UTG+1", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  9: ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
};

/** Seat names in preflop order, the same tables as the hand recorder. */
export function seatNames(players: number): string[] {
  const names = SEAT_NAMES[players];
  if (!names) throw new Error(`players must be 2..9, got ${players}`);
  return names;
}

// ───────────── tree types ─────────────

export type ActionKey = "F" | "C" | "X" | "L" | "R" | "J";
/** ACT codes as stored in `actKey`; ACTION_KEYS[code] is the key. */
export const ACT = { F: 0, C: 1, X: 2, L: 3, R: 4, J: 5 } as const;
export const ACTION_KEYS: readonly ActionKey[] = ["F", "C", "X", "L", "R", "J"];

/** What an action does in poker terms; the §6.4 generic scenario ids use these words. */
export type Verb = "fold" | "check" | "call" | "limp" | "open" | "iso" | "3bet" | "squeeze" | "reraise" | "4bet" | "jam";

export type TermKind = "win" | "allin" | "flop";
export const TERM = { WIN: 0, ALLIN: 1, FLOP: 2 } as const;
export const TERM_KINDS: readonly TermKind[] = ["win", "allin", "flop"];

export type PotType = "limp" | "srp" | "3bp" | "4bp";
/** POT codes as stored in `termPotType`; POT_TYPES[code] is the type. NO_POT for non-flop terminals. */
export const POT = { LIMP: 0, SRP: 1, THREE_BET: 2, FOUR_BET: 3 } as const;
export const POT_TYPES: readonly PotType[] = ["limp", "srp", "3bp", "4bp"];
export const NO_POT = 255;

export interface LineStep {
  readonly seat: number;
  readonly key: ActionKey;
  /** The seat's total bet after the action (ante excluded). */
  readonly to: number;
  readonly verb: Verb;
  /** A collapsed single-action node (R7), e.g. a fold behind a called jam. */
  readonly forced: boolean;
}

export interface ActionInfo {
  key: ActionKey;
  to: number;
  verb: Verb;
}

/** Public state at a decision node, for export and the §6.4 scenario mapping. */
export interface NodeInfo {
  id: number;
  seat: number;
  parent: number;
  /** Index of the action within the parent node that leads here (-1 for the root). */
  parentAction: number;
  depth: number;
  actions: ActionInfo[];
  /** Every action so far, forced folds included. */
  line: readonly LineStep[];
  /** Bets per seat at this node (ante excluded). */
  bet: readonly number[];
  /** Seats that have not folded, in table order. */
  active: readonly number[];
  maxBet: number;
  /** Σ bet + ante. */
  pot: number;
  /** Voluntary raises so far: 0 unopened (an SB limp does not count), 1 open, 2 3-bet, 3 4-bet, 4 5-bet jam. */
  raises: number;
  limped: boolean;
  opener: number;
  threeBettor: number;
  lastRaiser: number;
  /** Seats that called raise 1, in order (cold callers and overcallers; the SB calling an iso). */
  callers: readonly number[];
  called3b: boolean;
  /** Every raise in order, as seats (opens, an iso, 3-bets, squeezes, 4-bets, jams). */
  raiseSeq: readonly number[];
  /** The actor faces an uncalled all-in (R1). */
  facingJam: boolean;
  /** The seat whose jam is being faced, -1 if none. */
  jammer: number;
  /** That jam was raise 1 (answered in table order), not a re-raising jam (answered in R1 priority order). */
  jamFirstIn: boolean;
  /** The actor has acted before in this hand (a forced action counts). */
  heroActed: boolean;
}

export interface TermInfo {
  id: number;
  kind: TermKind;
  /** The decision node whose action ends here, and that action's index. */
  parent: number;
  parentAction: number;
  line: readonly LineStep[];
  /** Live seats in postflop order (the winner alone for "win"). */
  seats: readonly number[];
  bet: readonly number[];
  /** T_s = bet + the ante for the BB. */
  commit: readonly number[];
  pot: number;
  /** P' for "allin" (the pot minus uncalled chips), else the pot. */
  allinPot: number;
  refund: number;
  refundSeat: number;
  potType: PotType | null;
  aggressor: number;
  spr: number;
  raises: number;
  limped: boolean;
  opener: number;
  threeBettor: number;
  callers: readonly number[];
  raiseSeq: readonly number[];
  /** The all-in that was called or won uncontested, -1 if none. */
  jammer: number;
  /** The seat whose call closed the action on a jam, -1 if none. */
  closer: number;
  /** Seats with voluntary chips that the closing call folded out (R1), and those of them that had raised. */
  frozen: readonly number[];
  frozenRaisers: readonly number[];
}

export interface PreflopTree {
  cfg: StageConfig;
  n: number;
  sbSeat: number;
  bbSeat: number;
  nodeCount: number;
  edgeCount: number;
  termCount: number;
  maxDepth: number;
  // decision nodes
  seat: Uint8Array;
  actStart: Int32Array;
  foldIdx: Int8Array;
  raisesAt: Uint8Array;
  depth: Uint8Array;
  parent: Int32Array;
  parentEdge: Int32Array;
  // edges
  actKey: Uint8Array;
  actTo: Float64Array;
  child: Int32Array;
  // terminals
  termKind: Uint8Array;
  termParentEdge: Int32Array;
  termPot: Float64Array;
  termCommit: Float64Array;
  termNLive: Uint8Array;
  termSeats: Int8Array;
  termPotType: Uint8Array;
  termAggressor: Int8Array;
  termSpr: Float64Array;
  termAllinPot: Float64Array;
  termRefund: Float64Array;
  termRefundSeat: Int8Array;
  termFrozen: Uint8Array;
  termFrozenRaisers: Uint8Array;
  // metadata
  nodes: NodeInfo[];
  terms: TermInfo[];
}

/** Child codes below 0 are terminals. */
export const isTerminal = (child: number) => child < 0;
export const terminalOf = (child: number) => ~child;

/** Most live seats at a flop: maxFlop is at most 3 and the BB may add one. */
const MAX_LIVE = 4;
const EPS = 1e-9;
/** Sizes are rounded to 0.01bb. */
const round2 = (x: number) => Math.round(x * 100) / 100;

// ───────────── builder (§2.1–2.4) ─────────────

interface State {
  bet: number[];
  folded: boolean[];
  allin: boolean[];
  maxBet: number;
  raises: number;
  limped: boolean;
  opener: number;
  threeBettor: number;
  lastRaiser: number;
  raiseSeq: number[];
  callers: number[];
  called3b: boolean;
  allinCalled: boolean;
  jammer: number;
  jamFirstIn: boolean;
  closer: number;
  queue: number[];
  line: LineStep[];
  frozen: number[];
  frozenRaisers: number[];
}

const cloneState = (st: State): State => ({
  ...st,
  bet: st.bet.slice(),
  folded: st.folded.slice(),
  allin: st.allin.slice(),
  raiseSeq: st.raiseSeq.slice(),
  callers: st.callers.slice(),
  queue: st.queue.slice(),
  line: st.line.slice(),
  frozen: st.frozen.slice(),
  frozenRaisers: st.frozenRaisers.slice(),
});

function validate(cfg: StageConfig) {
  if (!Number.isInteger(cfg.players) || cfg.players < 2 || cfg.players > 9) throw new Error(`players must be 2..9, got ${cfg.players}`);
  if (!(cfg.S > cfg.ante) || cfg.sb < 0 || cfg.bb < cfg.sb || cfg.ante < 0) throw new Error("bad blinds or stack");
  if (cfg.maxFlop + 1 > MAX_LIVE || cfg.maxFlop < 2) throw new Error("maxFlop must be 2 or 3");
}

export function buildTree(cfg: StageConfig): PreflopTree {
  validate(cfg);
  const n = cfg.players;
  const { SB, BB } = blindSeats(n);
  const live = Array.from({ length: n }, (_, s) => cfg.S - (s === BB ? cfg.ante : 0));
  const blind = (s: number) => (s === SB ? cfg.sb : s === BB ? cfg.bb : 0);
  const rank = (s: number) => postRank(s, n);

  // Growable outputs, packed into typed arrays at the end.
  const nSeat: number[] = [], nActStart: number[] = [], nFold: number[] = [], nRaises: number[] = [];
  const nDepth: number[] = [], nParent: number[] = [], nParentEdge: number[] = [];
  const eKey: number[] = [], eTo: number[] = [], eChild: number[] = [];
  const nodes: NodeInfo[] = [];
  const terms: TermInfo[] = [];
  const termEdge: number[] = [];
  let maxDepth = 0;

  const facingJamOf = (st: State) => !st.allinCalled && st.allin.some((a, o) => a && !st.folded[o]);

  /** The legal actions of seat s, in display order (§2.3 R1–R6, or a reduction mode's rules). */
  function legal(st: State, s: number): ActionInfo[] {
    const moves: ActionInfo[] = [];
    const add = (key: ActionKey, to: number, verb: Verb) => moves.push({ key, to, verb });
    const fold = () => add("F", st.bet[s], "fold");
    // R2: the first call of a jam closes the action.
    if (st.allinCalled) {
      fold();
      return moves;
    }
    // §2.2 size helpers.
    let maxOther = 0;
    for (let o = 0; o < n; o++) if (o !== s && !st.folded[o]) maxOther = Math.max(maxOther, live[o]);
    const jamTo = Math.min(live[s], maxOther);
    let potNow = cfg.ante;
    for (let o = 0; o < n; o++) potNow += st.bet[o];
    const okSize = (to: number) => {
      if (!(to < jamTo - EPS)) return false;
      const potAfterCall = potNow + (to - st.bet[s]) + (to - st.maxBet);
      // Multiplied out with a tolerance, so that an exact SPR of 1 passes despite rounding.
      return jamTo - to >= cfg.minSprAfterCall * potAfterCall - EPS;
    };
    const jamOk = jamTo <= cfg.jamMax + EPS || st.raises >= 2;
    const facingJam = facingJamOf(st);
    const call = () => add("C", Math.min(st.maxBet, live[s]), "call");
    const jam = () => add("J", jamTo, "jam");
    // A non-jam raise must stay below the jam. Opens are not size-checked otherwise (§2.3 R3); this
    // guard only matters for degenerate test stacks.
    const below = (to: number) => to < jamTo - EPS;

    if (cfg.mode === "pushfold") {
      if (facingJam) {
        fold();
        call();
      } else if (st.raises === 0 && s !== BB) {
        fold();
        jam();
      } else if (st.raises === 0) add("X", st.bet[s], "check"); // unreachable: the BB wins when folded to
      else throw new Error("pushfold: a raise that is not a jam");
      return moves;
    }

    if (cfg.mode === "openjam") {
      if (facingJam) {
        // A first-in jam is answered in table order; over an open only the opener answers a re-jam
        // and everyone else folds, as in solveOpenJam.
        fold();
        if (st.jamFirstIn || s === st.opener) call();
      } else if (st.raises === 0 && s !== BB) {
        fold();
        if (below(cfg.open)) add("R", cfg.open, "open");
        jam();
      } else if (st.raises === 0) add("X", st.bet[s], "check"); // unreachable, as above
      else if (st.raises === 1) {
        fold();
        if (s === BB) call();
        jam();
      } else throw new Error("openjam: a raise beyond the open");
      return moves;
    }

    // R1: facing an uncalled all-in.
    if (facingJam) {
      fold();
      call();
      return moves;
    }
    const r = st.maxBet;
    switch (st.raises) {
      case 0: {
        // R3: unopened.
        if (s === BB) {
          // Only after an SB limp: the BB never folds here.
          add("X", st.bet[s], "check");
          if (okSize(cfg.iso)) add("R", cfg.iso, "iso");
          if (jamOk) jam();
        } else if (s === SB) {
          fold();
          if (cfg.sbLimp) add("L", st.maxBet, "limp");
          if (below(cfg.sbRaise)) add("R", cfg.sbRaise, "open");
          if (jamOk) jam();
        } else {
          fold();
          if (below(cfg.open)) add("R", cfg.open, "open");
          if (jamOk) jam();
        }
        break;
      }
      case 1: {
        // R4: facing raise 1.
        fold();
        if (st.limped && st.opener === BB) {
          // The SB facing the BB's iso: the re-raise jams like any other 3-bet-level raise.
          call();
          const to = round2(r * cfg.limpReraise);
          const ok = okSize(to);
          if (ok) add("R", to, "reraise");
          if (jamOk || !ok) jam();
        } else {
          const c = st.callers.length;
          const canCall =
            c === 0 ? cfg.coldCall || s === BB : c + 2 <= cfg.maxFlop ? cfg.overcall : c + 2 === cfg.maxFlop + 1 && s === BB && cfg.overcall;
          if (canCall) call();
          const blinds = s === SB || s === BB;
          const mult = s === BB && st.opener === SB ? cfg.bbVsSb3 : blinds ? cfg.blind3 : cfg.ip3;
          const to = round2(r * mult + c * r * (blinds ? cfg.sqzPerCallerBlind : cfg.sqzPerCallerIP));
          const ok = okSize(to);
          if ((c === 0 || cfg.squeeze) && ok) add("R", to, c === 0 ? "3bet" : "squeeze");
          if (jamOk || !ok) jam();
        }
        break;
      }
      case 2: {
        // R5: facing a non-all-in 3-bet or squeeze.
        fold();
        if (s === st.opener || st.callers.includes(s)) {
          // Only one player calls a 3-bet: no 3-way 3-bet pots.
          if (!st.called3b) call();
          if (s === st.opener && st.callers.length === 0 && !st.limped) {
            const tb = st.threeBettor;
            // Real solvers size OOP 4-bets larger.
            const to4 = round2(st.bet[tb] * (rank(s) > rank(tb) ? cfg.fourIP : cfg.fourOOP));
            if (okSize(to4)) add("R", to4, "4bet");
          }
          jam();
        } else if (cfg.cold4 === "jam") jam();
        break;
      }
      case 3: {
        // R6: facing a non-all-in 4-bet; a 5-bet is always a jam.
        fold();
        if (s === st.threeBettor) {
          call();
          jam();
        }
        break;
      }
      default:
        throw new Error(`no rule for ${st.raises} raises without a jam`);
    }
    return moves;
  }

  /** The R1 answer order after seat s jams: still-live raisers (most recent first), then voluntary chips, then cold seats. */
  function priorityQueue(st: State, s: number, base: number[], prevRaises: number[]): number[] {
    const raisers: number[] = [];
    for (let k = prevRaises.length - 1; k >= 0; k--) {
      const o = prevRaises[k];
      if (o !== s && base.includes(o) && !raisers.includes(o)) raisers.push(o);
    }
    const rest = base.filter((o) => !raisers.includes(o));
    const voluntary = rest.filter((o) => st.bet[o] > blind(o) + EPS);
    const cold = rest.filter((o) => !(st.bet[o] > blind(o) + EPS));
    return [...raisers, ...voluntary, ...cold];
  }

  function apply(st: State, s: number, m: ActionInfo, forced: boolean): State {
    const x = cloneState(st);
    x.queue.shift();
    x.line.push({ seat: s, key: m.key, to: m.to, verb: m.verb, forced });
    switch (m.key) {
      case "F":
        if (st.allinCalled) {
          // PF-FROZEN: the closing call folds out a seat that already put voluntary chips in.
          if (st.bet[s] > blind(s) + EPS) x.frozen.push(s);
          if (st.raiseSeq.includes(s)) x.frozenRaisers.push(s);
        }
        x.folded[s] = true;
        break;
      case "X":
        break;
      case "L":
        x.bet[s] = m.to;
        x.limped = true;
        break;
      case "C":
        x.bet[s] = m.to;
        if (m.to >= live[s] - EPS) x.allin[s] = true;
        if (facingJamOf(st)) {
          x.allinCalled = true;
          x.closer = s;
        } else if (st.raises === 1) x.callers.push(s);
        else if (st.raises === 2) x.called3b = true;
        break;
      case "R":
      case "J": {
        x.bet[s] = m.to;
        x.maxBet = m.to;
        x.raises++;
        x.lastRaiser = s;
        if (x.raises === 1) x.opener = s;
        if (x.raises === 2) x.threeBettor = s;
        x.raiseSeq.push(s);
        // A jam is an effective all-in: it covers every other live seat even when s has chips left.
        if (m.key === "J" || m.to >= live[s] - EPS) {
          x.allin[s] = true;
          x.jammer = s;
          x.jamFirstIn = x.raises === 1;
        }
        // Everyone live and not all-in acts again, starting after s.
        const base: number[] = [];
        for (let k = 1; k < n; k++) {
          const o = (s + k) % n;
          if (!x.folded[o] && !x.allin[o]) base.push(o);
        }
        const reraisingJam = x.allin[s] && x.raises >= 2;
        x.queue = reraisingJam && cfg.mode === "full" && cfg.allinOrder === "priority" ? priorityQueue(x, s, base, st.raiseSeq) : base;
        break;
      }
    }
    return x;
  }

  function terminal(st: State, parent: number, parentAction: number, parentEdge: number): number {
    const t = terms.length;
    const active: number[] = [];
    for (let s = 0; s < n; s++) if (!st.folded[s]) active.push(s);
    const seats = active.slice().sort((a, b) => rank(a) - rank(b));
    const commit = st.bet.map((b, s) => b + (s === BB ? cfg.ante : 0));
    const pot = commit.reduce((a, b) => a + b, 0);
    let kind: TermKind;
    let allinPot = pot, refund = 0, refundSeat = -1, spr = 0, aggressor = -1;
    let potType: PotType | null = null;
    if (seats.length === 1) kind = "win";
    else if (st.allinCalled) {
      if (seats.length !== 2) throw new Error("an all-in terminal must be heads-up");
      kind = "allin";
      const [a, b] = seats;
      refund = Math.abs(st.bet[a] - st.bet[b]);
      if (refund > EPS) refundSeat = st.bet[a] > st.bet[b] ? a : b;
      else refund = 0;
      allinPot = pot - refund;
    } else {
      if (seats.some((s) => st.allin[s])) throw new Error("a flop terminal with an all-in seat");
      if (seats.length > cfg.maxFlop + 1) throw new Error("too many players at the flop");
      kind = "flop";
      potType = st.raises === 0 ? "limp" : POT_TYPES[st.raises];
      aggressor = st.raises === 0 ? -1 : st.lastRaiser;
      spr = Math.min(...seats.map((s) => live[s] - st.bet[s])) / pot;
    }
    terms.push({
      id: t,
      kind,
      parent,
      parentAction,
      line: st.line,
      seats,
      bet: st.bet,
      commit,
      pot,
      allinPot,
      refund,
      refundSeat,
      potType,
      aggressor,
      spr,
      raises: st.raises,
      limped: st.limped,
      opener: st.opener,
      threeBettor: st.threeBettor,
      callers: st.callers,
      raiseSeq: st.raiseSeq,
      jammer: st.jammer,
      closer: st.closer,
      frozen: st.frozen,
      frozenRaisers: st.frozenRaisers,
    });
    termEdge.push(parentEdge);
    return t;
  }

  /** Builds the subtree of st and returns its child code (a node index, or ~terminal). */
  function gen(stIn: State, parent: number, parentAction: number, parentEdge: number, depth: number): number {
    let st = stIn;
    for (;;) {
      while (st.queue.length && (st.folded[st.queue[0]] || st.allin[st.queue[0]])) st.queue.shift();
      const liveCount = st.folded.reduce((c, f) => c + (f ? 0 : 1), 0);
      if (liveCount === 1 || st.queue.length === 0) return ~terminal(st, parent, parentAction, parentEdge);
      const s = st.queue[0];
      const moves = legal(st, s);
      if (moves.length === 0) throw new Error(`no legal action for seat ${s}`);
      // R7: a single legal action is not a decision.
      if (moves.length === 1) {
        st = apply(st, s, moves[0], true);
        continue;
      }
      const id = nSeat.length;
      const e0 = eKey.length;
      maxDepth = Math.max(maxDepth, depth);
      nSeat.push(s);
      nActStart.push(e0);
      nFold.push(moves.findIndex((m) => m.key === "F"));
      nRaises.push(st.raises);
      nDepth.push(depth);
      nParent.push(parent);
      nParentEdge.push(parentEdge);
      for (const m of moves) {
        eKey.push(ACT[m.key]);
        eTo.push(m.to);
        eChild.push(0);
      }
      const facingJam = facingJamOf(st);
      let pot = cfg.ante;
      for (const b of st.bet) pot += b;
      nodes.push({
        id,
        seat: s,
        parent,
        parentAction,
        depth,
        actions: moves,
        line: st.line,
        bet: st.bet,
        active: st.folded.flatMap((f, o) => (f ? [] : [o])),
        maxBet: st.maxBet,
        pot,
        raises: st.raises,
        limped: st.limped,
        opener: st.opener,
        threeBettor: st.threeBettor,
        lastRaiser: st.lastRaiser,
        callers: st.callers,
        called3b: st.called3b,
        raiseSeq: st.raiseSeq,
        facingJam,
        jammer: facingJam ? st.jammer : -1,
        jamFirstIn: facingJam && st.jamFirstIn,
        heroActed: st.line.some((l) => l.seat === s),
      });
      for (let k = 0; k < moves.length; k++) eChild[e0 + k] = gen(apply(st, s, moves[k], false), id, k, e0 + k, depth + 1);
      return id;
    }
  }

  const st0: State = {
    bet: Array.from({ length: n }, (_, s) => blind(s)),
    folded: Array<boolean>(n).fill(false),
    allin: Array<boolean>(n).fill(false),
    maxBet: cfg.bb,
    raises: 0,
    limped: false,
    opener: -1,
    threeBettor: -1,
    lastRaiser: -1,
    raiseSeq: [],
    callers: [],
    called3b: false,
    allinCalled: false,
    jammer: -1,
    jamFirstIn: false,
    closer: -1,
    queue: Array.from({ length: n }, (_, s) => s),
    line: [],
    frozen: [],
    frozenRaisers: [],
  };
  const root = gen(st0, -1, -1, -1, 0);
  if (root !== 0) throw new Error("the root must be a decision node");

  const nodeCount = nSeat.length, edgeCount = eKey.length, termCount = terms.length;
  const actStart = new Int32Array(nodeCount + 1);
  actStart.set(nActStart);
  actStart[nodeCount] = edgeCount;

  const termKind = new Uint8Array(termCount);
  const termPot = new Float64Array(termCount);
  const termCommit = new Float64Array(termCount * n);
  const termNLive = new Uint8Array(termCount);
  const termSeats = new Int8Array(termCount * MAX_LIVE).fill(-1);
  const termPotType = new Uint8Array(termCount).fill(NO_POT);
  const termAggressor = new Int8Array(termCount).fill(-1);
  const termSpr = new Float64Array(termCount);
  const termAllinPot = new Float64Array(termCount);
  const termRefund = new Float64Array(termCount);
  const termRefundSeat = new Int8Array(termCount).fill(-1);
  const termFrozen = new Uint8Array(termCount);
  const termFrozenRaisers = new Uint8Array(termCount);
  for (const ti of terms) {
    const t = ti.id;
    termKind[t] = TERM_KINDS.indexOf(ti.kind);
    termPot[t] = ti.pot;
    termCommit.set(ti.commit, t * n);
    termNLive[t] = ti.seats.length;
    termSeats.set(ti.seats, t * MAX_LIVE);
    if (ti.potType) termPotType[t] = POT_TYPES.indexOf(ti.potType);
    termAggressor[t] = ti.aggressor;
    termSpr[t] = ti.spr;
    termAllinPot[t] = ti.allinPot;
    termRefund[t] = ti.refund;
    termRefundSeat[t] = ti.refundSeat;
    termFrozen[t] = ti.frozen.length;
    termFrozenRaisers[t] = ti.frozenRaisers.length;
  }

  return {
    cfg,
    n,
    sbSeat: SB,
    bbSeat: BB,
    nodeCount,
    edgeCount,
    termCount,
    maxDepth,
    seat: Uint8Array.from(nSeat),
    actStart,
    foldIdx: Int8Array.from(nFold),
    raisesAt: Uint8Array.from(nRaises),
    depth: Uint8Array.from(nDepth),
    parent: Int32Array.from(nParent),
    parentEdge: Int32Array.from(nParentEdge),
    actKey: Uint8Array.from(eKey),
    actTo: Float64Array.from(eTo),
    child: Int32Array.from(eChild),
    termKind,
    termParentEdge: Int32Array.from(termEdge),
    termPot,
    termCommit,
    termNLive,
    termSeats,
    termPotType,
    termAggressor,
    termSpr,
    termAllinPot,
    termRefund,
    termRefundSeat,
    termFrozen,
    termFrozenRaisers,
    nodes,
    terms,
  };
}

// ───────────── chip accounting (§3.1–3.3) ─────────────

/**
 * Net chips of every seat at terminal t, written to `out` (length n).
 * `shares[k]` belongs to the live seat termSeats[t*4 + k]: all-in equities at an ALLIN (they sum to
 * 1), pot shares at a FLOP; ignored at a WIN. Folded seats lose what they put in.
 */
export function terminalNets(tree: PreflopTree, t: number, shares: ArrayLike<number>, out: Float64Array = new Float64Array(tree.n)): Float64Array {
  const { n } = tree;
  for (let s = 0; s < n; s++) out[s] = -tree.termCommit[t * n + s];
  const k = tree.termNLive[t];
  const kind = tree.termKind[t];
  if (kind === TERM.WIN) {
    out[tree.termSeats[t * MAX_LIVE]] += tree.termPot[t];
    return out;
  }
  const P = kind === TERM.ALLIN ? tree.termAllinPot[t] : tree.termPot[t];
  for (let j = 0; j < k; j++) out[tree.termSeats[t * MAX_LIVE + j]] += shares[j] * P;
  if (kind === TERM.ALLIN && tree.termRefundSeat[t] >= 0) out[tree.termRefundSeat[t]] += tree.termRefund[t];
  return out;
}

// ───────────── display and counts ─────────────

/** "UTG:R2.2 HJ:C BB:J" style text of a line; folds are left out unless asked for. */
export function lineText(line: readonly LineStep[], players: number, withFolds = false): string {
  const names = seatNames(players);
  return line
    .filter((l) => withFolds || l.key !== "F")
    .map((l) => `${names[l.seat]}:${l.key}${l.key === "R" ? l.to : ""}`)
    .join(" ");
}

export interface TreeCounts {
  nodes: number;
  edges: number;
  terms: number;
  win: number;
  allin: number;
  flopHU: number;
  flop3: number;
  flop4: number;
  /** Terminals where the first call of a jam folded out a seat with voluntary chips, and a raiser. */
  frozen: number;
  frozenRaiser: number;
}

export function treeCounts(tree: PreflopTree): TreeCounts {
  const c: TreeCounts = { nodes: tree.nodeCount, edges: tree.edgeCount, terms: tree.termCount, win: 0, allin: 0, flopHU: 0, flop3: 0, flop4: 0, frozen: 0, frozenRaiser: 0 };
  for (let t = 0; t < tree.termCount; t++) {
    const k = tree.termKind[t];
    if (k === TERM.WIN) c.win++;
    else if (k === TERM.ALLIN) c.allin++;
    else if (tree.termNLive[t] === 2) c.flopHU++;
    else if (tree.termNLive[t] === 3) c.flop3++;
    else c.flop4++;
    if (tree.termFrozen[t] > 0) c.frozen++;
    if (tree.termFrozenRaisers[t] > 0) c.frozenRaiser++;
  }
  return c;
}
