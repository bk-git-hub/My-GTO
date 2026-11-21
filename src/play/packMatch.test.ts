import { describe, expect, it } from "vitest";
import { distOk, MATCH_LIMITS, matchPack, packIndex, packListText, rangeDist, refVerb, seatLines, type PackInfo } from "./packMatch";
import { PRESETS } from "./profile";
import type { PlayState } from "./table";
import { readManifest, srpAtFlop, testPacks } from "./testPacks";

/** The registry against the three packs public/packs holds, by manifest data only. */

const packs = testPacks();
const match = (s: PlayState, list: readonly PackInfo[] = packs) => matchPack(s, list);

describe("pack registry", () => {
  it("reads every app pack's signature, refs and ranges from the manifest", () => {
    expect(packs.map((p) => p.id).sort()).toEqual(["pub-srp-btn-bb-55", "pub-srp-utg-bb-55", "srp-btn-bb-100"]);
    const cash = packs.find((p) => p.id === "srp-btn-bb-100")!;
    expect(cash.sides.map((x) => [x.seat, x.verbs, x.refs])).toEqual([
      ["BB", ["call"], ["cash6/100bb/bb-vs-btn:call"]],
      ["BTN", ["open"], ["cash6/100bb/rfi-btn:raise"]],
    ]);
    expect(cash.files.size).toBe(1755);
    expect(refVerb("solver/100bb-2.2/btn-open-vs-bb-3bet:call")).toBe("call");
    expect(refVerb("solver/55bb-2.2/bb-vs-sb-limp:raise")).toBe("iso");
    expect(packListText(packs)).toMatch(/^지금 있는 솔버 팩 3개: /);
    // A slim calibration pack (root classes only) is never playable.
    const m = readManifest();
    const slim = { ...m, packs: [{ ...m.packs[0], id: "cal-x", scenario: { ...m.packs[0].scenario, storage: "rootClasses" as const } }] };
    expect(packIndex(slim)).toEqual([]);
    // A malformed entry (one side's range source missing, a bad range) is left out; the others still load.
    const bad = { ...m.packs[0], id: "bad-1", scenario: { ...m.packs[0].scenario, rangeSources: [m.packs[0].scenario.rangeSources![0]] as unknown as [string, string] } };
    const bad2 = { ...m.packs[0], id: "bad-2", scenario: { ...m.packs[0].scenario, ranges: ["", ""] as [string, string] } };
    expect(packIndex({ ...m, packs: [bad, ...m.packs, bad2] }).map((p) => p.id).sort()).toEqual(["pub-srp-btn-bb-55", "pub-srp-utg-bb-55", "srp-btn-bb-100"]);
  });

  it("matches the cash BTN vs BB pot exactly", () => {
    const m = match(srpAtFlop("cash", "100bb", "BTN", { board: "Kd7c2h" }))!;
    expect([m.packId, m.level, m.reasons]).toEqual(["srp-btn-bb-100", "exact", []]);
    expect(m.spr[0]).toBeCloseTo(m.spr[1], 6);
    expect(m.file.path).toBe("srp-btn-bb-100/v1/flop-Ks7h2d.json");
  });

  // [mode, stage, opener, pack or null, reasons, l1 / outside of [OOP, IP] (±2)]
  const PUB = "팩은 펍 차트 레인지로 계산";
  const CASH = "팩은 캐시 차트 레인지로 계산";
  const verdicts: [("pub" | "cash"), string, string, string | null, string[], [number, number, number, number]?][] = [
    ["cash", "100bb", "CO", "srp-btn-bb-100", ["CO 오픈 30% → BTN 팩 49%"]],
    ["cash", "100bb", "HJ", null, []],
    ["cash", "100bb", "UTG", null, []],
    ["pub", "mid", "BTN", "pub-srp-btn-bb-55", [PUB, "SPR 8.8 → 7.9"], [28.3, 27.5, 13.9, 26.7]],
    ["pub", "mid", "CO", "pub-srp-btn-bb-55", [PUB, "CO 오픈 37% → BTN 팩 38%", "SPR 8.8 → 7.9"], [15.6, 13.5, 6.9, 7.3]],
    ["pub", "mid", "HJ", "pub-srp-btn-bb-55", [PUB, "HJ 오픈 29% → BTN 팩 38%", "SPR 8.8 → 7.9"]],
    ["pub", "mid", "LJ", "pub-srp-btn-bb-55", [PUB, "LJ 오픈 23% → BTN 팩 38%", "SPR 8.8 → 7.9"]],
    // UTG+1 and UTG+2 open 18-20%: the 38% BTN pack is over 1.8 times as wide, and the 12% UTG pack lacks a third of
    // their hands, so no pack stands in (참고, not a grade on another range's solution).
    ["pub", "mid", "UTG+2", null, []],
    ["pub", "mid", "UTG+1", null, []],
    ["pub", "mid", "UTG", "pub-srp-utg-bb-55", [PUB, "SPR 8.8 → 7.9"], [16.8, 2.0, 4.8, 27.7]],
    ["pub", "deep", "BTN", "srp-btn-bb-100", [CASH, "앤티 없는 캐시 팩", "SPR 12.8 → 17.7"], [19.1, 6.3, 7.4, 4.0]],
    ["pub", "deep", "CO", "srp-btn-bb-100", [CASH, "CO 오픈 34% → BTN 팩 49%", "앤티 없는 캐시 팩", "SPR 12.8 → 17.7"]],
    ["pub", "deep", "UTG", null, []],
    ["pub", "35bb", "BTN", null, []],
    // A 35bb UTG open (15%) goes to the UTG pack, never to the BTN pack its range merely lies inside.
    ["pub", "35bb", "UTG", "pub-srp-utg-bb-55", [PUB, "SPR 5.8 → 7.9"], [13.1, 8.7, 4.6, 26.1]],
    ["pub", "35bb", "UTG+1", null, []],
    ["pub", "35bb", "UTG+2", null, []],
    ["pub", "35bb", "LJ", "pub-srp-btn-bb-55", [PUB, "LJ 오픈 22% → BTN 팩 38%", "SPR 5.8 → 7.9"]],
    ["pub", "35bb", "CO", "pub-srp-btn-bb-55", [PUB, "CO 오픈 34% → BTN 팩 38%", "SPR 5.8 → 7.9"]],
    ["pub", "short", "BTN", null, []],
    ["pub", "short", "CO", null, []],
    ["pub", "push", "BTN", null, []],
  ];
  it.each(verdicts)("%s %s: %s opens, the BB calls → %s", (mode, stage, opener, pack, reasons, dist) => {
    const m = match(srpAtFlop(mode, stage, opener, { board: "Qs8h5h" }));
    if (!pack) return void expect(m).toBeNull();
    expect(m).not.toBeNull();
    expect([m!.packId, m!.level, m!.reasons]).toEqual([pack, "approx", reasons]);
    if (dist) {
      expect(m!.dist[0].l1).toBeCloseTo(dist[0], -0.6);
      expect(m!.dist[0].outside * 100).toBeCloseTo(dist[1], -0.6);
      expect(m!.dist[1].l1).toBeCloseTo(dist[2], -0.6);
      expect(m!.dist[1].outside * 100).toBeCloseTo(dist[3], -0.6);
    }
  });

  it("keeps a narrow range off a much wider pack, in both directions", () => {
    // UTG 35bb inside the BTN pack: nothing outside, L1 within the limit, but the BTN range is 2.6 times as wide.
    const s = srpAtFlop("pub", "35bb", "UTG", { board: "Qs8h5h" });
    const lines = seatLines(s)!;
    const btn = packs.find((p) => p.id === "pub-srp-btn-bb-55")!;
    const d = rangeDist(lines[1].freq!, btn.sides[1].classFreq);
    expect(d.outside).toBe(0);
    expect(d.l1).toBeLessThan(MATCH_LIMITS.l1);
    expect(d.extra).toBeGreaterThan(0.5);
    expect(d.width).toBeLessThan(MATCH_LIMITS.widthMin);
    expect(distOk(d)).toBe(false);
    // The same distance read the other way round (our range the wide one) fails on width too.
    expect(distOk(rangeDist(btn.sides[1].classFreq, lines[1].freq!))).toBe(false);
    // The pack of the same two seats ranks ahead of another seat's pack when both pass, even a closer one: a BTN pack
    // solved on exactly our ranges would score better, but the UTG pack wins.
    const near: PackInfo = { ...btn, id: "x-near", sides: [{ ...btn.sides[0], classFreq: lines[0].freq! }, { ...btn.sides[1], classFreq: lines[1].freq! }] };
    const utg = packs.find((p) => p.id === "pub-srp-utg-bb-55")!;
    expect(match(s, [near, utg])!.packId).toBe("pub-srp-utg-bb-55");
    expect(match(s, [near])!.packId).toBe("x-near");
  });

  it("has no pack for multiway, 3-bet or limped pots", () => {
    expect(match(srpAtFlop("pub", "mid", "BTN", { calls: ["SB"] }))).toBeNull();
    expect(match(srpAtFlop("pub", "mid", "CO", { calls: ["BTN"] }))).toBeNull();
    expect(match(srpAtFlop("pub", "mid", "BTN", { threeBet: true }))).toBeNull();
    expect(match(srpAtFlop("cash", "100bb", "BTN", { threeBet: true }))).toBeNull();
    expect(match(srpAtFlop("pub", "mid", "SB", { limp: true }))).toBeNull();
  });

  it("names the opponent's profile when it isn't GTO", () => {
    const s = srpAtFlop("cash", "100bb", "BTN", { board: "Kd7c2h", hero: "BTN" });
    const bb = s.game.players.findIndex((p) => p.seat === "BB");
    const m = match({ ...s, profiles: s.profiles!.map((p, i) => (i === bb ? PRESETS.pub.p : p)) })!;
    expect(m.level).toBe("exact");
    expect(m.reasons).toEqual(["상대 성향 미반영"]);
  });

  it("lets a later exact pack win on its boards and the approximate one stand in elsewhere", () => {
    // A subset pack solved on the solver chart's own 55bb ranges, stacks and refs, with one board only.
    const s = srpAtFlop("pub", "mid", "BTN", { board: "Qs8h5h" });
    const lines = seatLines(s)!;
    const base = packs.find((p) => p.id === "pub-srp-btn-bb-55")!;
    const pot = 5.9, stack = 51.8;
    const fake: PackInfo = {
      ...base,
      id: "pub-srp-btn-bb-55-solver",
      title: "BTN vs BB (솔버 차트 55bb)",
      meta: { ...base.meta, pot, stack },
      files: new Map([["Qs8h5h", { ...base.files.get("Qs8h5h")!, path: "x/v1/flop-Qs8h5h.json" }]]),
      sides: [
        { ...base.sides[0], refs: [lines[0].refs[0]!], classFreq: lines[0].freq! },
        { ...base.sides[1], refs: [lines[1].refs[0]!], classFreq: lines[1].freq! },
      ],
    };
    const list = [...packs, fake];
    const here = match(s, list)!;
    expect([here.packId, here.level, here.reasons]).toEqual(["pub-srp-btn-bb-55-solver", "exact", []]);
    const elsewhere = match(srpAtFlop("pub", "mid", "BTN", { board: "Kd7c2h" }), list)!;
    expect([elsewhere.packId, elsewhere.level]).toEqual(["pub-srp-btn-bb-55", "approx"]);
  });
});
