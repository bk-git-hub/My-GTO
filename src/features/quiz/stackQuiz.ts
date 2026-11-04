import { randomCombo, type Card, type HandClass } from "../../poker/cards";
import { getSet, type HandStrategy, type Scenario, type Stage } from "../../data/charts";
import { openSize } from "../../play/policy";
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
  { key: "call", label: "콜" },
  { key: "3bet", label: "3벳" },
  { key: "shove", label: "올인" },
] as const;
export type QuizAction = (typeof QUIZ_ACTIONS)[number]["key"];

/** Which spots the drill asks: first in (RFI), facing an open from an earlier seat, or both. */
export type DrillSpot = "rfi" | "vs" | "mix";

/** The quiz button a chart action counts as. First in: open (any size) or shove. Facing an open: call, 3-bet or 3-bet all-in. */
function bucketOf(sc: Scenario, color: string): QuizAction {
  if (sc.kind === "rfi") return color === "allin" ? "shove" : "open";
  return color === "call" ? "call" : color === "allin" ? "shove" : "3bet";
}

/** Collapse a chart's actions to the quiz buttons. */
export function collapse(sc: Scenario, st: HandStrategy): Record<QuizAction, number> {
  const out: Record<QuizAction, number> = { fold: st.fold ?? 0, open: 0, call: 0, "3bet": 0, shove: 0 };
  for (const a of sc.actions) out[bucketOf(sc, a.color)] += st[a.key] ?? 0;
  return out;
}

/** pub: 펍아재 토너먼트 (스택별 차트) · cash: 6맥스 캐시 100bb · nash: 계산된 푸시/폴드 내쉬 */
export type DrillMode = "pub" | "cash" | "nash";

/** Chart set each drill mode asks from. */
export const DRILL_SET: Record<DrillMode, string> = { pub: "pub", cash: "cash6", nash: "nash" };

/** Stat key prefix per mode (pub keeps the original keys). */
export const statPrefix = (mode: DrillMode) => (mode === "pub" ? "stack" : `stack-${mode}`);

