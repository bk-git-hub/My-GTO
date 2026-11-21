import type { Street } from "../../play/engine";
import type { Decision } from "../../play/table";

/**
 * The end-of-hand verdict for 핸드 플레이: how good the user's decisions were, kept apart from how
 * many chips the hand won or lost. One hand's chips are mostly luck; the decisions are what the
 * user controls, so the result box is colored and headlined by the decisions.
 */

export const STREET_LABEL: Record<Street, string> = { preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버" };

/** What the verdict needs from a decision (a 참고 row of the AI table also carries the EV model's options). */
export type GradedDecision = Pick<Decision, "street" | "grade" | "chosen" | "chosenLabel"> & Partial<Pick<Decision, "options" | "pot" | "reason">>;

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The worst graded decision of the hand; "none" when nothing was graded (only 참고, or no decision). */
export type VerdictKind = "good" | "ok" | "mistake" | "none";

export interface HandVerdict {
  kind: VerdictKind;
  /** Result-box class: the box's color comes from the decisions, not the chips. */
  cls: "correct" | "mixed" | "wrong" | "neutral";
  headline: string;
  /** Decisions graded good / ok / mistake (참고 is not graded). */
  graded: number;
  mistakes: number;
}

export function handVerdict(decisions: readonly GradedDecision[]): HandVerdict {
  const graded = decisions.filter((d) => d.grade !== "info");
  const mistakes = graded.filter((d) => d.grade === "mistake").length;
  const n = graded.length;
  if (!n) return { kind: "none", cls: "neutral", headline: "채점할 결정이 없었어요", graded: 0, mistakes: 0 };
  if (mistakes) return { kind: "mistake", cls: "wrong", headline: `실수 ${mistakes}개`, graded: n, mistakes };
  if (graded.some((d) => d.grade === "ok")) return { kind: "ok", cls: "mixed", headline: "판단 괜찮았어요", graded: n, mistakes: 0 };
  return { kind: "good", cls: "correct", headline: "판단 좋았어요", graded: n, mistakes: 0 };
}

/** A chip amount as the page writes it: "+5bb", "-3bb", or "본전". */
export function formatNet(net: number): string {
  const n = r1(net);
  return n > 0 ? `+${n}bb` : n < 0 ? `${n}bb` : "본전";
}

export interface ChipResult {
  /** "+5bb" / "-3bb" / "본전" */
  amount: string;
  tone: "win" | "loss" | "even";
  showdown: boolean;
  /** "결과 -3bb · 쇼다운" */
  text: string;
}

/** The hand's chip result, the secondary line under the verdict. */
export function chipResult(net: number, showdown: boolean): ChipResult {
  const n = r1(net);
  const amount = formatNet(n);
  return { amount, tone: n > 0 ? "win" : n < 0 ? "loss" : "even", showdown, text: `결과 ${amount}${showdown ? " · 쇼다운" : ""}` };
}

export const GOOD_BUT_LOST = "판단이 맞아도 한 판은 질 수 있어요. 같은 상황을 여러 번 하면 평균적으로 더 이득인 선택이에요.";
export const MISTAKE_BUT_WON = "이번엔 이겼지만, 길게 보면 손해 보는 선택이 있었어요.";

/**
 * One sentence when the verdict and the chips disagree; null when they agree (or there is nothing to
 * compare). `foldedOnly`: my only move was a fold, so the chips lost were blinds or antes I could not
 * save; a right fold there needs no explaining on every hand.
 */
export function mismatchNote(kind: VerdictKind, net: number, foldedOnly = false): string | null {
  const n = r1(net);
  if ((kind === "good" || kind === "ok") && n < 0 && !foldedOnly) return GOOD_BUT_LOST;
  if (kind === "mistake" && n > 0) return MISTAKE_BUT_WON;
  return null;
}

/** Every move I made was a fold (in practice: one fold, before putting in a chip of my own). */
export function foldedOnly(decisions: readonly Pick<GradedDecision, "chosen">[]): boolean {
  return decisions.length > 0 && decisions.every((d) => d.chosen === "fold");
}

/** A move without its size: "콜 2.5" -> "콜", "벳 33% (2.1)" -> "벳 33%", "3벳 10.5" -> "3벳". */
export function moveName(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+[\d.]+$/, "").trim() || label;
}

/**
 * The moves that went wrong, named in order: "실수: 플랍 체크, 턴 콜". With no 실수 but some 괜찮음,
 * those: "아쉬운 선택: 턴 콜". Null when every graded decision was good or nothing was graded; 참고
 * decisions are never named. No EV sum: the EVs are per-street estimates of the whole pot, so adding
 * them across streets gives numbers bigger than the stack.
 */
export function missLine(decisions: readonly GradedDecision[]): string | null {
  const named = (grade: "mistake" | "ok") =>
    decisions.filter((d) => d.grade === grade).map((d) => `${STREET_LABEL[d.street]} ${moveName(d.chosenLabel)}`);
  const mistakes = named("mistake");
  if (mistakes.length) return `실수: ${mistakes.join(", ")}`;
  const ok = named("ok");
  return ok.length ? `아쉬운 선택: ${ok.join(", ")}` : null;
}

