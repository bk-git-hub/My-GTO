import type { ReactNode } from "react";
import { RANKS, SUITS, SUIT_SYMBOL } from "../../poker/cards";
import {
  amountValue,
  bbText1,
  canAddRank,
  chipsShort,
  inBb,
  levelChip,
  MINUS,
  missedPart,
  netBoth,
  overBefore,
  postedBy,
  signedText,
  stackNet,
  toChips,
  walkWin,
  type BoardMark,
  type FastRes,
  type Missed,
  type SessionMoney,
  type StackAt,
  type Unit,
} from "./fastChips";

/**
 * 빠른 기록's chip result and board, as pieces FastView puts on the screen: the keypad's digit and board
 * faces, the row under it as 칩 | bb or ♠♥♦♣, the 결과 line and its chips, the 보드 row with 지금 스택, the
 * 액션도 기록 toggle, the day's total. Presentational: everything comes in as props.
 */

/** The rank pad's keys, high to low (the same grid as the hand's pad). */
const PAD = "AKQJT98765432".split("");
/** The digit face: 1–7 on the first row, then 8 9 0 00 000 . and ⌫. */
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "00", "000", "."];

/** The keypad typing an amount: digits in the hand pad's grid. "." rests in chips, "000" in bb. */
export function DigitPad({ unit, onKey, onBack }: { unit: Unit; onKey: (k: string) => void; onBack: () => void }) {
  return (
    <div className="fast-pad digits">
      {DIGITS.map((k) => (
        <button key={k} type="button" className={`k-d${k.length > 1 ? " k-dd" : ""}`} disabled={unit === "chips" ? k === "." : k === "000"} onClick={() => onKey(k)}>
          {k}
        </button>
      ))}
      <button type="button" className="fast-back k-d" aria-label="지우기" onClick={onBack}>
        ⌫
      </button>
    </div>
  );
}

/** The keypad typing the board: the same ranks; a rank that can't be dealt again with this class rests. */
export function BoardPad({ marks, holeRanks, onRank, onBack }: { marks: BoardMark[]; holeRanks: number[]; onRank: (r: number) => void; onBack: () => void }) {
  return (
    <div className="fast-pad board">
      {PAD.map((k) => {
        const r = RANKS.indexOf(k);
        return (
          <button key={k} type="button" className="k-b" disabled={!canAddRank(marks, r, holeRanks)} onClick={() => onRank(r)}>
            {k}
          </button>
        );
      })}
      <button type="button" className="fast-back k-b" aria-label="지우기" onClick={onBack}>
        ⌫
      </button>
    </div>
  );
}

/** The row under the pad while an amount is typed: the unit. */
export function UnitRow({ unit, onUnit }: { unit: Unit; onUnit: (u: Unit) => void }) {
  return (
    <div className="fast-suits unit" role="group" aria-label="단위">
      <button type="button" className={`u-chips${unit === "chips" ? " on" : ""}`} aria-pressed={unit === "chips"} onClick={() => onUnit("chips")}>
        칩
      </button>
      <button type="button" className={`u-bb${unit === "bb" ? " on" : ""}`} aria-pressed={unit === "bb"} onClick={() => onUnit("bb")}>
        bb
      </button>
    </div>
  );
}

/** The row under the pad while the board is typed: the suit of the card ringed on the board (the last one, or a slot tapped), only if remembered. */
export function SuitRow({ target, onSuit }: { target: BoardMark | undefined; onSuit: (s: number) => void }) {
  return (
    <div className="fast-suits suit4" role="group" aria-label={target ? `${RANKS[target.r]} 수트 (기억나면)` : "카드 수트 (기억나면)"}>
      {SUITS.split("").map((su, s) => (
        <button key={su} type="button" className={`s-${su}${target?.s === s ? " on" : ""}`} aria-pressed={target?.s === s} disabled={!target} onClick={() => onSuit(s)}>
          {SUIT_SYMBOL[su]}
        </button>
      ))}
    </div>
  );
}

