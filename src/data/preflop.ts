import { ALL_HANDS, type HandClass } from "../poker/cards";
import { parseRange, type Range } from "../poker/range";

/**
 * 학습용 근사 프리플랍 차트 (6맥스 캐시, 100bb, 오픈 2.5bb / SB 3bb).
 *
 * 솔버를 돌려 얻은 정확한 값이 아니라, 일반적으로 알려진 GTO 경향을 바탕으로
 * 손으로 정리한 출발점이다. 직접 구한 솔버 결과나 차트로 바꿔 넣으려면
 * 아래 range 문자열만 교체하면 된다.
 *
 * 문법: "66+, 55:0.5, A2s+, KTo+, AJs-A6s, QJo:0.4"
 *   - 77+ : 77~AA,   A2s+ : A2s~AKs,   22-66 / AJs-A6s : 범위
 *   - :0.5 : 50% 빈도(혼합 전략). 뒤에 쓴 토큰이 앞의 값을 덮어쓴다.
 */

export type Position = "UTG" | "HJ" | "CO" | "BTN" | "SB" | "BB";
export const POSITIONS: Position[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

export type ActionKey = "raise" | "call" | "fold";

export interface ScenarioDef {
  id: string;
  kind: "rfi" | "vsOpen";
  hero: Position;
  villain?: Position;
  title: string;
  description: string;
  raiseLabel: string;
  raise: string;
  call?: string;
}

export interface HandStrategy {
  raise: number;
  call: number;
  fold: number;
}

export interface Scenario extends ScenarioDef {
  strategy: Record<HandClass, HandStrategy>;
  raiseRange: Range;
  callRange: Range;
}

export const GAME_LABEL = "6맥스 캐시 · 100bb · 오픈 2.5bb (SB 3bb)";

const DEFS: ScenarioDef[] = [
  // ───────── RFI: 앞에서 모두 폴드, 내가 처음 들어갈 때 ─────────
  {
    id: "rfi-utg",
    kind: "rfi",
    hero: "UTG",
    title: "UTG 오픈",
    description: "앞에 아무도 없고 UTG(가장 빠른 자리)에서 처음 레이즈할지 결정. 뒤에 5명이 남아 있어서 가장 타이트하게.",
    raiseLabel: "오픈 2.5bb",
    raise:
      "66+, 55:0.75, 44:0.5, 33:0.35, 22:0.35, A2s+, K9s+, K8s:0.4, K7s:0.2, QTs+, Q9s:0.7, JTs, J9s:0.6, T9s, T8s:0.3, 98s:0.6, 87s:0.4, 76s:0.4, 65s:0.3, ATo+, KJo+, KTo:0.3, QJo:0.4",
  },
  {
    id: "rfi-hj",
    kind: "rfi",
    hero: "HJ",
    title: "HJ 오픈",
    description: "UTG가 폴드했고 HJ에서 처음 레이즈할지 결정. 뒤에 4명.",
    raiseLabel: "오픈 2.5bb",
    raise:
      "55+, 44:0.7, 33:0.5, 22:0.4, A2s+, K8s+, K7s:0.6, K6s:0.3, Q9s+, Q8s:0.4, J9s+, J8s:0.2, T8s+, 98s, 97s:0.5, 87s, 86s:0.2, 76s:0.8, 65s:0.5, 54s:0.3, ATo+, A9o:0.6, A8o:0.2, KTo+, QJo, QTo:0.4, JTo:0.3",
  },
  {
    id: "rfi-co",
    kind: "rfi",
    hero: "CO",
    title: "CO 오픈",
    description: "앞에서 모두 폴드, CO(버튼 바로 앞)에서 처음 레이즈할지 결정. 뒤에 3명.",
    raiseLabel: "오픈 2.5bb",
    raise:
      "33+, 22:0.6, A2s+, K5s+, K4s:0.5, K3s:0.3, Q8s+, Q7s:0.6, Q6s:0.3, J8s+, J7s:0.5, T8s+, T7s:0.6, 97s, 96s:0.4, 87s, 86s:0.6, 76s, 75s:0.4, 65s, 64s:0.3, 54s:0.8, A9o+, A8o:0.8, A7o:0.5, A5o:0.4, KTo+, K9o:0.5, QTo+, Q9o:0.3, JTo, J9o:0.2, T9o:0.3",
  },
  {
    id: "rfi-btn",
    kind: "rfi",
    hero: "BTN",
    title: "BTN 오픈",
    description: "앞에서 모두 폴드, 버튼에서 처음 레이즈할지 결정. 뒤에는 블라인드 2명뿐이고 포스트플랍에서 항상 마지막에 행동(IP)한다.",
    raiseLabel: "오픈 2.5bb",
    raise:
      "22+, A2s+, K2s+, Q4s+, Q3s:0.6, Q2s:0.4, J6s+, J5s:0.6, J4s:0.4, T6s+, T5s:0.4, 96s+, 95s:0.3, 85s+, 84s:0.3, 74s+, 64s+, 63s:0.3, 53s+, 43s:0.5, A2o+, K8o+, K7o:0.6, K6o:0.3, Q9o+, Q8o:0.6, J9o+, J8o:0.5, T8o+, T7o:0.2, 98o, 97o:0.4, 87o:0.6, 76o:0.3",
  },
  {
    id: "rfi-sb",
    kind: "rfi",
    hero: "SB",
    title: "SB 오픈 (레이즈 or 폴드)",
    description: "모두 폴드하고 SB와 BB만 남음. SB에서 3bb 레이즈할지 결정. (실제 솔버는 림프도 섞지만, 여기서는 단순화해 레이즈/폴드만 다룸)",
    raiseLabel: "오픈 3bb",
    raise:
      "22+, A2s+, K2s+, Q3s+, Q2s:0.5, J5s+, J4s:0.5, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, 53s:0.5, 43s:0.4, A2o+, K8o+, K7o:0.3, Q9o+, Q8o:0.3, J9o+, J8o:0.2, T9o, T8o:0.2, 98o:0.3, 87o:0.2",
  },

  // ───────── vs 오픈: 누군가 먼저 레이즈했을 때 ─────────
  {
    id: "bb-vs-utg",
    kind: "vsOpen",
    hero: "BB",
    villain: "UTG",
    title: "BB vs UTG 오픈",
    description: "UTG가 2.5bb 오픈, 나머지는 폴드. BB에서 3벳/콜/폴드 결정. UTG 레인지가 강해서 3벳은 좁게, 콜은 팟오즈 덕분에 꽤 넓게.",
    raiseLabel: "3벳 11bb",
    raise: "KK+, QQ:0.6, JJ:0.2, AKs, AKo:0.7, AQs:0.3, A5s:0.5, A4s:0.4, KQs:0.2, 76s:0.15, 65s:0.15",
    call:
      "QQ:0.4, JJ:0.8, TT-22, AQs:0.7, AJs-A6s, A5s:0.5, A4s:0.6, A3s, A2s, KQs:0.8, KJs-K6s, QJs-Q8s, JTs-J8s, T9s, T8s, 98s, 97s, 87s, 86s, 76s:0.85, 75s, 65s:0.85, 54s, AKo:0.3, AQo, AJo, ATo:0.7, KQo, KJo:0.6, QJo:0.4",
  },
  {
    id: "bb-vs-co",
    kind: "vsOpen",
    hero: "BB",
    villain: "CO",
    title: "BB vs CO 오픈",
    description: "CO가 2.5bb 오픈. BB에서 3벳/콜/폴드 결정. CO 레인지가 UTG보다 넓어서 더 넓게 방어.",
    raiseLabel: "3벳 11bb",
    raise:
      "QQ+, JJ:0.5, TT:0.2, AKs, AQs:0.6, AJs:0.3, A5s:0.7, A4s:0.6, A3s:0.3, KQs:0.4, KJs:0.3, K9s:0.2, QJs:0.2, J9s:0.2, T9s:0.2, 87s:0.2, 76s:0.2, 65s:0.25, AKo, AQo:0.4, AJo:0.2, KQo:0.2",
    call:
      "JJ:0.5, TT:0.8, 99-22, AQs:0.4, AJs:0.7, ATs-A6s, A5s:0.3, A4s:0.4, A3s:0.7, A2s, KQs:0.6, KJs:0.7, KTs, K9s:0.8, K8s-K2s, QJs:0.8, QTs-Q5s, JTs, J9s:0.8, J8s-J6s, T9s:0.8, T8s-T6s, 98s, 97s, 96s, 87s:0.8, 86s, 85s, 76s:0.8, 75s, 74s:0.5, 65s:0.75, 64s, 54s, 53s, 43s:0.5, AQo:0.6, AJo:0.8, ATo-A7o, A5o:0.5, KJo-K9o, KQo:0.8, QJo, QTo, Q9o:0.5, JTo, J9o:0.5, T9o, 98o:0.4",
  },
  {
    id: "bb-vs-btn",
    kind: "vsOpen",
    hero: "BB",
    villain: "BTN",
    title: "BB vs BTN 오픈",
    description: "버튼이 2.5bb 오픈. BB에서 3벳/콜/폴드 결정. 버튼 레인지가 넓고 BB는 이미 1bb를 냈기 때문에 아주 넓게 방어한다.",
    raiseLabel: "3벳 11bb",
    raise:
      "QQ+, JJ:0.6, TT:0.3, 99:0.2, AKs, AQs, AJs:0.5, ATs:0.3, A5s:0.8, A4s:0.7, A3s:0.5, A2s:0.3, KQs:0.6, KJs:0.5, KTs:0.3, K9s:0.3, K8s:0.2, QJs:0.4, QTs:0.3, Q9s:0.2, JTs:0.3, J9s:0.3, T9s:0.3, T8s:0.2, 98s:0.25, 87s:0.25, 76s:0.25, 65s:0.3, 54s:0.3, AKo, AQo:0.7, AJo:0.4, ATo:0.2, KQo:0.4, KJo:0.2, A5o:0.2",
    call:
      "JJ:0.4, TT:0.7, 99:0.8, 88-22, AJs:0.5, ATs:0.7, A9s-A6s, A5s:0.2, A4s:0.3, A3s:0.5, A2s:0.7, KQs:0.4, KJs:0.5, KTs:0.7, K9s:0.7, K8s:0.8, K7s-K2s, QJs:0.6, QTs:0.7, Q9s:0.8, Q8s-Q2s, JTs:0.7, J9s:0.7, J8s-J3s, T9s:0.7, T8s:0.8, T7s-T4s, 98s:0.75, 97s-94s, 87s:0.75, 86s-84s, 76s:0.75, 75s-73s, 65s:0.7, 64s, 63s, 54s:0.7, 53s, 52s:0.5, 43s, 42s:0.4, 32s:0.4, AQo:0.3, AJo:0.6, ATo:0.8, A9o-A2o, A5o:0.8, KQo:0.6, KJo:0.8, KTo-K5o, QJo-Q7o, JTo-J7o, T9o-T7o, 98o, 97o, 87o, 86o:0.6, 76o, 75o:0.4, 65o, 54o:0.5",
  },
  {
    id: "bb-vs-sb",
    kind: "vsOpen",
    hero: "BB",
    villain: "SB",
    title: "BB vs SB 오픈",
    description: "SB가 3bb 레이즈(블라인드 배틀). BB는 포스트플랍에서 IP라서 3벳도 콜도 많이 한다.",
    raiseLabel: "3벳 9bb",
    raise:
      "TT+, 99:0.5, AJs+, ATs:0.6, A9s:0.3, A5s-A2s:0.5, KTs+, K9s:0.4, QTs+, Q9s:0.3, JTs, J9s:0.4, T9s:0.5, 98s:0.4, 87s:0.4, 76s:0.4, 65s:0.4, AJo+, ATo:0.5, KQo, KJo:0.5, QJo:0.3, K5o:0.2, Q8o:0.2, J8o:0.2",
    call:
      "99:0.5, 88-22, ATs:0.4, A9s:0.7, A8s-A6s, A5s-A2s:0.5, K9s:0.6, K8s-K2s, Q9s:0.7, Q8s-Q2s, J9s:0.6, J8s-J2s, T9s:0.5, T8s-T3s, 98s:0.6, 97s-93s, 87s:0.6, 86s-83s, 76s:0.6, 75s-73s, 65s:0.6, 64s-62s, 54s, 53s, 52s, 43s, 42s, 32s, ATo:0.5, A9o-A2o, KJo:0.5, KTo-K6o, K5o:0.8, K4o-K2o:0.6, QJo:0.7, QTo-Q9o, Q8o:0.8, Q7o-Q5o, JTo, J9o, J8o:0.8, J7o, T9o-T7o, 98o, 97o, 96o:0.5, 87o, 86o, 76o, 75o:0.5, 65o, 54o",
  },
  {
    id: "btn-vs-utg",
    kind: "vsOpen",
    hero: "BTN",
    villain: "UTG",
    title: "BTN vs UTG 오픈",
    description: "UTG가 2.5bb 오픈. 버튼에서 3벳/콜/폴드 결정. 상대 레인지가 강하니 좁게, 대신 포지션(IP)이 있어 콜도 섞는다.",
    raiseLabel: "3벳 7.5bb",
    raise: "QQ+, JJ:0.4, AKs, AQs:0.5, AKo:0.8, A5s:0.5, A4s:0.4, KQs:0.3, K9s:0.15, 76s:0.15, 65s:0.15",
    call:
      "JJ:0.6, TT-66, 55:0.7, 44:0.5, 33:0.4, 22:0.4, AQs:0.5, AJs-ATs, A9s:0.5, A5s:0.3, A4s:0.3, KQs:0.7, KJs, KTs:0.7, QJs, QTs:0.6, JTs, J9s:0.3, T9s:0.8, 98s:0.6, 87s:0.5, 76s:0.4, 65s:0.3, AKo:0.2, AQo:0.7, AJo:0.3, KQo:0.5",
  },
  {
    id: "btn-vs-co",
    kind: "vsOpen",
    hero: "BTN",
    villain: "CO",
    title: "BTN vs CO 오픈",
    description: "CO가 2.5bb 오픈. 버튼에서 3벳/콜/폴드 결정. CO 레인지가 넓어서 3벳을 적극적으로 쓴다.",
    raiseLabel: "3벳 7.5bb",
    raise:
      "TT+, 99:0.5, AJs+, ATs:0.7, A9s:0.3, A5s:0.8, A4s:0.6, A3s:0.3, KJs+, KTs:0.6, K9s:0.3, QJs:0.6, QTs:0.4, JTs:0.4, J9s:0.2, T9s:0.3, 98s:0.2, 87s:0.2, 76s:0.2, 65s:0.2, AQo+, AJo:0.5, KQo:0.6, KJo:0.2",
    call:
      "99:0.5, 88-22, ATs:0.3, A9s:0.7, A8s-A6s:0.8, A4s:0.4, A3s:0.5, KTs:0.4, K9s:0.6, QTs:0.6, Q9s:0.6, JTs:0.6, J9s:0.6, T9s:0.7, T8s:0.5, 98s:0.7, 87s:0.6, 76s:0.6, 65s:0.5, 54s:0.4, AJo:0.4, ATo:0.3, KQo:0.4, KJo:0.4, QJo:0.3",
  },
  {
    id: "co-vs-hj",
    kind: "vsOpen",
    hero: "CO",
    villain: "HJ",
    title: "CO vs HJ 오픈",
    description: "HJ가 2.5bb 오픈. CO에서 3벳/콜/폴드 결정. 뒤에 버튼과 블라인드가 남아 있어서 콜보다 3벳 위주.",
    raiseLabel: "3벳 7.5bb",
    raise:
      "JJ+, TT:0.6, 99:0.3, AQs+, AJs:0.7, ATs:0.4, A5s:0.8, A4s:0.6, A3s:0.3, KQs:0.8, KJs:0.5, KTs:0.3, QJs:0.4, JTs:0.3, T9s:0.2, 98s:0.15, 76s:0.15, 65s:0.15, AKo, AQo:0.6, KQo:0.3",
    call:
      "TT:0.4, 99:0.7, 88-55, 44:0.6, 33:0.4, 22:0.4, AJs:0.3, ATs:0.6, A9s:0.4, KJs:0.5, KTs:0.6, QJs:0.6, QTs:0.6, JTs:0.7, J9s:0.3, T9s:0.6, 98s:0.5, 87s:0.4, AQo:0.4, AJo:0.3, KQo:0.4",
  },
  {
    id: "sb-vs-btn",
    kind: "vsOpen",
    hero: "SB",
    villain: "BTN",
    title: "SB vs BTN 오픈",
    description: "버튼이 2.5bb 오픈. SB에서 결정. 뒤에 BB가 남아 있고 포스트플랍에서 OOP라서 콜은 거의 안 하고 '3벳 아니면 폴드'.",
    raiseLabel: "3벳 11bb",
    raise:
      "88+, 77:0.7, 66:0.5, 55:0.3, A9s+, A8s:0.7, A7s:0.5, A6s:0.4, A5s-A3s, A2s:0.6, KTs+, K9s:0.7, K8s:0.3, QTs+, Q9s:0.5, JTs, J9s:0.5, T9s:0.7, T8s:0.3, 98s:0.6, 87s:0.5, 76s:0.5, 65s:0.4, 54s:0.3, ATo+, A9o:0.3, A5o:0.2, KJo+, KTo:0.4, QJo:0.5, JTo:0.2",
    call: "77:0.2, 66:0.3, 55:0.3, 44:0.3, 33:0.2, 22:0.2",
  },
];

function buildScenario(def: ScenarioDef): Scenario {
  const raiseRange = parseRange(def.raise);
  const callRange = parseRange(def.call ?? "");
  const strategy: Record<HandClass, HandStrategy> = {};
  for (const h of ALL_HANDS) {
    const raise = raiseRange[h] ?? 0;
    const call = Math.min(callRange[h] ?? 0, 1 - raise);
    strategy[h] = { raise, call, fold: Math.max(0, 1 - raise - call) };
  }
  return { ...def, strategy, raiseRange, callRange };
}

export const SCENARIOS: Scenario[] = DEFS.map(buildScenario);

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`없는 시나리오: ${id}`);
  return s;
}

export function actionLabel(scenario: Scenario, action: ActionKey): string {
  if (action === "fold") return "폴드";
  if (action === "call") return "콜";
  return scenario.kind === "rfi" ? "오픈" : "3벳";
}

export function scenarioActions(scenario: Scenario): ActionKey[] {
  return scenario.kind === "rfi" ? ["fold", "raise"] : ["fold", "call", "raise"];
}

/** Named villain ranges for the calculator, derived from the charts. */
export interface NamedRange {
  id: string;
  label: string;
  range: Range;
}

export const NAMED_RANGES: NamedRange[] = SCENARIOS.flatMap((s) => {
  const out: NamedRange[] = [];
  if (s.kind === "rfi") {
    out.push({ id: `${s.id}:raise`, label: `${s.hero} 오픈 레인지`, range: s.raiseRange });
  } else {
    out.push({ id: `${s.id}:raise`, label: `${s.hero} 3벳 레인지 (vs ${s.villain})`, range: s.raiseRange });
    if (s.call) out.push({ id: `${s.id}:call`, label: `${s.hero} 콜 레인지 (vs ${s.villain})`, range: s.callRange });
  }
  return out;
});
