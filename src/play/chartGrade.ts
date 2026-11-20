import { closeFact } from "../components/FreqBar";
import { describeStrategy, legendActions, reachOf } from "../data/charts";
import { bigPairCloseNote, cautionFacts, quizCloseActions, RAISE_KEYS } from "../data/sets/preflop";
import { gradePreflop, MIXED_MIN, SOLVER_MIXED_MIN } from "../features/quiz/generators";
import type { HandClass } from "../poker/cards";
import { CONFIDENCE_KO, type ChartHit } from "./computedChart";
import type { MoveOption } from "./policy";

/**
 * Grading one preflop decision against its computed chart (computedChart.ts), the way the chart quiz grades an answer
 * (generators.ts gradePreflop): the chart's frequency of what I did, by group (fold / call / raise / all-in, as
 * 빠른 기록's verdict groups them); a close-call action (EV within the stage's ε) counts as good, a mix of 5% or more
 * (the solver's; 20% for the short-stack and push/fold charts, as in the quiz) as ok. A ✗ softens to △ only for a
 * flagged model-artifact cell, a low-confidence chart one step from my action (or the all-in, on its tree, of a premium
 * it limps), or a raise size far from the chart's in the direction that excuses me. Facing an all-in, a raise over it
 * is a call of it, and a ✓ or ✗ the hand's own call numbers (shown next to it) contradict, by more than EV_GAP bb or
 * by EQ_GAP equity points, is only △. No grade (참고) where the chart can't judge: a limp or flat the short-stack and
 * push/fold models leave out (unless the chart folds the hand outright), or a limp or open of a premium a
 * low-confidence solver line limps (a fold and an all-in stay graded). fastVerdict.ts shares the groups and the size
 * rule.
 */

export type Group = "fold" | "call" | "raise" | "allin";
/** How much each group puts in: a shove is more than the chart's raise (a 100bb open-jam over a 3bb open). */
export const LEVEL: Record<Group, number> = { fold: 0, call: 1, raise: 2, allin: 3 };
/** A chart raise to this share of the stack or more commits it: a shove instead is only a size (a deep 4-bet to ~21 of 100bb). */
export const COMMIT = 0.2;
export const GROUPS: Group[] = ["allin", "raise", "call", "fold"];

/** A chart move's group: a raise to the whole stack is all-in. */
export const groupOf = (m: Pick<MoveOption, "kind" | "to">, allInTo: number): Group =>
  m.kind === "fold" ? "fold" : m.kind === "call" || m.kind === "check" ? "call" : (m.to ?? 0) >= allInTo - 1e-9 ? "allin" : "raise";

/** How often the chart takes each group. */
export function groupFreqs(moves: MoveOption[], allInTo: number): Record<Group, number> {
  const out: Record<Group, number> = { fold: 0, call: 0, raise: 0, allin: 0 };
  for (const m of moves) out[groupOf(m, allInTo)] += m.prob;
  return out;
}

/** What a chart key is, as a group (its raise size against the stack). */
function keyGroup(hit: ChartHit, key: string, allInTo: number): Group {
  if (key === "fold") return "fold";
  const a = hit.scenario.actions.find((x) => x.key === key);
  if (!a) return "fold";
  if (key === "shove" || a.label.includes("올인")) return "allin";
  if (!RAISE_KEYS.has(key)) return "call";
  const size = Number(/([\d.]+)bb/.exec(a.label)?.[1] ?? NaN);
  return Number.isFinite(size) && size < allInTo - 1e-9 ? "raise" : "allin";
}

export interface ChartGrade {
  grade: "good" | "ok" | "mistake" | "info";
  /** The chart's frequency of my action (of its size-equivalent where the size rule applied). */
  freq: number;
  /** The close-call actions of the cell (labels), when it has them. */
  close?: string[];
  /** Why a ✗ became △, or why there is no grade. */
  soft?: string;
  /** My action is not one this chart offers ("이 차트엔 없는 선택"). */
  offTree?: boolean;
  /** My raise was graded as the chart's raise of another size: "올인", "3벳 6.6bb". */
  size?: string;
  /** The chart's main action group. */
  main: Group;
  /** My action is in the cell's close-call set (EV within the stage's ε of the best). */
  near?: boolean;
  /** My raise over an all-in was graded as a call of it. */
  asCall?: boolean;
}

