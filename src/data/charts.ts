import { ALL_HANDS, comboCount, type HandClass } from "../poker/cards";
import { parseRange, type Range } from "../poker/range";
import { CASH6 } from "./sets/cash6";
import { NASH } from "./sets/nash";
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

export type ScenarioKind = "rfi" | "vsOpen" | "vs3bet" | "vsShove";

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

function buildSet(def: ChartSetDef): ChartSet {
  return {
    ...def,
    stages: def.stages.map((st) => ({ ...st, scenarios: st.scenarios.map((sc) => buildScenario(def, st, sc)) })),
  };
}

export const CHART_SETS: ChartSet[] = [PUB_TOURNEY, CASH6, NASH].map(buildSet);

export function getSet(id: string): ChartSet {
  return CHART_SETS.find((s) => s.id === id) ?? CHART_SETS[0];
}

export function allScenarios(set?: ChartSet): Scenario[] {
  return (set ? [set] : CHART_SETS).flatMap((s) => s.stages.flatMap((st) => st.scenarios));
}

/** Actions in display order: fold first, then the scenario's actions. */
export function scenarioActions(s: ScenarioDef): Omit<ActionDef, "range">[] {
  return [FOLD, ...s.actions];
}

export function describeStrategy(s: ScenarioDef, st: HandStrategy): string {
  return [...s.actions, FOLD].map((a) => `${a.label} ${Math.round((st[a.key] ?? 0) * 100)}%`).join(" / ");
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

export const KIND_LABEL: Record<ScenarioKind, string> = {
  rfi: "오픈 (RFI)",
  vsOpen: "vs 레이즈",
  vs3bet: "vs 레이즈",
  vsShove: "vs 올인",
};

/** Named villain ranges for the calculator, one per (scenario, action). */
export interface NamedRange {
  id: string;
  group: string;
  label: string;
  range: Range;
}

export const NAMED_RANGES: NamedRange[] = CHART_SETS.flatMap((set) =>
  set.stages.flatMap((stage) =>
    stage.scenarios.flatMap((s) =>
      s.actions.map((a) => ({
        id: `${s.id}:${a.key}`,
        group: `${set.label} · ${stage.label}`,
        label: `${s.title} — ${a.label}`,
        // Effective frequencies (an earlier action can take hands out of this one).
        range: Object.fromEntries(ALL_HANDS.map((h) => [h, s.strategy[h][a.key] ?? 0])),
      })),
    ),
  ),
);
