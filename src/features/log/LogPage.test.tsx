import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { parseCards } from "../../poker/cards";
import { emptyHand, handLogStore, localDay, putAside, type LoggedHand } from "./handLog";
import { bbText, LevelRow } from "./inputs";
import { LogPage } from "./LogPage";
import { BoardRanks, HoleEntry } from "./SuitEntry";

const noop = () => {};
/** renderToString puts <!-- --> between adjacent text nodes. */
const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const page = (sub: string) => render(<LogPage sub={sub} go={noop} />);
const initial = handLogStore.get();
const put = (hands: LoggedHand[], extra: Partial<typeof initial> = {}) => handLogStore.set({ ...initial, hands, ...extra });
const tabsOf = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((x) => ["테이블", "핸드", "프리플랍", "플랍", "턴", "리버", "결과"].includes(x));
const lit = (html: string) => /class="on"[^>]*aria-current="step"[^>]*>([^<]+)</.exec(html)?.[1];
/** 22:05 on a fixed day, and that day's 19:00 start: Lv9, 3 hours 5 minutes in. */
const NIGHT = new Date(2026, 10, 7, 22, 5).getTime();
const START = { day: localDay(NIGHT), clock: "19:00" };

afterEach(() => {
  handLogStore.set(initial);
});

describe("새 기록 작성: the hand first (react-dom/server)", () => {
  it("opens on the hand step: the card keypad first, 무늬 모름, the save line and the two ways on", () => {
    put([]);
    const html = page("");
    const t = text(html);
    expect(tabsOf(html)).toEqual(["핸드", "테이블", "프리플랍", "플랍", "턴", "리버", "결과"]);
    expect(lit(html)).toBe("핸드");
    // the first line: the label and, at its right end, the past-hands link (no quick-record pill any more)
    expect(html).toMatch(/<div class="flow-label">내 핸드<span class="flow-aside"><button type="button" class="log-link" aria-label="지난 기록">지난<span class="ll-word"> 기록<\/span> ›<\/button><\/span><\/div>/);
    expect(html).not.toContain("log-quick");
    expect(t).not.toContain("빠른");
    // the keypad right under it, then 무늬 모름
    const order = ['class="cardtext-field', 'class="cardkeys"', 'class="suit-toggle"', 'class="save-line idle"', 'class="flow-next"', 'class="flow-later"'].map((x) => html.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const k of "AKQJT98765432") expect(html).toContain(`<button type="button">${k}</button>`);
    expect(t).toContain("무늬 모름 수딧·오프수트만 기억나요");
    expect(t).toContain("카드 두 장이나 메모를 넣으면 바로 저장돼요");
    // nothing saved yet: neither way on is open; nothing grabs focus (the phone keyboard stays down)
    expect(html).toMatch(/<button type="button" class="flow-next" disabled="">다음: 테이블 →<\/button>/);
    expect(html).toMatch(/<button type="button" class="flow-later" disabled="">나중에 작성하기<\/button>/);
    expect(html.toLowerCase()).not.toContain("autofocus");
    // the table comes second
    expect(html).not.toContain("rt-table");
    expect(t).not.toContain("백업");
  });

  it("offers a hand left mid-way on the first line, and not again after ＋ 새 핸드", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "mid", seat: "BTN", hole: parseCards("AdTd"), updatedAt: Date.now() - 60_000 };
    put([h]);
    let html = page("");
    expect(text(html)).toMatch(/↺ 이어서 BTN A♦︎ ?T♦︎/);
    expect(html).toContain('aria-label="이어서 기록: BTN A♦T♦ · 프리플랍"');
    expect(html).toMatch(/<div class="flow-label">내 핸드<span class="flow-aside with-resume"><button type="button" class="log-resume has-cards"/);
    expect(html).toMatch(/<button type="button" class="log-link" aria-label="지난 기록 1개">지난<span class="ll-word"> 기록<\/span><span class="log-link-n"> 1<span class="ll-word">개<\/span><\/span> ›<\/button>/);
    expect(html).not.toContain('class="log-top"');
    putAside("mid");
    html = page("");
    expect(text(html)).not.toContain("이어서");
    expect(html).toContain('class="flow-aside"');
  });

  it("names a hand with guessed suits by its class in the resume pill", () => {
    const h: LoggedHand = { ...emptyHand(6), id: "g", hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited", updatedAt: Date.now() - 60_000 };
    put([h]);
    const html = page("");
    expect(html).toContain('aria-label="이어서 기록: ATs · 테이블"');
    expect(html).toMatch(/<span class="hole-text">ATs<\/span>/);
  });

  it("reopens a saved hand without cards on the hand step, saved and ready to leave for later", () => {
    put([{ ...emptyHand(6), id: "n1", note: "BB 아재 올인", updatedAt: Date.now() }]);
    const html = page("n1");
    expect(lit(html)).toBe("핸드");
    expect(html).toMatch(/<p class="save-line ok" aria-live="polite"><b>✓ 저장됐어요<\/b><span>지금 다 안 써도 지난 기록에서 이어서 작성할 수 있어요<\/span><\/p>/);
    expect(html).toMatch(/<button type="button" class="flow-later">나중에 작성하기<\/button>/);
    // a saved hand's own screen: back to the list, or a new hand
    expect(text(html)).toContain("‹ 지난 기록");
    expect(text(html)).toContain("＋ 새 핸드");
    expect(text(html)).toContain("자동 저장");
    expect(page("gone-123")).toContain("이 기록을 찾을 수 없어요");
  });
});

