import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The solver set's stages are separate chunks loaded on first use (docs §6.3): the index (labels, stacks, descriptions)
 * comes with the app, each stage's scenarios are fetched by loadSolverStage / loadSolver, and a solver screen renders a
 * skeleton until they are in. Each test starts from fresh modules, as an app start does, and checks what loads them and
 * what does not.
 */

beforeEach(() => {
  vi.resetModules();
});

async function fresh(chartSet = "pub") {
  const charts = await import("./charts");
  const preflop = await import("./sets/preflop");
  const { settingsStore } = await import("../state/settings");
  settingsStore.set({ ...settingsStore.get(), chartSet });
  const loaded = () => [preflop.solverStagesLoaded(), preflop.solverSetDefBuilt(), charts.lazySetsBuilt()];
  return { charts, preflop, loaded };
}

describe("lazy solver set", () => {
  it("loads no stage for the menu, the other sets, the pub quiz pool or the pub charts and quiz pages", async () => {
    const { charts, preflop, loaded } = await fresh();
    expect(loaded()).toEqual([[], false, []]);
    expect(charts.chartSetMenu().map((s) => s.id)).toEqual(["solver", "pub", "cash6", "nash", "shortnash"]);
    expect(charts.chartSetId("solver")).toBe("solver");
    expect(charts.chartSetId("x")).toBe("pub");
    expect(charts.getSet("pub").id).toBe("pub");
    expect(charts.getSet("x").id).toBe("pub");
    expect(charts.allScenarios(charts.getSet("nash")).length).toBeGreaterThan(0);
    // The index alone gives the stage list, the labels and the set's texts.
    expect(preflop.SOLVER_STAGE_IDS.length).toBeGreaterThanOrEqual(3);
    expect(preflop.solverSetInfo().source).toContain("DCFR");
    const { quizPool } = await import("../features/quiz/generators");
    expect(quizPool("pub", "all").length).toBeGreaterThan(0);
    const { ChartsPage } = await import("../features/charts/ChartsPage");
    const { QuizPage } = await import("../features/quiz/QuizPage");
    expect(renderToString(createElement(ChartsPage))).toContain("솔버 프리플랍");
    // The default quiz mode is the range drill; "preflop" renders the chart quiz with its set picker.
    expect(renderToString(createElement(QuizPage, { sub: "preflop" }))).toContain('class="card-box quiz"');
    expect(loaded()).toEqual([[], false, []]);
    expect(charts.solverLoaded()).toBe(false);
    expect(() => charts.getSet("solver")).toThrow(/not loaded/);
    expect(() => charts.allSets()).toThrow(/not loaded/);
  });

  it("solver screens show a skeleton until the stages are in, then the chart", async () => {
    const { charts, loaded } = await fresh("solver");
    const { ChartsPage } = await import("../features/charts/ChartsPage");
    const { QuizPage } = await import("../features/quiz/QuizPage");
    const { CalcPage } = await import("../features/calc/CalcPage");
    for (const page of [createElement(ChartsPage), createElement(QuizPage, { sub: "preflop" }), createElement(CalcPage)]) {
      const html = renderToString(page);
      expect(html).toContain("솔버 차트 불러오는 중");
      expect(html).not.toContain('role="grid"');
    }
    expect(loaded()[0]).toEqual([]);
    await charts.loadSolver();
    const charts2 = renderToString(createElement(ChartsPage));
    expect(charts2).not.toContain("솔버 차트 불러오는 중");
    expect(charts2).toContain(charts.getSet("solver").stages[0].label);
    expect(renderToString(createElement(QuizPage, { sub: "preflop" }))).toContain('class="card-box quiz"');
    expect(renderToString(createElement(CalcPage))).toContain("솔버 프리플랍");
  });

  it("loadSolverStage fetches one stage; loadSolver all of them, once; the set holds the same stage objects", async () => {
    const { charts, preflop, loaded } = await fresh();
    const [first, second] = preflop.SOLVER_STAGE_IDS;
    expect(charts.solverStage(second)).toBeUndefined();
    let notified = 0;
    const off = charts.subscribeSolver(() => notified++);
    const st = await charts.loadSolverStage(second);
    expect(st.id).toBe(second);
    expect(st.scenarios[0].id.startsWith(`solver/${second}/`)).toBe(true);
    expect(charts.solverStage(second)).toBe(st);
    expect(await charts.loadSolverStage(second)).toBe(st);
    expect(loaded()).toEqual([[second], false, []]);
    expect(charts.solverStage(first)).toBeUndefined();
    expect(() => charts.getSet("solver")).toThrow(/not loaded/);
    expect(notified).toBe(1);

    const set = await charts.loadSolver();
    expect(loaded()).toEqual([[...preflop.SOLVER_STAGE_IDS], true, ["solver"]]);
    expect(notified).toBe(preflop.SOLVER_STAGE_IDS.length);
    off();
    expect(charts.solverLoaded()).toBe(true);
    expect(charts.getSet("solver")).toBe(set);
    expect(await charts.loadSolver()).toBe(set);
    expect(set.stages.map((s) => s.id)).toEqual(preflop.SOLVER_STAGE_IDS);
    expect(set.stages[1]).toBe(st);
    expect(charts.allSets().at(-1)).toBe(set);
    expect(charts.allScenarios().some((s) => s.setId === "solver")).toBe(true);
    expect(charts.getNamedRanges().some((r) => r.id.startsWith("solver/"))).toBe(true);
    // Every stage's label, stack and description equal the index's, so a screen can list the stages before loading.
    for (const s of set.stages) expect({ id: s.id, label: s.label, stack: s.stack, description: s.description }).toEqual(
      (({ id, label, stack, description }) => ({ id, label, stack, description }))(preflop.stageInfo(preflop.solverStageData(s.id)!)),
    );
  });

  it("an unknown stage id rejects instead of loading anything", async () => {
    const { charts, loaded } = await fresh();
    await expect(charts.loadSolverStage("7bb-x")).rejects.toThrow(/no solver stage/);
    expect(loaded()).toEqual([[], false, []]);
  });
});
