import type { ChartSetDef, Scenario, ScenarioDef, StageDef } from "../charts";
import { ALL_HANDS, type HandClass } from "../../poker/cards";
import { parseRange, type Range } from "../../poker/range";
import { PREFLOP_STAGE_FILES, PREFLOP_STAGE_META } from "./preflopIndex";
import type { PreflopFlag, PreflopFlagCode, PreflopScenario, PreflopStage, PreflopStageMeta } from "./preflopTypes";

/**
 * 솔버 프리플랍: the chart set built from our own 9-handed preflop solver (src/poker/preflop; the data is generated
 * by scripts/make-preflop.mjs into preflopIndex.ts and one file per stage under preflopStages/). This file only adapts
 * the generated data to the app's ChartSetDef (design §6.3, §6.7): every range, frequency and text of a spot comes
 * from the data unchanged.
 *
 * What it adds on top of the data:
 *  - reachRange: the hero's own reach at a spot deep in a line, ρ(h) = Π of the frequencies of the hero's earlier
 *    actions named in `reachFrom`. Those are the snapped values the earlier charts show (a hand's actions sum to
 *    at most 1, so buildScenario's "earlier action takes first" fill keeps them as written), so the dimmed cells
 *    and the reach-relative totals are exactly what the earlier charts imply. A spot where the hero acts for the
 *    first time gets no reachRange: every hand gets there, as in the hand-made sets.
 *  - weight = min(occ, 5): quiz picks follow how often a spot comes up (occ is % of dealt hands), capped so the
 *    first-in and vs-open spots, which all come up often, are drawn about equally often. A cold spot behind a 3-bet
 *    in a stage of 55bb or more gets weight 0: the tree lets that seat only fold or jam, which is not how anyone
 *    plays 55–100bb deep (a real cold 4-bet is small), so its answers (fold QQ, jam A4s) must not be drilled. The
 *    charts page still shows it, with its "트리 제약" note.
 *  - noFold for the BB facing an SB limp, which checks instead of folding (its last action is 체크).
 *  - heroFilter: a kind group holds up to 72 spots per stage, which a phone cannot show without the seat row.
 *  - close: the data's close string decoded to legend keys per marked hand (§6.9), and the stage's closeEps.
 *  - flags as written, and quizSkip (§6.10): the quiz never deals a flag's `hands`, nor the `vs` of PF-SANITY-9 and
 *    -14, where both sides of the comparison are distorted. The `vs` of -11 and -13 stay in the quiz: TT–77 there are
 *    mostly ties, and AA's small 4-bet is the line §8 recommends. `cautionLines` and `flagLines` give the Korean
 *    caution of each flag, with the chart's own numbers, and `cautionFacts` the coach's lines about them.
 *  - `quizCloseActions` and `bigPairCloseNote`: the close-call set the quiz accepts (no AA/KK passive tie) and the
 *    caveat under such a tie (§6.8, §8 "More KK flats").
 *  - sens: the data's model-sensitive cells (§6.6) decoded like close, per marked hand the legend keys of its set.
 *
 * Loading (docs §6.3): the index (every stage's metadata: label, stack, description, tree) loads with the app; each
 * stage's scenarios are a separate chunk (the index's PREFLOP_STAGE_FILES), fetched on first use by loadSolverStageData, and the set
 * definition (solverSetDef) is built only once every stage is in. charts.ts's loadSolver / loadSolverStage / useSolver
 * are the app's entry points. Building every stage's spots costs about 120 ms and 15 MB in Node (docs §6.3), which an
 * app start on another set should not pay.
 */

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/** Quiz pick weight cap, in % of dealt hands (see above). */
const WEIGHT_CAP = 5;
/** From this stack on, the fold-or-jam cold spots are left out of the quiz (see above). */
const COLD_QUIZ_MAX_STACK = 55;

/** A cold spot behind a 3-bet (decision 1): kind vs3bet with a generic id; the fixed vs3bet ids are "-open-vs-". */
export const isColdSpot = (sc: Pick<PreflopScenario, "kind" | "id">) => sc.kind === "vs3bet" && sc.id.includes("-at-");

