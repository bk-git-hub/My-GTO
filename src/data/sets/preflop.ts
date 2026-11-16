import type { ChartSetDef, ScenarioDef, StageDef } from "../charts";
import { ALL_HANDS } from "../../poker/cards";
import { parseRange, type Range } from "../../poker/range";
import { PREFLOP_STAGES } from "./preflopData";
import type { PreflopScenario, PreflopStage } from "./preflopTypes";

/**
 * 솔버 프리플랍: the chart set built from our own 9-handed preflop solver (src/poker/preflop; the data is generated
 * by scripts/make-preflop.mjs into preflopData.ts). This file only adapts the generated data to the app's
 * ChartSetDef (design §6.3, §6.7): every range, frequency and text of a spot comes from the data unchanged.
 *
 * What it adds on top of the data:
 *  - reachRange: the hero's own reach at a spot deep in a line, ρ(h) = Π of the frequencies of the hero's earlier
 *    actions named in `reachFrom`. Those are the snapped values the earlier charts show (a hand's actions sum to
 *    at most 1, so buildScenario's "earlier action takes first" fill keeps them as written), so the dimmed cells
 *    and the reach-relative totals are exactly what the earlier charts imply. A spot where the hero acts for the
 *    first time gets no reachRange: every hand gets there, as in the hand-made sets.
 *  - weight = min(occ, 5): quiz picks follow how often a spot comes up (occ is % of dealt hands), capped so the
 *    first-in and vs-open spots, which all come up often, are drawn about equally often.
 *  - noFold for the BB facing an SB limp, which checks instead of folding (its last action is 체크).
 *  - heroFilter: a kind group holds up to 72 spots per stage, which a phone cannot show without the seat row.
 */

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/** Quiz pick weight cap, in % of dealt hands (see above). */
const WEIGHT_CAP = 5;

/**
 * The hero's reach per hand at each spot of `stage` that has `reachFrom`, by scenario id. Only hands that get
 * there are listed (reachOf reads a missing hand as 0). A reference to an action the stage does not export gives
 * reach 0 rather than throwing: this module loads with charts.ts, so a throw would take every page of the app
 * down, and the data tests (src/data/preflopData.test.ts, PF-DATA-1) already reject such data.
 */
export function stageReach(stage: PreflopStage): Map<string, Range> {
  const parsed = new Map<string, Range>();
  for (const sc of stage.scenarios) for (const a of sc.actions) parsed.set(`${sc.id}:${a.key}`, parseRange(a.range));
  const out = new Map<string, Range>();
  for (const sc of stage.scenarios) {
    if (!sc.reachFrom?.length) continue;
    const refs = sc.reachFrom.map((ref) => parsed.get(ref));
    const reach: Range = {};
    for (const h of ALL_HANDS) {
      let rho = 1;
      for (const r of refs) rho *= r?.[h] ?? 0;
      if (rho > 0) reach[h] = rho;
    }
    out.set(sc.id, reach);
  }
  return out;
}

function scenario(sc: PreflopScenario, reach: Map<string, Range>): ScenarioDef {
  const reachRange = reach.get(sc.id);
  return {
    id: sc.id,
    kind: sc.kind,
    hero: sc.hero,
    ...(sc.villain ? { villain: sc.villain } : {}),
    ...(sc.villainSeats ? { villainSeats: sc.villainSeats } : {}),
    chip: sc.chip,
    title: sc.title,
    description: sc.description,
    actions: sc.actions,
    ...(reachRange ? { reachRange } : {}),
    ...(sc.noFold ? { noFold: true } : {}),
    weight: Math.min(sc.occ, WEIGHT_CAP),
  };
}

function stage(st: PreflopStage): StageDef {
  const reach = stageReach(st);
  return {
    id: st.id,
    label: st.label,
    stack: `모두 ${st.stack}bb`,
    description: st.description,
    scenarios: st.scenarios.map((sc) => scenario(sc, reach)),
  };
}

export const SOLVER: ChartSetDef = {
  id: "solver",
  label: "솔버 프리플랍 (9인·BB 앤티)",
  game: "홀덤펍 토너먼트 · 9인 · BB 앤티 1bb · 모두 같은 스택 · 칩EV (ICM 미반영)",
  source:
    "이 앱이 직접 만든 9인 프리플랍 솔버(DCFR)의 계산값이에요 (scripts/make-preflop.mjs). 상용 차트나 다른 솔버 결과는 쓰지 않았어요. 플랍 이후는 풀지 않고, 우리 포스트플랍 솔버 팩(BTN vs BB)에서 잰 에퀴티 실현율 모델로 근사했어요. 콜드콜·오버콜·스퀴즈가 있고, 플랍은 3명까지 봐요 (BB가 오버콜하면 4명). 3벳 뒤에 처음 액션하는 자리는 폴드나 올인만 해요 (콜드콜·작은 콜드 4벳 없음). 올인은 늘 두 명만 붙어요: 누가 콜하면 뒤 사람은 폴드해요. 멀티웨이 팟, 3벳·4벳 팟, IP 콜러의 실현율은 아직 보정 전 가정값이라 시나리오마다 신뢰도를 붙였어요. 아주 드문 라인(전체 판의 0.1~1% 미만)은 차트에서 뺐어요. 모두 같은 스택, ICM 미반영.",
  positions: POS,
  heroFilter: true,
  stages: PREFLOP_STAGES.map(stage),
};
