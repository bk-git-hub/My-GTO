import { describe, expect, it } from "vitest";
import { buildEquityTable, mulberry32, N } from "../pushfold";
import {
  ACT,
  ACTION_KEYS,
  buildTree,
  isTerminal,
  lineText,
  openJamConfig,
  openOr3BetConfig,
  postRank,
  pushFoldConfig,
  seatNames,
  STAGE_PRESETS,
  stageConfig,
  TERM,
  terminalNets,
  terminalOf,
  treeCounts,
  type NodeInfo,
  type PreflopTree,
  type StageConfig,
  type StageId,
} from "./tree";

// A coarse table keeps the test fast; only its equities are used, as random all-in shares.
const table = buildEquityTable(150, mulberry32(3));
const EPS = 1e-9;

const live = (cfg: StageConfig, s: number) => cfg.S - (s === cfg.players - 1 ? cfg.ante : 0);
const blindOf = (cfg: StageConfig, s: number) => (s === cfg.players - 2 ? cfg.sb : s === cfg.players - 1 ? cfg.bb : 0);

/** Configs whose trees PF-TREE-1 checks: every stage, the ablation switches, the test trees, generic seats. */
const CONFIGS: [string, StageConfig][] = [
  ...STAGE_PRESETS.map((p): [string, StageConfig] => [p.id, p.cfg]),
  ...(["100bb-2.2", "55bb-2.2", "35bb-2"] as StageId[]).flatMap((id): [string, StageConfig][] => [
    [`${id} cold4 none`, stageConfig(id, { cold4: "none" })],
    [`${id} table order`, stageConfig(id, { allinOrder: "table" })],
  ]),
  ["open-or-3-bet", openOr3BetConfig()],
  ["open-or-3-bet + flats", openOr3BetConfig({ coldCall: true, overcall: true, squeeze: true })],
  ["100bb-2.2 maxFlop 2", stageConfig("100bb-2.2", { maxFlop: 2 })],
  ...[2, 3, 4, 6].map((players): [string, StageConfig] => [`100bb-2.2 players ${players}`, stageConfig("100bb-2.2", { players })]),
  ["35bb-2 players 6", stageConfig("35bb-2", { players: 6 })],
  ["pushfold 9 x 10bb", pushFoldConfig({ players: 9, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 })],
  ["openjam 9 x 20bb", openJamConfig({ players: 9, stack: 20, sb: 0.5, bb: 1, bbAnte: 1, open: 2 })],
];

/** Follows "UTG:R HJ:C" from the root, folding every seat in between; a trailing "BB:?" folds up to BB's node. */
function follow(tree: PreflopTree, spec: string): number {
  const names = seatNames(tree.n);
  let code = 0;
  const takeFolds = (seat: number) => {
    while (!isTerminal(code) && tree.seat[code] !== seat) {
      const f = tree.foldIdx[code];
      if (f < 0) throw new Error(`${names[tree.seat[code]]} cannot fold on the way to ${spec}`);
      code = tree.child[tree.actStart[code] + f];
    }
    if (isTerminal(code)) throw new Error(`${spec}: reached a terminal before ${names[seat]}`);
  };
  for (const tok of spec.split(" ").filter(Boolean)) {
    const [name, key] = tok.split(":");
    const seat = names.indexOf(name);
    takeFolds(seat);
    if (key === "?") break;
    const a = tree.nodes[code].actions.findIndex((x) => x.key === key);
    if (a < 0) throw new Error(`${spec}: ${name} has no ${key}`);
    code = tree.child[tree.actStart[code] + a];
  }
  return code;
}
const nodeAt = (tree: PreflopTree, spec: string): NodeInfo => {
  const code = follow(tree, spec);
  if (isTerminal(code)) throw new Error(`${spec} is a terminal`);
  return tree.nodes[code];
};
const acts = (nd: NodeInfo) => nd.actions.map((a) => (a.key === "R" ? `R${a.to}` : a.key)).join(" ");

