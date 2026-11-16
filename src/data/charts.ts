import { ALL_HANDS, comboCount, type HandClass } from "../poker/cards";
import { parseRange, type Range } from "../poker/range";
import { CASH6 } from "./sets/cash6";
import { NASH } from "./sets/nash";
import { SOLVER } from "./sets/preflop";
import { SHORT_NASH } from "./sets/shortNash";
import { PUB_TOURNEY } from "./sets/pub";

/**
 * 차트 세트 → 스택 구간(stage) → 시나리오.
 *
 * 레인지 문법: "66+, 55:0.5, A2s+, KTo+, AJs-A6s, QJo:0.4"
 *   - 77+ : 77~AA,   A2s+ : A2s~AKs,   22-66 / AJs-A6s : 범위
 *   - :0.5 : 50% 빈도(혼합 전략). 뒤에 쓴 토큰이 앞의 값을 덮어쓴다.
 * 한 시나리오의 액션은 위에서부터 차례로 채운다. 앞 액션이 100%인 핸드는
 * 뒤 액션 범위에 있어도 0%가 된다 (예: "작게 열기 TT+" 다음 "올인 77+").
 */

export type ActionColor = "open" | "raise" | "allin" | "call";

export interface ActionDef {
  key: string;
  label: string;
  color: ActionColor;
  range: string;
}

/**
 * vs4bet, squeeze and vsLimp only occur in the solver set (src/data/sets/preflop.ts). Hand play looks scenarios up
 * by the other kinds only (src/play/policy.ts), so the new ones never reach it.
 */
export type ScenarioKind = "rfi" | "vsOpen" | "vs3bet" | "vsShove" | "vs4bet" | "squeeze" | "vsLimp";

export interface ScenarioDef {
  id: string;
  kind: ScenarioKind;
  /** 내 자리. 좌석이 아닌 설명("뒤 자리" 등)이어도 된다. */
  hero: string;
  /** 이 상황이 함께 적용되는 자리들 (예: LJ·HJ) */
  heroSeats?: string[];
  /** 먼저 액션한 사람 (좌석 하나 또는 "UTG~MP" 같은 묶음) */
  villain?: string;
  /** 좌석 그림에서 상대로 표시할 자리들 */
  villainSeats?: string[];
  /** 칩 버튼에 쓸 짧은 이름 */
  chip: string;
  title: string;
  description: string;
  actions: ActionDef[];
  /**
   * The hero's own reach here: the product of the hero's earlier chart frequencies on this line (the solver set
   * builds it from its data's reachFrom). Set only for spots deep in a line, where most hands never arrive: hands
   * with reach 0 are dimmed on the grid and never dealt in the quiz, and reachTotals weights hands by it. Without
   * it every hand reaches the spot, as in the hand-made sets.
   */
  reachRange?: Range;
  /** The hero cannot fold here (the BB facing an SB limp checks instead): no 폴드 button, and no fold in texts. */
  noFold?: boolean;
  /** Quiz pick weight against the other scenarios of the pool; default 1. */
  weight?: number;
}

export interface StageDef {
  id: string;
  label: string;
  /** 예: "100bb 이상" */
  stack: string;
  description: string;
  scenarios: ScenarioDef[];
}

export interface ChartSetDef {
  id: string;
  label: string;
  /** AI 코치에게 넘길 게임 설명 */
  game: string;
  /** 차트 출처와 한계 */
  source: string;
  positions: string[];
  stages: StageDef[];
  /**
   * Charts page: a kind group with more than HERO_FILTER_ABOVE scenarios gets a row of hero seats above its chips
   * (heroFilterSeats). Opt-in: the Nash sets' 36-chip groups have always been one scrolling row of chips, and
   * the existing sets keep their pages as they were.
   */
  heroFilter?: boolean;
}

/** action key → 빈도, 그리고 "fold" */
export type HandStrategy = Record<string, number>;

export const FOLD: Omit<ActionDef, "range"> = { key: "fold", label: "폴드", color: "call" };

