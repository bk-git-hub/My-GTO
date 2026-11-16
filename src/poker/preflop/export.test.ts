import { describe, expect, it } from "vitest";
import type { PreflopStage } from "../../data/sets/preflopTypes";
import { ALL_HANDS } from "../cards";
import { buildEquityTable, mulberry32, N } from "../pushfold";
import { parseRange } from "../range";
import { EQR_FIT } from "./eqrFit";
import {
  DATA_LIMITS,
  LADDER_START,
  LADDER_STEPS,
  chooseLadder,
  classifyTree,
  countKinds,
  dataChecks,
  decodeStage,
  exportSet,
  exportStage,
  ladderThresholds,
  moveAt,
  productFormHu,
  raiseAll,
  rangeText,
  reachShares,
  stageSanity,
  stageValuation,
  thresholdsByKind,
  type DataLimits,
  type NodeClass,
  type StageExportInput,
} from "./export";
import { handFeatures } from "./features";
import { comboWeights, createSolver, ownReach } from "./solve";
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
    expect(labels(sb)).toEqual(["림프", "레이즈 3bb"]);
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
    expect(cold.order.map((a) => cold.actions[a])).toEqual([{ key: "shove", label: "콜드 올인", color: "allin" }]);
    // A cold seat answering a 3-bet jam after the opener folded.
    const sh = byId(c35, "sb-at-co-open-btn-jam");
    expect([sh.kind, ...keys(sh)]).toEqual(["vsShove", "call"]);
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
      snappedGainMbb: 1.234,
      model: { id: "modelB-5f", fitHash: "fit-sha", packs: { "pack-a": { version: 2, flops: 448 } } },
      equityTable: "table-sha",
    });
    expect(stage.brGainMbb).toHaveLength(5);
    expect(stage.description).toContain("모두 100bb. 오픈 2.2bb, SB는 림프·레이즈 3bb, 3벳 IP 3배·블라인드 4배, 4벳 2.3~2.5배.");
    expect(stage.description).not.toContain("초안");
    expect(out.draft).toEqual([]);
  });

  it("badges confidence by §6.6 and says why", () => {
    const sanity = stageSanity(stage);
    const low = new Set([...sanity.sanity5.map((x) => x.id), ...sanity.sanity6.map((x) => x.id), ...out.twoStart]);
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
      expect(sc.description.includes("작은 4벳과 4벳 올인의 배분은 낮은 SPR 가정에 민감해요.")).toBe(fourBet);
      if (move >= 1) expect(sc.description).toContain(`약 ${Math.round(move)}%p 움직여요`);
      else expect(sc.description).toContain("거의 안 움직여요");
    });
    expect(stage.scenarios.find((sc) => out.twoStart.includes(sc.id))!.description).toContain("다른 시작점에서 풀면");
  });

  it("writes a draft without a measured move when the sensitivity and two-start solves did not run", () => {
    const d = exportStage(input({ moves: null, twoStartFlags: null }));
    expect(d.draft).toEqual(["sensitivity", "twostart"]);
    expect(d.stage.description).toContain("초안이에요: 민감도 풀이·두 출발점 검사 전이라");
    for (const sc of d.stage.scenarios) {
      expect(sc.move).toBe(0);
      expect(sc.description).not.toContain("움직여요");
      expect(sc.description).toContain("(초안): 민감도 풀이를 아직 안 해서");
    }
    // Same ranges and reach as the release export: only the confidence texts differ.
    expect(d.stage.scenarios.map((x) => [x.id, x.reachFrom, x.actions])).toEqual(stage.scenarios.map((x) => [x.id, x.reachFrom, x.actions]));
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
    model: { id: "modelB-5f", fitHash: "", sprAlpha: 1.5, sprSurplus: 6, packs: {} },
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
    const sh = reachShares(decodeStage(st).get("utg-open-vs-hj-3bet")!);
    // Reach: 22+ (78 combos), A2s+ (48), K2s+ (44) = 170 combos.
    expect(sh.call).toBeCloseTo((78 / 170) * 100, 9);
    expect(sh.shove).toBeCloseTo((48 / 170) * 100, 9);
    expect(sh.fold).toBeCloseTo((44 / 170) * 100, 9);
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
    const { rO, rI } = EQR_FIT.alternatives.product5;
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
