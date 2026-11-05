import { describe, expect, it } from "vitest";
import { parseCards, type Card } from "../poker/cards";
import { evaluate } from "../poker/evaluator";
import { parseRange } from "../poker/range";
import { COMBOS } from "../play/handInfo";
import * as solver from "../solver/index";
import type { SolverInput } from "../solver/types";
import { decodeFlopFile, nodeActionTotals, pathKey, Q_MAX, validateFlopFile } from "./format";
import { compatibleWeights, extractFlop, rangeEquity, summarizeFile } from "./extract";

const weights = (text: string): Float32Array => {
  const r = parseRange(text);
  return Float32Array.from(COMBOS, (c) => r[c.hand] ?? 0);
};

/** Brute force: every compatible hand pair, every runout. */
function bruteEquity(board: Card[], w0: ArrayLike<number>, w1: ArrayLike<number>): number {
  const dead = new Set(board);
  let num = 0, den = 0;
  for (let i = 0; i < 1326; i++) {
    const h = COMBOS[i].cards;
    if (!(w0[i] > 0) || dead.has(h[0]) || dead.has(h[1])) continue;
    for (let j = 0; j < 1326; j++) {
      const o = COMBOS[j].cards;
      if (!(w1[j] > 0) || dead.has(o[0]) || dead.has(o[1]) || h.includes(o[0]) || h.includes(o[1])) continue;
      const used = new Set([...board, ...h, ...o]);
      let s = 0, n = 0;
      for (let t = 0; t < 52; t++)
        for (let r = t + 1; r < 52; r++) {
          if (used.has(t) || used.has(r)) continue;
          const a = evaluate([...board, t, r, ...h], 7), b = evaluate([...board, t, r, ...o], 7);
          s += a > b ? 1 : a === b ? 0.5 : 0;
          n++;
        }
      num += w0[i] * w1[j] * (s / n);
      den += w0[i] * w1[j];
    }
  }
  return num / den;
}

describe("range helpers", () => {
  it("rangeEquity matches brute force with card removal and ties", () => {
    const board = parseCards("AsKh7d");
    const w0 = weights("77, AQs, 65s:0.5, KQo:0.25");
    const w1 = weights("AA, KJs, QJs, 76s:0.5");
    const [e0, e1] = rangeEquity(board, w0, w1);
    expect(e0 + e1).toBeCloseTo(1, 12);
    expect(e0).toBeCloseTo(bruteEquity(board, w0, w1), 9);
  });

  it("compatibleWeights is inclusion–exclusion over shared cards", () => {
    const board = parseCards("AsKh7d");
    const opp = weights("QQ, JTs");
    const cs = compatibleWeights(board, opp);
    const dead = new Set(board);
    for (const i of [0, 100, 500, 900, 1325]) {
      const h = COMBOS[i].cards;
      if (dead.has(h[0]) || dead.has(h[1])) {
        expect(cs[i]).toBe(0);
        continue;
      }
      let s = 0;
      COMBOS.forEach((c, j) => {
        if (opp[j] > 0 && !dead.has(c.cards[0]) && !dead.has(c.cards[1]) && !h.includes(c.cards[0]) && !h.includes(c.cards[1])) s += opp[j];
      });
      expect(cs[i]).toBeCloseTo(s, 9);
    }
  });
});

const hasSolve = typeof (solver as { solve?: unknown }).solve === "function";
if (!hasSolve) console.warn("src/solver/index.ts does not export solve() yet: skipping the extract tests that need a real solve");

