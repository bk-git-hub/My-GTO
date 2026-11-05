import { describe, expect, it } from "vitest";
import { ALL_HANDS, parseCards, type Card } from "../poker/cards";
import { COMBOS } from "../play/handInfo";
import {
  COMBO_BITMAP_BYTES,
  EV_NAN,
  NUM_COMBOS,
  Q_MAX,
  RAW_FLOPS,
  aggregateByHandClass,
  boardKey,
  canonicalBoard,
  comboIndex,
  comboRows,
  comboString,
  decodeBase64,
  decodeCombos,
  decodeFlopFile,
  decodeInt16,
  decodeRange,
  decodeUint8,
  dequantize,
  dequantizeEv,
  encodeBase64,
  encodeCombos,
  encodeFlopNode,
  encodeInt16,
  encodeRange,
  encodeUint8,
  flopClasses,
  invertSuitMap,
  mapComboSuits,
  nodeActionTotals,
  packFilePath,
  parseBoardKey,
  quantizeEv,
  quantizeStrategy,
  rangesAfter,
  summarizeFlop,
  summaryNodeDefs,
  turnStart,
  validateFlopFile,
  validateManifest,
  type DecodedNode,
  type FlopFile,
  type FlopNodeSource,
  type Manifest,
  type PackAction,
} from "./format";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sum = (xs: ArrayLike<number>) => Array.from(xs).reduce((s, x) => s + x, 0);

describe("base64", () => {
  it("matches btoa without padding and round-trips every length", () => {
    const r = rng(1);
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      const s = encodeBase64(bytes);
      expect(s).toBe(btoa(String.fromCharCode(...bytes)).replace(/=+$/, ""));
      expect(Array.from(decodeBase64(s))).toEqual(Array.from(bytes));
      expect(Array.from(decodeBase64(btoa(String.fromCharCode(...bytes))))).toEqual(Array.from(bytes));
    }
  });

  it("rejects bad input", () => {
    expect(() => decodeBase64("A")).toThrow();
    expect(() => decodeBase64("AB$D")).toThrow();
  });
});

describe("binary arrays", () => {
  it("Uint8 round-trips and clamps", () => {
    const v = [0, 1, 127.4, 254.6, 255, 300, -3, NaN];
    expect(Array.from(decodeUint8(encodeUint8(v)))).toEqual([0, 1, 127, 255, 255, 255, 0, 0]);
  });

  it("Int16 is little endian and round-trips, NaN as EV_NAN", () => {
    expect(Array.from(decodeBase64(encodeInt16([1, -2])))).toEqual([1, 0, 0xfe, 0xff]);
    const v = [0, 1, -1, 12345, -12345, 32767, -32768, 40000, -40000, NaN];
    expect(Array.from(decodeInt16(encodeInt16(v)))).toEqual([0, 1, -1, 12345, -12345, 32767, -32768, 32767, -32768, EV_NAN]);
  });

  it("EV quantization keeps NaN apart from the clamp", () => {
    expect(quantizeEv(NaN)).toBe(EV_NAN);
    expect(quantizeEv(-1000)).toBe(-32767);
    expect(quantizeEv(12.345)).toBe(1235);
    expect(dequantizeEv(quantizeEv(-7.31))).toBeCloseTo(-7.31, 10);
    expect(dequantizeEv(EV_NAN)).toBeNaN();
  });

  it("combo sets round-trip as a 222-character bitmap", () => {
    const r = rng(2);
    for (let t = 0; t < 20; t++) {
      const set = new Set<number>();
      const n = Math.floor(r() * NUM_COMBOS);
      for (let k = 0; k < n; k++) set.add(Math.floor(r() * NUM_COMBOS));
      const s = encodeCombos([...set]);
      expect(s.length).toBe(222);
      expect(Array.from(decodeCombos(s))).toEqual([...set].sort((a, b) => a - b));
    }
    expect(decodeCombos(encodeCombos([])).length).toBe(0);
    const all = Array.from({ length: NUM_COMBOS }, (_, i) => i);
    expect(Array.from(decodeCombos(encodeCombos(all)))).toEqual(all);
    expect(decodeBase64(encodeCombos([0])).length).toBe(COMBO_BITMAP_BYTES);
    expect(() => encodeCombos([NUM_COMBOS])).toThrow();
    expect(() => decodeCombos(encodeBase64(new Uint8Array(10)))).toThrow();
  });
});

