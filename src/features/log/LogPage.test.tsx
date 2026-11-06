import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { emptyHand, handLogStore, putAside, type LoggedHand } from "./handLog";
import { BlindRow } from "./inputs";
import { LogPage } from "./LogPage";

const noop = () => {};
/** renderToString puts <!-- --> between adjacent text nodes. */
const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const initial = handLogStore.get();
const put = (hands: LoggedHand[]) => handLogStore.set({ ...initial, hands });

afterEach(() => {
  handLogStore.set(initial);
});

describe("hand log first screen (react-dom/server)", () => {
  it("opens straight onto a new hand's table setup", () => {
    put([]);
    const html = render(<LogPage sub="" go={noop} />);
    const t = text(html);
    // the seven step tabs, the table step lit
    const tabs = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((x) => ["테이블", "핸드", "프리플랍", "플랍", "턴", "리버", "결과"].includes(x));
    expect(tabs).toEqual(["테이블", "핸드", "프리플랍", "플랍", "턴", "리버", "결과"]);
    expect(html).toMatch(/class="on"[^>]*aria-current="step"[^>]*>테이블</);
    expect(t).toContain("몇 인 테이블?");
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(t).toContain(`${n}인`);
    expect(t).toContain("내 포지션");
    expect(html).toContain("rt-table compact");
    expect(t).toContain("블라인드");
    expect(t).toContain("시작 스택");
    expect(t).toContain("다음: 내 핸드 →");
    expect(t).toContain("지난 핸드 ›");
    // nothing from the list in front of the table
    expect(t).not.toContain("빠른 메모");
    expect(t).not.toContain("백업");
    expect(t).not.toContain("이어서 기록");
  });

  it("offers to pick up a hand left mid-way on the setup's first line, not in a row of its own", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "mid", seat: "BTN", hole: parseCards("AdTd"), updatedAt: Date.now() - 60_000 };
    put([h]);
    const html = render(<LogPage sub="" go={noop} />);
    const t = text(html);
    expect(t).toContain("↺ 이어서");
    // suits carry U+FE0E so phones draw them as text, not emoji
    expect(t).toMatch(/↺ 이어서 BTN A♦\uFE0E ?T♦\uFE0E/);
    expect(html).toContain('aria-label="이어서 기록: BTN A♦T♦ · 프리플랍"');
    expect(t).toContain("지난 핸드 1개 ›");
    // same line as "몇 인 테이블?", before the tabs' content and with nothing above the tabs
    expect(html).toMatch(/<div class="flow-label">몇 인 테이블\?<span class="flow-aside"><button[^>]*class="log-resume"/);
    expect(html).not.toContain('class="log-top"');
  });

  it("does not offer a hand again after leaving it with ＋ 새 핸드", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "mid2", seat: "CO", hole: parseCards("KhKs"), updatedAt: Date.now() - 60_000 };
    put([h]);
    expect(text(render(<LogPage sub="" go={noop} />))).toContain("↺ 이어서");
    // what both "＋ 새 핸드" buttons (on the new-hand screen and on the hand's own screen) do before going to #log
    putAside("mid2");
    const t = text(render(<LogPage sub="" go={noop} />));
    expect(t).not.toContain("이어서");
    expect(t).toContain("지난 핸드 1개 ›");
  });

  it("keeps past hands, the quick memo and the backup behind 지난 핸드", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "old", seat: "CO", hole: parseCards("KhKs"), result: "win" };
    put([h]);
    const t = text(render(<LogPage sub="list" go={noop} />));
    expect(t).toContain("지난 핸드 1");
    expect(t).toContain("상대별 쇼다운");
    expect(t).toContain("＋ 새 핸드");
    expect(t).toContain("빠른 메모");
    expect(t).toContain("백업");
    expect(t).toContain("CO");
    expect(t).toContain("이김");
    // the quick memo starts folded once there are hands to list
    expect(t).toContain("카드·자리만 찍어 두고 나중에 이어서");
    expect(t).not.toContain("저장하고 테이블로 이어서");
    expect(render(<LogPage sub="list" go={noop} />)).toMatch(/class="log-memo-head" aria-expanded="false"/);
  });

  it("opens the quick memo when nothing is saved yet, with the table flow's inputs", () => {
    put([]);
    const out = render(<LogPage sub="list" go={noop} />);
    const t = text(out);
    expect(out).toMatch(/class="log-memo-head" aria-expanded="true"/);
    // 내 핸드: the card text field and its keypad, as on the 핸드 step
    expect(t).toContain("내 핸드");
    expect(out).toMatch(/<div class="cardtext-field "><input[^>]*placeholder="예\) AdTd"[^>]*inputMode="none"/);
    expect(out).toContain('class="cardkeys"');
    for (const k of "AKQJT98765432") expect(out).toContain(`<button type="button">${k}</button>`);
    // ...and no 52-card grid until 표 is tapped
    expect(out).not.toContain('class="picker"');
    expect(out.match(/class="pick /g)).toBeNull();
    // nothing grabs focus (the phone keyboard stays down)
    expect(out.toLowerCase()).not.toContain("autofocus");
    // one row of seats for the last table size, with the size as a small toggle
    expect(out).toContain('class="flow-chips one seats n9"');
    expect(out).toMatch(/class="memo-size"[^>]*>9인/);
    expect(t).toContain("내 포지션");
    // the setup's blinds row, the stack in chips, results as one-row chips, the note
    expect(out).toMatch(/class="flow-row"[^>]*><span>블라인드<\/span>/);
    expect(t).toContain("내 스택");
    expect(out).toMatch(/<div class="flow-chips one fill"><button[^>]*>이김<\/button><button[^>]*>짐<\/button><button[^>]*>찹<\/button><button[^>]*>폴드<\/button><\/div>/);
    expect(out).toContain("<textarea");
    // an empty memo can't be saved
    expect(out).toMatch(/<button type="button" class="flow-next" disabled="">저장<\/button>/);
    expect(out).toMatch(/<button type="button" class="ghost" disabled="">저장하고 테이블로 이어서 →<\/button>/);
    expect(t).toContain("카드 두 장이나 메모를 넣으면 저장할 수 있어요");
    // the old inputs are gone
    expect(out).not.toContain("seat-chips");
    expect(out).not.toContain("log-form");
  });

  it("lays the memo's seats out for the last table size and level used", () => {
    handLogStore.set({ ...initial, hands: [], lastPlayers: 6, lastLevel: 6 });
    const out = render(<LogPage sub="list" go={noop} />);
    expect(out).toContain('class="flow-chips one seats n6"');
    expect(out).toMatch(/class="memo-size"[^>]*>6인/);
    expect(text(out)).toContain("Lv6 · 400/800");
    expect(text(out)).toContain("BB 앤티 800");
  });

  it("names the blinds picker's no-level option for where the stack is typed", () => {
    const row = (unknownLabel?: string) => render(<BlindRow level={null} bbAnte={false} onLevel={noop} onAnte={noop} open onToggle={noop} unknownLabel={unknownLabel} />);
    // the setup asks for stacks in bb when the level is unknown
    expect(row()).toMatch(/<option value=""[^>]*>레벨 모름 \(bb로 입력\)<\/option>/);
    // the quick memo always takes chips
    expect(row("레벨 모름")).toMatch(/<option value=""[^>]*>레벨 모름<\/option>/);
    expect(row("레벨 모름")).not.toContain("bb로 입력");
  });

  it("still opens a saved hand and the showdowns by opponent", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "x1", seat: "SB", note: "SB 아재 림프" };
    put([h]);
    const savedHtml = render(<LogPage sub="x1" go={noop} />);
    const saved = text(savedHtml);
    expect(saved).toContain("‹ 지난 핸드");
    expect(saved).toContain("SB");
    expect(saved).toContain("다음: 프리플랍 →"); // seat in, no cards yet: opens on the hand step
    expect(savedHtml).toMatch(/class="on"[^>]*aria-current="step"[^>]*>핸드</);
    const players = text(render(<LogPage sub="players" go={noop} />));
    expect(players).toContain("아직 쇼다운 기록이 없어요");
    const missing = text(render(<LogPage sub="gone-123" go={noop} />));
    expect(missing).toContain("이 기록을 찾을 수 없어요");
  });
});