describe.skipIf(!hasSolve)("extractFlop on a real solve", () => {
  // Tiny flop: a dozen combos a side, one flop size with an all-in raise, checks only on the turn and river.
  const board = parseCards("AsKh7d");
  const input: SolverInput = {
    board,
    ranges: [weights("77, KQs, QJs, 65s:0.5"), weights("AQs, KJs, T9s, 88:0.5")],
    pot: 10,
    stack: 10,
    sizes: {
      flop: [{ bet: [0.5], raise: [1] }, { bet: [0.5], raise: [1] }],
      turn: [{ bet: [], raise: [] }, { bet: [], raise: [] }],
      river: [{ bet: [], raise: [] }, { bet: [], raise: [] }],
    },
    raiseLimit: 1,
    addAllIn: false,
  };
  const sol = solver.solve(input, { iterations: 300, targetExploitability: 0.2 });
  const res = extractFlop(input, sol, { scenario: "test-spot", version: 1 });
  const flop = decodeFlopFile(res.file);

  it("writes a valid, prefix-closed file with every flop node", () => {
    expect(validateFlopFile(res.file)).toEqual([]);
    expect(res.file.board).toBe("AsKh7d");
    expect(res.file.nodes.map((n) => pathKey(n.path))).toEqual(["", "0", "1", "0.1", "1.2", "0.1.2"]);
    expect(res.tooBig).toBe(false);
    expect(res.bytes).toBe(new TextEncoder().encode(res.json).length);
    expect(JSON.parse(res.json)).toEqual(res.file);
    const root = res.file.nodes[0];
    expect(root.actions.map((a) => [a.kind, a.to, a.next])).toEqual([
      ["check", 0, "action"],
      ["bet", 5, "action"],
    ]);
    expect(res.file.nodes[2].actions.map((a) => a.next)).toEqual(["fold", "street", "action"]);
    expect(res.file.nodes[4].actions.map((a) => [a.kind, a.next])).toEqual([
      ["fold", "fold"],
      ["call", "allin-runout"],
    ]);
    expect(root.reach).toBeUndefined();
  });

  it("decodes to the solver's strategies within quantization error and EVs within 0.01 bb", () => {
    const start = sol.node([]).ranges;
    for (const node of flop.nodes) {
      const steps = node.path.map((action) => ({ action }));
      const sn = sol.node(steps);
      const p = sn.player!;
      expect(node.player).toBe(p);
      const stored = new Set(node.combos);
      for (let i = 0; i < 1326; i++) {
        const rel = start[p][i] > 0 ? sn.ranges[p][i] / start[p][i] : 0;
        if (!stored.has(i)) expect(rel).toBeLessThan(0.5 / Q_MAX + 1e-9);
      }
      node.combos.forEach((c, j) => {
        expect(Math.abs(node.reach[j] - sn.ranges[p][c] / start[p][c])).toBeLessThanOrEqual(0.5 / Q_MAX + 1e-6);
        node.actions.forEach((a, k) => {
          expect(Math.abs(node.strategy[k][j] - sn.strategy![k][c])).toBeLessThan(1 / Q_MAX + 1e-6);
          const child = sol.node([...steps, { action: k }]);
          const ev = child.ev[p][c];
          if (a.kind === "fold") expect(node.ev[k][j]).toBeCloseTo(ev, 6);
          else if (Number.isNaN(ev)) expect(node.ev[k][j]).toBeNaN();
          else expect(Math.abs(node.ev[k][j] - ev)).toBeLessThanOrEqual(0.01);
        });
      });
    }
  });

  it("summarizes the root and the depth-2 nodes", () => {
    expect(res.summaryNodes.map((d) => pathKey(d.path))).toEqual(["", "0", "1", "0.1", "1.2"]);
    expect(res.summaryNodes[0]).toMatchObject({ player: 0, labels: ["체크", "벳 50%"], kinds: ["check", "bet"] });
    const s = res.summary;
    expect(s.freq.length).toBe(5);
    s.freq.forEach((row, i) => {
      if (!row) return;
      expect(row.length).toBe(res.summaryNodes[i].labels.length);
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    });
    expect(s.freq[0]).toEqual(nodeActionTotals(flop.node([])!).map((x) => Math.round(x * 1000) / 1000));
    expect(s.equity[0] + s.equity[1]).toBeCloseTo(1, 3);
    expect(s.equity[0]).toBeCloseTo(rangeEquity(board, input.ranges[0], input.ranges[1])[0], 4);
    expect(s.ev[0] + s.ev[1]).toBeCloseTo(input.pot, 1);
    expect(res.exploitability).toBeLessThan(1);
  });

  it("rebuilds the summary from the file alone", () => {
    const again = summarizeFile(res.file);
    expect(again.summaryNodes).toEqual(res.summaryNodes);
    expect(again.summary.freq).toEqual(res.summary.freq);
    expect(Math.abs(again.summary.ev[0] - res.summary.ev[0])).toBeLessThanOrEqual(0.02);
    expect(again.summary.ev[0] + again.summary.ev[1]).toBeCloseTo(input.pot, 6);
    expect(Math.abs(again.summary.equity[0] - res.summary.equity[0])).toBeLessThanOrEqual(0.003);
  });

  it("drops deeper nodes when they don't fit the size target", () => {
    const small = extractFlop(input, sol, { scenario: "test-spot", version: 1 }, { targetBytes: 0, equity: false });
    expect(small.file.nodes.map((n) => pathKey(n.path))).toEqual(["", "0", "1", "0.1", "1.2"]);
    expect(small.stats.leftOut).toBe(1);
    expect(validateFlopFile(small.file)).toEqual([]);
  });

  it("handles a tree where OOP may only check (single-action root)", () => {
    const xInput: SolverInput = { ...input, sizes: { ...input.sizes, flop: [{ bet: [], raise: [1] }, { bet: [0.5], raise: [] }] } };
    const xSol = solver.solve(xInput, { iterations: 200, targetExploitability: 0.3 });
    const x = extractFlop(xInput, xSol, { scenario: "test-spot", version: 1 }, { equity: false });
    expect(validateFlopFile(x.file)).toEqual([]);
    expect(x.file.nodes.map((n) => pathKey(n.path))).toEqual(["", "0", "0.1", "0.1.2"]);
    expect(x.summaryNodes[0]).toMatchObject({ path: [], player: 0, labels: ["체크"] });
    expect(x.summary.freq[0]).toEqual([1]);
    const root = decodeFlopFile(x.file).node([])!;
    expect(root.strategy[0].every((p) => p === 1)).toBe(true);
  });

  it("refuses a board that isn't the canonical representative", () => {
    expect(() => extractFlop({ ...input, board: parseCards("AhKd7c") }, sol, { scenario: "x", version: 1 })).toThrow(/canonical/);
  });
});
