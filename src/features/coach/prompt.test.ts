import { describe, expect, it } from "vitest";
import { buildSystem } from "./prompt";

describe("the coach's instructions", () => {
  it("say the app's charts are its own computed charts, chip EV without ICM, and how to treat the uncertain ones", () => {
    const text = buildSystem("")[0].text;
    expect(text).toContain("직접 계산");
    expect(text).toContain("칩EV");
    expect(text).toContain("ICM");
    expect(text).toContain("계산된 차트 없음");
    expect(text).toContain("신뢰도 낮음");
    expect(text).not.toContain("솔버 정확값이 아닙니다");
  });
});