/** A remembered card: "K♥" in its suit's color, or the rank alone (muted) when the suit isn't known. */
function Mark({ m }: { m: BoardMark }) {
  if (m.s === undefined) return <span className="nos">{RANKS[m.r]}</span>;
  const su = SUITS[m.s];
  return (
    <span className={`s-${su}`}>
      {RANKS[m.r]}
      {SUIT_SYMBOL[su]}
    </span>
  );
}

/** The board as remembered, for a list row: "K♥ 7 2". */
export function MarksText({ marks, className }: { marks: BoardMark[]; className?: string }) {
  return (
    <span className={className}>
      {marks.map((m, i) => (
        <Mark key={i} m={m} />
      ))}
    </span>
  );
}

/** An amount's text as shown: chips with separators ("12,000"), bb as typed with "bb" ("20.5bb"). */
const shown = (text: string, unit: Unit): string => (unit === "bb" ? `${text}bb` : Number(text).toLocaleString());

/** An amount this many big blinds or more is tinted on the 결과 line: a 00 / 000 slip makes it ten times too big. */
const BIG_BB = 50;

/** A stack in whole chips while it fits ("64,200"), in 만 past a million. */
export const fullChips = (n: number): string => (n < 1_000_000 ? n.toLocaleString() : chipsShort(n));

/**
 * The 결과 line: its text, a small second line under it (스택's sum), whether it is only a hint, whether the
 * amount is unusually big, and whether 스택 is likely what was meant (an amount bigger than the stack before).
 */
interface Line {
  text: string;
  sub?: string;
  hint: boolean;
  big?: boolean;
  toStack?: boolean;
}

/**
 * 스택 on the 결과 line: what to type (with the stack before it), then the result worked out as typed, over
 * the sum that gives it ("+3,600 (+6bb)" over "지금 61,800 − 전 58,200"; 자동 계산 is on the 스택 chip lit
 * under it); the stack before not known: 지금 스택 goes on file with no result, and the next hand is worked
 * out from it.
 */
function stackResultLine(p: { stackNow?: string; stackUnit: Unit; level: number | null; before: StackAt }): Line {
  const b = p.before.chips;
  // Why the stack before isn't known: no stack on file yet, or a hand since without chips.
  const why = p.before.chips === null && p.before.why === "gap" ? "결과 없는 핸드 있음" : "전 스택 모름";
  const t = p.stackNow ?? "";
  if (amountValue(t) === null) return { text: "지금 스택 얼마?", sub: b !== null ? `전 ${fullChips(b)} · 빼기는 앱이 해요` : `${why} · 스택만 저장돼요`, hint: true };
  const now = toChips(t, p.stackUnit, p.level);
  if (now === null) return { text: `스택 ${t}bb`, sub: "레벨을 골라 주세요", hint: false };
  const net = stackNet(now, b);
  if (net === null) return { text: `스택 ${fullChips(now)} · 결과 모름`, sub: `${why} · 다음 핸드부터 계산`, hint: false };
  const bbs = inBb(Math.abs(net), p.level);
  return { text: net === 0 ? "본전" : netBoth(net, p.level), sub: `지금 ${fullChips(now)} − 전 ${fullChips(b as number)}`, hint: false, big: bbs !== null && bbs >= BIG_BB };
}