/** PF-TREE-1: structure, sizes and chip accounting of one tree. */
function checkInvariants(tree: PreflopTree, rand: () => number) {
  const { cfg, n, nodeCount, edgeCount, termCount } = tree;
  // Structure: contiguous edges, pre-order numbering, consistent parent links, every child reached once.
  expect(tree.actStart[0]).toBe(0);
  expect(tree.actStart[nodeCount]).toBe(edgeCount);
  const nodeSeen = new Uint8Array(nodeCount);
  const termSeen = new Uint8Array(termCount);
  nodeSeen[0] = 1;
  for (let i = 0; i < nodeCount; i++) {
    const A = tree.actStart[i + 1] - tree.actStart[i];
    expect(A, "no decision node has one action").toBeGreaterThanOrEqual(2);
    const nd = tree.nodes[i];
    expect(nd.actions.length).toBe(A);
    expect(tree.seat[i]).toBe(nd.seat);
    expect(tree.foldIdx[i]).toBe(nd.actions.findIndex((a) => a.key === "F"));
    if (i > 0) {
      expect(tree.parent[i]).toBeLessThan(i);
      expect(tree.child[tree.parentEdge[i]]).toBe(i);
      expect(tree.depth[i]).toBe(tree.depth[tree.parent[i]] + 1);
      expect(tree.parentEdge[i]).toBe(tree.actStart[tree.parent[i]] + nd.parentAction);
    }
    const seen = new Set<string>();
    for (let a = 0; a < A; a++) {
      const e = tree.actStart[i] + a;
      const key = ACTION_KEYS[tree.actKey[e]];
      expect(key).toBe(nd.actions[a].key);
      expect(tree.actTo[e]).toBe(nd.actions[a].to);
      expect(seen.has(key), "one size per action key").toBe(false);
      seen.add(key);
      const c = tree.child[e];
      if (isTerminal(c)) {
        expect(termSeen[terminalOf(c)]++).toBe(0);
        expect(tree.termParentEdge[terminalOf(c)]).toBe(e);
      } else expect(nodeSeen[c]++).toBe(0);
      // Sizes.
      const s = nd.seat;
      const to = tree.actTo[e];
      const jamTo = Math.min(live(cfg, s), Math.max(...nd.active.filter((o) => o !== s).map((o) => live(cfg, o))));
      expect(Math.abs(to * 100 - Math.round(to * 100)), "sizes are rounded to 0.01bb").toBeLessThan(1e-6);
      if (key === "R" || key === "J") {
        expect(to).toBeGreaterThan(nd.maxBet + EPS);
        expect(to).toBeLessThanOrEqual(live(cfg, s) + EPS);
      }
      if (key === "J") expect(to).toBe(jamTo);
      if (key === "R" && cfg.mode === "full" && nd.raises > 0) {
        // A non-all-in re-raise leaves an SPR of at least minSprAfterCall after a call.
        const potAfterCall = nd.pot + (to - nd.bet[s]) + (to - nd.maxBet);
        expect((jamTo - to) / potAfterCall).toBeGreaterThanOrEqual(cfg.minSprAfterCall - EPS);
      }
      if (key === "C") expect(to).toBe(Math.min(nd.maxBet, live(cfg, s)));
      if (key === "F" || key === "X") expect(to).toBe(nd.bet[s]);
      if (key === "X") expect(nd.bet[s]).toBe(nd.maxBet);
      if (key === "L") expect(s === tree.sbSeat && nd.raises === 0 && to === cfg.bb).toBe(true);
    }
  }
  expect(nodeSeen.every((x) => x === 1)).toBe(true);
  expect(termSeen.every((x) => x === 1)).toBe(true);

  // Terminals: chip accounting and classification.
  const out = new Float64Array(n);
  for (let t = 0; t < termCount; t++) {
    const ti = tree.terms[t];
    const k = tree.termNLive[t];
    expect(ti.seats.length).toBe(k);
    for (let s = 0; s < n; s++) expect(tree.termCommit[t * n + s]).toBe(ti.bet[s] + (s === tree.bbSeat ? cfg.ante : 0));
    expect(tree.termPot[t]).toBeCloseTo(ti.commit.reduce((a, b) => a + b, 0), 12);
    for (let j = 0; j + 1 < k; j++) expect(postRank(ti.seats[j], n)).toBeLessThan(postRank(ti.seats[j + 1], n));
    for (let j = 0; j < 4; j++) expect(tree.termSeats[t * 4 + j]).toBe(j < k ? ti.seats[j] : -1);
    const kind = tree.termKind[t];
    let shares: number[];
    if (kind === TERM.WIN) {
      expect(k).toBe(1);
      shares = [];
    } else if (kind === TERM.ALLIN) {
      expect(k).toBe(2);
      const [a, b] = ti.seats;
      expect(Math.abs(ti.bet[a] - ti.bet[b])).toBeCloseTo(tree.termRefund[t], 12);
      expect(tree.termAllinPot[t]).toBeCloseTo(tree.termPot[t] - tree.termRefund[t], 12);
      expect(ti.closer).toBeGreaterThanOrEqual(0);
      const h = Math.floor(rand() * N);
      const x = Math.floor(rand() * N);
      const e = table.eq[h * N + x];
      shares = [e, 1 - e];
      // net = e·P' + refund - T, written out independently of terminalNets.
      const refundOf = (s: number) => Math.max(0, ti.bet[s] - ti.bet[s === a ? b : a]);
      terminalNets(tree, t, shares, out);
      expect(out[a]).toBeCloseTo(e * tree.termAllinPot[t] + refundOf(a) - ti.commit[a], 12);
      expect(out[b]).toBeCloseTo((1 - e) * tree.termAllinPot[t] + refundOf(b) - ti.commit[b], 12);
    } else {
      expect(k).toBeGreaterThanOrEqual(2);
      expect(k).toBeLessThanOrEqual(cfg.maxFlop + 1);
      expect(ti.potType).toBe(ti.raises === 0 ? "limp" : ["srp", "3bp", "4bp"][ti.raises - 1]);
      if (ti.raises === 0) expect(ti.limped && k === 2 && tree.termAggressor[t] === -1).toBe(true);
      else expect(tree.termAggressor[t]).toBe(ti.raiseSeq[ti.raiseSeq.length - 1]);
      const spr = Math.min(...ti.seats.map((s) => live(cfg, s) - ti.bet[s])) / ti.pot;
      expect(tree.termSpr[t]).toBeCloseTo(spr, 12);
      if (cfg.mode === "full") expect(spr, "no flop below the minimum SPR").toBeGreaterThanOrEqual(cfg.minSprAfterCall - EPS);
      if (k === 2) {
        // A model-B-like affine share with random parameters: zero-sum per hand pair.
        const e = table.eq[Math.floor(rand() * N) * N + Math.floor(rand() * N)];
        const phi = e + (rand() - 0.2) * (e - 0.5) + (rand() - 0.5) * 0.2;
        shares = [phi, 1 - phi];
      } else {
        // Multiway shares only conserve chips when they sum to 1; the chip accounting itself is exact.
        const raw = ti.seats.map(() => rand());
        const sum = raw.reduce((p, q) => p + q, 0);
        shares = raw.map((r) => r / sum);
      }
    }
    terminalNets(tree, t, shares, out);
    expect(out.reduce((p, q) => p + q, 0), "Σ net = 0").toBeCloseTo(0, 12);
    for (let s = 0; s < n; s++) if (!ti.seats.includes(s)) expect(out[s]).toBe(-ti.commit[s]);
  }
}

