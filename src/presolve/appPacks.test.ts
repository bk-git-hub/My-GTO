import { describe, expect, it } from "vitest";
import { PREFLOP_STAGES } from "../data/sets/preflopData";
import { ALL_HANDS, parseCards } from "../poker/cards";
import { parseRange, rangeToString } from "../poker/range";
import { estimateMemory } from "../solver/index";
import { APP_RANGE_LINES, APP_RANGES, APP_STAGE_SOLVES } from "./appRanges";
import { CAL_RANGES } from "./calRanges";
import { canonicalBoard, splitManifest, validateCatalog } from "./format";
import {
  ALL_SCENARIOS,
  APP_QUEUE,
  APP_STAGES,
  CAL_SCENARIOS,
  LINE_SEP,
  SCENARIOS,
  TREE_OOP_AGGR,
  TREE_SRP,
  appRange,
  chartRange,
  calRange,
  getScenario,
  huPotStack,
  lineRange,
  plannedPacks,
  rangeWeights,
  solverInput,
} from "./scenarios";
import { jobQueue } from "./shard";

const APP = SCENARIOS.filter((s) => s.id.startsWith("sv-"));
const stageOf = (id: string) => getScenario(id).spot!.stage;
const refsOf = (src: string) => src.split(LINE_SEP);
const treeOf = (sc: (typeof APP)[number]) => ({ sizes: sc.meta.sizes, raiseLimit: sc.meta.raiseLimit, addAllIn: sc.meta.addAllIn, allInThreshold: sc.meta.allInThreshold, minBet: sc.meta.minBet });

/** Pot and stack worked by hand: pot = 2 × put + dead blinds + the BB's ante; stack = start − put (the BB also − ante). */
const POT_STACK: Record<string, [number, number]> = {
  "sv-srp-utg-bb-55": [5.9, 51.8], // 2·2.2 + 0.5 + 1; 55 − 2.2 − 1
  "sv-srp-hj-bb-55": [5.9, 51.8],
  "sv-srp-co-bb-55": [5.9, 51.8],
  "sv-srp-btn-bb-55": [5.9, 51.8],
  "sv-srp-sb-bb-55": [7, 51], // 2·3 + 1 (the SB's raise is called, nobody's blind is dead); 55 − 3 − 1
  "sv-3bp-bb-btn-55": [19.1, 45.2], // 2·8.8 + 0.5 (SB) + 1; 55 − 8.8 − 1
  "sv-3bp-btn-co-55": [15.7, 48.4], // 2·6.6 + 0.5 + 1 (both blinds dead) + 1; 55 − 6.6
  "sv-3bp-sb-btn-55": [19.6, 46.2], // 2·8.8 + 1 (BB) + 1; 55 − 8.8
  "sv-srp-utg-bb-35": [5.5, 32], // 2·2 + 0.5 + 1; 35 − 2 − 1
  "sv-srp-hj-bb-35": [5.5, 32],
  "sv-srp-co-bb-35": [5.5, 32],
  "sv-srp-btn-bb-35": [5.5, 32],
  "sv-srp-sb-bb-35": [6, 31.5], // 2·2.5 + 1; 35 − 2.5 − 1
  "sv-3bp-bb-btn-35": [17.5, 26], // 2·8 + 0.5 + 1; 35 − 8 − 1
  "sv-3bp-btn-co-35": [14.5, 29], // 2·6 + 1.5 + 1; 35 − 6
  "sv-3bp-sb-btn-35": [18, 27], // 2·8 + 1 + 1; 35 − 8
  "sv-srp-utg-bb-100": [5.9, 96.8],
  "sv-srp-hj-bb-100": [5.9, 96.8],
  "sv-srp-co-bb-100": [5.9, 96.8],
  "sv-srp-btn-bb-100": [5.9, 96.8],
  "sv-srp-sb-bb-100": [7, 96],
  "sv-3bp-bb-btn-100": [19.1, 90.2],
  "sv-3bp-btn-co-100": [15.7, 93.4],
  "sv-3bp-sb-btn-100": [19.6, 91.2],
};