/** This visit's running totals (React state on the page; nothing stored). */
export interface SessionTotals {
  hands: number;
  /** Chips won or lost over the session, bb */
  net: number;
  /** Decisions graded good / ok / mistake over the session (참고 is not graded) */
  graded: number;
  mistakes: number;
}

export const EMPTY_SESSION: SessionTotals = { hands: 0, net: 0, graded: 0, mistakes: 0 };

export function addHand(t: SessionTotals, hand: { net: number; graded: number; mistakes: number }): SessionTotals {
  return { hands: t.hands + 1, net: r1(t.net + hand.net), graded: t.graded + hand.graded, mistakes: t.mistakes + hand.mistakes };
}

/**
 * "이번 세션 12핸드 · 실수 2개 / 결정 30개 · 결과 합계 -12bb": decisions first, chips last. The
 * decision count is left out while nothing was graded; null before the first finished hand.
 */
export function sessionLine(t: SessionTotals): string | null {
  if (!t.hands) return null;
  const net = formatNet(t.net);
  const decisions = t.graded ? ` · 실수 ${t.mistakes}개 / 결정 ${t.graded}개` : "";
  return `이번 세션 ${t.hands}핸드${decisions} · 결과 합계 ${net === "본전" ? "0bb" : net}`;
}

/**
 * A 참고 decision (not graded: multiway, turn, river, no pack) whose move is not the best one by the EV model against
 * these AIs, by more than the ✓ margin of an EV grade (0.15bb or 5% of the pot). It is never a grade (the model is
 * approximate), only a hint that the hand's headline doesn't cover that decision.
 */
export function refMiss(d: GradedDecision): boolean {
  if (d.grade !== "info" || !d.reason || !d.options) return false;
  const evs = d.options.filter((o) => o.ev !== null) as { key: string; ev: number }[];
  const mine = evs.find((o) => o.key === d.chosen);
  if (!mine || evs.length < 2) return false;
  const best = Math.max(...evs.map((o) => o.ev));
  return best - mine.ev > Math.max(0.15, (d.pot ?? 0) * 0.05);
}

const named = (ds: readonly GradedDecision[]) => ds.map((d) => `${STREET_LABEL[d.street]} ${moveName(d.chosenLabel)}`).join(", ");

export interface TableVerdict {
  /** "프리플랍 판단 좋았어요" when only part of the hand was graded; else handVerdict's headline. */
  headline: string;
  /** "채점 1개 · 참고 4개"; null when every decision was graded. */
  scope: string | null;
  /** Under the verdict: the luck note (only when no 참고 decision went against the EV model) and the 참고 note. */
  notes: string[];
}

/**
 * The AI table's end-of-hand verdict. Most postflop decisions are 참고 there, so the headline names the streets it
 * graded, the scope line counts the rest, and "판단이 맞아도 한 판은 질 수 있어요" is kept for hands whose 참고 decisions
 * agreed with the EV model; otherwise those decisions are named, plainly as 참고.
 */
export function tableVerdict(decisions: readonly GradedDecision[], net: number | null): TableVerdict {
  const v = handVerdict(decisions);
  const info = decisions.filter((d) => d.grade === "info");
  const misses = decisions.filter(refMiss);
  const streets = [...new Set(decisions.filter((d) => d.grade !== "info").map((d) => STREET_LABEL[d.street]))].join("·");
  const headline = info.length && (v.kind === "good" || v.kind === "ok") ? `${streets} ${v.headline}` : v.headline;
  // The 참고 decisions that went against the model are named in the note below, not counted here as well.
  const scope = !info.length ? null : v.graded ? `채점 ${v.graded}개 · 참고 ${info.length}개` : `참고 ${info.length}개`;
  const notes: string[] = [];
  if (net !== null) {
    const m = mismatchNote(v.kind, net, foldedOnly(decisions));
    if (m && !(m === GOOD_BUT_LOST && misses.length)) notes.push(m);
  }
  if (misses.length) notes.push(`참고 결정 중 이 AI들 기준 EV가 더 높은 선택이 있었어요: ${named(misses)} (근사라 채점엔 안 넣어요)`);
  return { headline, scope, notes };
}

/** The verdict lines of the AI review, placed before the chip result so the coach reads them first. */
export function verdictReviewLines(decisions: readonly GradedDecision[]): string[] {
  const v = handVerdict(decisions);
  const miss = missLine(decisions);
  const lines = [v.kind === "none" ? `판단 평가: ${v.headline}` : `판단 평가: ${v.headline} (채점한 결정 ${v.graded}개 중 실수 ${v.mistakes}개)`];
  if (miss) lines.push(miss);
  const info = decisions.filter((d) => d.grade === "info").length;
  const misses = decisions.filter(refMiss);
  if (info) lines.push(`참고만 한 결정 ${info}개 (채점 안 함)${misses.length ? ` · 이 AI들 기준 EV 최고와 다른 선택: ${named(misses)}` : ""}`);
  lines.push(
    "리뷰 기준: 이 한 판의 칩 결과가 아니라 각 결정이 그 시점의 정보로 맞았는지로 평가해줘. 좋은 판단도 한 판은 질 수 있고, 실수해도 이길 수 있어.",
  );
  return lines;
}