describe("preflop tree: stages (§1.2) and seats (§1.1)", () => {
  it("presets carry the stage table's sizes", () => {
    const sizes = (id: StageId) => {
      const c = stageConfig(id);
      return [c.S, c.open, c.sbRaise, c.iso, c.ip3, c.blind3, c.bbVsSb3, c.fourIP, c.fourOOP, c.limpReraise];
    };
    expect(sizes("100bb-2.2")).toEqual([100, 2.2, 3, 3.5, 3, 4, 3, 2.3, 2.5, 3]);
    expect(sizes("100bb-3")).toEqual([100, 3, 3.5, 3.5, 3, 3.5, 3, 2.3, 2.5, 3]);
    expect(sizes("55bb-2.2")).toEqual([55, 2.2, 3, 3.5, 3, 4, 3, 2.3, 2.5, 3]);
    expect(sizes("35bb-2")).toEqual([35, 2, 2.5, 3, 3, 4, 3, 2.3, 2.5, 3]);
    expect(sizes("25bb-2")).toEqual([25, 2, 2.5, 3, 3, 4, 3, 2.3, 2.5, 3]);
    for (const p of STAGE_PRESETS) {
      expect(p.cfg).toMatchObject({ players: 9, sb: 0.5, bb: 1, ante: 1, sqzPerCallerIP: 1, sqzPerCallerBlind: 1.25, jamMax: 40, minSprAfterCall: 1, maxFlop: 3 });
      expect(p.cfg).toMatchObject({ coldCall: true, overcall: true, squeeze: true, sbLimp: true, cold4: "jam", allinOrder: "priority", mode: "full", valuation: "modelB" });
    }
    expect(STAGE_PRESETS.map((p) => p.status)).toEqual(["required", "required", "required", "optional", "check"]);
    // A fresh copy each time, so an override never leaks into the preset.
    stageConfig("100bb-2.2").S = 1;
    expect(stageConfig("100bb-2.2").S).toBe(100);
  });

  it("postflop order is SB, BB, then UTG..BTN; heads-up the BB acts first", () => {
    expect([7, 8, 0, 1, 6].map((s) => postRank(s, 9))).toEqual([0, 1, 2, 3, 8]);
    expect([0, 1].map((s) => postRank(s, 2))).toEqual([1, 0]);
    expect([1, 2, 0].map((s) => postRank(s, 3))).toEqual([0, 1, 2]);
  });
});

describe("preflop tree: PF-TREE-1 invariants", () => {
  for (const [name, cfg] of CONFIGS) {
    it(name, () => checkInvariants(buildTree(cfg), mulberry32(11)));
  }
});

describe("preflop tree: node and terminal counts", () => {
  // Any change to these counts must be deliberate (§2.5). Against the critic's prototype builder
  // (critic/count-frozen.mjs), the only differences are the design's final rules:
  //  - 100bb (both stages): 5,190 / 6,024 vs 5,193 / 6,030. The SB facing an iso has no jam (R4: jamOk
  //    is false and 3 x iso passes okSize), -1 node / -2 terminals; the BB facing the SB's limp-re-raise
  //    has no small 4-bet (R5: never in a limped pot), -2 / -4.
  //  - 55bb: 5,160 / 5,964 vs 5,163 / 5,970. The same SB-vs-iso jam, -1 / -2; and the SB's 4-bet over
  //    the BB's 3-bet becomes a jam, -2 / -4: the design's 3bb SB raise and 2.5x OOP 4-bet (22.5 into a
  //    9bb 3-bet) leave SPR 0.68, where the prototype's 2.5bb raise and 2.3x 4-bet left 1.04.
  //  - 35bb, 25bb and every fold-out count (1,764 / 672 at 100bb, 700 / 224 at 35bb, 1,050 / 336 without
  //    cold jams, 2,100 / 1,974 under table order) equal the prototype; open-or-3-bet has the 188 nodes
  //    §5.1 quotes.
  it("snapshot per preset and test tree", () => {
    const counts = Object.fromEntries(CONFIGS.map(([name, cfg]) => [name, treeCounts(buildTree(cfg))]));
    const c = (nodes: number, edges: number, terms: number, win: number, allin: number, flopHU: number, flop3: number, flop4: number, frozen: number, frozenRaiser: number) =>
      ({ nodes, edges, terms, win, allin, flopHU, flop3, flop4, frozen, frozenRaiser });
    expect(counts).toEqual({
      "100bb-2.2": c(5190, 11213, 6024, 1710, 3517, 657, 84, 56, 1764, 672),
      "100bb-3": c(5190, 11213, 6024, 1710, 3517, 657, 84, 56, 1764, 672),
      "55bb-2.2": c(5160, 11123, 5964, 1680, 3502, 642, 84, 56, 1764, 672),
      "35bb-2": c(2490, 5346, 2857, 669, 1903, 145, 84, 56, 700, 224),
      "25bb-2": c(1613, 3457, 1845, 387, 1258, 60, 84, 56, 413, 77),
      "100bb-2.2 cold4 none": c(3468, 7769, 4302, 1374, 2131, 657, 84, 56, 1050, 336),
      "100bb-2.2 table order": c(5190, 11213, 6024, 1710, 3517, 657, 84, 56, 2100, 1974),
      "55bb-2.2 cold4 none": c(3438, 7679, 4242, 1344, 2116, 642, 84, 56, 1050, 336),
      "55bb-2.2 table order": c(5160, 11123, 5964, 1680, 3502, 642, 84, 56, 2100, 1974),
      "35bb-2 cold4 none": c(1566, 3498, 1933, 480, 1168, 145, 84, 56, 406, 35),
      "35bb-2 table order": c(2490, 5346, 2857, 669, 1903, 145, 84, 56, 1288, 952),
      "open-or-3-bet": c(188, 492, 305, 153, 72, 80, 0, 0, 0, 0),
      "open-or-3-bet + flats": c(3464, 7758, 4295, 1371, 2130, 654, 84, 56, 1050, 336),
      "100bb-2.2 maxFlop 2": c(1956, 4255, 2300, 702, 1291, 279, 28, 0, 504, 294),
      "100bb-2.2 players 2": c(10, 27, 18, 9, 3, 6, 0, 0, 0, 0),
      "100bb-2.2 players 3": c(33, 84, 52, 23, 14, 14, 1, 0, 3, 2),
      "100bb-2.2 players 4": c(110, 263, 154, 59, 58, 32, 4, 1, 21, 11),
      "100bb-2.2 players 6": c(736, 1650, 915, 295, 457, 133, 20, 10, 213, 91),
      "35bb-2 players 6": c(396, 889, 494, 141, 282, 41, 20, 10, 96, 33),
      "pushfold 9 x 10bb": c(44, 88, 45, 9, 36, 0, 0, 0, 0, 0),
      "openjam 9 x 20bb": c(116, 248, 133, 53, 72, 8, 0, 0, 0, 0),
    });
  });
});

