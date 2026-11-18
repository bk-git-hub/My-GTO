import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBackHandler } from "../../backNav";
import { RANKS, SUITS, SUIT_SYMBOL } from "../../poker/cards";
import { blindsBack, blindsDraft, blindsFill, blindsFocus, blindsKey, blindsOut, blindsShown, BLINDS_WHY, type BlindField, type BlindsDraft } from "./blindsEdit";
import { canAddRank, chipsText, type BoardMark } from "./fastChips";
import { nextPubBlinds, type Blinds } from "./levelClock";

/**
 * 빠른 기록's calculator sheet: the one number entry of the screen (a hand's result, the blinds of a 직접 입력
 * tournament, 칩 업데이트, a tournament's 시작 스택). It is fixed to the bottom of the screen, never in the page's
 * flow, so opening, typing, saving and closing move nothing on the page. Big keys (three full-width columns,
 * 56px, 62px on tall phones), no input element: the phone's own keyboard never comes up.
 *
 * - The hand's sheet (not modal) sits under the 아재's layer (z 2 < .ajae-host 3): his reaction draws over its top
 *   row for its ~2 s, his layers take no taps. The seat row and the hand row above it stay live.
 * - Modal sheets (칩 업데이트, 시작 스택, the blinds between hands) dim the page and sit over everything.
 * - It slides up (160 ms, transform only; none with reduced motion) and closes at once. Its keys and buttons take
 *   no tap for 250 ms after it opens: it comes up under the finger that tapped the class.
 * - Hardware keys (desktop, tests): 0–9, Backspace, Enter, Escape go to the sheet on top (useCalcKeys).
 */
export function CalcSheet(p: {
  /** Dimmed page, over everything; `over`: over the tournament sheet too. */
  modal?: boolean;
  over?: boolean;
  label: string;
  /** A tap on the dimmed page (modal only). */
  onDim?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(t);
  }, []);
  const cls = `calc${p.modal ? " modal" : ""}${p.over ? " over" : ""}${armed ? " armed" : ""}${p.className ? ` ${p.className}` : ""}`;
  const body = p.modal ? (
    <div className={cls} role="dialog" aria-modal="true" aria-label={p.label}>
      {p.children}
    </div>
  ) : (
    <div className={cls} role="group" aria-label={p.label}>
      {p.children}
    </div>
  );
  return p.modal ? (
    <>
      <div className={`calc-dim${p.over ? " over" : ""}`} onClick={p.onDim} />
      {body}
    </>
  ) : (
    body
  );
}

/** How long the keys rest after the sheet comes up (a ghost tap from the finger that opened it). */
export const ARM_MS = 250;

export interface CalcKeys {
  /** A digit ("0"–"9"). */
  key?: (k: string) => void;
  back?: () => void;
  enter?: () => void;
  escape?: () => void;
}

/** The sheets on screen with their hardware keys, the latest on top: only it takes a key. */
const keyStack: { current: CalcKeys }[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  const top = keyStack[keyStack.length - 1];
  if (!top || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  const h = top.current;
  if (/^\d$/.test(e.key) && h.key) h.key(e.key);
  else if (e.key === "Backspace" && h.back) h.back();
  else if (e.key === "Enter" && h.enter) h.enter();
  else if (e.key === "Escape" && h.escape) h.escape();
  else return;
  e.preventDefault();
}

/** The hardware keys for the sheet that calls it, while it is on screen (the latest one mounted takes them). */
export function useCalcKeys(h: CalcKeys): void {
  const ref = useRef(h);
  useEffect(() => {
    ref.current = h;
  });
  useEffect(() => {
    keyStack.push(ref);
    if (!listening && typeof window !== "undefined") {
      window.addEventListener("keydown", onKeyDown);
      listening = true;
    }
    return () => {
      const i = keyStack.lastIndexOf(ref);
      if (i >= 0) keyStack.splice(i, 1);
    };
  }, []);
}

/** The digit keys: 1–9, then 000 (or "." typing bb), 0 and ⌫, three to a row. */
export function DigitKeys({ dot = false, onKey, onBack }: { dot?: boolean; onKey: (k: string) => void; onBack: () => void }) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", dot ? "." : "000", "0"];
  return (
    <div className="calc-keys">
      {keys.map((k) => (
        <button key={k} type="button" className={k === "000" ? "k-000" : k === "." ? "k-dot" : undefined} aria-label={k === "000" ? "영 세 개" : k === "." ? "소수점" : undefined} onClick={() => onKey(k)}>
          {k}
        </button>
      ))}
      <button type="button" className="k-back" aria-label="지우기" onClick={onBack}>
        ⌫
      </button>
    </div>
  );
}