/** A hero move's group. */
export const moveGroup = (m: { kind: MoveOption["kind"]; to?: number }, allInTo: number): Group => groupOf(m, allInTo);

/** Why a ✗ became △, or why there is no grade (the soft texts the tags compare). */
export const LOW_SOFT = "신뢰도 낮은 차트";
export const SIZE_SOFT = "레이즈 크기가 차트와 달라요";
export const MODEL_GAP_SOFT = "이 차트엔 림프·플랫이 없어요";
export const LOW_LIMP_SOFT = "신뢰도 낮은 차트라 참고만";
export const AS_CALL_TAG = "올인엔 콜과 같아요";
/**
 * A ✓ or ✗ facing an all-in that the hand's own call numbers contradict: the call EV by more than EV_GAP (bb), or the
 * equity shown against the price (필요 X% · 그때 추정 Y%, whole points) by EQ_GAP points or more. At 8–20bb a point of
 * equity is worth 0.2–0.4bb, so the EV alone lets a ✗ stand beside "필요 41% · 그때 추정 44%".
 */
export const EV_SOFT = "콜 EV와 차트가 엇갈려요";
export const EV_GAP = 1;
export const EQ_GAP = 2;

/** Facing an all-in, the numbers the hand shows beside the grade: the call EV (bb, as shown), my equity and the price. */
export interface CallNumbers {
  ev: number;
  equity: number;
  need: number;
}

/**
 * The edge of my call or fold by those numbers, in bb and in the whole equity points the card shows (positive: the
 * numbers favour what I did).
 */
export function callEdge(nums: CallNumbers, mine: "call" | "fold"): { bb: number; points: number } {
  const sign = mine === "call" ? 1 : -1;
  return { bb: sign * nums.ev, points: sign * (Math.round(nums.equity * 100) - Math.round(nums.need * 100)) };
}

/** A ✓ the numbers call clearly worse, or a ✗ they call clearly better (EV_GAP bb, EQ_GAP points). */
export function numbersContradict(grade: ChartGrade["grade"], edge: { bb: number; points: number }): boolean {
  if (grade === "good") return edge.bb < -EV_GAP || edge.points <= -EQ_GAP;
  if (grade === "mistake") return edge.bb > EV_GAP || edge.points >= EQ_GAP;
  return false;
}

/** The hands everyone raises: a low-confidence chart that limps one of them is not graded by (the SB's AA limp). */
const PREMIUM: ReadonlySet<string> = new Set(["AA", "KK", "QQ", "JJ", "AKs", "AKo"]);

/**
 * A low-confidence solver line whose top action with this premium hand is a limp: its limp or open (the call and raise
 * groups) is shown for reference only. A fold is still graded; an all-in is a △ at most where the tree has an all-in
 * (a ✗ where it has none).
 */
export function lowConfidenceLimp(hit: ChartHit, cls: HandClass): boolean {
  if (hit.pick.source !== "solver" || hit.confidence !== "low" || !PREMIUM.has(cls)) return false;
  const s = hit.scenario.strategy[cls];
  const limp = s?.limp ?? 0;
  return limp > 1e-9 && Object.entries(s ?? {}).every(([k, p]) => k === "limp" || (p ?? 0) <= limp + 1e-9);
}

/** Whether the chart offers a move of this group at all (the BB facing the SB's limp can't fold). */
export function chartOffers(hit: ChartHit, g: Group, allInTo: number): boolean {
  const sc = hit.scenario;
  return g === "fold" ? !sc.noFold : sc.actions.some((a) => keyGroup(hit, a.key, allInTo) === g);
}

/**
 * The all-in of a premium a low-confidence solver line limps (lowConfidenceLimp): "soft" where the chart's tree has an
 * all-in, even at 0% (30–45bb SB AKo: 림프 80% / 올인 0%), so a ✗ is only △: it is two steps from the limp the chart is
 * doubted for. "offTree" where the tree has none (the SB's AA at 55bb and up): a ✗ as any move the chart lacks. Null
 * for any other hand or line. The hand review's grade and 빠른 기록's verdict both read it.
 */
