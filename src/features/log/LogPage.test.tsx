import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCards } from "../../poker/cards";
import { emptyHand, handLogStore, localDay, putAside, type LoggedHand } from "./handLog";
import { bbText, CardText, LevelRow } from "./inputs";
import { ListView, LogPage } from "./LogPage";
import { BoardRanks, HoleEntry } from "./SuitEntry";
import { fastHand, fastOtherStore, fastStore, newDraft, pickRes, pickSuited, startEdit, tapRank, withFastResult, type FastDraft } from "./fastLog";

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

describe("핸드 복기: the hand first (react-dom/server)", () => {
  it("opens on the hand step: the card keypad first, 수트 입력 | 수딧·오프만, the save line and the two ways on", () => {
    put([]);
    const html = page("");
    const t = text(html);
    expect(tabsOf(html)).toEqual(["핸드", "테이블", "프리플랍", "플랍", "턴", "리버", "결과"]);
    expect(lit(html)).toBe("핸드");
    // the first line: the label and, at its right end, the past-hands link (no quick-record pill any more)
    expect(html).toMatch(/<div class="flow-label">내 핸드<span class="flow-aside"><button type="button" class="log-link" aria-label="지난 기록">지난<span class="ll-word"> 기록<\/span> ›<\/button><\/span><\/div>/);
    expect(html).not.toContain("log-quick");
    expect(t).not.toContain("빠른");
    // the keypad right under it, then how the cards go in: 수트 입력 (lit) or 수딧·오프만
    const order = ['class="cardtext-field', 'class="cardkeys"', 'class="seg small suit-toggle"', 'class="save-line idle"', 'class="flow-next"', 'class="flow-later"'].map((x) => html.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const k of "AKQJT98765432") expect(html).toContain(`<button type="button">${k}</button>`);
    expect(html).toContain('<div class="seg small suit-toggle" role="group" aria-label="카드 입력 방식"><button type="button" class="on" aria-pressed="true">수트 입력</button><button type="button" class="" aria-pressed="false">수딧·오프만</button></div>');
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

describe("수딧·오프만 / 숫자만 entry (react-dom/server)", () => {
  it("shows guessed hole cards by their ranks and class, the remembered kind lit, tap to fix", () => {
    const html = render(<HoleEntry h={{ hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited" }} taken={[]} onChange={noop} />);
    expect(html).toMatch(/<button type="button" class="suitless-field ok" aria-label="수트 입력으로 바꾸기"><span class="sl-ranks">A T<\/span><b>ATs<\/b><small>수트 추정 · 눌러서 고치기<\/small><\/button>/);
    expect(html).toMatch(/<div class="kinds"><button type="button" class=" on">수딧<\/button><button type="button" class="">오프수트<\/button><button type="button" class="small">모름<\/button>/);
    // both ranks in: the rank keys rest
    expect(html).toMatch(/<button type="button" disabled="">A<\/button>/);
    expect(html).toContain('<div class="seg small suit-toggle" role="group" aria-label="카드 입력 방식"><button type="button" class="" aria-pressed="false">수트 입력</button><button type="button" class="on" aria-pressed="true">수딧·오프만</button></div>');
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
    expect(turn).toMatch(/<div class="kinds n2"><button type="button" disabled="">새 수트<\/button><button type="button" disabled="">플러시 수트<\/button>/);
  });
});

describe("card keypads: one rank pad, like 빠른 기록's (react-dom/server)", () => {
  /** The labels of a keypad's rank grid, and of the row under it. */
  const grid = (html: string, row: string) => [...(new RegExp(`<div class="${row}">(.*?)</div>`).exec(html)?.[1] ?? "").matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  const RANKS_AND_BACK = [..."AKQJT98765432", "⌫"];

  it("puts ⌫ after the 13 ranks in every card entry, the suits or what is remembered of them on the row below", () => {
    const exact = render(<CardText cards={[]} max={2} taken={[]} onChange={noop} />);
    expect(grid(exact, "ranks")).toEqual(RANKS_AND_BACK);
    expect(grid(exact, "suits")).toEqual(["♠s", "♥h", "♦d", "♣c"]);
    const hole = render(<HoleEntry h={{ hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited" }} taken={[]} onChange={noop} />);
    expect(grid(hole, "ranks")).toEqual(RANKS_AND_BACK);
    expect(grid(hole, "kinds")).toEqual(["수딧", "오프수트", "모름"]);
    const flop = render(<BoardRanks street="flop" board={[]} taken={[]} onFill={noop} />);
    expect(grid(flop, "ranks")).toEqual(RANKS_AND_BACK);
    expect(grid(flop, "kinds n3")).toEqual(["레인보우", "투톤", "모노톤"]);
  });

  it("rests ⌫ while there is nothing to erase", () => {
    const back = (html: string) => /<button type="button" class="back" aria-label="지우기"( disabled="")?>⌫<\/button>/.exec(html);
    expect(back(render(<CardText cards={[]} max={2} taken={[]} onChange={noop} />))?.[1]).toBe(' disabled=""');
    expect(back(render(<CardText cards={parseCards("Ad")} max={2} taken={[]} onChange={noop} />))?.[1]).toBeUndefined();
    expect(back(render(<BoardRanks street="turn" board={parseCards("Kh9h2d")} taken={[]} onFill={noop} />))?.[1]).toBe(' disabled=""');
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

  it("marks guessed suits on the table and offers 숫자만 for the board", () => {
    const h: LoggedHand = { ...emptyHand(9), id: "f1", seat: "BTN", hole: parseCards("AsTs"), guess: { hole: true }, holeKind: "suited", stack: 32000, steps: [{ s: "UTG", k: "fold" }, { s: "UTG+1", k: "fold" }, { s: "UTG+2", k: "fold" }, { s: "LJ", k: "fold" }, { s: "HJ", k: "fold" }, { s: "CO", k: "fold" }, { s: "BTN", k: "raise", to: 2.2 }, { s: "SB", k: "fold" }, { s: "BB", k: "call" }] };
    put([h]);
    const html = page("f1");
    expect(lit(html)).toBe("플랍");
    expect(html).toContain('<div class="flow-guess"><span>핸드 수트 추정</span></div>');
    expect(html).toMatch(/class="rt-card s-s small  guess"/);
    expect(html).toContain('<div class="seg small suit-toggle" role="group" aria-label="카드 입력 방식"><button type="button" class="on" aria-pressed="true">수트 입력</button><button type="button" class="" aria-pressed="false">숫자만</button></div>');
    expect(text(html)).toContain("나중에 작성하기");
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
    expect(html).toMatch(/<button class="log-row other"><span class="log-row-main"><span class="log-kind" aria-label="남의 핸드">남<\/span><b class="log-seat">CO<\/b><b class="log-class">K9s<\/b><span class="log-end"><span class="log-tag soft">수트 추정<\/span><\/span><\/span><span class="log-pre small">미들 · CO 오픈 2.5bb<\/span>/);
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
    expect(text(page("list/other"))).toContain("아직 남의 핸드가 없어요.");
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

describe("빠른 기록 (react-dom/server)", () => {
  const R = (k: string) => "23456789TJQKA".indexOf(k);
  const typed = (seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft => {
    let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
    if (cls[2]) d = pickSuited(d, cls[2] === "s");
    return { ...d, ...extra };
  };
  const fast = (at: number, d: FastDraft, a: Parameters<typeof fastHand>[1]) => fastHand(d, a, { ...emptyHand(null), id: `f${at}`, createdAt: at, updatedAt: at }, "mid", 9)!;
  afterEach(() => {
    fastStore.set({});
  });

  it("is one screen: the stage and table size, my seat, the rank pad, the result, the board, and the action folded away", () => {
    put([], { lastStage: "mid" });
    fastStore.set({});
    const html = page("fast");
    const t = text(html);
    // the stage chips and the table size in the sticky bar
    expect(html).toMatch(/<div class="fast-bar"><div class="fast-stages" role="group" aria-label="스택 구간 \(차트\)"><button type="button" class="" aria-pressed="false">딥<\/button><button type="button" class="on" aria-pressed="true">미들<\/button>/);
    expect(html).toContain('aria-label="테이블 9인 · 인원 바꾸기"');
    // 내 핸드 | 남의 핸드 on the seat line; the button by default
    expect(html).toMatch(/<div class="fast-label">내 포지션 <b>BTN<\/b><div class="seg small fast-toggle" role="tablist" aria-label="빠른 기록"><button type="button" role="tab" aria-selected="true" class="on">내 핸드<\/button>/);
    expect(html).toMatch(/<div class="fast-row fast-seats n9">(<button type="button" class="">[^<]+<\/button>){6}<button type="button" class="on">BTN<\/button>/);
    // the pad: 13 ranks and ⌫; 수딧 / 오프수트 wait for two different ranks
    for (const k of "AKQJT98765432") expect(html).toContain(`<button type="button">${k}</button>`);
    expect(html).toMatch(/<button type="button" class="" disabled="">수딧<\/button><button type="button" class="" disabled="">오프수트<\/button>/);
    // 결과: the line with the level chip, then 폴드 · 잃음 · 땄음, waiting for the hand
    expect(html).toMatch(/<div class="fast-sec fast-res"><div class="fast-res-head"><span class="frh-label">결과<\/span><button type="button" class="fr-amt hint" disabled="">폴드 한 번, 아니면 금액<\/button><button type="button" class="fast-lv" aria-expanded="false" aria-label="블라인드 레벨 \? · 바꾸기">레벨 \? <i>▾<\/i><\/button><\/div>/);
    expect(html).toMatch(/<div class="fast-res-chips n3"><button type="button" class="r-fold" disabled=""><span>폴드<\/span><\/button><button type="button" class="r-lose" aria-pressed="false" disabled="">− 잃음<\/button><button type="button" class="r-win" aria-pressed="false" disabled="">\+ 땄음<\/button><\/div>/);
    // 보드: five empty slots and 지금 스택, waiting too
    expect(html).toMatch(/<button type="button" class="fb-slots" aria-label="보드 카드 \(기억나는 것만\)" disabled="">(<span class="fb-slot( turn)?">·<\/span>){5}<\/button><button type="button" class="fast-stack" disabled="">지금 스택<\/button>/);
    // the save slot says what to tap next; 액션도 기록 is folded away, with no spot or action rows
    expect(html).toContain('<div class="fast-result" role="status" aria-live="polite"><span class="fr-hint">랭크 두 개를 누르세요</span></div>');
    expect(html).toContain('<button type="button" class="fast-more" aria-expanded="false">액션도 기록 ▾ <small>차트대로 했는지 판정</small></button>');
    expect(html).not.toContain("fast-spots");
    expect(html).not.toContain("fast-acts");
    expect(t).toContain("아직 오늘 기록이 없어요");
    // no OS keyboard: no text field at all
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  it("shows the class as typed, the opener row facing an open, and the choices for it", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, actions: true, draft: typed("HJ", "K9s", { spot: "open", opener: "UTG" }) });
    const html = page("fast");
    expect(html).toMatch(/<span class="fast-class done" aria-live="polite">K9s<\/span>/);
    expect(html).toMatch(/<div class="fast-opener"><span class="fast-sub">오픈<br\/>자리<\/span><div class="fast-row fast-seats n4"><button type="button" class="on">UTG<\/button><button type="button" class="">UTG\+1<\/button><button type="button" class="">UTG\+2<\/button><button type="button" class="">LJ<\/button><\/div><\/div>/);
    expect(html).toMatch(/<div class="fast-acts n4"><button type="button" class="a-fold">폴드<\/button><button type="button" class="a-call">콜<\/button><button type="button" class="a-3bet">3벳<\/button><button type="button" class="a-allin">올인<\/button><\/div>/);
    expect(text(html)).toContain("누르면 바로 저장 · 다음 핸드는 LJ");
    // two ranks without suitedness: it asks
    fastStore.set({ stage: "mid", players: 9, actions: true, draft: typed("BTN", "AJ") });
    const ask = page("fast");
    expect(ask).toMatch(/<span class="fast-class" aria-live="polite">AJ<small>\?<\/small><\/span>/);
    expect(ask).toContain('<div class="fast-suits ask">');
    expect(text(ask)).toContain("수딧인지 오프수트인지 골라 주세요");
    // UTG: nothing can have happened before me but a 3-bet over my open
    fastStore.set({ stage: "mid", players: 9, actions: true, draft: typed("UTG", "AA") });
    expect(page("fast").match(/<button type="button" class="" disabled=""><span>/g)).toHaveLength(3);
    // the BB with nobody in: a walk
    fastStore.set({ stage: "mid", players: 9, actions: true, draft: typed("BB", "72o") });
    expect(page("fast")).toContain('<div class="fast-acts n1"><button type="button" class="a-walk">워크 (모두 폴드)</button></div>');
  });

  it("lists today's hands with their verdicts, overplays and underplays marked, and the counts", () => {
    const now = Date.now();
    put([
      fast(now - 60_000, typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call"),
      fast(now - 120_000, typed("LJ", "55"), "fold"),
      fast(now - 180_000, typed("CO", "72o"), "fold"),
      fast(now - 240_000, typed("BTN", "AJo"), "open"),
    ]);
    fastStore.set({ stage: "mid", players: 9, draft: newDraft("UTG+2") });
    const html = page("fast");
    expect(text(html)).toMatch(/차트대로 50% \(2\/4\) ⚠ 오버 1 ▽ 언더 1 △ 섞음 0/);
    expect(html.match(/class="fast-item /g)).toHaveLength(4);
    expect(html).toMatch(/class="fast-item v-over"><span class="fi-time">[^<]+<\/span><b class="fi-seat">HJ<\/b><b class="fi-class">K9s<\/b><span class="fi-act">UTG 오픈 → 콜<\/span><span class="fi-verdict">⚠ 오버 \(폴드\)<\/span>/);
    expect(html).toMatch(/class="fast-item v-under">.*?<b class="fi-class">55<\/b><span class="fi-act">폴드<\/span><span class="fi-verdict">▽ 언더 \(오픈\)<\/span>/);
    expect(html).toMatch(/class="fast-item v-ok">.*?<b class="fi-class">AJo<\/b><span class="fi-act">오픈<\/span><span class="fi-verdict">✓<\/span>/);
    expect(text(html)).toContain("오늘 요약 복사");
  });

  it("shows a hand being corrected with 삭제 and 취소, its action lit", () => {
    const h = fast(Date.now() - 60_000, typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call");
    put([h]);
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("LJ"), parked: null }, h));
    const html = page("fast");
    expect(text(html)).toMatch(/✎ 수정 중 \d\d:\d\d HJ K9s · 액션을 다시 누르면 저장 삭제 취소/);
    expect(html).toContain('<button type="button" class="a-call on">콜</button>');
    expect(text(html)).toContain("누르면 이 핸드를 고쳐서 저장해요");
  });

  it("shows in 지난 기록 with a 빠른 tag, the decision and the verdict", () => {
    put([fast(5, typed("HJ", "K9s", { spot: "open", opener: "UTG" }), "call")]);
    const html = page("list/mine");
    expect(html).toMatch(/<b class="log-seat">HJ<\/b><b class="log-class">K9s<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><\/span><\/span><span class="log-pre small">미들 · UTG 오픈 → 콜<\/span><span class="log-verdict small v-over">⚠ 오버플레이 \(차트: 폴드\)<\/span>/);
    // complete as it is: not 작성 중
    expect(html).not.toContain("log-continue");
    expect(text(html)).toContain("⚡ 빠른 기록");
  });

  it("has 남의 핸드 a tap away, and back", () => {
    put([]);
    expect(page("other")).toMatch(/<div class="seg small fast-toggle" role="tablist" aria-label="빠른 기록"><button type="button" role="tab" aria-selected="false" class="">내 핸드<\/button><button type="button" role="tab" aria-selected="true" class="on">남의 핸드<\/button><\/div>/);
  });
});

describe("빠른 기록 v2: the chip result and the board (react-dom/server)", () => {
  const R = (k: string) => "23456789TJQKA".indexOf(k);
  const typed = (seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft => {
    let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
    if (cls[2]) d = pickSuited(d, cls[2] === "s");
    return { ...d, ...extra };
  };
  /** A hand saved on the default screen (no decision) at Lv5, or with `act`. */
  const saved = (at: number, d: FastDraft, act: Parameters<typeof fastHand>[1] = null) =>
    withFastResult(fastHand(d, act, { ...emptyHand(null), id: `v${at}`, createdAt: at, updatedAt: at }, "mid", 9)!, d, { level: 5, guessed: false }, true)!;
  const lv5 = () => ({ levelPick: { level: 5, at: Date.now() } });
  const K72 = [{ r: R("K"), s: 1 }, { r: R("7") }, { r: R("2") }];
  afterEach(() => {
    fastStore.set({});
  });

  it("types the amount on the same keypad: digits, 칩 | bb under them, the line with its bb, 저장 with the next seat", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" } });
    const html = page("fast");
    expect(html).toContain('<div class="fast-pad digits"><button type="button" class="k-d">1</button><button type="button" class="k-d">2</button>');
    expect(html).toContain('<button type="button" class="k-d k-dd">00</button><button type="button" class="k-d k-dd">000</button><button type="button" class="k-d" disabled="">.</button><button type="button" class="fast-back k-d" aria-label="지우기">⌫</button></div>');
    expect(html).toContain('<div class="fast-suits unit" role="group" aria-label="단위"><button type="button" class="u-chips on" aria-pressed="true">칩</button><button type="button" class="u-bb" aria-pressed="false">bb</button></div>');
    expect(html).toContain('<button type="button" class="fr-amt on">+12,000 = +20bb</button>');
    expect(html).toContain('aria-label="블라인드 Lv5 300/600 · 바꾸기">Lv5 300/600 <i>▾</i></button>');
    expect(html).toContain('<button type="button" class="r-win on" aria-pressed="true">+ 땄음</button>');
    expect(html).toContain('<button type="button" class="fs-save">저장 · 다음 핸드 CO</button>');
    // the hand line takes the keypad back to the hand; the class stays exactly as it is
    expect(html).toContain('<div class="fast-label hand-line" role="button" tabindex="0">핸드');
    expect(html).toContain('<span class="fast-class done" aria-live="polite">AKs</span>');
    // in bb: "000" rests and the line shows the chips
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "20.5", unit: "bb" } });
    const bb = page("fast");
    expect(bb).toContain('<button type="button" class="k-d k-dd" disabled="">000</button>');
    expect(bb).toContain('<button type="button" class="fr-amt on">+20.5bb = +12,300</button>');
  });

  it("asks for the level for bb with none known, and for the sign for an amount without one", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb" } });
    const html = page("fast");
    expect(html).toContain("+20bb · 레벨을 골라 주세요");
    expect(html).toContain('class="fast-lv ask"');
    expect(html).toContain('<button type="button" class="fs-save" disabled="">bb로 넣으려면 레벨을 골라 주세요</button>');
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), amount: "12000", focus: "result" } });
    const sign = page("fast");
    expect(sign).toContain("12,000 · 땄어요? 잃었어요?");
    expect(sign).toContain('<button type="button" class="r-lose ask" aria-pressed="false">− 잃음</button>');
    expect(sign).toContain('<button type="button" class="fs-save plain" disabled="">땄어요? 잃었어요?</button>');
  });

  it("shows what a fold costs on its chip: the BB's blind and ante, the SB's blind, nothing before the blinds; the BB's walk", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("BB", "94o") });
    const bb = page("fast");
    expect(bb).toContain('<div class="fast-res-chips n4"><button type="button" class="r-fold"><span>폴드</span><small>−1,200</small></button><button type="button" class="r-walk"><span>워크</span><small>+300</small></button>');
    expect(bb).toContain('<button type="button" class="fs-save plain">결과 없이 저장 · 다음 SB</button>');
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("SB", "T4o") });
    expect(page("fast")).toContain('<button type="button" class="r-fold"><span>폴드</span><small>−300</small></button>');
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("BTN", "72o") });
    expect(page("fast")).toContain('<button type="button" class="r-fold"><span>폴드</span></button><button type="button" class="r-lose"');
    // in bb, and without a level
    fastStore.set({ stage: "mid", players: 9, unit: "bb", ...lv5(), draft: { ...typed("BB", "94o"), unit: "bb" } });
    expect(page("fast")).toContain("<span>폴드</span><small>−2bb</small>");
    fastStore.set({ stage: "mid", players: 9, draft: typed("BB", "94o") });
    expect(page("fast")).toContain("<span>폴드</span><small>블라인드</small>");
  });

  it("types the board on the rank pad, the last card's suit on the row under it", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), board: [{ r: R("K"), s: 1 }], focus: "board" } });
    const one = page("fast");
    expect(one).toContain('<div class="fast-pad board"><button type="button" class="k-b">A</button>');
    expect(one).toContain('<div class="fast-suits suit4" role="group" aria-label="마지막 카드 수트 (기억나면)"><button type="button" class="s-s" aria-pressed="false">♠</button><button type="button" class="s-h on" aria-pressed="true">♥</button>');
    expect(one).toContain('<button type="button" class="fb-slots on" aria-label="보드 K♥ (기억나는 것만)"><span class="fb-slot set"><span class="s-h">K♥</span></span>');
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), board: K72, stackNow: "64200", focus: "board" } });
    const three = page("fast");
    expect(three).not.toContain('class="s-h on"');
    expect(three).toContain('<span class="fb-slot set"><span class="nos">7</span></span><span class="fb-slot set"><span class="nos">2</span></span><span class="fb-slot turn">·</span>');
    expect(three).toContain('<button type="button" class="fast-stack set"><span>스택 64,200</span><small>107bb</small></button>');
    // four of a rank counting the class: that key rests
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "KK"), board: [{ r: R("K") }, { r: R("K") }], focus: "board" } });
    expect(page("fast")).toContain('<button type="button" class="k-b" disabled="">K</button>');
  });

  it("lists today's hands with their chips and board, the total and the graph; the chart line only for hands with a decision", () => {
    const now = Date.now();
    put([
      saved(now - 60_000, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: K72 }),
      saved(now - 120_000, pickRes(typed("SB", "T4o"), "fold")),
      saved(now - 180_000, pickRes(typed("CO", "72o"), "fold")),
      saved(now - 240_000, { ...pickRes(typed("HJ", "QJs"), "-"), amount: "4800" }),
    ]);
    fastStore.set({ stage: "mid", players: 9, draft: newDraft("CO") });
    const html = page("fast");
    expect(text(html)).toContain("오늘 빠른 기록 4핸드");
    expect(html).toMatch(/<button type="button" class="fast-item res v-none"><span class="fi-time">[^<]+<\/span><b class="fi-seat">BTN<\/b><b class="fi-class">AKs<\/b><span class="fi-net up">\+12,000<\/span><span class="fi-board"><span class="s-h">K♥<\/span><span class="nos">7<\/span><span class="nos">2<\/span><\/span><\/button>/);
    expect(html).toMatch(/<b class="fi-seat">SB<\/b><b class="fi-class">T4o<\/b><span class="fi-net down">−300<\/span><span class="fi-board"><\/span>/);
    expect(html).toMatch(/<b class="fi-seat">CO<\/b><b class="fi-class">72o<\/b><span class="fi-net">폴드<\/span>/);
    expect(html).toContain('<b class="fm-total up">+6,900</b><span class="fm-sub">+11.5bb</span>');
    // oldest first: −4,800, a fold, −300, +12,000
    expect(html).toMatch(/<svg class="chip-graph" viewBox="0 0 320 96" role="img" aria-label="오늘 칩 흐름: 0에서 지금 \+6,900, 최고 \+6,900, 최저 −5,100"/);
    expect(text(html)).toContain("0에서 · 최고 +6,900 · 최저 −5,100");
    expect(html).not.toContain("fast-stats");
    // in bb
    fastStore.set({ stage: "mid", players: 9, view: "bb", draft: newDraft("CO") });
    const bb = page("fast");
    expect(bb).toContain('<span class="fi-net up">+20bb</span>');
    expect(bb).toContain('<b class="fm-total up">+11.5bb</b><span class="fm-sub">+6,900</span>');
    // with old hands only (no chips on file): no graph, today's rows and the chart line
    put([fastHand(typed("BTN", "AJo"), "open", { ...emptyHand(null), id: "old", createdAt: now - 60_000, updatedAt: now - 60_000 }, "mid", 9)!]);
    const old = page("fast");
    expect(old).toContain("결과를 넣으면 오늘 칩 흐름이 그래프로 보여요");
    expect(old).not.toContain("<svg");
    expect(old).toContain("fast-stats");
    expect(old).toMatch(/class="fast-item v-ok">.*?<b class="fi-class">AJo<\/b><span class="fi-act">오픈<\/span><span class="fi-verdict">✓<\/span>/);
  });

  it("shows a hand saved without a decision in 지난 기록 with its chips and board, nothing to grade", () => {
    put([saved(5, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: K72 })]);
    const html = page("list/mine");
    expect(html).toMatch(/<b class="log-seat">BTN<\/b><b class="log-class">AKs<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><span class="log-result win">\+12,000<\/span><\/span><\/span><span class="log-pre small">\+12,000 \(\+20bb\) · 보드 K♥ 7 2<\/span><span class="muted small">/);
    expect(html).not.toContain("log-verdict");
    expect(html).not.toContain("자세히");
    expect(html).not.toContain("log-continue");
  });

  it("corrects a hand saved without a decision on the same screen: 고친 뒤 저장을 누르세요, 고쳐서 저장", () => {
    const h = saved(Date.now() - 60_000, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: K72 });
    put([h]);
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("CO"), parked: null }, h));
    const html = page("fast");
    expect(text(html)).toMatch(/✎ 수정 중 \d\d:\d\d BTN AKs · 고친 뒤 저장을 누르세요 삭제 취소/);
    expect(html).toContain('<button type="button" class="fs-save">고쳐서 저장</button>');
    expect(html).toContain("+12,000 = +20bb");
    expect(html).toContain('<span class="fb-slot set"><span class="s-h">K♥</span></span>');
    expect(html).toContain('<button type="button" class="fast-more" aria-expanded="false">');
  });

  it("shows the level the hand goes in at: the start time's estimate dashed, a pick gone stale in gold, none as 레벨 ?", () => {
    // 22:05 with a 19:00 start: Lv9, from the clock
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NIGHT);
    try {
      put([], { startClock: START });
      fastStore.set({ stage: "mid", players: 9, draft: typed("BB", "AKs") });
      const est = page("fast");
      expect(est).toContain('<button type="button" class="fast-lv est" aria-expanded="false" aria-label="블라인드 Lv9 800/1,600 (추정) · 바꾸기">Lv9 800/1,600 <i>▾</i></button>');
      expect(est).toContain("<span>폴드</span><small>−3,200</small>");
    } finally {
      vi.useRealTimers();
    }
    put([]);
    fastStore.set({ stage: "mid", players: 9, levelPick: { level: 5, at: Date.now() - 25 * 60_000 }, draft: typed("BTN", "AKs") });
    expect(page("fast")).toContain('class="fast-lv stale"');
    fastStore.set({ stage: "mid", players: 9, levelPick: { level: 5, at: Date.now() - 5 * 60_000 }, draft: typed("BTN", "AKs") });
    expect(page("fast")).toContain('class="fast-lv"');
    // a level left from an earlier day isn't taken: 레벨 ?
    put([], { lastLevel: 12 });
    fastStore.set({ stage: "mid", players: 9, draft: typed("SB", "AKs") });
    const none = page("fast");
    expect(none).toContain(">레벨 ? <i>▾</i></button>");
    expect(none).toContain("<span>폴드</span><small>블라인드</small>");
  });

  it("opens 액션도 기록 as it was left: the spot and action rows, the signs kept with the result", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, actions: true, ...lv5(), draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" } });
    const html = page("fast");
    expect(html).toContain('<div class="fast-res-chips n2"><button type="button" class="r-lose" aria-pressed="false">− 잃음</button>');
    expect(html).not.toContain("r-fold");
    expect(html).toContain('<button type="button" class="fast-more open" aria-expanded="true">액션 접기 ▴</button>');
    expect(html).toContain("fast-spots");
    expect(html).toContain('<div class="fast-acts n4"><button type="button" class="a-fold">폴드</button>');
    expect(text(html)).toContain("누르면 바로 저장 · 다음 핸드는 CO");
    expect(html).not.toContain("fs-save");
  });
});

