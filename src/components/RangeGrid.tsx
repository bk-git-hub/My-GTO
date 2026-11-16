import { closeSplit, describeStrategy, strategyGradient } from "./FreqBar";
import { inReach, type Scenario } from "../data/charts";
import { gridHand, type HandClass } from "../poker/cards";

/**
 * 13x13 chart. Cells are colored by action frequency; `selected` is outlined. Where the scenario has a
 * reachRange, hands that never get here are dimmed with no colors ("out"): a chart deep in a line would
 * otherwise read as mostly fold. A close-call cell (the solver set, docs §6.9) gets a corner notch ("close", last in
 * the class list so every other cell's class stays as it was) and the near actions in its title.
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
          const close = out ? null : closeSplit(scenario, h);
          return (
            <button
              key={h}
              type="button"
              className={`cell ${selected === h ? "sel" : ""} ${out ? "out" : s.fold >= 0.999 ? "folded" : ""}${close ? " close" : ""}`}
              style={out ? undefined : { background: strategyGradient(scenario, s) }}
              onClick={onPick ? () => onPick(h) : undefined}
              tabIndex={onPick ? 0 : -1}
              title={
                out
                  ? `${h}: 여기까지 오지 않는 핸드`
                  : `${h}: ${describeStrategy(scenario, s)}${close ? ` · EV 거의 같음: ${[close.chart, ...close.others].join("·")}` : ""}`
              }
            >
              {h}
            </button>
          );
        }),
      )}
    </div>
  );
}
