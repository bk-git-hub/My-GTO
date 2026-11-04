import { describe, expect, it } from "vitest";
import { collapse, generateStackQuestion, gradeStack, type StackQuestion } from "./stackQuiz";

describe("stack quiz", () => {
  it("generates first-in spots with stacks that match the chart stage", () => {
    const range: Record<string, [number, number]> = { deep: [100, 250], mid: [40, 80], short: [14, 22], push: [5, 12] };
    for (let i = 0; i < 400; i++) {
      const q = generateStackQuestion("all", "all");
      expect(q.scenario.kind).toBe("rfi");
      expect(q.scenario.setId).toBe("yajasu");
      const bb = q.myChips / q.bb;
      const [lo, hi] = range[q.stageId];
      expect(bb, `${q.stageId} ${bb}`).toBeGreaterThanOrEqual(lo - 0.5);
      expect(bb, `${q.stageId} ${bb}`).toBeLessThanOrEqual(hi + 0.5);
      expect(q.avgChips).toBeGreaterThan(0);
      const f = collapse(q.scenario.strategy[q.hand]);
      expect(f.fold + f.open + f.shove).toBeCloseTo(1, 6);
    }
  });

  it("respects stage and seat filters", () => {
    for (let i = 0; i < 50; i++) {
      const q = generateStackQuestion("push", "BTN");
      expect(q.stageId).toBe("push");
      expect(q.scenario.hero).toBe("BTN");
    }
  });

  it("grades against the chart", () => {
    const base = generateStackQuestion("push", "UTG");
    const q = (hand: string): StackQuestion => ({ ...base, hand });
    expect(gradeStack(q("AA"), "shove").grade).toBe("correct");
    expect(gradeStack(q("AA"), "open").grade).toBe("wrong");
    expect(gradeStack(q("72o"), "fold").grade).toBe("correct");
    const short = generateStackQuestion("short", "UTG");
    // 17bb UTG: TT+ is a 2bb open, 99 a shove
    expect(gradeStack({ ...short, hand: "TT" }, "open").grade).toBe("correct");
    expect(gradeStack({ ...short, hand: "99" }, "shove").grade).toBe("correct");
    expect(gradeStack({ ...short, hand: "99" }, "open").grade).toBe("wrong");
  });
});