describe("preflop tree: node rules (§2.3) on concrete lines", () => {
  const t100 = buildTree(stageConfig("100bb-2.2"));
  const at = (tree: PreflopTree, spec: string) => acts(nodeAt(tree, spec));

  it("R3: first in, SB first in, BB vs a limp", () => {
    expect(acts(t100.nodes[0])).toBe("F R2.2");
    expect(at(t100, "SB:?")).toBe("F L R3");
    expect(at(t100, "SB:L BB:?")).toBe("X R3.5");
    const t35 = buildTree(stageConfig("35bb-2"));
    expect(acts(t35.nodes[0])).toBe("F R2 J");
    expect(at(t35, "SB:?")).toBe("F L R2.5 J");
    expect(at(t35, "SB:L BB:?")).toBe("X R3 J");
  });

  it("R4: cold calls, overcalls, the BB as 4th player, 3-bet and squeeze sizes", () => {
    expect(at(t100, "UTG:R CO:?")).toBe("F C R6.6");
    expect(at(t100, "UTG:R BB:?")).toBe("F C R8.8");
    expect(at(t100, "SB:R BB:?")).toBe("F C R9");
    expect(at(t100, "UTG:R HJ:C BTN:?")).toBe("F C R8.8");
    expect(at(t100, "UTG:R HJ:C BB:?")).toBe("F C R11.55");
    // Two callers in: only the BB may call; the SB must fold or squeeze.
    expect(at(t100, "UTG:R HJ:C CO:C BTN:?")).toBe("F R11");
    expect(at(t100, "UTG:R HJ:C CO:C SB:?")).toBe("F R14.3");
    expect(at(t100, "UTG:R HJ:C CO:C BB:?")).toBe("F C R14.3");
    const t3 = buildTree(stageConfig("100bb-3"));
    expect(at(t3, "UTG:R BTN:?")).toBe("F C R9");
    expect(at(t3, "UTG:R BB:?")).toBe("F C R10.5");
    expect(at(t3, "SB:R BB:?")).toBe("F C R10.5");
    const t35 = buildTree(stageConfig("35bb-2"));
    expect(at(t35, "UTG:R CO:?")).toBe("F C R6 J");
  });

  it("R4: the SB facing an iso jams only where other 3-bet-level jams exist", () => {
    expect(at(t100, "SB:L BB:R SB:?")).toBe("F C R10.5");
    expect(at(buildTree(stageConfig("55bb-2.2")), "SB:L BB:R SB:?")).toBe("F C R10.5");
    expect(at(buildTree(stageConfig("35bb-2")), "SB:L BB:R SB:?")).toBe("F C R9 J");
    // No 4-bet in a limped pot: the BB facing the SB's re-raise folds, calls or jams.
    expect(at(t100, "SB:L BB:R SB:R BB:?")).toBe("F C J");
  });

  it("R5: 4-bets 2.3x in position and 2.5x out of position; cold players fold or jam", () => {
    expect(at(t100, "UTG:R BTN:R UTG:?")).toBe("F C R16.5 J");
    expect(at(t100, "BTN:R BB:R BTN:?")).toBe("F C R20.24 J");
    expect(at(t100, "CO:R BTN:R CO:?")).toBe("F C R16.5 J");
    expect(at(t100, "SB:R BB:R SB:?")).toBe("F C R22.5 J");
    expect(at(buildTree(stageConfig("100bb-3")), "SB:R BB:R SB:?")).toBe("F C R26.25 J");
    // At 55bb the SB's 4-bet would leave an SPR below 1, so it becomes a jam.
    expect(at(buildTree(stageConfig("55bb-2.2")), "SB:R BB:R SB:?")).toBe("F C J");
    expect(at(t100, "BTN:R SB:R BB:?")).toBe("F J");
    expect(at(t100, "UTG:R HJ:R CO:?")).toBe("F J");
    // A squeeze pot has no small 4-bet, and only one player calls the squeeze.
    expect(at(t100, "UTG:R HJ:C BTN:R UTG:?")).toBe("F C J");
    expect(at(t100, "UTG:R HJ:C BTN:R UTG:C HJ:?")).toBe("F J");
    expect(at(t100, "UTG:R HJ:C BTN:R UTG:F HJ:?")).toBe("F C J");
    // With cold4 "none" the cold player's fold is collapsed: the opener acts next.
    const none = buildTree(stageConfig("100bb-2.2", { cold4: "none" }));
    expect(nodeAt(none, "UTG:R HJ:R").seat).toBe(0);
  });

  it("R6 and the 5-bet jam", () => {
    expect(at(t100, "UTG:R BTN:R UTG:R BTN:?")).toBe("F C J");
    expect(at(t100, "UTG:R BTN:R UTG:R BTN:J UTG:?")).toBe("F C");
    const end = follow(t100, "UTG:R BTN:R UTG:R BTN:C");
    expect(isTerminal(end)).toBe(true);
    const ti = t100.terms[terminalOf(end)];
    expect([ti.kind, ti.potType, ti.seats, ti.aggressor]).toEqual(["flop", "4bp", [0, 6], 0]);
    expect(ti.pot).toBeCloseTo(16.5 * 2 + 0.5 + 1 + 1, 12);
  });

  it("terminals carry pot type, postflop order, aggressor and SPR", () => {
    const limp = t100.terms[terminalOf(follow(t100, "SB:L BB:X"))];
    expect([limp.kind, limp.potType, limp.seats, limp.aggressor, limp.pot]).toEqual(["flop", "limp", [7, 8], -1, 3]);
    const four = t100.terms[terminalOf(follow(t100, "UTG:R HJ:C CO:C BB:C"))];
    expect([four.potType, four.seats, four.aggressor]).toEqual(["srp", [8, 0, 4, 5], 0]);
    expect(four.pot).toBeCloseTo(2.2 * 4 + 0.5 + 1, 12);
    expect(four.spr).toBeCloseTo((99 - 2.2) / four.pot, 12);
    const sb3 = t100.terms[terminalOf(follow(t100, "BTN:R SB:R BTN:C"))];
    expect([sb3.potType, sb3.seats, sb3.aggressor]).toEqual(["3bp", [7, 6], 7]);
    const jam = t100.terms[terminalOf(follow(t100, "UTG:R BTN:R UTG:J BTN:C"))];
    expect([jam.kind, jam.seats, jam.allinPot, jam.refund]).toEqual(["allin", [0, 6], 202.5, 0]);
    // With only the BB left to answer, UTG's jam is capped at the BB's 99 (it paid the ante), so nothing comes back.
    const bbCall = t100.terms[terminalOf(follow(t100, "UTG:R BB:R UTG:J BB:C"))];
    expect([bbCall.allinPot, bbCall.refund]).toEqual([99 + 99 + 0.5 + 1, 0]);
    const bbJam = t100.terms[terminalOf(follow(t100, "UTG:R HJ:R BB:J HJ:F UTG:C"))];
    expect([bbJam.seats, bbJam.bet[0], bbJam.bet[8], bbJam.refund, bbJam.refundSeat]).toEqual([[8, 0], 99, 99, 0, -1]);
    const coldJam = t100.terms[terminalOf(follow(t100, "UTG:R HJ:R CO:J HJ:F UTG:F BTN:F SB:F BB:C"))];
    expect([coldJam.seats, coldJam.refund, coldJam.refundSeat]).toEqual([[8, 5], 1, 5]);
    expect(coldJam.allinPot).toBeCloseTo(99 * 2 + 2.2 + 6.6 + 0.5 + 1, 12);
  });
});

