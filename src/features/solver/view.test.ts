import { beforeAll, describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { decodeFlopFile, type DecodedFlop, type FileEntry, type PackEntry, type SummaryNodeDef } from "../../presolve/format";
import { SYNTHETIC_SPECS, buildSyntheticPacks } from "../../../tests/fixtures/solverPack";
import {
  KIND_COLOR,
  SIZE_COLORS,
  actionColors,
  actionFraction,
  averageNodeFreq,
  bestAction,
  betShare,
  boardTexture,
  compareBoards,
  contrastRatio,
  describeLine,
  evTolerance,
  filterRows,
  fmtBb,
  fmtEv,
  matchesTexture,
  mixGradient,
  nextHint,
  nextSort,
  parseRoute,
  pct,
  rangeByClass,
  reportColumns,
  reportRows,
  resolvePath,
  routeOf,
  shareOf,
  sizeBucket,
  sortRows,
  textureOfKey,
  textureTags,
  toggleChip,
  unblockedCounts,
  weightedAverage,
} from "./view";

describe("formatting", () => {
  it("formats percentages, chips and EVs", () => {
    expect(pct(0.613)).toBe("61%");
    expect(pct(0.6134, 1)).toBe("61.3%");
    expect(pct(NaN)).toBe("–");
    expect(fmtBb(5.5)).toBe("5.5");
    expect(fmtBb(97.5)).toBe("97.5");
    expect(fmtBb(1.815)).toBe("1.8");
    expect(fmtBb(1.815, 2)).toBe("1.82");
    expect(fmtBb(-0.01)).toBe("0");
    expect(fmtEv(2.345)).toBe("2.35");
    expect(fmtEv(-0.001)).toBe("0.00");
    expect(fmtEv(NaN)).toBe("–");
  });
});

describe("board textures", () => {
  const t = (s: string) => boardTexture(parseCards(s));

  it("classifies suits, pairs, high card and connectedness", () => {
    expect(t("AsKh7d")).toEqual({ suits: "rainbow", paired: false, trips: false, high: "A", connected: false });
    expect(t("Th9h7c")).toMatchObject({ suits: "twotone", high: "T", connected: true, paired: false });
    expect(t("Js8s3s")).toMatchObject({ suits: "monotone", high: "J", connected: false });
    expect(t("7s7h2d")).toMatchObject({ paired: true, trips: false, high: "low", connected: false });
    expect(t("5s5h5d")).toMatchObject({ paired: true, trips: true });
    expect(t("As2h3d").connected).toBe(true); // the wheel
    expect(t("AsKhQd").connected).toBe(true);
    expect(t("Ts9h4d").connected).toBe(false);
    expect(t("9s6h5d")).toMatchObject({ high: "low", connected: true });
  });

  it("reads board keys and makes Korean tags", () => {
    expect(textureOfKey("AsKh7d").suits).toBe("rainbow");
    expect(() => textureOfKey("KhAs7d")).toThrow();
    expect(textureTags(t("Th9h7c"))).toEqual(["투톤", "커넥티드", "T 하이"]);
    expect(textureTags(t("7s7h2d"))).toEqual(["레인보우", "페어드", "9 이하"]);
  });

  it("filter chips OR within a group and AND across groups", () => {
    const ak7 = t("AsKh7d"), t97 = t("Th9h7c"), j83 = t("Js8s3s"), p72 = t("7s7h2d");
    expect(matchesTexture(ak7, [])).toBe(true);
    expect(matchesTexture(ak7, ["rainbow"])).toBe(true);
    expect(matchesTexture(t97, ["rainbow"])).toBe(false);
    expect(matchesTexture(t97, ["rainbow", "twotone"])).toBe(true);
    expect(matchesTexture(p72, ["rainbow", "paired"])).toBe(true);
    expect(matchesTexture(ak7, ["rainbow", "paired"])).toBe(false);
    expect(matchesTexture(j83, ["monotone", "high-J", "high-Q"])).toBe(true);
    expect(matchesTexture(j83, ["monotone", "high-A"])).toBe(false);
    expect(matchesTexture(t97, ["connected", "high-T"])).toBe(true);
    expect(matchesTexture(ak7, ["no-such-chip"])).toBe(true);
    expect(toggleChip(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleChip(["a", "b"], "a")).toEqual(["b"]);
  });

  it("orders boards high first", () => {
    const keys = ["7s7h2d", "AsKh7d", "AsKs7d", "Th9h7c", "AsQh7d"];
    const sorted = keys.map(parseCards).sort(compareBoards).map((c) => c.map((x) => "23456789TJQKA"[x >> 2] + "shdc"[x & 3]).join(""));
    expect(sorted).toEqual(["AsKh7d", "AsKs7d", "AsQh7d", "Th9h7c", "7s7h2d"]);
  });
});

describe("action colors", () => {
  const root = [
    { kind: "check" as const, label: "체크", to: 0 },
    { kind: "bet" as const, label: "벳 33%", to: 1.815 },
    { kind: "bet" as const, label: "벳 75%", to: 4.125 },
    { kind: "allin" as const, label: "올인", to: 97.5 },
  ];
  const rootNode = { pot: 5.5, bets: [0, 0] as [number, number], player: 0 as const };

  it("gives passive kinds fixed colors and bets warmer colors by size", () => {
    expect(actionColors(root, rootNode)).toEqual([KIND_COLOR.check, SIZE_COLORS[0], SIZE_COLORS[2], KIND_COLOR.allin]);
    // Without the node the size comes from the label.
    expect(actionColors(root)).toEqual(actionColors(root, rootNode));
    expect(sizeBucket(0.33)).toBe(0);
    expect(sizeBucket(0.5)).toBe(1);
    expect(sizeBucket(1)).toBe(2);
    expect(sizeBucket(1.5)).toBe(3);
  });

  it("measures raises against the pot after calling", () => {
    const node = { pot: 7.315, bets: [1.815, 0] as [number, number], player: 1 as const };
    const raise = { kind: "raise" as const, label: "레이즈 8.7", to: 8.6625 };
    expect(actionFraction(raise, node)).toBeCloseTo(0.75, 6);
    expect(actionFraction(raise)).toBeNull();
    const facing = [{ kind: "fold" as const, label: "폴드", to: 0 }, { kind: "call" as const, label: "콜", to: 1.815 }, raise];
    expect(actionColors(facing, node)).toEqual([KIND_COLOR.fold, KIND_COLOR.call, SIZE_COLORS[2]]);
  });

  it("never repeats a size color within a node", () => {
    const close = [
      { kind: "check" as const, label: "체크" },
      { kind: "bet" as const, label: "벳 33%" },
      { kind: "bet" as const, label: "벳 40%" },
      { kind: "bet" as const, label: "벳 1.5" },
    ];
    const c = actionColors(close);
    expect(new Set(c).size).toBe(4);
    expect(c.slice(1)).toEqual([SIZE_COLORS[0], SIZE_COLORS[1], SIZE_COLORS[2]]);
  });

  it("measures contrast", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#38bdf8", "#ffffff")).toBeCloseTo(2.14, 2);
  });

  it("builds cell gradients", () => {
    expect(mixGradient([0, 0], ["#111111", "#222222"])).toBeNull();
    expect(mixGradient([0, 1], ["#111111", "#222222"])).toBe("#222222");
    expect(mixGradient([0.25, 0.75], ["#111111", "#222222"])).toBe("linear-gradient(to right, #111111 0% 25%, #222222 25% 100%)");
  });

  it("finds the best action by EV, treating near-equal EVs as ties broken by frequency", () => {
    const tol = 0.05;
    expect(bestAction([1, 3, NaN, 2], [0.1, 0.8, 0, 0.1], tol)).toBe(1);
    expect(bestAction([NaN, NaN], [0.5, 0.5], tol)).toBe(-1);
    // An exact tie goes to the action the solver plays more, not to the first one.
    expect(bestAction([7.34, 7.34], [0.05, 0.6], tol)).toBe(1);
    expect(bestAction([2.63, 2.63, 1.2], [0.14, 0.86, 0], tol)).toBe(1);
    // Within the tolerance: 9.75 vs 9.72 is a tie, the raise (89%) wins over the higher-EV call (11%).
    expect(bestAction([-1, 9.75, 9.72], [0, 0.11, 0.89], tol)).toBe(2);
    // A clear EV winner keeps the mark even when it is played less.
    expect(bestAction([9.9, 9.72], [0.1, 0.9], tol)).toBe(0);
    // Same frequency and EV: the earlier action.
    expect(bestAction([2, 2], [0.5, 0.5], tol)).toBe(0);
    expect(bestAction([2, 2.01], [0.5, 0.5], tol)).toBe(1);
    expect(evTolerance(5.5)).toBe(0.05);
    expect(evTolerance(30)).toBeCloseTo(0.15, 9);
  });
});

// ───────── report helpers on a hand-made pack ─────────

const defs: SummaryNodeDef[] = [
  { path: [], player: 0, labels: ["체크", "벳 33%", "벳 75%"], kinds: ["check", "bet", "bet"] },
  { path: [0], player: 1, labels: ["체크", "벳 33%", "벳 75%"], kinds: ["check", "bet", "bet"] },
  { path: [1], player: 1, labels: ["폴드", "콜", "레이즈 8.7"], kinds: ["fold", "call", "raise"] },
];

function file(board: string, weight: number, oop: number[] | null, ip: number[] | null, eq: number): FileEntry {
  return {
    path: `srp-btn-bb-100/v1/flop-${board}.json`,
    sha256: "0".repeat(64),
    bytes: 100,
    board,
    weight,
    exploitability: 0.3,
    summary: { equity: [eq, 1 - eq], ev: [eq * 5, 5.5 - eq * 5], freq: [oop, ip, [0.3, 0.6, 0.1]] },
  };
}

const pack: PackEntry = {
  id: "srp-btn-bb-100",
  title: "test",
  version: 1,
  tier: "free",
  scenario: SYNTHETIC_SPECS[0].meta,
  summaryNodes: defs,
  files: [
    file("AsKh7d", 24, [0.7, 0.2, 0.1], [0.4, 0.5, 0.1], 0.42),
    file("Th9h7c", 12, [0.5, 0.3, 0.2], [0.6, 0.3, 0.1], 0.5),
    file("7s7h2d", 12, [0.8, 0.2, 0], null, 0.46),
  ],
};

// The real srp-btn-bb-100 tree: OOP only checks at the root, then answers IP's 33% or 75% c-bet.
const checkOnlyDefs: SummaryNodeDef[] = [
  { path: [], player: 0, labels: ["체크"], kinds: ["check"] },
  { path: [0], player: 1, labels: ["체크", "벳 33%", "벳 75%"], kinds: ["check", "bet", "bet"] },
  { path: [0, 1], player: 0, labels: ["폴드", "콜", "레이즈 7.3"], kinds: ["fold", "call", "raise"] },
  { path: [0, 2], player: 0, labels: ["폴드", "콜", "레이즈 12.4"], kinds: ["fold", "call", "raise"] },
];

const checkOnlyPack: PackEntry = {
  ...pack,
  summaryNodes: checkOnlyDefs,
  files: [
    { ...file("AsKh7d", 24, [1], [0.4, 0.4, 0.2], 0.42), summary: { equity: [0.42, 0.58], ev: [2, 3.5], freq: [[1], [0.4, 0.4, 0.2], [0.3, 0.6, 0.1], [0.5, 0.45, 0.05]] } },
    { ...file("Th9h7c", 12, [1], [0.6, 0.3, 0.1], 0.5), summary: { equity: [0.5, 0.5], ev: [2.7, 2.8], freq: [[1], [0.6, 0.3, 0.1], [0.2, 0.6, 0.2], [0.4, 0.5, 0.1]] } },
  ],
};

describe("report", () => {
  it("finds the OOP root and IP-after-check columns", () => {
    const cols = reportColumns(pack);
    expect(cols.oop).toEqual([{ node: 0, player: 0, metric: "bet", context: "첫 액션" }]);
    expect(cols.ip).toEqual({ node: 1, player: 1, metric: "bet", context: "체크 받고" });
    const noCheck: PackEntry = { ...pack, summaryNodes: [{ ...defs[0], kinds: ["bet", "bet", "bet"] }] };
    expect(reportColumns(noCheck).oop.map((c) => c.node)).toEqual([0]);
    expect(reportColumns(noCheck).ip).toBeNull();
  });

  it("drops a root without bets and offers OOP's answer to each c-bet instead", () => {
    const cols = reportColumns(checkOnlyPack);
    expect(cols.oop).toEqual([
      { node: 2, player: 0, metric: "fold", context: "vs 벳 33%", vs: "벳 33%" },
      { node: 3, player: 0, metric: "fold", context: "vs 벳 75%", vs: "벳 75%" },
    ]);
    expect(cols.ip?.node).toBe(1);
    const vs33 = reportRows(checkOnlyPack);
    expect(vs33[0].oopStat).toBeCloseTo(0.3, 9);
    expect(vs33[0].ipStat).toBeCloseTo(0.6, 9);
    const vs75 = reportRows(checkOnlyPack, 1);
    expect(vs75.map((r) => r.oopStat)).toEqual([0.5, 0.4]);
    expect(reportRows(checkOnlyPack, 9)[0].oopStat).toBeCloseTo(0.3, 9);
    expect(sortRows(vs75, { key: "oop", desc: true }).map((r) => r.entry.board)).toEqual(["AsKh7d", "Th9h7c"]);
    expect(weightedAverage(vs75).oopStat).toBeCloseTo((24 * 0.5 + 12 * 0.4) / 36, 9);
    expect(averageNodeFreq(vs75, 3)![0]).toBeCloseTo((24 * 0.5 + 12 * 0.4) / 36, 9);
    expect(averageNodeFreq(vs75, 0)).toEqual([1]);
  });

  it("builds rows with bet shares", () => {
    const rows = reportRows(pack);
    expect(rows.map((r) => r.entry.board)).toEqual(["AsKh7d", "Th9h7c", "7s7h2d"]);
    expect(rows[0].oopStat).toBeCloseTo(0.3, 9);
    expect(rows[0].ipStat).toBeCloseTo(0.6, 9);
    expect(rows[2].ipStat).toBeNaN();
    expect(betShare([0.1, 0.2, 0.7], ["fold", "call", "raise"])).toBeCloseTo(0.7, 9);
    expect(betShare(null, [])).toBeNaN();
    expect(shareOf([0.1, 0.2, 0.7], ["fold", "call", "raise"], "fold")).toBeCloseTo(0.1, 9);
  });

  it("sorts by any column with missing values last", () => {
    const rows = reportRows(pack);
    const by = (key: Parameters<typeof sortRows>[1]["key"], desc: boolean) => sortRows(rows, { key, desc }).map((r) => r.entry.board);
    expect(by("board", true)).toEqual(["AsKh7d", "Th9h7c", "7s7h2d"]);
    expect(by("board", false)).toEqual(["7s7h2d", "Th9h7c", "AsKh7d"]);
    expect(by("oop", true)).toEqual(["Th9h7c", "AsKh7d", "7s7h2d"]);
    expect(by("oop", false)).toEqual(["7s7h2d", "AsKh7d", "Th9h7c"]);
    expect(by("ip", true)).toEqual(["AsKh7d", "Th9h7c", "7s7h2d"]);
    expect(by("ip", false)).toEqual(["Th9h7c", "AsKh7d", "7s7h2d"]);
    expect(by("weight", true)[0]).toBe("AsKh7d");
    expect(by("equity", true)).toEqual(["Th9h7c", "7s7h2d", "AsKh7d"]);
    expect(nextSort({ key: "board", desc: true }, "board")).toEqual({ key: "board", desc: false });
    expect(nextSort({ key: "board", desc: false }, "ip")).toEqual({ key: "ip", desc: true });
  });

  it("filters by texture and averages with file weights", () => {
    const rows = reportRows(pack);
    expect(filterRows(rows, ["paired"]).map((r) => r.entry.board)).toEqual(["7s7h2d"]);
    expect(filterRows(rows, ["monotone"])).toEqual([]);
    const avg = weightedAverage(rows);
    expect(avg.count).toBe(3);
    expect(avg.weight).toBe(48);
    // (24 × 0.7 + 12 × 0.5 + 12 × 0.8) / 48
    expect(avg.oop![0]).toBeCloseTo((24 * 0.7 + 12 * 0.5 + 12 * 0.8) / 48, 9);
    // IP: the paired board has no row, so only 36 weight counts.
    expect(avg.ip![1]).toBeCloseTo((24 * 0.5 + 12 * 0.3) / 36, 9);
    expect(avg.ipStat).toBeCloseTo((24 * 0.6 + 12 * 0.4) / 36, 9);
    expect(avg.equity).toBeCloseTo((24 * 0.42 + 12 * 0.5 + 12 * 0.46) / 48, 9);
    const none = weightedAverage([]);
    expect(none.oop).toBeNull();
    expect(none.equity).toBeNaN();
  });
});

describe("routes", () => {
  it("round-trips", () => {
    expect(parseRoute("")).toEqual({ packId: undefined, board: undefined, path: [], badPath: false });
    expect(parseRoute("srp-btn-bb-100")).toMatchObject({ packId: "srp-btn-bb-100", board: undefined });
    expect(parseRoute("srp-btn-bb-100/AsKh7d/0.1")).toEqual({ packId: "srp-btn-bb-100", board: "AsKh7d", path: [0, 1], badPath: false });
    expect(parseRoute("srp-btn-bb-100/AsKh7d/x")).toMatchObject({ path: [], badPath: true });
    expect(routeOf()).toBe("solver");
    expect(routeOf("p")).toBe("solver/p");
    expect(routeOf("p", "AsKh7d")).toBe("solver/p/AsKh7d");
    expect(routeOf("p", "AsKh7d", [0, 1])).toBe("solver/p/AsKh7d/0.1");
    const r = parseRoute(routeOf("p", "AsKh7d", [2, 0, 1]).slice("solver/".length));
    expect(r.path).toEqual([2, 0, 1]);
  });
});

describe("ranges by hand class", () => {
  it("counts unblocked combos and weights", () => {
    const board = parseCards("AsKh7d");
    const counts = unblockedCounts(board);
    expect(counts.AA).toBe(3);
    expect(counts.AKs).toBe(2);
    expect(counts.AKo).toBe(7);
    expect(counts.QQ).toBe(6);
    const full = rangeByClass(new Float32Array(1326).fill(1), board);
    expect(full.AA).toEqual({ combos: 3, weight: 3, frac: 1 });
    const half = rangeByClass(new Float32Array(1326).fill(0.5), board);
    expect(half.QJs.frac).toBeCloseTo(0.5, 6);
  });
});

describe("lines on a synthetic flop", () => {
  let flop: DecodedFlop;
  beforeAll(async () => {
    const { manifest, flops } = await buildSyntheticPacks([SYNTHETIC_SPECS[0]]);
    flop = decodeFlopFile(flops.get(manifest.packs[0].files[0].path)!);
  });
  const meta = SYNTHETIC_SPECS[0].meta;

  it("describes and resolves paths", () => {
    expect(describeLine(flop, [], meta)).toBe("플랍 시작");
    expect(describeLine(flop, [0, 1], meta)).toBe("BB 체크 → BTN 벳 33%");
    expect(resolvePath(flop, [0]).kind).toBe("node");
    const end = resolvePath(flop, [0, 0]);
    expect(end.kind).toBe("end");
    if (end.kind === "end") expect(end.action.next).toBe("street");
    const fold = resolvePath(flop, [1, 0]);
    expect(fold.kind === "end" && fold.action.next).toBe("fold");
    expect(resolvePath(flop, [9]).kind).toBe("invalid");
    expect(resolvePath(flop, [0, 0, 0]).kind).toBe("invalid");
  });

  it("labels where each action leads", () => {
    const root = flop.node([])!;
    expect(nextHint(root.actions[0], true, meta, 0)).toBe("→ BTN 결정");
    expect(nextHint(root.actions[0], false, meta, 0)).toBe("저장 안 됨");
    const ip = flop.node([0])!;
    expect(nextHint(ip.actions[0], false, meta, 1)).toBe("→ 턴");
  });
});
