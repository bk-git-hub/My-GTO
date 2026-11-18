import { describe, expect, it } from "vitest";
import type { PreflopStage } from "../../data/sets/preflopTypes";
import { ALL_HANDS } from "../cards";
import { buildEquityTable, mulberry32, N } from "../pushfold";
import { parseRange } from "../range";
import { EQR_FIT } from "./eqrFit";
import {
  CLOSE_EPS,
  CLOSE_LADDER,
  CLOSE_USE_MIN_PCT,
  BANDS_MIN_STACK,
  SANITY3_SPLIT_MAX_STACK,
  DATA_LIMITS,
  DEGEN_MIN_OPEN,
  FOUR_BET_SPLIT_TEXT,
  LADDER_START,
  LOW_SPR_CAP_TEXT,
  LADDER_STEPS,
  LOW_SUITED_CONNECTORS,
  PUSHFOLD_CONFIDENCE_TEXT,
  PUSHFOLD_LIMITS,
  PUSHFOLD_RULE_TEXT,
  SENS_FLIP,
  SENS_MIN_REACH,
  SUITED_WHEEL_ACES,
  TWOSTART_TOLERANCE,
  annotateStage,
  chainFamilies,
  chooseLadder,
  classifyTree,
  closeString,
  countKinds,
  countProblems,
  dataChecks,
  dataLimits,
  decodeStage,
  degenGates,
  degenerateOpeners,
  dropClose,
  exportSet,
  exportStage,
  flagProblems,
  hasFlop,
  kickerChains,
  ladderThresholds,
  legendOrder,
  moveAt,
  productFormHu,
  raiseAll,
  rangeText,
  reachShares,
  sensString,
  stageBands,
  stageFlags,
  stageSanity,
  stageValuation,
  thresholdsByKind,
  topCardChains,
  twoStartRfiProblems,
  valuationForStage,
  type DataLimits,
  type NodeClass,
  type StageExportInput,
} from "./export";
import { handFeatures } from "./features";
import { actionShares, comboWeights, createSolver, ownReach } from "./solve";
import { TERM, buildTree, stageConfig, type PreflopTree } from "./tree";
import { MW_C_POS, equityScaledSurplusVectors, featureMatrix, surplusShrink } from "./value";

// The export mapping (§6.4), the size ladder (§6.5), the snapped export with reach references (§4.4, §6.2) and the
// sensitivity valuations (§6.6), on the shipped trees (mapping only) and on a small solved tree with the coarse table
// the other solver tests use.

const table = buildEquityTable(150, mulberry32(3));
const CW = comboWeights();
const features = featureMatrix(N, handFeatures);

const byId = (classes: NodeClass[], id: string) => {
  const c = classes.find((x) => x.id === id);
  if (!c) throw new Error(`no node ${id}`);
  return c;
};
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const labels = (c: NodeClass) => c.order.map((a) => c.actions[a]!.label);
const keys = (c: NodeClass) => c.order.map((a) => c.actions[a]!.key);

describe("scenario mapping (§6.4)", () => {
  const tree100 = buildTree(stageConfig("100bb-2.2"));
  const c100 = classifyTree(tree100);
  const tree35 = buildTree(stageConfig("35bb-2"));
  const c35 = classifyTree(tree35);

  it("gives every node of the shipped trees a unique, well-formed id and a consistent action list", () => {
    for (const [tree, classes] of [
      [tree100, c100],
      [tree35, c35],
    ] as const) {
      expect(new Set(classes.map((c) => c.id)).size).toBe(tree.nodeCount);
      for (const c of classes) {
        expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        const info = tree.nodes[c.node];
        expect(c.actions.filter((a) => a === null).length).toBe(tree.foldIdx[c.node] >= 0 ? 1 : 0);
        expect(new Set(keys(c)).size).toBe(c.order.length);
        expect(c.order.length).toBe(info.actions.length - (tree.foldIdx[c.node] >= 0 ? 1 : 0));
        expect(c.noFold).toBe(tree.foldIdx[c.node] < 0);
      }
      expect(classes.filter((c) => c.kind === "rfi").map((c) => c.id)).toEqual(["rfi-utg", "rfi-utgp1", "rfi-utgp2", "rfi-lj", "rfi-hj", "rfi-co", "rfi-btn", "rfi-sb"].filter((id) => classes.some((c) => c.id === id)));
    }
    expect(c100.filter((c) => c.kind === "rfi")).toHaveLength(8);
    // Exactly the 84 cold nodes: a seat that has not acted, facing an open and a non-all-in 3-bet, no callers.
    expect(c100.filter((c) => c.cold)).toHaveLength(84);
    expect(c100.filter((c) => c.cold).every((c) => c.kind === "vs3bet" && c.generic)).toBe(true);
  });

  it("names first-in, vs-open and limped-pot spots with the stage's real sizes", () => {
    expect(labels(byId(c100, "rfi-utg"))).toEqual(["오픈 2.2bb"]);
    const sb = byId(c100, "rfi-sb");
    expect(keys(sb)).toEqual(["limp", "raise"]);
    // Key "raise" next to 림프, but it reads 오픈 like every later spot of its line ("SB 오픈 후 vs BB 3벳").
    expect(labels(sb)).toEqual(["림프", "오픈 3bb"]);
    expect(byId(c100, "sb-open-vs-bb-3bet").title).toBe("SB 오픈 후 vs BB 3벳");
    const bbBtn = byId(c100, "bb-vs-btn-open");
    expect(bbBtn.kind).toBe("vsOpen");
    expect(labels(bbBtn)).toEqual(["콜", "3벳 8.8bb"]);
    expect([bbBtn.title, bbBtn.chip, bbBtn.line, bbBtn.villain]).toEqual(["BB vs BTN 오픈", "BB vs BTN", "BTN 2.2", "BTN"]);
    expect(labels(byId(c100, "btn-vs-co-open"))).toEqual(["콜", "3벳 6.6bb"]);
    expect(labels(byId(c100, "bb-vs-sb-open"))).toEqual(["콜", "3벳 9bb"]);
    // The BB facing a limp never folds: an explicit check, last, so it takes every remaining hand.
    const limp = byId(c100, "bb-vs-sb-limp");
    expect([limp.kind, limp.noFold]).toEqual(["vsLimp", true]);
    expect(keys(limp)).toEqual(["raise", "check"]);
    expect(labels(limp)).toEqual(["레이즈 3.5bb", "체크"]);
    expect(labels(byId(c100, "sb-limp-vs-bb-iso"))).toEqual(["콜", "리레이즈 10.5bb"]);
    expect(keys(byId(c100, "bb-iso-vs-sb-reraise"))).toEqual(["call", "shove"]);
    expect(keys(byId(c100, "sb-reraise-vs-bb-jam"))).toEqual(["call"]);
    expect(c100.filter((c) => c.kind === "vsLimp").map((c) => c.id).sort()).toEqual(["bb-iso-vs-sb-reraise", "bb-vs-sb-limp", "sb-limp-vs-bb-iso", "sb-reraise-vs-bb-jam"]);
    expect(c35.filter((c) => c.kind === "vsLimp")).toHaveLength(6);
    expect(labels(byId(c35, "bb-vs-sb-limp"))).toEqual(["레이즈 3bb", "올인", "체크"]);
  });

  it("names 3-bet and 4-bet spots, including the jam variants", () => {
    const co = byId(c100, "co-open-vs-btn-3bet");
    expect([co.kind, co.title, co.chip]).toEqual(["vs3bet", "CO 오픈 후 vs BTN 3벳", "CO vs BTN 3벳"]);
    expect(labels(co)).toEqual(["콜", "4벳 16.5bb", "올인"]); // CO is out of position: 2.5 × 6.6
    expect(labels(byId(c100, "btn-open-vs-bb-3bet"))).toEqual(["콜", "4벳 20.2bb", "올인"]); // IP: 2.3 × 8.8
    const v4 = byId(c100, "btn-3bet-vs-co-4bet");
    expect([v4.kind, v4.title, ...keys(v4)]).toEqual(["vs4bet", "BTN 3벳 후 vs CO 4벳", "call", "shove"]);
    expect([byId(c100, "btn-3bet-vs-co-4bet-jam").title, ...keys(byId(c100, "btn-3bet-vs-co-4bet-jam"))]).toEqual(["BTN 3벳 후 vs CO 4벳 올인", "call"]);
    expect([byId(c100, "co-4bet-vs-btn-jam").title, byId(c100, "co-4bet-vs-btn-jam").kind]).toEqual(["CO 4벳 후 vs BTN 5벳 올인", "vs4bet"]);
    // ≤ 40bb: jams first in and over an open.
    expect(labels(byId(c35, "rfi-utg"))).toEqual(["오픈 2bb", "올인"]);
    expect([byId(c35, "bb-vs-btn-jam").kind, ...keys(byId(c35, "bb-vs-btn-jam"))]).toEqual(["vsShove", "call"]);
    expect([byId(c35, "co-open-vs-btn-jam").kind, byId(c35, "co-open-vs-btn-jam").title]).toEqual(["vs3bet", "CO 오픈 후 vs BTN 3벳 올인"]);
  });

  it("gives multiway, cold and post-jam spots the generic id, with the right kind", () => {
    const sq = byId(c100, "bb-at-co-open-btn-call");
    expect([sq.kind, sq.title, sq.chip, sq.line]).toEqual(["squeeze", "BB vs CO 오픈 + BTN 콜", "CO오픈·BTN콜", "CO 2.2 · BTN 콜"]);
    expect(keys(sq)).toEqual(["overcall", "squeeze"]);
    expect(labels(byId(c100, "btn-at-hj-open-co-call"))).toEqual(["오버콜", "스퀴즈 8.8bb"]); // IP: 3 × 2.2 + 2.2
    const opener = byId(c100, "co-at-co-open-btn-call-bb-squeeze");
    expect([opener.kind, opener.title, opener.villain]).toEqual(["squeeze", "CO — CO 오픈 → BTN 콜 → BB 스퀴즈", "BB"]);
    expect(keys(opener)).toEqual(["call", "shove"]);
    const coldJamAnswer = byId(c100, "hj-at-utg-open-hj-3bet-co-jam");
    expect([coldJamAnswer.kind, coldJamAnswer.title, ...keys(coldJamAnswer)]).toEqual(["vs4bet", "HJ — UTG 오픈 → HJ 3벳 → CO 올인", "call"]);
    const cold = byId(c100, "co-at-utg-open-hj-3bet");
    expect([cold.kind, cold.cold, cold.title, cold.villainSeats]).toEqual(["vs3bet", true, "CO — UTG 오픈 → HJ 3벳 (콜드: 폴드·올인)", ["UTG", "HJ"]]);
    expect(cold.order.map((a) => cold.actions[a])).toEqual([{ key: "shove", label: "콜드 올인", color: "allin", to: 100 }]);
    // A cold seat answering a 3-bet jam after the opener folded.
    const sh = byId(c35, "sb-at-co-open-btn-jam");
    expect([sh.kind, ...keys(sh)]).toEqual(["vsShove", "call"]);
  });

  it("shows the fold of a seat that had put chips in, so the line says who is still live (the id stays)", () => {
    // 35bb: CO opens, SB jams, CO (R1 priority) folds, then the BB decides heads-up against the SB.
    const bb = byId(c35, "bb-at-co-open-sb-jam");
    expect([bb.title, bb.chip, bb.line, bb.sizedLine, bb.villainSeats]).toEqual([
      "BB — CO 오픈 → SB 올인 → CO 폴드",
      "CO오픈·SB올인·CO폴드",
      "CO 2 · SB 올인 · CO 폴드",
      "CO 오픈 2bb → SB 올인 → CO 폴드",
      ["SB"],
    ]);
    // 100bb: the 3-bettor folds to the BB's jam before the opener decides.
    const btn = byId(c100, "btn-at-btn-open-sb-3bet-bb-jam");
    expect([btn.title, btn.chip]).toEqual(["BTN — BTN 오픈 → SB 3벳 → BB 올인 → SB 폴드", "BTN오픈·SB3벳·BB올인·SB폴드"]);
    expect(byId(c100, "sb-at-btn-open-sb-3bet-bb-jam").title).toBe("SB — BTN 오픈 → SB 3벳 → BB 올인");
    // Folds of seats without voluntary chips stay out (the SB and BB folding to the CO-BTN 3-bet).
    expect(byId(c100, "co-open-vs-btn-3bet").line).toBe("CO 2.2 · BTN 3벳 6.6");
    // Every shown fold is by a seat that acted voluntarily earlier on the line, and the id ignores folds.
    for (const [tree, classes] of [
      [tree100, c100],
      [tree35, c35],
    ] as const)
      for (const c of classes) {
        const line = tree.nodes[c.node].line;
        line.forEach((l, i) => {
          if (l.verb !== "fold") return;
          const invested = line.slice(0, i).some((m) => m.seat === l.seat && m.verb !== "fold" && m.verb !== "check");
          expect(c.line.includes(`${["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"][l.seat]} 폴드`)).toBe(invested);
        });
      }
  });
});