/** The quiz pick weight of a spot (see above). */
export function quizWeight(sc: PreflopScenario, stack: number): number {
  return isColdSpot(sc) && stack >= COLD_QUIZ_MAX_STACK ? 0 : Math.min(sc.occ, WEIGHT_CAP);
}

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

/** The legend keys of a scenario: its actions in order, then fold unless noFold (the bit order of `close`). */
const legendKeys = (sc: PreflopScenario) => [...sc.actions.map((a) => a.key), ...(sc.noFold ? [] : ["fold"])];

/** A close or sens string decoded: per marked hand, the legend keys of its set bits, in legend order. */
function decodeMarks(sc: PreflopScenario, text: string | undefined): Partial<Record<HandClass, string[]>> | undefined {
  if (!text) return undefined;
  const keys = legendKeys(sc);
  const out: Partial<Record<HandClass, string[]>> = {};
  ALL_HANDS.forEach((h, i) => {
    const ch = text[i];
    if (ch === undefined || ch === ".") return;
    const mask = parseInt(ch, 16);
    out[h] = keys.filter((_, j) => mask & (1 << j));
  });
  return out;
}

/** The flags whose `vs` the quiz also skips: both sides of their comparison are distorted (§8). */
const SKIP_VS: ReadonlySet<PreflopFlagCode> = new Set(["PF-SANITY-9", "PF-SANITY-14"]);

/** The hands of a flag's range string (every value 1). */
const handsOf = (text: string | undefined): HandClass[] => (text ? Object.keys(parseRange(text)) : []);

function quizSkipOf(flags: PreflopFlag[] | undefined): Partial<Record<HandClass, true>> | undefined {
  if (!flags?.length) return undefined;
  const out: Partial<Record<HandClass, true>> = {};
  for (const f of flags) for (const h of [...handsOf(f.hands), ...(SKIP_VS.has(f.code) ? handsOf(f.vs) : [])]) out[h] = true;
  return out;
}

function scenario(sc: PreflopScenario, reach: Map<string, Range>, stack: number): ScenarioDef {
  const reachRange = reach.get(sc.id);
  const close = decodeMarks(sc, sc.close);
  const sens = decodeMarks(sc, sc.sens);
  const quizSkip = quizSkipOf(sc.flags);
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
    weight: quizWeight(sc, stack),
    ...(close ? { close } : {}),
    ...(sens ? { sens } : {}),
    ...(sc.flags?.length ? { flags: sc.flags } : {}),
    ...(quizSkip ? { quizSkip } : {}),
  };
}

/** A stage's label, stack text and description as the app shows them, from its metadata alone. */
export function stageInfo(st: PreflopStageMeta): Omit<StageDef, "scenarios"> {
  const stack = `모두 ${st.stack}bb`;
  // The charts page and the coach facts print `stack` right before the description ("모두 100bb · …"), and the
  // generated description opens with the same words, so they are dropped here instead of showing twice.
  const description = st.description.startsWith(`${stack}. `) ? st.description.slice(stack.length + 2) : st.description;
  // The depth row's size label: the generated label is "<stack>bb · <size>" (export.ts's STAGE_LABELS).
  const depthPrefix = `${st.stack}bb · `;
  const sizeLabel = st.label.startsWith(depthPrefix) ? st.label.slice(depthPrefix.length) : st.label;
  return {
    id: st.id,
    label: st.label,
    stack,
    description,
    ...(st.closeEps !== undefined ? { closeEps: st.closeEps } : {}),
    depth: st.stack,
    sizeLabel,
  };
}

function stage(st: PreflopStage): StageDef {
  const reach = stageReach(st);
  return { ...stageInfo(st), scenarios: st.scenarios.map((sc) => scenario(sc, reach, st.stack)) };
}

export const SOLVER_ID = "solver";
export const SOLVER_LABEL = "솔버 프리플랍 (9인·BB 앤티)";