describe("the app's solver-chart packs", () => {
  it("are the 24 pub-priority heads-up spots, after the app's first three packs, with short Korean titles", () => {
    expect(SCENARIOS.slice(0, 3).map((s) => s.id)).toEqual(["srp-btn-bb-100", "pub-srp-btn-bb-55", "pub-srp-utg-bb-55"]);
    expect(APP.map((s) => s.id)).toEqual(Object.keys(POT_STACK));
    expect(SCENARIOS).toHaveLength(27);
    expect(new Set(ALL_SCENARIOS.map((s) => s.id)).size).toBe(ALL_SCENARIOS.length);
    const titles: Record<string, string> = {
      "srp-utg-bb": "UTG 오픈 vs BB 콜",
      "srp-hj-bb": "HJ 오픈 vs BB 콜",
      "srp-co-bb": "CO 오픈 vs BB 콜",
      "srp-btn-bb": "BTN 오픈 vs BB 콜",
      "srp-sb-bb": "SB 오픈 vs BB 콜",
      "3bp-bb-btn": "BB 3벳 vs BTN 콜",
      "3bp-btn-co": "BTN 3벳 vs CO 콜",
      "3bp-sb-btn": "SB 3벳 vs BTN 콜",
    };
    for (const sc of APP) {
      const [, kind, tag] = /^sv-(.+)-(55|35|100)$/.exec(sc.id)!;
      expect(sc.title).toBe(`${titles[kind]} · ${tag}bb`);
      expect(sc.set).toBe("app");
      expect(sc.version).toBe(1);
      expect(sc.tier).toBe("free");
      expect(sc.startStack).toBe(Number(tag));
      expect(sc.meta.preflop).toMatch(new RegExp(`\\(9인 모두 ${tag}bb, BB 앤티 1bb\\)$`));
      expect(sc.meta).toMatchObject({ format: "pub", iterations: 300, targetExploitability: 0.5, flopSet: "priority" });
      expect(sc.spot).toMatchObject({ chart: "solver", stage: Object.keys(APP_STAGES).find((k) => APP_STAGES[k] === tag), stack: Number(tag) });
    }
    expect(getScenario("sv-srp-hj-bb-55").meta.preflop).toBe("HJ 2.2bb 오픈, 나머지 폴드, BB 콜 (9인 모두 55bb, BB 앤티 1bb)");
    expect(getScenario("sv-3bp-bb-btn-35").meta.preflop).toBe("BTN 2bb 오픈, SB 폴드, BB 3벳 8bb, BTN 콜 (9인 모두 35bb, BB 앤티 1bb)");
  });

  it("derive pot and stack from the stage's sizes as worked by hand", () => {
    for (const sc of APP) {
      const [pot, stack] = POT_STACK[sc.id];
      expect({ id: sc.id, pot: sc.meta.pot, stack: sc.meta.stack }).toEqual({ id: sc.id, pot, stack });
      // The put is the last size on the line of the IP or OOP spot, and the stage's sizes give it.
      const st = APP_STAGE_SOLVES[stageOf(sc.id)];
      const z = st.sizes!;
      const put = sc.id.startsWith("sv-srp-sb") ? z.sbRaise : sc.id.startsWith("sv-srp") ? st.open : sc.id.startsWith("sv-3bp-btn-co") ? z.ip3 * st.open : z.blind3 * st.open;
      expect(huPotStack({ start: st.stack, seats: sc.meta.positions, put: Math.round(put * 1000) / 1000, bbAnte: 1 })).toEqual({ pot, stack });
    }
  });

  it("start from the shipped solver chart's ranges, pinned, along each player's own line", () => {
    const used = new Set<string>();
    for (const sc of APP) {
      const stage = stageOf(sc.id);
      const shipped = PREFLOP_STAGES.find((s) => s.id === stage)!;
      const rec = APP_STAGE_SOLVES[stage];
      expect(rec).toMatchObject({ stack: shipped.stack, open: shipped.open, model: "modelB-rank9" });
      const same = rec.fitHash === shipped.model.fitHash.slice(0, 12) && rec.equityTable === shipped.equityTable.slice(0, 12);
      if (same) expect(rec.sizes).toEqual(shipped.sizes);
      sc.meta.rangeSources!.forEach((src, p) => {
        const parts = refsOf(src);
        parts.forEach((ref, k) => {
          used.add(ref);
          expect(APP_RANGES[ref], ref).toBeDefined();
          const [, refStage, spot, action] = /^solver\/([^/]+)\/([^:]+):(.+)$/.exec(ref)!;
          expect(refStage).toBe(stage);
          const scn = shipped.scenarios.find((x) => x.id === spot);
          expect(scn, ref).toBeDefined();
          expect(scn!.actions.some((a) => a.key === action), ref).toBe(true);
          expect(scn!.line, ref).toBe(APP_RANGE_LINES[ref]);
          if (k === 0) expect(scn!.reachFrom, ref).toBeUndefined();
          else expect(scn!.reachFrom, ref).toEqual(parts.slice(0, k).map((r) => r.split("/")[2]));
          // While the shipped chart is the pinned one, the pins are its numbers, and agree with the calibration pins.
          if (same) {
            const pinned = appRange(ref), chart = chartRange(ref);
            for (const h of ALL_HANDS) expect(Math.abs((pinned[h] ?? 0) - (chart[h] ?? 0)), `${ref} ${h}`).toBeLessThan(1e-9);
          }
          if (CAL_RANGES[ref] !== undefined) expect(APP_RANGES[ref], ref).toBe(CAL_RANGES[ref]);
        });
        // The flop range is the product along the line, written exactly; no ghost combos.
        const r = lineRange(src, appRange);
        expect(sc.meta.ranges[p]).toBe(rangeToString(r));
        const w = rangeWeights(r);
        for (let i = 0; i < 1326; i++) expect(sc.ranges[p][i]).toBe(w[i]);
        expect(rangeWeights(parseRange(sc.meta.ranges[p]))).toEqual(w);
      });
    }
    expect(Object.keys(APP_RANGES).sort()).toEqual(Object.keys(APP_RANGE_LINES).sort());
    for (const ref of Object.keys(APP_RANGES)) expect(used.has(ref), ref).toBe(true);
    // The 3-bet caller brings its open × its call; the 3-bettor its 3-bets.
    const P = "solver/55bb-2.2";
    expect(getScenario("sv-3bp-bb-btn-55").meta.rangeSources).toEqual([`${P}/bb-vs-btn-open:3bet`, `${P}/rfi-btn:open${LINE_SEP}${P}/btn-open-vs-bb-3bet:call`]);
    expect(getScenario("sv-3bp-btn-co-55").meta.rangeSources).toEqual([`${P}/rfi-co:open${LINE_SEP}${P}/co-open-vs-btn-3bet:call`, `${P}/btn-vs-co-open:3bet`]);
    expect(getScenario("sv-3bp-sb-btn-55").meta.rangeSources).toEqual([`${P}/sb-vs-btn-open:3bet`, `${P}/rfi-btn:open${LINE_SEP}${P}/btn-open-vs-sb-3bet:call`]);
    expect(getScenario("sv-srp-sb-bb-55").meta.rangeSources).toEqual([`${P}/rfi-sb:raise`, `${P}/bb-vs-sb-open:call`]);
    expect(getScenario("sv-srp-hj-bb-55").meta.rangeSources).toEqual([`${P}/bb-vs-hj-open:call`, `${P}/rfi-hj:open`]);
    expect(() => appRange("solver/55bb-2.2/rfi-lj:open")).toThrow(/--app/);
    // The calibration packs keep their own pins (calRange), untouched.
    expect(CAL_SCENARIOS.every((s) => s.meta.rangeSources!.every((src) => refsOf(src).every((ref) => calRange(ref))))).toBe(true);
  });

  it("give the preflop aggressor its betting and are full, viewable files", () => {
    for (const sc of APP) {
      const want = sc.meta.aggressor === 1 ? TREE_SRP : TREE_OOP_AGGR;
      expect(treeOf(sc), sc.id).toEqual(want);
      const [, , raiser, caller] = /^sv-(srp|3bp)-([a-z]+)-([a-z]+)-/.exec(sc.id)!;
      expect(sc.meta.positions[sc.meta.aggressor as 0 | 1].toLowerCase(), sc.id).toBe(raiser);
      expect(sc.meta.positions[1 - (sc.meta.aggressor as 0 | 1)].toLowerCase(), sc.id).toBe(caller);
      expect(sc.spot!.raiser.toLowerCase()).toBe(raiser);
      expect(sc.spot!.caller.toLowerCase()).toBe(caller);
      for (const k of ["ghostWeight", "storage"]) expect(k in sc.meta, `${sc.id} ${k}`).toBe(false);
      expect("compress" in sc.meta, sc.id).toBe(sc.id.startsWith("sv-srp-sb-bb-"));
      expect(solverInput(sc, canonicalBoard(parseCards("Qs8h5h")).cards).compress === true).toBe(sc.id.startsWith("sv-srp-sb-bb-"));
    }
    // The IP raisers (UTG/HJ/CO/BTN opens, the BTN's 3-bet) keep the first packs' tree; the SB and the blinds' 3-bets OOP.
    expect(APP.filter((s) => s.meta.aggressor === 0).map((s) => s.id.replace(/-\d+$/, ""))).toEqual(
      ["sv-srp-sb-bb", "sv-3bp-bb-btn", "sv-3bp-sb-btn", "sv-srp-sb-bb", "sv-3bp-bb-btn", "sv-3bp-sb-btn", "sv-srp-sb-bb", "sv-3bp-bb-btn", "sv-3bp-sb-btn"],
    );
  });

  it("fit a quarter of a 16 GB runner and the job's --max-mb 2000 on every board", () => {
    for (const sc of APP)
      for (const raw of ["AhKd7c", "Qs8h5h", "9h8h6h", "7d7c2h"]) {
        const m = estimateMemory(solverInput(sc, canonicalBoard(parseCards(raw)).cards));
        expect(m.bytes, `${sc.id} ${raw}`).toBeLessThan(1.95e9);
        expect(4 * 1.25 * m.bytes).toBeLessThan(0.85 * 16e9);
      }
    // Why the SB's open is compressed: in Float32 its rainbow flops pass --max-mb at 55bb and 100bb.
    const rainbow = canonicalBoard(parseCards("AhKd7c")).cards;
    expect(estimateMemory({ ...solverInput(getScenario("sv-srp-sb-bb-100"), rainbow), compress: false }).bytes).toBeGreaterThan(2e9);
  });

  it("are solved before every calibration pack: the SRPs at 55 and 35bb, then their 3-bet pots, then 100bb", () => {
    for (const [kind, stage, queue] of APP_QUEUE) {
      const sc = getScenario(`sv-${kind}-${APP_STAGES[stage]}`);
      expect(sc.queue).toBe(queue);
      expect(queue).toBe(stage === "100bb-2.2" ? -1 : kind.startsWith("3bp") ? -2 : -3);
    }
    for (const sc of [...SCENARIOS.slice(0, 3), ...CAL_SCENARIOS]) expect(sc.queue).toBeGreaterThanOrEqual(0);
    const order = jobQueue(ALL_SCENARIOS.map((sc) => ({ queue: sc.queue, jobs: [`${sc.id}#0`, `${sc.id}#1`, `${sc.id}#2`] }))).map((j) => j.split("#")[0]);
    const lastApp = Math.max(...APP.map((s) => order.lastIndexOf(s.id)));
    const firstCal = Math.min(...CAL_SCENARIOS.map((s) => order.indexOf(s.id)));
    expect(lastApp).toBeLessThan(firstCal);
    // Within a wave the packs are interleaved: the first 10 jobs are one flop of each SRP at 55 and 35bb.
    expect(new Set(order.slice(0, 10))).toEqual(new Set(APP.filter((s) => s.queue === -3).map((s) => s.id)));
    expect(order.indexOf("sv-3bp-bb-btn-55")).toBeGreaterThan(order.lastIndexOf("sv-srp-utg-bb-35"));
    expect(order.indexOf("sv-srp-utg-bb-100")).toBeGreaterThan(order.lastIndexOf("sv-3bp-sb-btn-35"));
  });

  it("carry the chart's lowest confidence of their spots, pinned with the ranges (12 of 24 start from a range rated 낮음)", () => {
    const RANK = { low: 0, mid: 1, high: 2 } as const;
    for (const sc of APP) {
      const stage = stageOf(sc.id);
      const shipped = PREFLOP_STAGES.find((s) => s.id === stage)!;
      const spots = sc.meta.rangeSources!.flatMap(refsOf).map((ref) => ref.split("/")[2].split(":")[0]);
      for (const id of spots) expect(APP_STAGE_SOLVES[stage].confidence?.[id], `${stage} ${id}`).toBe(shipped.scenarios.find((x) => x.id === id)!.confidence);
      const lowest = spots.map((id) => APP_STAGE_SOLVES[stage].confidence![id]).sort((a, b) => RANK[a] - RANK[b])[0];
      expect(sc.spot!.confidence, sc.id).toBe(lowest);
    }
    // The data review's list, from the chart's own confidence field.
    expect(APP.filter((sc) => sc.spot!.confidence === "low").map((sc) => sc.id).sort()).toEqual(
      [
        "sv-srp-sb-bb-55",
        "sv-srp-sb-bb-35",
        "sv-srp-sb-bb-100",
        "sv-srp-co-bb-35",
        "sv-srp-btn-bb-35",
        "sv-3bp-bb-btn-35",
        "sv-3bp-bb-btn-100",
        "sv-3bp-btn-co-55",
        "sv-3bp-btn-co-35",
        "sv-3bp-btn-co-100",
        "sv-3bp-sb-btn-55",
        "sv-3bp-sb-btn-35",
      ].sort(),
    );
  });

  it("are listed as planned in the catalog until they have files", () => {
    const planned = plannedPacks(new Set(["srp-btn-bb-100", "pub-srp-btn-bb-55", "pub-srp-utg-bb-55", "sv-srp-btn-bb-55"]));
    expect(planned.map((p) => p.id)).toEqual(APP.map((s) => s.id).filter((id) => id !== "sv-srp-btn-bb-55"));
    expect(planned[0]).toEqual({
      id: "sv-srp-utg-bb-55",
      title: "UTG 오픈 vs BB 콜 · 55bb",
      pot: 5.9,
      stack: 51.8,
      spot: { chart: "solver", stage: "55bb-2.2", stack: 55, pot: "srp", raiser: "UTG", caller: "BB", confidence: "mid" },
    });
    const { catalog } = splitManifest({ v: 1, packs: [] }, { planned }, () => "0".repeat(64));
    expect(validateCatalog(catalog)).toEqual([]);
  });
});
