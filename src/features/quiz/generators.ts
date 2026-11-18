import {
  ALL_HANDS,
  GRID_RANKS,
  cardLabel,
  combosOf,
  fullDeck,
  gridHand,
  randomCombo,
  shuffle,
  type Card,
  type HandClass,
} from "../../poker/cards";
import { countOuts, equityVsHand } from "../../poker/equity";
import { categoryName, evaluate } from "../../poker/evaluator";
import { bluffBreakEven, callEV, hitChance, mdf, requiredEquity, ruleOf2and4 } from "../../poker/odds";
import { allScenarios, getSet, inReach, reachOf, type Scenario, type StageDef } from "../../data/charts";
import { quizCloseActions } from "../../data/sets/preflop";

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const fmtPct = (x: number) => `${Math.round(x * 100)}%`;
const fmtBB = (x: number) => `${Number.isInteger(x) ? x : x.toFixed(1)}bb`;
const round1 = (x: number) => Math.round(x * 10) / 10;

// ───────────────────────── Preflop quiz ─────────────────────────

export interface PreflopQuestion {
  uid: string;
  scenario: Scenario;
  hand: HandClass;
  cards: [Card, Card];
}

function neighbors(h: HandClass): HandClass[] {
  const idx = ALL_HANDS.indexOf(h);
  const r = Math.floor(idx / 13);
  const c = idx % 13;
  const out: HandClass[] = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 13 && cc >= 0 && cc < 13) out.push(gridHand(rr, cc));
  }
  return out;
}

/**
 * The action a hand "doesn't play" with: fold, or where the hero cannot fold (the BB checking behind an SB limp)
 * the last action, which takes every remaining hand there.
 */
function passiveKey(s: Scenario): string {
  return s.noFold && s.actions.length ? s.actions[s.actions.length - 1].key : "fold";
}

/**
 * Weight hands toward the interesting ones: mixed, near the range edge. Only hands that reach the spot count as
 * neighbors: the edge of the reaching range itself (say, the opening range in a vs-3-bet chart) is not a decision
 * made here.
 */
function handWeight(s: Scenario, h: HandClass): number {
  const st = s.strategy[h];
  const max = Math.max(...Object.values(st));
  if (max < 0.999) return 3;
  const passive = passiveKey(s);
  const plays = (st[passive] ?? 0) < 0.999;
  const edge = neighbors(h).some((n) => inReach(s, n) && ((s.strategy[n][passive] ?? 0) < 0.999) !== plays);
  if (edge) return 2;
  return plays ? 0.6 : 0.15;
}

/**
 * An index drawn with probability proportional to weights[i], from one Math.random() call. Weights that are not
 * positive never come up; if none is positive, every index is equally likely. With all weights 1 it returns
 * floor(r·n), exactly pick's index (subtracting 1 from a float is exact here), so a pool without weights draws
 * the same sequence as before weights existed.
 */
function weightedIndex(weights: number[]): number {
  const w = weights.map((x) => (x > 0 ? x : 0));
  const total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return Math.floor(Math.random() * weights.length);
  let x = Math.random() * total;
  let last = 0;
  for (let i = 0; i < w.length; i++) {
    if (!(w[i] > 0)) continue;
    if (x < w[i]) return i;
    x -= w[i];
    last = i;
  }
  return last; // rounding left x at or past the total: the last index that can come up
}

/** filter: "all" | "stage:<stageId>" | full scenario id */
export function quizPool(setId: string, filter: string): Scenario[] {
  const set = getSet(setId);
  if (filter.startsWith("stage:")) {
    const st = set.stages.find((x) => x.id === filter.slice(6));
    if (st) return st.scenarios;
  }
  const one = allScenarios(set).find((x) => x.id === filter);
  return one ? [one] : allScenarios(set);
}

/**
 * A hand drawn toward the edges of the scenario's ranges, times the hero's reach (reachRange): a hand that never
 * gets here is never dealt, and one that rarely does comes up rarely. Hands in quizSkip (the solver set's flagged
 * artifact cells, docs §6.10) are never dealt, unless they are all the spot has. Without reachRange and quizSkip
 * every hand keeps its weight (times 1, exactly), and the loop below draws exactly as it always has.
 */