/** Every shipped stage's id, in chart order (from the index: nothing is loaded). */
export const SOLVER_STAGE_IDS: readonly string[] = PREFLOP_STAGE_META.map((st) => st.id);

const stageData = new Map<string, PreflopStage>();
const stagePending = new Map<string, Promise<PreflopStage>>();

/** Loads one stage's data file (once; later calls get the same promise or the loaded stage). */
export function loadSolverStageData(id: string): Promise<PreflopStage> {
  const done = stageData.get(id);
  if (done) return Promise.resolve(done);
  let p = stagePending.get(id);
  if (!p) {
    // The index's literal dynamic imports: one chunk per stage file (docs §6.3).
    const file = Object.hasOwn(PREFLOP_STAGE_FILES, id) ? PREFLOP_STAGE_FILES[id] : undefined;
    if (!file || !SOLVER_STAGE_IDS.includes(id)) return Promise.reject(new Error(`no solver stage ${id}`));
    p = file().then(
      ({ default: st }) => {
        if (st.id !== id) throw new Error(`preflopStages/${id}.ts holds stage ${st.id}`);
        stageData.set(id, st);
        stagePending.delete(id);
        return st;
      },
      (e: unknown) => {
        // A failed fetch (offline before the chunk was cached) may be retried.
        stagePending.delete(id);
        throw e;
      },
    );
    stagePending.set(id, p);
  }
  return p;
}

/** A loaded stage's data, or undefined. */
export function solverStageData(id: string): PreflopStage | undefined {
  return stageData.get(id);
}

/** The ids of the stages whose data is loaded, in chart order (tests: nothing but a solver screen loads them). */
export function solverStagesLoaded(): string[] {
  return SOLVER_STAGE_IDS.filter((id) => stageData.has(id));
}

const stageDefs = new Map<string, StageDef>();

/** One loaded stage as the app's StageDef (built once), or undefined while its data is not loaded. */
export function solverStageDef(id: string): StageDef | undefined {
  let def = stageDefs.get(id);
  if (!def) {
    const st = stageData.get(id);
    if (!st) return undefined;
    stageDefs.set(id, (def = stage(st)));
  }
  return def;
}

/** The solver set without its stages: label, game line, source text and seats, from the index alone. */
export function solverSetInfo(): Omit<ChartSetDef, "stages"> {
  // After the cold4 fallback (§2.8), or by its preset, a stage has no cold jam behind a 3-bet: the cold seat only
  // folds there. A push/fold stage has no 3-bet at all.
  const noColdJam = PREFLOP_STAGE_META.filter((st) => st.tree.cold4 === "none" && st.tree.mode !== "pushfold").map((st) => st.label);
  const COLD_TEXT =
    "3벳 뒤에 처음 액션하는 자리는 폴드나 올인만 해요 (콜드콜·작은 콜드 4벳 없음)." +
    (noColdJam.length ? ` ${noColdJam.join("·")}에서는 그 자리가 폴드만 해요.` : "");
  const pushFold = PREFLOP_STAGE_META.filter((st) => st.tree.mode === "pushfold").map((st) => `${st.stack}bb`);
  const PUSH_TEXT = pushFold.length ? ` ${pushFold.join("·")}는 푸시/폴드만 하는 구간이라 실현율 모델 없이 올인 승률로만 계산했어요.` : "";
  return {
    id: SOLVER_ID,
    label: SOLVER_LABEL,
    game: "홀덤펍 토너먼트 · 9인 · BB 앤티 1bb · 모두 같은 스택 · 칩EV (ICM 미반영)",
    source:
      `이 앱이 직접 만든 9인 프리플랍 솔버(DCFR)의 계산값이에요 (scripts/make-preflop.mjs). 상용 차트나 다른 솔버 결과는 쓰지 않았어요. 플랍 이후는 풀지 않고, 우리 포스트플랍 솔버 팩(BTN vs BB)에서 잰 에퀴티 실현율 모델로 근사했어요.${PUSH_TEXT} 콜드콜·오버콜·스퀴즈가 있고, 플랍은 3명까지 봐요 (BB가 오버콜하면 4명). ${COLD_TEXT} 올인은 늘 두 명만 붙어요: 누가 콜하면 뒤 사람은 폴드해요. 멀티웨이 팟, 3벳·4벳 팟, IP 콜러의 실현율은 아직 보정 전 가정값이라 시나리오마다 신뢰도를 붙였어요. 아주 드문 라인(전체 판의 0.1~1% 미만)은 차트에서 뺐어요. 모두 같은 스택, ICM 미반영.`,
    positions: POS,
    heroFilter: true,
  };
}

