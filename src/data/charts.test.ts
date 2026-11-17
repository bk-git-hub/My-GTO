import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FreqBar, strategyGradient } from "../components/FreqBar";
import { RangeGrid } from "../components/RangeGrid";
import { ChartsPage } from "../features/charts/ChartsPage";
import { ALL_HANDS, gridHand, type HandClass } from "../poker/cards";
import { parseRange } from "../poker/range";
import { settingsStore } from "../state/settings";
import { cautionLines } from "./sets/preflop";
import {
  actionTotals,
  allScenarios,
  buildSet,
  CHART_SETS,
  describeStrategy,
  displayChips,
  FOLD,
  getSet,
  HERO_FILTER_ABOVE,
  heroFilterSeats,
  heroSeats,
  inReach,
  KIND_LABEL,
  legendActions,
  NAMED_RANGES,
  namedRanges,
  reachOf,
  reachShare,
  reachTotals,
  scenarioActions,
  type ChartSet,
  type ChartSetDef,
  type HandStrategy,
  type Scenario,
  type ScenarioDef,
} from "./charts";

const playFreq = (s: ReturnType<typeof allScenarios>[number], h: string) => 1 - s.strategy[h].fold;

describe("chart sets", () => {
  it("build every scenario with unique ids and strategies that sum to 1", () => {
    const ids = new Set<string>();
    for (const s of allScenarios()) {
      expect(ids.has(s.id), s.id).toBe(false);
      ids.add(s.id);
      for (const h of ALL_HANDS) {
        const total = Object.values(s.strategy[h]).reduce((a, b) => a + b, 0);
        expect(total, `${s.id} ${h}`).toBeCloseTo(1, 6);
      }
    }
    expect(NAMED_RANGES.length).toBeGreaterThan(50);
  });

  it("pub: later seats never play fewer hands than earlier seats (first-in)", () => {
    const order = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"];
    for (const stage of getSet("pub").stages) {
      const rfi = Object.fromEntries(stage.scenarios.filter((s) => s.kind === "rfi").map((s) => [s.hero, s]));
      for (let i = 1; i < order.length; i++) {
        const prev = rfi[order[i - 1]], cur = rfi[order[i]];
        for (const h of ALL_HANDS) {
          expect(playFreq(cur, h), `${stage.id} ${order[i]} ${h} vs ${order[i - 1]}`).toBeGreaterThanOrEqual(playFreq(prev, h));
        }
      }
    }
  });

  it("pub: shove ranges widen from 17bb to 11bb", () => {
    const set = getSet("pub");
    const short = set.stages.find((s) => s.id === "short")!;
    const push = set.stages.find((s) => s.id === "push")!;
    for (const s of push.scenarios.filter((x) => x.kind === "rfi")) {
      const t = short.scenarios.find((x) => x.kind === "rfi" && x.hero === s.hero)!;
      const w17 = 1 - actionTotals(t).fold;
      const w11 = 1 - actionTotals(s).fold;
      expect(w11, s.hero).toBeGreaterThanOrEqual(w17);
    }
  });

  it("pub: spot checks against the chat", () => {
    const set = getSet("pub");
    const sc = (stage: string, id: string) => set.stages.find((s) => s.id === stage)!.scenarios.find((s) => s.id.endsWith(`/${id}`))!;
    // 55bb UTG: "55 / A9s, A5s / KTs / QTs, JTs / AJo, KQo"
    const mUtg = sc("mid", "rfi-utg");
    expect(mUtg.strategy["A5s"].open).toBe(1);
    expect(mUtg.strategy["A6s"].fold).toBe(1);
    expect(mUtg.strategy["44"].fold).toBe(1);
    expect(mUtg.strategy["KQo"].open).toBe(1);
    expect(mUtg.strategy["KJo"].fold).toBe(1);
    // 55bb BTN: A5o is the weakest offsuit ace
    const mBtn = sc("mid", "rfi-btn");
    expect(mBtn.strategy["A5o"].open).toBe(1);
    expect(mBtn.strategy["A4o"].fold).toBe(1);
    // 17bb UTG: TT+/AQ+ small, 77-99 shove, 66 fold
    const sUtg = sc("short", "rfi-utg");
    expect(sUtg.strategy["TT"].small).toBe(1);
    expect(sUtg.strategy["AKo"].small).toBe(1);
    expect(sUtg.strategy["99"].shove).toBe(1);
    expect(sUtg.strategy["AJo"].shove).toBe(1);
    expect(sUtg.strategy["66"].fold).toBe(1);
    // 11bb BTN: K7o shoves, K6o folds
    const pBtn = sc("push", "rfi-btn");
    expect(pBtn.strategy["K7o"].shove).toBe(1);
    expect(pBtn.strategy["K6o"].fold).toBe(1);
    // 11bb call vs early shove: TT+, AQ+
    const call = sc("push", "call-vs-early-shove");
    expect(call.strategy["TT"].call).toBe(1);
    expect(call.strategy["99"].fold).toBe(1);
    expect(call.strategy["KQo"].fold).toBe(1);
  });

  it("prints range widths", () => {
    for (const set of CHART_SETS) {
      for (const st of set.stages) {
        const row = st.scenarios
          .filter((s) => s.kind === "rfi")
          .map((s) => `${s.hero} ${((1 - actionTotals(s).fold) * 100).toFixed(1)}%`)
          .join(" | ");
        console.log(`${set.id}/${st.id}: ${row}`);
      }
    }
  });
});