/** The board's rank keys, five to a row: A K Q J T / 9 8 7 6 5 / 4 3 2 ⌫ 완료; a rank that can't be dealt again with this class rests. */
export function RankKeys({ marks, holeRanks, onRank, onBack, onDone }: { marks: BoardMark[]; holeRanks: number[]; onRank: (r: number) => void; onBack: () => void; onDone: () => void }) {
  return (
    <div className="calc-keys ranks">
      {"AKQJT98765432".split("").map((k) => {
        const r = RANKS.indexOf(k);
        return (
          <button key={k} type="button" disabled={!canAddRank(marks, r, holeRanks)} onClick={() => onRank(r)}>
            {k}
          </button>
        );
      })}
      <button type="button" className="k-back" aria-label="지우기" onClick={onBack}>
        ⌫
      </button>
      <button type="button" className="k-done" onClick={onDone}>
        완료
      </button>
    </div>
  );
}

/** ♠♥♦♣ for the board card ringed (the last one, or a slot tapped), only if remembered. */
export function SuitKeys({ target, onSuit }: { target: BoardMark | undefined; onSuit: (s: number) => void }) {
  return (
    <div className="calc-suits" role="group" aria-label={target ? `${RANKS[target.r]} 수트 (기억나면)` : "카드 수트 (기억나면)"}>
      {SUITS.split("").map((su, s) => (
        <button key={su} type="button" className={`s-${su}${target?.s === s ? " on" : ""}`} aria-pressed={target?.s === s} disabled={!target} onClick={() => onSuit(s)}>
          {SUIT_SYMBOL[su]}
        </button>
      ))}
    </div>
  );
}

/** Blinds as the 적용 button and the chip read them: "400/800 (800)", "400/800 노앤티". */
export const blindsShort = (b: Blinds): string => `${chipsText(b.sb)}/${chipsText(b.bb)} ${b.ante ? `(${chipsText(b.ante)})` : "노앤티"}`;

/**
 * The blinds editor in the sheet: "블라인드 [다음 ▸ 500/1,000] [닫기]", the three fields (SB / BB / 앤티, BB
 * focused first, SB and 앤티 following BB until typed), the keys, [취소] [적용 · …]. `applyNote`: what 적용 does
 * ("새 핸드부터", "이 핸드만").
 */
export function BlindsPanel({ initial, applyNote, onApply, onCancel }: { initial: Blinds | null; applyNote: string; onApply: (b: Blinds) => void; onCancel: () => void }) {
  const [d, setD] = useState<BlindsDraft>(() => blindsDraft(initial));
  const shown = blindsShown(d);
  const out = blindsOut(d);
  const next = nextPubBlinds(shown.bb !== null ? { sb: shown.sb ?? 0, bb: shown.bb, ante: shown.ante ?? 0 } : initial);
  const apply = () => "blinds" in out && onApply(out.blinds);
  useCalcKeys({ key: (k) => setD((x) => blindsKey(x, k)), back: () => setD(blindsBack), enter: apply, escape: onCancel });
  const field = (f: BlindField, label: string, tag: string | null, v: number | null) => (
    <button key={f} type="button" className={`calc-field${d.focus === f ? " on" : ""}`} aria-pressed={d.focus === f} aria-label={`${label} ${v === null ? "비어 있음" : chipsText(v)}`} onClick={() => setD((x) => blindsFocus(x, f))}>
      <small>
        {label}
        {tag && <i>{tag}</i>}
      </small>
      <b>{v === null ? "–" : chipsText(v)}</b>
    </button>
  );
  return (
    <>
      <div className="calc-top">
        <b className="calc-title">블라인드</b>
        {next && (
          <button type="button" className="calc-next" onClick={() => setD(blindsFill(next))}>
            다음 ▸ {chipsText(next.sb)}/{chipsText(next.bb)}
          </button>
        )}
        <button type="button" className="calc-x" onClick={onCancel}>
          닫기
        </button>
      </div>
      <div className="calc-fields" aria-live="polite">
        {field("sb", "SB", shown.autoSb ? "자동" : null, shown.sb)}
        {field("bb", "BB", null, shown.bb)}
        {field("ante", "앤티", shown.autoAnte ? "= BB" : shown.ante === 0 ? "없음" : null, shown.ante)}
      </div>
      <DigitKeys onKey={(k) => setD((x) => blindsKey(x, k))} onBack={() => setD(blindsBack)} />
      <div className="calc-acts">
        <button type="button" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="c-save" disabled={!("blinds" in out)} onClick={apply}>
          {"blinds" in out ? "적용" : BLINDS_WHY[out.why]}
          {"blinds" in out && (
            <small>
              {applyNote} · {blindsShort(out.blinds)}
            </small>
          )}
        </button>
      </div>
    </>
  );
}

