import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSet, CHART_SETS, scenarioActions, type ChartSet, type Scenario, type ScenarioDef } from "../../data/charts";
import { ALL_HANDS, gridHand, randomCombo, type HandClass } from "../../poker/cards";
import { parseRange } from "../../poker/range";
import { quizCloseActions } from "../../data/sets/preflop";
import {
  generateEquity,
  generateOdds,
  generatePreflop,
  gradeAnswer,
  gradePreflop,
  MIXED_MIN,
  pickScenario,
  quizMixedMin,
  quizPool,
  SOLVER_MIXED_MIN,
  weightedHand,
} from "./generators";

describe("quiz generators", () => {
  it("odds questions have 4 distinct options and a valid answer", () => {
    for (let i = 0; i < 400; i++) {
      const q = generateOdds();
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(4);
      expect(q.steps.length).toBeGreaterThan(0);
    }
  });
  it("equity questions have 4 distinct options", () => {
    for (let i = 0; i < 40; i++) {
      const q = generateEquity();
      expect(new Set(q.options).size).toBe(4);
      expect(q.hero).toHaveLength(2);
    }
  });
  it("preflop questions pick valid hands", () => {
    for (let i = 0; i < 200; i++) {
      const q = generatePreflop(i % 2 ? "pub" : "cash6", i % 3 ? "all" : "stage:push");
      expect(q.scenario.strategy[q.hand]).toBeDefined();
      expect(q.cards).toHaveLength(2);
    }
  });
  it("grades by chart frequency", () => {
    expect(gradePreflop(1, 1)).toBe("correct");
    expect(gradePreflop(0.6, 0.6)).toBe("correct");
    expect(gradePreflop(0.4, 0.6)).toBe("mixed");
    expect(gradePreflop(0.45, 0.45)).toBe("correct"); // best action in a 3-way mix
    expect(gradePreflop(0.1, 0.9)).toBe("wrong");
    expect(gradePreflop(0, 1)).toBe("wrong");
    // A close call (docs §6.9): an action in the near set that the chart does not take is "close"; the chart's own
    // action and every grade without `near` stay as they were.
    expect(gradePreflop(0, 1, true)).toBe("close");
    expect(gradePreflop(0.1, 0.9, true)).toBe("close");
    expect(gradePreflop(0.3, 0.7)).toBe("mixed");
    expect(gradePreflop(1, 1, true)).toBe("correct");
    expect(gradePreflop(0.6, 0.6, true)).toBe("correct");
  });
});

// ───────────── Solver-style fields: scenario weight, hero reach, noFold (synthetic scenarios) ─────────────

afterEach(() => {
  vi.restoreAllMocks();
});

/** Small seeded PRNG, so a run of questions is the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs f once for each r = (i + 0.5) / n as Math.random's every value: a deterministic sweep of [0, 1). */
function sweep<T>(n: number, f: () => T): T[] {
  const spy = vi.spyOn(Math, "random");
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    spy.mockReturnValue((i + 0.5) / n);
    out.push(f());
  }
  spy.mockRestore();
  return out;
}

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const REACH_HANDS = ["AA", "KK", "QQ", "AKs", "AQs"];
const deep = (reach: string, extra: Partial<ScenarioDef> = {}): ScenarioDef => ({
  id: "co-open-vs-btn-3bet",
  kind: "vs3bet",
  hero: "CO",
  villain: "BTN",
  chip: "CO vs BTN",
  title: "CO 오픈 후 vs BTN 3벳",
  description: "",
  reachRange: parseRange(reach),
  actions: [
    { key: "shove", label: "올인", color: "allin", range: "AA" },
    { key: "call", label: "콜", color: "call", range: "KK, QQ, AKs:0.5" },
  ],
  ...extra,
});
const LIMP: ScenarioDef = {
  id: "bb-vs-sb-limp",
  kind: "vsLimp",
  hero: "BB",
  villain: "SB",
  chip: "BB vs SB",
  title: "SB 림프 vs BB",
  description: "",
  noFold: true,
  actions: [
    { key: "raise", label: "레이즈 3.5bb", color: "raise", range: "AA, KK, AKs:0.5" },
    { key: "check", label: "체크", color: "call", range: ALL_HANDS.join(", ") },
  ],
};
const spot = (id: string, weight?: number): ScenarioDef => ({ ...deep("AA"), id, reachRange: undefined, weight });