describe("nash push/fold set", () => {
  const set = getSet("nash");
  const pushPct = (stage: (typeof set.stages)[number], seat: string) =>
    1 - actionTotals(stage.scenarios.find((s) => s.kind === "rfi" && s.hero === seat)!).fold;
  const callPct = (stage: (typeof set.stages)[number], id: string) => 1 - actionTotals(stage.scenarios.find((s) => s.id.endsWith(`/${id}`))!).fold;

  it("has every stack with 8 shove spots and 36 calling spots", () => {
    expect(set.stages.map((s) => s.id)).toContain("10bb");
    for (const st of set.stages) {
      expect(st.scenarios.filter((s) => s.kind === "rfi")).toHaveLength(8);
      expect(st.scenarios.filter((s) => s.kind === "vsShove")).toHaveLength(36);
    }
  });

  it("shoves wider from later seats and with shorter stacks", () => {
    for (const st of set.stages) {
      expect(pushPct(st, "UTG"), st.id).toBeLessThan(pushPct(st, "BTN"));
      expect(pushPct(st, "BTN"), st.id).toBeLessThan(pushPct(st, "SB"));
    }
    const [s5, s15] = ["5bb", "15bb"].map((id) => set.stages.find((s) => s.id === id)!);
    for (const seat of ["UTG", "CO", "BTN", "SB"]) expect(pushPct(s5, seat), seat).toBeGreaterThan(pushPct(s15, seat));
  });

  it("calls wider against later shovers", () => {
    for (const st of set.stages.filter((s) => s.id !== "4bb")) {
      expect(callPct(st, "call-bb-vs-utg"), st.id).toBeLessThan(callPct(st, "call-bb-vs-btn"));
      expect(callPct(st, "call-bb-vs-btn"), st.id).toBeLessThan(callPct(st, "call-bb-vs-sb"));
    }
  });
});

describe("short-stack open / re-jam set", () => {
  const set = getSet("shortnash");
  const sc = (stage: string, id: string) => set.stages.find((s) => s.id === stage)!.scenarios.find((s) => s.id.endsWith(`/${id}`))!;
  const played = (stage: string, id: string) => 1 - actionTotals(sc(stage, id)).fold;

  it("has first-in, vs-open, vs-re-jam and vs-jam spots for every seat pair", () => {
    for (const st of set.stages) {
      expect(st.scenarios.filter((s) => s.kind === "rfi")).toHaveLength(8);
      expect(st.scenarios.filter((s) => s.kind === "vsOpen")).toHaveLength(36);
      expect(st.scenarios.filter((s) => s.kind === "vs3bet")).toHaveLength(36);
      expect(st.scenarios.filter((s) => s.kind === "vsShove")).toHaveLength(36);
    }
  });

  it("opens wider from later seats and the BB defends wider against them (20~25bb)", () => {
    for (const st of ["20bb", "25bb"]) {
      expect(played(st, "rfi-utg"), st).toBeLessThan(played(st, "rfi-co"));
      expect(played(st, "rfi-co"), st).toBeLessThan(played(st, "rfi-btn"));
      expect(played(st, "bb-vs-utg-open"), st).toBeLessThan(played(st, "bb-vs-btn-open"));
      expect(played(st, "bb-vs-btn-open"), st).toBeLessThan(played(st, "bb-vs-sb-open"));
      // Getting about 4.5:1, the BB defends at least half its hands even against UTG.
      expect(played(st, "bb-vs-utg-open"), st).toBeGreaterThan(0.45);
    }
  });
});

