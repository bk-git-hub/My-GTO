import { RANKS, type HandClass } from "./cards";

/**
 * How much of its raw equity a hand realizes out of position after calling a preflop raise,
 * before any stack-depth adjustment. Pairs and connected or broadway suited hands play well
 * postflop; weak offsuit hands get bet off their equity. A judgment table shared by the
 * short-stack solver and the BB defense charts.
 */
export function baseRealization(h: HandClass): number {
  if (h.length === 2) return 0.9;
  const r = (c: string) => RANKS.indexOf(c);
  const hi = r(h[0]), lo = r(h[1]);
  const gap = hi - lo - 1;
  if (h[2] === "s") {
    if (lo >= r("T")) return 0.9; // suited broadway
    if (gap === 0 && lo >= r("4")) return 0.9; // 54s+ connectors
    if (gap === 1 && lo >= r("5")) return 0.85; // 75s+ one-gappers
    if (hi === r("A")) return 0.85; // suited aces: nut flushes
    if (hi >= r("Q")) return 0.8; // K-x, Q-x suited
    return gap <= 2 ? 0.72 : 0.62;
  }
  if (lo >= r("T")) return 0.85; // offsuit broadway
  if (hi === r("A")) return 0.72;
  if (gap === 0 && lo >= r("5")) return 0.7; // 65o+ connectors
  if (hi === r("K")) return 0.62;
  return 0.5;
}

/** Shorter stacks leave less to play after the flop, so the shortfall shrinks (in full from 20bb up). */
export function realizationAt(h: HandClass, stack: number, open: number): number {
  return 1 - (1 - baseRealization(h)) * Math.min(1, (stack - open) / 18);
}
