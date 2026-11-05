import type { AttemptGrade } from "../../../shared/contracts";
import type { Decision, OptionEV } from "../../play/table";

const r2 = (x: number) => Math.round(x * 100) / 100;
const sign = (x: number) => `${x >= 0 ? "+" : ""}${x}`;

/** Hand-play grade → attempt grade (the tallies count everything but "mistake" as correct). */
export function playGrade(g: Decision["grade"]): AttemptGrade | null {
  if (g === "good") return "correct";
  if (g === "ok") return "mixed";
  if (g === "mistake") return "wrong";
  return null;
}

/** EV given up versus the best option, when at least two options have an EV. */
export function evLoss(options: OptionEV[], chosen: string): number | undefined {
  const evs = options.filter((o): o is OptionEV & { ev: number } => o.ev !== null && Number.isFinite(o.ev));
  const mine = evs.find((o) => o.key === chosen);
  if (!mine || evs.length < 2) return undefined;
  return r2(Math.max(0, Math.max(...evs.map((o) => o.ev)) - mine.ev));
}

const chartFreq = (label: string) => {
  const m = label.match(/차트 (\d+)%/);
  return m ? Number(m[1]) : -1;
};

function chartBestLabel(options: OptionEV[]): string {
  let best: OptionEV | null = null;
  for (const o of options) if (chartFreq(o.label) > (best ? chartFreq(best.label) : -1)) best = o;
  return best ? best.label : "-";
}

/** Label of the best option: highest EV when known, otherwise highest chart frequency (preflop). */
export function bestOptionLabel(options: OptionEV[]): string {
  const evs = options.filter((o) => o.ev !== null);
  if (evs.length >= 2) {
    const best = evs.reduce((b, o) => (o.ev! > b.ev! ? o : b));
    return `${best.label} (${sign(r2(best.ev!))}bb)`;
  }
  return chartBestLabel(options);
}

/**
 * Preflop decisions are graded by the chart, even when an all-in call also carries an EV.
 * Their stored answer must come from the same basis as the grade, so EV is left to the detail text.
 */
const chartGraded = (d: Decision) => d.street === "preflop";

/** The stored "correct" answer: chart-best preflop (the grade's basis), EV-best postflop. */
export function decisionCorrect(d: Decision): string {
  return chartGraded(d) ? chartBestLabel(d.options) : bestOptionLabel(d.options);
}

/** EV loss for the record: only for EV-graded (postflop) decisions, so it never contradicts a chart grade. */
export function decisionEvLoss(d: Decision): number | undefined {
  return chartGraded(d) ? undefined : evLoss(d.options, d.chosen);
}

/** What the user picked, with its EV (postflop) or chart frequency (preflop, already in the label). */
export function chosenOptionLabel(d: Decision): string {
  const o = d.options.find((x) => x.key === d.chosen);
  if (!o) return d.chosenLabel;
  if (chartGraded(d)) return o.label;
  return o.ev !== null && d.options.filter((x) => x.ev !== null).length >= 2 ? `${o.label} (${sign(r2(o.ev))}bb)` : o.label;
}