describe("pub BB defense (deep/mid)", () => {
  const pub = getSet("pub");
  const defend = (stage: string, opener: string) =>
    1 - actionTotals(pub.stages.find((s) => s.id === stage)!.scenarios.find((s) => s.id.endsWith(`/bb-vs-${opener}`))!).fold;

  it("has a chart per opener, defending wider against later seats and with smaller opens", () => {
    for (const stage of ["deep", "mid"]) {
      expect(defend(stage, "utg"), stage).toBeLessThan(defend(stage, "co"));
      expect(defend(stage, "co"), stage).toBeLessThan(defend(stage, "btn"));
      expect(defend(stage, "utg"), stage).toBeGreaterThan(0.25);
    }
    for (const op of ["utg", "hj", "btn"]) expect(defend("deep", op), op).toBeLessThan(defend("mid", op)); // 3bb vs 2.5bb opens
  });
});

// ───────────── Solver-style fields (§6.3 / §6.8 of the preflop design), on synthetic scenarios ─────────────
// The real solver set is generated separately (src/data/sets/preflop.ts); these tests pin the app-side behaviour.

const POS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const seatId = (p: string) => p.toLowerCase().replace("+", "p");
/** The opener's reach in the synthetic vs-3-bet spots: 6 + 6 + 3 + 4 = 19 combos. */
const OPEN = "AA, KK, QQ:0.5, AKs";
const REACH = parseRange(OPEN);
const EVERY_HAND = ALL_HANDS.join(", ");

const rfi = (hero: string): ScenarioDef => ({
  id: `rfi-${seatId(hero)}`,
  kind: "rfi",
  hero,
  chip: hero,
  title: `${hero} 오픈`,
  description: "",
  actions: [{ key: "open", label: "오픈 2.2bb", color: "open", range: OPEN }],
});
const vs3bet = (hero: string, threeBettor: string): ScenarioDef => ({
  id: `${seatId(hero)}-open-vs-${seatId(threeBettor)}-3bet`,
  kind: "vs3bet",
  hero,
  villain: threeBettor,
  chip: `${hero} vs ${threeBettor}`,
  title: `${hero} 오픈 후 vs ${threeBettor} 3벳`,
  description: "",
  reachRange: REACH,
  actions: [
    { key: "shove", label: "올인", color: "allin", range: "AA" },
    { key: "call", label: "콜", color: "call", range: "KK, QQ, AKs:0.5" },
  ],
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
    { key: "check", label: "체크", color: "call", range: EVERY_HAND },
  ],
};
const VS_OPEN: ScenarioDef = {
  id: "bb-vs-co-open",
  kind: "vsOpen",
  hero: "BB",
  villain: "CO",
  chip: "BB vs CO",
  title: "BB vs CO 오픈",
  description: "",
  actions: [
    { key: "3bet", label: "3벳 9bb", color: "raise", range: "QQ+" },
    { key: "call", label: "콜", color: "call", range: "JJ-22, AQs-A2s" },
  ],
};
const SQUEEZE: ScenarioDef = {
  id: "bb-at-co-open-btn-call",
  kind: "squeeze",
  hero: "BB",
  chip: "CO오픈·BTN콜",
  title: "BB — CO 오픈 → BTN 콜",
  description: "",
  weight: 0.2,
  actions: [
    { key: "squeeze", label: "스퀴즈 11bb", color: "raise", range: "QQ+" },
    { key: "call", label: "콜", color: "call", range: "JJ-99" },
  ],
};
const VS_4BET: ScenarioDef = {
  id: "btn-3bet-vs-co-4bet",
  kind: "vs4bet",
  hero: "BTN",
  villain: "CO",
  chip: "BTN vs CO",
  title: "BTN 3벳 후 vs CO 4벳",
  description: "",
  reachRange: parseRange("QQ+, AKs, A5s:0.5"),
  actions: [
    { key: "shove", label: "올인", color: "allin", range: "KK+" },
    { key: "call", label: "콜", color: "call", range: "QQ, AKs" },
  ],
};
// Decision 1 of the main session: a cold player behind a 3-bet is a vs3bet scenario with only a jam.
const COLD: ScenarioDef = {
  id: "hj-at-utg-open-co-3bet",
  kind: "vs3bet",
  hero: "HJ",
  chip: "UTG오픈·CO3벳",
  title: "HJ — UTG 오픈 → CO 3벳 (콜드: 폴드·올인)",
  description: "",
  actions: [{ key: "shove", label: "콜드 올인", color: "allin", range: "KK+" }],
};
const COLD_JAM_ANSWER: ScenarioDef = {
  id: "utg-at-utg-open-co-3bet-hj-jam",
  kind: "vsShove",
  hero: "UTG",
  chip: "UTG오픈·CO3벳·HJ올인",
  title: "UTG — UTG 오픈 → CO 3벳 → HJ 올인",
  description: "",
  reachRange: REACH,
  actions: [{ key: "call", label: "콜", color: "call", range: "AA" }],
};
/** 13 vs-3-bet spots (one more than HERO_FILTER_ABOVE): CO's come first in the list, UTG first at the table. */
const BIG: ScenarioDef[] = [
  ...["BTN", "SB", "BB"].map((v) => vs3bet("CO", v)),
  ...POS.slice(1).map((v) => vs3bet("UTG", v)),
  ...["SB", "BB"].map((v) => vs3bet("BTN", v)),
];