/** What the 결과 line reads for the draft (whether it is only a hint, whether the amount is unusually big). */
function resultLine(p: { res?: FastRes; amount?: string; unit: Unit; level: number | null; seat: string; bbAnte: boolean; stackNow?: string; stackUnit: Unit; before: StackAt }): Line {
  const { res, amount, unit, level, seat, bbAnte } = p;
  if (res === "stack") return stackResultLine(p);
  if (res === "fold") {
    const posted = postedBy(seat, level, bbAnte);
    return { text: posted === null ? "폴드 · 블라인드 (레벨 모름)" : posted ? `폴드 ${signedText(-posted, "chips")}` : "폴드", hint: false };
  }
  if (res === "walk") {
    const w = walkWin(level);
    return { text: w === null ? "워크" : `워크 ${signedText(w, "chips")}`, hint: false };
  }
  const sign = res === "+" ? "+" : res === "-" ? MINUS : "";
  if (!amount) {
    if (res === "+") return { text: "+ 수익 얼마?", hint: true };
    if (res === "-") return { text: `${MINUS} 손실 얼마?`, hint: true };
    // 지금 스택 typed with no result: 스택 works it out.
    if (p.stackNow) return { text: "스택을 누르면 자동 계산", hint: true };
    return { text: "폴드 한 번, 아니면 금액·스택", hint: true };
  }
  const main = `${sign}${shown(amount, unit)}`;
  if (!res) return { text: `${main} · 수익? 손실?`, hint: false };
  // "0." on its way to "0.5": nothing to work out yet.
  if (amountValue(amount) === null) return { text: main, hint: false };
  const chips = toChips(amount, unit, level);
  if (chips === null) return { text: `${main} · 레벨을 골라 주세요`, hint: false };
  if (chips === 0) return { text: `${main} = 본전`, hint: false };
  const b = inBb(chips, level);
  const big = b !== null && b >= BIG_BB;
  const text = unit === "bb" ? `${main} = ${sign}${chips.toLocaleString()}` : b === null ? main : `${main} = ${sign}${bbText1(b)}`;
  // More than my whole stack before the hand: a loss can't be (the save waits), a win that big is rare; most likely 지금 스택.
  const pre = p.before.chips;
  if (pre !== null && overBefore(chips, pre, p.stackNow)) {
    return { text, sub: `지금 스택이면 → 스택 · 전 ${fullChips(pre)}`, hint: false, big: true, toStack: true };
  }
  return { text, hint: false, big };
}

/** A blind's fold or a walk on its chip: the chips in the unit being typed, short ("−1,200", "−80만", "−2bb"). */
function chipAmount(n: number, unit: Unit, level: number | null): string {
  return unit === "bb" ? signedText(n, "bb", level) : n > 0 ? `+${chipsShort(n)}` : chipsShort(n);
}

/**
 * 결과: the line (what will be saved, as typed: "+12,000 = +20bb"; tap it to type the amount) with the
 * level chip at its right, the level picker under it when open, then the chips: 폴드 (one tap, saves, with
 * the blind it costs), 워크 for the BB, − 손실 / + 수익 (the sign; the keypad turns to digits), and 스택
 * (자동 계산: the keypad types 지금 스택, my chips counted after the hand, and the line works the result out
 * from my stack before it: "+3,600 (+6bb)" over "지금 61,800 − 전 58,200"). With 액션도 기록 open,
 * 폴드 / 워크 are the action row's, so only the signs and 스택 are here.
 */
