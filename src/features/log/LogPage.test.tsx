import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCards } from "../../poker/cards";
import { emptyHand, handLogStore, localDay, putAside, type LoggedHand } from "./handLog";
import { bbText, CardText, LevelRow } from "./inputs";
import { ListView, LogPage } from "./LogPage";
import { BoardRanks, HoleEntry } from "./SuitEntry";
import { fastHand, fastOtherStore, fastStore, newDraft, pickRes, pickSuited, startEdit, tapRank, withFastResult, type FastDraft } from "./fastLog";
import type { Tourney } from "./tourney";
import { ChipUpdateSheet, TourneySheet } from "./TourneySheet";
import { BlindsSheet } from "./CalcSheet";

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
    // 남의 핸드 is no longer recorded from here (the hands on file stay in their tab)
    expect(text(html)).not.toContain("＋ 남의 핸드");
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
    // the seat line: no 남의 핸드 toggle; no stack known yet, so nothing by the seat
    expect(html).toContain('<div class="fast-label seat-line">내 포지션 <b>BTN</b></div>');
    expect(html).toMatch(/<div class="fast-row fast-seats n9">(<button type="button" class="">[^<]+<\/button>){6}<button type="button" class="on">BTN<\/button>/);
    // the pad: 13 ranks and ⌫; 수딧 / 오프수트 wait for two different ranks
    for (const k of "AKQJT98765432") expect(html).toContain(`<button type="button">${k}</button>`);
    expect(html).toMatch(/<button type="button" class="" disabled="">수딧<\/button><button type="button" class="" disabled="">오프수트<\/button>/);
    // 결과: one row with the level chip (the calculator comes up once the class is in); no result chips, no board row
    expect(html).toContain('<div class="fast-resrow fast-under"><button type="button" class="rr-sum hint" disabled="">결과</button><button type="button" class="fast-lv" aria-expanded="false" aria-label="블라인드 레벨 ? · 바꾸기">레벨 ? <i>▾</i></button></div>');
    expect(html).not.toContain("fast-res-chips");
    expect(html).not.toContain("fb-slots");
    // no calculator before the class is in
    expect(html).toContain('<div class="fast"><div class="fast-bar">');
    expect(html).not.toContain('class="calc');
    // the save slot says what to tap next; 액션도 기록 is folded away, with no spot or action rows
    expect(html).toContain('<div class="fast-result fast-under" role="status" aria-live="polite"><span class="fr-hint">핸드를 넣거나, 안 넣고 폴드</span></div>');
    // the quick buttons: 폴드 / −1bb work without cards (핸드 생략); ⏳ and 스택 입력 wait for the hand
    expect(html).toContain('<button type="button" class="fq fq-fold">폴드<small>핸드 생략</small></button><button type="button" class="fq fq-bb">−1bb<small>넣은 만큼</small></button>');
    expect(html).toContain('<button type="button" class="fq fq-lose" disabled="">− 손실 ⏳</button><button type="button" class="fq fq-win" disabled="">+ 수익 ⏳</button><button type="button" class="fq fq-stack" disabled="">스택 입력</button>');
    // no 액션도 기록: no spot or action rows
    expect(html).not.toContain("fast-more");
    expect(html).not.toContain("fast-spots");
    expect(html).not.toContain("fast-acts");
    expect(t).toContain("아직 오늘 기록이 없어요");
    // no OS keyboard: no text field at all
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  // 빠른 기록 no longer has 액션도 기록 (the action row): kept for 남의 핸드's old screen only.
  it.skip("shows the class as typed, the opener row facing an open, and the choices for it", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, actions: true, draft: typed("HJ", "K8s", { spot: "open", opener: "UTG" }) });
    const html = page("fast");
    expect(html).toMatch(/<span class="fast-class done" aria-live="polite">K8s<\/span>/);
    expect(html).toMatch(/<div class="fast-opener"><span class="fast-sub">오픈<br\/>자리<\/span><div class="fast-row fast-seats n4"><button type="button" class="on">UTG<\/button><button type="button" class="">UTG\+1<\/button><button type="button" class="">UTG\+2<\/button><button type="button" class="">LJ<\/button><\/div><\/div>/);
    expect(html).toMatch(/<div class="fast-acts n4"><button type="button" class="a-fold">폴드<\/button><button type="button" class="a-call">콜<\/button><button type="button" class="a-3bet">3벳<\/button><button type="button" class="a-allin">올인<\/button><\/div>/);
    // 액션도 기록 open: no calculator by itself (상황 and 내 액션 stay in view); a fold saves at once, the rest ask for the result
    expect(html).not.toContain('class="calc');
    expect(text(html)).toContain("폴드는 바로 저장 · 다른 액션은 계산기에 결과를 넣고 저장");
    // two ranks without suitedness: it asks
    fastStore.set({ stage: "mid", players: 9, actions: true, draft: typed("BTN", "AJ") });
    const ask = page("fast");
    expect(ask).toMatch(/<span class="fast-class" aria-live="polite">AJ<small>\?<\/small><\/span>/);
    expect(ask).toContain('<div class="fast-suits fast-under ask">');
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
      fast(now - 60_000, typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call"),
      fast(now - 120_000, typed("LJ", "55"), "fold"),
      fast(now - 180_000, typed("CO", "72o"), "fold"),
      fast(now - 240_000, typed("BTN", "AJo"), "open"),
    ]);
    fastStore.set({ stage: "mid", players: 9, draft: newDraft("UTG+2") });
    const html = page("fast");
    expect(text(html)).toMatch(/차트대로 50% \(2\/4\) ⚠ 오버 1 ▽ 언더 1 △ 섞음 0/);
    expect(html.match(/class="fast-item /g)).toHaveLength(4);
    expect(html).toMatch(/class="fast-item v-over"><span class="fi-time">[^<]+<\/span><b class="fi-seat">HJ<\/b><b class="fi-class">K8s<\/b><span class="fi-act">UTG 오픈 → 콜<\/span><span class="fi-verdict">⚠ 오버 \(폴드\)<\/span>/);
    expect(html).toMatch(/class="fast-item v-under">.*?<b class="fi-class">55<\/b><span class="fi-act">폴드<\/span><span class="fi-verdict">▽ 언더 \(오픈\)<\/span>/);
    expect(html).toMatch(/class="fast-item v-ok">.*?<b class="fi-class">AJo<\/b><span class="fi-act">오픈<\/span><span class="fi-verdict">✓<\/span>/);
    expect(text(html)).toContain("오늘 요약 복사");
  });

  // 빠른 기록 no longer has 액션도 기록 (the action row): kept for 남의 핸드's old screen only.
  it.skip("shows a hand being corrected with 삭제 and 취소, its action lit", () => {
    const h = fast(Date.now() - 60_000, typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call");
    put([h]);
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("LJ"), parked: null }, h));
    const html = page("fast");
    // 수정 중, 삭제 and 취소 in the seat row's label line (in the toggle's place): the hand row stays where it is
    expect(html).toMatch(/<div class="fast-label seat-line">내 포지션 <b>HJ<\/b><span class="fast-edit-mini" role="status"><span>✎ \d\d:\d\d 수정 중<\/span><button type="button" class="danger">삭제<\/button><button type="button">취소<\/button><\/span><\/div>/);
    expect(html).not.toContain("fast-editing");
    expect(html).not.toContain("fast-toggle");
    expect(html).toContain('<button type="button" class="a-call on">콜</button>');
    expect(text(html)).toContain("누르면 이 핸드를 고쳐서 저장해요");
    // its decision on file keeps the action row in view: no calculator by itself
    expect(html).not.toContain('class="calc');
  });

  it("shows in 지난 기록 with a 빠른 tag, the decision and the verdict", () => {
    put([fast(5, typed("HJ", "K8s", { spot: "open", opener: "UTG" }), "call")]);
    const html = page("list/mine");
    expect(html).toMatch(/<b class="log-seat">HJ<\/b><b class="log-class">K8s<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><\/span><\/span><span class="log-pre small">미들 · UTG 오픈 → 콜<\/span><span class="log-verdict small v-over">⚠ 오버플레이 \(차트: 폴드\) · 솔버 55bb 기준<\/span>/);
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

  it("types the amount on the calculator sheet: 12 big keys, the chips big with their bb, 칩 | bb, − 손실 / + 수익 saving it", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", focus: "result" } });
    const html = page("fast");
    // the sheet is up; the page under it keeps its layout (hidden by the class), the rank pad still in place
    expect(html).toContain('<div class="fast calc-open">');
    expect(html).toContain('<div class="fast-pad fast-under">');
    expect(html).toContain('<div class="calc hand" role="group" aria-label="결과 입력"><div class="calc-top">');
    // the tabs (금액 on) and the level chip
    expect(html).toContain(
      '<div class="calc-tabs" role="tablist" aria-label="결과 입력"><button type="button" role="tab" aria-selected="false" class="">스택</button><button type="button" role="tab" aria-selected="true" class="on">금액</button><button type="button" role="tab" aria-selected="false" class="">보드</button></div><button type="button" class="fast-lv" aria-label="블라인드 Lv5 300/600 · 바꾸기">Lv5 300/600 <i>▾</i></button>',
    );
    // the display: the chips big, the bb right next to them in its own color, 칩 | bb at the right
    expect(html).toContain(
      '<div class="calc-disp" aria-live="polite"><div class="calc-main"><b class="calc-num">12,000</b><span class="bb calc-bb">20bb</span><div class="calc-unit" role="group" aria-label="단위"><button type="button" class="on" aria-pressed="true">칩</button><button type="button" class="" aria-pressed="false">bb</button></div></div><div class="calc-line hint">손실·수익을 누르면 저장 · 다음 CO</div></div>',
    );
    // 12 keys, three to a row: 1–9, 000, 0, ⌫
    const keys = /<div class="calc-keys">(.*?)<\/div>/.exec(html)?.[1] ?? "";
    expect([...keys.matchAll(/>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "000", "0", "⌫"]);
    expect(keys).toContain('<button type="button" class="k-000" aria-label="영 세 개">000</button><button type="button">0</button><button type="button" class="k-back" aria-label="지우기">⌫</button>');
    // − 손실 / + 수익 save the amount with their sign (they take 저장's place), each showing what it saves
    expect(html).toContain('<div class="calc-acts n3 signs"><button type="button" class="c-fold">폴드</button><button type="button" class="c-lose">− 손실<small>−12,000</small></button><button type="button" class="c-win on">+ 수익<small>+12,000</small></button></div>');
    expect(html).not.toContain("c-save");
    // the hand line closes the sheet (a clear button laid over it); the class stays exactly as it is
    expect(html).toContain('<div class="fast-label hand-line"><button type="button" class="hand-hit" aria-label="핸드 AKs · 다시 입력"></button>핸드');
    expect(html).toContain('<span class="fast-class done" aria-live="polite">AKs</span>');
    // no input element and nothing focused: the phone's keyboard never comes up
    expect(html).not.toContain("<input");
    expect(html.toLowerCase()).not.toContain("autofocus");
    // in bb: the 10th key is "." and the display shows the chips it comes to
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "20.5", unit: "bb", focus: "result" } });
    const bb = page("fast");
    expect(bb).toContain('<button type="button" class="k-dot" aria-label="소수점">.</button><button type="button">0</button>');
    expect(bb).toContain('<b class="calc-num bb">20.5bb</b><span class="calc-conv">= 12,300</span>');
    expect(bb).toContain('<button type="button" class="c-win on">+ 수익<small>+12,300</small></button>');
    // nothing typed: the display asks, the signs save a win or a loss without an amount
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), focus: "result" } });
    const none = page("fast");
    expect(none).toContain('<b class="calc-num ph">금액은?</b>');
    expect(none).toContain('<button type="button" class="c-lose">− 손실<small>금액 없이</small></button><button type="button" class="c-win">+ 수익<small>금액 없이</small></button>');
    // 0: a chop
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), amount: "0", focus: "result" } });
    expect(page("fast")).toContain('<button type="button" class="c-lose">− 손실<small>본전</small></button><button type="button" class="c-win">+ 수익<small>본전</small></button>');
  });

  it("asks for the level for bb with none known, and for the sign for an amount without one", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "20", unit: "bb", focus: "result" } });
    const html = page("fast");
    expect(html).toContain('<b class="calc-num bb">20bb</b>');
    expect(html).toContain('<div class="calc-line hint">레벨을 골라 주세요</div>');
    expect(html).toContain('class="fast-lv ask"');
    expect(html).toContain('<button type="button" class="c-lose" disabled="">− 손실<small>레벨 ?</small></button><button type="button" class="c-win on" disabled="">+ 수익<small>레벨 ?</small></button>');
    // the page's save slot under the sheet says it too
    expect(html).toContain('<button type="button" class="fs-save" disabled="">bb로 넣으려면 레벨을 골라 주세요</button>');
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), amount: "12000", focus: "result" } });
    const sign = page("fast");
    // neither sign lit: the tap on one saves
    expect(sign).toContain('<button type="button" class="c-lose">− 손실<small>−12,000</small></button><button type="button" class="c-win">+ 수익<small>+12,000</small></button>');
    expect(sign).toContain('<button type="button" class="fs-save plain" disabled="">수익? 손실?</button>');
  });

  it("puts 폴드 (one tap) with the blind it costs and its bb, 워크 for the BB, 저장 at the right; chips only in a row of four", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("BB", "94o", { focus: "stack" }) });
    const bb = page("fast");
    expect(bb).toContain(
      '<div class="calc-acts n3"><button type="button" class="c-fold">폴드<small>−1,200 · <span class="bb">2bb</span></small></button><button type="button" class="c-walk">워크<small>+300 · <span class="bb">0.5bb</span></small></button><button type="button" class="c-save plain">결과 없이 저장<small>다음 SB</small></button></div>',
    );
    // 스택 is the tab by default: the display asks for the stack
    expect(bb).toContain('<button type="button" role="tab" aria-selected="true" class="on">스택</button>');
    expect(bb).toContain('<b class="calc-num ph">지금 스택은?</b>');
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("SB", "T4o", { focus: "stack" }) });
    expect(page("fast")).toContain('<button type="button" class="c-fold">폴드<small>−300 · <span class="bb">0.5bb</span></small></button>');
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("BTN", "72o", { focus: "stack" }) });
    expect(page("fast")).toContain('<div class="calc-acts n2"><button type="button" class="c-fold">폴드</button><button type="button" class="c-save plain">');
    // the BB in 금액: four buttons, the costs in chips only (nothing cut on a 360px phone)
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("BB", "94o", { focus: "result" }) });
    expect(page("fast")).toContain('<div class="calc-acts n4 signs"><button type="button" class="c-fold">폴드<small>−1,200</small></button><button type="button" class="c-walk">워크<small>+300</small></button><button type="button" class="c-lose">');
    // without a level
    fastStore.set({ stage: "mid", players: 9, draft: typed("BB", "94o", { focus: "stack" }) });
    expect(page("fast")).toContain('<button type="button" class="c-fold">폴드<small>블라인드 · 레벨 ?</small></button>');
    // the sheet closed (the class in, ⌫ back to the hand): the page's row opens it
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: typed("BB", "94o") });
    const shut = page("fast");
    expect(shut).toContain('<div class="fast"><div class="fast-bar">');
    expect(shut).not.toContain('class="calc');
    expect(shut).toContain('<button type="button" class="rr-sum hint">결과 · 누르면 계산기</button>');
    // The hand in, nothing typed: 폴드 | 스택 입력 (the calculator only on a tap, so the hand stays editable).
    expect(shut).toContain('<button type="button" class="fq fq-fold">폴드</button><button type="button" class="fq fq-bb">−1bb<small>넣은 만큼</small></button>');
    expect(shut).toContain('<button type="button" class="fq fq-lose">− 손실 ⏳</button><button type="button" class="fq fq-win">+ 수익 ⏳</button><button type="button" class="fq fq-stack">스택 입력</button>');
  });

  it("types the board in the sheet's 보드 tab: five slots, the ranks five to a row with ⌫ and 완료, the ringed card's suit", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), board: [{ r: R("K"), s: 1 }], focus: "board" } });
    const one = page("fast");
    const ranks = /<div class="calc-keys ranks">(.*?)<\/div>/.exec(one)?.[1] ?? "";
    expect([...ranks.matchAll(/>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual([..."AKQJT98765432", "⌫", "완료"]);
    expect(one).toContain('<div class="calc-suits" role="group" aria-label="K 수트 (기억나면)"><button type="button" class="s-s" aria-pressed="false">♠</button><button type="button" class="s-h on" aria-pressed="true">♥</button>');
    expect(one).toContain('<div class="calc-slots" role="group" aria-label="보드 K♥ (기억나는 것만)"><button type="button" class="calc-slot set target" aria-label="1번째 카드 K♥ · 수트 고르기" aria-pressed="true"><span class="s-h">K♥</span></button>');
    expect(one).toContain("<em>기억나는 카드만</em>");
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), board: K72, focus: "board" } });
    const three = page("fast");
    expect(three).not.toContain('class="s-h on"');
    expect(three).toContain(
      '<button type="button" class="calc-slot set" aria-label="2번째 카드 7 · 수트 고르기" aria-pressed="false"><span class="nos">7</span></button><button type="button" class="calc-slot set target" aria-label="3번째 카드 2 · 수트 고르기" aria-pressed="true"><span class="nos">2</span></button><button type="button" class="calc-slot turn" aria-label="보드 카드 넣기">·</button>',
    );
    expect(three).toContain('aria-label="2 수트 (기억나면)"');
    // the K's slot tapped: the ring and the suit row go to it (its ♥ lit)
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "AKs"), board: K72, focus: "board", boardAt: 0 } });
    const late = page("fast");
    expect(late).toContain('class="calc-slot set target" aria-label="1번째 카드 K♥ · 수트 고르기" aria-pressed="true"');
    expect(late).toContain('aria-label="K 수트 (기억나면)"');
    expect(late).toContain('<button type="button" class="s-h on" aria-pressed="true">♥</button>');
    // 저장 there says what the result typed saves as
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: K72, focus: "board" } });
    expect(page("fast")).toContain('<button type="button" class="c-save">저장<small>+12,000 · 다음 CO</small></button>');
    // four of a rank counting the class: that key rests
    fastStore.set({ stage: "mid", players: 9, ...lv5(), draft: { ...typed("BTN", "KK"), board: [{ r: R("K") }, { r: R("K") }], focus: "board" } });
    expect(page("fast")).toContain('<button type="button" disabled="">K</button>');
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
    expect(html).toMatch(/<button type="button" class="fast-item res v-none"><span class="fi-time">[^<]+<\/span><b class="fi-seat">BTN<\/b><b class="fi-class">AKs<\/b><span class="fi-money"><span class="fi-net up">\+12,000<\/span> <span class="fi-bb bb">\+20bb<\/span><\/span><span class="fi-board"><span class="s-h">K♥<\/span><span class="nos">7<\/span><span class="nos">2<\/span><\/span><\/button>/);
    // a fold is muted, the blind it cost with it
    expect(html).toMatch(/<b class="fi-seat">SB<\/b><b class="fi-class">T4o<\/b><span class="fi-money"><span class="fi-net fold">폴드 −300<\/span> <span class="fi-bb bb">−0\.5bb<\/span><\/span><span class="fi-board"><\/span>/);
    expect(html).toMatch(/<b class="fi-seat">CO<\/b><b class="fi-class">72o<\/b><span class="fi-net fold">폴드<\/span><span class="fi-board">/);
    expect(html).toContain('<b class="fm-total up">+6,900</b><span class="fm-sub bb">+11.5bb</span>');
    // oldest first: −4,800, a fold, −300, +12,000
    expect(html).toMatch(/<svg class="chip-graph" viewBox="0 0 320 96" role="img" aria-label="오늘 칩 흐름: 0에서 지금 \+6,900, 최고 \+6,900, 최저 −5,100"/);
    expect(text(html)).toContain("0에서 · 최고 +6,900 · 최저 −5,100");
    expect(html).not.toContain("fast-stats");
    // in bb
    fastStore.set({ stage: "mid", players: 9, view: "bb", draft: newDraft("CO") });
    const bb = page("fast");
    // the chips small under the bb
    expect(bb).toContain('<span class="fi-money"><span class="fi-net up">+20bb</span> <span class="fi-bb">12,000</span></span>');
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
    put([saved(5, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: K72 }), saved(4, pickRes(typed("SB", "T4o"), "fold")), saved(3, { ...pickRes(typed("CO", "72o"), "fold"), board: K72 })]);
    const html = page("list/mine");
    // the line says only what the pill doesn't: the bb, the board
    expect(html).toMatch(/<b class="log-seat">BTN<\/b><b class="log-class">AKs<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><span class="log-result win">\+12,000<\/span><\/span><\/span><span class="log-pre small">\+20bb · 보드 K♥ 7 2<\/span><span class="muted small">/);
    // a fold: the pill alone (with a board, the board)
    expect(html).toMatch(/<b class="log-class">T4o<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><span class="log-result fold">폴드<\/span><\/span><\/span><span class="muted small">/);
    expect(html).toMatch(/<b class="log-class">72o<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><span class="log-result fold">폴드<\/span><\/span><\/span><span class="log-pre small">보드 K♥ 7 2<\/span>/);
    expect(html).not.toContain("log-verdict");
    expect(html).not.toContain("자세히");
    expect(html).not.toContain("log-continue");
  });

  it("corrects a hand saved without a decision in the sheet, in its own tab: 고쳐서 저장 / the sign saves it", () => {
    const h = saved(Date.now() - 60_000, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", board: K72 });
    put([h]);
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("CO"), parked: null }, h));
    const html = page("fast");
    expect(html).toMatch(/<div class="fast-label seat-line">내 포지션 <b>BTN<\/b><span class="fast-edit-mini" role="status"><span>✎ \d\d:\d\d 수정 중<\/span><button type="button" class="danger">삭제<\/button><button type="button">취소<\/button><\/span><\/div>/);
    expect(html).not.toContain("fast-editing");
    // the sheet in 금액 (the hand's own), its sign lit, the amount with its bb
    expect(html).toContain('<button type="button" role="tab" aria-selected="true" class="on">금액</button>');
    expect(html).toContain('<b class="calc-num">12,000</b><span class="bb calc-bb">20bb</span>');
    expect(html).toContain('<div class="calc-line hint">손실·수익을 누르면 고쳐서 저장</div>');
    expect(html).toContain('<button type="button" class="c-win on">+ 수익<small>+12,000</small></button>');
    // the page's row under it: what it saves as, and the board remembered
    expect(html).toContain('<button type="button" class="rr-sum"><b class="up">+12,000</b> <b class="bb">+20bb</b> · <span class="rr-board"><span class="s-h">K♥</span><span class="nos">7</span><span class="nos">2</span></span></button>');
    expect(html).toContain('<button type="button" class="fs-save">고쳐서 저장</button>');
    expect(html).not.toContain("fast-more");
    // a fold: 스택, empty, 폴드 lit with what is on file
    const f = saved(Date.now() - 50_000, pickRes(typed("SB", "T4o"), "fold"));
    put([f]);
    fastStore.set(startEdit({ stage: "mid", players: 9, draft: newDraft("CO"), parked: null }, f));
    const fold = page("fast");
    expect(fold).toContain('<div class="calc-line hint">지금 폴드 −300로 저장돼 있어요</div>');
    expect(fold).toContain('<button type="button" class="c-fold on">폴드<small>−300 · <span class="bb">0.5bb</span></small></button><button type="button" class="c-save">고쳐서 저장</button>');
  });

  it("shows the level the hand goes in at: the start time's estimate dashed, a pick moved on by the schedule dashed, none as 레벨 ? asking", () => {
    // 22:05 with a 19:00 start: Lv9, from the clock
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NIGHT);
    try {
      put([], { startClock: START });
      fastStore.set({ stage: "mid", players: 9, draft: typed("BB", "AKs") });
      const est = page("fast");
      expect(est).toContain('<button type="button" class="fast-lv est" aria-expanded="false" aria-label="블라인드 Lv9 800/1,600 (추정) · 바꾸기">Lv9 800/1,600 (추정) <i>▾</i></button>');
      fastStore.set({ stage: "mid", players: 9, draft: typed("BB", "AKs", { focus: "stack" }) });
      const sheet = page("fast");
      expect(sheet).toContain('<button type="button" class="fast-lv est" aria-label="블라인드 Lv9 800/1,600 (추정) · 바꾸기">Lv9 800/1,600 (추정) <i>▾</i></button>');
      expect(sheet).toContain('<button type="button" class="c-fold">폴드<small>−3,200 · <span class="bb">2bb</span></small></button>');
    } finally {
      vi.useRealTimers();
    }
    put([]);
    // Lv5 picked 25 minutes ago: the schedule has moved it on to Lv6 (an estimate now)
    fastStore.set({ stage: "mid", players: 9, levelPick: { level: 5, at: Date.now() - 25 * 60_000 }, draft: typed("BB", "AKs", { focus: "stack" }) });
    const moved = page("fast");
    expect(moved).toContain('<button type="button" class="fast-lv est" aria-expanded="false" aria-label="블라인드 Lv6 400/800 (추정) · 바꾸기">Lv6 400/800 (추정) <i>▾</i></button>');
    expect(moved).toContain('<button type="button" class="c-fold">폴드<small>−1,600 · <span class="bb">2bb</span></small></button>');
    expect(moved).not.toContain("stale");
    fastStore.set({ stage: "mid", players: 9, levelPick: { level: 5, at: Date.now() - 5 * 60_000 }, draft: typed("BTN", "AKs") });
    expect(page("fast")).toContain('class="fast-lv" aria-expanded="false" aria-label="블라인드 Lv5 300/600 · 바꾸기"');
    // a level left from an earlier day isn't taken: 레벨 ?, asking once a hand is typed
    put([], { lastLevel: 12 });
    fastStore.set({ stage: "mid", players: 9, draft: typed("SB", "AKs", { focus: "stack" }) });
    const none = page("fast");
    expect(none).toContain('<button type="button" class="fast-lv ask" aria-expanded="false" aria-label="블라인드 레벨 ? · 바꾸기">레벨 ? <i>▾</i></button>');
    expect(none).toContain('<button type="button" class="c-fold">폴드<small>블라인드 · 레벨 ?</small></button>');
    fastStore.set({ stage: "mid", players: 9, draft: newDraft("SB") });
    expect(page("fast")).toContain('class="fast-lv" aria-expanded="false" aria-label="블라인드 레벨 ? · 바꾸기"');
    // 레벨 모름 picked on purpose: no asking
    fastStore.set({ stage: "mid", players: 9, levelPick: { level: null, at: Date.now() }, draft: typed("SB", "AKs") });
    expect(page("fast")).toContain('class="fast-lv" aria-expanded="false" aria-label="블라인드 레벨 ? · 바꾸기"');
  });

  // 빠른 기록 no longer has 액션도 기록 (the action row): kept for 남의 핸드's old screen only.
  it.skip("opens 액션도 기록 as it was left: the spot and action rows, the result typed shown on the page's row", () => {
    put([]);
    // (a sign picked puts the calculator on the amount: stored with the sheet closed here)
    fastStore.set({ stage: "mid", players: 9, actions: true, ...lv5(), draft: { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000", focus: undefined } });
    const html = page("fast");
    expect(html).toContain('<button type="button" class="rr-sum"><b class="up">+12,000</b> <b class="bb">+20bb</b></button>');
    expect(html).not.toContain('class="calc');
    expect(html).toContain('<button type="button" class="fast-more open" aria-expanded="true">액션 접기 ▴</button>');
    // open, the toggle sits under the actions (so the hand, the result, the board and the actions fit one screen)
    expect(html.indexOf("fast-more open")).toBeGreaterThan(html.indexOf("fast-acts"));
    expect(html).toContain("fast-spots");
    expect(html).toContain('<div class="fast-acts n4"><button type="button" class="a-fold">폴드</button>');
    expect(text(html)).toContain("누르면 바로 저장 · 다음 핸드는 CO");
    expect(html).not.toContain("fs-save");
  });

  // 빠른 기록 no longer has 액션도 기록 (the action row): kept for 남의 핸드's old screen only.
  it.skip("asks for the result of an action tapped with none typed: the sheet with the action waiting, 결과 없이 or 저장", () => {
    put([]);
    fastStore.set({ stage: "mid", players: 9, actions: true, ...lv5(), draft: { ...typed("BTN", "AKs"), act: "open", focus: "stack" } });
    const html = page("fast");
    expect(html).toContain('<div class="fast calc-open">');
    expect(html).toContain('<span class="calc-act">오픈 · 결과는?</span>');
    // no 폴드 / 워크 here (they are actions); 결과 없이 saves the action alone, 저장 the action with the result
    expect(html).toContain('<div class="calc-acts n2"><button type="button" class="c-none">결과 없이<small>오픈만</small></button><button type="button" class="c-save">저장<small>오픈 · 다음 CO</small></button></div>');
    // the page's 결과 row opened the sheet without an action: 확인 closes it
    fastStore.set({ stage: "mid", players: 9, actions: true, ...lv5(), draft: { ...typed("BTN", "AKs"), focus: "stack" } });
    const bare = page("fast");
    expect(bare).not.toContain('class="calc-act"');
    expect(bare).toContain('<div class="calc-acts n1"><button type="button" class="c-save">확인<small>계산기 닫기</small></button></div>');
    // a stored action that can't be one (폴드 saves at once; one the spot doesn't offer) isn't kept
    fastStore.set({ stage: "mid", players: 9, actions: true, ...lv5(), draft: { ...typed("BTN", "AKs"), act: "fold", focus: "stack" } });
    expect(page("fast")).not.toContain('class="calc-act"');
    fastStore.set({ stage: "mid", players: 9, actions: true, ...lv5(), draft: { ...typed("BTN", "AKs"), act: "3bet", focus: "stack" } });
    expect(page("fast")).not.toContain('class="calc-act"');
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
    expect(html).toMatch(/<div class="fast-label seat-line">상대 포지션 <b>BTN<\/b><div class="seg small fast-toggle" role="tablist" aria-label="빠른 기록"><button type="button" role="tab" aria-selected="false" class="">내 핸드<\/button><button type="button" role="tab" aria-selected="true" class="on">남의 핸드<\/button><\/div>/);
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
    expect(html).toMatch(/<div class="fast-label seat-line">상대 포지션 <b>BB<\/b><span class="fast-edit-mini" role="status"><span>✎ \d\d:\d\d 수정 중<\/span><button type="button" class="danger">삭제<\/button><button type="button">취소<\/button><\/span><\/div>/);
    expect(html).not.toContain('class="calc');
    expect(html).toContain('<button type="button" class="a-call on">콜</button>');
  });

  it("shows in 지난 기록 › 남의 핸드 with the 남 badge, a 빠른 tag and their verdict", () => {
    put([theirs(5, typed("BB", "72o", { spot: "open", opener: "CO" }), "call")]);
    const html = page("list/other");
    expect(html).toMatch(/<button class="log-row other"><span class="log-row-main"><span class="log-kind" aria-label="남의 핸드">남<\/span><b class="log-seat">BB<\/b><b class="log-class">72o<\/b><span class="log-end"><span class="log-tag fast">빠른<\/span><\/span><\/span><span class="log-pre small">미들 · CO 오픈 → 콜<\/span><span class="log-verdict small v-over">⚠ 차트보다 루즈 \(차트: 폴드\) · 솔버 55bb 기준<\/span>/);
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

describe("빠른 기록's tournaments (react-dom/server)", () => {
  const R = (k: string) => "23456789TJQKA".indexOf(k);
  const typed = (seat: string, cls: string, extra: Partial<FastDraft> = {}): FastDraft => {
    let d = tapRank(tapRank(newDraft(seat), R(cls[0])), R(cls[1]));
    if (cls[2]) d = pickSuited(d, cls[2] === "s");
    return { ...d, ...extra };
  };
  /** A hand saved on 빠른 기록 at Lv5 (no decision), in tournament `t` (none: logged before tournaments). */
  const saved = (at: number, d: FastDraft, t?: string, kind: "mine" | "other" = "mine") =>
    ({ ...withFastResult(fastHand(d, null, { ...emptyHand(null, kind), id: `t${at}${kind}`, createdAt: at, updatedAt: at }, "mid", 9, kind)!, d, { level: 5, guessed: false }, true)!, ...(t ? { tourney: t } : {}) }) as LoggedHand;
  const MIN = 60_000;
  /** That night's 19:00. */
  const T0 = new Date(2026, 10, 7, 19, 0).getTime();
  const rec = (id: string, extra: Partial<Tourney> = {}): Tourney => ({ id, createdAt: T0, updatedAt: T0, activeAt: T0, name: "", memo: "", start: T0, startSet: true, startStack: 50000, ...extra });
  const won = (at: number, t?: string) => saved(at, { ...pickRes(typed("BTN", "AKs"), "+"), amount: "12000" }, t);
  const fold = (at: number, t?: string) => saved(at, pickRes(typed("SB", "T4o"), "fold"), t);
  const DRAFT = { stage: "mid" as const, players: 9, draft: newDraft("CO"), parked: null };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NIGHT);
    fastStore.set(DRAFT);
  });
  afterEach(() => {
    vi.useRealTimers();
    fastStore.set({});
    fastOtherStore.set({});
  });

  it("heads the list with the current tournament: its title to edit, ＋ 새 토너먼트, its start and stack, the graph from the start stack", () => {
    put([won(NIGHT - MIN, "a"), fold(NIGHT - 2 * MIN, "a"), fold(NIGHT - 3 * MIN)], { tourneys: [rec("a")] });
    const html = page("fast");
    const t = text(html);
    expect(html).toContain(
      '<div class="fast-today-head tn-head"><h2><button type="button" class="tn-title" aria-label="토너먼트 정보 고치기: 11/7 토너먼트"><span>11/7 토너먼트</span><i>✎</i></button></h2><button type="button" class="tn-new">＋ 새 토너먼트</button></div><div class="tn-meta-row"><p class="tn-meta">19:00 시작 · 2핸드 · 시작 50,000 <span class="tn-end">→ 61,700 <span class="bb">38.6bb</span></span></p><button type="button" class="tn-upd">칩 업데이트</button></div>',
    );
    // the stack now in bb at the level now (Lv9 by the clock: 61,700 / 1,600)
    // only its own hands (the untagged fold is under 이전 기록)
    expect(html.match(/class="fast-item /g)).toHaveLength(2);
    expect(html).toMatch(/<svg class="chip-graph" viewBox="0 0 320 96" role="img" aria-label="칩 흐름: 50,000에서 지금 61,700/);
    expect(html).toContain('<b class="fm-total up">+11,700</b>');
    expect(t).toContain("요약 복사 토너먼트 삭제 토너먼트 기록 ›");
    expect(t).not.toContain("오늘 요약 복사");
    expect(t).not.toContain("지난 기록 ›");
    // the start stack is known, and it has hands: no invite, no 취소
    expect(html).not.toContain("tn-invite");
    expect(html).not.toContain("tn-cancel");
    // its level clock: 19:00 start, 22:05 → Lv9 (estimated)
    fastStore.set({ ...DRAFT, draft: typed("BB", "94o") });
    expect(page("fast")).toContain('aria-label="블라인드 Lv9 800/1,600 (추정) · 바꾸기"');
  });

  it("keeps my stack now in bb at the level now while an older hand is corrected (not at that hand's level)", () => {
    const w = won(NIGHT - MIN, "a");
    put([w, fold(NIGHT - 2 * MIN, "a")], { tourneys: [rec("a")] });
    fastStore.set(startEdit(DRAFT, w));
    const html = page("fast");
    // the hand corrected is at Lv5 (its chip says so); the line still reads Lv9's 1,600
    expect(html).toContain('aria-label="블라인드 Lv5 300/600 · 바꾸기"');
    expect(html).toContain('시작 50,000 <span class="tn-end">→ 61,700 <span class="bb">38.6bb</span></span>');
    // a hand with no level on file: the line keeps its bb
    const bare = { ...w, level: null };
    put([bare, fold(NIGHT - 2 * MIN, "a")], { tourneys: [rec("a")] });
    fastStore.set(startEdit(DRAFT, bare));
    expect(page("fast")).toContain('<span class="tn-end">→ 61,700 <span class="bb">38.6bb</span></span>');
  });

  it("works a hand out from 스택 in the sheet: 지금 스택 less the stack before, with its bb as big as the chips", () => {
    // 50,000; +12,000; a 칩 업데이트 of 60,000 after it
    put([won(NIGHT - 5 * MIN, "a")], { tourneys: [rec("a", { checks: [{ at: NIGHT - 3 * MIN, stack: 60000 }] })] });
    fastStore.set({ ...DRAFT, draft: typed("CO", "AKs", { focus: "stack" }) });
    const waiting = page("fast");
    expect(waiting).toContain('<div class="calc-main"><b class="calc-num ph">지금 스택은?</b></div><div class="calc-line hint">전 60,000 <span class="bb calc-pre">37.5bb</span> · 빼기는 앱이 해요</div>');
    expect(waiting).toContain('<button type="button" class="c-save plain">결과 없이 저장<small>다음 HJ</small></button>');
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "stack"), stackNow: "61800" } });
    const html = page("fast");
    // Lv9 800/1,600 by the 19:00 start
    expect(html).toContain('<div class="calc-main"><b class="calc-num">61,800</b><span class="bb calc-bb">38.6bb</span></div><div class="calc-line"><b class="up">+1,800</b> <b class="bb">+1.1bb</b><small>지금 61,800 − 전 60,000</small></div>');
    expect(html).toContain('<button type="button" class="c-save">저장<small>다음 HJ</small></button>');
    // the sheet closed: the page's row says what it saves as
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "stack"), stackNow: "61800", focus: undefined } });
    const shut = page("fast");
    expect(shut).toContain('<button type="button" class="rr-sum">스택 61,800 <span class="bb">38.6bb</span> → <b class="up">+1,800</b> <b class="bb">+1.1bb</b></button>');
    expect(shut).toContain('<button type="button" class="fs-save">저장 · 다음 핸드 HJ</button>');
    // 50 bb or more: amber; a 0 too many: 자릿수 확인
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "stack"), stackNow: "618000" } });
    expect(page("fast")).toContain('<div class="calc-line big"><b class="up">+558,000</b> <b class="bb">+348.8bb</b><small>지금 618,000 − 전 60,000</small><small class="slip">자릿수 확인</small></div>');
    // even, and a loss
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "stack"), stackNow: "60000" } });
    expect(page("fast")).toContain('<div class="calc-line"><b>본전</b><small>지금 60,000 − 전 60,000</small></div>');
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "stack"), stackNow: "52000" } });
    expect(page("fast")).toContain('<b class="down">−8,000</b> <b class="bb">−5bb</b>');
    // the stack before unknown: 지금 스택 alone goes on file
    put([won(NIGHT - 5 * MIN, "a"), saved(NIGHT - 4 * MIN, pickRes(typed("BTN", "QQ"), "+"), "a")], { tourneys: [rec("a")] });
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "stack"), stackNow: "61800" } });
    const gap = page("fast");
    expect(gap).toContain('<b class="calc-num">61,800</b><span class="bb calc-bb">38.6bb</span></div><div class="calc-line hint">결과 없는 핸드 있음 · 이번엔 스택만</div>');
    expect(gap).toContain('<button type="button" class="c-save">스택만 저장<small>다음 HJ</small></button>');
    put([], { tourneys: [rec("a", { startStack: null })] });
    expect(page("fast")).toContain('<div class="calc-line hint">전 스택 모름 · 이번엔 스택만, 다음 핸드부터 계산</div>');
    // in the list: a hand by 스택 with the stack before unknown shows the stack; one saved with no result shows –, never 워크
    const unknown = saved(NIGHT - 2 * MIN, { ...pickRes(typed("CO", "72o"), "stack"), stackNow: "90000" }, "a");
    expect(unknown).toMatchObject({ result: null, net: null, stack: 90000, fastStack: true });
    put([unknown, saved(NIGHT - MIN, typed("HJ", "JTs"), "a")], { tourneys: [rec("a", { startStack: null })] });
    fastStore.set(DRAFT);
    const list = page("fast");
    expect(list).toMatch(/<b class="fi-class">72o<\/b><span class="fi-money"><span class="fi-net">스택 90,000<\/span> <span class="fi-bb bb">150bb<\/span><\/span>/);
    expect(list).toMatch(/<b class="fi-class">JTs<\/b><span class="fi-net">–<\/span>/);
    expect(list).not.toContain("fi-act");
  });

  it("points an amount bigger than the stack before to 스택: a loss that big waits, a win that big is tinted", () => {
    // 50,000 +12,000 = 62,000 before the hand
    put([won(NIGHT - 5 * MIN, "a")], { tourneys: [rec("a")] });
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "-"), amount: "70000", focus: "result" } });
    const lose = page("fast");
    expect(lose).toContain('<div class="calc-line hint big">전 62,000보다 많이 잃을 순 없어요<button type="button" class="calc-tostack">스택으로</button></div>');
    expect(lose).toContain('<button type="button" class="c-lose on" disabled="">− 손실<small>−70,000</small></button>');
    expect(lose).toContain('<button type="button" class="fs-save" disabled="">전 스택보다 많이 잃을 순 없어요</button>');
    // all in and lost: the whole stack is fine
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "-"), amount: "62000", focus: "result" } });
    expect(page("fast")).toContain('<button type="button" class="c-lose on">− 손실<small>−62,000</small></button>');
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "+"), amount: "70000", focus: "result" } });
    const win = page("fast");
    expect(win).toContain('<div class="calc-line hint big">전 62,000보다 커요 · 지금 스택이면<button type="button" class="calc-tostack">스택으로</button></div>');
    expect(win).toContain('<button type="button" class="c-win on">+ 수익<small>+70,000</small></button>');
    // 지금 스택 typed too says the stack itself: nothing to point at
    fastStore.set({ ...DRAFT, draft: { ...pickRes(typed("CO", "AKs"), "-"), amount: "70000", stackNow: "5000", focus: "result" } });
    const both = page("fast");
    expect(both).not.toContain("스택이면");
    expect(both).toContain("지금 스택 5,000도 같이 저장");
  });

  it("names a jump after hands with no chips 결과 모름, not 빠진 핸드", () => {
    // +12,000; a win with no amount; a hand by 스택 with the stack before unknown (90,000 after it)
    const unknown = saved(NIGHT - 3 * MIN, { ...pickRes(typed("CO", "72o"), "stack"), stackNow: "90000" }, "a");
    put([won(NIGHT - 5 * MIN, "a"), saved(NIGHT - 4 * MIN, pickRes(typed("BTN", "QQ"), "+"), "a"), unknown], { tourneys: [rec("a")] });
    const t = text(page("fast"));
    expect(t).toContain("기록한 핸드 +12,000 +20bb · 결과 모름 +28,000 +46.7bb");
    expect(t).not.toContain("빠진 핸드");
    // a stack on file that disagrees with hands all known: hands missed
    put([won(NIGHT - 5 * MIN, "a"), saved(NIGHT - 3 * MIN, { ...pickRes(typed("CO", "72o"), "-"), amount: "1000", stackNow: "70000" }, "a")], { tourneys: [rec("a")] });
    expect(text(page("fast"))).toContain("기록한 핸드 +11,000 +18.3bb · 빠진 핸드 +9,000 +15bb");
  });

  it("shows a 칩 업데이트 by the tournament's line, in the total and among the hands", () => {
    put([won(NIGHT - 5 * MIN, "a"), fold(NIGHT - MIN, "a")], { tourneys: [rec("a", { checks: [{ at: NIGHT - 3 * MIN, stack: 60000 }] })] });
    const html = page("fast");
    // 50,000 +12,000 = 62,000; counted 60,000; −300
    expect(html).toContain('<div class="tn-meta-row"><p class="tn-meta">19:00 시작 · 2핸드 · 시작 50,000 <span class="tn-end">→ 59,700 <span class="bb">37.3bb</span></span></p><button type="button" class="tn-upd">칩 업데이트</button></div>');
    expect(html).toContain('<b class="fm-total up">+9,700</b>');
    expect(text(html)).toContain("기록한 핸드 +11,700 +19.5bb · 칩 업데이트 −2,000 −3.3bb");
    // in the list by its time, between the two hands, with what it changed
    const rows = [...html.matchAll(/class="(fast-item res[^"]*|fast-check)"/g)].map((m) => m[1].split(" ")[0]);
    expect(rows).toEqual(["fast-item", "fast-check", "fast-item"]);
    expect(html).toMatch(/<div class="fast-check"><span class="fi-time">22:02<\/span><b class="fc-name">칩 업데이트<\/b><span class="fc-count"><b class="fc-stack">60,000<\/b><span class="bb fc-bb">100bb<\/span><\/span><span class="fc-diff down">−2,000<\/span><button type="button" class="fast-mini" aria-label="22:02 칩 업데이트 60,000 지우기">지우기<\/button><\/div>/);
    // the graph jumps there
    expect(html).toContain('class="cg-jump"');
  });

  it("invites the start stack and name when unknown, and offers 새 토너먼트 취소 while a new one is empty", () => {
    put([fold(NIGHT - 2 * MIN, "a")], { tourneys: [rec("a", { startStack: null, startSet: undefined, auto: true })] });
    const html = page("fast");
    expect(html).toContain('<button type="button" class="tn-invite">＋ 시작 스택·이름 넣기<small>그래프가 시작 스택부터</small></button>');
    expect(html).toContain('<p class="tn-meta">22:03부터 · 1핸드</p>');
    put([fold(NIGHT - 2 * MIN, "a")], { tourneys: [rec("a", { activeAt: T0 }), rec("b", { name: "2부", activeAt: NIGHT - MIN, createdAt: NIGHT - MIN })] });
    const empty = page("fast");
    expect(empty).toContain('<span>2부</span>');
    expect(empty).toContain('<div class="tn-cancel"><span>아직 핸드가 없어요</span><button type="button">새 토너먼트 취소</button></div>');
    // said once: not again under it
    expect(text(empty)).not.toContain("아직 이 토너먼트에 핸드가 없어요");
    expect(text(empty)).toContain("토너먼트 기록 ›");
    expect(empty).not.toContain("fast-item");
    // the only one there is, or the one before is last week's: it can only go (none current after it)
    put([], { tourneys: [rec("b", { activeAt: NIGHT - MIN, createdAt: NIGHT - MIN })] });
    expect(page("fast")).toContain('<button type="button">새 토너먼트 지우기</button>');
    const week = NIGHT - 7 * 24 * 60 * MIN;
    put([fold(week, "w")], { tourneys: [rec("w", { start: week, createdAt: week, activeAt: week }), rec("b", { activeAt: NIGHT - MIN, createdAt: NIGHT - MIN })] });
    expect(page("fast")).toContain('<button type="button">새 토너먼트 지우기</button>');
    // resumed, not new: neither (its sheet can delete it, with a confirm)
    put([], { tourneys: [rec("b", { activeAt: NIGHT - MIN })] });
    const resumed = page("fast");
    expect(resumed).not.toContain("tn-cancel");
    expect(text(resumed)).toContain("아직 이 토너먼트에 핸드가 없어요. 핸드를 적으면 여기 모여요.");
  });

  it("lays out the sheet: 구조 first, the start stack on the calculator with its bb, the level the start gives, the box for today's hands, the note", () => {
    const html = render(
      <TourneySheet
        mode="new"
        initial={{ name: "", clock: "19:00", stack: "50000", memo: "", structure: "pub", blinds: null }}
        defaultName="11/7 토너먼트"
        levelText={(c) => (c === "19:00" ? "지금 Lv3 200/400" : null)}
        join={5}
        onSave={() => null}
        onClose={noop}
      />,
    );
    // 구조: 야자수 새틀 lit by default, 직접 입력 beside it
    expect(html).toContain(
      '<div class="tn-struct" role="radiogroup" aria-label="구조"><button type="button" role="radio" aria-checked="true" class="on">야자수 새틀<small>구조표대로 · 레벨 자동</small></button><button type="button" role="radio" aria-checked="false" class="">직접 입력<small>블라인드를 직접</small></button></div>',
    );
    // 시작 스택: a field-looking button (the in-app calculator), 50,000 with its bb at Lv1
    expect(html).toContain('<button type="button" class="tn-numfield" aria-label="시작 스택 50,000 · 계산기로 넣기">50,000 <span class="bb">250bb</span></button><small>Lv1 기준 · 누르면 계산기</small>');
    expect(html).not.toContain('inputMode="numeric"');
    expect(html).not.toContain('placeholder="예: 50000"');
    expect(html).toContain('<small class="tn-lv">지금 Lv3 200/400</small>');
    expect(html).not.toContain("레벨 추정에 써요");
    expect(html).toMatch(/<label class="tn-join"><input type="checkbox" checked=""\/><span>오늘 토너먼트 없이 적은 5핸드도 여기로 모으기<\/span><\/label>/);
    const edit = render(<TourneySheet mode="edit" initial={{ name: "", clock: "", stack: "", memo: "" }} defaultName="x" note="저장된 핸드의 레벨은 그대로예요." join={5} onSave={() => null} onClose={noop} />);
    expect(edit).toContain('<button type="button" class="tn-numfield empty" aria-label="시작 스택 모름 · 계산기로 넣기">모름</button>');
    expect(edit).toContain("<small>레벨 추정에 써요 · 모르면 비워 두세요</small>");
    expect(edit).toContain("<p>저장된 핸드의 레벨은 그대로예요.</p>");
    // only a new one takes today's hands
    expect(edit).not.toContain("tn-join");
    // 직접 입력: no 시작 시간 (no time estimate), 블라인드 on the keypad, the note
    const custom = render(
      <TourneySheet mode="new" initial={{ name: "", clock: "19:00", stack: "30000", memo: "", structure: "custom", blinds: { sb: 100, bb: 200, ante: 200 } }} defaultName="x" onSave={() => null} onClose={noop} />,
    );
    expect(custom).toContain('aria-checked="true" class="on">직접 입력');
    expect(custom).not.toContain('type="time"');
    expect(custom).toContain('<button type="button" class="tn-numfield" aria-label="블라인드 100/200 · 앤티 200 · 넣기">100/200 <small>앤티 200</small></button>');
    expect(custom).toContain('>30,000 <span class="bb">150bb</span></button><small>BB 200 기준</small>');
    expect(custom).toContain("레벨은 칠 때 레벨 칩에서 바꿔요 · 시간으로 추정하지 않아요");
    const unset = render(<TourneySheet mode="new" initial={{ name: "", clock: "", stack: "", memo: "", structure: "custom", blinds: null }} defaultName="x" onSave={() => null} onClose={noop} />);
    expect(unset).toContain('<button type="button" class="tn-numfield empty" aria-label="블라인드 없음 · 넣기">＋ 넣기</button>');
  });

  it("shows a 직접 입력 tournament's blinds on the chip (never 추정), asks for them when not set, and its fold costs and bb at them", () => {
    const B = { sb: 100, bb: 200, ante: 200 };
    put([], { startClock: START, tourneys: [rec("c", { structure: "custom", blinds: B, startSet: undefined, startStack: 30000 })] });
    fastStore.set({ ...DRAFT, draft: typed("BB", "94o", { focus: "stack" }) });
    const html = page("fast");
    expect(html).toContain('<button type="button" class="fast-lv" aria-label="블라인드 100/200 · 바꾸기">100/200 <i>▾</i></button>');
    expect(html).not.toContain("추정");
    expect(html).toContain('<button type="button" class="c-fold">폴드<small>−400 · <span class="bb">2bb</span></small></button><button type="button" class="c-walk">워크<small>+100 · <span class="bb">0.5bb</span></small></button>');
    expect(html).toContain('전 30,000 <span class="bb calc-pre">150bb</span> · 빼기는 앱이 해요');
    // a stack typed: its bb at the tournament's blinds
    fastStore.set({ ...DRAFT, draft: { ...typed("CO", "AKs"), res: "stack", stackNow: "32000", focus: "stack" } });
    expect(page("fast")).toContain('<b class="calc-num">32,000</b><span class="bb calc-bb">160bb</span></div><div class="calc-line"><b class="up">+2,000</b> <b class="bb">+10bb</b>');
    // another 앤티, and none
    put([], { tourneys: [rec("c", { structure: "custom", blinds: { sb: 400, bb: 800, ante: 0 }, startSet: undefined })] });
    fastStore.set({ ...DRAFT, draft: typed("BB", "94o", { focus: "stack" }) });
    const none = page("fast");
    expect(none).toContain(">400/800 노앤티 <i>▾</i></button>");
    expect(none).toContain("폴드<small>−800 · ");
    // not set yet: the chip asks once a hand is typed; a blind's fold can't be counted yet
    put([], { tourneys: [rec("c", { structure: "custom", startSet: undefined })] });
    const ask = page("fast");
    expect(ask).toContain('<button type="button" class="fast-lv ask" aria-label="블라인드 ? · 바꾸기">블라인드 ? <i>▾</i></button>');
    expect(ask).toContain('<button type="button" class="c-fold">폴드<small>블라인드 ?</small></button>');
    // the page's chip with the sheet closed
    fastStore.set({ ...DRAFT, draft: newDraft("CO") });
    expect(page("fast")).toContain('<button type="button" class="fast-lv" aria-expanded="false" aria-label="블라인드 ? · 바꾸기">블라인드 ? <i>▾</i></button>');
  });

  it("lays out the blinds editor on the keypad: 다음 ▸ from the 야자수 ladder, SB / BB / 앤티 (BB ringed, the others following it), 적용", () => {
    const html = render(<BlindsSheet initial={{ sb: 300, bb: 600, ante: 600 }} applyNote="새 핸드부터" onApply={noop} onClose={noop} />);
    expect(html).toContain('<div class="calc-dim"></div><div class="calc modal blinds" role="dialog" aria-modal="true" aria-label="블라인드">');
    expect(html).toContain('<div class="calc-top"><b class="calc-title">블라인드</b><button type="button" class="calc-next">다음 ▸ 400/800</button><button type="button" class="calc-x">닫기</button></div>');
    expect(html).toContain(
      '<div class="calc-fields" aria-live="polite"><button type="button" class="calc-field" aria-pressed="false" aria-label="SB 300"><small>SB<i>자동</i></small><b>300</b></button><button type="button" class="calc-field on" aria-pressed="true" aria-label="BB 600"><small>BB</small><b>600</b></button><button type="button" class="calc-field" aria-pressed="false" aria-label="앤티 600"><small>앤티<i>= BB</i></small><b>600</b></button></div>',
    );
    expect(html).toContain('<div class="calc-keys">');
    expect(html).toContain('<div class="calc-acts"><button type="button">취소</button><button type="button" class="c-save">적용<small>새 핸드부터 · 300/600 (600)</small></button></div>');
    expect(html).not.toContain("<input");
    // nothing set: 적용 waits for the BB
    const empty = render(<BlindsSheet initial={null} applyNote="새 핸드부터" onApply={noop} onClose={noop} />);
    expect(empty).toContain('<button type="button" class="c-save" disabled="">BB를 넣어 주세요</button>');
    expect(empty).toContain('<button type="button" class="calc-next">다음 ▸ 100/200</button>');
  });

  it("takes 칩 업데이트 on the calculator in a modal sheet: the app's count with its bb, 12 keys, 업데이트, no input element", () => {
    const html = render(<ChipUpdateSheet now={{ chips: 63000 }} level={5} open={null} onSave={() => null} onClose={noop} />);
    expect(html).toContain('<div class="calc modal" role="dialog" aria-modal="true" aria-label="칩 업데이트">');
    expect(html).toContain('<b class="calc-title">칩 업데이트</b><span class="calc-note">앱이 센 스택 <b>63,000</b> <span class="bb">105bb</span></span><button type="button" class="calc-x">취소</button>');
    expect(html.match(/<div class="calc-keys">(.*?)<\/div>/)?.[1].match(/<button/g)).toHaveLength(12);
    expect(html).toContain('<div class="calc-acts"><button type="button">취소</button><button type="button" class="c-save">업데이트</button></div>');
    expect(html).not.toContain("<input");
    // not known: why
    expect(render(<ChipUpdateSheet now={{ chips: null, why: "gap" }} level={5} open={null} onSave={() => null} onClose={noop} />)).toContain("앱이 센 스택 모름 · 결과 없는 핸드가 있어요");
    // one just typed, no hand since: put right in place
    expect(render(<ChipUpdateSheet now={{ chips: 63000 }} level={5} open={{ at: 1, stack: 61000 }} onSave={() => null} onClose={noop} />)).toContain("방금 넣은 61,000을 이걸로 고쳐요");
  });

  it("keeps the seat line one height with or without my stack (the old toggle's 38 px), so the hand row and the 아재's room stay put", async () => {
    // No @types/node here: reach node:fs through an untyped handle (vitest serves an imported .css as empty).
    const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(path: URL, encoding: "utf8"): string };
    const styles = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    const px = (sel: string, prop: string) => Number(new RegExp(`\\n${sel.replace(/\./g, "\\.")} \\{[^}]*?${prop}: (\\d+)px`).exec(styles)?.[1]);
    // the line's floor is what the 내 핸드 | 남의 핸드 toggle made it (a 32 px button in a 2 px padded, 1 px bordered box),
    // the height 수정 중's line keeps too; my stack's button (32 px) and its ⏳ button fit inside it
    expect(px(".fast-label.seat-line", "min-height")).toBe(38);
    expect(px(".fast-label .fast-toggle button", "height") + 2 * 2 + 2 * 1).toBe(38);
    expect(px(".fast-edit-mini", "height")).toBe(38);
    expect(px(".fast-label .seat-stack", "height")).toBeLessThanOrEqual(38);
    // the seat line carries it whatever sits at its right end: nothing, my stack, the toggle (남의 핸드)
    put([]);
    expect(page("fast")).toMatch(/<div class="fast-label seat-line">내 포지션 <b>[A-Z+0-9]+<\/b><\/div>/);
    put([fold(NIGHT - MIN, "a"), won(NIGHT - 2 * MIN, "a")], { tourneys: [rec("a", { startSet: undefined })] });
    expect(page("fast")).toMatch(/<div class="fast-label seat-line">내 포지션 <b>[A-Z+0-9]+<\/b><button type="button" class="seat-stack[^"]*"/);
    expect(page("other")).toContain('<div class="fast-label seat-line">상대 포지션 <b>');
    // and only that line: the other labels keep their own height
    expect(styles.match(/seat-line/g)).toHaveLength(1);
  });

  it("leaves everything above the list as it was, tournament or not", () => {
    // My stack by my seat shows only when a count is known: the rest above the list stays.
    const head = (html: string) => html.slice(0, html.indexOf('class="card-box fast-today"')).replace(/<button type="button" class="seat-stack".*?<\/button>/, "");
    put([]);
    const none = head(page("fast"));
    put([fold(NIGHT - MIN, "a"), won(NIGHT - 2 * MIN, "a")], { tourneys: [rec("a", { startSet: undefined })] });
    const withT = page("fast");
    expect(withT).toContain("tn-title");
    expect(head(withT)).toBe(none);
    put([fold(NIGHT - MIN), won(NIGHT - 2 * MIN)]);
    expect(head(page("fast"))).toBe(none);
    expect(none).not.toContain("토너먼트");
    expect(none.length).toBeGreaterThan(1000);
  });

  it("shows today's hands from before tournaments as they were, with ＋ 새 토너먼트 and what happens next", () => {
    put([won(NIGHT - MIN), fold(NIGHT - 2 * MIN)]);
    const html = page("fast");
    const t = text(html);
    expect(t).toContain("오늘 빠른 기록 2핸드 ＋ 새 토너먼트");
    expect(html).toContain('<p class="tn-meta">토너먼트 없이 적은 기록이에요 · 다음 핸드를 적으면 이 핸드들도 토너먼트로 모여요</p>');
    expect(html).toMatch(/aria-label="오늘 칩 흐름: 0에서 지금 \+11,700/);
    expect(t).toContain("오늘 요약 복사 토너먼트 기록 ›");
  });

  it("offers the last tournament's 이어 적기 when none is current and nothing is on today", () => {
    const week = NIGHT - 7 * 24 * 60 * MIN;
    put([won(week + MIN, "w"), fold(week, "w")], { tourneys: [rec("w", { name: "지난주 펍", start: week, createdAt: week, activeAt: week })] });
    const html = page("fast");
    const t = text(html);
    expect(html).toContain('<div class="tn-card"><div class="tn-card-main"><small class="muted">지난 토너먼트</small><b>지난주 펍</b>');
    expect(t).toMatch(/지난주 펍 10월 31일 \(토\) · 2핸드 · \+11,700 \+19\.5bb 이어 적기/);
    expect(t).toContain("아직 오늘 기록이 없어요. 핸드를 적으면 토너먼트가 시작돼요");
    expect(t).toContain("토너먼트 기록 ›");
    // nothing at all yet: neither
    put([]);
    const fresh = page("fast");
    expect(fresh).not.toContain("tn-card");
    expect(text(fresh)).not.toContain("토너먼트 기록 ›");
    expect(fresh).toContain('<button type="button" class="tn-new">＋ 새 토너먼트</button>');
  });

  it("shows 남의 핸드 of the current tournament under its name, without the tournament buttons", () => {
    const o = (at: number, t?: string) => saved(at, typed("CO", "K9s"), t, "other");
    put([o(NIGHT - MIN, "a"), o(NIGHT - 2 * MIN)], { tourneys: [rec("a")] });
    const html = page("other");
    expect(text(html)).toContain("오늘 남의 핸드 1핸드 11/7 토너먼트 · 19:00 시작");
    expect(html).toContain('<p class="tn-meta">11/7 토너먼트 · 19:00 시작</p>');
    expect(html).not.toContain("tn-new");
    expect(html).not.toContain("tn-title");
    expect(html.match(/class="fast-item /g)).toHaveLength(1);
  });

  it("lists the tournaments: the current one tagged, 이어 적기 on the others, 이전 기록 under them", () => {
    const week = NIGHT - 7 * 24 * 60 * MIN;
    put([won(NIGHT - MIN, "a"), saved(NIGHT - MIN, typed("CO", "K9s"), "a", "other"), fold(week, "w"), fold(week - 3 * 24 * 60 * MIN), won(week - 3 * 24 * 60 * MIN + 30 * MIN)], {
      tourneys: [rec("a", { name: "토요 펍" }), rec("w", { name: "지난주", start: week - 60 * MIN, createdAt: week, activeAt: week })],
    });
    const html = page("fast/past");
    const t = text(html);
    expect(html).toContain('<button type="button" class="log-link back">‹ 빠른 기록</button><button type="button" class="log-new-btn">＋ 새 토너먼트</button>');
    expect(html).toContain('<div class="tn-row current"><button type="button" class="tn-open"><span class="tn-row-top"><b class="tn-name">토요 펍</b><span class="log-tag">적는 중</span><span class="tn-res up">+12,000 <span class="bb">+20bb</span></span></span><span class="muted small">11월 7일 (토) 19:00 시작 · 1핸드 · 남의 핸드 1</span></button></div>');
    expect(html).toContain('<b class="tn-name">지난주</b><span class="tn-res down">−300 <span class="bb">−0.5bb</span></span>');
    expect(html).toContain('<button type="button" class="tn-resume" aria-label="이어 적기: 지난주">이어 적기</button>');
    expect(html.match(/class="tn-resume"/g)).toHaveLength(1);
    expect(t).toMatch(/이전 기록 · 토너먼트 없이 적은 빠른 기록 10월 28일 \(수\) 빠른 기록 \+11,700 \+19\.5bb 22:05~22:35 · 2핸드/);
    expect(t).toContain("토너먼트도 같이 저장돼요");
    put([]);
    expect(text(page("fast/past"))).toContain("아직 토너먼트 기록이 없어요. 빠른 기록에서 핸드를 적으면 토너먼트가 시작돼요.");
  });

  it("opens one tournament: its title to edit, start, stack and memo, every hand, 이어 적기 or 적는 중", () => {
    const week = NIGHT - 7 * 24 * 60 * MIN;
    put([won(NIGHT - MIN, "a"), fold(NIGHT - 2 * MIN, "a"), fold(week, "w")], {
      tourneys: [rec("a", { name: "토요 펍", memo: "테이블 3\n옆자리 공격적" }), rec("w", { start: week, createdAt: week, activeAt: week, startStack: null, startSet: undefined })],
    });
    const html = page("fast/t/a");
    const t = text(html);
    expect(html).toContain('<button type="button" class="log-link back">‹ 토너먼트 기록</button><span class="log-tag">적는 중</span>');
    expect(html).toContain('<h2><button type="button" class="tn-title" aria-label="토너먼트 정보 고치기: 토요 펍"><span>토요 펍</span><i>✎</i></button></h2>');
    // the stack at the end in bb at its last hand's level (Lv5: 61,700 / 600)
    expect(html).toContain('<p class="tn-meta">11월 7일 (토) 19:00 시작 · 2핸드 · 시작 50,000 <span class="tn-end">→ 61,700 <span class="bb">102.8bb</span></span></p>');
    expect(html).toContain('<p class="tn-memo">메모: 테이블 3\n옆자리 공격적</p>');
    expect(html.match(/class="fast-item /g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="칩 흐름: 50,000에서 지금 61,700/);
    expect(t).toContain("요약 복사");
    // deletable with its hands
    expect(html).toContain("이 토너먼트 삭제");
    const past = page("fast/t/w");
    expect(past).toContain('<button type="button" class="tn-resume">이어 적기</button>');
    expect(text(past)).toContain("10월 31일 (토) 22:05부터 · 1핸드");
    // gone, or never here
    expect(text(page("fast/t/nope"))).toContain("이 토너먼트를 찾을 수 없어요");
    // an empty one can be deleted
    put([], { tourneys: [rec("e", { activeAt: T0 - 60 * MIN })] });
    expect(page("fast/t/e")).toContain("이 토너먼트 삭제");
  });

  it("opens a group of hands from before tournaments by its newest hand's time (or any hand in it), with nothing to resume", () => {
    const old = [won(NIGHT - 24 * 60 * MIN), fold(NIGHT - 24 * 60 * MIN - 30 * MIN)];
    put(old);
    expect(page(`fast/s/${old[0].createdAt}`)).toBe(page(`fast/s/${old[1].id}`));
    // its newest hand deleted (opened from here and deleted in 빠른 기록): still there by the same address
    put([old[1]]);
    expect(text(page(`fast/s/${old[0].createdAt}`))).toContain("21:35~21:35 · 1핸드");
    put(old);
    const html = page(`fast/s/${old[1].id}`);
    const t = text(html);
    expect(html).toContain("<h2>11월 6일 (금) 빠른 기록</h2>");
    expect(t).toContain("21:35~22:05 · 2핸드");
    expect(html).not.toContain("tn-resume");
    expect(html).not.toContain("tn-title");
    expect(html).toMatch(/aria-label="칩 흐름: 0에서 지금 \+11,700/);
    expect(text(page("fast/s/nope"))).toContain("이 기록을 찾을 수 없어요");
  });
});