function solverLike(id: string, scenarios: ScenarioDef[], extra: Partial<ChartSetDef> = {}): ChartSet {
  return buildSet({
    id,
    label: "테스트 세트",
    game: "테스트 게임",
    source: "테스트용 합성 데이터",
    positions: POS,
    heroFilter: true,
    ...extra,
    stages: [{ id: "100bb-2.2", label: "100bb · 오픈 2.2bb", stack: "모두 100bb", description: "합성", scenarios }],
  });
}
const one = (def: ScenarioDef): Scenario => solverLike("solver", [def]).stages[0].scenarios[0];

/** renderToString puts <!-- --> between adjacent text nodes. */
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");
const cellOf = (html: string, h: HandClass) => html.match(new RegExp(`<button[^>]*>${h}</button>`))![0];
const texts = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");

/** The charts page for `set`, put into CHART_SETS (and picked) only while it renders. */
function renderPage(set?: ChartSet, chartSet = set?.id ?? "pub"): string {
  const before = settingsStore.get();
  if (set) CHART_SETS.push(set);
  try {
    settingsStore.set({ ...before, chartSet });
    return render(createElement(ChartsPage));
  } finally {
    if (set) expect(CHART_SETS.pop()).toBe(set);
    settingsStore.set(before);
  }
}

