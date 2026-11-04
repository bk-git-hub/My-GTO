import { describeStrategy, strategyGradient } from "./FreqBar";
import type { Scenario } from "../data/charts";
import { gridHand, type HandClass } from "../poker/cards";

/** 13x13 chart. Cells are colored by action frequency; `selected` is outlined. */
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
          return (
            <button
              key={h}
              type="button"
              className={`cell ${selected === h ? "sel" : ""} ${s.fold >= 0.999 ? "folded" : ""}`}
              style={{ background: strategyGradient(scenario, s) }}
              onClick={onPick ? () => onPick(h) : undefined}
              tabIndex={onPick ? 0 : -1}
              title={`${h}: ${describeStrategy(scenario, s)}`}
            >
              {h}
            </button>
          );
        }),
      )}
    </div>
  );
}
