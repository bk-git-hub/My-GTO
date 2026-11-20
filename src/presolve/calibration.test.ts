import { describe, expect, it } from "vitest";
import { ALL_HANDS, comboCount, parseCards } from "../poker/cards";
import { parseRange, rangeToString } from "../poker/range";
import { EQR_FIT } from "../poker/preflop/eqrFit";
import { COMBOS } from "../play/handInfo";
import { PREFLOP_STAGES } from "../data/sets/preflopData";
import * as solver from "../solver/index";
import { estimateMemory } from "../solver/index";
import type { SolverInput } from "../solver/types";
import { CAL_RANGE_LINES, CAL_RANGES, CAL_STAGE_SOLVES } from "./calRanges";
import { compatibleWeights, extractFlop, summarizeFile } from "./extract";
import {
  COMBO_CLASS,
  NUM_CLASSES,
  Q_MAX,
  canonicalBoard,
  decodeClassRange,
  decodeFlopFile,
  decodeRange,
  encodeClassRange,
  encodeRange,
  validateFlopFile,
  validateManifest,
  type Manifest,
} from "./format";
import {
  ALL_SCENARIOS,
  CAL_SCENARIOS,
  GHOST_WEIGHT,
  LINE_SEP,
  PACK_SET_DIRS,
  SCENARIOS,
  TREE_LIMP,
  TREE_OOP_AGGR,
  TREE_SRP,
  calRange,
  chartRange,
  getScenario,
  ghostRangeString,
  huPotStack,
  lineRange,
  lineReach,
  rangeWeights,
  solverInput,
  srpPotStack,
  weightedCombos,
  withGhosts,
} from "./scenarios";
import { misplacedPacks, setDirs, writesCommitted } from "./sets";
import { jobQueue } from "./shard";

// No @types/node here: reach node:fs and node:crypto through untyped handles (as cardColors.test.tsx does).
const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { existsSync(path: string): boolean; readFileSync(path: string, encoding: "utf8"): string };
const crypto = (await import(/* @vite-ignore */ "node:crypto" as string)) as { createHash(a: string): { update(s: string): { digest(e: "hex"): string } } };
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const root = new URL("../../", import.meta.url).pathname;
const readManifest = (dir: string): Manifest | null => {
  const file = `${root}${dir}/manifest.json`;
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Manifest) : null;
};
/** Combo-weighted share of all hands. */
const share = (r: Record<string, number>) => ALL_HANDS.reduce((s, h) => s + (r[h] ?? 0) * comboCount(h), 0) / 1326;
/** The two short-stage packs (being solved: their files must not change), then the queue. */
const SHORT = CAL_SCENARIOS.slice(0, 2);
const QUEUE = CAL_SCENARIOS.slice(2);
const isShortRef = (ref: string) => /^solver\/(20|15)bb-2\//.test(ref);

