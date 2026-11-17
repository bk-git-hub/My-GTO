import { closeActions, describeStrategy, FOLD, legendActions, type ActionColor, type HandStrategy, type Scenario, type ScenarioDef } from "../data/charts";
import type { HandClass } from "../poker/cards";

const COLOR_VAR: Record<ActionColor, string> = {
  open: "var(--open)",
  raise: "var(--raise)",
  allin: "var(--allin)",
  call: "var(--call)",
};

export function actionColor(color: ActionColor, key?: string): string {
  return key === "fold" ? "var(--fold)" : COLOR_VAR[color];
}

/** Horizontal bands in action order, fold last. */
export function strategyGradient(s: ScenarioDef, st: HandStrategy): string {
  const stops: string[] = [];
  let at = 0;
  for (const a of [...s.actions, FOLD]) {
    const f = (st[a.key] ?? 0) * 100;
    if (f <= 0) continue;
    const c = actionColor(a.color, a.key);
    stops.push(`${c} ${at}% ${at + f}%`);
    at += f;
  }
  return stops.length ? `linear-gradient(to right, ${stops.join(", ")})` : "var(--fold)";
}

export function FreqBar({ scenario, strategy }: { scenario: ScenarioDef; strategy: HandStrategy }) {
  return (
    <div>
      <div className="freqbar" style={{ background: strategyGradient(scenario, strategy) }} />
      <div className="freq-legend">
        {/* legendActions leaves fold out where the spot has none (noFold: the BB facing an SB limp). */}
        {legendActions(scenario).map((a) => (
          <span key={a.key} className="freq-item">
            <i style={{ background: actionColor(a.color, a.key) }} />
            {a.label} {Math.round((strategy[a.key] ?? 0) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}

/** The solver set's close-call threshold (bb) when a stage does not say (docs §6.9). */
const DEFAULT_CLOSE_EPS = 0.05;

/**
 * The close-call set of hand h (docs §6.9) as labels: the chart's action (the one it shows at ≥ 0.999) and the other
 * actions within ε of the best, in legend order. `keys` overrides the set (the quiz's quizCloseActions). null where h
 * is not marked, or the set has fewer than two actions.
 */
export function closeSplit(s: Scenario, h: HandClass, keys = closeActions(s, h)): { chart: string; others: string[] } | null {
  if (!keys || keys.length < 2) return null;
  const st = s.strategy[h];
  const label = (k: string) => legendActions(s).find((a) => a.key === k)?.label ?? k;
  const chartKey = keys.find((k) => (st[k] ?? 0) >= 0.999) ?? keys[0];
  return { chart: label(chartKey), others: keys.filter((k) => k !== chartKey).map(label) };
}

/** The coach fact of a marked hand, or null. `keys` overrides the set, as in closeSplit. */
export function closeFact(s: Scenario, h: HandClass, eps = DEFAULT_CLOSE_EPS, keys = closeActions(s, h)): string | null {
  const split = closeSplit(s, h, keys);
  return split ? `EV가 거의 같은 액션: ${[split.chart, ...split.others].join("·")} (차이 ${eps}bb 이내, 솔버 균형에 대한 최선응답 기준)` : null;
}

/**
 * Why a 100% cell carries the close notch: the chart's action and the others within ε. With `chosen` (the quiz's
 * "정답 (EV 거의 같음)"), the chosen action takes the others' place and the sentence ends "괜찮아요". `keys` overrides
 * the set (the quiz passes quizCloseActions). Nothing where h is not marked.
 */
export function CloseNote({
  scenario,
  hand,
  eps = DEFAULT_CLOSE_EPS,
  chosen,
  keys,
}: {
  scenario: Scenario;
  hand: HandClass;
  eps?: number;
  chosen?: string;
  keys?: string[];
}) {
  const split = closeSplit(scenario, hand, keys ?? closeActions(scenario, hand));
  if (!split) return null;
  const others = chosen ? [legendActions(scenario).find((a) => a.key === chosen)?.label ?? chosen] : split.others;
  return (
    <p className="close-note">
      차트는 {split.chart}만 보여 주지만 {others.join("·")}도 EV 차이가 {eps}bb 이내라 {chosen ? "괜찮아요" : "거의 같아요"}.
    </p>
  );
}

export { describeStrategy };