describe("rangeText", () => {
  it("writes tenths that parseRange reads back exactly", () => {
    const rnd = mulberry32(11);
    for (let trial = 0; trial < 40; trial++) {
      const density = trial / 40;
      const v = Float64Array.from(ALL_HANDS, () => (rnd() < density ? Math.floor(rnd() * 11) / 10 : 0));
      const text = rangeText(v);
      const r = parseRange(text);
      ALL_HANDS.forEach((h, i) => expect(r[h] ?? 0).toBe(v[i]));
    }
    expect(rangeText(new Float64Array(169))).toBe("");
    const full = new Float64Array(169).fill(1);
    expect(rangeText(full)).toBe("22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s, A2o+, K2o+, Q2o+, J2o+, T2o+, 92o+, 82o+, 72o+, 62o+, 52o+, 42o+, 32o");
    const some = new Float64Array(169);
    for (const [h, f] of [["AA", 1], ["KK", 1], ["99", 0.5], ["AKs", 0.3], ["AQs", 0.3], ["AJs", 0.3], ["K9s", 0.3], ["K8s", 0.3]] as const) some[ALL_HANDS.indexOf(h)] = f;
    expect(rangeText(some)).toBe("KK+, 99:0.5, AJs+:0.3, K9s-K8s:0.3");
  });
});

describe("size ladder (§6.5)", () => {
  const tree = buildTree(stageConfig("100bb-2.2"));
  const classes = classifyTree(tree);
  // Synthetic occ: squeeze lines 0.3%, vs4bet 0.15%, cold nodes 0.8%, everything else 5%.
  const occ = Float64Array.from(classes, (c) => (c.cold ? 0.008 : c.kind === "squeeze" ? 0.003 : c.kind === "vs4bet" ? 0.0015 : 0.05));
  const limits: DataLimits = { rfi: 8, vsOpen: [0, 36], vsLimp: [0, 6], otherMax: 100, total: 1e9 };

  it("exports every rfi node, and nothing whose hero has an unexported earlier decision", () => {
    const none = exportSet(tree, classes, new Float64Array(tree.nodeCount), LADDER_START);
    expect(countKinds(classes, none.exported)).toMatchObject({ rfi: 8, total: 8 });
    const o = Float64Array.from(occ);
    const v = byId(classes, "btn-vs-co-open"), d = byId(classes, "btn-3bet-vs-co-4bet");
    o[v.node] = 0;
    o[d.node] = 0.05;
    const set = exportSet(tree, classes, o, LADDER_START);
    expect(set.exported[v.node]).toBe(0);
    expect(set.exported[d.node]).toBe(0);
    expect(set.omitted).toContain(d.node);
  });

  it("raises each group only as far as its own count needs, or all together when shared", () => {
    const per = chooseLadder(tree, classes, occ, { limits });
    expect(per.ok).toBe(true);
    expect(per.steps).toEqual({ squeeze: 2, vs4bet: 1, vsShove: 0, cold: 3 });
    expect(per.counts).toMatchObject({ squeeze: 0, vs4bet: 0, vs3bet: 36, cold: 0 });
    const sh = chooseLadder(tree, classes, occ, { limits, shared: true });
    expect(sh.steps).toEqual({ squeeze: 3, vs4bet: 3, vsShove: 3, cold: 3 });
    // With every line at 5%, no step cuts the cold nodes (36 + 84 vs3bet > 72): PF-DATA-1's counts cannot be met.
    const bad = chooseLadder(tree, classes, Float64Array.from(classes, () => 0.05), { limits: DATA_LIMITS });
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThan(0);
  });

  it("records thresholds per kind and steps the gzip ladder", () => {
    const steps = { squeeze: 2, vs4bet: 1, vsShove: 0, cold: 3 };
    expect(thresholdsByKind(steps)).toEqual({ rfi: 0.1, vsOpen: 0.1, vs3bet: 0.1, vs4bet: 0.2, squeeze: 0.5, vsLimp: 0.1, vsShove: 0.1 });
    expect(ladderThresholds(steps)).toEqual({ squeeze: 0.5, vs4bet: 0.2, vsShove: 0.1, cold: 1 });
    expect(raiseAll(steps)).toEqual({ squeeze: 3, vs4bet: 2, vsShove: 1, cold: 3 });
    const top = LADDER_STEPS.length - 1;
    expect(raiseAll({ squeeze: top, vs4bet: top, vsShove: top, cold: top })).toBeNull();
  });
});

/** A 5-handed 100bb tree solved briefly: two decisions per seat, limped pots, squeezes and cold jams. */
function solved(players = 5, iterations = 300) {
  const tree = buildTree(stageConfig("100bb-2.2", { players }));
  const solver = createSolver(tree, table, { valuation: stageValuation(EQR_FIT, features) });
  solver.iterate(iterations);
  const avg = solver.average();
  const ev = solver.evaluate(avg);
  return { tree, solver, avg, ev, classes: classifyTree(tree) };
}

const FIT = { sha256: "fit-sha", packs: { "pack-a": { version: 2, format: "pub", flops: 448, pot: 6.5, stack: 51.5, minCheck: 1, filesSha256: "x" } } };
const SMALL_LIMITS: DataLimits = { rfi: 4, vsOpen: [0, 36], vsLimp: [0, 6], otherMax: 72, total: 180 };

describe("exportStage (§4.4, §6.2, §6.5, §6.6)", { timeout: 60_000 }, () => {
  const s = solved();
  const { tree, avg, ev, classes } = s;
  const ladder = chooseLadder(tree, classes, ev.occ, { limits: SMALL_LIMITS });
  const set = ladder.set;
  const moves = Float64Array.from({ length: tree.nodeCount }, (_, p) => (p * 7) % 31);
  const flagged = new Set([classes.find((c) => c.kind === "vsOpen" && set.exported[c.node])!.node]);
  const input = (over: Partial<StageExportInput> = {}): StageExportInput => ({
    id: "test-100",
    label: "테스트",
    tree,
    strategy: avg,
    classes,
    exported: set.exported,
    ladder: ladder.steps,
    iterations: 300,
    metrics: {
      occ: ev.occ,
      localRegret: ev.localRegret,
      gainMbb: ev.gainMbb,
      nashConvMbb: ev.nashConvMbb,
      snappedGainMbb: 1.234,
      ev: ev.ev,
      evSum: ev.evSum,
      frozenOcc: ev.frozen.occ,
      negativeShares: ev.negativeShares.count,
    },
    moves,
    twoStartFlags: flagged,
    fit: FIT,
    equityTable: "table-sha",
    ...over,
  });
  const out = exportStage(input());
  const stage = out.stage;

  it("writes data that passes PF-DATA-1", () => {
    expect(ladder.ok).toBe(true);
    expect(stage.scenarios.length).toBe(countKinds(classes, set.exported).total);
    // The small tree still has every kind but vsShove (no jams below the 4-bet level at 100bb) and two-step reach chains.
    expect(new Set(stage.scenarios.map((x) => x.kind))).toEqual(new Set(["rfi", "vsOpen", "vs3bet", "vs4bet", "squeeze", "vsLimp"]));
    expect(stage.scenarios.some((x) => (x.reachFrom?.length ?? 0) >= 2)).toBe(true);
    expect(dataChecks(stage, SMALL_LIMITS)).toEqual([]);
  });

  it("reproduces the snapped strategy exactly through the range strings and reachFrom", () => {
    const decoded = decodeStage(stage);
    stage.scenarios.forEach((sc, i) => {
      const p = out.nodes[i];
      const c = classes[p];
      expect(sc.id).toBe(c.id);
      const rho = ownReach(tree, out.snapped, p, N);
      const d = decoded.get(sc.id)!;
      let w = 0;
      for (let h = 0; h < N; h++) {
        expect(d.rho[h]).toBeCloseTo(rho[h], 12);
        w += CW[h] * rho[h];
        for (const a of c.order) {
          const want = rho[h] > 0 ? out.snapped[(tree.actStart[p] + a) * N + h] : 0;
          expect(Math.abs(d.freq[c.actions[a]!.key][h] - want)).toBeLessThan(1e-12);
          expect(Math.round(want * 10)).toBeCloseTo(want * 10, 9); // on the 0.1 grid
        }
        if (!(rho[h] > 0)) expect(d.fold[h]).toBe(1);
      }
      expect(sc.reachPct).toBe(Math.round((w / 1326) * 1000) / 10);
      // reachFrom: the hero's earlier decisions, root first, each an exported scenario of the same hero.
      const heroAncestors: number[] = [];
      for (let x = p; x > 0; x = tree.parent[x]) if (tree.seat[tree.parent[x]] === tree.seat[p]) heroAncestors.unshift(tree.parent[x]);
      expect((sc.reachFrom ?? []).map((r) => r.split(":")[0])).toEqual(heroAncestors.map((q) => classes[q].id));
      if (!heroAncestors.length) expect(sc.reachFrom).toBeUndefined();
    });
    // The BB never folds against a limp: the check takes the rest.
    const limp = decoded.get("bb-vs-sb-limp")!;
    expect(limp.scenario.noFold).toBe(true);
    expect(limp.scenario.actions.at(-1)!.key).toBe("check");
    for (let h = 0; h < N; h++) expect(limp.fold[h]).toBeLessThan(1e-12);
  });

  it("fills the stage fields from the tree, the fit and the metrics", () => {
    const cfg = tree.cfg;
    expect(stage).toMatchObject({
      id: "test-100",
      label: "테스트",
      stack: 100,
      open: 2.2,
      sizes: { sbRaise: cfg.sbRaise, iso: cfg.iso, ip3: 3, blind3: 4, bbVsSb3: 3, sqzPerCallerIP: 1, sqzPerCallerBlind: 1.25, fourIP: 2.3, fourOOP: 2.5, limpReraise: 3, jamMax: 40 },
      tree: { cold4: "jam", allinOrder: "priority" },
      iterations: 300,
      occThreshold: 0.1,
      occThresholdByKind: thresholdsByKind(ladder.steps),
      occThresholdCold: ladderThresholds(ladder.steps).cold,
      snappedGainMbb: 1.234,
      model: { id: "modelB-rank9", fitHash: "fit-sha", packs: { "pack-a": { version: 2, flops: 448 } } },
      equityTable: "table-sha",
    });
    expect(stage.brGainMbb).toHaveLength(5);
    expect(stage.description).toContain("모두 100bb. 오픈 2.2bb, SB는 림프·오픈 3bb, 3벳 IP 3배·블라인드 4배, 4벳 2.3~2.5배.");
    expect(stage.description).not.toContain("초안");
    expect(out.draft).toEqual([]);
  });

  it("badges confidence by §6.6 and says why", () => {
    const sanity = stageSanity(stage);
    const low = new Set([...sanity.sanity5.map((x) => x.id), ...sanity.sanity6.map((x) => x.id), ...sanity.sanity7.map((x) => x.id), ...out.twoStart]);
    expect(out.twoStart).toEqual([classes[[...flagged][0]].id]);
    stage.scenarios.forEach((sc, i) => {
      const move = Math.round(moves[out.nodes[i]] * 10) / 10;
      expect(sc.move).toBe(move);
      let want: "high" | "mid" | "low" = move < 8 ? "high" : move <= 20 ? "mid" : "low";
      if (low.has(sc.id)) want = "low";
      const fourBet = sc.kind === "vs3bet" || sc.kind === "vs4bet"; // 100bb ≥ 55bb
      if (fourBet && want === "high") want = "mid";
      expect(sc.confidence).toBe(want);
      expect(sc.description).toContain(`신뢰도 ${{ high: "높음", mid: "보통", low: "낮음" }[want]}`);
      // The split sentence only where the hero has both a small 4-bet and a jam; the plain cap reason elsewhere.
      const split = sc.actions.some((a) => a.key === "4bet") && sc.actions.some((a) => a.key === "shove");
      expect(sc.description.includes(FOUR_BET_SPLIT_TEXT), sc.id).toBe(fourBet && split);
      expect(sc.description.includes(LOW_SPR_CAP_TEXT), sc.id).toBe(fourBet && !split);
      // One decimal, the stored value the badge was decided on.
      if (move >= 1) expect(sc.description).toContain(`약 ${String(move)}%p 움직여요`);
      else expect(sc.description).toContain("거의 안 움직여요");
    });
    expect(stage.scenarios.find((sc) => out.twoStart.includes(sc.id))!.description).toContain("다른 시작점에서 풀면");
    // The BB facing a limp names only its own actions (no jam at 100bb).
    expect(stage.scenarios.find((sc) => sc.id === "bb-vs-sb-limp")!.description).toContain("BB는 폴드하지 않아요: 레이즈가 아니면 체크해요.");
  });

  it("badges on the stored move: a raw 7.95 is stored as 8 and is not 높음", () => {
    const p = out.nodes[stage.scenarios.findIndex((sc) => sc.kind === "rfi")];
    const m = Float64Array.from(moves);
    m[p] = 7.95;
    const sc = exportStage(input({ moves: m })).stage.scenarios.find((x) => x.id === classes[p].id)!;
    expect([sc.move, sc.confidence]).toEqual([8, sc.description.includes("왜곡") ? "low" : "mid"]);
    expect(sc.description).toContain("약 8%p 움직여요");
  });

  it("writes a draft without a measured move when the sensitivity and two-start solves did not run", () => {
    const d = exportStage(input({ moves: null, twoStartFlags: null }));
    expect(d.draft).toEqual(["sensitivity", "twostart"]);
    expect(d.stage.description).toContain("초안이에요: 민감도 풀이·두 출발점 검사 전이라");
    for (const sc of d.stage.scenarios) {
      expect(sc.move).toBe(0);
      // Nothing measured: never 높음.
      expect(sc.confidence).not.toBe("high");
      expect(sc.description).not.toContain("움직여요");
      expect(sc.description).toContain("(초안): 민감도 풀이를 아직 안 해서");
    }
    // Same ranges and reach as the release export: only the confidence texts differ.
    expect(d.stage.scenarios.map((x) => [x.id, x.reachFrom, x.actions])).toEqual(stage.scenarios.map((x) => [x.id, x.reachFrom, x.actions]));
  });

  it("lists a capped schedule and a two-start solve that failed its gates as draft reasons", () => {
    const d = exportStage(input({ iterationsCapped: true, twoStartFailed: true }));
    expect(d.draft).toEqual(["iterations", "twostartGates"]);
    expect(d.stage.description).toContain("초안이에요: 정식 반복 횟수 풀이·두 출발점 풀이의 수렴 전이라");
    // The moves were measured, so the badges and texts are the release ones.
    expect(d.stage.scenarios.map((x) => [x.confidence, x.description])).toEqual(stage.scenarios.map((x) => [x.confidence, x.description]));
  });

  it("is deterministic", () => {
    expect(JSON.stringify(exportStage(input()).stage)).toBe(JSON.stringify(stage));
  });
});

