import { act, pot, type Game } from "./engine";
import { COMBOS } from "./handInfo";
import type { PreflopDecision } from "./policy";
import type { Weights } from "./analysis";

/**
 * The one honest exploit number of the AI table preflop: how often every AI behind folds to my raise, as they play now
 * (their profiles) and as the chart would, next to the fold rate a pure bluff needs. No EV claim: the chart data stores
 * no action EVs, and the called branch would need a realization model the app doesn't have. Pure.
 */

export interface FoldOut {
  raiseTo: number;
  /** Every responder folds, as these AIs play. */
  all: number;
  /** The same with every responder on the chart. */
  gto: number;
  /** A pure bluff's break-even fold rate: invest ÷ (invest + pot). */
  need: number;
  /** Some responder had no chart (the fallback rules). */
  fallback: boolean;
  text: string;
}

/** A responder's decision at game `g` (the seat to act), as it plays it (`adjusted`) and on the chart. */
export type Decide = (g: Game, idx: number) => { dec: PreflopDecision; gto: PreflopDecision; fellBack: boolean };

const pct = (x: number) => `${Math.round(x * 100)}%`;

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * `g`: the game with the hero to act; `ranges`: everyone's current ranges. The responders answer in order, each after
 * the earlier ones folded; a responder's fold share is over its range without my hole cards. `chartRaise`: I folded or
 * called and `raiseTo` is the chart's raise with my hand, so the note names it ("차트 레이즈 8.8이면 …").
 */
export function foldOut(g: Game, heroIdx: number, raiseTo: number, ranges: readonly Weights[], decide: Decide, chartRaise = false): FoldOut | null {
  if (g.toAct !== heroIdx || g.street !== "preflop") return null;
  const hero = g.players[heroIdx];
  const invest = raiseTo - hero.streetBet;
  const potNow = pot(g);
  if (!(invest > 0)) return null;
  const dead = new Set(hero.hole);
  let cur = act(g, "raise", raiseTo);
  let all = 1, gto = 1, fallback = false, n = 0;
  let guard = 0;
  while (!cur.done && cur.toAct !== null && cur.toAct !== heroIdx && guard++ < 20) {
    const i = cur.toAct;
    const { dec, gto: base, fellBack } = decide(cur, i);
    fallback ||= fellBack;
    const w = ranges[i];
    let tot = 0, f = 0, fg = 0;
    for (let c = 0; c < COMBOS.length; c++) {
      const x = w[c];
      if (!(x > 0)) continue;
      const [a, b] = COMBOS[c].cards;
      if (dead.has(a) || dead.has(b)) continue;
      const h = COMBOS[c].hand;
      tot += x;
      f += x * dec.moves(h).filter((m) => m.kind === "fold").reduce((s, m) => s + m.prob, 0);
      fg += x * base.moves(h).filter((m) => m.kind === "fold").reduce((s, m) => s + m.prob, 0);
    }
    all *= tot > 0 ? f / tot : 1;
    gto *= tot > 0 ? fg / tot : 1;
    n++;
    cur = act(cur, "fold");
  }
  if (!n) return null;
  const need = invest / (invest + potNow);
  const head = chartRaise ? `차트 레이즈 ${r1(raiseTo)}이면 모두 폴드` : "이 레이즈에 모두 폴드";
  // A responder without a chart plays the fallback rules either way: the comparison is then "without a profile".
  const base = fallback ? "성향 없는 AI라면" : "차트대로 치는 AI라면";
  const text = `${head} ${pct(all)} (${base} ${pct(gto)}) · 순수 블러프면 필요 폴드율 ${pct(need)}`;
  return { raiseTo, all, gto, need, fallback, text };
}

/** The fact lines under the fold-out note. */
export function foldOutFacts(f: FoldOut): string[] {
  return ["콜 받은 뒤 이기는 몫은 빼고 계산", "두 값 모두 지금 남은 레인지 기준", ...(f.fallback ? ["일부 자리는 차트 없음 · 기본 규칙"] : [])];
}