export function ResultSec(p: {
  seat: string;
  level: number | null;
  levelLabel: string;
  levelClass: string;
  unit: Unit;
  res?: FastRes;
  amount?: string;
  /** 지금 스택 as typed, its unit, and my stack before the hand (for 스택). */
  stackNow?: string;
  stackUnit: Unit;
  before: StackAt;
  bbAnte: boolean;
  focused: boolean;
  enabled: boolean;
  actionsView: boolean;
  askSign: boolean;
  pickerOpen: boolean;
  picker: ReactNode;
  onAmount: () => void;
  onRes: (r: FastRes) => void;
  onLevel: () => void;
}) {
  const line = resultLine(p);
  const posted = postedBy(p.seat, p.level, p.bbAnte);
  const walk = !p.actionsView && p.seat === "BB";
  const n = (p.actionsView ? 0 : 1) + (walk ? 1 : 0) + 3;
  const w = walkWin(p.level);
  const byStack = p.res === "stack";
  // 지금 스택 typed with no result yet, or an amount bigger than the stack before: 스택 is the way to work it out.
  const askStack = (!p.res && !p.amount && !!p.stackNow) || !!line.toStack;
  return (
    <div className="fast-sec fast-res">
      <div className="fast-res-head">
        <span className="frh-label">결과</span>
        <button type="button" className={`fr-amt${p.focused ? " on" : ""}${line.hint ? " hint" : ""}${line.big ? " big" : ""}${line.sub ? " two" : ""}`} disabled={!p.enabled} onClick={p.onAmount}>
          {line.sub ? (
            <>
              <span>{line.text}</span>
              <small>{line.sub}</small>
            </>
          ) : (
            line.text
          )}
        </button>
        <button type="button" className={`fast-lv${p.levelClass}`} aria-expanded={p.pickerOpen} aria-label={`블라인드 ${p.levelLabel} · 바꾸기`} onClick={p.onLevel}>
          {levelChip(p.level)} <i>{p.pickerOpen ? "▴" : "▾"}</i>
        </button>
      </div>
      {p.pickerOpen && p.picker}
      <div className={`fast-res-chips n${n}`}>
        {!p.actionsView && (
          <button type="button" className={`r-fold${p.res === "fold" ? " on" : ""}`} disabled={!p.enabled} onClick={() => p.onRes("fold")}>
            <span>폴드</span>
            {posted === null ? <small>블라인드</small> : posted ? <small>{chipAmount(-posted, p.unit, p.level)}</small> : null}
          </button>
        )}
        {walk && (
          <button type="button" className={`r-walk${p.res === "walk" ? " on" : ""}`} disabled={!p.enabled} onClick={() => p.onRes("walk")}>
            <span>워크</span>
            {w !== null && <small>{chipAmount(w, p.unit, p.level)}</small>}
          </button>
        )}
        <button type="button" className={`r-lose${p.res === "-" ? " on" : ""}${p.askSign ? " ask" : ""}`} aria-pressed={p.res === "-"} disabled={!p.enabled} onClick={() => p.onRes("-")}>
          {MINUS} 손실
        </button>
        <button type="button" className={`r-win${p.res === "+" ? " on" : ""}${p.askSign ? " ask" : ""}`} aria-pressed={p.res === "+"} disabled={!p.enabled} onClick={() => p.onRes("+")}>
          + 수익
        </button>
        <button type="button" className={`r-stack${byStack ? " on" : ""}${askStack ? " ask" : ""}`} aria-pressed={byStack} aria-label="스택으로 입력 · 지금 스택에서 자동 계산" disabled={!p.enabled} onClick={() => p.onRes("stack")}>
          <span>스택</span>
          <small>자동 계산</small>
        </button>
      </div>
    </div>
  );
}

/** 지금 스택 as typed: "스택 64,200" over "107bb" (typed in bb: "스택 107bb" over the chips). */
function stackLine(text: string, unit: Unit, level: number | null): [string, string] {
  const chips = toChips(text, unit, level);
  if (unit === "bb") return [`스택 ${text}bb`, chips === null ? "레벨 ?" : fullChips(chips)];
  const b = chips === null ? null : inBb(chips, level);
  return [`스택 ${fullChips(Number(text))}`, b === null ? "" : bbText1(b)];
}

/**
 * 보드: five slots for the cards remembered, a card without a suit as its rank alone. Tap one: the
 * keypad types the board's ranks, the row under it the suit of the ringed card (the last one; a card
 * already typed when its own slot is tapped, for a suit remembered late). 지금 스택 at the right (tap: digits).
 */
export function BoardRow(p: {
  marks: BoardMark[];
  /** The card the suit row is for while the board has the keypad (-1: none). */
  target: number;
  stackNow?: string;
  stackUnit: Unit;
  level: number | null;
  focus: "board" | "stack" | null;
  enabled: boolean;
  onSlot: (i: number) => void;
  onStack: () => void;
}) {
  const st = p.stackNow ? stackLine(p.stackNow, p.stackUnit, p.level) : null;
  const name = (m: BoardMark) => `${RANKS[m.r]}${m.s === undefined ? "" : SUIT_SYMBOL[SUITS[m.s]]}`;
  return (
    <div className="fast-board">
      <span className="fb-label">보드</span>
      <div className={`fb-slots${p.focus === "board" ? " on" : ""}${p.enabled ? "" : " off"}`} role="group" aria-label={`보드 ${p.marks.length ? p.marks.map(name).join(" ") : "카드"} (기억나는 것만)`}>
        {[0, 1, 2, 3, 4].map((i) => {
          const m = p.marks[i];
          const ring = p.focus === "board" && i === p.target;
          return (
            <button
              key={i}
              type="button"
              className={`fb-slot${i === 3 ? " turn" : ""}${m ? " set" : ""}${ring ? " target" : ""}`}
              aria-label={m ? `${i + 1}번째 카드 ${name(m)} · 수트 고르기` : i === p.marks.length ? "보드 카드 넣기" : `${i + 1}번째 카드 자리`}
              aria-pressed={m ? ring : undefined}
              disabled={!p.enabled}
              onClick={() => p.onSlot(i)}
            >
              {m ? <Mark m={m} /> : "·"}
            </button>
          );
        })}
      </div>
      <button type="button" className={`fast-stack${p.focus === "stack" ? " on" : ""}${st ? " set" : ""}`} disabled={!p.enabled} onClick={p.onStack}>
        {st ? (
          <>
            <span>{st[0]}</span>
            {st[1] && <small>{st[1]}</small>}
          </>
        ) : (
          "지금 스택"
        )}
      </button>
    </div>
  );
}