describe("checks on a stage's data", () => {
  const scenario = (id: string, kind: PreflopStage["scenarios"][number]["kind"], hero: string, actions: [string, string][], extra: object = {}) => ({
    id,
    kind,
    hero,
    chip: id,
    title: id,
    description: "",
    line: "",
    reachPct: 100,
    occ: 5,
    regret: 0,
    confidence: "high" as const,
    move: 0,
    actions: actions.map(([key, range]) => ({ key, label: key, color: "call" as const, range })),
    ...extra,
  });
  const base = (scenarios: ReturnType<typeof scenario>[], stack = 100): PreflopStage => ({
    id: "t",
    label: "t",
    description: "",
    stack,
    open: 2.2,
    sizes: { sbRaise: 3, iso: 3.5, ip3: 3, blind3: 4, bbVsSb3: 3, sqzPerCallerIP: 1, sqzPerCallerBlind: 1.25, fourIP: 2.3, fourOOP: 2.5, limpReraise: 3, jamMax: 40 },
    tree: { cold4: "jam", allinOrder: "priority" },
    iterations: 1,
    occThreshold: 0.1,
    occThresholdByKind: thresholdsByKind(LADDER_START),
    brGainMbb: [],
    nashConvMbb: 0,
    snappedGainMbb: 0,
    ev: [],
    diag: { evSum: 0, frozenOccPct: 0, negativeShares: 0 },
    model: { id: "modelB-rank9", fitHash: "", sprAlpha: 1.5, sprSurplus: 6, packs: {} },
    equityTable: "",
    scenarios,
  });
  const loose: DataLimits = { rfi: 1, vsOpen: [0, 36], vsLimp: [0, 6], otherMax: 72, total: 180 };

  it("PF-DATA-1 catches broken references, sums above 1 and frequencies out of reach", () => {
    const ok = base([scenario("rfi-utg", "rfi", "UTG", [["open", "AA, KK:0.5"]]), scenario("utg-open-vs-hj-3bet", "vs3bet", "UTG", [["call", "AA"]], { reachFrom: ["rfi-utg:open"] })]);
    expect(dataChecks(ok, loose)).toEqual([]);
    const badRef = base([scenario("rfi-utg", "rfi", "UTG", [["open", "AA"]]), scenario("x", "vs3bet", "UTG", [["call", "AA"]], { reachFrom: ["rfi-utg:shove"] })]);
    expect(dataChecks(badRef, loose).join()).toContain("names no action");
    const over = base([scenario("rfi-utg", "rfi", "UTG", [["open", "AA:0.7"], ["shove", "AA:0.4"]])]);
    expect(dataChecks(over, loose).join()).toContain("sum to");
    const outOfReach = base([scenario("rfi-utg", "rfi", "UTG", [["open", "AA"]]), scenario("x", "vs3bet", "UTG", [["call", "KK"]], { reachFrom: ["rfi-utg:open"] })]);
    expect(dataChecks(outOfReach, loose).join()).toContain("out of reach");
    const low = base([scenario("rfi-utg", "rfi", "UTG", [["open", "AA"]]), scenario("x", "vsOpen", "HJ", [["call", "AA"]], { occ: 0.05 })]);
    expect(dataChecks(low, loose).join()).toContain("below");
  });

  it("PF-SANITY-5 and -6 flag the scenarios they badge 낮음; reach-relative shares", () => {
    const st = base([
      scenario("rfi-utg", "rfi", "UTG", [["open", "22+, A2s+, K2s+"]]),
      scenario("hj-vs-utg-open", "vsOpen", "HJ", [["call", "22+, A2s+, K2s+, Q2s+"]], { villain: "UTG" }),
      scenario("utg-open-vs-hj-3bet", "vs3bet", "UTG", [["call", "22+"], ["4bet", ""], ["shove", "A2s+"]], { reachFrom: ["rfi-utg:open"] }),
      scenario("utg-at-utg-open-hj-3bet-co", "vs3bet", "CO", [["shove", "AA"]]),
    ]);
    const rep = stageSanity(st);
    expect(rep.sanity5.map((x) => x.id)).toEqual(["hj-vs-utg-open"]);
    expect(rep.sanity6.map((x) => x.id)).toEqual(["utg-open-vs-hj-3bet"]);
    expect(stageSanity({ ...st, stack: 35 }).sanity6).toEqual([]);
    expect(rep.sanity7).toEqual([]);
    const sh = reachShares(decodeStage(st).get("utg-open-vs-hj-3bet")!);
    // Reach: 22+ (78 combos), A2s+ (48), K2s+ (44) = 170 combos.
    expect(sh.call).toBeCloseTo((78 / 170) * 100, 9);
    expect(sh.shove).toBeCloseTo((48 / 170) * 100, 9);
    expect(sh.fold).toBeCloseTo((44 / 170) * 100, 9);
  });

  it("PF-SANITY-7 warns on inverted kickers in RFI and BB defense and names the worst pair", () => {
    const chains = kickerChains();
    expect(chains).toContainEqual(["A7s", "K7s"]);
    expect(chains).toContainEqual(["KTo", "K9o"]);
    // No kicker ladder below A6 in the ace row: the wheel aces may play more than A6–A9.
    expect(chains).not.toContainEqual(["A6s", "A5s"]);
    expect(chains).not.toContainEqual(["A5o", "A4o"]);
    expect(chains).toContainEqual(["A2s", "K2s"]);
    const st = base([
      scenario("rfi-utg", "rfi", "UTG", [["open", "22+, A8s+, K7s+, KTo+, ATo+"]]),
      scenario("rfi-hj", "rfi", "HJ", [["open", "22+, A2s+, K9s+, JTs, J9s, ATo+, KTo+, J9o, JTo:0.5"]]),
      scenario("bb-vs-utg-open", "vsOpen", "BB", [["call", "22+, A2s+, K2s+"]], { villain: "UTG" }),
      scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "K7s"]], { villain: "UTG" }),
    ]);
    const rep = stageSanity(st);
    // UTG plays K7s but folds A7s (the worst gap, 1.0; A6s–A2s are not asked against A7s); HJ plays J9o fully and
    // JTo half. The CO is not in PF-SANITY-7's scope.
    expect(rep.sanity7).toEqual([
      { id: "rfi-utg", better: "A7s", worse: "K7s", pBetter: 0, pWorse: 1 },
      { id: "rfi-hj", better: "JTo", worse: "J9o", pBetter: 0.5, pWorse: 1 },
    ]);
    expect(rep.fails).toEqual([]);
    expect(rep.warns.filter((w) => w.startsWith("PF-SANITY-7"))).toHaveLength(2);
  });

  it("PF-SANITY-8 prints inverted top cards (Kx ≥ Qx, kickers 2–J) and changes no badge", () => {
    const chains = topCardChains();
    expect(chains).toHaveLength(20);
    expect(chains).toContainEqual(["K2s", "Q2s"]);
    expect(chains).toContainEqual(["KJo", "QJo"]);
    expect(chains).toContainEqual(["KTo", "QTo"]);
    // Not Qx ≥ Jx (the packs put J9/J8 at or above Q9/Q8), and not KQ vs QQ.
    expect(chains.some(([a, b]) => a.startsWith("Q") || b.startsWith("J"))).toBe(false);
    expect(chains).not.toContainEqual(["KQo", "QQo"]);
    const st = base([scenario("rfi-utg", "rfi", "UTG", [["open", "22+, A2s+, K9s+, Q9s+, AJo+, KQo, KJo, QJo, QTo"]])]);
    const rep = stageSanity(st);
    const w8 = rep.warns.filter((w) => w.startsWith("PF-SANITY-8"));
    expect(w8).toEqual(["PF-SANITY-8 rfi-utg: 1 top-card pair(s) inverted, worst KTo plays 0.00 < QTo 1.00"]);
    // Print-only: no PF-SANITY-7 hit, nothing failed, and the export's confidence reads only sanity5/6/7.
    expect(rep.sanity7).toEqual([]);
    expect(rep.fails).toEqual([]);
    expect(rep.warns.filter((w) => !w.startsWith("PF-SANITY-8"))).toEqual([]);
    expect(Object.keys(rep).sort()).toEqual(["fails", "sanity5", "sanity6", "sanity7", "warns"]);
  });

  it("PF-SANITY-9 prints 3-bet compositions and -10 the chains outside RFI and BB defense; neither changes a badge", () => {
    expect(LOW_SUITED_CONNECTORS).toEqual(["43s", "54s", "65s", "53s", "64s"]);
    expect(SUITED_WHEEL_ACES).toEqual(["A5s", "A4s", "A3s", "A2s"]);
    const fams = Object.fromEntries(chainFamilies().map((f) => [f.name, f.pairs]));
    expect(Object.keys(fams)).toEqual(["A>K", "K>Q", "kicker", "same-gap"]);
    // A>K runs to kicker Q (PF-SANITY-7 stops at 9); K>Q is PF-SANITY-8's; the kicker ladder is PF-SANITY-7's.
    expect(fams["A>K"]).toHaveLength(22);
    expect(fams["A>K"]).toContainEqual(["ATs", "KTs"]);
    expect(fams["A>K"]).toContainEqual(["AQo", "KQo"]);
    expect(fams["K>Q"]).toEqual(topCardChains());
    expect(fams.kicker).toEqual(kickerChains().filter(([a, b]) => a[0] === b[0]));
    expect(fams.kicker).not.toContainEqual(["A7s", "K7s"]);
    // Same gap, both cards one rank lower; no ace row.
    expect(fams["same-gap"]).toContainEqual(["65s", "54s"]);
    expect(fams["same-gap"]).toContainEqual(["KJo", "QTo"]);
    expect(fams["same-gap"]).toContainEqual(["43s", "32s"]);
    expect(fams["same-gap"].some(([a]) => a.startsWith("A"))).toBe(false);
    const st = base([
      scenario("rfi-utg", "rfi", "UTG", [["open", "22+, A2s+, K9s+, QJs, AJo+, KQo, 54s"]]),
      scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "TT-77"], ["3bet", "JJ+, AK, 43s, 54s, 65s"]], { villain: "UTG" }),
      scenario("btn-vs-utg-open", "vsOpen", "BTN", [["3bet", "QQ+, A5s, A4s, 54s"]], { villain: "UTG" }),
      scenario("co-at-utg-open-hj-call", "squeeze", "CO", [["overcall", "99"], ["squeeze", "QQ+, KTs"]]),
    ]);
    const rep = stageSanity(st);
    // The CO 3-bets 43s, 54s and 65s (3 classes) and no wheel ace; the BTN's 54s (1) against A5s and A4s (2) passes.
    expect(rep.warns.filter((w) => w.startsWith("PF-SANITY-9"))).toEqual([
      "PF-SANITY-9 co-vs-utg-open: 3-bets 43s/54s/65s/53s/64s 3.0 > A5s/A4s/A3s/A2s 0.0 (hand classes)",
    ]);
    // RFI gets only the pairs PF-SANITY-7 and -8 do not check (here the same-gap 65s < 54s); the squeeze folds ATs and
    // KJs but squeezes KTs; the CO and BTN play 65s or 54s but fold the next connector up. Ordered by family, then group.
    expect(rep.warns.filter((w) => w.startsWith("PF-SANITY-10"))).toEqual([
      "PF-SANITY-10 A>K squeeze: 1 spot(s), 1 pair(s) inverted, worst co-at-utg-open-hj-call ATs plays 0.00 < KTs 1.00",
      "PF-SANITY-10 kicker squeeze: 1 spot(s), 1 pair(s) inverted, worst co-at-utg-open-hj-call KJs plays 0.00 < KTs 1.00",
      "PF-SANITY-10 same-gap rfi: 1 spot(s), 1 pair(s) inverted, worst rfi-utg 65s plays 0.00 < 54s 1.00",
      "PF-SANITY-10 same-gap vsOpen cold: 2 spot(s), 2 pair(s) inverted, worst co-vs-utg-open 76s plays 0.00 < 65s 1.00",
    ]);
    // Print-only: nothing else fires, nothing fails, and no scenario is flagged for a badge.
    expect(rep.warns.filter((w) => !/^PF-SANITY-(9|10) /.test(w))).toEqual([]);
    expect(rep.fails).toEqual([]);
    expect([rep.sanity5, rep.sanity6, rep.sanity7]).toEqual([[], [], []]);
  });
});

