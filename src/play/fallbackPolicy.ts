import type { HandClass } from "../poker/cards";
import { parseRange, type Range } from "../poker/range";
import { openSize, threeBetSize, type MoveOption, type PreflopDecision, type PreflopSpot } from "./policy";

/**
 * What an opponent does where the computed charts have no spot (computedChart.ts chartFor's misses: limped pots, a
 * cold call of a 3-bet, multiway lines the solver dropped): plain tight rules, labelled as such. Only bots and the
 * opponents' range narrowing use them; the hero is never graded by them (a decision with no chart is "info").
 */

export const FALLBACK_LABEL = "차트 없음 · 기본 규칙";

const R = (s: string) => parseRange(s);
const TIGHT_CONTINUE = R("QQ+, AKs, AKo");
const PREMIUM = R("KK+, AKs");
const FLAT = R("22-JJ, AJs-AQs, KQs, JTs");
/** A first-in raise when no chart says (the heads-up SB deep): a wide button-like range. */
const OPEN_DEFAULT = R("22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, A7o+, K9o+, QTo+, JTo");

function fromRanges(spec: { kind: MoveOption["kind"]; to?: number; range: Range | ((h: HandClass) => number) }[], rest: MoveOption["kind"]) {
  return (h: HandClass): MoveOption[] => {
    let left = 1;
    const out: MoveOption[] = [];
    for (const s of spec) {
      const f = typeof s.range === "function" ? s.range(h) : (s.range[h] ?? 0);
      const p = Math.min(f, left);
      if (p > 0) out.push({ kind: s.kind, ...(s.to !== undefined ? { to: s.to } : {}), prob: p });
      left -= p;
    }
    if (left > 1e-9) out.push({ kind: rest, prob: left });
    return out;
  };
}

/**
 * The fallback decision of a spot. `firstIn`: the seat's own first-in raise share from the computed chart at these
 * stacks (computedChart.ts firstInRaise); an iso over limpers raises those hands, 1bb more per limper.
 */
export function fallbackDecision(spot: PreflopSpot, firstIn?: (h: HandClass) => number): PreflopDecision {
  const allInTo = spot.myBet + spot.myStack;
  const cap = (x: number) => Math.min(x, allInTo);
  const label = FALLBACK_LABEL;
  if (spot.facingAllIn) return { label, moves: fromRanges([{ kind: "call", range: TIGHT_CONTINUE }], "fold") };
  if (spot.raises === 0) {
    if (spot.seat === "BB") return { label, moves: fromRanges([{ kind: "raise", to: cap(4 + spot.limpers), range: TIGHT_CONTINUE }], "check") };
    const to = cap(openSize(spot.mode, spot.stageId, spot.seat) + spot.limpers);
    return { label, moves: fromRanges([{ kind: "raise", to, range: firstIn ?? OPEN_DEFAULT }], "fold") };
  }
  if (spot.raises === 1) {
    const to = cap(threeBetSize(spot.mode, spot.seat, spot.openerSeat, spot.currentBet));
    return { label, moves: fromRanges([{ kind: "raise", to, range: TIGHT_CONTINUE }, { kind: "call", range: FLAT }], "fold") };
  }
  if (spot.raises === 2 && spot.iAmOpener) {
    return { label, moves: fromRanges([{ kind: "raise", to: allInTo, range: PREMIUM }, { kind: "call", range: R("QQ-TT, AKo, AQs") }], "fold") };
  }
  return { label, moves: fromRanges([{ kind: "raise", to: allInTo, range: PREMIUM }, { kind: "call", range: R("QQ, AKo") }], "fold") };
}