function synthSet(id: string, scenarios: ScenarioDef[]): ChartSet {
  return buildSet({
    id,
    label: "테스트 세트",
    game: "테스트",
    source: "테스트",
    positions: POS,
    stages: [{ id: "100bb-2.2", label: "100bb", stack: "모두 100bb", description: "", scenarios }],
  });
}
/** Runs f with `set` in CHART_SETS, so quizPool and generatePreflop find it. */
function withSet<T>(set: ChartSet, f: () => T): T {
  CHART_SETS.push(set);
  try {
    return f();
  } finally {
    expect(CHART_SETS.pop()).toBe(set);
  }
}

describe("preflop quiz: scenario weights", () => {
  it("picks scenarios in proportion to weight, never one of weight 0", () => {
    const pool = synthSet("w", [spot("a", 1), spot("b", 3), spot("c", 0), spot("d")]).stages[0].scenarios;
    const counts: Record<string, number> = {};
    for (const s of sweep(1000, () => pickScenario(pool))) counts[s.id.split("/")[2]] = (counts[s.id.split("/")[2]] ?? 0) + 1;
    // Weights 1, 3, 0 and the default 1: 1000 · w / 5.
    expect(counts).toEqual({ a: 200, b: 600, d: 200 });
  });

  it("draws floor(r·n) when every weight is 1, as the uniform pick did", () => {
    const pool = synthSet("w", Array.from({ length: 7 }, (_, i) => spot(`s${i}`))).stages[0].scenarios;
    const rs = Array.from({ length: 997 }, (_, i) => i / 997).concat([0, 0.999999999, 1 / 7, 2 / 7, 6 / 7]);
    const spy = vi.spyOn(Math, "random");
    for (const r of rs) {
      spy.mockReturnValue(r);
      expect(pickScenario(pool), String(r)).toBe(pool[Math.floor(r * pool.length)]);
    }
  });

  it("falls back to a uniform pick when no weight is positive", () => {
    const pool = synthSet("w", [spot("a", 0), spot("b", 0), spot("c", -1), spot("d", Number.NaN)]).stages[0].scenarios;
    expect(sweep(400, () => pickScenario(pool).id.split("/")[2]).filter((id) => id === "c")).toHaveLength(100);
  });
});

describe("preflop quiz: hero reach", () => {
  it("never deals a hand that does not reach the spot", () => {
    const s = synthSet("r", [deep("AA, KK, QQ:0.5, AKs, AQs:0.1")]).stages[0].scenarios[0];
    const dealt = new Set(sweep(2000, () => weightedHand(s)));
    expect([...dealt].sort()).toEqual([...REACH_HANDS].sort());
  });

  it("deals a hand less often when it reaches the spot less often", () => {
    const share = (reach: string, h: HandClass) => {
      const s = synthSet("r", [deep(reach)]).stages[0].scenarios[0];
      return sweep(2000, () => weightedHand(s)).filter((x) => x === h).length;
    };
    expect(share("AA, KK, QQ:0.2, AKs", "QQ")).toBeLessThan(share("AA, KK, QQ, AKs", "QQ"));
  });

  it("deals reaching hands end to end through generatePreflop", () => {
    const set = synthSet("r", [deep("AA, KK, QQ:0.5, AKs, AQs:0.1")]);
    const hands = withSet(set, () => sweep(2000, () => generatePreflop("r").hand));
    expect(new Set(hands).size).toBe(REACH_HANDS.length);
    expect(hands.every((h) => REACH_HANDS.includes(h))).toBe(true);
  });

  it("deals any hand rather than crash when nothing reaches (broken data)", () => {
    const s = synthSet("r", [deep("")]).stages[0].scenarios[0];
    expect(ALL_HANDS).toContain(weightedHand(s));
  });
});