describe("strategy quantization", () => {
  it("every combo sums to 255 and each value is within one step", () => {
    const r = rng(3);
    for (const A of [2, 3, 4, 5]) {
      const n = 600;
      const raw = Array.from({ length: A }, () => new Float64Array(n));
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let a = 0; a < A; a++) s += raw[a][i] = r() < 0.3 ? 0 : r();
        for (let a = 0; a < A; a++) raw[a][i] = s > 0 ? raw[a][i] / s : 1 / A;
      }
      const q = quantizeStrategy(raw);
      const d = dequantize(q);
      for (let i = 0; i < n; i++) {
        let qs = 0;
        let ds = 0;
        for (let a = 0; a < A; a++) {
          qs += q[a][i];
          ds += d[a][i];
          expect(Math.abs(q[a][i] - raw[a][i] * Q_MAX)).toBeLessThan(1);
          expect(Math.abs(d[a][i] - raw[a][i])).toBeLessThan(1 / Q_MAX);
        }
        expect(qs).toBe(Q_MAX);
        expect(ds).toBe(1);
      }
    }
  });

  it("handles pure, unnormalized, empty and uniform combos", () => {
    const q = quantizeStrategy([
      [1, 2, 0, NaN, 1 / 3],
      [0, 2, 0, NaN, 1 / 3],
      [0, 0, 0, NaN, 1 / 3],
    ]);
    expect(q.map((a) => Array.from(a))).toEqual([
      [255, 128, 85, 85, 85],
      [0, 127, 85, 85, 85],
      [0, 0, 85, 85, 85],
    ]);
    const d = dequantize(q);
    for (let i = 0; i < 5; i++) expect(d[0][i] + d[1][i] + d[2][i]).toBe(1);
    expect(d[0][0]).toBe(1);
    expect(dequantize([[0], [0]]).map((a) => a[0])).toEqual([0.5, 0.5]);
  });
});

describe("boards", () => {
  it("boardKey sorts high to low, equal ranks in suit order s h d c", () => {
    expect(boardKey(parseCards("7cAhKd"))).toBe("AhKd7c");
    expect(boardKey(parseCards("7dKhKs"))).toBe("KsKh7d");
    expect(boardKey(parseCards("2c2d2h"))).toBe("2h2d2c");
    expect(boardKey(parseCards("7cAhKd5s"))).toBe("AhKd7c5s");
    expect(() => boardKey(parseCards("AhAh7c"))).toThrow();
  });

  it("parseBoardKey inverts boardKey and only accepts canonical keys", () => {
    expect(parseBoardKey("AhKd7c")).toEqual(parseCards("AhKd7c"));
    expect(boardKey(parseBoardKey("KsKh7d"))).toBe("KsKh7d");
    expect(() => parseBoardKey("KdAh7c")).toThrow();
    expect(() => parseBoardKey("AhKd")).toThrow();
    expect(() => parseBoardKey("AhAh7c")).toThrow();
    expect(() => parseBoardKey("ahkd7c")).toThrow();
  });

  it("canonicalBoard picks one representative per suit class", () => {
    expect(canonicalBoard(parseCards("AhKd7c")).key).toBe("AsKh7d");
    expect(canonicalBoard(parseCards("7dAdKd")).key).toBe("AsKs7s");
    expect(canonicalBoard(parseCards("AcKd7c")).key).toBe("AsKh7s");
    expect(canonicalBoard(parseCards("KdKc7c")).key).toBe("KsKh7s");
    expect(canonicalBoard(parseCards("KdKc7h")).key).toBe("KsKh7d");
    for (const raw of ["Td9d2c", "QhJs8h", "5c5h5d", "AhKd7c4s"]) {
      const c = canonicalBoard(parseCards(raw));
      const mapped = parseCards(raw).map((x) => (x & ~3) | c.suitMap[x & 3]);
      expect(boardKey(mapped)).toBe(c.key);
    }
  });

  it("there are 1755 flop classes covering all 22100 flops", () => {
    const classes = flopClasses();
    expect(classes.length).toBe(1755);
    expect(classes.reduce((s, c) => s + c.weight, 0)).toBe(RAW_FLOPS);
    const w = (k: string) => classes.find((c) => c.key === k)?.weight;
    expect(w("AsKh7d")).toBe(24);
    expect(w("AsKs7s")).toBe(4);
    expect(w("AsKs7h")).toBe(12);
    expect(w("KsKh7s")).toBe(12);
    expect(w("KsKh7d")).toBe(12);
    expect(w("2s2h2d")).toBe(4);
    expect(classes[0].key).toBe("AsAhAd");
    for (const c of classes.slice(0, 50)) expect(canonicalBoard(c.cards).key).toBe(c.key);
  });

  it("packFilePath builds versioned paths", () => {
    expect(packFilePath("srp-btn-bb-100", 1, parseCards("7cAhKd"))).toBe("srp-btn-bb-100/v1/flop-AhKd7c.json");
    expect(packFilePath("pub-srp-btn-bb-40", 3, "AsKh7d")).toBe("pub-srp-btn-bb-40/v3/flop-AsKh7d.json");
    expect(() => packFilePath("SRP btn", 1, "AsKh7d")).toThrow();
    expect(() => packFilePath("srp-btn-bb-100", 0, "AsKh7d")).toThrow();
    expect(() => packFilePath("srp-btn-bb-100", 1, "KhAs7d")).toThrow();
  });
});