let solverDef: ChartSetDef | null = null;

/** Whether solverSetDef has built the set (tests: nothing but a use of the solver set may build it). */
export function solverSetDefBuilt(): boolean {
  return solverDef !== null;
}

/** The solver set's definition, built on the first call once every stage is loaded; throws before that. */
export function solverSetDef(): ChartSetDef {
  if (solverDef) return solverDef;
  const missing = SOLVER_STAGE_IDS.filter((id) => !stageData.has(id));
  if (missing.length) throw new Error(`solver stages not loaded: ${missing.join(", ")} (await loadSolver() first)`);
  solverDef = { ...solverSetInfo(), stages: SOLVER_STAGE_IDS.map((id) => solverStageDef(id)!) };
  return solverDef;
}

// ───────────── cautions of the artifact flags (§6.10) ─────────────

/** "Raise" for the flags (export.ts's rules): every raise or jam key; the others (call, overcall, limp, check) call. */
export const RAISE_KEYS: ReadonlySet<string> = new Set(["open", "raise", "3bet", "squeeze", "4bet", "shove"]);
/** The raise keys as the action buttons name them, for PF-SANITY-12's caution. */
const RAISE_WORD: Record<string, string> = { "4bet": "4벳", shove: "올인", raise: "레이즈", "3bet": "3벳", squeeze: "스퀴즈", open: "오픈" };
/** The rules' hand lists, in the order that breaks ties in the examples. */
const LOW_SUITED_CONNECTORS = ["43s", "54s", "65s", "53s", "64s"], SUITED_WHEEL_ACES = ["A5s", "A4s", "A3s", "A2s"];
const BIG_PAIRS = ["AA", "KK", "QQ", "JJ"], MID_PAIRS = ["TT", "99", "88", "77"], JAM_PAIRS = ["AA", "KK", "QQ", "JJ", "TT", "99"];
const HIGH_OFFSUIT_ACES = ["A9o", "A8o", "A7o", "A6o"], LOW_OFFSUIT_ACES = ["A4o", "A3o", "A2o"];

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The first hand of `list` with the largest f (ties go to the earlier hand), or undefined for an empty list. */
const argmax = (list: string[], f: (h: string) => number) => list.reduce<string | undefined>((b, h) => (b === undefined || f(h) > f(b) ? h : b), undefined);

/** The first (a, b) pair of `pairs`, in order, with the largest gap; undefined if there is none. */
function widest(pairs: [string, string][], gap: (a: string, b: string) => number): [string, string] | undefined {
  let best: [string, string] | undefined;
  for (const p of pairs) if (!best || gap(...p) > gap(...best)) best = p;
  return best;
}

