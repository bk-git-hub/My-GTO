/**
 * Pot-odds math. `pot` is the pot before the villain's bet,
 * `bet` is the villain's bet (which is also hero's call amount).
 */

/** Minimum equity needed to call: call / (final pot). */
export function requiredEquity(pot: number, bet: number): number {
  return bet / (pot + bet * 2);
}

/** Minimum defense frequency vs a bet: pot / (pot + bet). */
export function mdf(pot: number, bet: number): number {
  return pot / (pot + bet);
}

/** Fold % a pure bluff needs to break even: bet / (pot + bet). */
export function bluffBreakEven(pot: number, bet: number): number {
  return bet / (pot + bet);
}

/** EV of calling relative to folding, in the same unit as pot/bet. */
export function callEV(equity: number, pot: number, bet: number): number {
  return equity * (pot + bet) - (1 - equity) * bet;
}

/** Exact chance to hit at least one of `outs` with `cardsToCome` (1 or 2) cards, unseen = 47 on flop / 46 on turn. */
export function hitChance(outs: number, cardsToCome: 1 | 2, unseen = cardsToCome === 2 ? 47 : 46): number {
  if (cardsToCome === 1) return outs / unseen;
  const miss = ((unseen - outs) * (unseen - outs - 1)) / (unseen * (unseen - 1));
  return 1 - miss;
}

/** The "rule of 2 and 4" approximation, in percent. */
export function ruleOf2and4(outs: number, cardsToCome: 1 | 2): number {
  if (cardsToCome === 1) return outs * 2;
  return outs > 8 ? outs * 4 - (outs - 8) : outs * 4;
}

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