/** "액션도 기록": my preflop decision and the chart's verdict, folded away by default. */
export function MoreToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`fast-more${open ? " open" : ""}`} aria-expanded={open} onClick={onToggle}>
      {open ? (
        <>액션 접기 ▴</>
      ) : (
        <>
          액션도 기록 ▾ <small>차트대로 했는지 판정</small>
        </>
      )}
    </button>
  );
}

/** A total: "+12,000" / "−3.5bb" / "0". */
const totalText = (n: number, unit: Unit): string => (n === 0 ? (unit === "bb" ? "0bb" : "0") : unit === "bb" ? `${n > 0 ? "+" : MINUS}${bbText1(Math.abs(n))}` : signedText(n, "chips"));

/**
 * The day's total: in the unit shown, the other unit small, and the 칩 | bb toggle for the list and the
 * graph. Where 지금 스택 or a 칩 업데이트 disagreed with the count (`missed`: hands not logged, a count put
 * right), the total is the stack's change, as the graph shows it, with the hands logged and the rest
 * (빠진 핸드; 결과 모름: after hands without chips; 칩 업데이트) on a line under it.
 */
export function MoneyHead({ money, missed, view, onView }: { money: SessionMoney; missed: Missed | null; view: Unit; onView: (u: Unit) => void }) {
  const total = money.chips + (missed?.chips ?? 0);
  const totalBb = money.bb === null || (missed && missed.bb === null) ? null : Math.round((money.bb + (missed?.bb ?? 0)) * 10) / 10;
  const chips = totalText(total, "chips");
  const bb = totalBb === null ? null : totalText(totalBb, "bb");
  const inBbView = view === "bb" && bb !== null;
  const [main, sub] = inBbView ? [bb, chips] : [chips, bb];
  const tone = total > 0 ? " up" : total < 0 ? " down" : "";
  const part = (c: number, b: number | null) => (inBbView && b !== null ? totalText(b, "bb") : totalText(c, "chips"));
  const upd = missed?.upd ?? null;
  const gap = missed?.gap ?? null;
  // The hands missed: the jumps other than 칩 업데이트 and 결과 모름 (shown when there are any, or nothing else to show).
  const lost = missed ? missedPart(missed) : null;
  return (
    <div className="fast-money">
      <b className={`fm-total${tone}`}>{main}</b>
      {sub && <span className="fm-sub">{sub}</span>}
      <div className="seg small fast-view" role="group" aria-label="보기 단위">
        <button type="button" className={view === "chips" ? "on" : "off"} aria-pressed={view === "chips"} onClick={() => onView("chips")}>
          칩
        </button>
        <button type="button" className={view === "bb" ? "on" : "off"} aria-pressed={view === "bb"} onClick={() => onView("bb")}>
          bb
        </button>
      </div>
      {missed && lost && (
        <span className="fm-split">
          기록한 핸드 {part(money.chips, money.bb)}
          {(!upd && !gap) || lost.chips ? ` · 빠진 핸드 ${part(lost.chips, lost.bb)}` : ""}
          {gap ? ` · 결과 모름 ${part(gap.chips, gap.bb)}` : ""}
          {upd ? ` · 칩 업데이트 ${part(upd.chips, upd.bb)}` : ""}
        </span>
      )}
    </div>
  );
}