export function lowLimpJam(hit: ChartHit, cls: HandClass, allInTo: number): "soft" | "offTree" | null {
  if (!lowConfidenceLimp(hit, cls)) return null;
  return chartOffers(hit, "allin", allInTo) ? "soft" : "offTree";
}

/**
 * The grade of my move (its group) with hand `cls` against the chart. `allInTo` is my whole stack as a street total.
 * `call`: facing an all-in, the call EV, equity and price the hand shows next to the grade, which it may not contradict.
 */
export function gradeVsChart(hit: ChartHit, cls: HandClass, move: { kind: MoveOption["kind"]; to?: number }, allInTo: number, call?: CallNumbers): ChartGrade {
  const sc = hit.scenario;
  const moves = hit.moves(cls, allInTo);
  const freq = groupFreqs(moves, allInTo);
  let mine = moveGroup(move, allInTo);
  // Facing an all-in, a raise over it (isolating a shorter stack's jam) is a call of it: the charts only call there.
  const asCall = hit.facingJam && (mine === "raise" || mine === "allin");
  if (asCall) mine = "call";
  const main = GROUPS.reduce((b, g) => (freq[g] > freq[b] + 1e-9 ? g : b), "fold" as Group);
  const closeKeys = quizCloseActions(sc, cls);
  const labels = (keys: string[]) => keys.map((k) => legendActions(sc).find((a) => a.key === k)?.label ?? k);
  const close = closeKeys && closeKeys.length >= 2 ? labels(closeKeys) : undefined;
  const extra = { ...(close ? { close } : {}), ...(asCall ? { asCall } : {}) };
  if (hit.refOnly) return { grade: "info", freq: freq[mine], soft: hit.refOnly, main, ...extra };
  if (reachOf(sc, cls) <= 0) return { grade: "info", freq: 0, soft: "앞 액션이 차트 밖이라 채점 안 해요", main };
  // The SB's 100% AA limp of a low-confidence chart: too far from what anyone plays to grade a limp or an open by
  // (an all-in, like a fold, stays graded; see the softening below).
  if ((mine === "call" || mine === "raise") && lowConfidenceLimp(hit, cls)) return { grade: "info", freq: freq[mine], soft: LOW_LIMP_SOFT, main, ...extra };

  let f = freq[mine];
  let size: string | undefined;
  let raiseTo = 0;
  let raiseLabel = "";
  for (const a of sc.actions) {
    if (keyGroup(hit, a.key, allInTo) !== "raise") continue;
    const to = Number(/([\d.]+)bb/.exec(a.label)?.[1] ?? 0);
    if (to > raiseTo) [raiseTo, raiseLabel] = [to, a.label];
  }
  // A raise of another size than the chart's counts as the chart's raise, its size named: a small raise where it
  // shoves, and a shove where short stacks shove anyway or the chart's raise commits the stack.
  const jamIsSize = hit.pick.source !== "solver" || raiseTo >= COMMIT * allInTo;
  if ((mine === "raise" || (mine === "allin" && jamIsSize)) && f < 1e-9) {
    const other: Group = mine === "raise" ? "allin" : "raise";
    if (freq[other] > 1e-9) {
      f = freq[other];
      size = other === "allin" ? "올인" : raiseLabel || "레이즈";
    }
  }
  const offTree = !chartOffers(hit, mine, allInTo) && !size;
  // The short-stack and push/fold models have no limp, and no flat but the BB's: a limit of the model, not a computed
  // 0%. Only a hand the chart folds outright is a ✗ there.
  if (offTree && hit.pick.source !== "solver" && freq.fold < 1 - 1e-9) return { grade: "info", freq: 0, soft: MODEL_GAP_SOFT, main, ...extra };
  const best = Math.max(...GROUPS.map((g) => freq[g]));
  const near = !!closeKeys && closeKeys.some((k) => keyGroup(hit, k, allInTo) === mine);
  const q = gradePreflop(f, best, near, hit.pick.source === "solver" ? SOLVER_MIXED_MIN : MIXED_MIN);
  let grade: ChartGrade["grade"] = q === "correct" || q === "close" ? "good" : q === "mixed" ? "ok" : "mistake";
  let soft: string | undefined;
  if (grade === "mistake") {
    const step = Math.abs(LEVEL[mine] - LEVEL[main]);
    if (sc.quizSkip?.[cls]) soft = "모델 한계 칸";
    // (Not a fold of a premium the low chart limps: its doubt is limp or raise, never fold.)
    else if (hit.confidence === "low" && step === 1 && !(mine === "fold" && lowConfidenceLimp(hit, cls))) soft = LOW_SOFT;
    // The all-in of a premium the low chart limps, where its tree has an all-in: no ✗ either (lowLimpJam).
    else if (mine === "allin" && lowLimpJam(hit, cls, allInTo) === "soft") soft = LOW_SOFT;
    else if ((hit.sizeRatio >= 1.25 && LEVEL[mine] < LEVEL[main]) || (hit.sizeRatio <= 0.8 && LEVEL[mine] > LEVEL[main])) soft = SIZE_SOFT;
    if (soft) grade = "ok";
  }
  // Facing an all-in the hand's own call EV, equity and price are on screen next to the grade: a ✓ or ✗ they
  // contradict (the chart assumed another jam range or stack than this hand's numbers) is only △.
  if (call !== undefined && hit.facingJam && (mine === "call" || mine === "fold") && numbersContradict(grade, callEdge(call, mine))) {
    grade = "ok";
    soft = EV_SOFT;
  }
  return { grade, freq: f, main, ...extra, ...(near ? { near } : {}), ...(soft ? { soft } : {}), ...(offTree ? { offTree } : {}), ...(size ? { size } : {}) };
}