export interface Scenario extends ScenarioDef {
  setId: string;
  stageId: string;
  stageLabel: string;
  stack: string;
  strategy: Record<HandClass, HandStrategy>;
  ranges: Record<string, Range>;
}

export interface Stage extends Omit<StageDef, "scenarios"> {
  scenarios: Scenario[];
}

export interface ChartSet extends Omit<ChartSetDef, "stages"> {
  stages: Stage[];
}

function buildScenario(set: ChartSetDef, stage: StageDef, def: ScenarioDef): Scenario {
  // ...def below carries reachRange, noFold and weight to the Scenario unchanged.
  const ranges: Record<string, Range> = {};
  for (const a of def.actions) ranges[a.key] = parseRange(a.range);
  const strategy: Record<HandClass, HandStrategy> = {};
  for (const h of ALL_HANDS) {
    const st: HandStrategy = {};
    let left = 1;
    for (const a of def.actions) {
      const f = Math.min(ranges[a.key][h] ?? 0, left);
      st[a.key] = f;
      left -= f;
    }
    st.fold = Math.max(0, left);
    strategy[h] = st;
  }
  return {
    ...def,
    id: `${set.id}/${stage.id}/${def.id}`,
    setId: set.id,
    stageId: stage.id,
    stageLabel: stage.label,
    stack: stage.stack,
    strategy,
    ranges,
  };
}

/** Exported for tests, which build synthetic sets; the app only reads CHART_SETS. */
export function buildSet(def: ChartSetDef): ChartSet {
  return {
    ...def,
    stages: def.stages.map((st) => ({ ...st, scenarios: st.scenarios.map((sc) => buildScenario(def, st, sc)) })),
  };
}

// SOLVER goes last: getSet's fallback (CHART_SETS[0]) and the default chart set "pub" stay as they are.
export const CHART_SETS: ChartSet[] = [PUB_TOURNEY, CASH6, NASH, SHORT_NASH, SOLVER].map(buildSet);

export function getSet(id: string): ChartSet {
  return CHART_SETS.find((s) => s.id === id) ?? CHART_SETS[0];
}

export function allScenarios(set?: ChartSet): Scenario[] {
  return (set ? [set] : CHART_SETS).flatMap((s) => s.stages.flatMap((st) => st.scenarios));
}

/** Actions in button order: fold first, then the scenario's actions. No fold where the hero cannot fold. */
export function scenarioActions(s: ScenarioDef): Omit<ActionDef, "range">[] {
  return s.noFold ? [...s.actions] : [FOLD, ...s.actions];
}

/** Actions in legend order: the scenario's actions, then fold (left out where the hero cannot fold). */
export function legendActions(s: ScenarioDef): Omit<ActionDef, "range">[] {
  return s.noFold ? [...s.actions] : [...s.actions, FOLD];
}

export function describeStrategy(s: ScenarioDef, st: HandStrategy): string {
  return legendActions(s).map((a) => `${a.label} ${Math.round((st[a.key] ?? 0) * 100)}%`).join(" / ");
}

/** The hero's reach with hand h (0..1); 1 when the scenario has no reachRange. */
export function reachOf(s: ScenarioDef, h: HandClass): number {
  return s.reachRange ? Math.max(0, s.reachRange[h] ?? 0) : 1;
}

/** Whether the hero can hold h here. Out-of-reach hands are dimmed on the grid and never dealt in the quiz. */
export function inReach(s: ScenarioDef, h: HandClass): boolean {
  return reachOf(s, h) > 0;
}

/**
 * Share of all 1326 combos that get here (Σ combos·reach / 1326): the "도달 레인지" of the charts page. Computed
 * from reachRange rather than stored, so it always describes exactly the cells the grid leaves undimmed.
 */
export function reachShare(s: ScenarioDef): number {
  let w = 0;
  for (const h of ALL_HANDS) w += comboCount(h) * reachOf(s, h);
  return w / 1326;
}