describe("preflop quiz: no fold", () => {
  it("offers no 폴드 button and always has a right answer among the buttons", () => {
    const set = synthSet("l", [LIMP]);
    const qs = withSet(set, () => sweep(500, () => generatePreflop("l")));
    for (const q of qs) {
      const keys = scenarioActions(q.scenario).map((a) => a.key);
      expect(keys).toEqual(["raise", "check"]);
      const st = q.scenario.strategy[q.hand];
      expect(st.fold).toBe(0);
      const best = Math.max(...Object.values(st));
      expect(keys.some((k) => gradePreflop(st[k], best) === "correct"), q.hand).toBe(true);
    }
  });

  it("weights the raise/check border like the open/fold border elsewhere", () => {
    // AKs is mixed (50% raise); AKo checks next to the raising AA and KK on the grid; 72o checks far from them.
    const s = synthSet("l", [LIMP]).stages[0].scenarios[0];
    const n = (h: HandClass, hands: HandClass[]) => hands.filter((x) => x === h).length;
    const hands = sweep(4000, () => weightedHand(s));
    expect(n("AKs", hands)).toBeGreaterThan(n("AKo", hands));
    expect(n("AKo", hands)).toBeGreaterThan(5 * n("72o", hands));
  });
});

describe("preflop quiz: close calls and skipped hands (docs §6.9, §6.10)", () => {
  // TT 3-bets 100% on the chart, with call within ε (close); QQ is a flagged cell the quiz never deals.
  const CLOSE: ScenarioDef = {
    id: "co-vs-utg-open",
    kind: "vsOpen",
    hero: "CO",
    villain: "UTG",
    chip: "vs UTG",
    title: "CO vs UTG 오픈",
    description: "",
    actions: [
      { key: "3bet", label: "3벳 6.6bb", color: "raise", range: "AA, KK, TT, AKs" },
      { key: "call", label: "콜", color: "call", range: "QQ, JJ, 99, AQs" },
    ],
    close: { TT: ["3bet", "call"] },
    quizSkip: { QQ: true },
  };

  it("grades the other near action close and an action outside the set wrong", () => {
    const s = synthSet("c", [CLOSE]).stages[0].scenarios[0];
    const st = s.strategy["TT"];
    expect(st["3bet"]).toBe(1);
    const best = Math.max(...Object.values(st));
    const near = (k: string) => s.close?.TT?.includes(k) ?? false;
    expect(gradePreflop(st.call, best, near("call"))).toBe("close");
    expect(gradePreflop(st.fold, best, near("fold"))).toBe("wrong");
    expect(gradePreflop(st["3bet"], best, near("3bet"))).toBe("correct");
  });

  it("gradeAnswer: close calls, no AA/KK passive tie, and the solver set's mixed floor", () => {
    // TT and KK 3-bet 100% with the call near; AJs 3-bets 90% and calls 10% (0.0999… after buildScenario's fill).
    const def: ScenarioDef = {
      ...CLOSE,
      actions: [
        { key: "3bet", label: "3벳 6.6bb", color: "raise", range: "AA, KK, TT, AKs, AJs:0.9" },
        { key: "call", label: "콜", color: "call", range: "QQ, JJ, 99, AQs, AJs:0.1" },
      ],
      close: { TT: ["3bet", "call"], KK: ["3bet", "call"], QQ: ["3bet", "call"] },
    };
    const s = synthSet("c", [def]).stages[0].scenarios[0];
    expect(gradeAnswer(s, "TT", "call")).toBe("close");
    expect(gradeAnswer(s, "TT", "3bet")).toBe("correct");
    expect(gradeAnswer(s, "TT", "fold")).toBe("wrong");
    // KK: the flat rests on the big pairs' call realization (§8): not accepted as close; QQ's is.
    expect(quizCloseActions(s, "KK")).toBeUndefined();
    expect(gradeAnswer(s, "KK", "call")).toBe("wrong");
    expect(gradeAnswer(s, "KK", "3bet")).toBe("correct");
    expect(quizCloseActions(s, "QQ")).toEqual(["3bet", "call"]);
    expect(gradeAnswer(s, "QQ", "3bet")).toBe("close"); // QQ calls on the chart
    // The mixed floor: 0.2 for the hand-made sets, so a 10% action stays 오답 there; the solver set's 0.05.
    expect(s.strategy.AJs.call).toBeLessThan(0.1);
    expect(s.strategy.AJs.call).toBeGreaterThan(0.0999);
    expect(gradeAnswer(s, "AJs", "call")).toBe("wrong");
    expect(gradeAnswer(s, "AJs", "call", SOLVER_MIXED_MIN)).toBe("mixed");
    expect(gradeAnswer(s, "AJs", "3bet", SOLVER_MIXED_MIN)).toBe("correct");
    expect(gradeAnswer(s, "AJs", "fold", SOLVER_MIXED_MIN)).toBe("wrong");
    expect(quizMixedMin({})).toBe(MIXED_MIN);
    expect(quizMixedMin({ closeEps: 0.05 })).toBe(SOLVER_MIXED_MIN);
    expect([gradePreflop(0.1, 0.9), gradePreflop(0.19, 0.81), gradePreflop(0.2, 0.8)]).toEqual(["wrong", "wrong", "mixed"]);
    expect([gradePreflop(0, 1, false, SOLVER_MIXED_MIN), gradePreflop(0.1, 0.9, false, SOLVER_MIXED_MIN)]).toEqual(["wrong", "mixed"]);
  });

  it("never deals a quizSkip hand", () => {
    const s = synthSet("c", [CLOSE]).stages[0].scenarios[0];
    vi.spyOn(Math, "random").mockImplementation(mulberry32(11));
    const dealt = Array.from({ length: 2000 }, () => weightedHand(s));
    expect(dealt).not.toContain("QQ");
    expect(new Set(dealt).size).toBeGreaterThan(100);
  });

  it("falls back to every hand rather than crash when all of a spot's hands are skipped", () => {
    const all = Object.fromEntries(ALL_HANDS.map((h) => [h, true as const]));
    const s = synthSet("c", [{ ...CLOSE, quizSkip: all }]).stages[0].scenarios[0];
    const dealt = new Set(sweep(500, () => weightedHand(s)));
    expect(dealt.size).toBeGreaterThan(50);
    // A skipped spot that also reaches only a few hands falls back to those hands.
    const d = synthSet("c", [deep("AA, KK, QQ:0.5, AKs, AQs:0.1", { quizSkip: all })]).stages[0].scenarios[0];
    expect([...new Set(sweep(2000, () => weightedHand(d)))].sort()).toEqual([...REACH_HANDS].sort());
  });
});

