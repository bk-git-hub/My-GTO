import { Fragment, type ReactNode } from "react";
import { RANKS, SUITS, SUIT_SYMBOL } from "../../poker/cards";
import { DigitKeys, numSize, RankKeys, SuitKeys, useCalcKeys } from "./CalcSheet";
import {
  amountValue,
  bbPart,
  bbText1,
  chipsShort,
  digitSlip,
  draftResult,
  inBb,
  MINUS,
  missedPart,
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
import type { Lv } from "./levelClock";

/**
 * 빠른 기록's chip result and board, as pieces FastView puts on the screen: the hand's calculator sheet (its tabs,
 * display, keys and buttons: HandSheet), the page's 결과 row under the hand while the sheet is closed, the 액션도
 * 기록 toggle, the day's total. Presentational: everything comes in as props.
 */

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
 * A piece of a line as shown: plain text, or a bb number, which is drawn in its own color, bold, as big as the
 * chips next to it (the chips are what is counted at the table, the bb what the chart reads).
 */
export type Part = string | { bb: string };

/** A bb number (`.bb`): "+25.6bb" in the bb color. Nothing without one. */
export function Bb({ v, className }: { v: string | null | undefined; className?: string }) {
  return v ? <span className={className ? `bb ${className}` : "bb"}>{v}</span> : null;
}

/** " " and the bb, for the end of a line's chips (nothing without a level). */
const bbAfter = (v: string | null): Part[] => (v ? [" ", { bb: v }] : []);

/** A line's parts on screen: the text pieces run together, each bb number its own `.bb` span. */
export function Parts({ p }: { p: Part[] }) {
  const merged = p.reduce<Part[]>((out, x) => {
    const last = out[out.length - 1];
    if (typeof x === "string" && typeof last === "string") out[out.length - 1] = last + x;
    else out.push(x);
    return out;
  }, []);
  return (
    <>
      {merged.map((x, i) => (typeof x === "string" ? <Fragment key={i}>{x}</Fragment> : <Bb key={i} v={x.bb} />))}
    </>
  );
}

/** A stack's line pieces: the result in its tone and its bb (as big as the chips), the sum that gives it. */
function NetBb({ net, level }: { net: number; level: Lv }) {
  if (net === 0) return <b>본전</b>;
  const b = bbPart(net, level, true);
  return (
    <>
      <b className={net > 0 ? "up" : "down"}>{signedText(net, "chips")}</b>
      {b && (
        <>
          {" "}
          <b className="bb">{b}</b>
        </>
      )}
    </>
  );
}

/** The sheet's tab from the field the keypad types into. */
export type SheetMode = "stack" | "amount" | "board";

/** What the hand's calculator sheet shows and does (FastView passes the draft's pieces and the handlers). */
export interface HandSheetProps {
  mode: SheetMode;
  seat: string;
  level: Lv;
  /** The level chip: its text ("Lv4 300/500 (추정)", "400/800", "블라인드 ?") and its tone (" est", " ask"). */
  levelText: string;
  levelClass: string;
  /** A 직접 입력 tournament's hand: its blinds are typed, not a 야자수 새틀 level. */
  custom?: boolean;
  unit: Unit;
  stackUnit: Unit;
  res?: FastRes;
  amount?: string;
  stackNow?: string;
  marks: BoardMark[];
  /** The board card the suit keys are for (-1: none). */
  target: number;
  holeRanks: number[];
  before: StackAt;
  bbAnte: boolean;
  editing: boolean;
  /** 액션도 기록 open: 폴드 / 워크 are actions there; the sheet saves only with an action waiting (`act`), else 확인. */
  actionsView: boolean;
  /** The action waiting for its result ("오픈"), or null. */
  act: string | null;
  /** Why the save waits (the button says it), or null. */
  waits: string | null;
  /** The seat the next hand is at ("다음 BTN"). */
  next: string;
  onTab: (e: SheetMode) => void;
  onLevel: () => void;
  onKey: (k: string) => void;
  onBack: () => void;
  onUnit: (u: Unit) => void;
  onFold: () => void;
  onWalk: () => void;
  /** 저장 as typed (with an action waiting: the action and the result); 확인 (액션도 기록, none waiting): closes. */
  onSave: () => void;
  /** 결과 없이: the action waiting, saved with no chips. */
  onNoResult: () => void;
  /** − 손실 / + 수익 in 금액: the amount with that sign, saved (액션도 기록 with none waiting: the sign, and the sheet closes). */
  onSign: (s: "+" | "-") => void;
  /** The amount typed moved to 지금 스택 (it was more than the stack before). */
  onToStack: () => void;
  onRank: (r: number) => void;
  onSuit: (s: number) => void;
  onSlot: (i: number) => void;
  onClose: () => void;
}

/** The level chip read out: "블라인드 Lv5 300/600", "블라인드 400/800"; "블라인드 ?" as it is. */
const chipLabel = (text: string): string => (text.startsWith("블라인드") ? text : `블라인드 ${text}`);

/** "−1,000" / "+300", short for the buttons' sub-labels. */
const shortSigned = (n: number): string => (n > 0 ? `+${chipsShort(n)}` : chipsShort(n));

/** The hand's result as the sheet types it, in chips (null: none yet, or not known), for the 보드 tab's save label. */
function typedNet(p: HandSheetProps): number | null {
  const out = draftResult({ res: p.res, amount: p.amount, unit: p.unit, seat: p.seat, level: p.level, bbAnte: p.bbAnte, stackNow: p.stackNow, stackUnit: p.stackUnit, before: p.before.chips });
  return "block" in out ? null : out.net;
}

/**
 * The hand's calculator sheet (inside CalcSheet): the tabs 스택 | 금액 | 보드 with the level chip; the display (the
 * number big with its bb next to it, the line under it: the result worked out with its bb, or what to do); the
 * keys (digits, or the board's ranks and suits); the buttons: 폴드 (one tap, with the blind it costs) and 워크 for
 * the BB, then 저장 (스택, 보드) or − 손실 / + 수익 (금액: they save).
 */
export function HandSheet(p: HandSheetProps) {
  const posted = postedBy(p.seat, p.level, p.bbAnte);
  const w = walkWin(p.level);
  const fold = !p.actionsView;
  const walk = fold && p.seat === "BB";
  const amountMode = p.mode === "amount";
  // Four buttons in a row (BB in 금액): the costs in chips only, so nothing is cut on a 360px phone.
  const four = amountMode && walk;
  const v = amountValue(p.amount ?? "");
  const amountChips = v === null ? null : toChips(p.amount ?? "", p.unit, p.level);
  const pre = p.before.chips;
  const over = amountMode && amountChips !== null && pre !== null && overBefore(amountChips, pre, p.stackNow);
  const needLevel = v !== null && v !== 0 && amountChips === null;
  const enter = () => {
    if (p.mode !== "amount") {
      if (!p.waits) p.onSave();
    } else if ((p.res === "+" || p.res === "-") && !(p.res === "-" && over) && !needLevel) p.onSign(p.res);
  };
  useCalcKeys({ key: (k) => p.mode !== "board" && p.onKey(k), back: p.onBack, enter, escape: p.onClose });

  const tabs = (
    <div className="calc-tabs" role="tablist" aria-label="결과 입력">
      {(
        [
          ["stack", "스택"],
          ["amount", "금액"],
          ["board", "보드"],
        ] as const
      ).map(([m, label]) => (
        <button key={m} type="button" role="tab" aria-selected={p.mode === m} className={p.mode === m ? "on" : ""} onClick={() => p.mode !== m && p.onTab(m)}>
          {label}
        </button>
      ))}
    </div>
  );
  const chip = (
    <button type="button" className={`fast-lv${p.levelClass}`} aria-label={`${chipLabel(p.levelText)} · 바꾸기`} onClick={p.onLevel}>
      {p.levelText} <i>▾</i>
    </button>
  );

  // ── the display ──
  let display: ReactNode;
  if (p.mode === "board") {
    const name = (m: BoardMark) => `${RANKS[m.r]}${m.s === undefined ? "" : SUIT_SYMBOL[SUITS[m.s]]}`;
    display = (
      <div className="calc-slots" role="group" aria-label={`보드 ${p.marks.length ? p.marks.map(name).join(" ") : "카드"} (기억나는 것만)`}>
        {[0, 1, 2, 3, 4].map((i) => {
          const m = p.marks[i];
          const ring = i === p.target;
          return (
            <button
              key={i}
              type="button"
              className={`calc-slot${i === 3 ? " turn" : ""}${m ? " set" : ""}${ring ? " target" : ""}`}
              aria-label={m ? `${i + 1}번째 카드 ${name(m)} · 수트 고르기` : i === p.marks.length ? "보드 카드 넣기" : `${i + 1}번째 카드 자리`}
              aria-pressed={m ? ring : undefined}
              onClick={() => p.onSlot(i)}
            >
              {m ? <Mark m={m} /> : "·"}
            </button>
          );
        })}
        <em>기억나는 카드만</em>
      </div>
    );
  } else if (p.mode === "stack") {
    const t = p.stackNow ?? "";
    const why = pre === null && p.before.chips === null && p.before.why === "gap" ? "결과 없는 핸드 있음 · 이번엔 스택만" : "전 스택 모름 · 이번엔 스택만, 다음 핸드부터 계산";
    let main: ReactNode;
    let line: ReactNode;
    let lineClass = "";
    if (amountValue(t) === null) {
      main = <b className="calc-num ph">{t ? t : "지금 스택은?"}</b>;
      lineClass = " hint";
      if (p.editing && (p.res === "fold" || p.res === "walk")) {
        const n = p.res === "fold" ? (posted === null ? null : -posted) : w;
        line = (
          <>
            지금 {p.res === "fold" ? "폴드" : "워크"}
            {n ? ` ${signedText(n, "chips")}` : ""}로 저장돼 있어요
          </>
        );
      } else
        line =
          pre !== null ? (
            <>
              전 {fullChips(pre)}
              {bbPart(pre, p.level) && (
                <>
                  {" "}
                  <Bb v={bbPart(pre, p.level)} className="calc-pre" />
                </>
              )}{" "}
              · 빼기는 앱이 해요
            </>
          ) : (
            why
          );
    } else {
      const now = toChips(t, p.stackUnit, p.level);
      main =
        p.stackUnit === "bb" ? (
          <>
            <b className={`calc-num bb${numSize(t)}`}>{t}bb</b>
            {now !== null && <span className="calc-conv">= {fullChips(now)}</span>}
          </>
        ) : (
          <>
            <b className={`calc-num${numSize(t)}`}>{Number(t).toLocaleString()}</b>
            <Bb v={now === null ? null : bbPart(now, p.level)} className={`calc-bb${numSize(t)}`} />
          </>
        );
      const net = now === null ? null : stackNet(now, pre);
      if (now === null) {
        line = "레벨을 골라 주세요";
        lineClass = " hint";
      } else if (net === null) {
        line = why;
        lineClass = " hint";
      } else {
        const bbs = inBb(Math.abs(net), p.level);
        if (bbs !== null && bbs >= BIG_BB) lineClass = " big";
        line = (
          <>
            <NetBb net={net} level={p.level} />
            <small>
              지금 {fullChips(now)} − 전 {fullChips(pre as number)}
            </small>
            {digitSlip(now, pre) && <small className="slip">자릿수 확인</small>}
          </>
        );
      }
    }
    display = (
      <div className="calc-disp" aria-live="polite">
        <div className="calc-main">
          {main}
          {p.stackUnit === "bb" && <UnitToggle unit={p.stackUnit} onUnit={p.onUnit} />}
        </div>
        <div className={`calc-line${lineClass}`}>{line}</div>
      </div>
    );
  } else {
    const a = p.amount ?? "";
    const bbs = amountChips === null ? null : inBb(amountChips, p.level);
    const big = bbs !== null && bbs >= BIG_BB;
    const main = !a ? (
      <b className="calc-num ph">금액은?</b>
    ) : p.unit === "bb" ? (
      <>
        <b className={`calc-num bb${numSize(a)}`}>{shown(a, "bb")}</b>
        {amountChips !== null && <span className="calc-conv">= {fullChips(amountChips)}</span>}
      </>
    ) : (
      <>
        <b className={`calc-num${numSize(a)}`}>{shown(a, "chips")}</b>
        <Bb v={amountChips === null || amountChips === 0 ? null : bbPart(amountChips, p.level)} className={`calc-bb${numSize(a)}`} />
      </>
    );
    let line: ReactNode;
    if (needLevel) line = "레벨을 골라 주세요";
    else if (over)
      // A loss that big can't be (− 손실 rests); a win that big most likely is 지금 스택 typed here.
      line = (
        <>
          {p.res === "-" ? `전 ${fullChips(pre as number)}보다 많이 잃을 순 없어요` : `전 ${fullChips(pre as number)}보다 커요 · 지금 스택이면`}
          <button type="button" className="calc-tostack" onClick={p.onToStack}>
            스택으로
          </button>
        </>
      );
    else if (p.stackNow && amountValue(p.stackNow) !== null) line = `지금 스택 ${fullChips(toChips(p.stackNow, p.stackUnit, p.level) ?? Number(p.stackNow))}도 같이 저장`;
    else line = p.actionsView && !p.act ? "손실·수익을 고르면 닫혀요" : p.editing ? "손실·수익을 누르면 고쳐서 저장" : p.actionsView ? "손실·수익을 누르면 저장" : `손실·수익을 누르면 저장 · 다음 ${p.next}`;
    display = (
      <div className="calc-disp" aria-live="polite">
        <div className={`calc-main${big ? " big" : ""}`}>
          {main}
          <UnitToggle unit={p.unit} onUnit={p.onUnit} />
        </div>
        <div className={`calc-line hint${over || big ? " big" : ""}`}>{line}</div>
      </div>
    );
  }

  // ── the keys ──
  const keys =
    p.mode === "board" ? (
      <>
        <RankKeys marks={p.marks} holeRanks={p.holeRanks} onRank={p.onRank} onBack={p.onBack} onDone={() => p.onTab(p.amount || p.res === "+" || p.res === "-" ? "amount" : "stack")} />
        <SuitKeys target={p.marks[p.target]} onSuit={p.onSuit} />
      </>
    ) : (
      <DigitKeys dot={p.mode === "amount" ? p.unit === "bb" : p.stackUnit === "bb"} onKey={p.onKey} onBack={p.onBack} />
    );

  // ── the buttons ──
  const foldSub = posted === null ? (p.custom ? "블라인드 ?" : "블라인드 · 레벨 ?") : posted ? shortSigned(-posted) : null;
  const foldBb = posted && !four ? bbPart(posted, p.level) : null;
  const walkBb = w && !four ? bbPart(w, p.level) : null;
  const btns: ReactNode[] = [];
  if (fold)
    btns.push(
      <button key="fold" type="button" className={`c-fold${p.res === "fold" ? " on" : ""}`} onClick={p.onFold}>
        폴드
        {foldSub && (
          <small>
            {foldSub}
            {foldBb && (
              <>
                {" · "}
                <Bb v={foldBb} />
              </>
            )}
          </small>
        )}
      </button>,
    );
  if (walk)
    btns.push(
      <button key="walk" type="button" className={`c-walk${p.res === "walk" ? " on" : ""}`} onClick={p.onWalk}>
        워크
        {w !== null && (
          <small>
            {shortSigned(w)}
            {walkBb && (
              <>
                {" · "}
                <Bb v={walkBb} />
              </>
            )}
          </small>
        )}
      </button>,
    );
  if (p.actionsView && p.act)
    btns.push(
      <button key="none" type="button" className="c-none" onClick={p.onNoResult}>
        결과 없이
        <small>{p.act}만</small>
      </button>,
    );
  if (amountMode) {
    const sub = (s: "+" | "-") => (v === null ? "금액 없이" : v === 0 ? "본전" : amountChips === null ? "레벨 ?" : `${s === "+" ? "+" : MINUS}${fullChips(amountChips)}`);
    btns.push(
      <button key="lose" type="button" className={`c-lose${p.res === "-" ? " on" : ""}`} disabled={over || needLevel} onClick={() => p.onSign("-")}>
        {MINUS} 손실
        <small>{sub("-")}</small>
      </button>,
      <button key="win" type="button" className={`c-win${p.res === "+" ? " on" : ""}`} disabled={needLevel} onClick={() => p.onSign("+")}>
        + 수익
        <small>{sub("+")}</small>
      </button>,
    );
  } else {
    const confirmOnly = p.actionsView && !p.act;
    const plain = !p.res && !p.editing && !p.actionsView && !p.waits;
    const label = confirmOnly ? "확인" : p.waits ?? (p.editing ? "고쳐서 저장" : p.res === "stack" && pre === null ? "스택만 저장" : p.res || p.act ? "저장" : "결과 없이 저장");
    const net = p.mode === "board" ? typedNet(p) : null;
    const sub = confirmOnly ? "계산기 닫기" : p.waits ? null : p.editing ? null : p.actionsView ? `${p.act} · 다음 ${p.next}` : `${net !== null && net !== 0 ? `${signedText(net, "chips")} · ` : ""}다음 ${p.next}`;
    btns.push(
      <button key="save" type="button" className={`c-save${plain ? " plain" : ""}${p.waits && !confirmOnly ? " wait" : ""}`} disabled={!!p.waits && !confirmOnly} onClick={p.onSave}>
        {label}
        {sub && <small>{sub}</small>}
      </button>,
    );
  }
  return (
    <>
      <div className="calc-top">
        {tabs}
        {p.act && <span className="calc-act">{p.act} · 결과는?</span>}
        {chip}
      </div>
      {display}
      {keys}
      <div className={`calc-acts n${btns.length}${amountMode ? " signs" : ""}`}>{btns}</div>
    </>
  );
}

/** 칩 | bb for the number typed (금액; 지금 스택 only for a draft typed in bb): the digits stay, only their meaning changes. */
function UnitToggle({ unit, onUnit }: { unit: Unit; onUnit: (u: Unit) => void }) {
  return (
    <div className="calc-unit" role="group" aria-label="단위">
      <button type="button" className={unit === "chips" ? "on" : ""} aria-pressed={unit === "chips"} onClick={() => onUnit("chips")}>
        칩
      </button>
      <button type="button" className={unit === "bb" ? "on" : ""} aria-pressed={unit === "bb"} onClick={() => onUnit("bb")}>
        bb
      </button>
    </div>
  );
}

/**
 * The page's 결과 row while the sheet is closed: what the hand saves as, with its bb ("스택 61,800 123.6bb → +12,800
 * +25.6bb", "−12,000 −24bb", "폴드 −1,000 −2bb", and the board remembered), or what to do; a tap opens the sheet. The
 * level chip at its right (the picker, or a 직접 입력 tournament's blinds editor).
 */
export function ResultRow(p: {
  enabled: boolean;
  seat: string;
  level: Lv;
  levelText: string;
  levelClass: string;
  pickerOpen: boolean;
  res?: FastRes;
  amount?: string;
  unit: Unit;
  stackNow?: string;
  stackUnit: Unit;
  marks: BoardMark[];
  before: StackAt;
  bbAnte: boolean;
  onOpen: () => void;
  onLevel: () => void;
}) {
  const parts: ReactNode[] = [];
  const now = p.stackNow ? toChips(p.stackNow, p.stackUnit, p.level) : null;
  const out = draftResult({ res: p.res, amount: p.amount, unit: p.unit, seat: p.seat, level: p.level, bbAnte: p.bbAnte, stackNow: p.stackNow, stackUnit: p.stackUnit, before: p.before.chips });
  const net = "block" in out ? null : out.net;
  if (p.res === "stack" && p.stackNow) {
    parts.push(
      <Fragment key="s">
        스택 {now !== null ? fullChips(now) : `${p.stackNow}bb`}
        {now !== null && bbPart(now, p.level) && (
          <>
            {" "}
            <Bb v={bbPart(now, p.level)} />
          </>
        )}
      </Fragment>,
    );
    if (net !== null)
      parts.push(
        <Fragment key="n">
          {" → "}
          <NetBb net={net} level={p.level} />
        </Fragment>,
      );
  } else if (p.res === "fold" || p.res === "walk") {
    parts.push(
      <Fragment key="f">
        {p.res === "fold" ? "폴드" : "워크"}
        {net ? (
          <>
            {" "}
            <NetBb net={net} level={p.level} />
          </>
        ) : null}
      </Fragment>,
    );
  } else if (p.res === "+" || p.res === "-") {
    parts.push(net !== null ? <NetBb key="n" net={net} level={p.level} /> : <Fragment key="n">{p.res === "+" ? "수익" : "손실"} · 금액 없이</Fragment>);
  } else if (p.amount) {
    parts.push(<Fragment key="a">{shown(p.amount, p.unit)} · 수익? 손실?</Fragment>);
  }
  if (p.marks.length)
    parts.push(
      <Fragment key="b">
        {parts.length ? " · " : "보드 "}
        <MarksText marks={p.marks} className="rr-board" />
      </Fragment>,
    );
  const hint = !p.enabled ? "결과" : parts.length ? null : "결과 · 누르면 계산기";
  return (
    <div className="fast-resrow fast-under">
      <button type="button" className={`rr-sum${hint ? " hint" : ""}`} disabled={!p.enabled} onClick={p.onOpen}>
        {hint ?? parts}
      </button>
      <button type="button" className={`fast-lv${p.levelClass}`} aria-expanded={p.pickerOpen} aria-label={`${chipLabel(p.levelText)} · 바꾸기`} onClick={p.onLevel}>
        {p.levelText} <i>{p.pickerOpen ? "▴" : "▾"}</i>
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
  // A part of the total under it: in the unit shown, with its bb next to the chips.
  const part = (c: number, b: number | null): Part[] => (inBbView && b !== null ? [{ bb: totalText(b, "bb") }] : [totalText(c, "chips"), ...bbAfter(b === null ? null : totalText(b, "bb"))]);
  const upd = missed?.upd ?? null;
  const gap = missed?.gap ?? null;
  // The hands missed: the jumps other than 칩 업데이트 and 결과 모름 (shown when there are any, or nothing else to show).
  const lost = missed ? missedPart(missed) : null;
  return (
    <div className="fast-money">
      <b className={`fm-total${tone}`}>{main}</b>
      {sub && <span className={`fm-sub${inBbView ? "" : " bb"}`}>{sub}</span>}
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
          <Parts
            p={[
              "기록한 핸드 ",
              ...part(money.chips, money.bb),
              ...((!upd && !gap) || lost.chips ? [" · 빠진 핸드 ", ...part(lost.chips, lost.bb)] : []),
              ...(gap ? [" · 결과 모름 ", ...part(gap.chips, gap.bb)] : []),
              ...(upd ? [" · 칩 업데이트 ", ...part(upd.chips, upd.bb)] : []),
            ]}
          />
        </span>
      )}
    </div>
  );
}