/** Share of all 1326 combos that take each action. */
export function actionTotals(s: Scenario): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of [...s.actions, FOLD]) out[a.key] = 0;
  for (const h of ALL_HANDS) {
    const n = comboCount(h);
    for (const k of Object.keys(out)) out[k] += (s.strategy[h][k] ?? 0) * n;
  }
  for (const k of Object.keys(out)) out[k] /= 1326;
  return out;
}

/**
 * Share of the combos that get here taking each action, fold included: Σ combos·reach·f / Σ combos·reach. Deep in
 * a line this is the meaningful total (a vs-3-bet chart as a share of all hands would read "폴드 9x%", most of it
 * hands that never opened). Equal to actionTotals when the scenario has no reachRange; all 0 if nothing reaches.
 */
export function reachTotals(s: Scenario): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of [...s.actions, FOLD]) out[a.key] = 0;
  let mass = 0;
  for (const h of ALL_HANDS) {
    const w = comboCount(h) * reachOf(s, h);
    if (!(w > 0)) continue;
    mass += w;
    for (const k of Object.keys(out)) out[k] += (s.strategy[h][k] ?? 0) * w;
  }
  if (mass > 0) for (const k of Object.keys(out)) out[k] /= mass;
  return out;
}

export const KIND_LABEL: Record<ScenarioKind, string> = {
  rfi: "오픈 (RFI)",
  vsOpen: "vs 오픈",
  vs3bet: "vs 3벳",
  vsShove: "vs 올인",
  vs4bet: "vs 4벳",
  squeeze: "스퀴즈·오버콜",
  vsLimp: "림프 팟",
};

/** The charts page's hero-seat filter appears for groups with more scenarios than this (and heroFilter on). */
export const HERO_FILTER_ABOVE = 12;

/**
 * The seats that occur as hero in `list`: those in `positions` in table order (UTG … BB), then any other hero in
 * order of first appearance.
 */
export function heroSeats(list: ScenarioDef[], positions: string[]): string[] {
  const heroes = new Set(list.map((s) => s.hero));
  return [...positions.filter((p) => heroes.has(p)), ...[...heroes].filter((h) => !positions.includes(h))];
}

/**
 * The seats the charts page offers above a kind group's chips, or [] when the group shows all its chips: the set
 * has not opted in, the group is small enough to scan, or only one seat occurs (nothing to filter).
 */
export function heroFilterSeats(set: Pick<ChartSetDef, "heroFilter" | "positions">, list: ScenarioDef[]): string[] {
  if (!set.heroFilter || list.length <= HERO_FILTER_ABOVE) return [];
  const seats = heroSeats(list, set.positions);
  return seats.length > 1 ? seats : [];
}

/** Named villain ranges for the calculator, one per (scenario, action). */
export interface NamedRange {
  id: string;
  group: string;
  label: string;
  range: Range;
}

/**
 * The solver set lists only these kinds in the calculator: its squeeze, 4-bet and limp-pot lines run to hundreds of
 * ranges per stage and would bury the list.
 */
const SOLVER_NAMED_KINDS: ScenarioKind[] = ["rfi", "vsOpen", "vs3bet"];

export function namedRanges(sets: ChartSet[]): NamedRange[] {
  return sets.flatMap((set) =>
    set.stages.flatMap((stage) =>
      stage.scenarios
        .filter((s) => set.id !== "solver" || SOLVER_NAMED_KINDS.includes(s.kind))
        .flatMap((s) =>
          s.actions.map((a) => ({
            id: `${s.id}:${a.key}`,
            group: `${set.label} · ${stage.label}`,
            label: `${s.title} — ${a.label}`,
            // Effective frequencies (an earlier action can take hands out of this one), times the hero's reach
            // where the spot is deep in a line: a villain who 4-bets holds ρ·f of each hand, not f.
            range: Object.fromEntries(ALL_HANDS.map((h) => [h, (s.strategy[h][a.key] ?? 0) * reachOf(s, h)])),
          })),
        ),
    ),
  );
}

export const NAMED_RANGES: NamedRange[] = namedRanges(CHART_SETS);