export interface StackQuestion {
  uid: string;
  mode: DrillMode;
  scenario: Scenario;
  /** My seat (a chart can cover several seats). */
  hero: string;
  /** Facing an open: who opened and to how much (bb). */
  opener?: string;
  openTo?: number;
  stageId: string;
  hand: HandClass;
  cards: [Card, Card];
  level: number;
  sb: number;
  bb: number;
  myChips: number;
  avgChips: number;
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** The vs-open chart for me in `hero` facing an open from `opener`: same lookup order as the play bots. */
export function vsOpenChart(stage: Stage, hero: string, opener: string): Scenario | undefined {
  const vs = stage.scenarios.filter((s) => s.kind === "vsOpen");
  const mine = (s: Scenario) => (s.heroSeats ?? [s.hero]).includes(hero);
  const fits = (s: Scenario) => (s.villainSeats ?? (s.villain ? [s.villain] : [])).includes(opener);
  return vs.find((s) => mine(s) && fits(s)) ?? vs.find((s) => s.hero === "Hero" && fits(s));
}

/** Nash set: the calling chart for `hero` facing an all-in from `shover`. */
export function vsShoveChart(stage: Stage, hero: string, shover: string): Scenario | undefined {
  return stage.scenarios.find((s) => s.kind === "vsShove" && s.hero === hero && s.villain === shover);
}

type Lookup = (stage: Stage, hero: string, opener: string) => Scenario | undefined;
/** In the Nash set the player in front shoves; in the others, they open. */
const lookupFor = (mode: DrillMode): Lookup => (mode === "nash" ? vsShoveChart : vsOpenChart);

/** Every charted (my seat, opener) pair in a stage, optionally for one of my seats. */
export function vsOpenSpots(
  stage: Stage,
  positions: string[],
  seatFilter: string,
  lookup: Lookup = vsOpenChart,
): { hero: string; opener: string; scenario: Scenario }[] {
  const out: { hero: string; opener: string; scenario: Scenario }[] = [];
  positions.forEach((hero, h) => {
    if (seatFilter !== "all" && hero !== seatFilter) return;
    for (const opener of positions.slice(0, h)) {
      if (opener === "BB") continue;
      const scenario = lookup(stage, hero, opener);
      if (scenario) out.push({ hero, opener, scenario });
    }
  });
  return out;
}

/** Seats the drill can ask about for a spot type. */
export function drillSeats(mode: DrillMode, spot: DrillSpot): string[] {
  const set = getSet(DRILL_SET[mode]);
  const rfi = set.positions.filter((p) => p !== "BB");
  if (spot === "rfi") return rfi;
  const vs = set.positions.filter((p) => set.stages.some((st) => vsOpenSpots(st, set.positions, p, lookupFor(mode)).length > 0));
  return spot === "vs" ? vs : set.positions.filter((p) => rfi.includes(p) || vs.includes(p));
}

function firstIn(stage: Stage, seatFilter: string): { scenario: Scenario; hero: string; opener?: string; openTo?: number } {
  const rfis = stage.scenarios.filter((s) => s.kind === "rfi" && (seatFilter === "all" || s.hero === seatFilter));
  const scenario = rfis.length ? pick(rfis) : stage.scenarios.find((s) => s.kind === "rfi")!;
  return { scenario, hero: scenario.hero };
}

/** Stack depth (bb) of a Nash stage ("10bb" → 10). */
const nashStack = (stage: Stage) => parseFloat(stage.id);

/** A spot facing an open (or, in the Nash set, an all-in) in this stage, or null if none fits the seat filter. */
function facing(mode: DrillMode, stage: Stage, positions: string[], seatFilter: string) {
  const spots = vsOpenSpots(stage, positions, seatFilter, lookupFor(mode));
  if (!spots.length) return null;
  const s = pick(spots);
  return { ...s, openTo: mode === "nash" ? nashStack(stage) : openSize(mode, stage.id, s.opener) };
}

export function generateStackQuestion(stageFilter: string, seatFilter: string, mode: DrillMode = "pub", spot: DrillSpot = "rfi"): StackQuestion {
  const set = getSet(DRILL_SET[mode]);
  const filtered = set.stages.filter((s) => stageFilter === "all" || s.id === stageFilter);
  const stages = filtered.length ? filtered : set.stages;
  // BB never opens and UTG never faces an open: steer the spot type to one that exists for the seat.
  const canVs = stages.filter((st) => vsOpenSpots(st, set.positions, seatFilter, lookupFor(mode)).length > 0);
  const canRfi = seatFilter !== "BB";
  const wantVs = !canRfi || (canVs.length > 0 && (spot === "vs" || (spot === "mix" && Math.random() < 0.5)));
  const stage = pick(wantVs && canVs.length ? canVs : stages);
  const vs = wantVs ? facing(mode, stage, set.positions, seatFilter) : null;
  const { scenario, hero, opener, openTo } = vs ?? firstIn(stage, seatFilter);
  const hand = weightedHand(scenario);
  const base = { uid: uid(), mode, scenario, hero, opener, openTo, stageId: stage.id, hand, cards: randomCombo(hand) };
  if (mode === "cash") return { ...base, level: 0, sb: 0.5, bb: 1, myChips: 100, avgChips: 100 };
  // Nash charts assume everyone on the same stack, in bb.
  if (mode === "nash") return { ...base, level: 0, sb: 0.5, bb: 1, myChips: nashStack(stage), avgChips: nashStack(stage) };

  const range = STAGE_SPOTS[stage.id];
  const candidates = BLIND_LEVELS.filter(([lv]) => lv >= range.levels[0] && lv <= range.levels[1]);
  const [level, sb, bb] = candidates[Math.floor(Math.random() * candidates.length)];
  const myChips = roundTo(rand(range.bb[0], range.bb[1]) * bb, 100);
  const avgChips = roundTo(50000 * avgGrowth(level) * rand(0.85, 1.15), 1000);
  return {
    ...base,
    level,
    sb,
    bb,
    myChips,
    avgChips,
  };
}

/** The buttons a question offers, in display order. */
export function questionActions(q: StackQuestion): QuizAction[] {
  if (q.scenario.kind === "rfi") return q.mode === "cash" ? ["fold", "open"] : q.mode === "nash" ? ["fold", "shove"] : ["fold", "open", "shove"];
  const present = new Set(q.scenario.actions.map((a) => bucketOf(q.scenario, a.color)));
  return ["fold", ...(["call", "3bet", "shove"] as const).filter((a) => present.has(a))];
}

/** Stat keys an answer counts toward. First-in keys keep their original shape. */
export function statKeys(q: StackQuestion): string[] {
  const p = statPrefix(q.mode);
  if (!q.opener) return [p, `${p}:${q.stageId}`, `${p}:${q.stageId}:${q.hero}`, `${p}:seat:${q.hero}`];
  return [p, `${p}:vs`, `${p}:vs:${q.stageId}`, `${p}:vs:${q.stageId}:${q.hero}`, `${p}:vs:seat:${q.hero}`];
}

export function gradeStack(q: StackQuestion, action: QuizAction): { grade: Grade; freqs: Record<QuizAction, number> } {
  const freqs = collapse(q.scenario, q.scenario.strategy[q.hand]);
  const best = Math.max(...Object.values(freqs));
  return { grade: gradePreflop(freqs[action], best), freqs };
}