export function weightedHand(scenario: Scenario): HandClass {
  const skip = scenario.quizSkip;
  let weights = ALL_HANDS.map((h) => handWeight(scenario, h) * reachOf(scenario, h) * (skip?.[h] ? 0 : 1));
  let total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0) && skip) {
    weights = ALL_HANDS.map((h) => handWeight(scenario, h) * reachOf(scenario, h));
    total = weights.reduce((a, b) => a + b, 0);
  }
  // Nothing reaches the spot (broken data): any hand beats a crash.
  if (!(total > 0)) return ALL_HANDS[Math.floor(Math.random() * ALL_HANDS.length)];
  let x = Math.random() * total;
  let last: HandClass = ALL_HANDS[ALL_HANDS.length - 1];
  for (let i = 0; i < ALL_HANDS.length; i++) {
    if (!(weights[i] > 0)) continue;
    last = ALL_HANDS[i];
    x -= weights[i];
    if (x <= 0) return last;
  }
  return last;
}

/** A scenario of the pool, drawn by weight (1 by default; the solver set favours the spots that come up often). */
export function pickScenario(pool: Scenario[]): Scenario {
  return pool[weightedIndex(pool.map((s) => s.weight ?? 1))];
}

export function generatePreflop(setId: string, filter = "all"): PreflopQuestion {
  const scenario = pickScenario(quizPool(setId, filter));
  const hand = weightedHand(scenario);
  return { uid: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, scenario, hand, cards: randomCombo(hand) };
}

export type Grade = "correct" | "close" | "mixed" | "wrong";

/** The chart frequency from which a non-best action grades "부분 정답 (혼합 빈도)": the hand-made sets' value. */
export const MIXED_MIN = 0.2;
/**
 * The solver set's (docs §6.8): half its data's 0.1 grid, so every action its chart plays (a tenth or more; buildScenario
 * can give 0.09999…) grades at least "부분 정답". An equilibrium mixes only near-indifferent actions, and next to a 0%
 * close-call action graded "정답 (EV 거의 같음)", a 10% action graded 오답 would contradict the chart.
 */
export const SOLVER_MIXED_MIN = 0.05;

/**
 * Grade by how often the chart takes the chosen action. `near`: the cell is a close call (the solver set, docs §6.9)
 * and the chosen action is in its set, so an action the chart does not take is "close" (정답, EV 거의 같음), which
 * counts as correct. `mixedMin`: see MIXED_MIN. With the defaults the grades are as they always were.
 */
export function gradePreflop(freq: number, best: number, near = false, mixedMin = MIXED_MIN): Grade {
  if (freq >= 0.5 || (freq > 0 && freq >= best - 0.001)) return "correct";
  if (near) return "close";
  if (freq >= mixedMin) return "mixed";
  return "wrong";
}

/** The mixed floor of a stage's quiz: SOLVER_MIXED_MIN where the stage carries close calls (the solver set). */
export const quizMixedMin = (stage: Pick<StageDef, "closeEps">) => (stage.closeEps !== undefined ? SOLVER_MIXED_MIN : MIXED_MIN);

/**
 * The preflop quiz's grade of answer `key` with hand h at spot s (QuizPage): gradePreflop on the chart's frequency,
 * with the close-call set the quiz accepts (quizCloseActions: closeActions without an AA or KK passive tie) and the
 * stage's mixed floor (quizMixedMin). The hand-made sets have neither close calls nor closeEps, so they grade as before.
 */
export function gradeAnswer(s: Scenario, h: HandClass, key: string, mixedMin = MIXED_MIN): Grade {
  const st = s.strategy[h];
  const best = Math.max(...Object.values(st));
  return gradePreflop(st[key] ?? 0, best, quizCloseActions(s, h)?.includes(key) ?? false, mixedMin);
}

// ───────────────────────── Multiple-choice quizzes ─────────────────────────

