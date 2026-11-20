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

  it("say a call of a covering all-in is priced on the pot I can win, as the app's numbers are", () => {
    const text = buildSystem("")[0].text;
    expect(text).toContain("내 스택을 넘는");
    expect(text).toContain("내가 이길 수 있는 팟");
    expect(text).toContain("전체 팟으로 다시 계산하지 마세요");
  });
});
