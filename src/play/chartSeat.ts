/**
 * Seats of any table (2–10 players) as the 9-handed seats the computed charts are written for: a seat plays like the
 * 9-handed seat with as many players behind it (a 6-handed UTG is the LJ, a 7-handed UTG the UTG+2; at 10 players the
 * UTG and UTG+1 both read UTG and the MP reads UTG+2). Keyed by the table's own seat list (Game players' seats, or
 * recorder.ts positionsFor), so play/ needs nothing from features/. judgeChart.ts judgeSeat is this.
 */

/** The 9-handed seats of the charts, in preflop order. */
export const CHART_POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/** The chart seat of `seat` at a table whose seats in preflop order are `seats`; a seat the table lacks stays as it is. */
export function chartSeat(seats: readonly string[], seat: string): string {
  const i = seats.indexOf(seat);
  if (i < 0) return seat;
  return CHART_POS[Math.max(0, CHART_POS.length - seats.length + i)];
}

/**
 * The chart seats of the seats on one line, in table order: chartSeat, except that a seat which would read the same
 * chart seat as an earlier seat of the line moves up one (10-handed, the UTG+1 facing the UTG's open reads UTG+1,
 * as judgeChart.ts solverChart does). Null when that runs past the SB, which no line of a real table does.
 */
export function chartSeats(seats: readonly string[], involved: readonly string[]): Map<string, string> | null {
  const order = [...new Set(involved)].filter((s) => seats.includes(s)).sort((a, b) => seats.indexOf(a) - seats.indexOf(b));
  const out = new Map<string, string>();
  let prev = -1;
  for (const s of order) {
    let k = CHART_POS.indexOf(chartSeat(seats, s));
    if (k <= prev) k = prev + 1;
    // The blinds never move: a bump into them means the line can't be read on a 9-handed chart.
    const base = CHART_POS.indexOf(chartSeat(seats, s));
    if (k >= CHART_POS.length || (k !== base && k >= CHART_POS.length - 2)) return null;
    out.set(s, CHART_POS[k]);
    prev = k;
  }
  return out;
}

/** Seat ids as in the chart data: lowercase, "+" → "p" ("UTG+1" → "utgp1"). */
export const seatId = (seat: string) => seat.toLowerCase().replace("+", "p");