describe("combos", () => {
  it("comboIndex, comboString and suit maps agree with COMBOS", () => {
    COMBOS.forEach(({ cards: [a, b] }, i) => {
      expect(comboIndex(a, b)).toBe(i);
      expect(comboIndex(b, a)).toBe(i);
    });
    expect(comboString(comboIndex(...(parseCards("KdAh") as [Card, Card])))).toBe("AhKd");
    expect(() => comboIndex(3, 3)).toThrow();
    const map = [2, 0, 3, 1];
    const inv = invertSuitMap(map);
    for (let i = 0; i < NUM_COMBOS; i += 7) {
      const j = mapComboSuits(i, map);
      expect(COMBOS[j].hand).toBe(COMBOS[i].hand);
      expect(mapComboSuits(j, inv)).toBe(i);
    }
  });
});

describe("ranges", () => {
  it("round-trips within half a step and drops board-blocked combos", () => {
    const r = rng(4);
    const board = parseCards("AsKh7d");
    const w = new Float32Array(NUM_COMBOS);
    for (let i = 0; i < NUM_COMBOS; i++) w[i] = r() < 0.4 ? 0 : r() < 0.5 ? 1 : r();
    w[0] = 0.0001;
    const d = decodeRange(encodeRange(w, board));
    for (let i = 0; i < NUM_COMBOS; i++) {
      const [a, b] = COMBOS[i].cards;
      if (board.includes(a) || board.includes(b) || !(w[i] > 0)) expect(d[i]).toBe(0);
      else if (w[i] < 0.5 / Q_MAX) expect(d[i]).toBeCloseTo(1 / Q_MAX, 6); // a tiny weight stays in range
      else expect(Math.abs(d[i] - w[i])).toBeLessThanOrEqual(0.5 / Q_MAX + 1e-6);
    }
  });
});

// ───────── a synthetic flop file shaped like a real one ─────────

const POT = 5.5;
const STACK = 97.5;
const BOARD = parseCards("AsKh7d");
const B33 = 1.815;

const A = (kind: PackAction["kind"], to: number, label: string, next: PackAction["next"]): PackAction => ({ kind, to, label, next });

