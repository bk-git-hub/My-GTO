import { actionLabel, scenarioActions, type HandStrategy, type Scenario } from "../data/preflop";

export const ACTION_COLORS = {
  raise: "var(--raise)",
  call: "var(--call)",
  fold: "var(--fold)",
} as const;

export function strategyGradient(s: HandStrategy): string {
  const r = s.raise * 100;
  const c = (s.raise + s.call) * 100;
  return `linear-gradient(to right, var(--raise) 0 ${r}%, var(--call) ${r}% ${c}%, var(--fold) ${c}% 100%)`;
}

export function FreqBar({ scenario, strategy }: { scenario: Scenario; strategy: HandStrategy }) {
  const actions = scenarioActions(scenario).slice().reverse(); // raise, call, fold
  return (
    <div>
      <div className="freqbar" style={{ background: strategyGradient(strategy) }} />
      <div className="freq-legend">
        {actions.map((a) => (
          <span key={a} className="freq-item">
            <i style={{ background: ACTION_COLORS[a] }} />
            {actionLabel(scenario, a)} {Math.round(strategy[a] * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}

export function describeStrategy(scenario: Scenario, s: HandStrategy): string {
  return scenarioActions(scenario)
    .slice()
    .reverse()
    .map((a) => `${actionLabel(scenario, a)} ${Math.round(s[a] * 100)}%`)
    .join(" / ");
}
