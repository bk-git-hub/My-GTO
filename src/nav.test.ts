import { describe, expect, it } from "vitest";
import { isActive, NAV, NAV_ITEMS, redirectRoute, titleOf } from "./nav";

describe("menu and routes", () => {
  it("is one column: a section title over every group, then items one per row", () => {
    // no two items share a row, and no item is set apart (indent, pair)
    for (const n of NAV) expect(Object.keys(n).sort()).toEqual("section" in n ? ["section"] : ["icon", "label", "route"]);
    const sections = NAV.filter((n): n is { section: string } => "section" in n).map((n) => n.section);
    expect(sections).toEqual(["차트", "기록", "퀴즈", "그외 도구"]);
    expect("section" in NAV[0]).toBe(true);
    // the groups, in the order the user set
    const groups: Record<string, string[]> = {};
    let current = "";
    for (const n of NAV) {
      if ("section" in n) groups[(current = n.section)] = [];
      else groups[current].push(n.route);
    }
    expect(groups).toEqual({
      차트: ["charts", "solver"],
      기록: ["log", "log/list", "log/fast"],
      퀴즈: ["quiz/stack", "quiz/preflop", "quiz/odds", "quiz/equity"],
      "그외 도구": ["home", "play", "calc", "settings"],
    });
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["펍아재 차트", "솔버 차트", "핸드 복기", "지난 기록 보기", "빠른 기록", "레인지 암기", "프리플랍 퀴즈", "팟 오즈·EV", "에퀴티", "홈", "핸드 플레이", "계산기", "설정"]);
    expect(NAV_ITEMS.some((i) => i.route === "scout" || i.label === "정보 수집")).toBe(false);
  });

  it("draws every icon as a plain text glyph, never a color emoji", () => {
    // A color emoji by default (⚡ was), a request for the emoji form (U+FE0F), or an emoji-capable character
    // (⚙, ♠: iOS may draw these in color) not followed by U+FE0E, which asks for the text glyph.
    const colorEmoji = /\p{Emoji_Presentation}|\uFE0F|\p{Emoji}(?!\uFE0E)/u;
    for (const bad of ["\u26A1", "\u2699", "\u2660", "\u2699\uFE0F", "\u26A0"]) expect(colorEmoji.test(bad), bad).toBe(true);
    expect(NAV_ITEMS.find((i) => i.route === "log/fast")!.icon).toBe("\u21AF");
    expect(NAV_ITEMS.find((i) => i.route === "settings")!.icon).toBe("\u2699\uFE0E");
    expect(NAV_ITEMS.find((i) => i.route === "play")!.icon).toBe("\u2660\uFE0E");
    for (const i of NAV_ITEMS) {
      expect(i.icon.length, i.label).toBeGreaterThan(0);
      expect(colorEmoji.test(i.icon), i.label).toBe(false);
    }
  });

  it("reaches every screen from the menu, each item lit on its own screen", () => {
    expect(new Set(NAV_ITEMS.map((i) => i.route)).size).toBe(NAV_ITEMS.length);
    for (const i of NAV_ITEMS) {
      expect(redirectRoute(i.route), i.route).toBeNull();
      expect(NAV_ITEMS.filter((j) => isActive(j.route, i.route)).map((j) => j.route), i.route).toEqual([i.route]);
      expect(titleOf(i.route), i.route).toBe(i.route === "home" ? "" : i.label);
    }
  });

  it("lights exactly one hand-log item for each of its screens", () => {
    const lit = (route: string) => NAV_ITEMS.filter((i) => isActive(i.route, route)).map((i) => i.route);
    expect(lit("log")).toEqual(["log"]);
    expect(lit("log/fast")).toEqual(["log/fast"]);
    // 남의 핸드 is reached from 빠른 기록's toggle
    expect(lit("log/other")).toEqual(["log/fast"]);
    expect(lit("log/other/abc-123")).toEqual(["log/fast"]);
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
    for (const r of ["log", "log/fast", "log/other", "log/list", "log/abc", "home", "quiz/stack"]) expect(redirectRoute(r)).toBeNull();
  });

  it("titles the header by screen", () => {
    expect(titleOf("home")).toBe("");
    expect(titleOf("log")).toBe("핸드 복기");
    expect(titleOf("log/fast")).toBe("빠른 기록");
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
