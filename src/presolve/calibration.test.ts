import { describe, expect, it } from "vitest";
import { ALL_HANDS, comboCount, parseCards } from "../poker/cards";
import { parseRange, rangeToString } from "../poker/range";
import { EQR_FIT } from "../poker/preflop/eqrFit";
import { estimateMemory } from "../solver/index";
import { CAL_RANGES, CAL_STAGE_SOLVES } from "./calRanges";
import { canonicalBoard, validateManifest, type Manifest } from "./format";
import {
  ALL_SCENARIOS,
  CAL_SCENARIOS,
  GHOST_WEIGHT,
  PACK_SET_DIRS,
  SCENARIOS,
  TREE_SRP,
  calRange,
  getScenario,
  ghostRangeString,
  rangeWeights,
  solverInput,
  weightedCombos,
  withGhosts,
} from "./scenarios";
import { misplacedPacks, setDirs, writesCommitted } from "./sets";

// No @types/node here: reach node:fs through an untyped handle (as cardColors.test.tsx does).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { existsSync(path: string): boolean; readFileSync(path: string, encoding: "utf8"): string };
const root = new URL("../../", import.meta.url).pathname;
const readManifest = (dir: string): Manifest | null => {
  const file = `${root}${dir}/manifest.json`;
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Manifest) : null;
};
/** Combo-weighted share of all hands. */
const share = (r: Record<string, number>) => ALL_HANDS.reduce((s, h) => s + (r[h] ?? 0) * comboCount(h), 0) / 1326;