/** COMBOS-indexed per-action random strategies and EVs for one node. */
function randomNode(r: () => number, actions: PackAction[]) {
  const strategy = actions.map(() => new Float32Array(NUM_COMBOS));
  const ev = actions.map((a) => (a.kind === "fold" ? null : new Float32Array(NUM_COMBOS)));
  for (let i = 0; i < NUM_COMBOS; i++) {
    let s = 0;
    for (let a = 0; a < actions.length; a++) s += strategy[a][i] = r() < 0.25 ? 0 : r();
    for (let a = 0; a < actions.length; a++) strategy[a][i] = s > 0 ? strategy[a][i] / s : 1 / actions.length;
    for (const e of ev) if (e) e[i] = -20 + 60 * r();
  }
  return { strategy, ev };
}

function syntheticFile(seed: number, oopShare = 0.35, ipShare = 0.45) {
  const r = rng(seed);
  const dead = new Set(BOARD);
  const start: [Float32Array, Float32Array] = [new Float32Array(NUM_COMBOS), new Float32Array(NUM_COMBOS)];
  for (let i = 0; i < NUM_COMBOS; i++) {
    const [a, b] = COMBOS[i].cards;
    if (dead.has(a) || dead.has(b)) continue;
    if (r() < oopShare) start[0][i] = r() < 0.7 ? 1 : 0.5;
    if (r() < ipShare) start[1][i] = r() < 0.7 ? 1 : 0.35;
  }
  // Quantize the starting weights first, as the file will, so reach ratios line up.
  const startQ: [Float32Array, Float32Array] = [decodeRange(encodeRange(start[0], BOARD)), decodeRange(encodeRange(start[1], BOARD))];

  const rootActs = [A("check", 0, "체크", "action"), A("bet", B33, "벳 33%", "action"), A("allin", STACK, "올인", "action")];
  const root = randomNode(r, rootActs);
  const ipCheckActs = [A("check", 0, "체크", "street"), A("bet", B33, "벳 33%", "action"), A("allin", STACK, "올인", "action")];
  const ipCheck = randomNode(r, ipCheckActs);
  const ipBetActs = [A("fold", 0, "폴드", "fold"), A("call", B33, "콜", "street"), A("raise", 7.5, "레이즈 7.5", "action"), A("allin", STACK, "올인", "action")];
  const ipBet = randomNode(r, ipBetActs);
  const oopVsBetActs = [A("fold", 0, "폴드", "fold"), A("call", B33, "콜", "street"), A("allin", STACK, "올인", "action")];
  const oopVsBet = randomNode(r, oopVsBetActs);

  const oopReachAfterCheck = startQ[0].map((w, i) => w * root.strategy[0][i]);
  const sources: FlopNodeSource[] = [
    { path: [], player: 0, pot: POT, bets: [0, 0], stacks: [STACK, STACK], actions: rootActs, start: startQ[0], reach: startQ[0], ...root },
    { path: [0], player: 1, pot: POT, bets: [0, 0], stacks: [STACK, STACK], actions: ipCheckActs, start: startQ[1], reach: startQ[1], ...ipCheck },
    { path: [1], player: 1, pot: POT + B33, bets: [B33, 0], stacks: [STACK - B33, STACK], actions: ipBetActs, start: startQ[1], reach: startQ[1], ...ipBet },
    {
      path: [0, 1], player: 0, pot: POT + B33, bets: [0, B33], stacks: [STACK, STACK - B33], actions: oopVsBetActs,
      start: startQ[0], reach: oopReachAfterCheck, ...oopVsBet,
    },
  ];
  const file: FlopFile = {
    v: 1,
    scenario: "srp-btn-bb-100",
    version: 1,
    board: boardKey(BOARD),
    pot: POT,
    stack: STACK,
    iterations: 500,
    exploitability: 0.31,
    ranges: [encodeRange(start[0], BOARD), encodeRange(start[1], BOARD)],
    nodes: sources.map(encodeFlopNode),
  };
  return { file, sources, startQ };
}

