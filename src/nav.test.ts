import { describe, expect, it } from "vitest";
import { isActive, NAV, NAV_ITEMS, redirectRoute, titleOf } from "./nav";

describe("menu and routes", () => {
  it("pairs 펍아재 차트·솔버 차트 and 핸드 복기·지난 기록 보기 on top, then 빠른 기록, the quizzes and the other tools", () => {
    expect(NAV[0]).toEqual({ pair: [{ route: "charts", label: "펍아재 차트", icon: "▦" }, { route: "solver", label: "솔버 차트", icon: "◆" }] });
    expect(NAV[1]).toEqual({ pair: [{ route: "log", label: "핸드 복기", icon: "✎" }, { route: "log/list", label: "지난 기록 보기", icon: "☰" }] });
    expect(NAV[2]).toEqual({ route: "log/other", label: "빠른 기록", icon: "⚡" });
    const sections = NAV.filter((n): n is { section: string } => "section" in n).map((n) => n.section);
    expect(sections).toEqual(["퀴즈", "그외 도구"]);
    expect(NAV_ITEMS.map((i) => i.route)).toEqual(["charts", "solver", "log", "log/list", "log/other", "quiz/stack", "quiz/preflop", "quiz/odds", "quiz/equity", "home", "play", "calc", "settings"]);
    expect(NAV_ITEMS.some((i) => i.route === "scout" || i.label === "정보 수집")).toBe(false);
  });

  it("lights exactly one hand-log item for each of its screens", () => {
    const lit = (route: string) => NAV_ITEMS.filter((i) => isActive(i.route, route)).map((i) => i.route);
    expect(lit("log")).toEqual(["log"]);
    expect(lit("log/other")).toEqual(["log/other"]);
    expect(lit("log/other/abc-123")).toEqual(["log/other"]);
    for (const r of ["log/list", "log/list/mine", "log/list/other", "log/players", "log/abc-123"]) expect(lit(r)).toEqual(["log/list"]);
    // the rest as before
    expect(lit("home")).toEqual(["home"]);
    expect(lit("quiz")).toEqual(["quiz/stack"]);
    expect(lit("quiz/stack/pub/deep")).toEqual(["quiz/stack"]);
    expect(lit("solver/x")).toEqual(["solver"]);
  });

  it("sends the old 정보 수집 and quick-record routes to their new places", () => {
    expect(redirectRoute("scout")).toBe("log/other");
    expect(redirectRoute("scout/anything")).toBe("log/other");
    expect(redirectRoute("log/quick")).toBe("log");
    expect(redirectRoute("log/quick/q-old")).toBe("log/q-old");
    expect(redirectRoute("log/quick/")).toBe("log");
    for (const r of ["log", "log/other", "log/list", "log/abc", "home", "quiz/stack"]) expect(redirectRoute(r)).toBeNull();
  });

  it("titles the header by screen", () => {
    expect(titleOf("home")).toBe("");
    expect(titleOf("log")).toBe("핸드 복기");
    expect(titleOf("log/other")).toBe("빠른 기록");
    expect(titleOf("log/other/x")).toBe("빠른 기록");
    expect(titleOf("log/list")).toBe("지난 기록 보기");
    expect(titleOf("log/list/other")).toBe("지난 기록 보기");
    expect(titleOf("log/players")).toBe("지난 기록 보기");
    expect(titleOf("log/abc-123")).toBe("핸드 기록");
    expect(titleOf("quiz/odds")).toBe("팟 오즈·EV");
    expect(titleOf("quiz")).toBe("퀴즈");
  });
});