/** Chips typed on the keypad: digits, at most 9; a leading 0 gives way; "000" on nothing or 0 does nothing. */
export function typeChips(t: string, key: string): string {
  if (!/^\d{1,3}$/.test(key)) return t;
  if (key.length > 1 && (t === "" || t === "0")) return t;
  const next = t === "0" ? key : t + key;
  return next.length > 9 ? t : next;
}

/**
 * A chip count on the keypad, in a modal sheet (칩 업데이트, 시작 스택): the top row (the title, a note, [취소]), the
 * count big with its bb, a line under it, the keys, two buttons. `fresh`: the first key replaces the value shown
 * (a prefilled 50,000), calculator style.
 */
export function ChipsPad(p: {
  label: string;
  title: string;
  note?: ReactNode;
  value: string;
  fresh?: boolean;
  placeholder: string;
  bb: string | null;
  line: ReactNode;
  lineClass?: string;
  left: { label: string; onClick: () => void };
  right: { label: string; onClick: () => void; disabled?: boolean };
  onValue: (v: string) => void;
  onClose: () => void;
  over?: boolean;
}) {
  const [fresh, setFresh] = useState(!!p.fresh);
  useBackHandler(() => {
    p.onClose();
    return true;
  });
  const key = (k: string) => {
    p.onValue(typeChips(fresh ? "" : p.value, k));
    setFresh(false);
  };
  const back = () => {
    p.onValue(p.value.slice(0, -1));
    setFresh(false);
  };
  useCalcKeys({ key, back, enter: () => !p.right.disabled && p.right.onClick(), escape: p.onClose });
  return (
    <CalcSheet modal over={p.over} label={p.label} onDim={p.onClose}>
      <div className="calc-top">
        <b className="calc-title">{p.title}</b>
        {p.note && <span className="calc-note">{p.note}</span>}
        <button type="button" className="calc-x" onClick={p.onClose}>
          취소
        </button>
      </div>
      <div className="calc-disp" aria-live="polite">
        <div className="calc-main">
          {p.value ? <b className={`calc-num${numSize(p.value)}`}>{Number(p.value).toLocaleString()}</b> : <b className="calc-num ph">{p.placeholder}</b>}
          {p.value && p.bb && <b className={`bb calc-bb${numSize(p.value)}`}>{p.bb}</b>}
        </div>
        <div className={`calc-line${p.lineClass ? ` ${p.lineClass}` : ""}`}>{p.line}</div>
      </div>
      <DigitKeys onKey={key} onBack={back} />
      <div className="calc-acts">
        <button type="button" onClick={p.left.onClick}>
          {p.left.label}
        </button>
        <button type="button" className="c-save" disabled={p.right.disabled} onClick={p.right.onClick}>
          {p.right.label}
        </button>
      </div>
    </CalcSheet>
  );
}

/** The big number's size step for long numbers (7+ digits, 9+): " long", " longer". */
export const numSize = (digits: string): string => {
  const n = digits.replace(/\D/g, "").length;
  return n >= 9 ? " longer" : n >= 7 ? " long" : "";
};

/** The blinds editor in a modal sheet of its own (between hands; the tournament sheet's 블라인드): Android back closes it. */
export function BlindsSheet({ initial, applyNote, onApply, onClose, over }: { initial: Blinds | null; applyNote: string; onApply: (b: Blinds) => void; onClose: () => void; over?: boolean }) {
  useBackHandler(() => {
    onClose();
    return true;
  });
  return (
    <CalcSheet modal over={over} label="블라인드" onDim={onClose} className="blinds">
      <BlindsPanel initial={initial} applyNote={applyNote} onApply={onApply} onCancel={onClose} />
    </CalcSheet>
  );
}
