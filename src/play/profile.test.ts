import { describe, expect, it } from "vitest";
import { ALL_HANDS, comboCount } from "../poker/cards";
import { fullWeights } from "./analysis";
import { act, newGame, PUB_TABLE, type Game } from "./engine";
import { STAGE_STACK, type MoveOption, type PreflopDecision } from "./policy";
import { badgeOf, isGto, presetOf, PRESETS, profileOf, type SeatProfile } from "./profile";
import { adjustPostflop, adjustPreflop, classMass, LOOSE_MULT, stageOrder } from "./profileAdjust";
import { botPreflop, type PlayState } from "./table";

/** A 9-handed tournament state after the given actions (seat names in order; "f" fold, "c" call, a number a raise to). */
function spotAfter(stage: string, steps: [string, "f" | "c" | number][]): PlayState {
  let g: Game = newGame(STAGE_STACK[stage], 0, undefined, PUB_TABLE);
  for (const [seat, a] of steps) {
    while (g.players[g.toAct!].seat !== seat) g = act(g, "fold");
    g = a === "f" ? act(g, "fold") : a === "c" ? act(g, "call") : act(g, "raise", a);
  }
  return { mode: "pub", stageId: stage, heroIdx: 0, game: g, ranges: g.players.map(() => fullWeights()), decisions: [], botNotes: {} };
}
/** The seat to act next, after folds up to `seat`. */
function at(s: PlayState, seat: string): PlayState {
  let g = s.game;
  while (g.players[g.toAct!].seat !== seat) g = act(g, "fold");
  return { ...s, game: g };
}
const withProfile = (s: PlayState, p: SeatProfile): PlayState => ({ ...s, profiles: s.game.players.map(() => p) });

const groups = (ms: MoveOption[]) => {
  const out = { fold: 0, call: 0, raise: 0 };
  for (const m of ms) out[m.kind === "fold" ? "fold" : m.kind === "raise" ? "raise" : "call"] += m.prob;
  return out;
};
/** Combo-weighted share of a group over all classes (the full range). */
function share(dec: PreflopDecision, g: "fold" | "call" | "raise"): number {
  let a = 0;
  for (const h of ALL_HANDS) a += comboCount(h) * groups(dec.moves(h))[g];
  return a / 1326;
}

const SPOTS: [string, PlayState][] = [
  ["55bb rfi-utg", at(spotAfter("mid", []), "UTG")],
  ["55bb bb-vs-btn-open", at(spotAfter("mid", [["BTN", 2.2]]), "BB")],
  ["55bb squeeze (BB vs CO open, BTN call)", at(spotAfter("mid", [["CO", 2.2], ["BTN", "c"]]), "BB")],
  ["17bb facing a jam", at(spotAfter("short", [["CO", 17]]), "BB")],
  ["fallback (limped pot)", at(spotAfter("mid", [["UTG", "c"]]), "BTN")],
];

describe("profiles", () => {
  it("sanitizes stored values and names presets", () => {
    expect(profileOf({ loose: 9, aggro: -7.6, sticky: "x" })).toEqual({ loose: 2, aggro: -2, sticky: 0 });
    expect(profileOf(null)).toEqual({ loose: 0, aggro: 0, sticky: 0 });
    expect(profileOf({ loose: 0.6, aggro: 1, sticky: 5 })).toEqual({ loose: 1, aggro: 1, sticky: 2 });
    expect(presetOf(PRESETS.pub.p)).toBe("pub");
    expect(presetOf({ loose: 1, aggro: 0, sticky: 0 })).toBeNull();
    expect(badgeOf({ loose: 1, aggro: 0, sticky: 0 })).toBe("직접");
    expect(isGto(null) && isGto(undefined) && isGto(PRESETS.gto.p)).toBe(true);
  });
});