/** "솔버 100bb · BTN vs CO 오픈 — 3벳 6.6bb 100% / 콜 0% / 폴드 0%". */
export function chartText(hit: ChartHit, cls: HandClass): string {
  const sc = hit.scenario;
  return `${hit.pick.name} · ${sc.title} — ${describeStrategy(sc, sc.strategy[cls])}`;
}

/**
 * The small tags under a graded decision, each short and said once: 신뢰도, EV 거의 같음 (when my action is one of the
 * close calls), each approximation, why a ✗ was softened or there is no grade (not when another tag already says it:
 * the low confidence, the raise size), a raise over an all-in taken as a call, and an action the chart lacks.
 */
export function chartTags(hit: ChartHit, g: ChartGrade): string[] {
  const out: string[] = [];
  // The low-confidence 참고 says the confidence itself.
  if (hit.confidence && g.soft !== LOW_LIMP_SOFT) out.push(`신뢰도 ${CONFIDENCE_KO[hit.confidence]}`);
  if (g.near) out.push("EV 거의 같음");
  out.push(...hit.approx);
  const repeats = (g.soft === LOW_SOFT && hit.confidence === "low") || (g.soft === SIZE_SOFT && hit.sizeNote !== undefined);
  if (g.soft && !repeats) out.push(g.soft);
  if (g.asCall) out.push(AS_CALL_TAG);
  if (g.offTree) out.push("이 차트엔 없는 선택");
  if (g.size) out.push(`차트는 ${g.size}`);
  return out;
}

/**
 * The coach's lines about the chart of one decision: the chart, stage and spot with my hand's frequencies and the
 * confidence, then the close call, the approximations, the model's known limits on this hand and the big-pair caveat.
 * Not why a ✗ was softened or there is no grade: the decision's summary, which the coach reads right before these
 * lines, says that already.
 */
export function chartFacts(hit: ChartHit, cls: HandClass, g: ChartGrade): string[] {
  const sc = hit.scenario;
  const conf = hit.confidence ? ` · 신뢰도 ${CONFIDENCE_KO[hit.confidence]}${hit.confidenceNote ? ` (${hit.confidenceNote})` : ""}` : "";
  const out = [`차트: ${hit.pick.name} (${sc.stageLabel}) · ${sc.title} · ${describeStrategy(sc, sc.strategy[cls])}${conf}`];
  const close = g.close ? closeFact(sc, cls, undefined, quizCloseActions(sc, cls)) : null;
  if (close) out.push(close);
  if (hit.approx.length) out.push(`근사: ${hit.approx.map((a) => a.replace(/ 근사$/, "")).join(", ")}`);
  if (g.asCall) out.push("채점 메모: 올인 위 레이즈도 콜로 채점");
  out.push(...cautionFacts(sc, cls));
  const big = bigPairCloseNote(sc, cls);
  if (big) out.push(big);
  return out;
}
