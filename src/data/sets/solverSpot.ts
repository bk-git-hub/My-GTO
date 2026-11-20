import { buildScenario, type Scenario } from "../charts";
import { SOLVER_ID, solverScenarioDef, spotReach } from "./preflop";
import { PREFLOP_STAGES } from "./preflopData";
import type { PreflopStage } from "./preflopTypes";

/**
 * One solver spot at a time, straight from the generated data (the way judgeChart.ts reads the few spots it needs):
 * a hand review, a bot or the coach facts look up the spot of one decision, so the full solver set (charts.ts
 * getSet("solver"), 633 spots, about 120 ms and 15 MB) is never built for them. Each spot is parsed on first use and
 * kept. The result is the same Scenario the full set holds (id "solver/<stage>/<spot>", strategy, ranges, reachRange,
 * close, flags, quizSkip, confidence), so the set's helpers (describeStrategy, reachOf, quizCloseActions,
 * cautionFacts…) work on it unchanged; src/play/computedChart.test.ts checks the two are equal.
 */

export interface SolverStageMeta {
  id: string;
  /** "100bb · 오픈 2.2bb". */
  label: string;
  /** Everyone's starting stack, bb. */
  stack: number;
  /** First-in open size (UTG–BTN) and the SB's, bb. */
  open: number;
  sbRaise: number;
  closeEps?: number;
}

function stageOf(id: string): PreflopStage | undefined {
  return PREFLOP_STAGES.find((s) => s.id === id);
}

/** A solver stage's ids and sizes; throws for a stage the data does not have. */
export function solverStageMeta(id: string): SolverStageMeta {
  const st = stageOf(id);
  if (!st) throw new Error(`no solver stage ${id}`);
  return { id: st.id, label: st.label, stack: st.stack, open: st.open, sbRaise: st.sizes.sbRaise, ...(st.closeEps !== undefined ? { closeEps: st.closeEps } : {}) };
}

/** Whether the data has this stage (the 35bb stage is optional in the generator). */
export const hasSolverStage = (id: string): boolean => stageOf(id) !== undefined;

export interface SolverSpotHit {
  scenario: Scenario;
  /** The data's public line with sizes ("CO 2.2 · BTN 3벳 6.6"; "" first in). */
  line: string;
  /** % of dealt hands in which the spot comes up. */
  occ: number;
  confidence: "high" | "mid" | "low";
  /** pp the chart moved in the sensitivity solves. */
  move: number;
}

const cache = new Map<string, SolverSpotHit | null>();

/** The solver's spot `spotId` of stage `stageId` as a full Scenario, or null when the data has no such spot. */
export function solverSpot(stageId: string, spotId: string): SolverSpotHit | null {
  const key = `${stageId}/${spotId}`;
  const had = cache.get(key);
  if (had !== undefined) return had;
  const st = stageOf(stageId);
  const sc = st?.scenarios.find((s) => s.id === spotId);
  let hit: SolverSpotHit | null = null;
  if (st && sc) {
    const def = solverScenarioDef(sc, spotReach(st, sc), st.stack);
    // The ids and labels the full set gives its scenarios (preflop.ts stage()).
    const scenario = buildScenario({ id: SOLVER_ID }, { id: st.id, label: st.label, stack: `모두 ${st.stack}bb` }, def);
    hit = { scenario, line: sc.line, occ: sc.occ, confidence: sc.confidence, move: sc.move };
  }
  cache.set(key, hit);
  return hit;
}
