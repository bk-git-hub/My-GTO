import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The solver set (633 spots) is built on first use, not at app start (docs §6.3): built at load it cost every start
 * about 0.26 s and 20 MB of JS heap in Chromium. Each test starts from fresh modules, as an app start does, and checks what builds it and what does not.
 */

beforeEach(() => {
  vi.resetModules();
});

async function fresh() {
  const charts = await import("./charts");
  const preflop = await import("./sets/preflop");
  const { settingsStore } = await import("../state/settings");
  settingsStore.set({ ...settingsStore.get(), chartSet: "pub" });
  const built = () => [preflop.solverSetDefBuilt(), charts.lazySetsBuilt()];
  return { charts, preflop, built };
}

describe("lazy solver set", () => {
  it("is not built by the menu, the other sets, the pub quiz pool or the pub charts and quiz pages", async () => {
    const { charts, built } = await fresh();
    expect(built()).toEqual([false, []]);
    expect(charts.chartSetMenu().map((s) => s.id)).toEqual(["solver", "pub", "cash6", "nash", "shortnash"]);
    expect(charts.chartSetId("solver")).toBe("solver");
    expect(charts.chartSetId("x")).toBe("pub");
    expect(charts.getSet("pub").id).toBe("pub");
    expect(charts.getSet("x").id).toBe("pub");
    expect(charts.allScenarios(charts.getSet("nash")).length).toBeGreaterThan(0);
    const { quizPool } = await import("../features/quiz/generators");
    expect(quizPool("pub", "all").length).toBeGreaterThan(0);
    const { ChartsPage } = await import("../features/charts/ChartsPage");
    const { QuizPage } = await import("../features/quiz/QuizPage");
    expect(renderToString(createElement(ChartsPage))).toContain("솔버 프리플랍");
    // The default quiz mode is the range drill; "preflop" renders the chart quiz with its set picker.
    expect(renderToString(createElement(QuizPage, { sub: "preflop" }))).toContain('class="card-box quiz"');
    expect(built()).toEqual([false, []]);

    // The first use builds it once; later calls get the same object.
    const a = charts.getSet("solver");
    expect(a.id).toBe("solver");
    expect(built()).toEqual([true, ["solver"]]);
    expect(charts.getSet("solver")).toBe(a);
    expect(charts.allSets().at(-1)).toBe(a);
    expect(charts.allScenarios().some((s) => s.setId === "solver")).toBe(true);
  });

  it("is not built by a hand review, 빠른 기록's verdict or hand play, which read one spot at a time", async () => {
    const { built } = await fresh();
    const { analyseHand } = await import("../features/log/handAnalysis");
    const { emptyHand } = await import("../features/log/handLog");
    const { fastVerdict } = await import("../features/log/fastVerdict");
    const { parseCards } = await import("../poker/cards");
    const h = { ...emptyHand(6), players: 9, seat: "BB", hole: parseCards("AdTd"), stack: 80000, steps: [
      { s: "UTG", k: "fold" as const }, { s: "UTG+1", k: "fold" as const }, { s: "UTG+2", k: "fold" as const }, { s: "LJ", k: "fold" as const },
      { s: "HJ", k: "fold" as const }, { s: "CO", k: "raise" as const, to: 2.5 }, { s: "BTN", k: "fold" as const }, { s: "SB", k: "fold" as const }, { s: "BB", k: "call" as const },
    ] };
    const a = analyseHand(h, { decisions: true, iterations: 200 });
    expect(a.decisions[0].decision.chartInfo?.source).toBe("solver");
    expect(fastVerdict({ stage: "mid", players: 9, seat: "BTN", cls: "AJo", spot: "none", act: "open" }).kind).toBe("ok");
    const { PlayPage } = await import("../features/play/PlayPage");
    renderToString(createElement(PlayPage));
    expect(built()).toEqual([false, []]);
  });

  it("is built by allScenarios() and by the calculator's named ranges", async () => {
    let { charts, built } = await fresh();
    charts.allScenarios();
    expect(built()).toEqual([true, ["solver"]]);
    vi.resetModules();
    ({ charts, built } = await fresh());
    const { CalcPage } = await import("../features/calc/CalcPage");
    expect(built()).toEqual([false, []]);
    renderToString(createElement(CalcPage));
    expect(built()).toEqual([true, ["solver"]]);
    expect(charts.getNamedRanges().some((r) => r.id.startsWith("solver/"))).toBe(true);
  });
});
