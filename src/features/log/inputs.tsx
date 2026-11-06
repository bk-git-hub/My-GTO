import { useEffect, useState, type ReactNode, type Ref } from "react";
import { CardPicker } from "../../components/Cards";
import { RANKS, SUITS, SUIT_SYMBOL, type Card } from "../../poker/cards";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import { cardText, parseCardText } from "./handAnalysis";
import { levelInfo } from "./handLog";

/**
 * The hand recorder's inputs, shared by the table flow and the quick memo on the past-hands page:
 * cards as text, chip counts, one-row chips, and the tap-to-open rows (the blinds among them).
 */

/** A playing card drawn the way the table draws it. */
export function TableCard({ c, small, hot }: { c: Card; small?: boolean; hot?: boolean }) {
  const suit = SUITS[c & 3];
  return (
    <span className={`rt-card s-${suit} ${small ? "small" : ""} ${hot ? "hot" : ""}`}>
      {RANKS[c >> 2]}
      <small>{SUIT_SYMBOL[suit]}</small>
    </span>
  );
}

/**
 * Cards as text ("AdTd") with a rank/suit keypad; a 52-card table is one tap away.
 * `onValid` hears whether the text is clean: false while it has a typo or a half-typed card,
 * when `cards` still holds the last clean parse rather than what is shown.
 */
export function CardText(props: { label?: string; cards: Card[]; max: number; taken: Card[]; onChange: (cards: Card[]) => void; onValid?: (ok: boolean) => void; placeholder?: string; hint?: string; autoFocus?: boolean; compact?: boolean; inline?: boolean }) {
  const { label, cards, max, taken, onChange, onValid, placeholder, hint, autoFocus, compact, inline } = props;
  const [text, setText] = useState(() => cardText(cards));
  const [picker, setPicker] = useState(false);
  const [keys, setKeys] = useState(!inline);
  // Keep the text in step when the cards change elsewhere (picker, undo).
  useEffect(() => {
    if (parseCardText(text, max, taken).cards.join() !== cards.join()) setText(cardText(cards));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.join()]);
  const parsed = parseCardText(text, max, taken);
  const clean = !parsed.error && !parsed.pending;
  useEffect(() => {
    onValid?.(clean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clean]);
  const update = (t: string) => {
    setText(t);
    const p = parseCardText(t, max, taken);
    if (!p.error && p.cards.join() !== cards.join()) onChange(p.cards);
  };
  return (
    <div className={`cardtext ${compact ? "compact" : ""} ${inline ? "inline" : ""}`}>
      {label && <div className="flow-label">{label}</div>}
      <div className={`cardtext-field ${parsed.error ? "bad" : parsed.cards.length === max ? "ok" : ""}`}>
        <input
          value={text}
          onChange={(e) => update(e.target.value)}
          onFocus={() => setKeys(true)}
          placeholder={placeholder ?? (max === 2 ? "예) AdTd" : "카드")}
          autoFocus={autoFocus}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="none"
        />
        <span className="parsed">
          {parsed.cards.map((c) => (
            <TableCard key={c} c={c} small />
          ))}
        </span>
      </div>
      {parsed.error ? <div className="cardtext-msg bad">{parsed.error}</div> : hint ? <div className="cardtext-msg">{hint}</div> : null}
      {keys && (
        <div className="cardkeys">
          <div className="ranks">
            {"AKQJT98765432".split("").map((k) => (
              <button key={k} type="button" onClick={() => update(text + k)}>
                {k}
              </button>
            ))}
          </div>
          <div className="suits">
            {SUITS.split("").map((s) => (
              <button key={s} type="button" className={`s-${s}`} onClick={() => update(text + s)}>
                {SUIT_SYMBOL[s]}
                <small>{s}</small>
              </button>
            ))}
            <button type="button" onClick={() => update(text.slice(0, -1))} aria-label="지우기">
              ⌫
            </button>
            <button type="button" onClick={() => setPicker(!picker)}>
              표
            </button>
          </div>
        </div>
      )}
      {picker && (
        <CardPicker
          selected={cards}
          max={max}
          disabled={taken}
          onChange={(cs) => {
            onChange(cs);
            setText(cardText(cs));
          }}
        />
      )}
    </div>
  );
}

/** A chip count with thousands separators, or a bb amount. */
export function ChipsInput({ value, onChange, placeholder, unit, autoFocus }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; unit: "chips" | "bb"; autoFocus?: boolean }) {
  const chips = unit === "chips";
  return (
    <input
      inputMode={chips ? "numeric" : "decimal"}
      autoFocus={autoFocus}
      value={value === null ? "" : chips ? value.toLocaleString() : String(value)}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value.replace(chips ? /[^0-9]/g : /[^0-9.]/g, "");
        onChange(raw ? Number(raw) : null);
      }}
    />
  );
}

