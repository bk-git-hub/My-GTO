import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { newSession, renamePlayer, scoutStore, setButton, setMySeat, tapAct, type ScoutSession } from "./scout";
import { ScoutPage } from "./ScoutPage";

const initial = scoutStore.get();
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const put = (s: ScoutSession) => scoutStore.set({ v: 1, active: s.id, sessions: [s] });

afterEach(() => {
  scoutStore.set(initial);
});

describe("scout screen (react-dom/server)", () => {
  it("shows the hand in action order with one-tap buttons", () => {
    let s = setMySeat(setButton(newSession(9), 5), 3);
    s = renamePlayer(s, s.occ[7]!, "빨간모자");
    s = tapAct(s, s.occ[7]!, "L"); // seat 8 = UTG limps
    s = tapAct(s, s.occ[4]!, "R"); // seat 5 = BTN raises
    put(s);
    const html = renderToString(<ScoutPage />);
    const t = text(html);
    expect(t).toContain("핸드 #1");
    expect(t).toContain("9인 · 내 자리 3번 · 닉 1");
    // rows UTG … BB, the UTG row first with its nickname
    const pos = [...html.matchAll(/class="sc-pos">([^<]+)</g)].map((m) => m[1]);
    expect(pos).toEqual(["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(t).toMatch(/UTG 8 빨간모자 림프/);
    // behind the raise the limp button reads 콜; my row says 나
    expect(t).toMatch(/SB 6 6번 콜 레이즈 3벳\+ 올인/);
    expect(t).toMatch(/HJ 3 나/);
    expect(html).toMatch(/class="k-L on" aria-pressed="true"/);
    expect(t).toContain("다음 핸드 ▶");
    expect(t).toContain("참여 2명");
  });
});
