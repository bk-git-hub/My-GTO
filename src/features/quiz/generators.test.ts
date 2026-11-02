import { describe, expect, it } from "vitest";
import { generateEquity, generateOdds, generatePreflop, gradePreflop } from "./generators";

describe("quiz generators", () => {
  it("odds questions have 4 distinct options and a valid answer", () => {
    for (let i = 0; i < 400; i++) {
      const q = generateOdds();
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThan(4);
      expect(q.steps.length).toBeGreaterThan(0);
    }
  });
  it("equity questions have 4 distinct options", () => {
    for (let i = 0; i < 40; i++) {
      const q = generateEquity();
      expect(new Set(q.options).size).toBe(4);
      expect(q.hero).toHaveLength(2);
    }
  });
  it("preflop questions pick valid hands", () => {
    for (let i = 0; i < 200; i++) {
      const q = generatePreflop(i % 2 ? "yajasu" : "cash6", i % 3 ? "all" : "stage:push");
      expect(q.scenario.strategy[q.hand]).toBeDefined();
      expect(q.cards).toHaveLength(2);
    }
  });
  it("grades by chart frequency", () => {
    expect(gradePreflop(1, 1)).toBe("correct");
    expect(gradePreflop(0.6, 0.6)).toBe("correct");
    expect(gradePreflop(0.4, 0.6)).toBe("mixed");
    expect(gradePreflop(0.45, 0.45)).toBe("correct"); // best action in a 3-way mix
    expect(gradePreflop(0.1, 0.9)).toBe("wrong");
    expect(gradePreflop(0, 1)).toBe("wrong");
  });
});
