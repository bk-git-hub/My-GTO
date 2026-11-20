import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { RANKS, SUITS, SUIT_SYMBOL, type Card } from "../../poker/cards";
import { BLIND_LEVELS } from "../quiz/stackQuiz";
import { cardText, parseCardText } from "./handAnalysis";
import { estimatedLevel, handLevelLabel, handLogStore, levelEstimateAt, levelInfo, levelLabel, setTodayStart, type LoggedHand } from "./handLog";
import { estimateLabel, type LevelEstimate } from "./levelClock";

/**
 * The hand recorder's inputs, shared by the table flow and the screen for another player's hand:
 * cards as text, chip counts, one-row chips, and the tap-to-open rows (the blinds among them).
 */

/** A playing card drawn the way the table draws it; `guess` marks a suit that was guessed (dashed, faded suit). */
export function TableCard({ c, small, hot, guess }: { c: Card; small?: boolean; hot?: boolean; guess?: boolean }) {
  const suit = SUITS[c & 3];
  return (
    <span className={`rt-card s-${suit} ${small ? "small" : ""} ${hot ? "hot" : ""}${guess ? " guess" : ""}`}>
      {RANKS[c >> 2]}
      <small>{SUIT_SYMBOL[suit]}</small>
    </span>
  );
}

const RANK_KEYS = "AKQJT98765432".split("");

/**
 * The thirteen rank keys and ⌫ on two rows of seven, like 빠른 기록's pad and sized with it (--pad-* in
 * styles.css): every card entry of the hand log types its ranks here. `ranksOff` rests the rank keys
 * (all the ranks are in), `backOff` rests ⌫ (nothing to erase).
 */
export function RankKeys(props: { onRank: (rank: string) => void; onBack: () => void; ranksOff?: boolean; backOff?: boolean }) {
  const { onRank, onBack, ranksOff, backOff } = props;
  return (
    <div className="ranks">
      {RANK_KEYS.map((k) => (
        <button key={k} type="button" disabled={ranksOff} onClick={() => onRank(k)}>
          {k}
        </button>
      ))}
      <button type="button" className="back" aria-label="지우기" disabled={backOff} onClick={onBack}>
        ⌫
      </button>
    </div>
  );
}

/**
 * Cards as text ("AdTd") with a rank/suit keypad; a 52-card table is one tap away.
 * `onValid` hears whether the text is clean: false while it has a typo or a half-typed card,
 * when `cards` still holds the last clean parse rather than what is shown. `onChange` gets the same
 * flag with the cards, for a caller that acts on each edit before `onValid` catches up.
 */
