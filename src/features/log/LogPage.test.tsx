import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { emptyHand, handLogStore, putAside, type LoggedHand } from "./handLog";
import { bbText, BlindRow } from "./inputs";
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
    // quick record is one tap away, on the same first line (it doesn't push the table down)
    expect(html).toMatch(/<div class="flow-label">몇 인 테이블\?<span class="flow-aside"><button type="button" class="log-quick" aria-label="빠른 기록: 핸드만 먼저 찍어 두기">⚡ 빠른<span class="lq-word"> 기록<\/span><\/button><button[^>]*class="log-link"/);
    // nothing from the list in front of the table
    expect(t).not.toContain("빠른 메모");
    expect(t).not.toContain("백업");
    expect(t).not.toContain("이어서 기록");
    expect(html).not.toContain("cardkeys");
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
    // the past-hands link keeps its full name for screen readers; narrow screens show "지난 1 ›"
    expect(html).toMatch(/<button type="button" class="log-link" aria-label="지난 핸드 1개">지난<span class="ll-word"> 핸드<\/span><span class="log-link-n"> 1<span class="ll-word">개<\/span><\/span> ›<\/button>/);
    // same line as "몇 인 테이블?", after the quick pill, with nothing above the tabs
    expect(html).toMatch(/<div class="flow-label">몇 인 테이블\?<span class="flow-aside with-resume"><button[^>]*class="log-quick"[^>]*>⚡ 빠른<span class="lq-word"> 기록<\/span><\/button><button[^>]*class="log-resume has-cards"/);
    // the words that go first on narrow screens: "↺ A♦T♦"
    expect(html).toMatch(/<b>↺<span class="rs-word"> 이어서<\/span><\/b><span><span class="rs-seat">BTN <\/span><span class="hole-text">/);
    expect(html).not.toContain('class="log-top"');
  });

  it("marks long seat names in the resume pill, the part that goes first on small phones", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "utg", seat: "UTG+1", hole: parseCards("KhQh"), updatedAt: Date.now() - 60_000 };
    put([h]);
    const html = render(<LogPage sub="" go={noop} />);
    expect(html).toMatch(/<span class="rs-seat long">UTG\+1 <\/span><span class="hole-text">/);
    expect(html).toContain('aria-label="이어서 기록: UTG+1 K♥Q♥ · 프리플랍"');
  });

  it("offers a quick hand for resuming as a quick hand", () => {
    const q: LoggedHand = { ...emptyHand(6), id: "qq", quick: true, hole: parseCards("AdTd"), updatedAt: Date.now() - 60_000 };
    put([q]);
    const html = render(<LogPage sub="" go={noop} />);
    expect(html).toContain('aria-label="이어서 기록: A♦T♦ · 빠른 기록"');
    expect(text(html)).toMatch(/↺ 이어서 A♦\uFE0E ?T♦\uFE0E/);
  });

  it("does not offer a hand again after leaving it with ＋ 새 핸드", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "mid2", seat: "CO", hole: parseCards("KhKs"), updatedAt: Date.now() - 60_000 };
    put([h]);
    expect(text(render(<LogPage sub="" go={noop} />))).toContain("↺ 이어서");
    // what both "＋ 새 핸드" buttons (on the new-hand screen and on the hand's own screen) do before going to #log
    putAside("mid2");
    const html = render(<LogPage sub="" go={noop} />);
    expect(text(html)).not.toContain("이어서");
    expect(html).toContain('aria-label="지난 핸드 1개"');
    expect(html).toContain('class="flow-aside"');
  });

  it("keeps past hands, a way into quick record and the backup behind 지난 핸드", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "old", seat: "CO", hole: parseCards("KhKs"), result: "win" };
    put([h]);
    const html = render(<LogPage sub="list" go={noop} />);
    const t = text(html);
    expect(t).toContain("지난 핸드 1");
    expect(t).toContain("상대별 쇼다운");
    expect(t).toContain("＋ 새 핸드");
    expect(t).toContain("백업");
    expect(t).toContain("CO");
    expect(t).toContain("이김");
    // one line into the quick screen, not a second form
    expect(html).toMatch(/<button type="button" class="card-box log-quick-entry"><b>⚡ 빠른 기록<\/b><span class="muted small">핸드만 먼저 찍고 나중에 이어 쓰기<\/span><em>›<\/em><\/button>/);
    expect(html).not.toContain("cardkeys");
    expect(html).not.toContain("<textarea");
    expect(t).not.toContain("빠른 메모");
    // a hand recorded on the table carries no tag
    expect(html).not.toContain("log-tag");
  });

  it("tags quick hands in the list until they are carried on to the table", () => {
    const quick: LoggedHand = { ...emptyHand(6), id: "q", quick: true, hole: parseCards("AdTd"), createdAt: 3 };
    const played: LoggedHand = { ...emptyHand(6), id: "p", quick: true, seat: "BTN", hole: parseCards("KhKs"), steps: [{ s: "UTG", k: "fold" }], createdAt: 2 };
    const table: LoggedHand = { ...emptyHand(6), id: "t", seat: "CO", hole: parseCards("9h9c"), createdAt: 1 };
    put([quick, played, table]);
    const html = render(<LogPage sub="list" go={noop} />);
    expect(html.match(/<span class="log-tag">이어 쓰기<\/span>/g)).toHaveLength(1);
    expect(html).toMatch(/<span class="log-tag">이어 쓰기<\/span>/);
    // with nothing saved, the empty list points at both ways in
    put([]);
    expect(text(render(<LogPage sub="list" go={noop} />))).toContain("⚡ 빠른 기록으로 핸드만 먼저 찍어 두세요");
  });

  it("opens quick record with the hand first, on the table flow's inputs", () => {
    put([]);
    const out = render(<LogPage sub="quick" go={noop} />);
    expect(out).toContain('<h2 class="quick-title">⚡ 빠른 기록</h2>');
    // the status line says what saves it (there is no save button)
    expect(out).toMatch(/<p class="quick-status idle" aria-live="polite">카드 두 장이나 메모를 넣으면 바로 저장돼요<\/p>/);
    expect(out).not.toMatch(/>저장<\/button>/);
    // in this order: 내 핸드, 내 포지션, 블라인드, 내 스택, 결과, 메모
    const order = ['class="flow-label">내 핸드', 'class="flow-label">내 포지션', "<span>블라인드</span>", "<span>내 스택</span>", 'class="flow-label">결과', 'class="flow-label">메모'].map((x) => out.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the card field and its keypad come first, nothing else in between
    expect(out).toMatch(/<div class="quick-hand"><div class="flow-label">내 핸드 <\/div><div class="cardtext  "><div class="cardtext-field "><input[^>]*placeholder="예\) AdTd"[^>]*inputMode="none"[^>]*\/>/);
    expect(out).toContain('class="cardkeys"');
    for (const k of "AKQJT98765432") expect(out).toContain(`<button type="button">${k}</button>`);
    expect(out).not.toContain('class="picker"');
    // nothing grabs focus (the phone keyboard stays down)
    expect(out.toLowerCase()).not.toContain("autofocus");
    // one row of seats for the last table size, with the size as a small toggle
    expect(out).toContain('class="flow-chips one seats n9"');
    expect(out).toMatch(/class="memo-size"[^>]*>9인/);
    expect(out).toMatch(/class="flow-row"[^>]*><span>블라인드<\/span>/);
    expect(out).toMatch(/<div class="flow-chips one fill"><button[^>]*>이김<\/button><button[^>]*>짐<\/button><button[^>]*>찹<\/button><button[^>]*>폴드<\/button><\/div>/);
    expect(out).toContain("<textarea");
    // nothing saved yet: no next hand to move on to; the table is open either way
    expect(out).toMatch(/<button type="button" class="flow-next" disabled="">＋ 다음 핸드<\/button>/);
    expect(out).toMatch(/<button type="button" class="ghost">테이블로 이어서 기록 →<\/button>/);
  });

  it("lays the quick screen out for the last table size and level used", () => {
    handLogStore.set({ ...initial, hands: [], lastPlayers: 6, lastLevel: 6 });
    const out = render(<LogPage sub="quick" go={noop} />);
    expect(out).toContain('class="flow-chips one seats n6"');
    expect(out).toMatch(/class="memo-size"[^>]*>6인/);
    expect(text(out)).toContain("Lv6 · 400/800");
    expect(text(out)).toContain("BB 앤티 800");
  });

  it("reopens a saved quick hand on the quick screen, filled in", () => {
    const q: LoggedHand = { ...emptyHand(6), id: "q1", quick: true, seat: "BTN", hole: parseCards("AdTd"), stack: 32000, result: "lose", note: "BB 올인 콜" };
    put([q]);
    const out = render(<LogPage sub="quick/q1" go={noop} />);
    const t = text(out);
    expect(out).toContain("quick-title");
    expect(out).toMatch(/<div class="cardtext-field ok"><input[^>]*value="AdTd"/);
    expect(out).toMatch(/<div class="flow-label">내 핸드 <small>ATs<\/small><\/div>/);
    expect(out).toMatch(/<button type="button" class="on">BTN<\/button>/);
    expect(out).toMatch(/<button type="button" class="on">짐<\/button>/);
    expect(out).toContain('value="32,000"');
    expect(t).toContain("= 40bb");
    expect(out).toContain(">BB 올인 콜</textarea>");
    expect(out).toMatch(/<p class="quick-status ok" aria-live="polite"><b>✓ 저장됨 · (오전|오후) \d{1,2}:\d\d<\/b>/);
    expect(t).toContain("지난 핸드에서 이어 쓸 수 있어요");
    expect(out).toMatch(/<button type="button" class="flow-next">＋ 다음 핸드<\/button>/);
    expect(t).toContain("테이블로 이어서 기록 →");
  });

  it("reopens a quick hand kept without its cards (cleared to be typed again) with its seat and result", () => {
    const q: LoggedHand = { ...emptyHand(6), id: "q2", quick: true, seat: "CO", stack: 32000, result: "win", createdAt: 5, updatedAt: Date.now() };
    put([q]);
    const out = render(<LogPage sub="quick/q2" go={noop} />);
    expect(out).toContain("quick-title");
    expect(out).toMatch(/<div class="cardtext-field "><input[^>]*value=""/);
    expect(out).toMatch(/<button type="button" class="on">CO<\/button>/);
    expect(out).toMatch(/<button type="button" class="on">이김<\/button>/);
    expect(out).toMatch(/<p class="quick-status ok" aria-live="polite"><b>✓ 저장됨 · /);
    expect(out).toMatch(/<button type="button" class="flow-next">＋ 다음 핸드<\/button>/);
    // and in the list, among the hands to finish
    const list = render(<LogPage sub="list" go={noop} />);
    expect(list).toContain("카드 없음");
    expect(list).toMatch(/<span class="log-tag">이어 쓰기<\/span>/);
  });

  it("opens a hand recorded on the table in the table flow, even from a quick link", () => {
    const played: LoggedHand = { ...emptyHand(6), id: "p1", quick: true, seat: "BTN", hole: parseCards("AdTd"), steps: [{ s: "UTG", k: "fold" }] };
    put([played]);
    for (const sub of ["p1", "quick/p1"]) {
      const out = render(<LogPage sub={sub} go={noop} />);
      expect(out).not.toContain("quick-title");
      expect(text(out)).toContain("‹ 지난 핸드");
      expect(out).toMatch(/class="on"[^>]*aria-current="step"[^>]*>프리플랍</);
    }
    // a quick hand asked for by its plain id ("테이블로 이어서 기록 →") goes to the table too
    put([{ ...played, steps: [] }]);
    const out = render(<LogPage sub="p1" go={noop} />);
    expect(out).not.toContain("quick-title");
    expect(out).toMatch(/class="on"[^>]*aria-current="step"[^>]*>프리플랍</);
  });

  it("puts a compact preflop block right after 내 포지션, rows appearing with the action", () => {
    handLogStore.set({ ...initial, hands: [], lastPlayers: 9, lastLevel: 6, lastStage: "short" });
    const out = render(<LogPage sub="quick" go={noop} />);
    const order = ['class="flow-label">내 포지션', 'class="flow-label">프리플랍', "<span>블라인드</span>", "<span>내 스택</span>"].map((x) => out.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the stage on the label line: no stack yet, so the last stage used, not marked 자동
    expect(out).toMatch(/<div class="pre-head"><span class="flow-label">프리플랍<\/span><div class="flow-chips one pre-stage"><button[^>]*>딥<\/button><button[^>]*>미들<\/button><button type="button" class="on">숏<\/button><button[^>]*>푸시<\/button><\/div><span class="pre-auto"><\/span><\/div>/);
    // my action on one row; nothing else until one is picked
    expect(out).toMatch(/<div class="flow-chips one fill pre-acts">(<button type="button" class="">[^<]+<\/button>){6}<\/div>/);
    expect(text(out)).toContain("폴드 림프 오픈 콜 3벳 올인");
    expect(out).not.toContain('class="pre-line"');
  });

  it("shows the open, who opened and the chips it came to for a call", () => {
    const q: LoggedHand = { ...emptyHand(6), id: "qc", quick: true, seat: "BB", hole: parseCards("AdTd"), stack: 32000, quickPre: { stage: "mid", action: "call", openBb: 2.5, openerSeat: "CO" } };
    put([q]);
    const out = render(<LogPage sub="quick/qc" go={noop} />);
    // 40bb: mid, from the stack
    expect(out).toMatch(/<button type="button" class="on">미들<\/button>/);
    expect(out).toContain('<span class="pre-auto"><small title="내 스택으로 정해져요">자동</small></span>');
    expect(out).toMatch(/<button type="button" class="on">콜<\/button>/);
    expect(out).toMatch(/<span class="pre-k">오픈<\/span><div class="flow-chips one pre-chips"><button type="button" class="">2.2bb<\/button><button type="button" class="on">2.5bb<\/button><button type="button" class="">3bb<\/button><button type="button">직접<\/button><\/div><small class="pre-amt">= 2,000<\/small>/);
    // every seat but mine, the opener lit
    expect(out).toMatch(/<span class="pre-k">자리<\/span><div class="flow-chips one seats pre-seats n8">/);
    expect(out).toMatch(/<button type="button" class="on">CO<\/button>/);
    expect(out).not.toMatch(/pre-seats[^"]*">(<button[^>]*>[^<]*<\/button>)*<button[^>]*>BB<\/button>/);
    expect(out).not.toContain('<span class="pre-k">3벳</span>');
    // the list names it in one line
    const list = render(<LogPage sub="list" go={noop} />);
    expect(list).toContain('<span class="log-pre small">CO 2.5bb 오픈 → 콜</span>');
  });

  it("shows my 3-bet's size, a typed open size, and a pinned stage's way back to 자동", () => {
    const q: LoggedHand = { ...emptyHand(6), id: "q3", quick: true, seat: "SB", hole: parseCards("AhKh"), stack: 32000, quickPre: { stage: "deep", pinned: true, action: "3bet", openBb: 3, openerSeat: "BTN", threeBetX: 3.5 } };
    put([q]);
    const out = render(<LogPage sub="quick/q3" go={noop} />);
    // pinned to 딥 although 40bb says mid
    expect(out).toMatch(/<button type="button" class="on">딥<\/button>/);
    expect(out).toMatch(/<span class="pre-auto"><button type="button" aria-label="[^"]*">자동<\/button><\/span>/);
    expect(out).toMatch(/<button type="button" class="on">3bb<\/button>/);
    expect(out).toMatch(/<span class="pre-k">3벳<\/span><div class="flow-chips one pre-chips"><button type="button" class="">×3<\/button><button type="button" class="on">×3.5<\/button><button type="button" class="">×4<\/button><button type="button" class="">올인<\/button><\/div><small class="pre-amt">10.5bb = 8,400<\/small>/);
    // a size that isn't one of the stage's chips sits in the 직접 field
    put([{ ...q, quickPre: { stage: "mid", action: "open", openBb: 2.7 } }]);
    const typed = render(<LogPage sub="quick/q3" go={noop} />);
    expect(typed).toMatch(/<label class="pre-typed on"><input aria-label="오픈 크기 직접 입력 \(bb\)" inputMode="decimal"[^>]*value="2.7"/);
    expect(typed).toContain("= 2,160");
    expect(typed).not.toContain('class="pre-k">자리');
  });

  it("lets a bb field take decimals as they are typed", () => {
    expect(bbText("2.")).toBe("2.");
    expect(bbText("2,5")).toBe("2.5");
    expect(bbText("2.5.1")).toBe("2.51");
    expect(bbText("a3 bb")).toBe("3");
  });

  it("names the blinds picker's no-level option for where the stack is typed", () => {
    const row = (unknownLabel?: string) => render(<BlindRow level={null} bbAnte={false} onLevel={noop} onAnte={noop} open onToggle={noop} unknownLabel={unknownLabel} />);
    // the setup asks for stacks in bb when the level is unknown
    expect(row()).toMatch(/<option value=""[^>]*>레벨 모름 \(bb로 입력\)<\/option>/);
    // the quick screen always takes chips
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
