import { ALL_HANDS } from "../poker/cards";
import type { Scenario } from "../data/charts";
import { RAISE_KEYS } from "../data/sets/preflop";
import { groupOf, type Group } from "./chartGrade";
import type { MoveOption, PreflopDecision } from "./policy";

/**
 * One preflop decision of a seat on the AI table as the chart reads it (always the GTO chart, never the seat's profile):
 * what the solver pack registry matches a flop's two lines against (packMatch.ts). `ref` is the chart ref of the group
 * the seat took, in the manifest's rangeSources format ("solver/55bb-2.2/rfi-btn:open", "cash6/100bb/rfi-btn:raise");
 * null where no chart answered (the fallback rules) or the chart has no such action. `freq` is the chart's frequency of
 * that group per class (ALL_HANDS order): a seat's nominal range at the flop is the product over its steps.
 */
export interface SeatLineStep {
  ref: string | null;
  /** The chart action keys of the group taken ("open", "call"), or ["fold"]. */
  keys: string[];
  freq: Float64Array;
}

/** What a chart key is, as a group (its raise size against the stack). */
export function keyGroup(sc: Scenario, key: string, allInTo: number): Group {
  if (key === "fold") return "fold";
  const a = sc.actions.find((x) => x.key === key);
  if (!a) return "fold";
  if (key === "shove" || a.label.includes("올인")) return "allin";
  if (!RAISE_KEYS.has(key) && key !== "raise") return "call";
  const size = Number(/([\d.]+)bb/.exec(a.label)?.[1] ?? NaN);
  return Number.isFinite(size) && size < allInTo - 1e-9 ? "raise" : "allin";
}

/**
 * The line step of taking `move` at a decision whose GTO chart is `dec` (its scenario when a chart answered).
 * `allInTo`: the seat's whole stack as a street total.
 */
export function lineStepOf(dec: PreflopDecision, scenario: Scenario | undefined, move: Pick<MoveOption, "kind" | "to">, allInTo: number): SeatLineStep {
  const g = groupOf(move, allInTo);
  const freq = new Float64Array(ALL_HANDS.length);
  ALL_HANDS.forEach((h, i) => {
    for (const m of dec.moves(h)) if (groupOf(m, allInTo) === g) freq[i] += m.prob;
  });
  if (g === "fold") return { ref: scenario ? `${scenario.id}:fold` : null, keys: ["fold"], freq };
  if (!scenario) return { ref: null, keys: [], freq };
  const keys = scenario.actions.map((a) => a.key).filter((k) => keyGroup(scenario, k, allInTo) === g);
  return { ref: keys.length ? `${scenario.id}:${keys.join("+")}` : null, keys, freq };
}