describe("남의 핸드: 빠른 기록 for other players' hands (react-dom/server)", () => {
  const R = (k: string) => "23456789TJQKA".indexOf(k);
  const typed = (seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft => {
    let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
    if (cls[2]) d = pickSuited(d, cls[2] === "s");
    return { ...d, ...extra };
  };
  const theirs = (at: number, d: FastDraft, a: Parameters<typeof fastHand>[1]) => fastHand(d, a, { ...emptyHand(null, "other"), id: `o${at}`, createdAt: at, updatedAt: at }, "mid", 9, "other")!;
  const mine = (at: number, d: FastDraft, a: Parameters<typeof fastHand>[1]) => fastHand(d, a, { ...emptyHand(null), id: `f${at}`, createdAt: at, updatedAt: at }, "mid", 9)!;
  afterEach(() => {
    fastStore.set({});
    fastOtherStore.set({});
  });

  it("is the 빠른 기록 screen: their seat, the pad, what happened before them, their action", () => {
    put([], { lastStage: "mid" });
    const html = page("other");
    const t = text(html);
    // the same bar, pad and chips as 빠른 기록
    expect(html).toContain('<div class="fast-bar"><div class="fast-stages" role="group" aria-label="스택 구간 (차트)">');
    for (const k of "AKQJT98765432") expect(html).toContain(`<button type="button">${k}</button>`);
    // their seat, 남의 핸드 lit in the toggle
    expect(html).toMatch(/<div class="fast-label">상대 포지션 <b>BTN<\/b><div class="seg small fast-toggle" role="tablist" aria-label="빠른 기록"><button type="button" role="tab" aria-selected="false" class="">내 핸드<\/button><button type="button" role="tab" aria-selected="true" class="on">남의 핸드<\/button><\/div>/);
    // what happened before them, worded from their side
    expect(html).toContain('<div class="fast-label">상황<small>상대 앞에서</small></div>');
    expect(html).toMatch(/<button type="button" class="on"><span>폴드로<\/span><span>상대에게<\/span><\/button>/);
    expect(t).not.toContain("나에게");
    expect(html).toMatch(/<div class="fast-label">상대 액션<\/div><div class="fast-acts n4"><button type="button" class="a-fold" disabled="">폴드<\/button>/);
    expect(t).toContain("오늘 남의 핸드");
    expect(t).toContain("아직 오늘 남의 핸드가 없어요");
    // the old entry screen is gone: no preflop block, no card keyboard, no text fields
    expect(html).not.toContain("pre-acts");
    expect(html).not.toContain("quick-status");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  it("keeps the seat for the next hand, and asks 상대 오픈에 3벳 facing a 3-bet", () => {
    put([]);
    fastOtherStore.set({ stage: "mid", players: 9, draft: typed("CO", "AKs") });
    expect(text(page("other"))).toContain("누르면 바로 저장 · 자리는 CO 그대로");
    fastOtherStore.set({ stage: "mid", players: 9, draft: typed("CO", "AKs", { spot: "3bet" }) });
    expect(page("other")).toMatch(/<button type="button" class="on">상대 오픈에 3벳<\/button><button type="button" class="">남끼리 오픈·3벳<\/button>/);
    // 빠른 기록's own hand isn't here
    fastStore.set({ stage: "mid", players: 9, draft: typed("HJ", "QQ") });
    fastOtherStore.set({});
    expect(page("other")).toMatch(/<span class="fast-class" aria-live="polite">—<\/span>/);
  });

  it("lists today's other hands only, judged as how they play: 루즈 / 타이트", () => {
    const now = Date.now();
    put([
      mine(now - 30_000, typed("CO", "AJo"), "open"),
      theirs(now - 60_000, typed("BB", "72o", { spot: "open", opener: "CO" }), "call"),
      theirs(now - 120_000, typed("BTN", "K9o"), "open"),
      theirs(now - 180_000, typed("CO", "AQo"), "limp"),
    ]);
    const html = page("other");
    const t = text(html);
    expect(t).toMatch(/오늘 남의 핸드 3핸드/);
    expect(t).toMatch(/차트대로 33% \(1\/3\) ⚠ 루즈 1 ▽ 타이트 1 △ 섞음 0/);
    expect(html.match(/class="fast-item /g)).toHaveLength(3);
    expect(html).toMatch(/class="fast-item v-over"><span class="fi-time">[^<]+<\/span><b class="fi-seat">BB<\/b><b class="fi-class">72o<\/b><span class="fi-act">CO 오픈 → 콜<\/span><span class="fi-verdict">⚠ 루즈 \(폴드\)<\/span>/);
    expect(html).toMatch(/class="fast-item v-under">.*?<b class="fi-class">AQo<\/b><span class="fi-act">림프<\/span><span class="fi-verdict">▽ 타이트 \(오픈\)<\/span>/);
    expect(t).toContain("핸드를 누르면 고치거나 지울 수 있어요");
    expect(t).not.toContain("AJo");
    // and 빠른 기록 doesn't list theirs
    const fast = page("fast");
    expect(fast.match(/class="fast-item /g)).toHaveLength(1);
    expect(text(fast)).toContain("오늘 빠른 기록 1핸드");
  });

  it("corrects one of theirs with 삭제 and 취소", () => {
    const h = theirs(Date.now() - 60_000, typed("BB", "72o", { spot: "open", opener: "CO" }), "call");
    put([h]);
    fastOtherStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("BTN"), parked: null }, h, "other"));
    const html = page("other");
    expect(text(html)).toMatch(/✎ 수정 중 \d\d:\d\d BB 72o · 액션을 다시 누르면 저장 삭제 취소/);
    expect(html).toContain('<button type="button" class="a-call on">콜</button>');
  });

  it("shows in 지난 기록 › 남의 핸드 with the 남 badge, a 빠른 tag and their verdict", () => {
    put([theirs(5, typed("BB", "72o", { spot: "open", opener: "CO" }), "call")]);
    const html = page("list/other");
    expect(html).toMatch(/<button class="log-row other"><span class="log-row-main"><span class="log-kind" aria-label="남의 핸드">남<\/span><b class="log-seat">BB<\/b><b class="log-class">72o<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><\/span><\/span><span class="log-pre small">미들 · CO 오픈 → 콜<\/span><span class="log-verdict small v-over">⚠ 차트보다 루즈 \(차트: 폴드\)<\/span>/);
    expect(html).not.toContain("log-continue");
  });
});

describe("지난 기록 편집: picking hands to delete (react-dom/server)", () => {
  const hs: LoggedHand[] = [
    { ...emptyHand(6), id: "h3", seat: "CO", hole: parseCards("KhKs"), result: "win", createdAt: 3 },
    { ...emptyHand(6), id: "h2", kind: "other", seat: "BTN", hole: parseCards("Kh9h"), result: "lose", createdAt: 2 },
    { ...emptyHand(6), id: "h1", seat: "BB", hole: parseCards("AsTs"), result: "fold", createdAt: 1 },
  ];

  it("has 편집 at the end of the list's top row, rows that open their hand", () => {
    put(hs);
    const html = page("list");
    expect(html).toMatch(/<div class="log-new-row">.*<button type="button" class="log-edit-btn">편집<\/button><\/div>/);
    expect(html).not.toContain("log-check");
    expect(html).not.toContain("log-pick-bar");
    put([]);
    expect(page("list")).not.toContain("log-edit-btn");
  });

  it("turns rows into picks with a check at the left, and a bar: 전체 선택, how many, 선택 삭제", () => {
    put(hs);
    const html = render(<ListView tab="all" hands={hs} go={noop} startPicking startPicks={["h2", "gone"]} />);
    const t = text(html);
    // the top row: what to do, and 완료 (no ways to new hands while picking)
    expect(html).toMatch(/<div class="log-new-row log-picking-head"><span class="log-pick-title">지울 기록을 골라 주세요<\/span><button type="button" class="log-edit-btn on">완료<\/button><\/div>/);
    expect(t).not.toContain("＋ 새 기록");
    // each row a checkbox, the picked one checked and marked
    expect(html.match(/role="checkbox"/g)).toHaveLength(3);
    expect(html).toMatch(/<button class="log-row other picking picked" role="checkbox" aria-checked="true"><span class="log-check" aria-hidden="true">✓<\/span><span class="log-row-main">/);
    expect(html).toMatch(/<button class="log-row picking" role="checkbox" aria-checked="false"><span class="log-check" aria-hidden="true"><\/span><span class="log-row-main"><b class="log-seat">CO<\/b>/);
    // a pick no longer on file doesn't count
    expect(html).toMatch(/<div class="log-pick-bar" role="toolbar" aria-label="선택한 기록"><button type="button" class="ghost">전체 선택<\/button><span class="log-pick-n" aria-live="polite">1개 선택<\/span><button type="button" class="log-pick-del">선택 삭제<\/button><\/div>/);
    // all picked: 전체 해제; none: 선택 삭제 waits
    expect(render(<ListView tab="all" hands={hs} go={noop} startPicking startPicks={["h1", "h2", "h3"]} />)).toContain('<button type="button" class="ghost">전체 해제</button><span class="log-pick-n" aria-live="polite">3개 선택</span>');
    expect(render(<ListView tab="all" hands={hs} go={noop} startPicking />)).toContain('<button type="button" class="log-pick-del" disabled="">선택 삭제</button>');
    // not picking: picks given are ignored
    expect(render(<ListView tab="all" hands={hs} go={noop} startPicks={["h2"]} />)).not.toContain("picked");
  });
});
