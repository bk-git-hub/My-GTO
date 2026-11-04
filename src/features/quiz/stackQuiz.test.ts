import { describe, expect, it } from "vitest";
import { getSet } from "../../data/charts";
import { collapse, drillSeats, generateStackQuestion, gradeStack, questionActions, statKeys, vsOpenChart, type StackQuestion } from "./stackQuiz";

describe("stack quiz", () => {
  it("generates first-in spots with stacks that match the chart stage", () => {
    const range: Record<string, [number, number]> = { deep: [100, 250], mid: [40, 80], short: [14, 22], push: [5, 12] };
    for (let i = 0; i < 400; i++) {
      const q = generateStackQuestion("all", "all");
      expect(q.scenario.kind).toBe("rfi");
      expect(q.scenario.setId).toBe("pub");
      const bb = q.myChips / q.bb;
      const [lo, hi] = range[q.stageId];
      expect(bb, `${q.stageId} ${bb}`).toBeGreaterThanOrEqual(lo - 0.5);
      expect(bb, `${q.stageId} ${bb}`).toBeLessThanOrEqual(hi + 0.5);
      expect(q.avgChips).toBeGreaterThan(0);
      const f = collapse(q.scenario, q.scenario.strategy[q.hand]);
      expect(f.fold + f.open + f.shove).toBeCloseTo(1, 6);
    }
  });

  it("respects stage and seat filters", () => {
    for (let i = 0; i < 50; i++) {
      const q = generateStackQuestion("push", "BTN");
      expect(q.stageId).toBe("push");
      expect(q.scenario.hero).toBe("BTN");
      expect(q.hero).toBe("BTN");
    }
  });

  it("asks vs-open spots with a charted opener in an earlier seat", () => {
    const pubSeats = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
    for (let i = 0; i < 400; i++) {
      const q = generateStackQuestion("all", "all", "pub", "vs");
      expect(q.scenario.kind).toBe("vsOpen");
      expect(pubSeats.indexOf(q.opener!)).toBeLessThan(pubSeats.indexOf(q.hero));
      expect((q.scenario.heroSeats ?? [q.scenario.hero]).includes(q.hero) || q.scenario.hero === "Hero").toBe(true);
      expect(q.scenario.villainSeats ?? [q.scenario.villain]).toContain(q.opener);
      expect(q.openTo).toBeGreaterThan(1);
      const f = collapse(q.scenario, q.scenario.strategy[q.hand]);
      expect(Object.values(f).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(questionActions(q)[0]).toBe("fold");
      expect(questionActions(q)).not.toContain("open");
    }
    for (let i = 0; i < 100; i++) {
      const q = generateStackQuestion("all", "BB", "cash", "vs");
      expect(q.hero).toBe("BB");
      expect(["UTG", "HJ", "CO", "BTN", "SB"]).toContain(q.opener);
      expect(questionActions(q)).toEqual(["fold", "call", "3bet"]);
    }
  });

  it("falls back to the spot type the seat has", () => {
    expect(generateStackQuestion("all", "BB", "pub", "rfi").opener).toBeDefined(); // the BB never opens
    expect(generateStackQuestion("all", "UTG", "pub", "vs").opener).toBeUndefined(); // UTG never faces an open
    expect(drillSeats("cash", "vs")).toEqual(["CO", "BTN", "SB", "BB"]);
  });

  it("grades a vs-open spot against its chart", () => {
    let q = generateStackQuestion("deep", "BB", "pub", "vs");
    while (q.opener !== "UTG") q = generateStackQuestion("deep", "BB", "pub", "vs");
    // 딥 BB vs EP: 3벳 QQ+/AK, 콜 22-JJ ...
    expect(gradeStack({ ...q, hand: "AA" }, "3bet").grade).toBe("correct");
    expect(gradeStack({ ...q, hand: "77" }, "call").grade).toBe("correct");
    expect(gradeStack({ ...q, hand: "77" }, "3bet").grade).toBe("wrong");
    expect(gradeStack({ ...q, hand: "72o" }, "fold").grade).toBe("correct");
    expect(statKeys(q)).toContain("stack:vs:deep:BB");
  });

  it("drills the computed Nash charts: shove or fold, and call or fold vs an all-in", () => {
    for (let i = 0; i < 200; i++) {
      const q = generateStackQuestion("all", "all", "nash", "mix");
      expect(q.scenario.setId).toBe("nash");
      expect(q.myChips).toBe(parseFloat(q.stageId));
      if (q.opener) {
        expect(q.scenario.kind).toBe("vsShove");
        expect(q.scenario.hero).toBe(q.hero);
        expect(q.scenario.villain).toBe(q.opener);
        expect(q.openTo).toBe(q.myChips);
        expect(questionActions(q)).toEqual(["fold", "call"]);
      } else {
        expect(q.scenario.kind).toBe("rfi");
        expect(questionActions(q)).toEqual(["fold", "shove"]);
      }
    }
    const bb = generateStackQuestion("10bb", "BB", "nash", "rfi");
    expect(bb.opener).toBeDefined();
    expect(statKeys(bb)).toContain("stack-nash:vs:10bb:BB");
    expect(drillSeats("nash", "vs")).toEqual(["UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"]);
    // 10bb BB vs SB all-in: Nash calls with any ace.
    let q = generateStackQuestion("10bb", "BB", "nash", "vs");
    while (q.opener !== "SB") q = generateStackQuestion("10bb", "BB", "nash", "vs");
    expect(gradeStack({ ...q, hand: "A2o" }, "call").grade).toBe("correct");
    expect(gradeStack({ ...q, hand: "72o" }, "fold").grade).toBe("correct");
  });

  it("has a chart for every opener the BB can face in every pub stage and in cash", () => {
    for (const st of getSet("pub").stages) {
      for (const op of ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB"]) expect(vsOpenChart(st, "BB", op), `${st.id} ${op}`).toBeDefined();
    }
    const cash = getSet("cash6").stages[0];
    for (const op of ["UTG", "HJ", "CO", "BTN", "SB"]) expect(vsOpenChart(cash, "BB", op), op).toBeDefined();
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