describe("calibration packs", () => {
  it("are the short stages' own BTN-open, BB-call single raised pots at SPR 3.1 and 2.2", () => {
    expect(SHORT.map((s) => s.id)).toEqual(["cal-srp-btn-bb-20", "cal-srp-btn-bb-15"]);
    const want = { "cal-srp-btn-bb-20": { start: 20, stack: 17, spr: 3.09 }, "cal-srp-btn-bb-15": { start: 15, stack: 12, spr: 2.18 } };
    for (const sc of SHORT) {
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
    for (const sc of SHORT) {
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
    expect(Object.keys(CAL_RANGES).filter(isShortRef).sort()).toEqual(Object.keys(bounds).sort());
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
    for (const sc of SHORT) {
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
    for (const sc of SHORT)
      for (const raw of ["AhKd7c", "9h8h6h", "7d7c2h", "Qs8h5h"]) {
        const board = canonicalBoard(parseCards(raw)).cards;
        const m = estimateMemory(solverInput(sc, board));
        expect(m.bytes).toBeLessThan(1.5e9);
        expect(m.actionNodes).toBe(76054);
      }
  });
});

// ───────────────────────── the calibration queue ─────────────────────────

/**
 * Flop pot and stack of every queued pack, worked out by hand from the stage presets (docs/preflop-solver.md §1.2):
 * pot = 2 × put + the folded seats' blinds + the BB's 1bb ante; stack = start − put, the BB's less its ante. In order.
 */
const POT_STACK: Record<string, [number, number]> = {
  "cal-srp-btn-bb-35": [5.5, 32], // BTN 2, BB calls: 4 + 0.5 + 1; 35 − 2 − 1
  "cal-srp-btn-bb-100": [5.9, 96.8], // 2.2 open: 4.4 + 0.5 + 1; 100 − 2.2 − 1
  "cal-srp-utg-bb-100": [5.9, 96.8],
  "cal-srp-co-bb-100": [5.9, 96.8],
  "cal-3bp-btn-co-100": [15.7, 93.4], // BTN 3-bets 3 × 2.2 = 6.6: 13.2 + 0.5 + 1 + 1 (both blinds and the ante dead)
  "cal-srp-btn-bb-55": [5.9, 51.8],
  "cal-3bp-bb-sb-100": [19, 90], // BB 3-bets the SB's 3 to 9: 18 + 1
  "cal-3bp-btn-co-55": [15.7, 48.4],
  "cal-3bp-bb-sb-55": [19, 45],
  "cal-3bp-btn-co-100-o3": [20.5, 91], // IP 3-bet 9
  "cal-3bp-bb-sb-100-o3": [22, 88.5], // SB raises to 3.5, BB 3-bets 10.5
  "cal-3bp-btn-co-35": [14.5, 29], // IP 3-bet 6
  "cal-3bp-bb-sb-35": [16, 26.5], // SB raises to 2.5, BB 3-bets 7.5
  "cal-srp-utg-bb-55": [5.9, 51.8],
  "cal-srp-co-bb-55": [5.9, 51.8],
  "cal-srp-utg-bb-35": [5.5, 32],
  "cal-srp-co-bb-35": [5.5, 32],
  "cal-srp-btn-bb-100-o3": [7.5, 96],
  "cal-srp-utg-bb-100-o3": [7.5, 96],
  "cal-srp-co-bb-100-o3": [7.5, 96],
  "cal-3bp-bb-btn-100": [19.1, 90.2], // BB 3-bets 4 × 2.2 = 8.8: 17.6 + 0.5 + 1; 100 − 8.8 − 1
  "cal-srp-sb-bb-100": [7, 96], // SB raises to 3: 6 + 1; the BB's 100 − 3 − 1
  "cal-3bp-sb-btn-100": [19.6, 91.2], // SB 3-bets 8.8: 17.6 + 1 + 1 (the BB's blind and ante dead)
  "cal-4bp-co-btn-100": [35.5, 83.5], // CO 4-bets 2.5 × 6.6 = 16.5: 33 + 2.5
  "cal-srp-co-btn-100": [6.9, 97.8], // CO 2.2, BTN flats: 4.4 + 2.5
  "cal-lp-sb-bb-100": [3, 98], // SB completes, BB checks: 2 + 1
  "cal-3bp-bb-btn-55": [19.1, 45.2],
  "cal-3bp-sb-btn-55": [19.6, 46.2],
  "cal-3bp-bb-btn-100-o3": [22.5, 88.5], // 3bb opens, blind 3-bet 3.5 × 3 = 10.5
  "cal-4bp-co-btn-100-o3": [47.5, 77.5], // 4-bet 2.5 × 9 = 22.5
  "cal-3bp-sb-btn-100-o3": [23, 89.5],
  "cal-3bp-bb-btn-35": [17.5, 26], // 2bb opens, blind 3-bet 8
  "cal-3bp-sb-btn-35": [18, 27],
  "cal-srp-sb-bb-55": [7, 51],
  "cal-srp-co-btn-55": [6.9, 52.8],
  "cal-lp-sb-bb-55": [3, 53],
  "cal-srp-sb-bb-35": [6, 31.5],
  "cal-lp-sb-bb-35": [3, 33],
  "cal-srp-sb-bb-100-o3": [8, 95.5],
  "cal-srp-co-btn-100-o3": [8.5, 97],
  "cal-lp-sb-bb-100-o3": [3, 98],
};

/** The chart refs a pack's ranges come from (both players, every action of their lines). */
const partRefs = (sc: (typeof CAL_SCENARIOS)[number]) => sc.meta.rangeSources!.flatMap((src) => src.split(LINE_SEP));
const stageOf = (sc: (typeof CAL_SCENARIOS)[number]) => /^solver\/([^/]+)\//.exec(sc.meta.rangeSources![0])![1];
const treeOf = (sc: (typeof CAL_SCENARIOS)[number]) => ({ sizes: sc.meta.sizes, raiseLimit: sc.meta.raiseLimit, addAllIn: sc.meta.addAllIn, allInThreshold: sc.meta.allInThreshold, minBet: sc.meta.minBet });

describe("the calibration queue", () => {
  it("follows the running packs in priority order, one queue position per pack", () => {
    expect(QUEUE.map((s) => s.id)).toEqual(Object.keys(POT_STACK));
    QUEUE.forEach((sc, i) => {
      expect(sc.queue).toBe(i + 1);
      expect(sc.set).toBe("calibration");
      expect(sc.version).toBe(1);
      expect(sc.title).toContain("보정");
      expect(sc.meta.preflop).toContain(`${sc.startStack}bb`);
      expect(sc.meta).toMatchObject({ format: "pub", ghostWeight: GHOST_WEIGHT, compress: true, storage: "rootClasses", iterations: 300, targetExploitability: 0.5, flopSet: "priority" });
      expect(sc.id).toMatch(/^cal-(srp|3bp|4bp|lp)-[a-z]+-[a-z]+-(100|55|35|100-o3)$/);
    });
    // The app's packs and the running packs keep queue 0, so the job interleaves them as it always did.
    for (const sc of [...SCENARIOS, ...SHORT]) expect(sc.queue).toBe(0);
  });

  it("derive pot and stack from the stage's sizes: dead blinds, the BB's ante, the stacks behind", () => {
    // huPotStack is srpPotStack's single raised pot with any seats.
    for (const [start, open] of [[20, 2], [100, 2.2], [55, 2.5]]) expect(huPotStack({ start, seats: ["BB", "BTN"], put: open, bbAnte: 1 })).toEqual(srpPotStack({ start, open, bbAnte: 1 }));
    expect(huPotStack({ start: 100, seats: ["BB", "BTN"], put: 8.8, bbAnte: 1 })).toEqual({ pot: 19.1, stack: 90.2 }); // the SB's blind dead
    expect(huPotStack({ start: 100, seats: ["SB", "BTN"], put: 8.8, bbAnte: 1 })).toEqual({ pot: 19.6, stack: 91.2 }); // the BB's blind and ante dead
    expect(huPotStack({ start: 100, seats: ["CO", "BTN"], put: 6.6, bbAnte: 1 })).toEqual({ pot: 15.7, stack: 93.4 }); // both blinds and the ante
    expect(huPotStack({ start: 100, seats: ["SB", "BB"], put: 1, bbAnte: 1 })).toEqual({ pot: 3, stack: 98 }); // a limped pot
    expect(() => huPotStack({ start: 100, seats: ["BB", "BB"], put: 2, bbAnte: 1 })).toThrow(/two seats/);
    expect(() => huPotStack({ start: 100, seats: ["CO", "BTN"], put: 1, bbAnte: 1 })).toThrow(/raised/);
    expect(() => huPotStack({ start: 100, seats: ["SB", "BB"], put: 0.5, bbAnte: 1 })).toThrow(/blind/);
    expect(() => huPotStack({ start: 10, seats: ["CO", "BTN"], put: 10, bbAnte: 1 })).toThrow(/stack/);
    for (const sc of QUEUE) {
      const [pot, stack] = POT_STACK[sc.id];
      expect(sc.meta.pot, sc.id).toBe(pot);
      expect(sc.meta.stack, sc.id).toBe(stack);
      expect(sc.startStack).toBe(CAL_STAGE_SOLVES[stageOf(sc)].stack);
      // The put is the last size on the chart line the pack's ranges come from ("BTN 2.2 · BB 3벳 8.8"; 1 after a limp).
      const line = partRefs(sc)
        .map((r) => CAL_RANGE_LINES[r])
        .filter(Boolean)
        .sort((a, b) => b.split(" · ").length - a.split(" · ").length)[0];
      const put = line.endsWith("림프") ? 1 : Number(/([\d.]+)$/.exec(line)![1]);
      expect(huPotStack({ start: sc.startStack, seats: sc.meta.positions, put, bbAnte: 1 }), sc.id).toEqual({ pot, stack });
    }
    // The SPRs the queue covers: 1.5 to 32.7 (the running packs 2.2 and 3.1, the app's packs 7.9 and 17.7).
    const sprs = QUEUE.map((sc) => sc.meta.stack / sc.meta.pot);
    expect(Math.min(...sprs)).toBeCloseTo(1.49, 2);
    expect(Math.max(...sprs)).toBeCloseTo(32.67, 2);
  });

  it("start from the shipped solver chart's ranges, pinned, along each player's own line", () => {
    for (const sc of QUEUE) {
      const stage = stageOf(sc);
      const shipped = PREFLOP_STAGES.find((s) => s.id === stage)!;
      expect(shipped, stage).toBeDefined();
      const rec = CAL_STAGE_SOLVES[stage];
      expect(rec).toMatchObject({ stack: shipped.stack, open: shipped.open, model: "modelB-rank9" });
      expect(rec.iterations).toBeGreaterThanOrEqual(1500);
      // While the shipped chart is the one pinned (same fit, same equity table), the pins are its numbers exactly.
      const same = rec.fitHash === shipped.model.fitHash.slice(0, 12) && rec.equityTable === shipped.equityTable.slice(0, 12);
      if (same) expect(rec.sizes).toEqual(shipped.sizes);
      for (const src of sc.meta.rangeSources!) {
        const parts = src.split(LINE_SEP);
        parts.forEach((ref, k) => {
          expect(CAL_RANGES[ref], ref).toBeDefined();
          const [, , spot, action] = /^solver\/([^/]+)\/([^:]+):(.+)$/.exec(ref)!;
          const scn = shipped.scenarios.find((x) => x.id === spot);
          expect(scn, ref).toBeDefined();
          expect(scn!.actions.some((a) => a.key === action), ref).toBe(true);
          expect(scn!.line, ref).toBe(CAL_RANGE_LINES[ref]);
          // A line is the hero's own decisions in turn: its first is the hero's first, each later one follows them.
          if (k === 0) expect(scn!.reachFrom, ref).toBeUndefined();
          else expect(scn!.reachFrom, ref).toEqual(parts.slice(0, k).map((r) => r.split("/")[2]));
          if (same) {
            const pinned = calRange(ref), chart = chartRange(ref);
            for (const h of ALL_HANDS) expect(Math.abs((pinned[h] ?? 0) - (chart[h] ?? 0)), `${ref} ${h}`).toBeLessThan(1e-9);
          }
        });
      }
    }
    // Every pinned ref has its line and is used by a pack.
    expect(Object.keys(CAL_RANGES).sort()).toEqual(Object.keys(CAL_RANGE_LINES).sort());
    const used = new Set(CAL_SCENARIOS.flatMap(partRefs));
    for (const ref of Object.keys(CAL_RANGES)) expect(used.has(ref), ref).toBe(true);
  });

  it("bring to a 3-bet or 4-bet pot what reaches it: the 3-bettor's 3-bets, the caller's open × its call", () => {
    const P = "solver/100bb-2.2";
    const bb = getScenario("cal-3bp-bb-btn-100");
    expect(bb.meta.rangeSources).toEqual([`${P}/bb-vs-btn-open:3bet`, `${P}/rfi-btn:open${LINE_SEP}${P}/btn-open-vs-bb-3bet:call`]);
    const open = calRange(`${P}/rfi-btn:open`), call = calRange(`${P}/btn-open-vs-bb-3bet:call`);
    const ip = lineRange(bb.meta.rangeSources![1], calRange);
    for (const h of ALL_HANDS) expect(ip[h] ?? 0, h).toBeCloseTo((open[h] ?? 0) * (call[h] ?? 0), 9);
    expect(share(ip)).toBeLessThan(share(open) * 0.6); // the BTN folds or 4-bets most of its open
    expect(lineRange(bb.meta.rangeSources![0], calRange)).toEqual(calRange(`${P}/bb-vs-btn-open:3bet`));
    expect(getScenario("cal-3bp-btn-co-100").meta.rangeSources).toEqual([`${P}/rfi-co:open${LINE_SEP}${P}/co-open-vs-btn-3bet:call`, `${P}/btn-vs-co-open:3bet`]);
    expect(getScenario("cal-3bp-sb-btn-100").meta.rangeSources).toEqual([`${P}/sb-vs-btn-open:3bet`, `${P}/rfi-btn:open${LINE_SEP}${P}/btn-open-vs-sb-3bet:call`]);
    expect(getScenario("cal-3bp-bb-sb-100").meta.rangeSources).toEqual([`${P}/rfi-sb:raise${LINE_SEP}${P}/sb-open-vs-bb-3bet:call`, `${P}/bb-vs-sb-open:3bet`]);
    expect(getScenario("cal-4bp-co-btn-100").meta.rangeSources).toEqual([
      `${P}/rfi-co:open${LINE_SEP}${P}/co-open-vs-btn-3bet:4bet`,
      `${P}/btn-vs-co-open:3bet${LINE_SEP}${P}/btn-3bet-vs-co-4bet:call`,
    ]);
    // Products of tenths are hundredths; a ref off the tenths has no exact product and throws.
    expect(() => lineRange("x × y", () => ({ AA: 0.25 }))).toThrow(/tenths/);
    expect(() => lineRange(`${P}/rfi-btn:open${LINE_SEP}${P}/nope:call`, calRange)).toThrow(/cal-ranges/);
    const xy: Record<string, Record<string, number>> = { x: { AA: 0.7, KK: 1 }, y: { AA: 0.3, QQ: 1 }, z: { AA: 0.5 } };
    expect(lineRange("x × y", (r) => xy[r])).toEqual({ AA: 0.21 });
    expect(lineReach("x × y", (r) => xy[r])).toEqual(xy.x);
    // Three tenths multiply to thousandths, which the range strings can't write: refused, not rounded.
    expect(() => lineRange("x × y × z", (r) => xy[r])).toThrow(/thousandths/);
  });

  it("add ghost combos to both ranges, on the classes that reach each player's last decision, written exactly", () => {
    let most = 0;
    for (const sc of QUEUE)
      sc.meta.rangeSources!.forEach((src, p) => {
        const base = lineRange(src, calRange);
        const reach = lineReach(src, calRange);
        for (const h of ALL_HANDS) expect(Math.abs((base[h] ?? 0) * 100 - Math.round((base[h] ?? 0) * 100))).toBeLessThan(1e-9);
        const expected = rangeWeights(withGhosts(base, GHOST_WEIGHT, reach));
        for (let i = 0; i < 1326; i++) {
          expect(sc.ranges[p][i]).toBe(expected[i]);
          // A one-decision line (the BB facing an open, the opener, the 3-bettor, the limper) ghosts every class; a
          // longer one only those that reach its last decision: the caller of a 3-bet gets ghosts on its open only.
          const reaches = !reach || (reach[COMBOS[i].hand as keyof typeof reach] ?? 0) > 0;
          if (reaches) expect(sc.ranges[p][i]).toBeGreaterThanOrEqual(Math.fround(GHOST_WEIGHT));
          else expect(sc.ranges[p][i]).toBe(0);
        }
        expect(sc.meta.ranges[p]).toBe(ghostRangeString(base, GHOST_WEIGHT, reach));
        const back = rangeWeights(parseRange(sc.meta.ranges[p]));
        for (let i = 0; i < 1326; i++) expect(back[i]).toBe(sc.ranges[p][i]);
        const ghostMass = weightedCombos(sc.ranges[p]) - weightedCombos(rangeWeights(base));
        expect(ghostMass).toBeGreaterThan(0);
        most = Math.max(most, ghostMass / weightedCombos(sc.ranges[p]));
      });
    // Ghosts weigh at most 8% of a range (the BTN's 8% flat of the 100bb CO open; 6% elsewhere), about the 5% of the running
    // cal-srp-btn-bb-15. Ghosting every class would put 15% / 12% into the 100bb-3 4-bet pot, whose ranges are 4% and 5%
    // of hands, and move its real hands' pot share by 0.04 (docs/solver-packs.md "The calibration queue").
    expect(most).toBeLessThan(0.081);
    const P = "solver/100bb-2.2";
    const call = getScenario("cal-3bp-bb-btn-100"); // IP: rfi-btn:open × btn-open-vs-bb-3bet:call
    const open = calRange(`${P}/rfi-btn:open`), callVs3 = lineRange(call.meta.rangeSources![1], calRange);
    const at = (r: Float32Array, hand: string) => r[COMBOS.findIndex((c) => c.hand === hand)];
    expect(open["72o"] ?? 0).toBe(0);
    expect(at(call.ranges[1], "72o")).toBe(0); // never opened, never faces the 3-bet
    const folded = ALL_HANDS.find((h) => (open[h] ?? 0) > 0 && !((callVs3[h] ?? 0) > 0))!;
    expect(at(call.ranges[1], folded)).toBe(Math.fround(GHOST_WEIGHT)); // opened, folds (or 4-bets) to the 3-bet: a ghost
    expect(at(call.ranges[0], "72o")).toBe(Math.fround(GHOST_WEIGHT)); // the BB 3-bets from every class it holds
    expect(lineReach(`${P}/rfi-btn:open`, calRange)).toBeUndefined();
    expect(() => ghostRangeString({ AA: 1, KK: 0.5 }, GHOST_WEIGHT, { AA: 1 })).toThrow(/reach/);
    expect(parseRange(ghostRangeString({ AA: 1 }, GHOST_WEIGHT, { AA: 1, KK: 0.3 }))).toEqual({ AA: 1, KK: GHOST_WEIGHT });
  });

  it("give the preflop aggressor its betting: TREE_SRP in position, TREE_OOP_AGGR out of position, TREE_LIMP limped", () => {
    for (const sc of QUEUE) {
      const want = sc.meta.aggressor === 1 ? TREE_SRP : sc.meta.aggressor === 0 ? TREE_OOP_AGGR : TREE_LIMP;
      expect(treeOf(sc), sc.id).toEqual(want);
      // The id names the last raiser: cal-<pot>-<raiser>-<caller>-..., the limper and the checker in a limped pot.
      const [, pot, raiser] = /^cal-([a-z0-9]+)-([a-z]+)-/.exec(sc.id)!;
      if (pot === "lp") expect(sc.meta.aggressor).toBeNull();
      else expect(sc.meta.positions[sc.meta.aggressor as 0 | 1].toLowerCase(), sc.id).toBe(raiser);
    }
    // OOP may bet the flop only where it raised last or nobody raised; the caller keeps a raise everywhere.
    expect(TREE_SRP.sizes.flop[0].bet).toEqual([]);
    expect(TREE_OOP_AGGR.sizes.flop[0].bet).toEqual([0.33, 0.75]);
    expect(TREE_OOP_AGGR.sizes.flop[1]).toEqual({ bet: [0.5], raise: [0.6] });
    expect(TREE_OOP_AGGR.sizes.flop[0].raise).toEqual([0.6]);
    expect(TREE_LIMP.sizes.flop).toEqual([{ bet: [0.5], raise: [0.6] }, { bet: [0.5], raise: [0.6] }]);
    for (const t of [TREE_OOP_AGGR, TREE_LIMP]) expect({ turn: t.sizes.turn, river: t.sizes.river, raiseLimit: t.raiseLimit, addAllIn: t.addAllIn }).toEqual({ turn: TREE_SRP.sizes.turn, river: TREE_SRP.sizes.river, raiseLimit: 1, addAllIn: false });
  });

  it("fit a quarter of a 16 GB runner and the job's --max-mb 2000 on every board, with 16-bit storage", () => {
    // With every combo in both ranges the estimate depends on the suit pattern only; a rainbow board is the largest
    // (the deep OOP-raiser pots: 1,928 MB of the 2,000 the job allows; 3.8 GB in Float32).
    for (const sc of QUEUE)
      for (const raw of ["AhKd7c", "Qs8h5h", "9h8h6h", "7d7c2h"]) {
        const input = solverInput(sc, canonicalBoard(parseCards(raw)).cards);
        expect(input.compress).toBe(true);
        const m = estimateMemory(input);
        expect(m.bytes, `${sc.id} ${raw}`).toBeLessThan(1.95e9);
        expect(4 * 1.25 * m.bytes).toBeLessThan(0.85 * 16e9); // the job's memory check, 4 flops at once
      }
    const rainbow = canonicalBoard(parseCards("AhKd7c")).cards;
    expect(estimateMemory({ ...solverInput(getScenario("cal-srp-sb-bb-100"), rainbow), compress: false }).bytes).toBeGreaterThan(3.5e9);
    expect(estimateMemory({ ...solverInput(getScenario("cal-srp-btn-bb-100"), rainbow), compress: false }).bytes).toBeGreaterThan(2e9);
  });

  it("are solved one pack after the other, after the packs already in the job (jobQueue)", () => {
    // Every pack at 0: the plain interleave the job has always used.
    expect(jobQueue([{ queue: 0, jobs: ["a1", "a2", "a3"] }, { queue: 0, jobs: ["b1"] }, { queue: 0, jobs: ["c1", "c2"] }])).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
    expect(jobQueue([{ queue: 2, jobs: ["q2"] }, { queue: 0, jobs: ["a1", "a2"] }, { queue: 1, jobs: ["q1a", "q1b"] }, { queue: 0, jobs: ["b1"] }])).toEqual(["a1", "b1", "a2", "q1a", "q1b", "q2"]);
    expect(jobQueue([])).toEqual([]);
    // The real packs: the app's and the running packs first (interleaved), then the queue in its order.
    const order = jobQueue(ALL_SCENARIOS.map((sc) => ({ queue: sc.queue, jobs: [`${sc.id}#0`, `${sc.id}#1`] }))).map((j) => j.split("#")[0]);
    const first = [...SCENARIOS, ...SHORT].map((sc) => sc.id);
    expect(order.slice(0, 2 * first.length)).toEqual([...first, ...first]);
    expect([...new Set(order.slice(2 * first.length))]).toEqual(QUEUE.map((s) => s.id));
  });
});

describe("the running packs", () => {
  it("are written exactly as before the queue: the same meta, solver input and files", () => {
    // sha256 of JSON.stringify(meta), as the HEAD that started them builds it (2026-11-20, commit 34da70a).
    expect(sha256(JSON.stringify(getScenario("cal-srp-btn-bb-20").meta))).toBe("32c8e3f599690899de1e095746552d841c255bb70f213a4d73f4bf150b5e600e");
    expect(sha256(JSON.stringify(getScenario("cal-srp-btn-bb-15").meta))).toBe("40a7da9b78e7e480dc7adc004f0c70a9cff9da3518e1b49345fc953f7e112103");
    for (const sc of SHORT) {
      for (const k of ["compress", "storage", "aggressor"]) expect(k in sc.meta, k).toBe(false);
      const input = solverInput(sc, canonicalBoard(parseCards("Qs8h5h")).cards);
      expect(Object.keys(input)).toEqual(["board", "ranges", "pot", "stack", "sizes", "raiseLimit", "addAllIn", "allInThreshold", "minBet"]);
    }
  });
});

// ───────────────────────── slim files ─────────────────────────

const classWeights = (text: string): Float32Array => rangeWeights(parseRange(text));
const hasSolve = typeof (solver as { solve?: unknown }).solve === "function";

describe.skipIf(!hasSolve)("slim calibration files (storage: rootClasses)", () => {
  // Tiny flop, class-uniform ranges like the packs': OOP may only check, IP bets 50% (the TREE_SRP shape).
  const board = parseCards("AsKh7d");
  const base: SolverInput = {
    board,
    ranges: [classWeights("77, KQs, QJs, 65s:0.5, AJo:0.3"), classWeights("AQs, KJs, T9s, 88:0.5, QQ:0.2")],
    pot: 10,
    stack: 10,
    sizes: {
      flop: [{ bet: [], raise: [1] }, { bet: [0.5], raise: [] }],
      turn: [{ bet: [], raise: [] }, { bet: [], raise: [] }],
      river: [{ bet: [], raise: [] }, { bet: [], raise: [] }],
    },
    raiseLimit: 1,
    addAllIn: false,
  };
  const sol = solver.solve(base, { iterations: 200, targetExploitability: 0.3 });
  const meta = { scenario: "test-spot", version: 1 };
  const full = extractFlop(base, sol, meta);
  const slim = extractFlop(base, sol, meta, { storage: "rootClasses" });
  const fd = decodeFlopFile(full.file), sd = decodeFlopFile(slim.file);
  /** The fit's class rows from a full file: Σ w·EV / Σ w over the class's combos at a node (scripts/fit-realization.mjs). */
  const rows = (path: number[]) => {
    const node = fd.node(path)!;
    const s = new Float64Array(NUM_CLASSES), w = new Float64Array(NUM_CLASSES);
    node.combos.forEach((c, j) => {
      let ev = 0;
      node.actions.forEach((_, a) => (ev += node.strategy[a][j] > 0 ? node.strategy[a][j] * node.ev[a][j] : 0));
      s[COMBO_CLASS[c]] += node.weight[j] * ev;
      w[COMBO_CLASS[c]] += node.weight[j];
    });
    return Array.from(s, (v, c) => (w[c] > 0 ? v / w[c] : NaN));
  };

  it("hold the ranges per class and the per-class root, no nodes, in about 2 KB", () => {
    expect(validateFlopFile(slim.file)).toEqual([]);
    expect(slim.file.nodes).toEqual([]);
    expect(slim.file.ranges.every((r) => "classes" in r)).toBe(true);
    expect(slim.file.rootClasses!.actions.map((a) => [a.kind, a.next])).toEqual([["check", "action"]]);
    expect(slim.bytes).toBeLessThan(2000);
    expect(slim.bytes).toBeLessThan(full.bytes);
    expect(JSON.parse(slim.json)).toEqual(slim.file);
    expect(slim.summaryNodes).toEqual([]);
    expect(slim.summary.freq).toEqual([]);
    // The same ranges as the per-combo form, after board removal, exactly.
    for (const p of [0, 1]) for (let i = 0; i < 1326; i++) expect(sd.ranges[p][i]).toBe(fd.ranges[p][i]);
    // The solver's root equity and EVs, as in a full file.
    expect(slim.summary.equity).toEqual(full.summary.equity);
    expect(slim.summary.ev).toEqual(full.summary.ev);
  });

  it("give the fit the class rows of the full file: OOP's root and IP's root (its node after the check)", () => {
    const rc = sd.rootClasses!;
    const oop = rows([]), ip = rows([0]);
    for (let c = 0; c < NUM_CLASSES; c++) {
      for (const [p, want] of [[0, oop[c]], [1, ip[c]]] as const) {
        if (Number.isNaN(want)) expect(rc.ev[p][c]).toBeNaN();
        else expect(Math.abs(rc.ev[p][c] - want), `${ALL_HANDS[c]} ${p}`).toBeLessThanOrEqual(0.0101); // two roundings to 0.01 bb
      }
      // OOP only checks.
      expect(rc.strategy[0][c]).toBe(Number.isNaN(oop[c]) ? 0 : 1);
    }
    // Against the solver itself: the start-weighted class mean of the root EV, rounded to 0.01 bb.
    const root = sol.node([]);
    for (const p of [0, 1] as const) {
      const s = new Float64Array(NUM_CLASSES), w = new Float64Array(NUM_CLASSES);
      for (let i = 0; i < 1326; i++) {
        const x = sd.ranges[p][i] > 0 ? root.ranges[p][i] : 0;
        if (!(x > 0)) continue;
        s[COMBO_CLASS[i]] += x * root.ev[p][i];
        w[COMBO_CLASS[i]] += x;
      }
      for (let c = 0; c < NUM_CLASSES; c++) if (w[c] > 0) expect(Math.abs(rc.ev[p][c] - s[c] / w[c])).toBeLessThanOrEqual(0.005 + 1e-6);
    }
  });

  it("store IP's root EV when OOP may bet, which the nodes never held", () => {
    const betInput: SolverInput = { ...base, sizes: { ...base.sizes, flop: [{ bet: [0.5], raise: [1] }, { bet: [0.5], raise: [1] }] } };
    const bs = solver.solve(betInput, { iterations: 200, targetExploitability: 0.3 });
    const f = extractFlop(betInput, bs, meta, { storage: "rootClasses", equity: false });
    expect(validateFlopFile(f.file)).toEqual([]);
    const d = decodeFlopFile(f.file);
    const rc = d.rootClasses!;
    expect(rc.actions.map((a) => a.kind)).toEqual(["check", "bet"]);
    const root = bs.node([]);
    const s = new Float64Array(NUM_CLASSES), w = new Float64Array(NUM_CLASSES), held = new Uint8Array(NUM_CLASSES);
    for (let i = 0; i < 1326; i++) {
      if (d.ranges[0][i] > 0) held[COMBO_CLASS[i]] = 1;
      if (!(d.ranges[1][i] > 0)) continue;
      s[COMBO_CLASS[i]] += root.ranges[1][i] * root.ev[1][i];
      w[COMBO_CLASS[i]] += root.ranges[1][i];
    }
    for (let c = 0; c < NUM_CLASSES; c++) {
      if (w[c] > 0) expect(Math.abs(rc.ev[1][c] - s[c] / w[c])).toBeLessThanOrEqual(0.005 + 1e-6);
      // OOP's class frequencies add up to 1 where it holds the class, 0 elsewhere.
      expect(rc.strategy[0][c] + rc.strategy[1][c]).toBeCloseTo(held[c] ? 1 : 0, 9);
    }
  }, 60_000); // a second small solve

  it("rebuild their manifest summary from the file alone", () => {
    const again = summarizeFile(slim.file);
    expect(again.summaryNodes).toEqual([]);
    expect(again.summary.freq).toEqual([]);
    expect(Math.abs(again.summary.ev[0] - slim.summary.ev[0])).toBeLessThanOrEqual(0.02);
    expect(again.summary.ev[0] + again.summary.ev[1]).toBeCloseTo(base.pot, 6);
    expect(Math.abs(again.summary.equity[0] - slim.summary.equity[0])).toBeLessThanOrEqual(0.003);
  });

  it("are checked: per-class ranges only with rootClasses and no nodes, EVs exactly where a class is held", () => {
    expect(validateFlopFile({ ...slim.file, nodes: full.file.nodes })).toContain("per-class ranges need rootClasses and no nodes");
    expect(validateFlopFile({ ...slim.file, rootClasses: undefined }).join()).toMatch(/per-class ranges need rootClasses|missing root node/);
    // A full file may carry rootClasses too; a slim file with per-combo ranges is valid as well.
    expect(validateFlopFile({ ...slim.file, ranges: full.file.ranges })).toEqual([]);
    const ev = slim.file.rootClasses!.ev;
    expect(validateFlopFile({ ...slim.file, rootClasses: { ...slim.file.rootClasses!, ev: [ev[1], ev[0]] } }).join()).toMatch(/EV for player/);
    const wrong = { ...slim.file.rootClasses!, strategy: ["/".repeat(226)] }; // 255 for every class, held or not
    expect(validateFlopFile({ ...slim.file, rootClasses: wrong }).join()).toMatch(/strategy sums/);
  });

  it("encode a class range only when every combo of a class has the same weight", () => {
    const w = classWeights("AA, KQs:0.5, 72o:0.0078");
    const r = encodeClassRange(w, board);
    expect(r.classes.length).toBe(Math.ceil((NUM_CLASSES * 4) / 3));
    const back = decodeClassRange(r, board);
    const per = decodeRange(encodeRange(w, board));
    for (let i = 0; i < 1326; i++) expect(back[i]).toBe(per[i]);
    // A blocked combo is left out: AsAh touches the board, AdAc does not.
    const aa = COMBOS.findIndex((c) => c.hand === "AA" && c.cards.includes(board[0]));
    expect(back[aa]).toBe(0);
    const uneven = w.slice();
    uneven[COMBOS.findIndex((c) => c.hand === "KQs")] = 1;
    expect(() => encodeClassRange(uneven, board)).toThrow(/different weights/);
    expect(Math.round(back[COMBOS.findIndex((c) => c.hand === "72o")] * Q_MAX)).toBe(2); // the ghost floor survives
  });

  it("stay at about 2–3 KB per flop with the packs' full ghost ranges and an OOP-raiser root", () => {
    // A stand-in solution for a queued pack's root (every combo in both ranges, three OOP actions): the slim file's size
    // does not depend on the solve, only on the ranges and the root's actions.
    const sc = getScenario("cal-srp-sb-bb-100");
    const b = canonicalBoard(parseCards("AhKd7c")).cards;
    const input = solverInput(sc, b);
    const dead = new Set(b);
    const start = sc.ranges.map((r) => Float32Array.from(r, (x, i) => (dead.has(COMBOS[i].cards[0]) || dead.has(COMBOS[i].cards[1]) ? 0 : x))) as [Float32Array, Float32Array];
    const ev = [0, 1].map((p) => Float32Array.from({ length: 1326 }, (_, i) => (start[p][i] > 0 ? ((i * 7919 + p * 104729) % 4000) / 100 - 10 : NaN))) as [Float32Array, Float32Array];
    const strat = [0, 1, 2].map((a) => Float32Array.from({ length: 1326 }, (_, i) => (start[0][i] > 0 ? [0.5, 0.3, 0.2][a] : 0)));
    const node = (kind: "action" | "chance", stacks: [number, number]) => ({ kind, street: "flop" as const, board: b, pot: input.pot, bets: [0, 0] as [number, number], stacks, ranges: start, ev });
    const fake = {
      iterations: 1,
      exploitability: 0.4,
      node: (path: { action: number }[]) =>
        path.length === 0
          ? { ...node("action", [input.stack, input.stack]), player: 0 as const, actions: [{ kind: "check" as const, to: 0, label: "체크" }, { kind: "bet" as const, to: 2.31, label: "벳 33%" }, { kind: "bet" as const, to: 5.25, label: "벳 75%" }], strategy: strat }
          : node("action", [input.stack, input.stack]),
    };
    const res = extractFlop(input, fake as unknown as ReturnType<typeof solver.solve>, { scenario: sc.id, version: sc.version }, { storage: "rootClasses", equity: false });
    expect(validateFlopFile(res.file)).toEqual([]);
    expect(res.bytes).toBeGreaterThan(1800);
    expect(res.bytes).toBeLessThan(3000); // × 1,755 flops: under 5.3 MB a pack
    // The fit's weight for a combo is its class's: the same per-combo ranges as the encoder was given.
    const d = decodeFlopFile(res.file);
    for (let i = 0; i < 1326; i++) expect(d.ranges[1][i]).toBeCloseTo(start[1][i], 2);
    expect(compatibleWeights(b, d.ranges[1]).length).toBe(1326);
  });
});