describe("sensitivity valuations (§6.6)", { timeout: 60_000 }, () => {
  it("scales the uncalibrated priors, swaps the fit, or changes the low-SPR rule", () => {
    const base = stageValuation(EQR_FIT, features);
    expect(base.kind).toBe("modelB");
    if (base.kind !== "modelB") return;
    expect(base.params).toEqual({ alpha: EQR_FIT.alpha, cFit: EQR_FIT.cFit, thetaO: EQR_FIT.thetaO, thetaI: EQR_FIT.thetaI, kappa3: EQR_FIT.kappa3, kappa4: EQR_FIT.kappa4 });
    expect(base.hu).toBeUndefined();
    for (const [v, k] of [["a", 0.5], ["b", 1.5]] as const) {
      const x = stageValuation(EQR_FIT, features, v);
      if (x.kind !== "modelB") throw new Error("model B expected");
      expect(x.params).toMatchObject({ alpha: EQR_FIT.alpha, cFit: EQR_FIT.cFit, cDerivedScale: k, mwCPos: MW_C_POS * k, mwUScale: k, alphaMw: EQR_FIT.alpha * k });
    }
    const c = stageValuation(EQR_FIT, features, "c");
    if (c.kind !== "modelB") throw new Error("model B expected");
    const m3 = EQR_FIT.alternatives.modelB3;
    expect(c.params).toMatchObject({ alpha: m3.alpha, cFit: m3.cFit, thetaO: m3.thetaO, thetaI: m3.thetaI });
    const e = stageValuation(EQR_FIT, features, "e");
    if (e.kind !== "modelB") throw new Error("model B expected");
    expect(e.params.sprAlpha).toBe(6);
  });

  it("(d) values every heads-up flop by Product's form by position, its surplus shrunk below SPR 6", () => {
    const d = stageValuation(EQR_FIT, features, "d");
    if (d.kind !== "modelB" || !d.hu) throw new Error("variant d needs a heads-up kernel");
    const tree: PreflopTree = buildTree(stageConfig("100bb-2.2", { players: 5 }));
    const { rO, rI } = EQR_FIT.alternatives.product;
    let deep = 0, shallow = 0;
    for (let t = 0; t < tree.termCount; t++) {
      if (tree.termKind[t] !== TERM.FLOP || tree.termNLive[t] !== 2) continue;
      const v = d.hu(tree, t);
      const s = surplusShrink(tree.termSpr[t]);
      const want = equityScaledSurplusVectors(rO.map((x) => 1 + s * (x - 1)), rI.map((x) => 1 + s * (x - 1)));
      expect(maxDiff(v.pO, want.pO)).toBeLessThan(1e-12);
      expect(maxDiff(v.pI, want.pI)).toBeLessThan(1e-12);
      expect(maxDiff(v.qI, want.qI)).toBeLessThan(1e-12);
      expect(v.qO.every((x) => x === 0)).toBe(true);
      if (s === 1) {
        deep++;
        // At full SPR the form is the fitted one, exactly.
        expect(Array.from(v.pO)).toEqual(rO);
        expect(Array.from(v.pI)).toEqual(rI.map((x) => x - 1));
      } else shallow++;
    }
    expect(deep).toBeGreaterThan(0);
    expect(shallow).toBeGreaterThan(0);
    // The shared vectors are cached per SPR, and the solver runs with them.
    const hu = productFormHu(rO, rI);
    const t0 = Array.from({ length: tree.termCount }, (_, t) => t).find((t) => tree.termKind[t] === TERM.FLOP && tree.termNLive[t] === 2)!;
    expect(hu(tree, t0)).toBe(hu(tree, t0));
    const solver = createSolver(tree, table, { valuation: d });
    solver.iterate(20);
    expect(Number.isFinite(solver.evaluate(solver.average()).nashConvMbb)).toBe(true);
  });

  it("measures the move as the ρ-weighted total variation in pp", () => {
    const { tree, avg } = solved(4, 50);
    const p = tree.nodes.findIndex((x) => x.raises === 1 && x.callers.length === 0 && !x.facingJam);
    const rho = ownReach(tree, avg, p, N);
    expect(moveAt(tree, avg, avg, p, rho)).toBe(0);
    const other = Float64Array.from(avg);
    const e0 = tree.actStart[p], A = tree.actStart[p + 1] - e0, f = tree.foldIdx[p];
    const pure = Float64Array.from(avg);
    for (let h = 0; h < N; h++)
      for (let a = 0; a < A; a++) {
        pure[(e0 + a) * N + h] = a === f ? 1 : 0;
        other[(e0 + a) * N + h] = a === f ? 0 : a === (f === 0 ? 1 : 0) ? 1 : 0;
      }
    expect(moveAt(tree, pure, other, p, rho)).toBeCloseTo(100, 9);
  });
});