describe("flop file", () => {
  const { file, sources, startQ } = syntheticFile(5);

  it("is valid and survives a JSON round trip", () => {
    expect(validateFlopFile(file)).toEqual([]);
    const again = JSON.parse(JSON.stringify(file)) as FlopFile;
    expect(validateFlopFile(again)).toEqual([]);
    expect(again).toEqual(file);
  });

  it("stores reach only where it isn't 1 and drops zero-reach combos", () => {
    expect(file.nodes[0].reach).toBeUndefined();
    expect(file.nodes[1].reach).toBeUndefined();
    expect(file.nodes[3].reach).toBeDefined();
    const inRoot = decodeCombos(file.nodes[0].combos).length;
    const inOopVsBet = decodeCombos(file.nodes[3].combos).length;
    expect(inOopVsBet).toBeLessThan(inRoot);
    expect(file.nodes[2].ev[0]).toBeNull();
  });

  it("decodes strategies, EVs and reach close to the solver's values", () => {
    const flop = decodeFlopFile(file);
    expect(flop.boardKey).toBe("AsKh7d");
    sources.forEach((src, k) => {
      const node = flop.node(src.path)!;
      expect(node).toBe(flop.nodes[k]);
      for (let j = 0; j < node.combos.length; j++) {
        const c = node.combos[j];
        let s = 0;
        for (let a = 0; a < node.actions.length; a++) {
          s += node.strategy[a][j];
          expect(Math.abs(node.strategy[a][j] - src.strategy[a][c])).toBeLessThan(1 / Q_MAX);
          const e = src.ev[a];
          if (e) expect(Math.abs(node.ev[a][j] - e[c])).toBeLessThanOrEqual(0.005 + 1e-6);
          else expect(node.ev[a][j]).toBeCloseTo(-(STACK - src.stacks[src.player]), 6);
        }
        expect(s).toBe(1);
        const rel = src.reach[c] / src.start[c];
        expect(Math.abs(node.reach[j] - rel)).toBeLessThanOrEqual(0.5 / Q_MAX + 1e-6);
        expect(node.weight[j]).toBeCloseTo(startQ[src.player][c] * node.reach[j], 6);
      }
    });
    expect(flop.node([2])).toBeUndefined();
  });

  it("validation catches broken files", () => {
    const bad = structuredClone(file);
    bad.nodes[0].strategy[0] = encodeUint8(decodeUint8(bad.nodes[0].strategy[0]).map((x) => (x > 0 ? x - 1 : x + 1)));
    bad.nodes.splice(1, 1);
    bad.nodes[2].ev[0] = bad.nodes[2].ev[1];
    bad.board = "KhAs7d";
    const errs = validateFlopFile(bad);
    expect(errs.some((e) => e.includes("sums to"))).toBe(true);
    expect(errs.some((e) => e.includes("parent not stored"))).toBe(true);
    expect(errs.some((e) => e.includes("fold EV must be null"))).toBe(true);
    expect(errs.some((e) => e.includes("canonical order"))).toBe(true);
  });

  it("derives turn-start ranges and pot for lines that end the flop", () => {
    const flop = decodeFlopFile(file);
    // check, check
    const xx = turnStart(flop, [0, 0]);
    expect(xx).toMatchObject({ pot: POT, stack: STACK, next: "street" });
    // bet 33%, call
    const bc = turnStart(flop, [1, 1]);
    expect(bc.pot).toBeCloseTo(POT + 2 * B33, 9);
    expect(bc.stack).toBeCloseTo(STACK - B33, 9);
    // check, bet, call
    const xbc = turnStart(flop, [0, 1, 1]);
    expect(xbc.pot).toBeCloseTo(POT + 2 * B33, 9);
    for (let c = 0; c < NUM_COMBOS; c++) {
      const s0 = sources[0].strategy, s1 = sources[1].strategy, s3 = sources[3].strategy;
      expect(Math.abs(xx.ranges[0][c] - startQ[0][c] * s0[0][c])).toBeLessThan(1.5 / Q_MAX);
      expect(Math.abs(xx.ranges[1][c] - startQ[1][c] * s1[0][c])).toBeLessThan(1.5 / Q_MAX);
      expect(Math.abs(xbc.ranges[0][c] - startQ[0][c] * s0[0][c] * s3[1][c])).toBeLessThan(3 / Q_MAX);
      expect(Math.abs(xbc.ranges[1][c] - startQ[1][c] * s1[1][c])).toBeLessThan(1.5 / Q_MAX);
    }
    expect(rangesAfter(flop, [])).toEqual(flop.ranges);
    expect(() => turnStart(flop, [0])).toThrow(); // OOP's check doesn't end the street
    expect(() => turnStart(flop, [1, 2])).toThrow(); // the raise isn't a street end
    expect(() => rangesAfter(flop, [2, 1])).toThrow(); // node [2] isn't stored
    expect(() => rangesAfter(flop, [0, 0, 1])).toThrow(); // continues past the end of the flop
  });

  it("summaries and the manifest validate", () => {
    const flop = decodeFlopFile(file);
    const defs = summaryNodeDefs(flop);
    expect(defs.map((d) => d.path)).toEqual([[], [0], [1], [0, 1]]);
    const summary = summarizeFlop(flop, defs, { equity: [0.4412, 0.5588], ev: [2.1, 3.4] });
    expect(summary.freq.length).toBe(4);
    for (const row of summary.freq) expect(Math.abs(sum(row!) - 1)).toBeLessThan(0.003);
    expect(summary.freq[0]).toEqual(nodeActionTotals(flop.nodes[0]).map((x) => Math.round(x * 1000) / 1000));
    const json = JSON.stringify(file);
    const manifest: Manifest = {
      v: 1,
      generatedAt: "2026-11-05T03:00:00Z",
      packs: [
        {
          id: "srp-btn-bb-100",
          title: "BTN vs BB 싱글 레이즈드 팟 (100bb)",
          version: 1,
          tier: "free",
          scenario: {
            format: "cash",
            positions: ["BB", "BTN"],
            pot: POT,
            stack: STACK,
            sizes: {
              flop: [{ bet: [0.33], raise: [0.75] }, { bet: [0.33], raise: [0.75] }],
              turn: [{ bet: [0.75], raise: [0.75] }, { bet: [0.75], raise: [0.75] }],
              river: [{ bet: [0.75], raise: [0.75] }, { bet: [0.75], raise: [0.75] }],
            },
            raiseLimit: 2,
            addAllIn: true,
            allInThreshold: 0.67,
            minBet: 1,
            iterations: 1000,
            targetExploitability: 0.5,
            ranges: ["22+, A2s+", "22+, A2s+, K2s+"],
            rangeSources: ["cash6/100bb/bb-vs-btn:call", "cash6/100bb/rfi-btn:raise"],
          },
          summaryNodes: defs,
          files: [
            {
              path: packFilePath("srp-btn-bb-100", 1, file.board),
              sha256: "0".repeat(64),
              bytes: json.length,
              board: file.board,
              weight: 24,
              exploitability: file.exploitability,
              summary,
            },
          ],
        },
      ],
    };
    expect(validateManifest(manifest)).toEqual([]);
    const bad = structuredClone(manifest);
    bad.packs[0].files[0].path = "srp-btn-bb-100/v2/flop-AsKh7d.json";
    bad.packs[0].files[0].sha256 = "xyz";
    bad.packs[0].files[0].summary.freq.pop();
    expect(validateManifest(bad).length).toBe(3);
  });

  it("a depth-2 file with realistic ranges stays within the size budget", () => {
    // ~40% of combos for OOP, ~50% for IP: wider than a real BB call / BTN open after board removal.
    const big = syntheticFile(6, 0.4, 0.5).file;
    expect(JSON.stringify(big).length).toBeLessThan(60_000);
  });
});

