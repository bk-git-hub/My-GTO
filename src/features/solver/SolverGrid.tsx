import { gridHand, type HandClass } from "../../poker/cards";

export interface GridCell {
  /** CSS background of the colored part; null = nothing to show. */
  fill: string | null;
  /** Height of the colored part, 0..1 (1 = the whole cell). */
  height: number;
  /** No combos of this class here: dimmed. */
  empty: boolean;
  title: string;
}

/**
 * 13x13 hand-class grid for solver data: each cell shows a mix of colors, optionally filled to a height. The label
 * is the same everywhere (white with a dark halo, styles.css), since it can sit over several colors at once.
 */
export function SolverGrid({
  cells,
  selected,
  onPick,
}: {
  cells: Record<HandClass, GridCell>;
  selected?: HandClass | null;
  onPick?: (h: HandClass) => void;
}) {
  return (
    <div className="grid sv-grid" role="grid">
      {Array.from({ length: 13 }, (_, r) =>
        Array.from({ length: 13 }, (_, c) => {
          const h = gridHand(r, c);
          const cell = cells[h];
          return (
            <button
              key={h}
              type="button"
              className={`cell sv-cell ${cell.empty ? "empty" : ""} ${selected === h ? "sel" : ""}`}
              onClick={onPick ? () => onPick(h) : undefined}
              tabIndex={onPick ? 0 : -1}
              title={cell.title}
              aria-pressed={selected === h}
            >
              {cell.fill && !cell.empty && <i className="sv-fill" style={{ height: `${Math.max(0, Math.min(1, cell.height)) * 100}%`, background: cell.fill }} />}
              <span className="sv-lab">{h}</span>
            </button>
          );
        }),
      )}
    </div>
  );
}