describe("close calls and artifact flags (§6.9, §6.10)", { timeout: 60_000 }, () => {
  const scenario = (id: string, kind: PreflopStage["scenarios"][number]["kind"], hero: string, actions: [string, string][], extra: object = {}) => ({
    id,
    kind,
    hero,
    chip: id,
    title: id,
    description: "",
    line: "",
    reachPct: 100,
    occ: 5,
    regret: 0,
    confidence: "high" as const,
    move: 0,
    actions: actions.map(([key, range]) => ({ key, label: key, color: "call" as const, range })),
    ...extra,
  });
  const base = (scenarios: ReturnType<typeof scenario>[], stack = 100): PreflopStage => ({
    id: "t",
    label: "t",
    description: "",
    stack,
    open: 2.2,
    sizes: { sbRaise: 3, iso: 3.5, ip3: 3, blind3: 4, bbVsSb3: 3, sqzPerCallerIP: 1, sqzPerCallerBlind: 1.25, fourIP: 2.3, fourOOP: 2.5, limpReraise: 3, jamMax: 40 },
    tree: { cold4: "jam", allinOrder: "priority" },
    iterations: 1,
    occThreshold: 0.1,
    occThresholdByKind: thresholdsByKind(LADDER_START),
    brGainMbb: [],
    nashConvMbb: 0,
    snappedGainMbb: 0,
    ev: [],
    diag: { evSum: 0, frozenOccPct: 0, negativeShares: 0 },
    model: { id: "modelB-rank9", fitHash: "", sprAlpha: 1.5, sprSurplus: 6, packs: {} },
    equityTable: "",
    scenarios,
  });
  const H = (h: string) => ALL_HANDS.indexOf(h);
  /** Legend rows of B, every hand at `fill[i]` for legend action i, then `set` per hand: { hand: [B per action] }. */
  const rows = (fill: number[], set: Record<string, number[]> = {}) =>
    fill.map((v, i) => {
      const r = new Float64Array(N).fill(v);
      for (const [h, bs] of Object.entries(set)) r[H(h)] = bs[i];
      return r;
    });
  const one = (sc: ReturnType<typeof scenario>, extra: ReturnType<typeof scenario>[] = []) => decodeStage(base([...extra, sc])).get(sc.id)!;
  const at = (s: string | undefined, h: string) => (s ?? ".".repeat(169))[H(h)];
  const handsOf = (text: string | undefined) => Object.keys(parseRange(text ?? "")).sort();

  it("closeString marks pure cells whose eligible near set has 2+ actions including the chart's, ε inclusive", () => {
    expect(CLOSE_EPS).toBe(0.05);
    expect(CLOSE_USE_MIN_PCT).toBe(1);
    expect(CLOSE_LADDER).toEqual([0.2, 0.5, 1, 2]);
    // Legend [call, 3bet, fold]; every action takes well over 1% of the hands.
    const sc = scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "22+, A2s+, KQs:0.5"], ["3bet", "AKo, AQo, KQs:0.5"]], { villain: "UTG" });
    const d = one(sc);
    const s = closeString(d, rows([0, -1, 0.1], {
      AA: [1, 0.95, 0], // pure call, 3-bet exactly ε below: marked, call + 3bet = bits 0, 1
      KK: [1, 0.9499, 0], // just outside ε: not marked
      AKo: [0.5, 0.52, 0.48], // pure 3-bet, all three within ε: bits 0, 1, 2
      KQs: [0, 0, 0], // mixed (call 0.5, 3-bet 0.5): never marked
      "72o": [0.8, 0.79, 0.81], // pure fold with call and 3-bet near: bits 0, 1, 2
      QQ: [0.5, 1, 0.97], // pure call, but the near set {3bet, fold} leaves the chart's action out
    }));
    expect(s).toHaveLength(169);
    expect(at(s, "AA")).toBe("3");
    expect(at(s, "KK")).toBe(".");
    expect(at(s, "AKo")).toBe("7");
    expect(at(s, "KQs")).toBe(".");
    expect(at(s, "72o")).toBe("7");
    expect(at(s, "QQ")).toBe(".");
    // Everything else: call 0, 3-bet −1, fold 0.1 → one action near the best: no mark.
    expect(s!.replace(/\./g, "")).toBe("377"); // AA, AKo, 72o in grid order
    // No hand marked: undefined.
    expect(closeString(d, rows([0, -1, -1]))).toBeUndefined();
  });

  it("closeString leaves out actions under 1% of the reaching range, and hands out of reach", () => {
    // The 3-bet takes AA only (6 of 1,326 combos, 0.45%): off σ̄'s path, never part of a near set.
    const thin = scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "22+, A2s+"], ["3bet", "AA"]], { villain: "UTG" });
    const d = one(thin);
    expect(reachShares(d)["3bet"]).toBeLessThan(1);
    expect(at(closeString(d, rows([0, 0, -1])), "KK")).toBe(".");
    expect(closeString(d, rows([0, 0, -1]))).toBeUndefined();
    // The same values with a 3-bet range of 2%+ are marked.
    const wide = scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "22+, A2s+"], ["3bet", "AKo, AQo, AJo"]], { villain: "UTG" });
    expect(at(closeString(one(wide), rows([0, 0, -1])), "KK")).toBe("3");
    // The best is taken over the eligible actions only: the thin 3-bet is worth 1 bb more, yet call and fold, 0.03 apart,
    // are a near set of their own (bits 0 and 2), and the 3-bet stays out of it.
    const t = closeString(d, rows([0, 1, -0.03]));
    expect(at(t, "KK")).toBe("5");
    expect(at(t, "72o")).toBe("5"); // pure fold, call near
    expect(at(closeString(d, rows([0, 1, -0.06])), "KK")).toBe("."); // fold 0.06 below: alone
    // Out of reach: "." whatever the values. The hero reached this vs-3-bet spot with AA and KK only.
    const rfi = scenario("rfi-utg", "rfi", "UTG", [["open", "AA, KK, AKs:0.5"]]);
    const deep = scenario("utg-open-vs-hj-3bet", "vs3bet", "UTG", [["call", "AA, KK, AKs"]], { reachFrom: ["rfi-utg:open"] });
    const s = closeString(one(deep, [rfi]), rows([0, 0]));
    expect(at(s, "AA")).toBe("3");
    expect(at(s, "QQ")).toBe(".");
    expect(at(s, "AKs")).toBe("3"); // in reach (0.5), pure call
    expect(s!.replace(/\./g, "")).toHaveLength(3);
  });

  it("closeString handles a no-fold legend and throws above 4 legend actions", () => {
    const limp = scenario("bb-vs-sb-limp", "vsLimp", "BB", [["raise", "AA, KK, QQ, AKs"], ["check", ALL_HANDS.join(", ")]], { noFold: true });
    const s = closeString(one(limp), rows([0, -0.04]));
    expect(at(s, "AA")).toBe("3"); // raise and check within ε
    expect(at(s, "72o")).toBe("3");
    expect(() => closeString(one(limp), rows([0, 0, 0]))).toThrow(/value rows/);
    const five = scenario("x", "vs3bet", "UTG", [["call", "AA"], ["4bet", "KK"], ["shove", "QQ"], ["raise", "JJ"]]);
    expect(() => closeString(one(five), rows([0, 0, 0, 0, 0]))).toThrow(/hex digit/);
  });

  it("legendOrder lists the exported actions, then the fold", () => {
    const tree = buildTree(stageConfig("100bb-2.2", { players: 4 }));
    for (const c of classifyTree(tree)) {
      const lo = legendOrder(c);
      expect(lo.slice(0, c.order.length)).toEqual(c.order);
      expect(lo.length).toBe(tree.actStart[c.node + 1] - tree.actStart[c.node]);
      if (!c.noFold) expect(lo.at(-1)).toBe(tree.foldIdx[c.node]);
    }
  });

  it("PF-SANITY-9's flag: connectors 3-betting above every wheel ace vs a UTG–LJ open, clear cells only", () => {
    const vsUtg = scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "22+, A5s:0.5"], ["3bet", "AA, 43s, 54s, 65s:0.6, A5s:0.5"]], { villain: "UTG" });
    const st = base([vsUtg]);
    const dec = decodeStage(st);
    const f = stageFlags(st, dec, new Map()).get("co-vs-utg-open")!;
    // 65s is mixed (a tie): only 43s and 54s are clear; every wheel ace 3-bets less than they do.
    expect(f.map((x) => x.code)).toEqual(["PF-SANITY-9"]);
    expect(handsOf(f[0].hands)).toEqual(["43s", "54s"]);
    expect(handsOf(f[0].vs)).toEqual(["A2s", "A3s", "A4s", "A5s"]);
    // A close mark on 54s takes it out.
    const marked = ".".repeat(169).split("");
    marked[H("54s")] = "3";
    expect(handsOf(stageFlags(st, dec, new Map([["co-vs-utg-open", marked.join("")]])).get("co-vs-utg-open")![0].hands)).toEqual(["43s"]);
    // Against a CO opener the rule prints (stageSanity) but never flags.
    const vsCo = scenario("btn-vs-co-open", "vsOpen", "BTN", vsUtg.actions.map((a) => [a.key, a.range] as [string, string]), { villain: "CO" });
    const st2 = base([vsCo]);
    expect(stageFlags(st2, decodeStage(st2), new Map()).size).toBe(0);
    expect(stageSanity(st2).warns.some((w) => w.startsWith("PF-SANITY-9 btn-vs-co-open"))).toBe(true);
  });

  it("PF-SANITY-11 and -12: big pairs below TT–77 or flatting, clear cells only; prints every hit", () => {
    const st = base([
      scenario("rfi-utg", "rfi", "UTG", [["open", "22+, AKo"]]),
      scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "QQ, JJ:0.6, 99:0.6"], ["3bet", "AA, KK, JJ:0.4, TT, 99:0.4"]], { villain: "UTG" }),
      scenario("utg-open-vs-co-3bet", "vs3bet", "UTG", [["call", "KK, AA:0.6"], ["4bet", "AA:0.4, QQ"]], { reachFrom: ["rfi-utg:open"] }),
    ]);
    const dec = decodeStage(st);
    const flags = stageFlags(st, dec, new Map());
    // QQ calls 100% while TT 3-bets 100%; JJ (3-bet 0.4) is a mix, so only in the printed warning.
    const f11 = flags.get("co-vs-utg-open")!;
    expect(f11.map((x) => x.code)).toEqual(["PF-SANITY-11"]);
    expect(handsOf(f11[0].hands)).toEqual(["QQ"]);
    expect(handsOf(f11[0].vs)).toEqual(["TT"]);
    // KK flats the 3-bet; AA is a mix (call 0.5): only KK. No vs for -12.
    const f12 = flags.get("utg-open-vs-co-3bet")!;
    expect(f12).toEqual([{ code: "PF-SANITY-12", hands: "KK" }]);
    const warns = stageSanity(st).warns;
    expect(warns).toContain("PF-SANITY-11 co-vs-utg-open: JJ+ raising at least 0.5 less than TT–77: QQ 0.0, JJ 0.4 vs TT 1.0");
    expect(warns).toContain("PF-SANITY-12 utg-open-vs-co-3bet: AA/KK calling at least half and raising less than half: AA 0.6, KK 1.0");
    // A close mark on QQ removes the -11 flag; KK out of reach removes the -12 flag.
    const m = ".".repeat(169).split("");
    m[H("QQ")] = "3";
    expect(stageFlags(st, dec, new Map([["co-vs-utg-open", m.join("")]])).get("co-vs-utg-open")).toBeUndefined();
    const st2 = base([
      scenario("rfi-utg", "rfi", "UTG", [["open", "AA, QQ"]]),
      scenario("utg-open-vs-co-3bet", "vs3bet", "UTG", [["call", "KK, QQ"], ["4bet", "AA"]], { reachFrom: ["rfi-utg:open"] }),
    ]);
    expect(stageFlags(st2, decodeStage(st2), new Map()).size).toBe(0);
  });

  it("PF-SANITY-13 (≥ 100bb only): lower pairs jamming over higher ones; vs against the remaining hands", () => {
    const sc = scenario("utg-open-vs-co-3bet", "vs3bet", "UTG", [["call", ""], ["4bet", "AA, KK:0.5"], ["shove", "QQ, KK:0.5"]]);
    const st = base([sc]);
    const f = stageFlags(st, decodeStage(st), new Map()).get(sc.id)!;
    // KK (jam 0.5, a mix) is out of `hands`, so it is now a higher pair QQ jams over: vs AA and KK.
    expect(f.map((x) => x.code)).toEqual(["PF-SANITY-13"]);
    expect(handsOf(f[0].hands)).toEqual(["QQ"]);
    expect(handsOf(f[0].vs)).toEqual(["AA", "KK"]);
    // Unrestricted (the printed warning), KK is a lower pair too, and vs is AA alone.
    expect(stageSanity(st).warns).toContain(
      "PF-SANITY-13 utg-open-vs-co-3bet: a lower pair (AA–99) jamming at least 0.5 more than a higher one: KK 0.5, QQ 1.0 vs AA 0.0",
    );
    const st55 = base([sc], 55);
    expect(stageFlags(st55, decodeStage(st55), new Map()).size).toBe(0);
    expect(stageSanity(st55).warns.some((w) => w.startsWith("PF-SANITY-13"))).toBe(false);
  });

  it("PF-SANITY-14: offsuit A9o–A6o played 0.3 less than A4o–A2o, never A5o or suited; flags in numeric order", () => {
    const st = base([
      // Also fires -9 (54s and 43s 3-bet, no wheel ace) and -11 (QQ flats, TT 3-bets): order 9, 11, 14.
      scenario("co-vs-utg-open", "vsOpen", "CO", [["call", "QQ, A5o, A3o, A9o:0.5, A3s"], ["3bet", "AA, KK, TT, 54s, 43s, A4o"]], { villain: "UTG" }),
    ]);
    const f = stageFlags(st, decodeStage(st), new Map()).get("co-vs-utg-open")!;
    expect(f.map((x) => x.code)).toEqual(["PF-SANITY-9", "PF-SANITY-11", "PF-SANITY-14"]);
    const f14 = f[2];
    // A9o (0.5) is a mix; A8o–A6o fold while A4o and A3o play. A5o plays too but is never a vs hand; A6s folds against
    // A3s, but suited aces are not checked.
    expect(handsOf(f14.hands)).toEqual(["A6o", "A7o", "A8o"]);
    expect(handsOf(f14.vs)).toEqual(["A3o", "A4o"]);
    // A string sort would put 11 before 9.
    expect([...f.map((x) => x.code)].sort()).not.toEqual(f.map((x) => x.code));
  });

  it("annotateStage adds closeEps, close and flags before scenarios and actions, keeping every other field", () => {
    const s = solved(5, 200);
    const ladder = chooseLadder(s.tree, s.classes, s.ev.occ, { limits: SMALL_LIMITS });
    const out = exportStage({
      id: "t4",
      label: "t4",
      tree: s.tree,
      strategy: s.avg,
      classes: s.classes,
      exported: ladder.set.exported,
      ladder: ladder.steps,
      iterations: 200,
      metrics: { occ: s.ev.occ, localRegret: s.ev.localRegret, gainMbb: s.ev.gainMbb, nashConvMbb: s.ev.nashConvMbb, snappedGainMbb: 1, ev: s.ev.ev, evSum: s.ev.evSum, frozenOcc: 0, negativeShares: 0 },
      moves: null,
      twoStartFlags: null,
      fit: FIT,
      equityTable: "x",
    });
    const before = JSON.stringify(out.stage);
    const { brActionValues } = s.solver.evaluate(s.avg, { brActionValues: true });
    const input = { tree: s.tree, classes: s.classes, nodes: out.nodes, brActionValues: brActionValues! };
    const a = annotateStage(out.stage, input);
    expect(JSON.stringify(out.stage)).toBe(before); // pure
    expect(JSON.stringify(annotateStage(out.stage, input))).toBe(JSON.stringify(a)); // deterministic
    expect(a.closeEps).toBe(CLOSE_EPS);
    const keys = Object.keys(a);
    expect(keys.slice(-2)).toEqual(["closeEps", "scenarios"]);
    // Stripped of the new keys, the stage is the export as it was, field for field and in order.
    const strip = JSON.parse(JSON.stringify(a));
    delete strip.closeEps;
    for (const sc of strip.scenarios) {
      delete sc.close;
      delete sc.flags;
    }
    expect(JSON.stringify(strip)).toBe(before);
    const decoded = decodeStage(out.stage);
    let marked = 0;
    a.scenarios.forEach((sc, i) => {
      const k = Object.keys(sc);
      expect(k.at(-1)).toBe("actions");
      const extra = k.filter((x) => x === "close" || x === "flags");
      expect(k.slice(k.length - 1 - extra.length, -1)).toEqual(extra);
      // The string is closeString's on the node's legend values.
      const c = s.classes[out.nodes[i]];
      const br = legendOrder(c).map((x) => brActionValues!.subarray((s.tree.actStart[c.node] + x) * N, (s.tree.actStart[c.node] + x + 1) * N));
      expect(sc.close).toBe(closeString(decoded.get(sc.id)!, br));
      if (sc.close) marked += sc.close.replace(/\./g, "").length;
    });
    expect(marked).toBeGreaterThan(0);
    expect(flagProblems(a)).toEqual([]);
    // PF-SIZE-1's fallback on it: the stored flags are stageFlags on the close strings that are left.
    const occs = a.scenarios.filter((sc) => sc.close).map((sc) => sc.occ).sort((x, y) => x - y);
    const t = occs[occs.length >> 1];
    const d = dropClose([a], t)[0];
    expect(d.scenarios.filter((sc) => sc.close).length).toBeLessThan(occs.length);
    expect(d.closeMinOcc).toBe(t);
    const kept = new Map(d.scenarios.map((sc) => [sc.id, sc.close]));
    const want = stageFlags(d, decodeStage(d), kept);
    for (const sc of d.scenarios) expect(sc.flags, sc.id).toEqual(want.get(sc.id));
    expect(flagProblems(d)).toEqual([]);
  });

  it("dropClose removes close strings from the lowest-occ spots first and records closeMinOcc", () => {
    const str = "3" + ".".repeat(168);
    const { scenarios, ...head } = base([
      scenario("a", "vsOpen", "CO", [["call", "AA"]], { occ: 0.05, close: str }),
      scenario("b", "vsOpen", "BTN", [["call", "AA"]], { occ: 0.3, close: str }),
      scenario("c", "vsOpen", "SB", [["call", "AA"]], { occ: 5, close: str }),
    ]);
    const st: PreflopStage = { ...head, closeEps: 0.05, scenarios };
    const one = dropClose([st], 0.2)[0];
    expect(one.scenarios.map((x) => x.close !== undefined)).toEqual([false, true, true]);
    expect(one.closeMinOcc).toBe(0.2);
    expect(Object.keys(one).slice(-3)).toEqual(["closeEps", "closeMinOcc", "scenarios"]);
    expect(dropClose([st], 0.5)[0].scenarios.map((x) => x.close !== undefined)).toEqual([false, false, true]);
    expect(st.scenarios.every((x) => x.close === str)).toBe(true); // pure
    // Again on its own output: the step is replaced, not added.
    expect(Object.keys(dropClose([one], 1)[0]).filter((k) => k === "closeMinOcc")).toHaveLength(1);
    // A stage that loses nothing comes back as it was, without closeMinOcc.
    expect(dropClose([st], 0.01)[0]).toBe(st);
    expect(dropClose([one], 0.01)[0]).toBe(one);
  });

  it("dropClose recomputes the flags: a cell whose close mark is dropped is clear again", () => {
    // UTG flats the CO's 3-bet with KK 100%: a PF-SANITY-12 hit, but KK's call is close-marked (with the 4-bet), so
    // it is a tie and carries no flag while the mark is there.
    const marks = ".".repeat(169).split("");
    marks[H("KK")] = "3";
    const { scenarios, ...head } = base([
      scenario("rfi-utg", "rfi", "UTG", [["open", "22+, AKo"]], { occ: 100 }),
      scenario("utg-open-vs-co-3bet", "vs3bet", "UTG", [["call", "KK, QQ"], ["4bet", "AA, AKo"]], { reachFrom: ["rfi-utg:open"], occ: 0.3, close: marks.join("") }),
    ]);
    const st: PreflopStage = { ...head, closeEps: 0.05, scenarios };
    expect(flagProblems(st)).toEqual([]);
    expect(st.scenarios[1].flags).toBeUndefined();
    const d = dropClose([st], 0.5)[0];
    expect(d.closeMinOcc).toBe(0.5);
    expect(d.scenarios[1].close).toBeUndefined();
    expect(d.scenarios[1].flags).toEqual([{ code: "PF-SANITY-12", hands: "KK" }]);
    const k = Object.keys(d.scenarios[1]);
    expect(k[k.indexOf("actions") - 1]).toBe("flags"); // just before actions, where annotateStage puts it
    expect(flagProblems(d)).toEqual([]);
    expect(st.scenarios[1].close).toBe(marks.join("")); // pure
    // Dropping the string alone (the old fallback) leaves flags the close strings no longer give: flagProblems says so.
    const stale: PreflopStage = { ...st, scenarios: st.scenarios.map((sc) => ({ ...sc, close: undefined })) };
    expect(flagProblems(stale)).toEqual([`utg-open-vs-co-3bet: flags [] ≠ [{"code":"PF-SANITY-12","hands":"KK"}] re-derived from its close string`]);
  });
});