/** The caution of one flag on spot `s`, with the chart's own numbers (percentages of the chart's tenths). */
function cautionLine(s: Scenario, f: PreflopFlag): string {
  const H = new Set(handsOf(f.hands)), V = new Set(handsOf(f.vs));
  const keys = s.actions.map((a) => a.key);
  const sum = (h: string, ks: string[]) => ks.reduce((x, k) => x + (s.strategy[h]?.[k] ?? 0), 0);
  const raise = (h: string) => sum(h, keys.filter((k) => RAISE_KEYS.has(k)));
  const call = (h: string) => sum(h, keys.filter((k) => !RAISE_KEYS.has(k)));
  const plays = (h: string) => 1 - (s.strategy[h]?.fold ?? 1);
  const inH = (list: string[]) => list.filter((h) => H.has(h)), inV = (list: string[]) => list.filter((h) => V.has(h));
  const eg = (text: string | null) => (text ? ` (예: ${text})` : "");
  switch (f.code) {
    case "PF-SANITY-9": {
      const r = (h: string) => sum(h, keys.filter((k) => k === "3bet" || k === "squeeze" || k === "shove"));
      const a = argmax(inH(LOW_SUITED_CONNECTORS), r), b = argmax(inV(SUITED_WHEEL_ACES), r);
      return `낮은 수딧 커넥터를 휠 에이스보다 더 많이 3벳해요${eg(a && b ? `${a} 3벳 ${pct(r(a))}, ${b} 3벳 ${pct(r(b))}` : null)}. 모델이 3벳한 핸드의 실현율을 상대 레인지와 상관없이 매겨서 생기는 알려진 한계예요.`;
    }
    case "PF-SANITY-11": {
      const verb = s.kind === "squeeze" ? "스퀴즈" : "3벳";
      const a = argmax(inH(BIG_PAIRS), (h) => -raise(h)), b = argmax(inV(MID_PAIRS), raise);
      return `더 높은 페어를 덜 ${verb}하는 칸이 있어요${eg(a && b ? `${a} ${verb} ${pct(raise(a))}, ${b} ${verb} ${pct(raise(b))}` : null)}. 3벳 뒤 콜드콜이 없는 트리 단순화 탓으로 보이는 알려진 한계예요.`;
    }
    case "PF-SANITY-12": {
      const hs = inH(["AA", "KK"]);
      // The raises by their button words (4벳, 올인), as the legend shows them.
      const raises = [...new Set(keys.filter((k) => RAISE_KEYS.has(k)).map((k) => RAISE_WORD[k] ?? "레이즈"))].join("·");
      return `${hs.join("·")}는 ${s.kind === "vs4bet" ? "4벳" : "3벳"}에 ${raises}보다 콜을 더 많이 해요 (${hs.map((h) => `${h} 콜 ${pct(call(h))}`).join(", ")}). 모델이 큰 페어의 콜 실현율을 높게 잡아서 생기는 알려진 한계예요.`;
    }
    case "PF-SANITY-13": {
      const jam = (h: string) => s.strategy[h]?.shove ?? 0;
      const higher = JAM_PAIRS.filter((h) => H.has(h) || V.has(h));
      const pairs: [string, string][] = [];
      for (const lo of inH(JAM_PAIRS))
        for (const hi of higher) if (JAM_PAIRS.indexOf(hi) < JAM_PAIRS.indexOf(lo) && jam(lo) >= jam(hi) + 0.5 - 1e-9) pairs.push([lo, hi]);
      const p = widest(pairs, (lo, hi) => jam(lo) - jam(hi));
      return `더 낮은 페어가 4벳 올인을 더 많이 하는 칸이 있어요${eg(p ? `${p[0]} 올인 ${pct(jam(p[0]))}, ${p[1]} 올인 ${pct(jam(p[1]))}` : null)}. 모델의 낮은 SPR 가정 탓으로 보이는 알려진 한계예요. 올인과 작은 4벳 중에 고민되면 작은 4벳을 권해요.`;
    }
    case "PF-SANITY-14": {
      const pairs: [string, string][] = [];
      for (const a of inH(HIGH_OFFSUIT_ACES)) for (const b of inV(LOW_OFFSUIT_ACES)) if (plays(a) <= plays(b) - 0.3 + 1e-9) pairs.push([a, b]);
      const p = widest(pairs, (a, b) => plays(b) - plays(a));
      return `킥커가 더 높은 오프수트 에이스를 덜 플레이하는 칸이 있어요${eg(p ? `${p[0]} ${pct(plays(p[0]))}, ${p[1]} ${pct(plays(p[1]))}` : null)}. 모델이 A2~A5에 같은 가산점을 줘서 생기는 알려진 한계예요.`;
    }
  }
}

