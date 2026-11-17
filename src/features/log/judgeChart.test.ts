import { describe, expect, it } from "vitest";
import { lazySetsBuilt } from "../../data/charts";
import { NASH_STAGES } from "../../data/sets/nashData";
import { PREFLOP_STAGES } from "../../data/sets/preflopData";
import { SHORT_NASH_STAGES } from "../../data/sets/shortNashData";
import { ALL_HANDS } from "../../poker/cards";
import { parseRange } from "../../poker/range";
import { ajaeTier } from "./ajae";
import { bbPlayShare, JUDGE_SOURCE, judgeSeat, limpShare, raiseShare, TRASH_DEFENSE, trashDefenseShare, warmJudgeCharts } from "./judgeChart";
import { PRE_STAGES } from "./quickPre";
import { positionsFor } from "./recorder";

const spot = (stage: string, id: string) => PREFLOP_STAGES.find((s) => s.id === stage)!.scenarios.find((s) => s.id === id)!;
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe("judgeChart: the charts 빠른 기록's 아재 judges by", () => {
  it("takes 딥 and 미들 from the solver (100bb with the 3bb open, 55bb), 숏 from the 17bb open/jam chart, 푸시 from the 10bb push/fold", () => {
    expect(JUDGE_SOURCE).toEqual({
      deep: { kind: "solver", id: "100bb-3" },
      mid: { kind: "solver", id: "55bb-2.2" },
      short: { kind: "shortnash", stack: 17 },
      push: { kind: "nash", stack: 10 },
    });
    expect(TRASH_DEFENSE).toEqual({ stage: "55bb-2.2", scenario: "bb-vs-hj-open" });
  });

  it("reads the solver's first-in charts as they are: raises apart from the SB's limps", () => {
    for (const [stage, id] of [["deep", "100bb-3"], ["mid", "55bb-2.2"]] as const) {
      const btn = parseRange(spot(id, "rfi-btn").actions[0].range);
      for (const h of ALL_HANDS) close(raiseShare(stage, 9, "BTN", h), btn[h] ?? 0);
      const sb = spot(id, "rfi-sb");
      const limp = parseRange(sb.actions.find((a) => a.key === "limp")!.range);
      const raise = parseRange(sb.actions.find((a) => a.key === "raise")!.range);
      for (const h of ALL_HANDS) {
        close(limpShare(stage, 9, "SB", h), limp[h] ?? 0);
        close(raiseShare(stage, 9, "SB", h), raise[h] ?? 0);
        expect(limpShare(stage, 9, "BTN", h)).toBe(0);
      }
      // the BB facing the button: calls and 3-bets
      const bb = spot(id, "bb-vs-btn-open");
      const parts = bb.actions.map((a) => parseRange(a.range));
      for (const h of ALL_HANDS) close(bbPlayShare(stage, 9, "BTN", h), parts.reduce((a, r) => a + (r[h] ?? 0), 0));
    }
    // the trash test's defense: the 55bb BB against the HJ
    const hj = spot("55bb-2.2", "bb-vs-hj-open").actions.map((a) => parseRange(a.range));
    for (const h of ALL_HANDS) close(trashDefenseShare(TRASH_DEFENSE, h), hj.reduce((a, r) => a + (r[h] ?? 0), 0));
  });

  it("reads 숏 as the 17bb open + jam and the BB's flat + re-jam, 푸시 as the 10bb shove and the BB's call", () => {
    const sn = SHORT_NASH_STAGES.find((s) => s.stack === 17)!;
    const nash = NASH_STAGES.find((s) => s.stack === 10)!;
    for (const seat of ["UTG", "CO", "BTN", "SB"]) {
      const open = parseRange(sn.open[seat]);
      const jam = parseRange(sn.jam[seat]);
      const push = parseRange(nash.push[seat]);
      for (const h of ALL_HANDS) {
        close(raiseShare("short", 9, seat, h), Math.min(1, (open[h] ?? 0) + (jam[h] ?? 0)));
        close(raiseShare("push", 9, seat, h), push[h] ?? 0);
      }
    }
    const flat = parseRange(sn.bbCall.BTN);
    const reJam = parseRange(sn.reJam.BB.BTN);
    const call = parseRange(nash.call.BB.BTN);
    for (const h of ALL_HANDS) {
      close(bbPlayShare("short", 9, "BTN", h), Math.min(1, (flat[h] ?? 0) + (reJam[h] ?? 0)));
      close(bbPlayShare("push", 9, "BTN", h), call[h] ?? 0);
      for (const stage of ["short", "push"] as const) expect(limpShare(stage, 9, "SB", h)).toBe(0);
    }
  });

  it("reads a seat of any table size as the 9-handed seat with as many players behind it", () => {
    for (const s of positionsFor(9)) expect(judgeSeat(9, s)).toBe(s);
    expect(positionsFor(6).map((s) => judgeSeat(6, s))).toEqual(["LJ", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(positionsFor(7).map((s) => judgeSeat(7, s))).toEqual(["UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(positionsFor(8).map((s) => judgeSeat(8, s))).toEqual(["UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(positionsFor(10).map((s) => judgeSeat(10, s))).toEqual(["UTG", "UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(positionsFor(3).map((s) => judgeSeat(3, s))).toEqual(["BTN", "SB", "BB"]);
    // heads-up the SB is the button: it opens as the 9-handed SB, and the BB defends against the SB
    expect(positionsFor(2).map((s) => judgeSeat(2, s))).toEqual(["SB", "BB"]);
    expect(raiseShare("mid", 6, "UTG", "K9o")).toBe(raiseShare("mid", 9, "LJ", "K9o"));
    expect(bbPlayShare("mid", 2, "SB", "K9o")).toBeGreaterThan(0);
  });

  it("never builds the whole solver set: a few spots parsed once, warmed ahead of the first hand", () => {
    warmJudgeCharts();
    for (const stage of PRE_STAGES) for (const seat of positionsFor(9)) for (const h of ["AA", "K9o", "J4o", "72o"]) ajaeTier(h, seat, stage, 9);
    expect(lazySetsBuilt()).not.toContain("solver");
  });
});
