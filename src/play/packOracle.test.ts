import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { act } from "./engine";
import { comboOf, flopPath, gradeAtNode, packSpot, type OracleSpot } from "./packOracle";
import type { PlayState } from "./table";
import { readFlop, srpAtFlop, testOracle } from "./testPacks";

/** A real pack file read through the oracle: the board and combo mapping, the line mapping and the grade. */

const o = testOracle();
const combo = (cs: string) => comboOf(parseCards(cs));

function btnVsBb(mode: "pub" | "cash" = "pub", stage = "mid"): PlayState {
  const s = srpAtFlop(mode, stage, "BTN", { holes: { BTN: "AcQc", BB: "Ts9s" }, board: "Kd7c2h", hero: "BTN" });
  return { ...s, post: { match: o.match(s) } };
}
const bb = (s: PlayState) => s.game.players.findIndex((p) => p.seat === "BB");
const btn = (s: PlayState) => s.game.players.findIndex((p) => p.seat === "BTN");
const spotOf = (s: PlayState, idx: number) => o.spot(s, idx) as OracleSpot;

describe("pack oracle", () => {
  it("maps a real board and combo onto the canonical file: Kd7c2h with AcQc is Ks7h2d's AhQh", () => {
    const s = btnVsBb();
    expect(s.post!.match!.file.path).toBe("pub-srp-btn-bb-55/v2/flop-Ks7h2d.json");
    const root = spotOf(s, bb(s));
    expect(root.oopRoot).toBe(true);
    expect(root.actions.map((a) => a.label)).toEqual(["체크"]);
    const x = { ...s, game: act(s.game, "check") };
    const sp = spotOf(x, btn(x));
    expect(sp.path).toEqual([0]);
    expect(sp.actions.map((a) => a.label)).toEqual(["체크", "벳 33% (2)", "벳 75% (4.4)"]);
    const row = sp.row(combo("AcQc"))!;
    expect(row.freq[0]).toBeCloseTo(0.51, 1);
    expect(row.freq[1]).toBeCloseTo(0.49, 1);
    expect(row.freq.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // The same row as the canonical combo in the file itself.
    const node = readFlop(s.post!.match!.file.path).node([0])!;
    const j = node.combos.indexOf(combo("AhQh"));
    expect(row.freq).toEqual(node.strategy.map((st) => st[j]));
    // A hand the pack's BTN range never holds has no row.
    expect(sp.row(combo("3d4c"))).toBeNull();
    expect(sp.inRange(combo("3d4c"))).toBe(false);
  });

  it("plays real sizes as the pack's times the pot scale", () => {
    const s = btnVsBb();
    const m = s.post!.match!;
    expect(m.potScale).toBeCloseTo(5.9 / 6.5, 9);
    const x = { ...s, game: act(s.game, "check") };
    const sp = spotOf(x, btn(x));
    const node = readFlop(m.file.path).node([0])!;
    sp.actions.forEach((a, i) => {
      if (a.kind === "raise") expect(a.to).toBeCloseTo(node.actions[i].to * m.potScale, 2);
    });
    // The check-raise keeps the solver's rule: call, then 60% of the pot after the call.
    const b = { ...x, game: act(x.game, "raise", sp.actions[1].to) };
    const f = spotOf(b, bb(b));
    expect(f.path).toEqual([0, 1]);
    const bet = sp.actions[1].to;
    expect(f.actions[2].to).toBeCloseTo(bet + 0.6 * (5.9 + 2 * bet), 1);
  });

  it("follows the line through the tree, and says when it leaves it", () => {
    const s = btnVsBb();
    const m = s.post!.match!;
    const flop = readFlop(m.file.path);
    const after = (...acts: [string, number?][]) => {
      let g = s.game;
      for (const [k, to] of acts) g = act(g, k as "check" | "call" | "raise" | "fold", to);
      return flopPath(g, m, flop);
    };
    const sp = spotOf({ ...s, game: act(s.game, "check") }, btn(s));
    const b33 = sp.actions[1].to, b75 = sp.actions[2].to;
    expect(after(["check"], ["check"])).toEqual({ path: [0, 0] });
    expect(after(["check"], ["raise", b33], ["call"])).toEqual({ path: [0, 1, 1] });
    const r = spotOf({ ...s, game: act(act(s.game, "check"), "raise", b75) }, bb(s)).actions[2].to;
    expect(after(["check"], ["raise", b75], ["raise", r], ["call"])).toEqual({ path: [0, 2, 2, 1] });
    // The BB leads: the tree has no lead.
    expect(after(["raise", 3])).toEqual({ off: "donk" });
    // A 50% bet is neither 33% nor 75%.
    expect(after(["check"], ["raise", 5.9 * 0.5])).toEqual({ off: "size" });
    // The BTN re-raises the check-raise.
    expect(after(["check"], ["raise", b75], ["raise", r], ["raise", r * 2.5])).toEqual({ off: "reraise" });
    // A jam the tree doesn't have.
    expect(after(["check"], ["raise", 52.8])).toEqual({ off: "allin" });
  });

  it("says 'stack' when a tree action is all-in only in the real game", () => {
    const s = btnVsBb();
    const m = s.post!.match!;
    const flop = readFlop(m.file.path);
    const x = { ...s, game: act(s.game, "check") };
    const b75 = spotOf(x, btn(x)).actions[2].to;
    const y = { ...x, game: act(x.game, "raise", b75) };
    const r = spotOf(y, bb(y)).actions[2].to;
    const z = act(y.game, "raise", r);
    expect(flopPath(z, m, flop)).toEqual({ path: [0, 2, 2] });
    // The BTN's call of the check-raise, had it been for its whole (shorter) stack.
    const last = z.log[z.log.length - 1];
    const shortCall = { ...z, log: [...z.log, { ...last, idx: btn(s), seat: "BTN", kind: "call" as const, allIn: true }] };
    expect(flopPath(shortCall, m, flop)).toEqual({ off: "stack" });
    // A jam over the check-raise is a re-raise the tree doesn't have.
    expect(flopPath({ ...z, log: [...z.log, { ...last, idx: btn(s), seat: "BTN", kind: "raise" as const, amount: 52.8, allIn: true }] }, m, flop)).toEqual({ off: "reraise" });
  });

  it("grades by EV: the top action is good, a 0% action that loses more than the band is a mistake", () => {
    const s = btnVsBb();
    const x = { ...s, game: act(s.game, "check") };
    const sp = spotOf(x, btn(x));
    const c = combo("AcQc");
    const g = [0, 1, 2].map((a) => gradeAtNode(sp, c, a)!);
    expect(g[1].grade).toBe("good");
    expect(g[g[0].best].grade).toBe("good");
    // Approximate pack: a 0% bet 75% losing 8.6% of the pot is only △ (the band is 10%); exact it would be ✗.
    expect(g[2].freq).toBe(0);
    expect(g[2].lossPct).toBeGreaterThan(0.05);
    expect(g[2].grade).toBe("ok");
    const exact: OracleSpot = { ...sp, level: "exact" };
    expect(gradeAtNode(exact, c, 2)!.grade).toBe("mistake");
    expect(gradeAtNode(sp, combo("3d4c"), 0)).toBeNull();
  });

  it("is exact in cash: the cash pack's own refs, seats and stacks", () => {
    const s = btnVsBb("cash", "100bb");
    expect(s.post!.match!.level).toBe("exact");
    expect(s.post!.match!.reasons).toEqual([]);
    const sp = packSpot({ ...s, game: act(s.game, "check") }, btn(s), s.post!.match!, readFlop(s.post!.match!.file.path));
    expect(sp && "source" in sp && sp.level).toBe("exact");
  });
});
