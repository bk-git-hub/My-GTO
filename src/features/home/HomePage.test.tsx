import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomePage } from "./HomePage";

describe("home cards (react-dom/server)", () => {
  it("splits the hand log into 핸드 복기 · 남의 핸드 기록 · 지난 기록 보기, with no 정보 수집", () => {
    const html = renderToString(<HomePage go={() => {}} />).replace(/<!-- -->/g, "");
    const titles = [...html.matchAll(/<b[^>]*>([^<]+)<\/b>/g)].map((m) => m[1]);
    const at = titles.indexOf("핸드 복기");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(titles.slice(at, at + 3)).toEqual(["핸드 복기", "남의 핸드 기록", "지난 기록 보기"]);
    expect(html).not.toContain("정보 수집");
  });
});