/** The R1 answer order after the jam that nd faces, computed from the public state alone. */
function expectedAnswers(tree: PreflopTree, nd: NodeInfo): number[] {
  const { cfg, n } = tree;
  const after = (s: number) => (s - nd.jammer + n) % n;
  const answerers = nd.active.filter((o) => o !== nd.jammer);
  if (cfg.mode === "openjam" && !nd.jamFirstIn) return [nd.opener];
  if (cfg.mode !== "full" || nd.jamFirstIn || cfg.allinOrder === "table") return answerers.sort((a, b) => after(a) - after(b));
  const prev = nd.raiseSeq.slice(0, -1);
  const key = (o: number): [number, number] =>
    prev.includes(o) ? [0, -prev.lastIndexOf(o)] : nd.bet[o] > blindOf(cfg, o) + EPS ? [1, after(o)] : [2, after(o)];
  return answerers.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
}

/** PF-TREE-2 (a): every jam is answered in the expected order, F or C each, and the first call closes. */
function checkAnswerOrder(tree: PreflopTree): { firstIn: number; reraising: number } {
  const counts = { firstIn: 0, reraising: 0 };
  for (const nd of tree.nodes) {
    const last = nd.line[nd.line.length - 1];
    if (!nd.facingJam || last.key !== "J" || last.seat !== nd.jammer) continue; // the first answer to each jam
    expect(nd.raiseSeq[nd.raiseSeq.length - 1]).toBe(nd.jammer);
    expect(nd.jamFirstIn).toBe(nd.raiseSeq.length === 1);
    counts[nd.jamFirstIn ? "firstIn" : "reraising"]++;
    const order: number[] = [];
    let code = nd.id;
    while (!isTerminal(code)) {
      const m = tree.nodes[code];
      expect(acts(m)).toBe("F C");
      expect(m.jammer).toBe(nd.jammer);
      order.push(m.seat);
      const call = tree.child[tree.actStart[code] + 1];
      expect(isTerminal(call)).toBe(true);
      const ti = tree.terms[terminalOf(call)];
      expect([ti.kind, ti.closer, ti.jammer]).toEqual(["allin", m.seat, nd.jammer]);
      code = tree.child[tree.actStart[code] + tree.foldIdx[code]];
    }
    const won = tree.terms[terminalOf(code)];
    expect([won.kind, won.seats]).toEqual(["win", [nd.jammer]]);
    expect(order, lineText(nd.line, tree.n)).toEqual(expectedAnswers(tree, nd));
  }
  return counts;
}