describe("adjustPreflop", () => {
  it("GTO is the chart itself: the same object and the same moves for every class", () => {
    for (const [name, s] of SPOTS) {
      const idx = s.game.toAct!;
      const plain = botPreflop(s, idx);
      const gto = botPreflop(withProfile(s, PRESETS.gto.p), idx);
      expect(gto.dec, name).toBe(gto.base);
      for (const h of ALL_HANDS) expect(gto.dec.moves(h), `${name} ${h}`).toEqual(plain.dec.moves(h));
    }
  });

  it("every class of every profile sums to 1 with no negative move", () => {
    const profiles = [PRESETS.pub.p, PRESETS.tight.p, PRESETS.aggro.p, { loose: -1, aggro: -2, sticky: 1 } as SeatProfile, { loose: 2, aggro: 2, sticky: 2 } as SeatProfile];
    for (const [name, s] of SPOTS)
      for (const p of profiles) {
        const d = botPreflop(withProfile(s, p), s.game.toAct!).dec;
        for (const h of ALL_HANDS) {
          const ms = d.moves(h);
          expect(ms.every((m) => m.prob >= 0), `${name} ${h}`).toBe(true);
          expect(ms.reduce((a, m) => a + m.prob, 0), `${name} ${h}`).toBeCloseTo(1, 9);
        }
      }
  });

  it("loose ±: the continue share moves by the multiplier (capped by the folding share), class by class in one direction", () => {
    const s = at(spotAfter("mid", []), "BTN");
    const idx = s.game.toAct!;
    const base = botPreflop(s, idx).base;
    const M = 1 - share(base, "fold");
    for (const loose of [-2, -1, 1, 2] as const) {
      const d = botPreflop(withProfile(s, { loose, aggro: 0, sticky: 0 }), idx).dec;
      const mult = LOOSE_MULT[loose];
      const target = mult > 1 ? Math.min(1, M * mult, M + (1 - M) * (mult - 1)) : M * mult;
      // Within one class's mass (12 combos of 1326).
      expect(Math.abs(1 - share(d, "fold") - target), `loose ${loose}`).toBeLessThan(12 / 1326 + 1e-9);
      for (const h of ALL_HANDS) {
        const b = 1 - groups(base.moves(h)).fold, a = 1 - groups(d.moves(h)).fold;
        if (loose > 0) expect(a, h).toBeGreaterThanOrEqual(b - 1e-9);
        else expect(a, h).toBeLessThanOrEqual(b + 1e-9);
      }
    }
  });

  it("loosening flips the close-call folds first", () => {
    // 55bb BB vs a UTG open: the chart marks some pure folds as close calls.
    const s = at(spotAfter("mid", [["UTG", 2.2]]), "BB");
    const idx = s.game.toAct!;
    const { base, ans } = botPreflop(s, idx);
    expect(ans?.ok).toBe(true);
    const sc = ans!.ok ? ans!.scenario : null;
    const closeFolds = ALL_HANDS.filter((h) => groups(base.moves(h)).fold > 1 - 1e-9 && (sc?.close?.[h] ?? []).some((k) => k !== "fold"));
    expect(closeFolds.length).toBeGreaterThan(0);
    const d = botPreflop(withProfile(s, { loose: 1, aggro: 0, sticky: 0 }), idx).dec;
    const opened = (h: string) => 1 - groups(d.moves(h)).fold;
    const flippedPure = ALL_HANDS.filter((h) => groups(base.moves(h)).fold > 1 - 1e-9 && !closeFolds.includes(h) && opened(h) > 1e-6);
    // Every close-call fold is fully continuing before any other pure fold starts to.
    if (flippedPure.length) for (const h of closeFolds) expect(opened(h), h).toBeGreaterThan(1 - 1e-6);
    expect(closeFolds.some((h) => opened(h) > 1e-6)).toBe(true);
  });

  it("aggro keeps what continues, uses only the spot's sizes, and makes no limp first in", () => {
    const s = at(spotAfter("mid", [["CO", 2.2]]), "BTN");
    const idx = s.game.toAct!;
    const { base } = botPreflop(s, idx);
    const sizes = new Set(ALL_HANDS.flatMap((h) => base.moves(h).filter((m) => m.kind === "raise").map((m) => m.to)));
    for (const aggro of [-2, 2] as const) {
      const d = botPreflop(withProfile(s, { loose: 0, aggro, sticky: 0 }), idx).dec;
      expect(1 - share(d, "fold")).toBeCloseTo(1 - share(base, "fold"), 9);
      for (const h of ALL_HANDS) for (const m of d.moves(h)) if (m.kind === "raise") expect(sizes.has(m.to)).toBe(true);
      expect(share(d, "raise") > share(base, "raise")).toBe(aggro > 0);
    }
    for (const seat of ["UTG", "HJ", "BTN"]) {
      const r = at(spotAfter("mid", []), seat);
      const d = botPreflop(withProfile(r, PRESETS.aggro.p), r.game.toAct!).dec;
      for (const h of ALL_HANDS) expect(d.moves(h).some((m) => m.kind === "call"), `${seat} ${h}`).toBe(false);
    }
  });

  it("sticky only acts facing a raise, adds only calls, and widens the call of a jam", () => {
    const jam = at(spotAfter("short", [["CO", 17]]), "BB");
    const idx = jam.game.toAct!;
    const base = botPreflop(jam, idx).base;
    const d = botPreflop(withProfile(jam, { loose: 0, aggro: 0, sticky: 2 }), idx).dec;
    expect(share(d, "call")).toBeGreaterThan(share(base, "call") + 0.05);
    expect(share(d, "raise")).toBeCloseTo(share(base, "raise"), 9);
    const rfi = at(spotAfter("mid", []), "CO");
    const r = botPreflop(rfi, rfi.game.toAct!);
    const rs = botPreflop(withProfile(rfi, { loose: 0, aggro: 0, sticky: 2 }), rfi.game.toAct!);
    for (const h of ALL_HANDS) expect(rs.dec.moves(h)).toEqual(r.base.moves(h));
  });

  it("reads the seat's own range: a class it can't hold here weighs nothing", () => {
    const s = at(spotAfter("mid", [["BTN", 2.2]]), "BB");
    const w = classMass(s.ranges[s.game.toAct!]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1326, 6);
    const order = stageOrder({ source: "solver", stageId: "55bb-2.2", stack: 55, open: 2.2, name: "솔버 55bb" });
    const idxOf = (h: string) => ALL_HANDS.indexOf(h);
    expect(order[idxOf("AA")]).toBeGreaterThan(order[idxOf("72o")]);
    expect(order[idxOf("A5s")]).toBeGreaterThan(order[idxOf("J4o")]);
    void adjustPreflop;
  });
});

