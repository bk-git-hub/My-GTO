import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { clearAttempts, recordAttempt } from "../../state/attempts";
import { RecordsPage } from "./RecordsPage";

const go = () => {};

describe("RecordsPage (server render smoke test)", () => {
  afterEach(() => clearAttempts());

  it("shows the empty state", () => {
    const html = renderToString(<RecordsPage go={go} />);
    expect(html).toContain("아직 문제별 기록이 없어요");
  });

  it("renders summary, categories, weak spots and history", () => {
    const now = Date.now();
    for (let i = 0; i < 35; i++) {
      recordAttempt(
        {
          kind: i % 2 ? "stack" : "play",
          keys: [i % 2 ? "stack" : "play"],
          spot: i % 2 ? "stack:pub:short:CO:K9o" : "play:deep:flop",
          title: i % 2 ? "펍 숏 · CO · K9o" : "딥 플랍 · BTN AKs",
          chosen: "폴드",
          correct: "오픈 (100%)",
          grade: i % 3 ? "wrong" : "correct",
          evLossBB: i % 2 ? undefined : 0.8,
          detail: "보드: As Kd 7c",
        },
        now - (35 - i) * 60_000,
      );
    }
    const html = renderToString(<RecordsPage go={go} />);
    for (const text of ["요약", "카테고리별", "약점 TOP 5", "히스토리", "연습하기", "더 보기", "평균 EV 손실", "기록 내보내기"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("핸드 플레이 · 딥 · 플랍");
  });
});