describe("무늬 모름 entry (react-dom/server)", () => {
  it("shows guessed hole cards by their ranks and class, the remembered kind lit, tap to fix", () => {
    const html = render(<HoleEntry h={{ hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited" }} taken={[]} onChange={noop} />);
    expect(html).toMatch(/<button type="button" class="suitless-field ok" aria-label="무늬 직접 입력으로 바꾸기"><span class="sl-ranks">A T<\/span><b>ATs<\/b><small>무늬 추정 · 눌러서 고치기<\/small><\/button>/);
    expect(html).toMatch(/<div class="kinds"><button type="button" class=" on">수딧<\/button><button type="button" class="">오프수트<\/button><button type="button" class="small">모름<\/button>/);
    // both ranks in: the rank keys rest
    expect(html).toMatch(/<button type="button" disabled="">A<\/button>/);
    expect(text(html)).toContain("무늬 알면 직접 입력");
  });

  it("skips 수딧/오프수트 for a pair", () => {
    const html = render(<HoleEntry h={{ hole: parseCards("7s7h"), guess: { hole: true } }} taken={[]} onChange={noop} />);
    expect(html).toContain("<b>77</b>");
    expect(html).toMatch(/<button type="button" class="" disabled="">수딧<\/button><button type="button" class="" disabled="">오프수트<\/button>/);
  });

  it("starts on the exact keypad for known cards", () => {
    const html = render(<HoleEntry h={{ hole: parseCards("AdTd") }} taken={[]} onChange={noop} />);
    expect(html).toMatch(/<input[^>]*value="AdTd"/);
    expect(html).toContain("ATs");
    expect(html).not.toContain("suitless");
  });

  it("asks a flop's texture after three ranks, a turn's suit after one", () => {
    const flop = render(<BoardRanks street="flop" board={[]} taken={[]} onFill={noop} />);
    expect(text(flop)).toContain("플랍 숫자 세 개");
    expect(flop).toMatch(/<div class="kinds n3"><button type="button" disabled="">레인보우<\/button><button type="button" disabled="">투톤<\/button><button type="button" disabled="">모노톤<\/button>/);
    const turn = render(<BoardRanks street="turn" board={parseCards("Kh9h2d")} taken={[]} onFill={noop} />);
    expect(text(turn)).toContain("턴 숫자 하나");
    expect(turn).toMatch(/<div class="kinds n2"><button type="button" disabled="">새 무늬<\/button><button type="button" disabled="">플러시 무늬<\/button>/);
  });
});

describe("테이블 step (react-dom/server)", () => {
  const cardsOnly = (over: Partial<LoggedHand> = {}): LoggedHand => ({ ...emptyHand(null), id: "t1", hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited", createdAt: NIGHT, updatedAt: NIGHT, ...over });

  it("comes second: table size, seat, the table, blinds, my stack, and the ways on", () => {
    put([cardsOnly()]);
    const html = page("t1");
    const t = text(html);
    expect(lit(html)).toBe("테이블");
    const order = ["몇 인 테이블?", "내 포지션", 'rt-table compact', "<span>블라인드</span>", "<span>내 스택</span>", "flow-next", "flow-later"].map((x) => html.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // my stack is typed in place
    expect(html).toMatch(/<label class="flow-row-box flow-row-in"><span>내 스택<\/span><input aria-label="내 스택 \(칩\)" inputMode="numeric"/);
    // no seat yet: not on to the preflop
    expect(html).toMatch(/<button type="button" class="flow-next" disabled="">다음: 프리플랍 →<\/button>/);
    // no start time today: the way to estimate a forgotten level
    expect(t).toContain("레벨이 기억 안 나면: 시작 시각으로 추정 ›");
  });

  it("shows the level the start time says for the hand's time", () => {
    put([cardsOnly({ level: 9, levelGuess: true })], { startClock: START });
    const html = page("t1");
    expect(html).toMatch(/<button type="button" class="flow-row-sub">⏱ Lv9 추정 · 19:00 시작 3시간 5분째<\/button>/);
    expect(text(html)).toContain("Lv9 · 800/1,600");
  });

  it("opens the blinds as a start time and every level by its blinds", () => {
    const row = (h: Partial<LoggedHand>) => render(<LevelRow h={{ id: "x", level: null, bbAnte: true, createdAt: NIGHT, ...h }} onLevel={noop} onAnte={noop} open onToggle={noop} />);
    put([]);
    let html = row({});
    expect(html).toMatch(/<form class="lv-clock"><span>레벨이 기억 안 나면: 시작 시각으로 추정<\/span><input type="time" aria-label="토너먼트 시작 시각" value="19:00"\/><button type="submit" class="ghost small">추정<\/button><\/form>/);
    // the blinds first, so 800/1,600 is found without knowing it is Lv9; 레벨 모름 at the start
    expect(html).toMatch(/<div class="lv-strip" role="listbox" aria-label="블라인드 고르기"><button type="button" role="option" aria-selected="true" class="on"><b>레벨 모름<\/b>/);
    expect(html).toContain("<b>800/1,600</b><small>Lv9</small>");
    expect(html).toContain("<b>200,000/400,000</b><small>Lv30</small>");
    // with today's start set: the estimate, and a way to take it
    put([], { startClock: START });
    html = row({ level: 8 });
    expect(text(html)).toContain("⏱ 19:00 시작 · Lv9 추정");
    expect(html).toMatch(/<button type="button" class="ghost small">Lv9로<\/button>/);
    expect(html).toContain('class=" est"><b>800/1,600</b><small>Lv9 추정</small>');
  });

  it("records another player's hand with their seat, my seat as an option, and their stack", () => {
    put([cardsOnly({ id: "o1", kind: "other", seat: "BTN", mySeat: "BB" })]);
    const html = page("o1");
    const t = text(html);
    expect(lit(html)).toBe("테이블");
    expect(t).toContain("상대 포지션 BTN");
    expect(t).toContain("내 자리 BB · 같은 테이블");
    expect(html).toContain("<span>상대 스택</span>");
    expect(html).toMatch(/<span class="me" data-m="me"[^>]*>상대<\/span>/);
    // my own seat carries its own quieter tag, once
    expect(html.match(/<span class="me mine" data-m="mine"[^>]*>나<\/span>/g)).toHaveLength(1);
    expect(t).toContain("＋ 남의 핸드");
    expect(html).toMatch(/<button type="button" class="flow-next">다음: 프리플랍 →<\/button>/);
  });
});

describe("프리플랍 and the board (react-dom/server)", () => {
  it("offers the stage's open sizes for the first open (20bb: 숏 → 2 / 2.2bb), tap the stage to change it", () => {
    put([{ ...emptyHand(9), id: "p1", seat: "UTG", hole: parseCards("AdTd"), stack: 32000 }]);
    const html = page("p1");
    expect(lit(html)).toBe("프리플랍");
    expect(html).toMatch(/<div class="flow-quick"><button type="button" class="stage" aria-label="스택 구간 숏 · 눌러서 바꾸기">숏<small>구간<\/small><\/button><button type="button">2bb<small>3,200<\/small><\/button><button type="button">2.2bb<small>3,520<\/small><\/button><button type="button">팟/);
  });

  it("follows the level's usual stage without a stack (Lv3: 딥 → 3 / 3.5 / 4bb)", () => {
    put([{ ...emptyHand(3), id: "p2", seat: "UTG", hole: parseCards("AdTd") }]);
    const html = page("p2");
    expect(html).toMatch(/>딥<small>구간<\/small><\/button><button type="button">3bb<small>1,200<\/small><\/button><button type="button">3.5bb<small>1,400<\/small><\/button><button type="button">4bb<small>1,600<\/small><\/button>/);
  });

  it("marks guessed suits on the table and offers 무늬 모름 for the board", () => {
    const h: LoggedHand = { ...emptyHand(9), id: "f1", seat: "BTN", hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited", stack: 32000, steps: [{ s: "UTG", k: "fold" }, { s: "UTG+1", k: "fold" }, { s: "UTG+2", k: "fold" }, { s: "LJ", k: "fold" }, { s: "HJ", k: "fold" }, { s: "CO", k: "fold" }, { s: "BTN", k: "raise", to: 2.2 }, { s: "SB", k: "fold" }, { s: "BB", k: "call" }] };
    put([h]);
    const html = page("f1");
    expect(lit(html)).toBe("플랍");
    expect(html).toContain('<div class="flow-guess"><span>핸드 무늬 추정</span></div>');
    expect(html).toMatch(/class="rt-card s-s small  guess"/);
    expect(text(html)).toContain("무늬 모름 숫자만 기억나요");
    expect(text(html)).toContain("나중에 작성하기");
  });
});

describe("남의 핸드 기록 (react-dom/server)", () => {
  it("is one quick screen: their seat, the preflop (no 폴드, with 올인 콜), their cards, result and note", () => {
    put([], { lastLevel: 6, lastPlayers: 9 });
    const html = page("other");
    const t = text(html);
    const order = ['class="flow-label">상대 포지션', 'class="flow-label">프리플랍', 'class="flow-label">상대 핸드', 'class="flow-label">결과', 'class="flow-label">메모'].map((x) => html.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(t).toContain("오픈 림프 콜 3벳 올인 올인 콜");
    expect(html).not.toMatch(/pre-acts">(<button[^>]*>[^<]*<\/button>)*<button[^>]*>폴드</);
    expect(html).toMatch(/<p class="quick-status idle" aria-live="polite">상대 카드 두 장이나 메모를 넣으면 바로 저장돼요<\/p>/);
    // the level and the table size as small toggles on the seat line
    expect(html).toMatch(/class="memo-size lv"[^>]*>Lv6 <i>▾<\/i><\/button><button type="button" class="memo-size"[^>]*>9인 <i>▾<\/i>/);
    expect(html).toContain('class="flow-chips one seats n9"');
    expect(t).toContain("무늬 모름 수딧·오프수트만 기억나요");
    // nothing saved yet
    expect(html).toMatch(/<button type="button" class="flow-next" disabled="">＋ 다음 핸드<\/button>/);
    expect(html).toMatch(/<button type="button" class="ghost" disabled="">테이블로 이어서 기록 →<\/button>/);
    expect(t).not.toContain("닉");
  });

  it("takes the stage from the level when their stack is unknown, else the last one used", () => {
    const stageLit = (html: string) => /<div class="flow-chips one pre-stage">.*?<button type="button" class="on">([^<]+)<\/button>/.exec(html)?.[1];
    // my last hand was short-stacked, but at Lv3 the table is usually deep: the open sizes follow
    put([], { lastLevel: 3, lastStage: "short" });
    expect(stageLit(page("other"))).toBe("딥");
    put([], { lastLevel: 18, lastStage: "deep" });
    expect(stageLit(page("other"))).toBe("숏");
    // no level: the last stage used
    put([{ ...emptyHand(null), id: "o3", kind: "other", seat: "CO", note: "x", updatedAt: Date.now() }], { lastStage: "push" });
    expect(stageLit(page("other/o3"))).toBe("푸시");
  });

  it("reopens a saved one with its open size by stage, and 올인 콜 with the shover's seat only", () => {
    const o: LoggedHand = { ...emptyHand(6), id: "o2", kind: "other", seat: "CO", hole: parseCards("Kh9h"), guess: { hole: true }, holeKind: "suited", quickPre: { stage: "mid", pinned: true, action: "open", openBb: 2.5 }, updatedAt: Date.now() };
    put([o]);
    let html = page("other/o2");
    expect(html).toMatch(/<button type="button" class="on">오픈<\/button>/);
    expect(html).toMatch(/<span class="pre-k">오픈<\/span><div class="flow-chips one pre-chips"><button type="button" class="">2.2bb<\/button><button type="button" class="on">2.5bb<\/button><button type="button" class="">3bb<\/button><button type="button">직접<\/button><\/div><small class="pre-amt">= 2,000<\/small>/);
    expect(html).toMatch(/<p class="quick-status ok" aria-live="polite"><b>✓ 저장됨 · /);
    expect(html).toMatch(/<button type="button" class="flow-next">＋ 다음 핸드<\/button>/);
    expect(html).toContain("<b>K9s</b>");
    put([{ ...o, seat: "BB", quickPre: { stage: "short", pinned: true, action: "call", openAllIn: true, openerSeat: "BTN" } }]);
    html = page("other/o2");
    expect(html).toMatch(/<button type="button" class="on">올인 콜<\/button>/);
    expect(html).not.toContain('<span class="pre-k">오픈</span>');
    expect(html).toMatch(/<span class="pre-k">자리<\/span>/);
  });
});

describe("지난 기록 보기 (react-dom/server)", () => {
  const mine: LoggedHand = { ...emptyHand(6), id: "m1", seat: "CO", hole: parseCards("KhKs"), result: "win", createdAt: 3 };
  const half: LoggedHand = { ...emptyHand(6), id: "m2", hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited", createdAt: 2 };
  const other: LoggedHand = { ...emptyHand(6), id: "o1", kind: "other", seat: "CO", hole: parseCards("Kh9h"), guess: { hole: true }, holeKind: "suited", quickPre: { stage: "mid", pinned: true, action: "open", openBb: 2.5 }, createdAt: 1 };

  it("splits mine and others' hands with counts, and keeps the showdowns by opponent as a view", () => {
    put([mine, half, other]);
    const html = page("list");
    expect(html).toMatch(/<div class="seg small log-tabs" role="tablist" aria-label="지난 기록"><button type="button" role="tab" aria-selected="true" class="on">전체<b>3<\/b><\/button><button type="button" role="tab" aria-selected="false" class="">내 핸드<b>2<\/b><\/button><button type="button" role="tab" aria-selected="false" class="">남의 핸드<b>1<\/b><\/button><button type="button" role="tab" aria-selected="false" class="" aria-label="상대별 쇼다운">쇼다운<\/button><\/div>/);
    expect(html.match(/class="log-row[ "]/g)).toHaveLength(3);
    expect(text(html)).toContain("＋ 새 기록");
    expect(text(html)).toContain("＋ 남의 핸드");
    expect(text(html)).toContain("백업");
    // only mine, only others'
    const mineHtml = page("list/mine");
    expect(mineHtml.match(/class="log-row[ "]/g)).toHaveLength(2);
    expect(mineHtml).not.toContain("log-kind");
    const otherHtml = page("list/other");
    expect(otherHtml.match(/class="log-row[ "]/g)).toHaveLength(1);
    expect(otherHtml).toContain("log-kind");
    expect(text(page("players"))).toContain("아직 쇼다운 기록이 없어요");
  });

  it("tags another player's hand, a hand recorded part of the way and guessed suits", () => {
    put([mine, half, other]);
    const html = page("list");
    // another player's: the 남 badge, their seat, the class, the preflop line; collected for its range
    // (cards, seat, what they did) it is complete as it is, not 작성 중
    expect(html).toMatch(/<button class="log-row other"><span class="log-row-main"><span class="log-kind" aria-label="남의 핸드">남<\/span><b class="log-seat">CO<\/b><b class="log-class">K9s<\/b><span class="log-end"><span class="log-tag soft">무늬 추정<\/span><\/span><\/span><span class="log-pre small">미들 · CO 오픈 2.5bb<\/span>/);
    // unfinished hands carry 이어서 작성; a finished one doesn't
    expect(html.match(/<span class="log-continue">이어서 작성 ›<\/span>/g)).toHaveLength(1);
    expect(html).toMatch(/<button class="log-row"><span class="log-row-main"><b class="log-seat">CO<\/b><span class="card-row">.*?<span class="log-end"><span class="log-result win">이김<\/span><\/span>/);
    // nothing in the list any more points at a quick screen
    expect(html).not.toContain("quick");
    expect(html).not.toContain("이어 쓰기");
  });

  it("says where to start on an empty tab", () => {
    put([]);
    expect(text(page("list"))).toContain("아직 기록이 없어요. ＋ 새 기록으로 기억나는 핸드부터 넣어 보세요.");
    expect(text(page("list/other"))).toContain("아직 남의 핸드 기록이 없어요.");
  });

  it("offers the old 정보 수집 data as a file while it is still stored", () => {
    put([]);
    expect(page("list")).not.toContain("이전 정보 수집 데이터 내보내기");
    const store = new Map<string, string>([["mygto.scout", '{"v":1,"active":null,"sessions":[]}']]);
    const g = globalThis as { localStorage?: unknown };
    const had = "localStorage" in g;
    const was = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    try {
      const html = page("list");
      expect(html).toContain("이전 정보 수집 데이터 내보내기");
      expect(text(html)).toContain("예전 정보 수집 기록은 남의 핸드로 옮겼어요");
    } finally {
      if (had) g.localStorage = was;
      else delete g.localStorage;
    }
  });

  it("lets a bb field take decimals as they are typed", () => {
    expect(bbText("2.")).toBe("2.");
    expect(bbText("2,5")).toBe("2.5");
    expect(bbText("2.5.1")).toBe("2.51");
    expect(bbText("a3 bb")).toBe("3");
  });
});