/** The cautions of spot `s` (the charts page's "알려진 한계"), one per flag, in flag order; [] without flags. */
export function cautionLines(s: Scenario): string[] {
  return (s.flags ?? []).map((f) => cautionLine(s, f));
}

/** The cautions of the flags whose `hands` or `vs` contain h (the hand card). */
export function flagLines(s: Scenario, h: HandClass): string[] {
  return (s.flags ?? []).filter((f) => handsOf(f.hands).includes(h) || handsOf(f.vs).includes(h)).map((f) => cautionLine(s, f));
}

/** The coach's line after a caution whose artifact cells hold the hand: its `hands`, or the `vs` of -9 and -14. */
export const ARTIFACT_CELL_FACT = "이 핸드는 위 모델 한계에 해당하는 칸이에요.";
/** The coach's line after a caution that only compares against the hand: the `vs` of -11 and -13, which the quiz
 *  drills (TT–77 against opens, AA's small 4-bet). */
export const COMPARISON_FACT = "이 핸드는 위 한계의 비교 대상이에요.";

/**
 * The coach facts of spot s's cautions for hand h (docs §6.8): "모델 한계: {caution}" for every flag of the spot (`all`,
 * the charts page) or only for the flags whose `hands` or `vs` hold h (the quiz), each followed by what h is to it:
 * ARTIFACT_CELL_FACT for one of its artifact cells (`hands`, or the `vs` of -9 and -14: the cells the quiz never deals),
 * COMPARISON_FACT for a kept comparison hand (the `vs` of -11 and -13), nothing when h is in neither.
 */
export function cautionFacts(s: Scenario, h: HandClass, all = false): string[] {
  const out: string[] = [];
  for (const f of s.flags ?? []) {
    const inHands = handsOf(f.hands).includes(h), inVs = handsOf(f.vs).includes(h);
    if (!all && !inHands && !inVs) continue;
    out.push(`모델 한계: ${cautionLine(s, f)}`);
    if (inHands || (inVs && SKIP_VS.has(f.code))) out.push(ARTIFACT_CELL_FACT);
    else if (inVs) out.push(COMPARISON_FACT);
  }
  return out;
}

// ───────────── AA and KK close calls with a passive action (§6.8, §8 "More KK flats") ─────────────

const BIG_PAIRS_CLOSE: ReadonlySet<string> = new Set(["AA", "KK"]);
/** A passive key of a near set: not a raise and not the fold. */
const isPassive = (k: string) => k !== "fold" && !RAISE_KEYS.has(k);

/**
 * The close-call set the quiz accepts for hand h (docs §6.8): closeActions, except that for AA and KK a passive action
 * (call, overcall, limp, check) other than the chart's own is left out. Those ties rest on the pair-rank slope that
 * makes the big pairs realize well as callers (§8 "More KK flats", the cause PF-SANITY-12 flags), so the quiz does not
 * call a KK flat "괜찮아요" next to a chart that 3-bets it. undefined when fewer than two actions remain.
 */
export function quizCloseActions(s: Scenario, h: HandClass): string[] | undefined {
  const keys = s.close?.[h];
  if (!keys || !BIG_PAIRS_CLOSE.has(h)) return keys;
  const st = s.strategy[h];
  const kept = keys.filter((k) => !isPassive(k) || (st?.[k] ?? 0) >= 0.999);
  return kept.length >= 2 ? kept : undefined;
}

/**
 * The caveat under an AA or KK close mark whose near set holds a passive action (the hand card and the quiz), or null:
 * the model over-rates the big pairs' realization as callers (§8 "More KK flats").
 */
export function bigPairCloseNote(s: Scenario, h: HandClass): string | null {
  const keys = s.close?.[h];
  if (!BIG_PAIRS_CLOSE.has(h) || !keys?.some(isPassive)) return null;
  const raise = keys.find((k) => RAISE_KEYS.has(k));
  return `모델이 큰 페어의 콜 실현율을 높게 잡는 알려진 한계가 있어서, 실전에서는 ${(raise && RAISE_WORD[raise]) ?? "레이즈"} 쪽이 더 나을 수 있어요.`;
}
