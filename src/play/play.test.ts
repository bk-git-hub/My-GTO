import { describe, expect, it } from "vitest";
import { parseCards } from "../poker/cards";
import { act, heroNet, newGame, pot } from "./engine";
import { handFeatures } from "./handInfo";
import { heroAct, heroMoves, startHand } from "./table";

/** Chips on the table: stacks plus the pot while the hand runs, stacks only once it's paid out. */
const totalChips = (g: ReturnType<typeof newGame>) => g.players.reduce((s, p) => s + p.stack, 0) + (g.done ? 0 : pot(g));

describe("engine", () => {
  it("posts blinds and BB ante, starts with UTG", () => {
    const g = newGame(100, 0);
    expect(pot(g)).toBeCloseTo(2.5);
    expect(g.toAct).toBe(0);
    expect(g.players[8].stack).toBeCloseTo(98);
    expect(g.players[7].stack).toBeCloseTo(99.5);
  });

  it("everyone folds to the BB: BB wins blinds + ante", () => {
    let g = newGame(100, 0);
    for (let i = 0; i < 8; i++) g = act(g, "fold");
    expect(g.done).toBe(true);
    expect(g.players[8].stack).toBeCloseTo(100.5); // 98 + 2.5
  });

  it("all-in preflop runs out the board and keeps chips constant", () => {
    let g = newGame(10, 0);
    expect(totalChips(g)).toBeCloseTo(90);
    g = act(g, "raise", 10); // UTG shoves
    for (let i = 1; i < 8; i++) g = act(g, "fold");
    g = act(g, "call"); // BB calls (has 9 behind after the ante)
    expect(g.done).toBe(true);
    expect(g.board).toHaveLength(5);
    expect(totalChips(g)).toBeCloseTo(90);
  });
});

describe("hand features", () => {
  const f = (h: string, b: string) => handFeatures(parseCards(h), parseCards(b));
  it("classifies common holdings", () => {
    expect(f("AhKd", "Ks7c2d").tier).toBe(3); // top pair top kicker
    expect(f("Kh5d", "Ks7c2d").tier).toBe(2); // top pair weak kicker
    expect(f("7h7d", "Ks7c2d").tier).toBe(4); // set
    expect(f("AhQh", "Kh7h2d").tier).toBe(1.5); // nut flush draw
    expect(f("9h8h", "Th7h2d").tier).toBe(2.5); // flush + straight draw
    expect(f("9c8d", "Th7s2d").straightDraw).toBe("oesd");
    expect(f("QcJd", "8h4s2d").tier).toBe(0);
  });
});

describe("full hands with bots", () => {
  it("plays 300 random hands to the end without losing chips", () => {
    for (const stage of ["deep", "mid", "short", "push"]) {
      for (let n = 0; n < 75; n++) {
        let s = startHand(stage);
        const start = s.game.startStack * 9;
        let guard = 0;
        while (!s.game.done && guard++ < 60) {
          const moves = heroMoves(s);
          expect(moves.length).toBeGreaterThan(0);
          s = heroAct(s, moves[Math.floor(Math.random() * moves.length)]);
        }
        expect(s.game.done).toBe(true);
        const chips = s.game.players.reduce((a, p) => a + p.stack, 0);
        expect(chips).toBeCloseTo(start, 1);
        expect(Number.isFinite(heroNet(s.game))).toBe(true);
        for (const d of s.decisions) expect(d.options.length).toBeGreaterThan(0);
      }
    }
  }, 60000);
});
