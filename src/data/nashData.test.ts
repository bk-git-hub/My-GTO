import { describe, expect, it } from "vitest";
import { ALL_HANDS } from "../poker/cards";
import { EQR_FIT } from "../poker/preflop/eqrFit";
import { parseRange } from "../poker/range";
import { NASH } from "./sets/nash";
import { NASH_SOURCE, NASH_STAGES } from "./sets/nashData";
import type { PreflopStage } from "./sets/preflopTypes";
import { SHORT_NASH } from "./sets/shortNash";
import { SHORT_NASH_SOURCE, SHORT_NASH_STAGES } from "./sets/shortNashData";

/**
 * Data tests on the committed push/fold (nashData.ts) and open/jam (shortNashData.ts) charts, which
 * scripts/make-nash.mjs and scripts/make-shortnash.mjs solve with the preflop solver's DCFR engine
 * (docs/preflop-solver.md): the chart grid, the provenance, the convergence the files record, and nash 10bb against
 * the solver set's 10bb-pf stage (the same game, engine and schedule, so the same chart cell for cell).
 */

const values = (text: string) => {
  const r = parseRange(text);
  return ALL_HANDS.map((h) => r[h] ?? 0);
};
const onGrid = (v: number) => v >= 0 && v <= 1 && Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;
const SEATS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/** Every range string of a stage, with a name for messages. */
function nashRanges(st: (typeof NASH_STAGES)[number]): [string, string][] {
  return [
    ...Object.entries(st.push).map(([s, t]): [string, string] => [`${st.stack}bb push ${s}`, t]),
    ...Object.entries(st.call).flatMap(([c, m]) => Object.entries(m).map(([j, t]): [string, string] => [`${st.stack}bb ${c} call vs ${j}`, t])),
  ];
}
function shortRanges(st: (typeof SHORT_NASH_STAGES)[number]): [string, string][] {
  const out: [string, string][] = [];
  for (const k of ["open", "jam", "bbCall"] as const) for (const [s, t] of Object.entries(st[k])) out.push([`${st.stack}bb ${k} ${s}`, t]);
  for (const k of ["reJam", "callReJam", "callJam"] as const)
    for (const [a, m] of Object.entries(st[k])) for (const [b, t] of Object.entries(m)) out.push([`${st.stack}bb ${k} ${a} ${b}`, t]);
  return out;
}

describe("push/fold and open/jam charts (DCFR)", () => {
  it("put every frequency on the solver's 0.1 grid, with the actions of a spot summing to at most 1", () => {
    for (const st of NASH_STAGES) for (const [name, text] of nashRanges(st)) expect(values(text).every(onGrid), name).toBe(true);
    for (const st of SHORT_NASH_STAGES) {
      for (const [name, text] of shortRanges(st)) expect(values(text).every(onGrid), name).toBe(true);
      for (const seat of SEATS.slice(0, 8)) {
        const open = values(st.open[seat]), jam = values(st.jam[seat]);
        expect(open.every((x, h) => x + jam[h] <= 1 + 1e-9), `${st.stack}bb ${seat} open + jam`).toBe(true);
        const call = values(st.bbCall[seat]), rejam = values(st.reJam.BB[seat]);
        expect(call.every((x, h) => x + rejam[h] <= 1 + 1e-9), `${st.stack}bb BB vs ${seat}`).toBe(true);
      }
    }
  });

  it("cover every seat and seat pair", () => {
    for (const st of NASH_STAGES) {
      expect(Object.keys(st.push), `${st.stack}bb`).toEqual(SEATS.slice(0, 8));
      expect(Object.values(st.call).reduce((n, m) => n + Object.keys(m).length, 0), `${st.stack}bb`).toBe(36);
    }
    for (const st of SHORT_NASH_STAGES) {
      expect(Object.keys(st.open), `${st.stack}bb`).toEqual(SEATS.slice(0, 8));
      for (const k of ["reJam", "callReJam", "callJam"] as const)
        expect(Object.values(st[k]).reduce((n, m) => n + Object.keys(m).length, 0), `${st.stack}bb ${k}`).toBe(36);
    }
  });

  it("come from the DCFR engine on the solver's equity table, converged as the gates require", () => {
    expect(NASH_SOURCE.engine).toBe("dcfr");
    expect(SHORT_NASH_SOURCE.engine).toBe("dcfr");
    expect(NASH_SOURCE.equityTable).toBe(EQR_FIT.equityTable);
    expect(SHORT_NASH_SOURCE.equityTable).toBe(EQR_FIT.equityTable);
    for (const st of [...NASH_STAGES, ...SHORT_NASH_STAGES]) {
      // §4.6: checks at 1,500 and every 250 after; the snapped chart within the 3 mbb/hand snapped-gain gate.
      expect(st.iterations >= 1500 && (st.iterations - 1500) % 250 === 0, `${st.stack}bb iterations ${st.iterations}`).toBe(true);
      expect(st.exploitability, `${st.stack}bb`).toBeLessThanOrEqual(0.003);
    }
    // Push/fold converges fast: every stack at the first check, far inside the gates (the fictitious-play file was
    // 0.5–15 mbb/hand from equilibrium).
    for (const st of NASH_STAGES) {
      expect(st.iterations, `${st.stack}bb`).toBe(1500);
      expect(st.nashConvMbb, `${st.stack}bb`).toBeLessThan(0.5);
    }
  });

  it("say DCFR in the set texts", () => {
    for (const set of [NASH, SHORT_NASH]) {
      expect(set.label).toContain("DCFR");
      expect(set.source).toContain("DCFR");
      for (const st of set.stages) expect(st.description).toContain("DCFR");
    }
    expect(SHORT_NASH.source).toContain("12~25bb");
  });
});

// The solver set's stage files (src/data/sets/preflopStages/<id>.ts, written by scripts/make-preflop.mjs).
const STAGES = Object.values(import.meta.glob<PreflopStage>("./sets/preflopStages/*.ts", { import: "default", eager: true }));
const PF10 = STAGES.find((s) => s.id === "10bb-pf");

describe("nash 10bb and the solver's 10bb-pf stage", () => {
  // The same game (pushFoldConfig = the 10bb-pf preset's tree), engine, schedule and snapping: the same chart. Runs
  // whenever the solver data ships the 10bb-pf stage.
  it.skipIf(!PF10)("are the same chart, cell for cell", () => {
    const stage = PF10!;
    const nash = NASH_STAGES.find((s) => s.stack === 10)!;
    expect(stage.scenarios).toHaveLength(44);
    let cells = 0;
    for (const sc of stage.scenarios) {
      expect(sc.actions, sc.id).toHaveLength(1);
      const ours = sc.kind === "rfi" ? nash.push[sc.hero] : sc.kind === "vsShove" ? nash.call[sc.hero]?.[sc.villain ?? ""] : undefined;
      expect(ours, `${sc.id} has no nash counterpart`).toBeDefined();
      const a = values(sc.actions[0].range), b = values(ours!);
      ALL_HANDS.forEach((h, i) => expect(a[i], `${sc.id} ${h}`).toBe(b[i]));
      cells += ALL_HANDS.length;
    }
    expect(cells).toBe(44 * 169);
  });
});