describe("solver-style scenario fields", () => {
  it("cautions pick each rule's extreme example where a flag lists several hands (docs §6.10)", () => {
    // The shipped data's -9, -11 and -14 flags list one hand each, so these choices are checked here.
    const vsOpen = (actions: [string, string, string][], flags: ScenarioDef["flags"]): Scenario =>
      one({
        id: "co-vs-utg-open",
        kind: "vsOpen",
        hero: "CO",
        villain: "UTG",
        chip: "vs UTG",
        title: "CO vs UTG 오픈",
        description: "",
        actions: actions.map(([key, label, range]) => ({ key, label, color: key === "call" ? "call" : "raise", range })),
        flags,
      });
    // -9: the connector that 3-bets most and the wheel ace that 3-bets most.
    const nine = vsOpen([["3bet", "3벳 6.6bb", "54s, 65s:0.6, A4s:0.5"]], [{ code: "PF-SANITY-9", hands: "54s, 65s", vs: "A4s, A3s" }]);
    expect(cautionLines(nine)[0]).toContain("(예: 54s 3벳 100%, A4s 3벳 50%)");
    // -11: the big pair that 3-bets least (QQ 30%, JJ 0%) and the middle pair that 3-bets most (TT 100%, 99 60%).
    const eleven = vsOpen(
      [
        ["3bet", "3벳 6.6bb", "AA, KK, QQ:0.3, TT, 99:0.6"],
        ["call", "콜", "QQ:0.7, JJ, 99:0.4"],
      ],
      [{ code: "PF-SANITY-11", hands: "QQ, JJ", vs: "TT, 99" }],
    );
    expect(cautionLines(eleven)[0]).toContain("(예: JJ 3벳 0%, TT 3벳 100%)");
    // -14: the widest gap in plays, A6o 0% against A4o 100% (A8o 20% and A3o 60% make the other pairs).
    const fourteen = vsOpen([["call", "콜", "A4o, A3o:0.6, A8o:0.2"]], [{ code: "PF-SANITY-14", hands: "A8o, A6o", vs: "A4o, A3o" }]);
    expect(cautionLines(fourteen)[0]).toContain("(예: A6o 0%, A4o 100%)");
  });

  it("labels the new kinds", () => {
    expect(KIND_LABEL.vs4bet).toBe("vs 4벳");
    expect(KIND_LABEL.squeeze).toBe("스퀴즈·오버콜");
    expect(KIND_LABEL.vsLimp).toBe("림프 팟");
  });

  it("carries reachRange, noFold and weight from the definition to the scenario", () => {
    const [limp, sqz, v4] = solverLike("solver", [LIMP, SQUEEZE, VS_4BET]).stages[0].scenarios;
    expect(limp.id).toBe("solver/100bb-2.2/bb-vs-sb-limp");
    expect(limp.noFold).toBe(true);
    expect(sqz.weight).toBe(0.2);
    expect(v4.reachRange).toBe(VS_4BET.reachRange);
    expect(sqz.reachRange).toBeUndefined();
  });

  it("reachTotals is the share of the reaching combos, weighted by reach, fold included", () => {
    const s = one(vs3bet("CO", "BTN"));
    expect(reachOf(s, "QQ")).toBe(0.5);
    expect(inReach(s, "QQ")).toBe(true);
    expect(inReach(s, "72o")).toBe(false);
    expect(reachShare(s)).toBeCloseTo(19 / 1326, 12);
    // AA 6 combos jam; KK 6 and half of QQ's 6 call; AKs's 4 combos call half the time and fold the rest.
    const r = reachTotals(s);
    expect(Object.keys(r)).toEqual(["shove", "call", "fold"]);
    expect(r.shove).toBeCloseTo(6 / 19, 12);
    expect(r.call).toBeCloseTo(11 / 19, 12);
    expect(r.fold).toBeCloseTo(2 / 19, 12);
    // actionTotals stays the share of all 1326 combos and ignores reach (QQ counts fully).
    const a = actionTotals(s);
    expect(a.shove).toBeCloseTo(6 / 1326, 12);
    expect(a.call).toBeCloseTo(14 / 1326, 12);
    expect(a.fold).toBeCloseTo(1306 / 1326, 12);
  });

  it("reachTotals is all 0 when nothing reaches, and equals actionTotals without reachRange", () => {
    const none = one({ ...vs3bet("CO", "BTN"), reachRange: parseRange("") });
    expect(reachShare(none)).toBe(0);
    expect(Object.values(reachTotals(none))).toEqual([0, 0, 0]);
    expect(reachShare(one(rfi("CO")))).toBe(1);
    // Spots with a reachRange (the solver set deep in a line) are reach-relative by design; reachTotals equals
    // actionTotals only where there is no reachRange, as the title says.
    for (const s of [one(rfi("CO")), one(LIMP), ...allScenarios().filter((x) => !x.reachRange)]) {
      const a = actionTotals(s);
      const r = reachTotals(s);
      expect(Object.keys(r)).toEqual(Object.keys(a));
      for (const k of Object.keys(a)) expect(r[k], `${s.id} ${k}`).toBe(a[k]);
    }
  });

  it("noFold leaves fold out of the buttons, the legend and the description", () => {
    const limp = one(LIMP);
    expect(scenarioActions(limp).map((a) => a.key)).toEqual(["raise", "check"]);
    expect(legendActions(limp).map((a) => a.key)).toEqual(["raise", "check"]);
    expect(describeStrategy(limp, limp.strategy["AA"])).toBe("레이즈 3.5bb 100% / 체크 0%");
    expect(describeStrategy(limp, limp.strategy["AKs"])).toBe("레이즈 3.5bb 50% / 체크 50%");
    for (const h of ALL_HANDS) expect(limp.strategy[h].fold, h).toBe(0);
    // Everywhere else fold is the first button and the last legend entry.
    const s = one(vs3bet("CO", "BTN"));
    expect(scenarioActions(s).map((a) => a.key)).toEqual(["fold", "shove", "call"]);
    expect(legendActions(s).map((a) => a.key)).toEqual(["shove", "call", "fold"]);
    expect(describeStrategy(s, s.strategy["AKs"])).toBe("올인 0% / 콜 50% / 폴드 50%");
  });

  it("FreqBar's legend follows legendActions: no 폴드 entry where the spot has no fold", () => {
    const legend = (sc: Scenario, h: HandClass) =>
      [...render(createElement(FreqBar, { scenario: sc, strategy: sc.strategy[h] })).matchAll(/<span class="freq-item">(.*?)<\/span>/g)].map((m) =>
        stripTags(m[1]),
      );
    const limp = one(LIMP);
    expect(legend(limp, "AKs")).toEqual(["레이즈 3.5bb 50%", "체크 50%"]);
    expect(legend(limp, "72o")).toEqual(["레이즈 3.5bb 0%", "체크 100%"]);
    const s = one(vs3bet("CO", "BTN"));
    expect(legend(s, "AKs")).toEqual(["올인 0%", "콜 50%", "폴드 50%"]);
    // The bar itself is unchanged: its bands still run in action order with fold last.
    expect(strategyGradient(s, s.strategy["AKs"])).toBe("linear-gradient(to right, var(--call) 0% 50%, var(--fold) 50% 100%)");
  });

  it("lists only rfi, vsOpen and vs3bet ranges of the solver set in the calculator, reach-weighted", () => {
    const defs = [rfi("CO"), VS_OPEN, vs3bet("CO", "BTN"), COLD, SQUEEZE, VS_4BET, LIMP, COLD_JAM_ANSWER];
    const spot = (id: string) => id.split("/")[2].split(":")[0];
    const solver = namedRanges([solverLike("solver", defs)]);
    expect([...new Set(solver.map((r) => spot(r.id)))]).toEqual(["rfi-co", "bb-vs-co-open", "co-open-vs-btn-3bet", "hj-at-utg-open-co-3bet"]);
    // Any other set keeps every scenario.
    const other = namedRanges([solverLike("other", defs)]);
    expect(other.length).toBe(defs.reduce((n, d) => n + d.actions.length, 0));
    // A villain who reached the spot half the time holds the hand half as often.
    const call = solver.find((r) => r.id === "solver/100bb-2.2/co-open-vs-btn-3bet:call")!;
    expect(call.label).toBe("CO 오픈 후 vs BTN 3벳 — 콜");
    expect(call.group).toBe("테스트 세트 · 100bb · 오픈 2.2bb");
    expect([call.range["KK"], call.range["QQ"], call.range["AKs"], call.range["AA"], call.range["72o"]]).toEqual([1, 0.5, 0.5, 0, 0]);
  });

  it("offers the hero-seat filter only for big groups of sets that opt in, seats in table order", () => {
    const on = { heroFilter: true, positions: POS };
    expect(BIG.length).toBe(HERO_FILTER_ABOVE + 1);
    expect(heroSeats(BIG, POS)).toEqual(["UTG", "CO", "BTN"]);
    expect(heroSeats([...BIG, { ...rfi("CO"), hero: "뒤 자리" }], POS)).toEqual(["UTG", "CO", "BTN", "뒤 자리"]);
    expect(heroFilterSeats(on, BIG)).toEqual(["UTG", "CO", "BTN"]);
    expect(heroFilterSeats(on, BIG.slice(0, HERO_FILTER_ABOVE))).toEqual([]);
    expect(heroFilterSeats({ positions: POS }, BIG)).toEqual([]);
    const oneSeat = Array.from({ length: 20 }, (_, i) => ({ ...vs3bet("UTG", "BB"), id: `x${i}` }));
    expect(heroFilterSeats(on, oneSeat)).toEqual([]);
  });

  it("dims the grid cells of hands that never reach the spot", () => {
    const html = render(createElement(RangeGrid, { scenario: one(vs3bet("CO", "BTN")) }));
    const out = ALL_HANDS.filter((h) => /class="[^"]*\bout\b/.test(cellOf(html, h)));
    expect(out).toEqual(ALL_HANDS.filter((h) => !["AA", "KK", "QQ", "AKs"].includes(h)));
    expect(cellOf(html, "72o")).not.toContain("style=");
    expect(cellOf(html, "72o")).not.toContain("folded");
    expect(cellOf(html, "72o")).toContain("여기까지 오지 않는 핸드");
    expect(cellOf(html, "QQ")).toContain("linear-gradient"); // half the reach is still in reach
    expect(cellOf(html, "AKs")).toContain("linear-gradient");
    // Without reachRange nothing is dimmed.
    expect(render(createElement(RangeGrid, { scenario: one(rfi("CO")) }))).not.toMatch(/class="[^"]*\bout\b/);
  });

  it("charts page: a big group gets the seat row, and deep spots show reach-relative totals", () => {
    const html = renderPage(solverLike("solver-test", [...BIG, rfi("CO")]));
    const seg = html.match(/<div class="seg small seat-filter"[^>]*>(.*?)<\/div>/)![1];
    expect(texts(seg)).toEqual(["UTG", "CO", "BTN"]);
    expect(seg).toContain('<button class="on">UTG</button>');
    const chips = html.match(/<div class="chips scroll">(.*?)<\/div>/)![1];
    expect(texts(chips)).toEqual(POS.slice(1).map((v) => `UTG vs ${v}`));
    const legend = stripTags(html.match(/<div class="legend">(.*?)<\/div>/)![1]);
    expect(legend).toBe("올인 31.6%콜 57.9%폴드 10.5%도달 레인지 1.4%");
    expect(html).toContain("비율은 여기까지 온 핸드 기준이에요.");
    expect(html).toMatch(/class="[^"]*\bout\b/);
  });

  it("charts page: a small group shows every chip, and a spot without reachRange keeps all-hands totals", () => {
    const html = renderPage(solverLike("solver-test", [...BIG.slice(0, HERO_FILTER_ABOVE).map((s) => ({ ...s, reachRange: undefined }))]));
    expect(html).not.toContain("seat-filter");
    expect(texts(html.match(/<div class="chips scroll">(.*?)<\/div>/)![1])).toHaveLength(HERO_FILTER_ABOVE);
    expect(html).not.toContain("도달");
    expect(stripTags(html.match(/<div class="legend">(.*?)<\/div>/)![1])).toBe("올인 0.5%콜 1.1%폴드 98.5%");
  });

  it("charts page: repeated chips in a list shown without the seat row get their hero in front", () => {
    // Two heroes on the same public line: identical generic chips, in a group small enough to show at once.
    const btn: ScenarioDef = { ...COLD_JAM_ANSWER, kind: "vs4bet", id: "btn-at-btn-open-sb-3bet-bb-jam", hero: "BTN", chip: "BTN오픈·SB3벳·BB올인" };
    const sb: ScenarioDef = { ...COLD_JAM_ANSWER, kind: "vs4bet", id: "sb-at-btn-open-sb-3bet-bb-jam", hero: "SB", chip: "BTN오픈·SB3벳·BB올인" };
    expect(displayChips([VS_4BET, btn, sb])).toEqual(["BTN vs CO", "BTN: BTN오픈·SB3벳·BB올인", "SB: BTN오픈·SB3벳·BB올인"]);
    expect(displayChips([VS_4BET, btn])).toEqual(["BTN vs CO", "BTN오픈·SB3벳·BB올인"]);
    const html = renderPage(solverLike("solver-test", [VS_4BET, btn, sb]));
    expect(texts(html.match(/<div class="chips scroll">(.*?)<\/div>/)![1])).toEqual(["BTN vs CO", "BTN: BTN오픈·SB3벳·BB올인", "SB: BTN오픈·SB3벳·BB올인"]);
  });

  it("charts page: no fold where the hero cannot fold", () => {
    const html = renderPage(solverLike("solver-test", [LIMP, rfi("SB")]));
    // From the spot's card on (the set picker above lists "푸시/폴드 내쉬").
    const spot = html.slice(html.indexOf('<section class="card-box">'));
    expect(stripTags(spot.match(/<div class="legend">(.*?)<\/div>/)![1])).toBe("레이즈 3.5bb 1.1%체크 98.9%");
    expect(spot).toContain("체크");
    expect(spot).not.toContain("폴드");
  });
});

