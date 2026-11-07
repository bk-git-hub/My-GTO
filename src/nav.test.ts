import { describe, expect, it } from "vitest";
import { isActive, NAV, NAV_ITEMS, redirectRoute, titleOf } from "./nav";

describe("menu and routes", () => {
  it("has a 핸드 기록 section with three indented items, and no 정보 수집", () => {
    const at = NAV.findIndex((n) => "section" in n && n.section === "핸드 기록");
    expect(at).toBeGreaterThan(0);
    expect(NAV.slice(at + 1, at + 4)).toEqual([
      { route: "log", label: "새 기록 작성", icon: "✎", indent: true },
      { route: "log/other", label: "남의 핸드 기록", icon: "◉", indent: true },
      { route: "log/list", label: "지난 기록 보기", icon: "☰", indent: true },
    ]);
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
    expect(titleOf("log")).toBe("새 기록 작성");
    expect(titleOf("log/other")).toBe("남의 핸드 기록");
    expect(titleOf("log/other/x")).toBe("남의 핸드 기록");
    expect(titleOf("log/list")).toBe("지난 기록 보기");
    expect(titleOf("log/list/other")).toBe("지난 기록 보기");
    expect(titleOf("log/players")).toBe("지난 기록 보기");
    expect(titleOf("log/abc-123")).toBe("핸드 기록");
    expect(titleOf("quiz/odds")).toBe("팟 오즈·EV");
    expect(titleOf("quiz")).toBe("퀴즈");
  });
});
