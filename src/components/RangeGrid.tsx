import { describeStrategy, strategyGradient } from "./FreqBar";
import { inReach, type Scenario } from "../data/charts";
import { gridHand, type HandClass } from "../poker/cards";

/**
 * 13x13 chart. Cells are colored by action frequency; `selected` is outlined. Where the scenario has a
 * reachRange, hands that never get here are dimmed with no colors ("out"): a chart deep in a line would
 * otherwise read as mostly fold.
 */
export function RangeGrid({
  scenario,
  selected,
  onPick,
  compact = false,
}: {
  scenario: Scenario;
  selected?: HandClass | null;
  onPick?: (h: HandClass) => void;
  compact?: boolean;
}) {
  return (
    <div className={`grid ${compact ? "compact" : ""}`} role="grid">
      {Array.from({ length: 13 }, (_, r) =>
        Array.from({ length: 13 }, (_, c) => {
          const h = gridHand(r, c);
          const s = scenario.strategy[h];
          const out = !inReach(scenario, h);
          return (
            <button
              key={h}
              type="button"
              className={`cell ${selected === h ? "sel" : ""} ${out ? "out" : s.fold >= 0.999 ? "folded" : ""}`}
              style={out ? undefined : { background: strategyGradient(scenario, s) }}
              onClick={onPick ? () => onPick(h) : undefined}
              tabIndex={onPick ? 0 : -1}
              title={out ? `${h}: 여기까지 오지 않는 핸드` : `${h}: ${describeStrategy(scenario, s)}`}
            >
              {h}
            </button>
          );
        }),
      )}
    </div>
  );
}
