import { afterEach, describe, expect, it } from "vitest";
import { act, legal, newGame, PUB_TABLE } from "./engine";
import { fullWeights } from "./analysis";
import { comboOf } from "./packOracle";
import { PRESETS, type SeatProfile, type Step2, type Sticky } from "./profile";
import { handClassOf } from "../poker/cards";
import { sample, STAGE_STACK } from "./policy";
import { analyse, botPreflop, heroAct, heroMoves, runBots, startHand, VS_PROFILE_TAG, type HeroMove, type PlayState, type TableCtx } from "./table";
import { restoreRandom, seedRandom, testOracle } from "./testPacks";

/** The AI table end to end: whole hands against profiled AIs, the solver packs read from public/packs. */

const randomProfile = (): SeatProfile => ({
  loose: (Math.floor(Math.random() * 5) - 2) as Step2,
  aggro: (Math.floor(Math.random() * 5) - 2) as Step2,
  sticky: Math.floor(Math.random() * 3) as Sticky,
});

const ctx: TableCtx = { oracle: testOracle() };

/** A preflop move the way the chart plays the hero's hand (so the hero reaches the packs' ranges). */
function chartMove(s: PlayState): HeroMove {
  const p = s.game.players[s.heroIdx];
  const m = sample(botPreflop(s, s.heroIdx).base.moves(handClassOf(p.hole[0], p.hole[1])));
  if (m.kind === "raise") return { key: `raise:${m.to}`, label: `레이즈 ${m.to}`, kind: "raise", to: m.to };
  if (m.kind === "fold" && legal(s.game, s.heroIdx).canCheck) return { key: "check", label: "체크", kind: "check" };
  return { key: m.kind, label: m.kind, kind: m.kind };
}

/** Every AI's real hole cards keep a positive weight in the range the hero's model holds for it. */
function rangesHoldBots(s: PlayState) {
  s.game.players.forEach((p, i) => {
    if (i === s.heroIdx) return;
    expect(s.ranges[i][comboOf(p.hole)], `${p.seat} ${s.game.street}`).toBeGreaterThan(0);
  });
}

afterEach(() => restoreRandom());