describe("viewer aggregation", () => {
  // AKs: 4 combos, AA: 2 combos (others not in range). Two actions: check / bet.
  const idx = (s: string) => comboIndex(...(parseCards(s) as [Card, Card]));
  const combos = [idx("AsAh"), idx("AdAc"), idx("AsKs"), idx("AhKh"), idx("AdKd"), idx("AcKc")].sort((a, b) => a - b);
  const byCombo = new Map<number, { p: number; ev: [number, number]; w: number }>([
    [idx("AsAh"), { p: 0.2, ev: [10, 12], w: 1 }],
    [idx("AdAc"), { p: 0.6, ev: [11, 13], w: 0.5 }],
    [idx("AsKs"), { p: 1, ev: [5, NaN], w: 1 }],
    [idx("AhKh"), { p: 0, ev: [4, 6], w: 1 }],
    [idx("AdKd"), { p: 0.5, ev: [3, 5], w: 0.5 }],
    [idx("AcKc"), { p: 0.5, ev: [3, 7], w: 0.25 }],
  ]);
  const get = (c: number) => byCombo.get(c)!;
  const node: DecodedNode = {
    path: [],
    player: 0,
    pot: POT,
    bets: [0, 0],
    stacks: [STACK, STACK],
    actions: [A("check", 0, "체크", "action"), A("bet", B33, "벳 33%", "action")],
    combos: Uint16Array.from(combos),
    strategy: [Float64Array.from(combos, (c) => get(c).p), Float64Array.from(combos, (c) => 1 - get(c).p)],
    ev: [Float32Array.from(combos, (c) => get(c).ev[0]), Float32Array.from(combos, (c) => get(c).ev[1])],
    reach: new Float32Array(combos.length).fill(1),
    weight: Float32Array.from(combos, (c) => get(c).w),
  };

  it("weights hand classes by reach × starting weight", () => {
    const agg = aggregateByHandClass(node);
    expect(Object.keys(agg).length).toBe(169);
    expect(new Set(Object.keys(agg))).toEqual(new Set(ALL_HANDS));
    const aa = agg["AA"];
    expect(aa.combos).toBe(2);
    expect(aa.weight).toBeCloseTo(1.5, 6);
    expect(aa.freq[0]).toBeCloseTo((0.2 * 1 + 0.6 * 0.5) / 1.5, 6);
    expect(aa.freq[1]).toBeCloseTo(1 - aa.freq[0], 6);
    expect(aa.ev[0]).toBeCloseTo((10 + 11 * 0.5) / 1.5, 5);
    expect(aa.evNode).toBeCloseTo((0.2 * 10 + 0.8 * 12 + 0.5 * (0.6 * 11 + 0.4 * 13)) / 1.5, 5);
    const ak = agg["AKs"];
    expect(ak.combos).toBe(4);
    expect(ak.weight).toBeCloseTo(2.75, 6);
    expect(ak.freq[0]).toBeCloseTo((1 + 0 + 0.25 + 0.125) / 2.75, 6);
    // AsKs has no bet EV, so the bet EV averages the other three; its node EV is still 5 (pure check).
    expect(ak.ev[1]).toBeCloseTo((6 + 5 * 0.5 + 7 * 0.25) / 1.75, 5);
    expect(ak.evNode).toBeCloseTo((5 + 6 + 0.5 * 4 + 0.25 * 5) / 2.75, 5);
    expect(agg["72o"]).toMatchObject({ combos: 0, weight: 0, freq: [0, 0] });
    expect(agg["72o"].evNode).toBeNaN();
  });

  it("start weights override the stored weights", () => {
    const start = new Float32Array(NUM_COMBOS).fill(1);
    const agg = aggregateByHandClass(node, start);
    expect(agg["AA"].freq[0]).toBeCloseTo(0.4, 6);
    expect(nodeActionTotals(node, start)[0]).toBeCloseTo((0.2 + 0.6 + 1 + 0 + 0.5 + 0.5) / 6, 6);
  });

  it("overall totals and combo rows", () => {
    const tot = nodeActionTotals(node);
    expect(tot[0]).toBeCloseTo((0.2 + 0.3 + 1 + 0 + 0.25 + 0.125) / 4.25, 6);
    expect(tot[0] + tot[1]).toBeCloseTo(1, 9);
    const rows = comboRows(node, undefined, "AKs");
    expect(rows.map((r) => r.cards)).toEqual(["AsKs", "AhKh", "AdKd", "AcKc"]);
    expect(rows[0]).toMatchObject({ hand: "AKs", reach: 1, weight: 1, freq: [1, 0], evNode: 5 });
    expect(rows[0].ev[1]).toBeNaN();
    expect(comboRows(node).length).toBe(6);
  });
});