/** PF-TREE-2 (b): who the first call may fold out under the priority rule. */
function checkFoldOuts(tree: PreflopTree) {
  const { cfg, n } = tree;
  for (const ti of tree.terms) {
    expect(tree.termFrozen[ti.id]).toBe(ti.frozen.length);
    expect(tree.termFrozenRaisers[ti.id]).toBe(ti.frozenRaisers.length);
    const seq = ti.raiseSeq;
    expect(ti.frozenRaisers).toEqual(ti.frozen.filter((f) => seq.includes(f)));
    if (ti.frozen.length === 0) continue;
    expect(ti.kind).toBe("allin");
    const c = ti.closer;
    const closerNode = tree.nodes[ti.parent];
    expect(closerNode.seat).toBe(c);
    const after = (s: number) => (s - ti.jammer + n) % n;
    for (const f of ti.frozen) {
      expect(ti.seats.includes(f)).toBe(false);
      expect(ti.bet[f]).toBeGreaterThan(blindOf(cfg, f) + EPS);
      if (seq.includes(f)) expect(seq.lastIndexOf(c), lineText(ti.line, n)).toBeGreaterThan(seq.lastIndexOf(f));
      else {
        const closerVoluntary = closerNode.bet[c] > blindOf(cfg, c) + EPS;
        expect(seq.includes(c) || (closerVoluntary && after(c) < after(f)), lineText(ti.line, n)).toBe(true);
      }
    }
  }
}

describe("preflop tree: PF-TREE-2 all-in answer order (R1)", () => {
  for (const [name, cfg] of CONFIGS.filter(([, c]) => c.mode === "full" && c.allinOrder === "priority")) {
    it(`${name}: priority order, first call closes, fold-outs only by a higher-priority caller`, () => {
      const tree = buildTree(cfg);
      const counts = checkAnswerOrder(tree);
      if (cfg.players === 9 && cfg.S <= 40) expect(counts.firstIn).toBeGreaterThan(0);
      if (cfg.players === 9) expect(counts.reraising).toBeGreaterThan(0);
      checkFoldOuts(tree);
    });
  }

  it("table order (PF-ABLATE only) answers every jam in table order and folds out raisers", () => {
    const tree = buildTree(stageConfig("100bb-2.2", { allinOrder: "table" }));
    checkAnswerOrder(tree);
    // §2.8: UTG opens, HJ 3-bets, CO jams, UTG calls: HJ is folded out.
    expect(nodeAt(tree, "UTG:R HJ:R CO:J").seat).toBe(6);
    const ti = tree.terms[terminalOf(follow(tree, "UTG:R HJ:R CO:J UTG:C"))];
    expect([ti.frozen, ti.frozenRaisers]).toEqual([[4], [4]]);
  });

  it("the design's examples under the priority rule", () => {
    const t100 = buildTree(stageConfig("100bb-2.2"));
    // The 3-bettor answers a cold jam first, then the opener, then the cold seats.
    expect(nodeAt(t100, "UTG:R HJ:R CO:J").seat).toBe(4);
    const chain = ["UTG:R HJ:R CO:J HJ:F", "UTG:R HJ:R CO:J HJ:F UTG:F", "UTG:R HJ:R CO:J HJ:F UTG:F BTN:F", "UTG:R HJ:R CO:J HJ:F UTG:F BTN:F SB:F"];
    expect(chain.map((l) => nodeAt(t100, l).seat)).toEqual([0, 6, 7, 8]);
    const hjCalls = t100.terms[terminalOf(follow(t100, "UTG:R HJ:R CO:J HJ:C"))];
    expect([hjCalls.closer, hjCalls.frozen, hjCalls.frozenRaisers]).toEqual([4, [0], [0]]);
    // A cold jam over a squeeze: squeezer, opener, then the flatter, then the blinds behind.
    expect(expectedAnswers(t100, nodeAt(t100, "UTG:R HJ:C CO:R BTN:J"))).toEqual([5, 0, 4, 7, 8]);
    // The SB's jam over the BB's squeeze: the BB (most recent raise) answers first; its call folds out the opener.
    expect(nodeAt(t100, "BTN:R SB:C BB:R BTN:C SB:J").seat).toBe(8);
    const bbCalls = t100.terms[terminalOf(follow(t100, "BTN:R SB:C BB:R BTN:C SB:J BB:C"))];
    expect([bbCalls.frozen, bbCalls.frozenRaisers]).toEqual([[6], [6]]);
    // 35bb: the opener answers the SB's 3-bet jam, so it is never folded out with 2bb in.
    const t35 = buildTree(stageConfig("35bb-2"));
    expect(nodeAt(t35, "BTN:R SB:J").seat).toBe(6);
    // A first-in jam keeps pushfold's table order.
    expect(nodeAt(t35, "HJ:J").seat).toBe(5);
  });
});

// ───────────── reductions: the reference solvers' games ─────────────

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
const folds = (seats: number[]) => seats.map((s) => `${s}:F`);

interface RefPath {
  steps: string[];
  kind: "win" | "allin" | "flop";
  seats: number[];
  /** Expected nets for given all-in or flop shares (by seat), or the fixed nets of a win. */
  nets: (share: (s: number) => number) => number[];
}

/** Root-to-terminal paths of the tree: the decisions taken (forced folds left out) and the outcome. */
function treePaths(tree: PreflopTree): Map<string, number> {
  const m = new Map<string, number>();
  for (const ti of tree.terms) {
    const key = `${ti.line.filter((l) => !l.forced).map((l) => `${l.seat}:${l.key}`).join(" ")} => ${ti.kind} ${[...ti.seats].sort((a, b) => a - b).join(",")}`;
    expect(m.has(key)).toBe(false);
    m.set(key, ti.id);
  }
  return m;
}

function compareGame(tree: PreflopTree, ref: RefPath[]) {
  const paths = treePaths(tree);
  const refKeys = ref.map((p) => `${p.steps.join(" ")} => ${p.kind} ${[...p.seats].sort((a, b) => a - b).join(",")}`);
  expect([...paths.keys()].sort()).toEqual([...refKeys].sort());
  const rand = mulberry32(5);
  const out = new Float64Array(tree.n);
  ref.forEach((p, k) => {
    const t = paths.get(refKeys[k]) as number;
    const ti = tree.terms[t];
    const bySeat = new Map<number, number>();
    if (p.kind === "allin") {
      const e = rand();
      bySeat.set(p.seats[0], e).set(p.seats[1], 1 - e);
    } else if (p.kind === "flop") {
      const phi = rand() * 1.4 - 0.2;
      bySeat.set(p.seats[0], phi).set(p.seats[1], 1 - phi);
    }
    terminalNets(tree, t, ti.seats.map((s) => bySeat.get(s) ?? 0), out);
    const want = p.nets((s) => bySeat.get(s) ?? 0);
    for (let s = 0; s < tree.n; s++) expect(out[s], `${refKeys[k]} seat ${s}`).toBeCloseTo(want[s], 12);
  });
}