describe("AI table hands", () => {
  it("plays 150 random hands with random profiles and the real solver packs: chips kept, ranges agree with the AIs' play", () => {
    seedRandom(20261121);
    let packDecisions = 0, packBot = 0, flopsMatched = 0;
    const runs = [["pub", "mid"], ["pub", "deep"], ["cash", "100bb"]] as const;
    for (const [mode, stage] of runs) {
      for (let n = 0; n < 50; n++) {
        const seats = mode === "cash" ? 6 : 9;
        const hero = n % seats;
        // Every third hand all GTO, so the exact-pack spots come up too.
        const profiles = Array.from({ length: seats }, (_, i) => (i === hero ? null : n % 3 === 0 ? PRESETS.gto.p : randomProfile()));
        let s = startHand(mode, stage, hero, { profiles, ctx });
        rangesHoldBots(s);
        const start = s.game.startStack * seats;
        let guard = 0;
        while (!s.game.done && guard++ < 60) {
          expect(s.needs).toBeUndefined();
          const moves = heroMoves(s, ctx);
          expect(moves.length).toBeGreaterThan(0);
          const L = legal(s.game, s.heroIdx);
          // Mostly a call or check (so heads-up single raised pots, the packs' spots, come up), now and then a min-raise
          // no chart makes, else any button.
          const x = Math.random();
          const passive = moves.find((m) => m.kind === "call" || m.kind === "check");
          const pick =
            s.game.street === "preflop" && x < 0.7
              ? chartMove(s)
              : x < 0.08 && L.canRaise
              ? { key: `raise:${L.minRaiseTo}`, label: `레이즈 ${L.minRaiseTo}`, kind: "raise" as const, to: L.minRaiseTo }
              : x < 0.6 && passive
                ? passive
                : moves[Math.floor(Math.random() * moves.length)];
          s = heroAct(s, pick, ctx);
          rangesHoldBots(s);
        }
        expect(s.game.done).toBe(true);
        expect(s.game.players.reduce((a, p) => a + p.stack, 0)).toBeCloseTo(start, 1);
        if (s.post?.match) flopsMatched++;
        for (const d of s.decisions) {
          expect(d.options.length).toBeGreaterThan(0);
          expect(d.source).toBeDefined();
          if (mode === "pub" && d.street === "preflop") expect(d.chartInfo, d.chosenLabel).toBeDefined();
          if (d.pack) {
            packDecisions++;
            expect(["good", "ok", "mistake"]).toContain(d.grade);
            expect(d.pack.freq.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
          }
          // Off the solver, postflop is 참고 with its reason.
          if (d.street !== "preflop" && !d.pack) expect([d.grade, !!d.reason]).toEqual(["info", true]);
        }
        packBot += Object.values(s.srcs ?? {}).filter((x) => x === "solver" || x === "solverApprox").length;
        // Every AI action carries its source.
        const aiActs = s.game.log.map((e, i) => ({ e, i })).filter(({ e }) => e.kind !== "post" && e.idx !== s.heroIdx);
        for (const { i } of aiActs) expect(s.srcs?.[i], `log ${i}`).toBeDefined();
      }
    }
    expect(flopsMatched).toBeGreaterThan(0);
    expect(packBot + packDecisions).toBeGreaterThan(0);
  }, 180000);

  it("plays a heads-up flop on the solver pack: the AI from the pack's rows, the hero graded on it", () => {
    seedRandom(7);
    for (const [mode, stage, level] of [["cash", "100bb", "exact"], ["pub", "mid", "approx"]] as const) {
      const seats = mode === "cash" ? 6 : 9;
      const btn = seats - 3;
      let graded = 0, aiPack = 0, hands = 0;
      while ((graded < 4 || aiPack < 4) && hands++ < 400) {
        let s = startHand(mode, stage, btn, { profiles: Array.from({ length: seats }, () => null), ctx });
        let guard = 0;
        while (!s.game.done && guard++ < 30) {
          const moves = heroMoves(s, ctx);
          let pick: HeroMove;
          if (s.game.street === "preflop") {
            const open = moves.find((m) => m.kind === "raise" && m.key !== "allin");
            pick = s.game.currentBet === 1 && open ? open : moves[0];
          } else pick = moves[Math.floor(Math.random() * moves.length)];
          s = heroAct(s, pick, ctx);
        }
        if (s.post?.match) expect(s.post.match.level).toBe(level);
        for (const d of s.decisions.filter((x) => x.pack)) {
          graded++;
          expect(d.source).toBe(level === "exact" ? "solver" : "solverApprox");
          expect(d.pack!.level).toBe(level);
          expect(d.summary).toMatch(/^솔버 기준 /);
          if (level === "approx") expect(d.summary).toContain("(근사)");
        }
        aiPack += Object.values(s.srcs ?? {}).filter((x) => x === (level === "exact" ? "solver" : "solverApprox")).length;
      }
      expect(graded, `${mode} pack grades`).toBeGreaterThanOrEqual(4);
      expect(aiPack, `${mode} AI pack moves`).toBeGreaterThanOrEqual(4);
    }
  }, 180000);

  it("plays preflop exactly as before when every AI is GTO (same random stream, same actions)", () => {
    for (const [mode, stage] of [["pub", "mid"], ["pub", "deep"], ["pub", "short"], ["cash", "100bb"]] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const seats = mode === "cash" ? 6 : 9;
        const hero = seed % seats;
        const play = (withProfiles: boolean) => {
          seedRandom(seed * 7919);
          let s = startHand(mode, stage, hero, withProfiles ? { profiles: Array.from({ length: seats }, () => null) } : undefined);
          let guard = 0;
          while (!s.game.done && s.game.street === "preflop" && guard++ < 20) s = heroAct(s, heroMoves(s)[heroMoves(s).length > 2 ? 1 : 0]);
          restoreRandom();
          return s.game.log.filter((e) => e.street === "preflop").map((e) => `${e.seat} ${e.kind} ${e.amount}`);
        };
        expect(play(true)).toEqual(play(false));
      }
    }
  });

  it("copy on write: a state kept before the AIs act is unchanged afterwards", () => {
    for (let n = 0; n < 20; n++) {
      const s0 = startHand("pub", "mid", n % 9, { profiles: Array.from({ length: 9 }, () => PRESETS.pub.p), ctx });
      if (s0.game.done) continue;
      const before = s0.ranges.map((w) => Array.from(w));
      const notes = { ...s0.botNotes };
      const srcs = { ...s0.srcs };
      const lines = s0.lines!.map((l) => l.length);
      const moves = heroMoves(s0, ctx);
      heroAct(s0, moves[moves.length - 1], ctx);
      expect(s0.ranges.map((w) => Array.from(w))).toEqual(before);
      expect(s0.botNotes).toEqual(notes);
      expect(s0.srcs).toEqual(srcs);
      expect(s0.lines!.map((l) => l.length)).toEqual(lines);
    }
  });

  it("replays a kept spot: same hole cards and board so far, and a valid hand to the end", () => {
    let replays = 0;
    for (let n = 0; n < 40 && replays < 10; n++) {
      let s = startHand("pub", "deep", n % 9, { profiles: Array.from({ length: 9 }, () => PRESETS.gto.p), ctx });
      const kept: PlayState[] = [];
      let guard = 0;
      while (!s.game.done && guard++ < 40) {
        kept.push(s);
        const m = heroMoves(s, ctx);
        s = heroAct(s, m.find((x) => x.kind === "call" || x.kind === "check") ?? m[0], ctx);
      }
      const k = kept[kept.length - 1];
      if (!k || k.game.street === "preflop") continue;
      replays++;
      let r: PlayState = { ...k, replay: true };
      expect(r.game.players[r.heroIdx].hole).toEqual(k.game.players[k.heroIdx].hole);
      let g2 = 0;
      while (!r.game.done && g2++ < 40) {
        const m = heroMoves(r, ctx);
        r = heroAct(r, m[0], ctx);
      }
      expect(r.game.done).toBe(true);
      expect(r.replay).toBe(true);
      expect(r.game.board.slice(0, k.game.board.length)).toEqual(k.game.board);
      expect(r.game.players[r.heroIdx].hole).toEqual(k.game.players[k.heroIdx].hole);
    }
    expect(replays).toBeGreaterThan(0);
  });

  it("stops for data the oracle doesn't have yet, and goes on once it loads", () => {
    // An oracle that holds the manifest back until told.
    const real = testOracle();
    let ready = false;
    const lazy: TableCtx = {
      oracle: { needs: (s) => (!ready && s.game.street === "flop" && s.post === undefined && !s.game.players[s.heroIdx].folded ? { kind: "manifest" } : real.needs(s)), match: real.match, spot: real.spot },
    };
    let stopped = 0;
    for (let n = 0; n < 60 && stopped < 3; n++) {
      ready = false;
      let s = startHand("pub", "mid", 8, { profiles: Array.from({ length: 9 }, () => null), ctx: lazy });
      let guard = 0;
      while (!s.game.done && guard++ < 40) {
        if (s.needs) {
          stopped++;
          expect(s.game.street).toBe("flop");
          expect(heroMoves(s, lazy).length === 0 || s.game.toAct === s.heroIdx).toBe(true);
          ready = true;
          s = runBots(s, lazy);
          expect(s.needs).toBeUndefined();
          expect(s.post).toBeDefined();
          continue;
        }
        const m = heroMoves(s, lazy);
        s = heroAct(s, m.find((x) => x.kind === "call" || x.kind === "check") ?? m[0], lazy);
      }
    }
    expect(stopped).toBeGreaterThan(0);
  });

  it("marks a preflop grade against non-GTO opponents only when a chart graded it, and names the chart raise of a fold", () => {
    const pubProf = PRESETS.pub.p;
    const profiles = (hero: number, n: number) => Array.from({ length: n }, (_, i) => (i === hero ? null : pubProf));
    // A tournament limped pot: no computed chart, so no "GTO 차트 기준" tag and no vsProfile mark.
    const hero = PUB_TABLE.seats.indexOf("BTN");
    let g = newGame(STAGE_STACK.mid, hero, undefined, PUB_TABLE);
    g = act(g, "call");
    while (g.toAct !== hero) g = act(g, "fold");
    const limp: PlayState = { mode: "pub", stageId: "mid", heroIdx: hero, game: g, ranges: g.players.map(() => fullWeights()), decisions: [], botNotes: {}, profiles: profiles(hero, 9), lines: g.players.map(() => []), srcs: {} };
    for (const m of heroMoves(limp)) {
      const d = analyse(limp, m, {});
      expect([d.chartInfo?.source, d.source, d.vsProfile]).toEqual([null, "none", undefined]);
      expect(d.chartInfo!.tags).not.toContain(VS_PROFILE_TAG);
      if (d.foldOut) expect(d.foldOut.text).toMatch(/성향 없는 AI라면|차트대로 치는 AI라면/);
    }
    // A first-in BTN spot with a hand the chart opens: folding it names the chart's raise in the all-fold note.
    seedRandom(11);
    let found = 0;
    for (let n = 0; n < 200 && found < 3; n++) {
      const s = startHand("pub", "mid", hero, { profiles: profiles(hero, 9), ctx });
      if (s.game.toAct !== hero || s.game.currentBet !== 1) continue;
      const fold = heroMoves(s).find((m) => m.kind === "fold")!;
      const d = analyse(s, fold, ctx);
      if (!d.foldOut) continue;
      found++;
      expect(d.vsProfile).toBe(true);
      expect(d.chartInfo!.tags).toContain(VS_PROFILE_TAG);
      expect(d.foldOut.text).toMatch(/^차트 레이즈 [\d.]+이면 모두 폴드 \d+% \(차트대로 치는 AI라면 \d+%\)/);
      const open = heroMoves(s).find((m) => m.kind === "raise" && m.key !== "allin")!;
      expect(analyse(s, open, ctx).foldOut!.text).toMatch(/^이 레이즈에 모두 폴드/);
    }
    expect(found).toBeGreaterThan(0);
  });

  it("cash preflop on the AI table: the hand-made chart's grade with the profile mark and the all-fold note; cash AIs logged as the cash chart", () => {
    seedRandom(3);
    let marked = 0, cashSrc = 0;
    for (let n = 0; n < 60; n++) {
      const hero = n % 6;
      let s = startHand("cash", "100bb", hero, { profiles: Array.from({ length: 6 }, (_, i) => (i === hero ? null : PRESETS.pub.p)), ctx });
      cashSrc += Object.values(s.srcs ?? {}).filter((x) => x === "cashChart").length;
      expect(Object.values(s.srcs ?? {})).not.toContain("chart");
      if (s.game.done || s.game.street !== "preflop") continue;
      const moves = heroMoves(s, ctx);
      const raise = moves.find((m) => m.kind === "raise" && m.key !== "allin");
      const d = analyse(s, raise ?? moves[0], ctx);
      if (d.grade !== "info") {
        expect(d.vsProfile).toBe(true);
        expect(d.source).toBe("chart");
        marked++;
      }
      if (raise) expect(d.foldOut?.text ?? "").toMatch(/모두 폴드/);
      s = heroAct(s, raise ?? moves[0], ctx);
    }
    expect(marked).toBeGreaterThan(0);
    expect(cashSrc).toBeGreaterThan(0);
  });
});