describe("adjustPostflop", () => {
  const unbet: MoveOption[] = [{ kind: "raise", to: 2, prob: 0.3, ai: 1 }, { kind: "raise", to: 4.5, prob: 0.2, ai: 2 }, { kind: "check", prob: 0.5, ai: 0 }];
  const facing: MoveOption[] = [{ kind: "raise", to: 9, prob: 0.1 }, { kind: "call", prob: 0.4 }, { kind: "fold", prob: 0.5 }];
  const sum = (ms: MoveOption[]) => ms.reduce((a, m) => a + m.prob, 0);

  it("GTO is the identity", () => {
    expect(adjustPostflop(unbet, PRESETS.gto.p, { tier: 3, facingBet: false })).toBe(unbet);
  });

  it("scales bets by aggression, keeps the size split, and sums to 1", () => {
    const a = adjustPostflop(unbet, { loose: 0, aggro: 2, sticky: 0 }, { tier: 3, facingBet: false });
    const b1 = a.find((m) => m.ai === 1)!.prob, b2 = a.find((m) => m.ai === 2)!.prob;
    expect(b1 + b2).toBeCloseTo(0.75, 9);
    expect(b1 / b2).toBeCloseTo(1.5, 9);
    expect(sum(a)).toBeCloseTo(1, 9);
    // Air bluffs scale by BLUFF_MULT, capped at 95%.
    const air = adjustPostflop(unbet, { loose: 0, aggro: 2, sticky: 0 }, { tier: 0, facingBet: false });
    expect(sum(air.filter((m) => m.kind === "raise"))).toBeCloseTo(0.95, 9);
    const passive = adjustPostflop(unbet, PRESETS.pub.p, { tier: 2, facingBet: false });
    expect(sum(passive.filter((m) => m.kind === "raise"))).toBeCloseTo(0.375, 9);
    // A row that already bets 98.9% is never cut to the 95% cap by a more aggressive profile.
    const heavy: MoveOption[] = [{ kind: "raise", to: 2, prob: 0.989, ai: 1 }, { kind: "check", prob: 0.011, ai: 0 }];
    for (const aggro of [1, 2] as const) expect(sum(adjustPostflop(heavy, { loose: 0, aggro, sticky: 0 }, { tier: 3, facingBet: false }).filter((m) => m.kind === "raise"))).toBeGreaterThanOrEqual(0.989 - 1e-9);
  });

  it("facing a bet: raises by aggression, folds into calls by stickiness", () => {
    const pub = adjustPostflop(facing, PRESETS.pub.p, { tier: 2, facingBet: true });
    const by = (k: string) => pub.find((m) => m.kind === k)?.prob ?? 0;
    // raise 0.1 × 0.6 = 0.06 (the rest calls), then fold × (0.55 + 0.1).
    expect(by("raise")).toBeCloseTo(0.06, 9);
    expect(by("fold")).toBeCloseTo(0.5 * 0.35, 9);
    expect(by("call")).toBeCloseTo(1 - 0.06 - 0.175, 9);
    const tight = adjustPostflop(facing, PRESETS.tight.p, { tier: 2, facingBet: true });
    expect(tight.find((m) => m.kind === "call")!.prob).toBeCloseTo(0.4 * 0.7, 9);
    expect(sum(tight)).toBeCloseTo(1, 9);
  });
});