/** solvePushFold's game and chip formulas (live, effOf, deadOf, allFoldWin), written out from pushfold.ts. */
function pushFoldRef(setup: { players: number; stack: number; sb: number; bb: number; bbAnte: number }): RefPath[] {
  const { players: n, stack, sb, bb, bbAnte } = setup;
  const SB = n - 2, BB = n - 1;
  const blind = (k: number) => (k === SB ? sb : k === BB ? bb : 0);
  const liveOf = (k: number) => stack - (k === BB ? bbAnte : 0);
  const effOf = (i: number, j: number) => Math.min(liveOf(i), liveOf(j));
  const deadOf = (i: number, j: number) => bbAnte + (i !== SB && j !== SB ? sb : 0) + (i !== BB && j !== BB ? bb : 0);
  const allFoldWin = bbAnte + sb + bb;
  // Folded seats lose their blind, and the BB its ante as well.
  const lost = (k: number) => -(blind(k) + (k === BB ? bbAnte : 0));
  const out: RefPath[] = [];
  for (let i = 0; i < n - 1; i++) {
    const pre = folds(range(0, i));
    for (let j = i + 1; j < n; j++) {
      out.push({
        steps: [...pre, `${i}:J`, ...folds(range(i + 1, j)), `${j}:C`],
        kind: "allin",
        seats: [i, j],
        nets: (sh) => range(0, n).map((k) => (k === i || k === j ? sh(k) * (2 * effOf(i, j) + deadOf(i, j)) - effOf(i, j) - (k === BB ? bbAnte : 0) : lost(k))),
      });
    }
    out.push({ steps: [...pre, `${i}:J`, ...folds(range(i + 1, n))], kind: "win", seats: [i], nets: () => range(0, n).map((k) => (k === i ? allFoldWin - blind(i) : lost(k))) });
  }
  out.push({ steps: folds(range(0, n - 1)), kind: "win", seats: [BB], nets: () => range(0, n).map((k) => (k === BB ? sb : lost(k))) });
  return out;
}

/**
 * solveOpenJam's game, written out from openjam.ts: first in F / open / J; a first-in jam is answered in
 * table order and the first call closes; facing an open each seat behind folds or re-jams and only the BB
 * may flat; after a re-jam the seats behind fold and only the opener answers; a BB flat goes to the flop
 * with flatPot(i). Chip formulas: effOf, deadOf, flatPot, and the gains vsOpenGains and gainOpen use.
 */
function openJamRef(setup: { players: number; stack: number; sb: number; bb: number; bbAnte: number; open: number }): RefPath[] {
  const { players: n, stack, sb, bb, bbAnte, open: r } = setup;
  const SB = n - 2, BB = n - 1;
  const blind = (k: number) => (k === SB ? sb : k === BB ? bb : 0);
  const liveOf = (k: number) => stack - (k === BB ? bbAnte : 0);
  const effOf = (i: number, j: number) => Math.min(liveOf(i), liveOf(j));
  const deadOf = (i: number, j: number) => bbAnte + (i !== SB && j !== SB ? sb : 0) + (i !== BB && j !== BB ? bb : 0);
  const allFoldWin = bbAnte + sb + bb;
  const flatPot = (i: number) => 2 * r + bbAnte + (i !== SB ? sb : 0);
  const lost = (k: number) => -(blind(k) + (k === BB ? bbAnte : 0));
  const allin = (i: number, j: number, folded: (k: number) => number) => (sh: (s: number) => number) =>
    range(0, n).map((k) => (k === i || k === j ? sh(k) * (2 * effOf(i, j) + deadOf(i, j)) - effOf(i, j) - (k === BB ? bbAnte : 0) : folded(k)));
  const out: RefPath[] = [];
  for (let i = 0; i < n - 1; i++) {
    const pre = folds(range(0, i));
    for (let j = i + 1; j < n; j++) out.push({ steps: [...pre, `${i}:J`, ...folds(range(i + 1, j)), `${j}:C`], kind: "allin", seats: [i, j], nets: allin(i, j, lost) });
    out.push({ steps: [...pre, `${i}:J`, ...folds(range(i + 1, n))], kind: "win", seats: [i], nets: () => range(0, n).map((k) => (k === i ? allFoldWin - blind(i) : lost(k))) });
    for (let j = i + 1; j < n; j++) {
      const mid = [...pre, `${i}:R`, ...folds(range(i + 1, j))];
      // The re-jammer's gain over folding when the opener folds is r + deadOf(i, j) + blind(j), as in vsOpenGains.
      const jamWins = () => range(0, n).map((k) => (k === j ? r + deadOf(i, j) + blind(j) + lost(j) : k === i ? -r : lost(k)));
      out.push({ steps: [...mid, `${j}:J`, `${i}:F`], kind: "win", seats: [j], nets: jamWins });
      out.push({ steps: [...mid, `${j}:J`, `${i}:C`], kind: "allin", seats: [i, j], nets: allin(i, j, lost) });
      if (j === BB) {
        // Flop after the BB's flat: the pot is flatPot(i), the opener has r in and the BB r plus the ante.
        out.push({
          steps: [...mid, `${j}:C`],
          kind: "flop",
          seats: [i, j],
          nets: (sh) => range(0, n).map((k) => (k === i ? sh(i) * flatPot(i) - r : k === BB ? sh(BB) * flatPot(i) - r - bbAnte : lost(k))),
        });
      }
    }
    out.push({ steps: [...pre, `${i}:R`, ...folds(range(i + 1, n))], kind: "win", seats: [i], nets: () => range(0, n).map((k) => (k === i ? allFoldWin - blind(i) : lost(k))) });
  }
  out.push({ steps: folds(range(0, n - 1)), kind: "win", seats: [BB], nets: () => range(0, n).map((k) => (k === BB ? sb : lost(k))) });
  return out;
}