// ───────────── Short stacks and push/fold (§1.2, §5.2, §5.3, §6.6) ─────────────

describe("short stacks and push/fold (§1.2, §5.2, §5.3, §6.6)", { timeout: 60_000 }, () => {
  const scenario = (id: string, kind: PreflopStage["scenarios"][number]["kind"], hero: string, actions: [string, string][], extra: object = {}) => ({
    id,
    kind,
    hero,
    chip: id,
    title: id,
    description: "",
    line: "",
    reachPct: 100,
    occ: 5,
    regret: 0,
    confidence: "high" as const,
    move: 0,
    actions: actions.map(([key, range]) => ({ key, label: key, color: "call" as const, range })),
    ...extra,
  });
  const base = (scenarios: ReturnType<typeof scenario>[], stack = 25): PreflopStage => ({
    id: "t",
    label: "t",
    description: "",
    stack,
    open: 2,
    sizes: { sbRaise: 2.5, iso: 3, ip3: 3, blind3: 4, bbVsSb3: 3, sqzPerCallerIP: 1, sqzPerCallerBlind: 1.25, fourIP: 2.3, fourOOP: 2.5, limpReraise: 3, jamMax: 40 },
    tree: { cold4: "none", allinOrder: "priority" },
    iterations: 1,
    occThreshold: 0.1,
    occThresholdByKind: thresholdsByKind(LADDER_START),
    brGainMbb: [],
    nashConvMbb: 0,
    snappedGainMbb: 0,
    ev: [],
    diag: { evSum: 0, frozenOccPct: 0, negativeShares: 0 },
    model: { id: "modelB-rank9", fitHash: "", sprAlpha: 1.5, sprSurplus: 6, packs: {} },
    equityTable: "",
    scenarios,
  });
  const OPENERS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN"];
  const sid = (p: string) => p.toLowerCase().replace("+", "p");

  // The 10bb push/fold stage, solved for a few hundred iterations on the coarse table.
  const pfTree = buildTree(stageConfig("10bb-pf"));
  const pfClasses = classifyTree(pfTree);
  const pfSolver = createSolver(pfTree, table, { valuation: valuationForStage(pfTree.cfg, EQR_FIT, features) });
  pfSolver.iterate(300);
  const pfAvg = pfSolver.average();
  const pfEv = pfSolver.evaluate(pfAvg);
  const pfLadder = chooseLadder(pfTree, pfClasses, pfEv.occ);
  const pfInput = (over: Partial<StageExportInput> = {}): StageExportInput => ({
    id: "10bb-pf",
    label: "10bb · 푸시/폴드",
    tree: pfTree,
    strategy: pfAvg,
    classes: pfClasses,
    exported: pfLadder.set.exported,
    ladder: pfLadder.steps,
    iterations: 1500,
    metrics: { occ: pfEv.occ, localRegret: pfEv.localRegret, gainMbb: pfEv.gainMbb, nashConvMbb: pfEv.nashConvMbb, snappedGainMbb: 0.1, ev: pfEv.ev, evSum: pfEv.evSum, frozenOcc: 0, negativeShares: 0 },
    moves: null,
    twoStartFlags: new Set(),
    fit: FIT,
    equityTable: "table-sha",
    ...over,
  });

  it("PF-DATA-1 per mode: push/fold is exactly 8 pushes and the 36 calls of a first-in jam; the full tree keeps its counts", () => {
    expect(dataLimits(undefined)).toBe(DATA_LIMITS);
    expect(dataLimits("full")).toBe(DATA_LIMITS);
    expect(dataLimits("pushfold")).toBe(PUSHFOLD_LIMITS);
    const c = (o: Partial<ReturnType<typeof countKinds>>) => ({ rfi: 8, vsOpen: 0, vs3bet: 0, vs4bet: 0, squeeze: 0, vsLimp: 0, vsShove: 36, cold: 0, total: 44, ...o });
    expect(countProblems(c({}), PUSHFOLD_LIMITS)).toEqual([]);
    expect(countProblems(c({ vsShove: 35, total: 43 }), PUSHFOLD_LIMITS)).toEqual(["vsShove 35 outside 36–36"]);
    expect(countProblems(c({ vsOpen: 1, total: 45 }), PUSHFOLD_LIMITS)).toEqual(["vsOpen 1 outside 0–0", "total 45 > 44"]);
    // The full tree: vsShove stays under otherMax, never an exact count.
    expect(countProblems(c({ vsOpen: 30, vsLimp: 1, vsShove: 3, total: 42 }), DATA_LIMITS)).toEqual([]);
    // chooseLadder picks the tree's mode by default.
    expect(pfLadder.ok).toBe(true);
    expect(pfLadder.counts).toMatchObject({ rfi: 8, vsShove: 36, total: 44 });
    expect(chooseLadder(pfTree, pfClasses, pfEv.occ, { limits: DATA_LIMITS }).ok).toBe(false);
  });

  it("a push/fold stage: showdown equity, no draft for lacking sensitivity solves, every spot 높음 with move 0 and its reason", () => {
    expect(hasFlop(pfTree)).toBe(false);
    expect(hasFlop(buildTree(stageConfig("15bb-2")))).toBe(true);
    const v = valuationForStage(pfTree.cfg, EQR_FIT, features);
    expect(v.kind).toBe("equity");
    expect(valuationForStage(stageConfig("25bb-2"), EQR_FIT, features)).toEqual(stageValuation(EQR_FIT, features));
    const out = exportStage(pfInput({ note: "더 짧은 스택은 '푸시/폴드 내쉬' 세트를 보세요." }));
    const st = out.stage;
    expect(out.draft).toEqual([]);
    expect(st.model).toEqual({ id: "showdown-equity" });
    expect(st.tree).toEqual({ cold4: "jam", allinOrder: "priority", mode: "pushfold" });
    expect(st.description).toBe(`모두 10bb. ${PUSHFOLD_RULE_TEXT} 서로 최선인 균형 근사(착취 아님). 더 짧은 스택은 '푸시/폴드 내쉬' 세트를 보세요.`);
    expect(dataChecks(st)).toEqual([]);
    expect(st.scenarios.map((x) => x.kind).filter((k) => k !== "rfi" && k !== "vsShove")).toEqual([]);
    for (const sc of st.scenarios) {
      // 높음 with move 0, unless a data check lowered it to 낮음 and says why (a kicker inversion of this coarse,
      // short solve).
      expect(sc.move, sc.id).toBe(0);
      expect(sc.description, sc.id).toContain(`: ${PUSHFOLD_CONFIDENCE_TEXT}`);
      if (sc.confidence !== "high") {
        expect(sc.confidence, sc.id).toBe("low");
        expect(sc.description.endsWith(PUSHFOLD_CONFIDENCE_TEXT), sc.id).toBe(false);
      } else expect(sc.description.endsWith(`신뢰도 높음: ${PUSHFOLD_CONFIDENCE_TEXT}`), sc.id).toBe(true);
      // Every push carries the jam size: the stack, or the BB's 9bb when only the BB is left behind the SB.
      for (const a of sc.actions) expect(a.to, `${sc.id}:${a.key}`).toBe(a.key === "shove" ? (sc.hero === "SB" ? 9 : 10) : undefined);
    }
    // A two-start flag still lowers a spot, with its reason; a missing two-start solve is still a draft.
    const flaggedNode = out.nodes[3];
    const flagged = exportStage(pfInput({ twoStartFlags: new Set([flaggedNode]) })).stage.scenarios[3];
    expect(flagged.confidence).toBe("low");
    expect(flagged.description).toContain("다른 시작점에서 풀면");
    expect(exportStage(pfInput({ twoStartFlags: null })).draft).toEqual(["twostart"]);
    // Without a flop the export of a full-tree draft would say "민감도 풀이"; this one never does.
    expect(st.scenarios.some((x) => x.description.includes("민감도"))).toBe(false);
    expect(st.scenarios.filter((x) => x.confidence === "high").length).toBeGreaterThan(st.scenarios.length / 2);
  });

  it("writes `to` on every raise and jam (the tree's size; the stack on a jam), never on a call, limp or check", () => {
    const c100 = classifyTree(buildTree(stageConfig("100bb-2.2")));
    const spec = (classes: NodeClass[], id: string) => byId(classes, id).order.map((a) => byId(classes, id).actions[a]!);
    expect(spec(c100, "rfi-utg")).toEqual([{ key: "open", label: "오픈 2.2bb", color: "raise", to: 2.2 }]);
    expect(spec(c100, "rfi-sb").map((a) => [a.key, a.to])).toEqual([["limp", undefined], ["raise", 3]]);
    expect(spec(c100, "bb-vs-btn-open").map((a) => [a.key, a.to])).toEqual([["call", undefined], ["3bet", 8.8]]);
    expect(spec(c100, "bb-vs-sb-limp").map((a) => [a.key, a.to])).toEqual([["raise", 3.5], ["check", undefined]]);
    expect(spec(c100, "co-open-vs-btn-3bet").map((a) => [a.key, a.to])).toEqual([["call", undefined], ["4bet", 16.5], ["shove", 100]]);
    const c20 = classifyTree(buildTree(stageConfig("20bb-2")));
    expect(spec(c20, "rfi-utg").map((a) => [a.key, a.to])).toEqual([["open", 2], ["shove", 20]]);
    // The BB's jam is its stack less the 1bb ante; the SB's jam behind it is capped by the BB's.
    expect(spec(c20, "bb-vs-btn-open").map((a) => [a.key, a.to])).toEqual([["call", undefined], ["shove", 19]]);
    expect(spec(c20, "rfi-sb").map((a) => [a.key, a.to])).toEqual([["limp", undefined], ["raise", 2.5], ["shove", 19]]);
  });

  it("PF-SANITY-3: the vs-SB clause only warns in a short stage where the SB limps more than it raises first in", () => {
    const stageWith = (sbLimp: string, sbRaise: string, stack: number) =>
      base(
        [
          ...OPENERS.map((p) => scenario(`rfi-${sid(p)}`, "rfi", p, [["open", "22+, A2s+"]])),
          scenario("rfi-sb", "rfi", "SB", [["limp", sbLimp], ["raise", sbRaise]]),
          ...OPENERS.map((p) => scenario(`bb-vs-${sid(p)}-open`, "vsOpen", "BB", [["call", "22+, A2s+, K2s+, Q2s+"]], { villain: p })),
          scenario("bb-vs-sb-open", "vsOpen", "BB", [["call", "22+, A2s+"]], { villain: "SB" }),
        ],
        stack,
      );
    const limpy = "22+, A2s+, K2s+, Q2s+, A2o+, K9o+";
    const short = SANITY3_SPLIT_MAX_STACK - 10;
    expect(SANITY3_SPLIT_MAX_STACK).toBe(35);
    // The SB raises wide and limps little: a BB defending 3pp narrower against it than against the BTN fails, short
    // or deep.
    for (const stack of [short, 100]) {
      const wide = stageSanity(stageWith("22", "33+, A2s+, K2s+, Q2s+, A2o+, K9o+", stack));
      expect(wide.fails.filter((f) => f.startsWith("PF-SANITY-3")), `${stack}bb`).toHaveLength(1);
      expect(wide.fails.find((f) => f.startsWith("PF-SANITY-3"))).toMatch(/^PF-SANITY-3 BB defense vs SB [\d.]+ < vs BTN [\d.]+ − 2$/);
    }
    // A short stage's SB limps most hands and raises a few strong ones: the same gap is a warning that says why.
    const split = stageSanity(stageWith(limpy, "AA, KK", short));
    expect(split.fails.filter((f) => f.startsWith("PF-SANITY-3"))).toEqual([]);
    expect(split.warns.find((w) => w.startsWith("PF-SANITY-3"))).toMatch(/the SB raises [\d.]+% < limps [\d.]+% first in: a warning only/);
    // From 35bb on the clause fails whatever the SB's split: the shipped 100/55/35bb SBs all limp more than they
    // raise, and their gate must stay a gate.
    for (const stack of [SANITY3_SPLIT_MAX_STACK, 55, 100]) {
      const deep = stageSanity(stageWith(limpy, "AA, KK", stack));
      expect(deep.fails.filter((f) => f.startsWith("PF-SANITY-3")), `${stack}bb`).toEqual([expect.stringMatching(/^PF-SANITY-3 BB defense vs SB [\d.]+ < vs BTN [\d.]+ − 2$/)]);
      expect(deep.warns.filter((w) => w.startsWith("PF-SANITY-3")), `${stack}bb`).toEqual([]);
    }
  });

  it("PF-BANDS are printed only from 35bb", () => {
    const st = base([scenario("rfi-utg", "rfi", "UTG", [["open", "22+"]])], 25);
    expect(stageBands(st)).toEqual([]);
    expect(stageBands({ ...st, stack: BANDS_MIN_STACK }).map((b) => b.name)).toEqual(["RFI UTG"]);
  });

  it("PF-DEGEN-1 and PF-TWOSTART-RFI apply where first-in jams exist; they find a seat that never min-raises and first-in drift", () => {
    expect(degenGates(stageConfig("100bb-2.2"))).toEqual({ degen: false, twoStartRfi: false });
    expect(degenGates(stageConfig("55bb-2.2"))).toEqual({ degen: false, twoStartRfi: false });
    expect(degenGates(stageConfig("35bb-2"))).toEqual({ degen: true, twoStartRfi: true });
    expect(degenGates(stageConfig("25bb-2"))).toEqual({ degen: true, twoStartRfi: true });
    expect(degenGates(stageConfig("15bb-2"))).toEqual({ degen: true, twoStartRfi: true });
    expect(degenGates(stageConfig("10bb-pf"))).toEqual({ degen: false, twoStartRfi: true });
    // A uniform strategy on a 5-handed 25bb tree: every first-in node opens a third of its hands.
    const tree = buildTree(stageConfig("25bb-2", { players: 5 }));
    const classes = classifyTree(tree);
    const uniform = new Float64Array(tree.edgeCount * N);
    for (let p = 0; p < tree.nodeCount; p++) {
      const A = tree.actStart[p + 1] - tree.actStart[p];
      for (let e = tree.actStart[p]; e < tree.actStart[p + 1]; e++) uniform.fill(1 / A, e * N, (e + 1) * N);
    }
    expect(degenerateOpeners(tree, uniform)).toEqual([]);
    // The root (5-handed "HJ") jams or folds only; CO opens 0.5% of its combos (AA and KK, 12 of 1,326 = 0.9%: just under).
    const s = uniform.slice();
    const setNode = (p: number, f: (verb: string, h: number) => number) =>
      tree.nodes[p].actions.forEach((a, k) => {
        for (let h = 0; h < N; h++) s[(tree.actStart[p] + k) * N + h] = f(a.verb, h);
      });
    setNode(0, (verb) => (verb === "open" ? 0 : 0.5));
    const co = tree.child[tree.actStart[0] + tree.foldIdx[0]];
    const big = new Set(["AA", "KK"].map((h) => ALL_HANDS.indexOf(h)));
    setNode(co, (verb, h) => (verb === "open" ? (big.has(h) ? 1 : 0) : verb === "fold" ? (big.has(h) ? 0 : 1) : 0));
    const degen = degenerateOpeners(tree, s);
    expect(degen.map((x) => x.seat)).toEqual(["HJ", "CO"]);
    expect(degen[0].open).toBe(0);
    expect(degen[1].open).toBeCloseTo(12 / 1326, 12);
    expect(degen[1].open).toBeLessThan(DEGEN_MIN_OPEN);
    // PF-TWOSTART-RFI: identical solves agree; a 3pp drift at a first-in node is named, one at a later node is not.
    expect(twoStartRfiProblems(tree, classes, uniform, uniform)).toEqual([]);
    const drift = (p: number, d: number) => {
      const x = uniform.slice();
      const e0 = tree.actStart[p];
      for (let h = 0; h < N; h++) {
        x[e0 * N + h] -= d;
        x[(e0 + 1) * N + h] += d;
      }
      return x;
    };
    const btn = tree.child[tree.actStart[co] + tree.foldIdx[co]];
    const rfi = twoStartRfiProblems(tree, classes, uniform, drift(btn, 0.03));
    expect(rfi.map((x) => x.id)).toEqual(["rfi-btn"]);
    expect(rfi[0].d).toBeCloseTo(0.03, 12);
    expect(twoStartRfiProblems(tree, classes, uniform, drift(btn, TWOSTART_TOLERANCE * 0.9))).toEqual([]);
    const later = classes.find((c) => c.kind === "vsOpen")!.node;
    expect(twoStartRfiProblems(tree, classes, uniform, drift(later, 0.2))).toEqual([]);
    expect(actionShares(tree, drift(btn, 0.03), btn, CW)[0]).toBeCloseTo(1 / 3 - 0.03, 12);
  });

  const H = (h: string) => ALL_HANDS.indexOf(h);
  const rowsOf = (fill: number[], set: Record<string, number[]> = {}) =>
    fill.map((v, i) => {
      const r = new Float64Array(N).fill(v);
      for (const [h, xs] of Object.entries(set)) r[H(h)] = xs[i];
      return r;
    });
  const one = (sc: ReturnType<typeof scenario>, extra: ReturnType<typeof scenario>[] = []) => decodeStage(base([...extra, sc])).get(sc.id)!;
  const at = (x: string | undefined, h: string) => (x ?? ".".repeat(169))[H(h)];

  it("sensString marks a pure cell whose action falls below half in a variant, with the actions on top", () => {
    // Chart: AA, KK, QQ open pure; JJ mixed; everything else folds pure.
    const d = one(scenario("rfi-utg", "rfi", "UTG", [["open", "AA, KK, QQ, JJ:0.5"]]));
    const main = rowsOf([0, 1], { AA: [1, 0], KK: [1, 0], QQ: [0.97, 0.03], JJ: [0.5, 0.5] });
    // Variant 1: KK opens 0.4 (fold on top), QQ 0.6 (still on top); 72o opens 0.7 (the chart folds it pure).
    const v1 = rowsOf([0, 1], { AA: [1, 0], KK: [0.4, 0.6], QQ: [0.6, 0.4], JJ: [0, 1], "72o": [0.7, 0.3] });
    const s = sensString(d, main, [v1])!;
    expect(at(s, "AA")).toBe(".");
    expect(at(s, "KK")).toBe("3"); // open (the chart's, bit 0) and fold (on top in the variant, bit 1)
    expect(at(s, "QQ")).toBe("."); // still ≥ 0.5
    expect(at(s, "JJ")).toBe("."); // mixed in the chart
    expect(at(s, "72o")).toBe("3");
    expect(s.replace(/\./g, "")).toBe("33");
    expect(sensString(d, main, [main])).toBeUndefined();
    expect(SENS_FLIP).toBe(0.5);
    // Exactly 0.5 is not below half.
    expect(at(sensString(d, main, [rowsOf([0, 1], { KK: [0.5, 0.5] })]), "KK")).toBe(".");
    expect(() => sensString(d, main, [rowsOf([0, 1, 0])])).toThrow(/legend actions/);
  });

  it("sensString needs two actions in the mask: a drop that leaves the chart's action on top marks nothing", () => {
    // Three legend actions: call, 3bet, fold. AA 3-bets pure; in the variant it 3-bets 0.45, calls 0.3, folds 0.25.
    const d = one(scenario("bb-vs-co-open", "vsOpen", "BB", [["call", "KK"], ["3bet", "AA"]], { villain: "CO" }));
    const main = rowsOf([0, 0, 1], { AA: [0, 1, 0], KK: [1, 0, 0] });
    const v = rowsOf([0, 0, 1], { AA: [0.3, 0.45, 0.25], KK: [0.2, 0.7, 0.1] });
    const s = sensString(d, main, [v]);
    expect(at(s, "AA")).toBe(".");
    expect(at(s, "KK")).toBe("3"); // call (the chart's) and 3bet (the variant's top)
    // The mask is the union over every variant's top action.
    const w = rowsOf([0, 0, 1], { KK: [0.45, 0.1, 0.45] });
    expect(at(sensString(d, main, [v, w]), "KK")).toBe("3");
    const z = rowsOf([0, 0, 1], { KK: [0.2, 0.1, 0.7] });
    expect(at(sensString(d, main, [v, z]), "KK")).toBe("7");
    // Out of reach: never marked.
    const deep = one(scenario("utg-open-vs-co-3bet", "vs3bet", "UTG", [["call", "QQ"]], { reachFrom: ["rfi-utg:open"] }), [
      scenario("rfi-utg", "rfi", "UTG", [["open", "QQ"]]),
    ]);
    expect(sensString(deep, rowsOf([1, 0]), [rowsOf([0, 1])])!.replace(/\./g, "")).toBe("3");
    expect(at(sensString(deep, rowsOf([1, 0]), [rowsOf([0, 1])]), "QQ")).toBe("3");
  });

  it("sensString hears a variant only where its own play brings the hand to the spot (SENS_MIN_REACH of the chart's reach)", () => {
    expect(SENS_MIN_REACH).toBe(0.05);
    // The chart opens QQ and JJ:0.5 and calls both behind the 3-bet: reach 1 and 0.5.
    const deep = one(scenario("utg-open-vs-co-3bet", "vs3bet", "UTG", [["call", "QQ, JJ"]], { reachFrom: ["rfi-utg:open"] }), [
      scenario("rfi-utg", "rfi", "UTG", [["open", "QQ, JJ:0.5"]]),
    ]);
    const main = rowsOf([1, 0]);
    const folds = rowsOf([0, 1]); // the variant folds both behind the 3-bet
    const reach = (qq: number, jj: number) => {
      const r = new Float64Array(N);
      r[H("QQ")] = qq;
      r[H("JJ")] = jj;
      return r;
    };
    // It still opens both: both marked.
    expect(sensString(deep, main, [folds], [reach(1, 0.5)])!.replace(/\./g, "")).toBe("33");
    // It no longer opens QQ (reach 0.04 < 0.05 · 1): its σ̄ there is from early iterations, so QQ is not marked; JJ at
    // 0.025 is exactly 0.05 · 0.5 and still counts.
    const s = sensString(deep, main, [folds], [reach(0.04, 0.025)])!;
    expect(at(s, "QQ")).toBe(".");
    expect(at(s, "JJ")).toBe("3");
    // A variant that does not reach the hand adds no bit to the mask of one that does.
    const three = one(scenario("utg-open-vs-co-3bet", "vs3bet", "UTG", [["call", "QQ"], ["shove", "KK"]], { reachFrom: ["rfi-utg:open"] }), [
      scenario("rfi-utg", "rfi", "UTG", [["open", "QQ, KK"]]),
    ]);
    const m3 = rowsOf([0, 0, 0], { QQ: [1, 0, 0], KK: [0, 1, 0] });
    const callLow = rowsOf([0, 0, 0], { QQ: [0.4, 0, 0.6] }); // fold on top: bits call + fold
    const shoveTop = rowsOf([0, 0, 0], { QQ: [0.3, 0.7, 0] }); // shove on top
    expect(at(sensString(three, m3, [callLow, shoveTop], [reach(1, 0), reach(1, 0)]), "QQ")).toBe("7");
    expect(at(sensString(three, m3, [callLow, shoveTop], [reach(1, 0), reach(0.01, 0)]), "QQ")).toBe("5");
    expect(at(sensString(three, m3, [callLow, shoveTop], [reach(0.01, 0), reach(0.01, 0)]), "QQ")).toBe(".");
    expect(() => sensString(deep, main, [folds], [])).toThrow(/reach rows/);
  });

  it("annotateStage writes sens after close and before flags, on the kinds asked for; dropClose keeps it", () => {
    const s = solved(5, 200);
    const ladder = chooseLadder(s.tree, s.classes, s.ev.occ, { limits: SMALL_LIMITS });
    const out = exportStage({
      id: "t5",
      label: "t5",
      tree: s.tree,
      strategy: s.avg,
      classes: s.classes,
      exported: ladder.set.exported,
      ladder: ladder.steps,
      iterations: 200,
      metrics: { occ: s.ev.occ, localRegret: s.ev.localRegret, gainMbb: s.ev.gainMbb, nashConvMbb: s.ev.nashConvMbb, snappedGainMbb: 1, ev: s.ev.ev, evSum: s.ev.evSum, frozenOcc: 0, negativeShares: 0 },
      moves: new Float64Array(s.tree.nodeCount),
      twoStartFlags: new Set(),
      fit: FIT,
      equityTable: "x",
    });
    // A variant that folds every hand everywhere a fold exists: every pure non-fold cell flips.
    const variant = new Float64Array(s.avg.length);
    for (let p = 0; p < s.tree.nodeCount; p++) {
      const f = s.tree.foldIdx[p];
      const A = s.tree.actStart[p + 1] - s.tree.actStart[p];
      for (let k = 0; k < A; k++) variant.fill(f < 0 ? 1 / A : k === f ? 1 : 0, (s.tree.actStart[p] + k) * N, (s.tree.actStart[p] + k + 1) * N);
    }
    const { brActionValues } = s.solver.evaluate(s.avg, { brActionValues: true });
    const input = { tree: s.tree, classes: s.classes, nodes: out.nodes, brActionValues: brActionValues! };
    const a = annotateStage(out.stage, { ...input, sensitivity: { strategy: s.avg, variants: [variant] } });
    const decoded = decodeStage(out.stage);
    let marked = 0;
    a.scenarios.forEach((sc, i) => {
      const c = s.classes[out.nodes[i]];
      const order = legendOrder(c);
      const rows = (x: Float64Array) => order.map((k) => Array.from(x.subarray((s.tree.actStart[c.node] + k) * N, (s.tree.actStart[c.node] + k + 1) * N)));
      // The variant's own reach: it folds wherever it can, so behind an earlier action of the hero that had a fold it
      // reaches nothing (the BB's raise over the SB's limp, with no fold, it makes half the time).
      const vReach = ownReach(s.tree, variant, c.node, N);
      expect(sc.sens, sc.id).toBe(sensString(decoded.get(sc.id)!, rows(s.avg), [rows(variant)], [vReach]));
      if (vReach.every((x) => x === 0)) expect(sc.sens, sc.id).toBeUndefined();
      const k = Object.keys(sc);
      const extra = k.filter((x) => x === "close" || x === "sens" || x === "flags");
      expect(k.slice(k.length - 1 - extra.length, -1), sc.id).toEqual(extra);
      if (sc.sens) marked += sc.sens.replace(/\./g, "").length;
    });
    expect(marked).toBeGreaterThan(0);
    // Without the reach rule, the spots behind an earlier action would be marked from the variant's leftover σ̄.
    expect(
      a.scenarios.some((sc, i) => {
        if (!sc.reachFrom?.length) return false;
        const c = s.classes[out.nodes[i]];
        const order = legendOrder(c);
        const rows = (x: Float64Array) => order.map((k) => Array.from(x.subarray((s.tree.actStart[c.node] + k) * N, (s.tree.actStart[c.node] + k + 1) * N)));
        return sensString(decoded.get(sc.id)!, rows(s.avg), [rows(variant)]) !== undefined;
      }),
    ).toBe(true);
    const rfiOnly = annotateStage(out.stage, { ...input, sensitivity: { strategy: s.avg, variants: [variant], kinds: ["rfi"] } });
    expect(rfiOnly.scenarios.filter((sc) => sc.sens).every((sc) => sc.kind === "rfi")).toBe(true);
    expect(rfiOnly.scenarios.some((sc) => sc.sens)).toBe(true);
    // Without the sensitivity solves: no sens; dropClose keeps what is there.
    expect(annotateStage(a, input).scenarios.some((sc) => sc.sens)).toBe(false);
    const occs = a.scenarios.filter((sc) => sc.close).map((sc) => sc.occ).sort((x, y) => x - y);
    const d = dropClose([a], occs[occs.length >> 1])[0];
    expect(d.scenarios.map((sc) => sc.sens)).toEqual(a.scenarios.map((sc) => sc.sens));
    expect(() => annotateStage(out.stage, { ...input, sensitivity: { strategy: s.avg, variants: [variant.subarray(1)] } })).toThrow(/edgeCount/);
  });
});
