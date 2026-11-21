import { afterEach, describe, expect, it } from "vitest";
import { heroAct, heroMoves, startHand, type LoadKey, type PlayState, type TableCtx } from "../../play/table";
import { createOracle } from "../../play/packOracle";
import { readFlop, restoreRandom, seedRandom, testPacks } from "../../play/testPacks";
import { advance } from "./advance";

/** The async loop: a hand stops for a pack, waits for it, and goes on; a failed or stale load never blocks it. */

afterEach(() => restoreRandom());

/** An oracle over a source whose manifest and files appear only after `load`. */
function lazySource(fail: "none" | "manifest" | "flop" = "none") {
  let packs: ReturnType<typeof testPacks> | null = null;
  const files = new Set<string>();
  const loads: LoadKey[] = [];
  const oracle = createOracle({ packs: () => packs, flop: (p) => (files.has(p) ? readFlop(p) : null) });
  const load = async (key: LoadKey) => {
    loads.push(key);
    await Promise.resolve();
    if (key.kind === "manifest") {
      if (fail === "manifest") return false;
      packs = testPacks();
      return true;
    }
    if (key.kind === "packs") return true; // testPacks are complete: nothing pending
    if (fail === "flop") return false;
    files.add(key.path);
    return true;
  };
  return { ctx: { oracle } as TableCtx, load, loads };
}

/** Plays BTN-open hands (the hero on the BTN, all GTO AIs) until runBots stops for data on the flop. */
function untilNeeds(ctx: TableCtx, seed: number): PlayState | null {
  seedRandom(seed);
  for (let n = 0; n < 300; n++) {
    let s = startHand("cash", "100bb", 3, { profiles: Array.from({ length: 6 }, () => null), ctx });
    let guard = 0;
    while (!s.game.done && !s.needs && guard++ < 20) {
      const m = heroMoves(s, ctx);
      const open = m.find((x) => x.kind === "raise" && x.key !== "allin");
      s = heroAct(s, s.game.street === "preflop" && s.game.currentBet === 1 && open ? open : (m.find((x) => x.kind === "check" || x.kind === "call") ?? m[0]), ctx);
    }
    if (s.needs) return s;
  }
  return null;
}

describe("advance", () => {
  it("stops with needs, loads the manifest and the flop file, then plays on with the pack", async () => {
    let matched = 0;
    for (let seed = 1; seed < 40 && matched < 2; seed++) {
      const src = lazySource();
      const s = untilNeeds(src.ctx, seed)!;
      expect(s).not.toBeNull();
      expect(s.needs).toEqual({ kind: "manifest" });
      expect(heroMoves(s, src.ctx).length === 0 || s.game.toAct === s.heroIdx).toBe(true);
      const next = (await advance(s, src, src.ctx, () => true))!;
      expect(next.needs).toBeUndefined();
      expect(next.post?.failed).toBeUndefined();
      // A heads-up BTN-open pot the BB called: the cash pack, exact; anything else (a 3-bet, the SB in) has none.
      if (!next.post?.match) {
        expect(src.loads.map((k) => k.kind)).toEqual(["manifest"]);
        continue;
      }
      matched++;
      expect(src.loads.map((k) => k.kind)).toEqual(["manifest", "flop"]);
      expect(next.post.match.level).toBe("exact");
    }
    expect(matched).toBeGreaterThan(0);
  });

  it("goes on with the rules when a load fails", async () => {
    for (const fail of ["manifest", "flop"] as const) {
      const src = lazySource(fail);
      const s = untilNeeds(src.ctx, 5)!;
      const next = (await advance(s, src, src.ctx, () => true))!;
      expect(next.needs).toBeUndefined();
      expect(next.post?.failed).toBe(fail);
      let t = next;
      let guard = 0;
      while (!t.game.done && guard++ < 30) {
        t = heroAct(t, heroMoves(t, src.ctx)[0], src.ctx);
        expect(t.needs).toBeUndefined();
      }
      expect(t.game.done).toBe(true);
      // The flop says the load failed; from the turn on there is no solver anyway once a pack had matched.
      for (const d of t.decisions.filter((x) => x.street !== "preflop"))
        expect(d.reason).toBe(d.street !== "flop" && t.post?.match ? "턴부터는 솔버 없음 · 근사" : "솔버 팩을 못 열어서 근사");
    }
  });

  it("never stays stuck: a load that throws, or a pack the bots can't read, marks the hand failed and it goes on", async () => {
    // The load itself throws.
    const src = lazySource();
    const s = untilNeeds(src.ctx, 5)!;
    const throwing = { load: async () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'split')")) };
    const a = (await advance(s, throwing, src.ctx, () => true))!;
    expect([a.needs, a.post?.failed]).toEqual([undefined, "manifest"]);
    // The manifest loads, but matching on it throws (a malformed pack): runBots marks the hand instead of throwing.
    const broken = createOracle({
      packs: () => [{ ...testPacks()[0], sides: undefined as never }],
      flop: () => null,
    });
    const ctx2: TableCtx = { oracle: broken };
    const b = (await advance(s, { load: async () => true }, ctx2, () => true))!;
    expect(b.needs).toBeUndefined();
    expect(b.post).toEqual({ match: null, failed: "manifest" });
    let t = b;
    let guard = 0;
    while (!t.game.done && guard++ < 30) t = heroAct(t, heroMoves(t, ctx2)[0], ctx2);
    expect(t.game.done).toBe(true);
  });

  it("drops a load that finishes after the hand was replaced", async () => {
    const src = lazySource();
    const s = untilNeeds(src.ctx, 9)!;
    let current = true;
    const p = advance(s, src, src.ctx, () => current);
    current = false; // 새 핸드 during the load
    expect(await p).toBeNull();
  });
});