describe("calibration packs", () => {
  it("are the short stages' own BTN-open, BB-call single raised pots at SPR 3.1 and 2.2", () => {
    expect(CAL_SCENARIOS.map((s) => s.id)).toEqual(["cal-srp-btn-bb-20", "cal-srp-btn-bb-15"]);
    const want = { "cal-srp-btn-bb-20": { start: 20, stack: 17, spr: 3.09 }, "cal-srp-btn-bb-15": { start: 15, stack: 12, spr: 2.18 } };
    for (const sc of CAL_SCENARIOS) {
      const w = want[sc.id as keyof typeof want];
      expect(sc.set).toBe("calibration");
      expect(sc.startStack).toBe(w.start);
      // 9-handed, 1bb BB ante: pot 2 × 2 + 0.5 + 1, stack start − open − ante.
      expect(sc.meta).toMatchObject({ format: "pub", positions: ["BB", "BTN"], pot: 5.5, stack: w.stack, ghostWeight: GHOST_WEIGHT, iterations: 300, targetExploitability: 0.5 });
      expect(sc.meta.stack / sc.meta.pot).toBeCloseTo(w.spr, 2);
      expect(sc.meta.rangeSources).toEqual([`solver/${w.start}bb-2/bb-vs-btn-open:call`, `solver/${w.start}bb-2/rfi-btn:open`]);
      // The app packs' tree, so the rows differ from theirs in stack depth and ranges only.
      expect({ sizes: sc.meta.sizes, raiseLimit: sc.meta.raiseLimit, addAllIn: sc.meta.addAllIn, allInThreshold: sc.meta.allInThreshold, minBet: sc.meta.minBet }).toEqual(TREE_SRP);
      expect(sc.meta.preflop).toContain(`${w.start}bb`);
      expect(sc.title).toContain("보정");
    }
  });

  it("start from the draft-solved chart ranges plus a ghost floor on both sides", () => {
    for (const sc of CAL_SCENARIOS) {
      sc.meta.rangeSources!.forEach((ref, p) => {
        const src = calRange(ref);
        // The source is a chart range: snapped to tenths, so a class at exactly GHOST_WEIGHT is a ghost.
        for (const h of ALL_HANDS) expect(Math.abs((src[h] ?? 0) * 10 - Math.round((src[h] ?? 0) * 10))).toBeLessThan(1e-9);
        const ghosted = withGhosts(src);
        for (const h of ALL_HANDS) expect(ghosted[h]).toBe((src[h] ?? 0) > 0 ? src[h] : GHOST_WEIGHT);
        const w = sc.ranges[p];
        const expected = rangeWeights(ghosted);
        for (let i = 0; i < 1326; i++) {
          expect(w[i]).toBe(expected[i]);
          expect(w[i]).toBeGreaterThanOrEqual(Math.fround(GHOST_WEIGHT));
        }
        // The manifest's range string is the ghosted range, exactly.
        expect(sc.meta.ranges[p]).toBe(ghostRangeString(src, GHOST_WEIGHT));
        const back = rangeWeights(parseRange(sc.meta.ranges[p]));
        for (let i = 0; i < 1326; i++) expect(back[i]).toBe(w[i]);
        // Ghosts are a small part of the range: at most 12% of its weighted combos (the 15bb BTN open is the
        // narrowest range, 12.6% of hands, so its ghosts weigh the most).
        const ghostMass = weightedCombos(w) - weightedCombos(rangeWeights(src));
        expect(ghostMass / weightedCombos(w)).toBeLessThan(0.12);
        expect(ghostMass).toBeGreaterThan(0);
      });
    }
    // The ranges as solved (CAL_STAGE_SOLVES records the same shares): the BB flats 55% / 43% against the BTN's
    // 2bb open of 23% / 13% of hands (at 15bb the BTN jams most of what it plays).
    const bounds: Record<string, [number, number]> = {
      "solver/20bb-2/bb-vs-btn-open:call": [0.5, 0.6],
      "solver/20bb-2/rfi-btn:open": [0.19, 0.27],
      "solver/15bb-2/bb-vs-btn-open:call": [0.38, 0.48],
      "solver/15bb-2/rfi-btn:open": [0.1, 0.16],
    };
    expect(Object.keys(CAL_RANGES).sort()).toEqual(Object.keys(bounds).sort());
    for (const [ref, [lo, hi]] of Object.entries(bounds)) {
      const s = share(calRange(ref));
      expect(s, ref).toBeGreaterThan(lo);
      expect(s, ref).toBeLessThan(hi);
      const [, stage, rest] = /^solver\/([^/]+)\/(.+)$/.exec(ref)!;
      expect(CAL_STAGE_SOLVES[stage].shares[rest]).toBeCloseTo(s * 100, 0);
    }
    // The BB's call is capped: its premium hands jam, so they are ghosts here; its trash folds, and is a ghost too.
    const bb20 = calRange("solver/20bb-2/bb-vs-btn-open:call");
    for (const h of ["AA", "KK", "AKs", "72o"]) expect(bb20[h as keyof typeof bb20] ?? 0).toBe(0);
    expect(() => calRange("solver/20bb-2/rfi-co:open")).toThrow(/cal-ranges/);
  });

  it("write a ghost floor of any size exactly in the range string", () => {
    const src = calRange("solver/15bb-2/rfi-btn:open");
    for (const floor of [0.02, 0.01, 0.005, 0.002]) {
      const text = ghostRangeString(src, floor);
      const back = parseRange(text);
      for (const h of ALL_HANDS) expect(back[h]).toBe((src[h] ?? 0) > 0 ? src[h] : floor);
    }
    // rangeToString alone rounds 0.005 to 0.01 and drops 0.002, which is why the ghosts are written separately.
    expect(parseRange(rangeToString(withGhosts(src, 0.005)))["72o"]).toBe(0.01);
    expect(parseRange(rangeToString(withGhosts(src, 0.002)))["72o"] ?? 0).toBe(0);
    expect(() => ghostRangeString({ ...src, "72o": 0.001 }, 0.02)).toThrow(/below the ghost floor/);
    expect(ghostRangeString(withGhosts({}, 1), 0.02)).toBe(rangeToString(withGhosts({}, 1)));
  });

  it("record solves made with the realization fit and stage presets the app ships", () => {
    for (const sc of CAL_SCENARIOS) {
      const stage = `${sc.startStack}bb-2`;
      const solve = CAL_STAGE_SOLVES[stage];
      expect(solve).toMatchObject({ stack: sc.startStack, open: 2, model: "modelB-rank9" });
      expect(solve.fitHash).toBe(EQR_FIT.sha256.slice(0, 12));
      expect(solve.equityTable).toBe(EQR_FIT.equityTable.slice(0, 12));
      expect(solve.iterations).toBeGreaterThanOrEqual(1500);
      expect(solve.nashConvMbb).toBeLessThan(5); // the §4.6 gate
    }
  });

  it("never enter the app's packs", () => {
    // The app's three packs are unchanged and stay the only "app" packs.
    expect(SCENARIOS.map((s) => s.id)).toEqual(["srp-btn-bb-100", "pub-srp-btn-bb-55", "pub-srp-utg-bb-55"]);
    for (const sc of SCENARIOS) {
      expect(sc.set).toBe("app");
      expect("ghostWeight" in sc.meta).toBe(false);
    }
    expect(ALL_SCENARIOS).toEqual([...SCENARIOS, ...CAL_SCENARIOS]);
    expect(new Set(ALL_SCENARIOS.map((s) => s.id)).size).toBe(ALL_SCENARIOS.length);
    for (const sc of CAL_SCENARIOS) {
      expect(sc.id.startsWith("cal-")).toBe(true);
      expect(getScenario(sc.id)).toBe(sc);
    }
    // The calibration manifest lives outside public/, so it is never deployed and the app's pack client (which reads
    // `${BASE_URL}packs/manifest.json`, src/features/solver/packs.ts) can't reach it.
    expect(PACK_SET_DIRS.app).toBe("public/packs");
    expect(PACK_SET_DIRS.calibration.startsWith("public/")).toBe(false);
    const app = readManifest(PACK_SET_DIRS.app)!;
    const appIds = new Set(SCENARIOS.map((s) => s.id));
    for (const p of app.packs) expect(appIds.has(p.id), p.id).toBe(true);
    // The app packs' settings are byte-identical to what their manifest entries were solved with.
    for (const sc of SCENARIOS) {
      const entry = app.packs.find((p) => p.id === sc.id)!;
      expect(entry.version).toBe(sc.version);
      expect(JSON.stringify(entry.scenario)).toBe(JSON.stringify(sc.meta));
    }
    const cal = readManifest(PACK_SET_DIRS.calibration);
    if (cal) {
      expect(validateManifest(cal)).toEqual([]);
      for (const p of cal.packs) expect(CAL_SCENARIOS.some((s) => s.id === p.id), p.id).toBe(true);
    }
  });

  it("are routed to their own directory and manifest by the presolve script", () => {
    const committed = { app: "/repo/public/packs", calibration: "/repo/calibration/packs" };
    // Default --out: both committed directories.
    expect(setDirs({ out: "/repo/public/packs", committed })).toEqual(committed);
    expect(setDirs({ out: "/repo/public/packs/", committed })).toEqual(committed);
    // A scratch --out keeps the calibration packs inside it, never in the committed directory.
    expect(setDirs({ out: "/tmp/x", committed })).toEqual({ app: "/tmp/x", calibration: "/tmp/x/calibration" });
    expect(setDirs({ out: "/tmp/x", calOut: "/tmp/y", committed })).toEqual({ app: "/tmp/x", calibration: "/tmp/y" });
    expect(() => setDirs({ out: "/tmp/x", calOut: "/tmp/x/", committed })).toThrow(/--cal-out/);
    // The experiment guards apply when a covered set writes into a committed directory.
    expect(writesCommitted(committed, ["app", "calibration"], committed)).toBe(true);
    expect(writesCommitted({ app: "/tmp/x", calibration: "/repo/calibration/packs" }, ["calibration"], committed)).toBe(true);
    expect(writesCommitted({ app: "/repo/public/packs", calibration: "/tmp/c" }, ["calibration"], committed)).toBe(false);
    expect(writesCommitted({ app: "/tmp/x", calibration: "/tmp/x/calibration" }, ["app", "calibration"], committed)).toBe(false);
    // A pack in the other set's manifest is refused (unknown ids are left alone, as the script always did).
    expect(misplacedPacks(["srp-btn-bb-100", "cal-srp-btn-bb-20", "old-pack"], "app", ALL_SCENARIOS)).toEqual(["cal-srp-btn-bb-20"]);
    expect(misplacedPacks(["cal-srp-btn-bb-20", "cal-srp-btn-bb-15"], "calibration", ALL_SCENARIOS)).toEqual([]);
    expect(misplacedPacks(["pub-srp-btn-bb-55"], "calibration", ALL_SCENARIOS)).toEqual(["pub-srp-btn-bb-55"]);
  });

  it("keep every flop solve under ~1.5 GB by the solver's estimate", () => {
    // Every combo has weight (ghosts), so the estimate depends on the board's suit pattern only: 430 MB monotone,
    // 902 MB two-tone, 1,476 MB rainbow (all 1,755 flops; mean 918 MB), with 76,054 action nodes at both stacks.
    for (const sc of CAL_SCENARIOS)
      for (const raw of ["AhKd7c", "9h8h6h", "7d7c2h", "Qs8h5h"]) {
        const board = canonicalBoard(parseCards(raw)).cards;
        const m = estimateMemory(solverInput(sc, board));
        expect(m.bytes).toBeLessThan(1.5e9);
        expect(m.actionNodes).toBe(76054);
      }
  });
});