// ───────────── The four hand-made / Nash sets behave exactly as before the solver fields ─────────────
// Each check compares with the code as it was (inlined here as `legacy…`), so it holds whatever their data.

const LEGACY_SETS = ["pub", "cash6", "nash", "shortnash"];
const legacySets = () => LEGACY_SETS.map((id) => CHART_SETS.find((s) => s.id === id)!);
const legacyActions = (s: ScenarioDef) => [FOLD, ...s.actions];
const legacyDescribe = (s: ScenarioDef, st: HandStrategy) =>
  [...s.actions, FOLD].map((a) => `${a.label} ${Math.round((st[a.key] ?? 0) * 100)}%`).join(" / ");
const legacyGrid = (scenario: Scenario) =>
  createElement(
    "div",
    { className: "grid ", role: "grid" },
    Array.from({ length: 13 }, (_, r) =>
      Array.from({ length: 13 }, (_, c) => {
        const h = gridHand(r, c);
        const st = scenario.strategy[h];
        return createElement(
          "button",
          {
            key: h,
            type: "button",
            className: `cell  ${st.fold >= 0.999 ? "folded" : ""}`,
            style: { background: strategyGradient(scenario, st) },
            tabIndex: -1,
            title: `${h}: ${legacyDescribe(scenario, st)}`,
          },
          h,
        );
      }),
    ),
  );