export function CardText(props: { label?: string; cards: Card[]; max: number; taken: Card[]; onChange: (cards: Card[], clean: boolean) => void; onValid?: (ok: boolean) => void; placeholder?: string; hint?: string; autoFocus?: boolean; compact?: boolean; inline?: boolean }) {
  const { label, cards, max, taken, onChange, onValid, placeholder, hint, autoFocus, compact, inline } = props;
  const [text, setText] = useState(() => cardText(cards));
  const [keys, setKeys] = useState(!inline);
  // Keep the text in step when the cards change elsewhere (undo, a guessed suit re-picked).
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
    if (!p.error && p.cards.join() !== cards.join()) onChange(p.cards, !p.pending);
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
          <RankKeys onRank={(k) => update(text + k)} onBack={() => update(text.slice(0, -1))} backOff={!text} />
          <div className="suits">
            {SUITS.split("").map((s) => (
              <button key={s} type="button" className={`s-${s}`} onClick={() => update(text + s)}>
                {SUIT_SYMBOL[s]}
                <small>{s}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Digits and one decimal point ("," counts as one): what a bb field keeps of what is typed. */
export const bbText = (t: string) => {
  const raw = t.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const dot = raw.indexOf(".");
  return dot < 0 ? raw : raw.slice(0, dot + 1) + raw.slice(dot + 1).replace(/\./g, "");
};
const bbValue = (t: string): number | null => (t && t !== "." ? Number(t) : null);

/** A chip count with thousands separators, or a bb amount (decimals allowed: "2." stays while 2.5 is typed). */
export function ChipsInput({ value, onChange, placeholder, unit, autoFocus, ariaLabel }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string; unit: "chips" | "bb"; autoFocus?: boolean; ariaLabel?: string }) {
  const chips = unit === "chips";
  const [typed, setTyped] = useState(() => (value === null ? "" : String(value)));
  // The typed text while it still reads as the value ("2." for 2), else the value as it changed elsewhere.
  const bbShown = bbValue(typed) === value ? typed : value === null ? "" : String(value);
  return (
    <input
      aria-label={ariaLabel}
      inputMode={chips ? "numeric" : "decimal"}
      autoFocus={autoFocus}
      value={chips ? (value === null ? "" : value.toLocaleString()) : bbShown}
      placeholder={placeholder}
      onChange={(e) => {
        if (chips) {
          const raw = e.target.value.replace(/[^0-9]/g, "");
          return onChange(raw ? Number(raw) : null);
        }
        const t = bbText(e.target.value);
        setTyped(t);
        onChange(bbValue(t));
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

/** A setting shown as one line ("블라인드 · Lv6 400/800") that opens its editor below when tapped; `sub` adds a small second line. */
export function RowBox(props: { label: string; value: ReactNode; hint: ReactNode; open: boolean; onToggle: () => void; editRef?: Ref<HTMLDivElement>; sub?: ReactNode; children?: ReactNode }) {
  const { label, value, hint, open, onToggle, editRef, sub, children } = props;
  return (
    <div className={`flow-row-box ${open ? "open" : ""}`}>
      <button type="button" className="flow-row" aria-expanded={open} onClick={onToggle}>
        <span>{label}</span>
        <b>
          {value} <small>{hint}</small>
        </b>
      </button>
      {sub && (
        <button type="button" className="flow-row-sub" onClick={onToggle}>
          {sub}
        </button>
      )}
      {open && (
        <div className="flow-edit" ref={editRef}>
          {children}
        </div>
      )}
    </div>
  );
}

/** Hands whose level was set to 레벨 모름 on purpose this session: the start-time estimate leaves them alone. */
export const levelDeclined = new Set<string>();

/** The start time to offer in the clock field: the last one set (any day), else 19:00. */
const lastClock = () => handLogStore.get().startClock?.clock ?? "19:00";

/**
 * The blinds row: level and BB ante on one line. With today's start time set, the level the clock says
 * for this hand's time is shown under it ("⏱ Lv9 추정 · 19:00 시작 3시간 5분째"); without one, the way to
 * set it. Opened: the start time (one small field, remembered for the day), every level by its blinds
 * on one sideways row (800/1,600 can be picked without knowing it is Lv9), 레벨 모름, and the ante.
 * `onLevel` gets `guessed` true for a level taken from the start time. 빠른 기록 passes its tournament's
 * estimate, start setter and clock (the table flow passes none of them: the day's start time as always).
 */
export function LevelRow(props: {
  h: Pick<LoggedHand, "id" | "level" | "levelGuess" | "bbAnte" | "createdAt"> & Partial<Pick<LoggedHand, "blinds">>;
  onLevel: (level: number | null, guessed: boolean) => void;
  onAnte: (bbAnte: boolean) => void;
  open: boolean;
  onToggle: () => void;
  editRef?: Ref<HTMLDivElement>;
  unknownLabel?: string;
  /** 레벨 모름's second line: what happens without a level (the table flow counts in bb). */
  unknownSub?: string;
  /** The estimate to show and offer (빠른 기록: its tournament's); left out: the day's start time for h.createdAt. */
  estimate?: LevelEstimate | null;
  /** Sets the start typed and returns the estimate after it, or false (can't be read, storage refused); left out: the day's start for h.createdAt. */
  onStartClock?: (clock: string) => LevelEstimate | null | false;
  /** The clock offered in the field; left out: the last start set, else 19:00. */
  clockDefault?: string;
}) {
  const { h, onLevel, onAnte, open, onToggle, editRef, unknownLabel = "레벨 모름", unknownSub = "bb로 계산", onStartClock, clockDefault } = props;
  const starts = handLogStore.use();
  const est = props.estimate !== undefined ? props.estimate : levelEstimateAt(h.createdAt, starts);
  const estLv = estimatedLevel(est);
  const info = levelInfo(h.level);
  const bbChips = info?.bb ?? null;
  const [clockOpen, setClockOpen] = useState(false);
  const [clock, setClock] = useState(() => clockDefault ?? lastClock());
  const [msg, setMsg] = useState("");
  const strip = useRef<HTMLDivElement>(null);

  // The level picked (or the estimate) in view when the row opens, and again when a start time gives
  // an estimate (the level it picks is far along the row). A level tapped by hand stays where it is.
  useEffect(() => {
    const row = strip.current;
    if (!open || !row) return;
    const el = row.querySelector<HTMLElement>("button.on") ?? row.querySelector<HTMLElement>("button.est");
    if (!el) return;
    const at = el.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    row.scrollLeft = at - (row.clientWidth - el.clientWidth) / 2;
  }, [open, estLv]);

  // A 직접 입력 hand carried to the table: its own blinds until a level is picked here (withLv replaces them).
  const value = info ? `${levelLabel(h.level)}${h.levelGuess && !est ? " (추정)" : ""}` : h.level === null && h.blinds ? handLevelLabel({ level: null, blinds: h.blinds }) : "레벨 모름";
  const ante = !h.bbAnte ? "앤티 없음" : bbChips ? `BB 앤티 ${bbChips.toLocaleString()}` : "BB 앤티 1bb";
  const sub = est ? `⏱ ${estimateLabel(est)}` : h.level === null ? "레벨이 기억 안 나면: 시작 시각으로 추정 ›" : null;

  function applyClock() {
    // The start of this hand's day (last night's hands filled in the next day keep last night's start).
    const e = onStartClock ? onStartClock(clock) : setTodayStart(clock, h.createdAt) ? levelEstimateAt(h.createdAt) : false;
    if (e === false) return setMsg("시각을 읽을 수 없어요 (예: 19:00)");
    const lv = estimatedLevel(e);
    setClockOpen(false);
    if (lv !== null) {
      setMsg("");
      onLevel(lv, true);
    } else setMsg(e?.phase === "before" ? "그 시각이면 이 핸드는 시작 전이에요" : "이 핸드 시각에는 맞지 않아요");
  }

  return (
    <RowBox label="블라인드" value={value} hint={ante} open={open} onToggle={onToggle} editRef={editRef} sub={open && !est ? null : sub}>
      {est && !clockOpen ? (
        <div className="lv-start">
          <span>
            ⏱ <b>{est.startClock}</b> 시작{estLv !== null ? ` · Lv${estLv} 추정` : ""}
          </span>
          {estLv !== null && (h.level !== estLv || !h.levelGuess) && (
            <button type="button" className="ghost small" onClick={() => onLevel(estLv, true)}>
              Lv{estLv}로
            </button>
          )}
          <button type="button" className="ghost small" onClick={() => (setClock(est.startClock ?? lastClock()), setClockOpen(true))}>
            시각 바꾸기
          </button>
        </div>
      ) : (
        <form
          className="lv-clock"
          onSubmit={(e) => {
            e.preventDefault();
            applyClock();
          }}
        >
          <span>레벨이 기억 안 나면: 시작 시각으로 추정</span>
          <input type="time" value={clock} onChange={(e) => setClock(e.target.value)} aria-label="토너먼트 시작 시각" />
          <button type="submit" className="ghost small">
            추정
          </button>
        </form>
      )}
      {msg && <div className="cardtext-msg bad">{msg}</div>}
      <div className="lv-strip" ref={strip} role="listbox" aria-label="블라인드 고르기">
        <button
          type="button"
          role="option"
          aria-selected={h.level === null}
          className={h.level === null ? "on" : ""}
          onClick={() => {
            levelDeclined.add(h.id);
            onLevel(null, false);
          }}
        >
          <b>{unknownLabel}</b>
          <small>{unknownSub}</small>
        </button>
        {BLIND_LEVELS.map(([lv, sb, big]) => (
          <button key={lv} type="button" role="option" aria-selected={h.level === lv} className={`${h.level === lv ? "on" : ""}${estLv === lv ? " est" : ""}`} onClick={() => onLevel(lv, false)}>
            <b>
              {sb.toLocaleString()}/{big.toLocaleString()}
            </b>
            <small>
              Lv{lv}
              {estLv === lv ? " 추정" : ""}
            </small>
          </button>
        ))}
      </div>
      <label className="flow-check">
        <span>BB 앤티 (BB가 1bb 더 냄)</span>
        <input type="checkbox" checked={h.bbAnte} onChange={(e) => onAnte(e.target.checked)} />
      </label>
    </RowBox>
  );
}