/**
 * Choices on one row that never wraps (table sizes, seats, results): slim chips, the picked one lit.
 * `className` adds modifiers to "flow-chips one" (e.g. "seats n9").
 */
export function ChipRow<T extends string | number>(props: { items: readonly T[]; value: T | null; onPick: (x: T) => void; label?: (x: T) => string; className?: string }) {
  const { items, value, onPick, label, className } = props;
  return (
    <div className={`flow-chips one${className ? ` ${className}` : ""}`}>
      {items.map((x) => (
        <button key={x} type="button" className={value === x ? "on" : ""} onClick={() => onPick(x)}>
          {label ? label(x) : x}
        </button>
      ))}
    </div>
  );
}

/** A setting shown as one line ("블라인드 · Lv6 400/800") that opens its editor below when tapped. */
export function RowBox(props: { label: string; value: ReactNode; hint: ReactNode; open: boolean; onToggle: () => void; editRef?: Ref<HTMLDivElement>; children?: ReactNode }) {
  const { label, value, hint, open, onToggle, editRef, children } = props;
  return (
    <div className={`flow-row-box ${open ? "open" : ""}`}>
      <button type="button" className="flow-row" aria-expanded={open} onClick={onToggle}>
        <span>{label}</span>
        <b>
          {value} <small>{hint}</small>
        </b>
      </button>
      {open && (
        <div className="flow-edit" ref={editRef}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The blinds row: level and BB ante on one line; opens a level picker (‹ list ›) and the ante switch.
 * `unknownLabel` names the picker's "no level" option (the setup adds that stacks then go in bb).
 */
export function BlindRow(props: { level: number | null; bbAnte: boolean; onLevel: (level: number | null) => void; onAnte: (bbAnte: boolean) => void; open: boolean; onToggle: () => void; editRef?: Ref<HTMLDivElement>; unknownLabel?: string }) {
  const { level, bbAnte, onLevel, onAnte, open, onToggle, editRef, unknownLabel = "레벨 모름 (bb로 입력)" } = props;
  const info = levelInfo(level);
  const bbChips = info?.bb ?? null;
  const levelIdx = BLIND_LEVELS.findIndex(([lv]) => lv === level);
  const stepLevel = (d: number) => {
    const i = levelIdx < 0 ? (d > 0 ? 0 : -1) : levelIdx + d;
    if (i >= 0 && i < BLIND_LEVELS.length) onLevel(BLIND_LEVELS[i][0]);
  };
  const blindText = info ? `Lv${level} · ${info.sb.toLocaleString()}/${info.bb.toLocaleString()}` : "레벨 모름";
  const anteText = !bbAnte ? "앤티 없음" : bbChips ? `BB 앤티 ${bbChips.toLocaleString()}` : "BB 앤티 1bb";
  return (
    <RowBox label="블라인드" value={blindText} hint={anteText} open={open} onToggle={onToggle} editRef={editRef}>
      <div className="flow-level">
        <button type="button" aria-label="레벨 내리기" disabled={levelIdx <= 0} onClick={() => stepLevel(-1)}>
          ‹
        </button>
        <select className="select" value={level ?? ""} onChange={(e) => onLevel(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{unknownLabel}</option>
          {BLIND_LEVELS.map(([lv, sb, big]) => (
            <option key={lv} value={lv}>
              Lv{lv} · {sb.toLocaleString()}/{big.toLocaleString()}
            </option>
          ))}
        </select>
        <button type="button" aria-label="레벨 올리기" disabled={levelIdx === BLIND_LEVELS.length - 1} onClick={() => stepLevel(1)}>
          ›
        </button>
      </div>
      <label className="flow-check">
        <span>BB 앤티 (BB가 1bb 더 냄)</span>
        <input type="checkbox" checked={bbAnte} onChange={(e) => onAnte(e.target.checked)} />
      </label>
    </RowBox>
  );
}