export interface MCQuestion {
  uid: string;
  topic: string;
  prompt: string;
  /** Optional cards to render above the options. */
  hero?: Card[];
  villain?: Card[];
  board?: Card[];
  options: string[];
  answer: number;
  /** Step-by-step explanation shown after answering. */
  steps: string[];
  /** Facts handed to the AI coach. */
  facts: string;
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Build options from a correct value and candidate distractors (same formatter, all distinct). */
function buildOptions(correct: number, candidates: number[], fmt: (x: number) => string, spread: number) {
  const labels = new Set([fmt(correct)]);
  const values = [correct];
  for (const c of [...candidates, ...shuffle([1, -1, 2, -2, 3, -3]).map((k) => correct + k * spread)]) {
    if (values.length >= 4) break;
    if (!Number.isFinite(c)) continue;
    const l = fmt(c);
    if (labels.has(l)) continue;
    labels.add(l);
    values.push(c);
  }
  const order = shuffle(values.map((v, i) => ({ v, i })));
  return { options: order.map((o) => fmt(o.v)), answer: order.findIndex((o) => o.i === 0) };
}

const POTS = [4, 6, 8, 10, 12, 20, 30, 50, 100];
const BET_FRACTIONS = [0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.5, 2];
const clampPct = (x: number) => Math.min(0.99, Math.max(0.01, x));

function potAndBet() {
  const pot = pick(POTS);
  const frac = pick(BET_FRACTIONS);
  return { pot, bet: round1(pot * frac), frac };
}

const DRAWS: { name: string; outs: number }[] = [
  { name: "플러시 드로우", outs: 9 },
  { name: "양방 스트레이트 드로우", outs: 8 },
  { name: "거트샷(안쪽 스트레이트 드로우)", outs: 4 },
  { name: "플러시 + 양방 스트레이트 콤보 드로우", outs: 15 },
  { name: "플러시 드로우 + 거트샷", outs: 12 },
  { name: "오버카드 2장 (상대가 원페어일 때)", outs: 6 },
];

export function generateOdds(): MCQuestion {
  const kind = pick(["required", "required", "mdf", "bluff", "outs", "ev"] as const);

  if (kind === "required") {
    const { pot, bet } = potAndBet();
    const total = pot + bet * 2;
    const ans = requiredEquity(pot, bet);
    const { options, answer } = buildOptions(ans, [bet / pot, bet / (pot + bet), 1 - ans].map(clampPct), fmtPct, 0.07);
    return {
      uid: uid(),
      topic: "팟 오즈",
      prompt: `팟이 ${fmtBB(pot)}인데 상대가 ${fmtBB(bet)}를 베팅했어요. 콜하려면 최소 몇 %의 에퀴티가 필요할까요?`,
      options,
      answer,
      steps: [
        `내가 내야 하는 돈(콜 금액) = ${fmtBB(bet)}`,
        `콜하고 나면 전체 팟 = ${fmtBB(pot)} + ${fmtBB(bet)}(상대) + ${fmtBB(bet)}(나) = ${fmtBB(round1(total))}`,
        `필요 에퀴티 = ${fmtBB(bet)} ÷ ${fmtBB(round1(total))} = ${(ans * 100).toFixed(1)}%`,
        `→ 이 상황을 반복했을 때 ${(ans * 100).toFixed(0)}% 넘게 이기면 콜이 이득이에요.`,
      ],
      facts: `퀴즈 주제: 팟 오즈 / 필요 에퀴티\n팟: ${fmtBB(pot)}, 상대 베팅: ${fmtBB(bet)}\n정답: ${(ans * 100).toFixed(1)}%`,
    };
  }

  if (kind === "mdf") {
    const { pot, bet } = potAndBet();
    const ans = mdf(pot, bet);
    const { options, answer } = buildOptions(ans, [requiredEquity(pot, bet), bluffBreakEven(pot, bet), 1 - requiredEquity(pot, bet)].map(clampPct), fmtPct, 0.08);
    return {
      uid: uid(),
      topic: "MDF",
      prompt: `팟 ${fmtBB(pot)}에 상대가 ${fmtBB(bet)}를 베팅했어요. 상대가 아무 카드로나 블러프해서 이득을 보지 못하게 하려면, 내 레인지 중 최소 몇 %를 계속(콜/레이즈)해야 할까요? (MDF)`,
      options,
      answer,
      steps: [
        `MDF = 팟 ÷ (팟 + 상대 베팅)`,
        `= ${fmtBB(pot)} ÷ (${fmtBB(pot)} + ${fmtBB(bet)}) = ${(ans * 100).toFixed(1)}%`,
        `→ 상대 블러프가 성공하려면 내가 ${(100 - ans * 100).toFixed(0)}%보다 많이 폴드해야 해요. 그보다 적게 폴드하면 블러프가 손해예요.`,
      ],
      facts: `퀴즈 주제: MDF(최소 방어 빈도)\n팟: ${fmtBB(pot)}, 상대 베팅: ${fmtBB(bet)}\n정답: ${(ans * 100).toFixed(1)}%`,
    };
  }

  if (kind === "bluff") {
    const { pot, bet } = potAndBet();
    const ans = bluffBreakEven(pot, bet);
    const { options, answer } = buildOptions(ans, [requiredEquity(pot, bet), mdf(pot, bet), bet / pot].map(clampPct), fmtPct, 0.08);
    return {
      uid: uid(),
      topic: "블러프",
      prompt: `팟 ${fmtBB(pot)}에서 내가 ${fmtBB(bet)}로 블러프(이길 가능성 없는 핸드)를 하려고 해요. 상대가 몇 % 이상 폴드해야 이득일까요?`,
      options,
      answer,
      steps: [
        `블러프로 거는 돈 = ${fmtBB(bet)}, 성공하면 얻는 돈 = 팟 ${fmtBB(pot)}`,
        `필요 폴드율 = 베팅 ÷ (팟 + 베팅) = ${fmtBB(bet)} ÷ ${fmtBB(round1(pot + bet))} = ${(ans * 100).toFixed(1)}%`,
        `→ 상대가 ${(ans * 100).toFixed(0)}%보다 자주 폴드하면 블러프가 이득이에요.`,
      ],
      facts: `퀴즈 주제: 블러프 성공에 필요한 폴드율\n팟: ${fmtBB(pot)}, 내 베팅: ${fmtBB(bet)}\n정답: ${(ans * 100).toFixed(1)}%`,
    };
  }

  if (kind === "outs") {
    const d = pick(DRAWS);
    const street = pick(["flop", "turn"] as const);
    const cards = street === "flop" ? 2 : 1;
    const ans = hitChance(d.outs, cards);
    const approx = ruleOf2and4(d.outs, cards) / 100;
    const wrongRule = street === "flop" ? (d.outs * 2) / 100 : (d.outs * 4) / 100;
    const { options, answer } = buildOptions(ans, [wrongRule, d.outs / 100, ans * 1.6].map(clampPct), fmtPct, 0.06);
    const where = street === "flop" ? "플랍에서 리버까지(남은 카드 2장)" : "턴에서 리버까지(남은 카드 1장)";
    return {
      uid: uid(),
      topic: "아웃츠",
      prompt: `${d.name}예요 (아웃츠 ${d.outs}장). ${where} 완성될 확률은 대략 얼마일까요?`,
      options,
      answer,
      steps: [
        street === "flop"
          ? `4의 법칙: 아웃츠 × 4${d.outs > 8 ? ` − (아웃츠 − 8)` : ""} ≈ ${Math.round(approx * 100)}%`
          : `2의 법칙: 아웃츠 × 2 ≈ ${Math.round(approx * 100)}%`,
        street === "flop"
          ? `정확한 값: 1 − (못 맞출 확률) = 1 − (${47 - d.outs}/47 × ${46 - d.outs}/46) = ${(ans * 100).toFixed(1)}%`
          : `정확한 값: ${d.outs} ÷ 46 = ${(ans * 100).toFixed(1)}%`,
        `→ 실전에서는 법칙으로 빠르게 어림하고, 팟 오즈와 비교하면 돼요.`,
      ],
      facts: `퀴즈 주제: 아웃츠와 2-4 법칙\n드로우: ${d.name}, 아웃츠 ${d.outs}장\n${where}\n어림값 ${Math.round(approx * 100)}%, 정확값 ${(ans * 100).toFixed(1)}%`,
    };
  }

  // EV of a call
  const { pot, bet } = potAndBet();
  const need = requiredEquity(pot, bet);
  const eq = Math.round(clampPct(need + pick([-0.12, -0.07, -0.04, 0.04, 0.08, 0.15])) * 100) / 100;
  const ans = callEV(eq, pot, bet);
  const fmtEV = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(round1(x)).toFixed(1)}bb`;
  const { options, answer } = buildOptions(
    ans,
    [eq * pot - (1 - eq) * bet, eq * (pot + bet), -ans],
    fmtEV,
    Math.max(0.5, Math.abs(ans) * 0.6),
  );
  return {
    uid: uid(),
    topic: "기대값(EV)",
    prompt: `팟 ${fmtBB(pot)}, 상대 베팅 ${fmtBB(bet)}, 내 에퀴티는 ${Math.round(eq * 100)}%예요. 콜하면 폴드할 때보다 평균 얼마를 벌까요(잃을까요)?`,
    options,
    answer,
    steps: [
      `이기면 얻는 돈 = 팟 + 상대 베팅 = ${fmtBB(round1(pot + bet))}, 지면 잃는 돈 = 콜 금액 ${fmtBB(bet)}`,
      `EV = ${Math.round(eq * 100)}% × ${fmtBB(round1(pot + bet))} − ${Math.round((1 - eq) * 100)}% × ${fmtBB(bet)} = ${fmtEV(ans)}`,
      `필요 에퀴티는 ${(need * 100).toFixed(1)}%예요. 내 에퀴티(${Math.round(eq * 100)}%)가 ${eq >= need ? "더 높으니 콜이 이득" : "더 낮으니 콜은 손해"}이에요.`,
    ],
    facts: `퀴즈 주제: 콜의 기대값(EV)\n팟: ${fmtBB(pot)}, 상대 베팅: ${fmtBB(bet)}, 내 에퀴티: ${Math.round(eq * 100)}%\n필요 에퀴티: ${(need * 100).toFixed(1)}%\n정답 EV: ${fmtEV(ans)}`,
  };
}

// ───────────────────────── Equity quiz ─────────────────────────

const COMMON_HANDS: HandClass[] = (() => {
  const out: HandClass[] = [];
  for (const h of ALL_HANDS) {
    const hi = GRID_RANKS.indexOf(h[0]);
    const lo = GRID_RANKS.indexOf(h[1]);
    // pairs, suited hands with T+ or connected, offsuit broadways
    if (h.length === 2) out.push(h);
    else if (h[2] === "s" && (hi <= 4 || lo - hi <= 2)) out.push(h);
    else if (h[2] === "o" && lo <= 4) out.push(h);
  }
  return out;
})();

function equityOptions(eq: number) {
  const fmt = (x: number) => `${Math.round(x * 100)}%`;
  const cands = shuffle([0.12, -0.12, 0.22, -0.22, 0.32, -0.32])
    .map((d) => eq + d)
    .filter((x) => x > 0.02 && x < 0.98);
  return buildOptions(eq, cands, fmt, 0.15);
}

export function generateEquity(): MCQuestion {
  return Math.random() < 0.5 ? preflopMatchup() : flopSpot();
}

function preflopMatchup(): MCQuestion {
  const heroHand = pick(COMMON_HANDS);
  const hero = randomCombo(heroHand);
  let villainHand = pick(COMMON_HANDS);
  let villain: [Card, Card] | undefined;
  for (let tries = 0; tries < 20 && !villain; tries++) {
    const options = combosOf(villainHand).filter(([a, b]) => !hero.includes(a) && !hero.includes(b));
    if (options.length) villain = pick(options);
    else villainHand = pick(COMMON_HANDS);
  }
  if (!villain) return preflopMatchup();
  const r = equityVsHand(hero, villain, [], 30000);
  const { options, answer } = equityOptions(r.equity);
  const tie = r.tie > 0.01 ? ` (비김 ${(r.tie * 100).toFixed(1)}% 포함)` : "";
  return {
    uid: uid(),
    topic: "프리플랍 에퀴티",
    prompt: `프리플랍 올인! 내 ${heroHand} vs 상대 ${villainHand}. 내 에퀴티는 대략 얼마일까요?`,
    hero,
    villain,
    options,
    answer,
    steps: [
      `계산 결과(시뮬레이션 3만 회): 내 에퀴티 ${(r.equity * 100).toFixed(1)}%${tie}`,
      matchupHint(heroHand, villainHand),
    ],
    facts: `퀴즈 주제: 프리플랍 핸드 대 핸드 에퀴티\n내 핸드: ${hero.map(cardLabel).join(" ")} (${heroHand})\n상대 핸드: ${villain.map(cardLabel).join(" ")} (${villainHand})\n계산된 내 에퀴티: ${(r.equity * 100).toFixed(1)}% (승 ${(r.win * 100).toFixed(1)}%, 무 ${(r.tie * 100).toFixed(1)}%)`,
  };
}

function matchupHint(a: HandClass, b: HandClass): string {
  const ranks = (h: HandClass) => [GRID_RANKS.indexOf(h[0]), GRID_RANKS.indexOf(h[1])];
  const [a1, a2] = ranks(a);
  const [b1, b2] = ranks(b);
  const pairA = a.length === 2, pairB = b.length === 2;
  if (pairA && pairB) return "높은 페어 vs 낮은 페어는 보통 약 80 : 20이에요. 낮은 페어는 셋(트리플)을 맞춰야 이겨요.";
  if (pairA !== pairB) {
    const [p, other] = pairA ? [a1, [b1, b2]] : [b1, [a1, a2]];
    const overs = other.filter((r) => r < p).length;
    if (overs === 2) return "페어 vs 오버카드 2장은 거의 반반(약 53 : 47)인 '코인플립'이에요.";
    if (overs === 1) return "페어 vs 오버카드 1장은 페어가 약 70% 정도로 유리해요.";
    return "페어 vs 낮은 카드 2장은 페어가 80% 이상 크게 유리해요.";
  }
  if (a[0] === b[0] || a[1] === b[1] || a[0] === b[1] || a[1] === b[0])
    return "같은 카드를 공유하면 키커 싸움이 돼요. 키커가 낮은 쪽은 '도미네이트(지배)'당해서 약 25~30%밖에 안 돼요.";
  if (Math.max(a1, a2) < Math.min(b1, b2) || Math.max(b1, b2) < Math.min(a1, a2))
    return "높은 카드 2장 vs 낮은 카드 2장은 높은 쪽이 대략 60~65%예요. 수딧·커넥터면 낮은 쪽이 조금 올라가요.";
  return "카드가 엇갈린 경우는 대체로 55 : 45 근처예요. 수딧이면 약 2~3%p 더해요.";
}

function flopSpot(): MCQuestion {
  for (let attempt = 0; attempt < 200; attempt++) {
    const deck = shuffle(fullDeck());
    const hero = [deck[0], deck[1]];
    const villain = [deck[2], deck[3]];
    const board = [deck[4], deck[5], deck[6]];
    const r = equityVsHand(hero, villain, board);
    const heroNow = evaluate([...hero, ...board]);
    const villNow = evaluate([...villain, ...board]);
    const drawSpot = heroNow < villNow && r.equity > 0.15 && r.equity < 0.55;
    const anySpot = r.equity > 0.12 && r.equity < 0.88;
    if (!(drawSpot || (Math.random() < 0.2 && anySpot))) continue;

    const { options, answer } = equityOptions(r.equity);
    const steps = [
      `지금 내 핸드: ${categoryName(heroNow)} / 상대: ${categoryName(villNow)}`,
    ];
    let outsLine = "";
    if (heroNow < villNow) {
      const { outs } = countOuts(hero, villain, board);
      outsLine = `턴에 나와서 내가 앞서게 되는 카드: ${outs.length}장`;
      steps.push(
        `${outsLine} → 4의 법칙으로 어림하면 약 ${ruleOf2and4(outs.length, 2)}%`,
        `정확한 에퀴티(턴·리버 990가지 전부 계산): ${(r.equity * 100).toFixed(1)}%`,
        `어림값과 차이가 나는 이유: 앞서게 된 뒤에도 상대가 리버에서 다시 역전하거나, 턴에 못 맞춰도 리버에서 맞출 수 있기 때문이에요.`,
      );
    } else {
      steps.push(
        `정확한 에퀴티(턴·리버 990가지 전부 계산): ${(r.equity * 100).toFixed(1)}%`,
        `지금 앞서 있어도 상대에게 역전 카드(아웃츠)가 있으면 에퀴티가 100%가 아니에요.`,
      );
    }
    return {
      uid: uid(),
      topic: "플랍 에퀴티",
      prompt: "플랍까지 나왔고 둘 다 올인했어요. 내 에퀴티는 대략 얼마일까요?",
      hero,
      villain,
      board,
      options,
      answer,
      steps,
      facts: [
        "퀴즈 주제: 플랍 핸드 대 핸드 에퀴티",
        `내 핸드: ${hero.map(cardLabel).join(" ")} (현재 ${categoryName(heroNow)})`,
        `상대 핸드: ${villain.map(cardLabel).join(" ")} (현재 ${categoryName(villNow)})`,
        `보드(플랍): ${board.map(cardLabel).join(" ")}`,
        outsLine,
        `정확히 계산된 내 에퀴티: ${(r.equity * 100).toFixed(1)}% (승 ${(r.win * 100).toFixed(1)}%, 무 ${(r.tie * 100).toFixed(1)}%)`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return preflopMatchup();
}
