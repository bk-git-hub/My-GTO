import { describeStrategy, FOLD, type ActionColor, type HandStrategy, type ScenarioDef } from "../data/charts";

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
        {[...scenario.actions, FOLD].map((a) => (
          <span key={a.key} className="freq-item">
            <i style={{ background: actionColor(a.color, a.key) }} />
            {a.label} {Math.round((strategy[a.key] ?? 0) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}

export { describeStrategy };