describe("preflop tree: reduction modes equal the reference solvers' games", () => {
  const pf = [
    { players: 9, stack: 10, sb: 0.5, bb: 1, bbAnte: 1 },
    { players: 6, stack: 8, sb: 0.5, bb: 1, bbAnte: 1 },
    { players: 3, stack: 15, sb: 0.5, bb: 1, bbAnte: 1 },
    { players: 2, stack: 10, sb: 0.5, bb: 1, bbAnte: 0 },
    { players: 2, stack: 2, sb: 0, bb: 0, bbAnte: 1 }, // PF-TOY-2
  ];
  for (const setup of pf) {
    it(`pushfold ${setup.players} x ${setup.stack}bb: first in F/J, F/C in table order, first call closes`, () => {
      const tree = buildTree(pushFoldConfig(setup));
      compareGame(tree, pushFoldRef(setup));
      checkAnswerOrder(tree);
      expect(tree.termFrozen.every((x) => x === 0)).toBe(true);
      for (const nd of tree.nodes) expect(acts(nd)).toBe(nd.facingJam ? "F C" : "F J");
    });
  }

  it("PF-TOY-2's game: P1 jams 1 into a dead ante of 1, the showdown pot is 3", () => {
    const tree = buildTree(pushFoldConfig({ players: 2, stack: 2, sb: 0, bb: 0, bbAnte: 1 }));
    expect([tree.nodeCount, tree.termCount]).toEqual([2, 3]);
    expect(tree.actTo[tree.actStart[0] + 1]).toBe(1);
    const nets = (spec: string, share = 0.5) => Array.from(terminalNets(tree, terminalOf(follow(tree, spec)), [share, 1 - share]), (x) => x + 0);
    expect(nets("SB:F")).toEqual([0, 0]);
    expect(nets("SB:J BB:F")).toEqual([1, -1]);
    expect(tree.termAllinPot[terminalOf(follow(tree, "SB:J BB:C"))]).toBe(3);
  });

  const oj = [
    { players: 9, stack: 20, sb: 0.5, bb: 1, bbAnte: 1, open: 2 },
    { players: 9, stack: 12, sb: 0.5, bb: 1, bbAnte: 1, open: 2 },
    { players: 6, stack: 15, sb: 0.5, bb: 1, bbAnte: 1, open: 2.2 },
    { players: 2, stack: 20, sb: 0.5, bb: 1, bbAnte: 1, open: 2 },
  ];
  for (const setup of oj) {
    it(`openjam ${setup.players} x ${setup.stack}bb: only the BB flats, only the opener answers a re-jam`, () => {
      const tree = buildTree(openJamConfig(setup));
      compareGame(tree, openJamRef(setup));
      checkAnswerOrder(tree);
      expect(tree.termFrozen.every((x) => x === 0)).toBe(true);
      for (const ti of tree.terms.filter((x) => x.kind === "flop")) {
        // The oneSided kernel needs the BB and the opener: an SRP with the opener as aggressor.
        expect([ti.potType, ti.aggressor, ti.seats.includes(tree.bbSeat)]).toEqual(["srp", ti.opener, true]);
      }
    });
  }

  it("openjam closed-form sizes: 9 seats", () => {
    const tree = buildTree(openJamConfig({ players: 9, stack: 20, sb: 0.5, bb: 1, bbAnte: 1, open: 2 }));
    // First in 8 nodes; per opener i: 8-i jam answers, 8-i open answers, 8-i opener answers to re-jams.
    expect(tree.nodeCount).toBe(8 + 3 * 36);
    expect(tree.termCount).toBe(1 + 3 * 36 + 3 * 8);
    expect(acts(nodeAt(tree, "UTG:R BB:?"))).toBe("F C J");
    expect(acts(nodeAt(tree, "UTG:R SB:?"))).toBe("F J");
    // After CO re-jams, BTN, SB and BB fold without a decision and UTG answers.
    expect(nodeAt(tree, "UTG:R CO:J").seat).toBe(0);
  });
});

describe("preflop tree: misc", () => {
  it("ACT codes and lineText", () => {
    expect(ACTION_KEYS.map((k) => ACT[k])).toEqual([0, 1, 2, 3, 4, 5]);
    const t100 = buildTree(stageConfig("100bb-2.2"));
    const nd = nodeAt(t100, "UTG:R HJ:C BTN:R UTG:?");
    expect(lineText(nd.line, 9)).toBe("UTG:R2.2 HJ:C BTN:R8.8");
    expect(nd.line.filter((l) => l.key === "F").length).toBe(6);
    expect([nd.opener, nd.threeBettor, nd.callers, nd.raiseSeq, nd.heroActed, nd.raises]).toEqual([0, 6, [4], [0, 6], true, 2]);
    expect(nd.line.map((l) => l.verb).filter((v) => v !== "fold")).toEqual(["open", "call", "squeeze"]);
    const iso = nodeAt(t100, "SB:L BB:R SB:?");
    expect([iso.limped, iso.opener, iso.heroActed]).toEqual([true, 8, true]);
    expect(iso.actions.map((a) => a.verb)).toEqual(["fold", "call", "reraise"]);
    expect(t100.maxDepth).toBe(13);
  });
});