describe("existing chart sets are unchanged", () => {
  it("are all present, without any solver field", () => {
    expect(legacySets().every(Boolean)).toBe(true);
    expect(CHART_SETS[0].id).toBe("pub");
    for (const set of legacySets()) {
      expect(set.heroFilter, set.id).toBeUndefined();
      for (const s of allScenarios(set)) {
        expect([s.reachRange, s.noFold, s.weight], s.id).toEqual([undefined, undefined, undefined]);
        expect(["rfi", "vsOpen", "vs3bet", "vsShove"], s.id).toContain(s.kind);
      }
    }
  });

  it("keep their buttons, descriptions, totals and reach", () => {
    for (const set of legacySets()) {
      for (const s of allScenarios(set)) {
        expect(scenarioActions(s), s.id).toEqual(legacyActions(s));
        expect(legendActions(s), s.id).toEqual([...s.actions, FOLD]);
        expect(reachShare(s), s.id).toBe(1);
        expect(ALL_HANDS.every((h) => inReach(s, h)), s.id).toBe(true);
        // One comparison per spot: 169 expect calls per spot would make this the slowest test of the file.
        const now = ALL_HANDS.map((h) => describeStrategy(s, s.strategy[h])).join("\n");
        expect(now, s.id).toBe(ALL_HANDS.map((h) => legacyDescribe(s, s.strategy[h])).join("\n"));
      }
    }
  });

  it("keep their calculator ranges", () => {
    const legacyNamed = legacySets().flatMap((set) =>
      set.stages.flatMap((stage) =>
        stage.scenarios.flatMap((s) =>
          s.actions.map((a) => ({
            id: `${s.id}:${a.key}`,
            group: `${set.label} · ${stage.label}`,
            label: `${s.title} — ${a.label}`,
            range: Object.fromEntries(ALL_HANDS.map((h) => [h, s.strategy[h][a.key] ?? 0])),
          })),
        ),
      ),
    );
    expect(namedRanges(legacySets())).toEqual(legacyNamed);
    expect(NAMED_RANGES.filter((r) => LEGACY_SETS.includes(r.id.split("/")[0]))).toEqual(legacyNamed);
  });

  it("render the same grids", () => {
    // Every pub and cash6 spot, and the first stage of each Nash set (their stages differ only in the ranges).
    for (const set of legacySets()) {
      const stages = set.id === "nash" || set.id === "shortnash" ? [set.stages[0]] : set.stages;
      for (const s of stages.flatMap((st) => st.scenarios)) {
        expect(render(createElement(RangeGrid, { scenario: s })), s.id).toBe(render(legacyGrid(s)));
      }
    }
  });

  it("show their chips as they are (no list repeats a chip, so displayChips changes nothing)", () => {
    for (const set of legacySets())
      for (const st of set.stages)
        for (const kind of new Set(st.scenarios.map((s) => s.kind))) {
          const list = st.scenarios.filter((s) => s.kind === kind);
          expect(heroFilterSeats(set, list)).toEqual([]);
          expect(displayChips(list), `${set.id} ${st.id} ${kind}`).toEqual(list.map((s) => s.chip));
        }
  });

  it("show the same charts page: no seat row, no reach, all-hands totals", () => {
    for (const set of legacySets()) {
      const html = renderPage(undefined, set.id);
      expect(html).not.toContain("seat-filter");
      expect(html).not.toContain("도달");
      expect(html).not.toMatch(/class="[^"]*\bout\b/);
      // The page opens on the stage's first spot; its legend is the share of all 1326 combos, fold last.
      const s = set.stages[0].scenarios[0];
      const t = actionTotals(s);
      const want = [...s.actions, FOLD].map((a) => `${a.label} ${(t[a.key] * 100).toFixed(1)}%`).join("");
      expect(stripTags(html.match(/<div class="legend">(.*?)<\/div>/)![1]), set.id).toBe(want);
      // Every chip of the first group is there (Nash groups hold 36 and still scroll as one row).
      const first = set.stages[0].scenarios.filter((x) => x.kind === s.kind);
      expect(texts(html.match(/<div class="chips scroll">(.*?)<\/div>/)![1]), set.id).toEqual(first.map((x) => x.chip));
    }
  });
});