// ───────────── The four existing sets draw exactly the questions they drew before ─────────────
// The draw as it was before weights and reach existed (generators.ts at d1c0049), inlined as the reference.

function legacyNeighbors(h: HandClass): HandClass[] {
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
function legacyHandWeight(s: Scenario, h: HandClass): number {
  const st = s.strategy[h];
  const max = Math.max(...Object.values(st));
  if (max < 0.999) return 3;
  const plays = st.fold < 0.999;
  const edge = legacyNeighbors(h).some((n) => (s.strategy[n].fold < 0.999) !== plays);
  if (edge) return 2;
  return plays ? 0.6 : 0.15;
}
function legacyWeightedHand(scenario: Scenario): HandClass {
  const weights = ALL_HANDS.map((h) => legacyHandWeight(scenario, h));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = Math.random() * total;
  for (let i = 0; i < ALL_HANDS.length; i++) {
    x -= weights[i];
    if (x <= 0) return ALL_HANDS[i];
  }
  return ALL_HANDS[ALL_HANDS.length - 1];
}
function legacyGenerate(setId: string, filter: string) {
  const pool = quizPool(setId, filter);
  const scenario = pool[Math.floor(Math.random() * pool.length)];
  const hand = legacyWeightedHand(scenario);
  Math.random(); // the question's uid
  return { scenario, hand, cards: randomCombo(hand) };
}

describe("preflop quiz: existing sets", () => {
  it("draw the same scenarios, hands and cards as before, from the same random numbers", () => {
    for (const setId of ["pub", "cash6", "nash", "shortnash"]) {
      const set = CHART_SETS.find((s) => s.id === setId)!;
      for (const filter of ["all", `stage:${set.stages[0].id}`, `stage:${set.stages[set.stages.length - 1].id}`]) {
        const run = (gen: () => { scenario: Scenario; hand: HandClass; cards: number[] }) => {
          vi.spyOn(Math, "random").mockImplementation(mulberry32(7));
          const out = Array.from({ length: 300 }, () => {
            const q = gen();
            return `${q.scenario.id} ${q.hand} ${q.cards.join(",")}`;
          });
          vi.restoreAllMocks();
          return out;
        };
        expect(run(() => generatePreflop(setId, filter)), `${setId} ${filter}`).toEqual(run(() => legacyGenerate(setId, filter)));
      }
    }
  });
});
