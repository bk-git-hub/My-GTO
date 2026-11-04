import { randomCombo, type Card, type HandClass } from "../../poker/cards";
import { getSet, type HandStrategy, type Scenario } from "../../data/charts";
import { gradePreflop, weightedHand, type Grade } from "./generators";

/** 펍 토너먼트 블라인드 구조 (레벨, SB, BB). BB 앤티 = BB. */
export const BLIND_LEVELS: [number, number, number][] = [
  [1, 100, 200], [2, 200, 300], [3, 200, 400], [4, 300, 500], [5, 300, 600], [6, 400, 800],
  [7, 500, 1000], [8, 600, 1200], [9, 800, 1600], [10, 1000, 2000], [11, 1500, 2500], [12, 2000, 3000],
  [13, 2000, 4000], [14, 2500, 5000], [15, 3000, 6000], [16, 4000, 8000], [17, 5000, 10000],
  [18, 6000, 12000], [19, 8000, 16000], [20, 10000, 20000], [21, 15000, 30000], [22, 20000, 40000],
  [23, 25000, 50000], [24, 30000, 60000], [25, 40000, 80000],
];

/** My stack range (bb) and the levels where that stack is common, per chart stage. */
const STAGE_SPOTS: Record<string, { bb: [number, number]; levels: [number, number] }> = {
  deep: { bb: [100, 250], levels: [1, 4] },
  mid: { bb: [40, 80], levels: [4, 12] },
  short: { bb: [14, 22], levels: [8, 20] },
  push: { bb: [5, 12], levels: [10, 25] },
};

/** Rough average stack growth by level (busts vs. re-entries), times the 50,000 start. */
function avgGrowth(level: number): number {
  if (level <= 3) return 1;
  if (level <= 6) return 1.3;
  if (level <= 10) return 1.8;
  if (level <= 14) return 2.6;
  if (level <= 17) return 4;
  if (level <= 20) return 6;
  return 9;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const roundTo = (x: number, step: number) => Math.max(step, Math.round(x / step) * step);

export const QUIZ_ACTIONS = [
  { key: "fold", label: "폴드" },
  { key: "open", label: "오픈" },
  { key: "shove", label: "올인" },
] as const;
export type QuizAction = (typeof QUIZ_ACTIONS)[number]["key"];

/** Collapse a chart's actions to fold / open (any raise size) / shove. */
export function collapse(st: HandStrategy): Record<QuizAction, number> {
  return {
    fold: st.fold ?? 0,
    open: (st.open ?? 0) + (st.small ?? 0),
    shove: st.shove ?? 0,
  };
}

export interface StackQuestion {
  uid: string;
  scenario: Scenario;
  stageId: string;
  hand: HandClass;
  cards: [Card, Card];
  level: number;
  sb: number;
  bb: number;
  myChips: number;
  avgChips: number;
}

export function generateStackQuestion(stageFilter: string, seatFilter: string): StackQuestion {
  const set = getSet("pub");
  const stages = set.stages.filter((s) => stageFilter === "all" || s.id === stageFilter);
  const stage = stages[Math.floor(Math.random() * stages.length)];
  const rfis = stage.scenarios.filter((s) => s.kind === "rfi" && (seatFilter === "all" || s.hero === seatFilter));
  const scenario = rfis[Math.floor(Math.random() * rfis.length)] ?? stage.scenarios.find((s) => s.kind === "rfi")!;

  const spot = STAGE_SPOTS[stage.id];
  const candidates = BLIND_LEVELS.filter(([lv]) => lv >= spot.levels[0] && lv <= spot.levels[1]);
  const [level, sb, bb] = candidates[Math.floor(Math.random() * candidates.length)];
  const myChips = roundTo(rand(spot.bb[0], spot.bb[1]) * bb, 100);
  const avgChips = roundTo(50000 * avgGrowth(level) * rand(0.85, 1.15), 1000);
  const hand = weightedHand(scenario);
  return {
    uid: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scenario,
    stageId: stage.id,
    hand,
    cards: randomCombo(hand),
    level,
    sb,
    bb,
    myChips,
    avgChips,
  };
}

export function gradeStack(q: StackQuestion, action: QuizAction): { grade: Grade; freqs: Record<QuizAction, number> } {
  const freqs = collapse(q.scenario.strategy[q.hand]);
  const best = Math.max(freqs.fold, freqs.open, freqs.shove);
  return { grade: gradePreflop(freqs[action], best), freqs };
}
