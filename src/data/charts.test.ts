import { describe, expect, it } from "vitest";
import { ALL_HANDS } from "../poker/cards";
import { actionTotals, allScenarios, CHART_SETS, getSet, NAMED_RANGES } from "./charts";

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

  it("yajasu: later seats never play fewer hands than earlier seats (first-in)", () => {
    const order = ["UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BTN"];
    for (const stage of getSet("yajasu").stages) {
      const rfi = Object.fromEntries(stage.scenarios.filter((s) => s.kind === "rfi").map((s) => [s.hero, s]));
      for (let i = 1; i < order.length; i++) {
        const prev = rfi[order[i - 1]], cur = rfi[order[i]];
        for (const h of ALL_HANDS) {
          expect(playFreq(cur, h), `${stage.id} ${order[i]} ${h} vs ${order[i - 1]}`).toBeGreaterThanOrEqual(playFreq(prev, h));
        }
      }
    }
  });

  it("yajasu: shove ranges widen from 17bb to 11bb", () => {
    const set = getSet("yajasu");
    const short = set.stages.find((s) => s.id === "short")!;
    const push = set.stages.find((s) => s.id === "push")!;
    for (const s of push.scenarios.filter((x) => x.kind === "rfi")) {
      const t = short.scenarios.find((x) => x.kind === "rfi" && x.hero === s.hero)!;
      const w17 = 1 - actionTotals(t).fold;
      const w11 = 1 - actionTotals(s).fold;
      expect(w11, s.hero).toBeGreaterThanOrEqual(w17);
    }
  });

  it("yajasu: spot checks against the chat", () => {
    const set = getSet("yajasu");
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
