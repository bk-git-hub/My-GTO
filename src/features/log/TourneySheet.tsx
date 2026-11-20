import { useState } from "react";
import { useBackHandler } from "../../backNav";
import { BlindsSheet, ChipsPad } from "./CalcSheet";
import { bbPart, blindsText, chipsText, digitSlip, signedText, type StackAt } from "./fastChips";
import { Bb } from "./FastResult";
import { fieldsBlock, PUB_START_STACK, type TourneyFields } from "./fastTourney";
import { blindsOf, type Blinds, type Lv } from "./levelClock";
import { STACK_MAX, type StackCheck } from "./tourney";

/**
 * 빠른 기록's tournament sheet: a new tournament (새 토너먼트 기록) or the current one's details (its title
 * tapped): 구조 (야자수 새틀: the pub's structure, the level from the start time; 직접 입력: the blinds typed by
 * hand as they go up), 이름, 시작 시간 (야자수 새틀 only), 시작 스택 and 블라인드 (직접 입력) on the in-app keypad,
 * 메모. It sits at the top of the screen, over a dimmed page, so the phone's keyboard never covers the fields; a
 * tap outside it, 취소 or the header's ‹ closes it. Nothing takes focus by itself.
 */
export function TourneySheet(p: {
  mode: "new" | "edit";
  initial: TourneyFields;
  /** 이름's placeholder: the title it gets without one ("11/17 토너먼트"). */
  defaultName: string;
  /** Edit only: no hand carries it (mine or other players'), so it can be deleted. */
  canDelete?: boolean;
  /** Hands that go with it when it is deleted. */
  handCount?: number;
  /** Edit only: it is the current tournament ("지금 적는 중" by the title). */
  current?: boolean;
  /** What the 시작 시간 typed gives now ("지금 Lv3 200/400", "시작 전 · 25분 뒤"), shown under it so a wrong start shows before saving; null: nothing to show. */
  levelText?: (clock: string) => string | null;
  /** A line above the buttons (edit: what changing the start does). */
  note?: string;
  /** New only: today's hands from before tournaments still running; with some, a box (ticked) takes them into the new one. */
  join?: number;
  /**
   * The 시작 스택 shown is the pub's 50,000 offered, not a value on file (a new tournament; one whose start stack isn't
   * known): left untouched, it is cleared on switching to 직접 입력 (a wrong start stack would skew every 스택 result)
   * and comes back on switching back. Default: a new tournament's.
   */
  offered?: boolean;
  /** Saves the fields (`join`: the box ticked): an error to show, or null when saved (the caller closes the sheet). */
  onSave: (f: TourneyFields, join: boolean) => string | null;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<TourneyFields>(() => ({ ...p.initial, structure: p.initial.structure ?? "pub", blinds: p.initial.blinds ?? null }));
  const [err, setErr] = useState<string | null>(null);
  const [join, setJoin] = useState(true);
  /** The keypad open over the sheet: 시작 스택, or 직접 입력's blinds. */
  const [pad, setPad] = useState<null | "stack" | "blinds">(null);
  /** 시작 스택 as it was when its keypad opened (취소 puts it back). */
  const [padWas, setPadWas] = useState("");
  const [touched, setTouched] = useState(false);
  const joinable = p.mode === "new" && (p.join ?? 0) > 0;
  useBackHandler(() => {
    p.onClose();
    return true;
  });
  const isNew = p.mode === "new";
  const offered = (p.offered ?? isNew) && p.initial.stack === String(PUB_START_STACK);
  const custom = f.structure === "custom";
  const stack = /^\d{1,9}$/.test(f.stack) && Number(f.stack) > 0 ? Number(f.stack) : null;
  const lv = p.levelText?.(f.clock) ?? null;
  /** The level 시작 스택's bb is counted at: 야자수 새틀 Lv1 (100/200), 직접 입력's starting blinds. */
  const startLv: Lv = custom ? (f.blinds ?? null) : 1;
  const startBb = blindsOf(startLv)?.bb ?? null;
  const put = <K extends keyof TourneyFields>(k: K, v: TourneyFields[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setErr(null);
  };
  /** 구조 switched: an untouched 50,000 offer goes for 직접 입력 and comes back for 야자수 새틀. */
  function pickStructure(to: "pub" | "custom") {
    if (to === f.structure) return;
    setF((x) => ({
      ...x,
      structure: to,
      ...(offered && !touched ? { stack: to === "custom" ? "" : String(PUB_START_STACK) } : {}),
    }));
    setErr(null);
  }

  function save() {
    const b = fieldsBlock(f);
    if (b === "clock") return setErr("시각을 읽을 수 없어요 (예: 19:00)");
    if (b === "stack") return setErr("시작 스택은 숫자로 (예: 50000)");
    if (b === "blinds") return setErr("블라인드를 다시 넣어 주세요");
    setErr(p.onSave(f, joinable && join));
  }

  const switched = !isNew && (p.initial.structure ?? "pub") !== f.structure;
  const stackField = (
    <div className="tn-field">
      시작 스택
      <button
        type="button"
        className={`tn-numfield${stack === null ? " empty" : ""}`}
        aria-label={`시작 스택 ${stack === null ? "모름" : chipsText(stack)} · 계산기로 넣기`}
        onClick={() => {
          setPadWas(f.stack);
          setPad("stack");
        }}
      >
        {stack !== null ? (
          <>
            {chipsText(stack)} <Bb v={bbPart(stack, startLv)} />
          </>
        ) : (
          "모름"
        )}
      </button>
      <small>{custom ? (startBb !== null ? `BB ${chipsText(startBb)} 기준` : "블라인드를 넣으면 bb로") : "Lv1 기준 · 누르면 계산기"}</small>
    </div>
  );

  return (
    <div className="tn-backdrop" onClick={p.onClose}>
      <div className="tn-sheet" role="dialog" aria-modal="true" aria-label={isNew ? "새 토너먼트 기록" : "토너먼트 정보"} onClick={(e) => e.stopPropagation()}>
        {isNew ? (
          <>
            <b>새 토너먼트 기록</b>
            <p>지금부터 적는 핸드는 여기로 모여요. 지난 토너먼트는 토너먼트 기록에서 이어 적을 수 있어요.</p>
          </>
        ) : (
          <div className="tn-sheet-head">
            <b>토너먼트 정보</b>
            {p.current && <span className="log-tag">지금 적는 중</span>}
          </div>
        )}
        <div className="tn-struct" role="radiogroup" aria-label="구조">
          <button type="button" role="radio" aria-checked={!custom} className={!custom ? "on" : ""} onClick={() => pickStructure("pub")}>
            야자수 새틀
            <small>구조표대로 · 레벨 자동</small>
          </button>
          <button type="button" role="radio" aria-checked={custom} className={custom ? "on" : ""} onClick={() => pickStructure("custom")}>
            직접 입력
            <small>블라인드를 직접</small>
          </button>
        </div>
        <label className="tn-field">
          이름
          <input type="text" value={f.name} maxLength={40} placeholder={p.defaultName} enterKeyHint="next" autoComplete="off" onChange={(e) => put("name", e.target.value)} />
        </label>
        {custom ? (
          <div className="tn-grid">
            {stackField}
            <div className="tn-field">
              블라인드
              <button type="button" className={`tn-numfield${f.blinds ? "" : " empty"}`} aria-label={`블라인드 ${f.blinds ? blindsText(f.blinds) : "없음"} · 넣기`} onClick={() => setPad("blinds")}>
                {f.blinds ? (
                  <>
                    {chipsText(f.blinds.sb)}/{chipsText(f.blinds.bb)} <small>{f.blinds.ante ? `앤티 ${chipsText(f.blinds.ante)}` : "노앤티"}</small>
                  </>
                ) : (
                  "＋ 넣기"
                )}
              </button>
              <small>칠 때 레벨 칩에서 바꿔요</small>
            </div>
          </div>
        ) : (
          <div className="tn-grid">
            <label className="tn-field">
              시작 시간
              <input type="time" value={f.clock} onChange={(e) => put("clock", e.target.value)} />
              {lv ? <small className="tn-lv">{lv}</small> : <small>레벨 추정에 써요 · 모르면 비워 두세요</small>}
            </label>
            {stackField}
          </div>
        )}
        {custom && <p className="tn-note">레벨은 칠 때 레벨 칩에서 바꿔요 · 시간으로 추정하지 않아요</p>}
        <label className="tn-field">
          메모
          <textarea rows={2} maxLength={500} value={f.memo} placeholder="바이인, 테이블, 특이사항…" onChange={(e) => put("memo", e.target.value)} />
        </label>
        {joinable && (
          <label className="tn-join">
            <input type="checkbox" checked={join} onChange={(e) => setJoin(e.target.checked)} />
            <span>오늘 토너먼트 없이 적은 {p.join}핸드도 여기로 모으기</span>
          </label>
        )}
        {switched ? <p>저장된 핸드의 블라인드는 그대로예요.</p> : p.note && !custom && <p>{p.note}</p>}
        {err && (
          <div className="cardtext-msg bad" role="alert">
            {err}
          </div>
        )}
        <div className="tn-actions">
          <button type="button" className="ghost" onClick={p.onClose}>
            취소
          </button>
          <button type="button" className="tn-go" onClick={save}>
            {isNew ? "새 토너먼트 시작" : "저장"}
          </button>
        </div>
        {!isNew && p.canDelete && p.onDelete && (
          <div className="tn-del">
            <span>{p.handCount ? `핸드 ${p.handCount}개도 같이 지워져요` : "핸드가 없는 토너먼트예요"}</span>
            <button
              type="button"
              className="ghost small danger"
              onClick={() => {
                if (confirm(p.handCount ? `이 토너먼트와 핸드 ${p.handCount}개를 지울까요? 되돌릴 수 없어요.` : "이 토너먼트를 지울까요?")) p.onDelete?.();
              }}
            >
              토너먼트 삭제
            </button>
          </div>
        )}
      </div>
      {pad === "stack" && (
        // The keypad over the sheet (and its dim): its own taps never reach the sheet's backdrop.
        <div onClick={(e) => e.stopPropagation()}>
          <ChipsPad
            over
            label="시작 스택"
            title="시작 스택"
            note={custom ? (f.blinds ? `직접 입력 · ${chipsText(f.blinds.sb)}/${chipsText(f.blinds.bb)}` : "직접 입력") : "야자수 새틀 · Lv1 100/200"}
            value={f.stack}
            fresh
            placeholder="모름"
            bb={stack !== null ? bbPart(stack, startLv) : null}
            line={startBb !== null ? `${custom ? "" : "Lv1 "}BB ${chipsText(startBb)} 기준 · 모르면 지우기` : "블라인드를 넣으면 bb로 보여요"}
            lineClass="hint"
            left={{ label: "지우기", onClick: () => (put("stack", ""), setTouched(true)) }}
            right={{ label: "확인", onClick: () => setPad(null) }}
            onValue={(v) => {
              put("stack", v);
              setTouched(true);
            }}
            onClose={() => {
              put("stack", padWas);
              setPad(null);
            }}
          />
        </div>
      )}
      {pad === "blinds" && (
        <div onClick={(e) => e.stopPropagation()}>
          <BlindsSheet
            over
            initial={f.blinds ?? null}
            applyNote="시작 블라인드"
            onApply={(b: Blinds) => {
              put("blinds", b);
              setPad(null);
            }}
            onClose={() => setPad(null)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The 칩 업데이트 sheet's lines under the field for `text` typed: the stack read back (`read`: the chips with
 * separators and their bb at `level`, big), then what it means and its tone (`big`: amber, a 0 too many or too
 * few, 3× the app's count or more or a third of it or less; `diff`: gold, it moves the count). Measured against
 * `open` (the 칩 업데이트 just typed, still put right in place) when there is one, else the app's count; the 0
 * check is always against the app's count (the one just typed may be the slip).
 */
export function chipUpdateNote(
  text: string,
  now: StackAt,
  open: StackCheck | null,
  level: Lv,
): { read: { chips: string; bb: string | null } | null; text: string; tone: "big" | "diff" | null } {
  const stack = /^\d{1,9}$/.test(text) && Number(text) <= STACK_MAX ? Number(text) : null;
  if (stack === null) return { read: null, text: "칩 개수 그대로 (0이면 탈락)", tone: null };
  const count = now.chips;
  const ref = open ? open.stack : count;
  const diff = ref !== null ? stack - ref : null;
  const big = digitSlip(stack, count);
  const vs = diff === null ? "" : diff === 0 ? (open ? "방금과 같아요" : "앱이 센 것과 같아요") : `${open ? "방금보다" : "앱보다"} ${signedText(diff, "chips")}`;
  return { read: { chips: chipsText(stack), bb: bbPart(stack, level) }, text: [vs, big ? "자릿수 확인" : ""].filter(Boolean).join(" · ") || "칩 개수 그대로 (0이면 탈락)", tone: big ? "big" : diff ? "diff" : null };
}

/**
 * 칩 업데이트: my stack counted and typed at any moment (after a break, a rebuy or add-on, or to put the count
 * right), on the in-app keypad in a modal calculator sheet. Its top row shows what the app counts now (`now`: the
 * start stack or the last stack on file plus every result since; not known: why), and as the stack is typed, the
 * count big with its bb and how far it is from that count: the difference goes on the graph as an adjustment, not
 * as a hand. `open`: the last 칩 업데이트, with no hand since, which this one puts right in place: it is what the top
 * row shows ("방금 업데이트") and what the stack typed is measured against (chipUpdateNote, which also tints a 0 too
 * many or too few with "자릿수 확인"). No input element: the phone's keyboard never comes up.
 */
export function ChipUpdateSheet(p: {
  now: StackAt;
  level: Lv;
  open: StackCheck | null;
  /** Saves the stack: an error to show, or null when saved (the caller closes the sheet). */
  onSave: (stack: number) => string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const stack = /^\d{1,9}$/.test(text) && Number(text) <= STACK_MAX ? Number(text) : null;
  // The top row: the 칩 업데이트 just typed while it can be put right in place, else the app's count.
  const ref = p.open ? p.open.stack : p.now.chips;
  const note = chipUpdateNote(text, p.now, p.open, p.level);
  const diff = stack !== null && ref !== null ? stack - ref : null;
  const save = () => (stack === null ? setErr("칩 개수를 넣어 주세요 (0이면 탈락)") : setErr(p.onSave(stack)));
  const line = err ? (
    <span className="calc-err" role="alert">
      {err}
    </span>
  ) : diff !== null && diff !== 0 ? (
    <>
      <b className={diff > 0 ? "up" : "down"}>{signedText(diff, "chips")}</b>
      <Bb v={bbPart(diff, p.level, true)} />
      <small>{p.open ? "방금보다" : "앱보다"} · 그래프에 보정으로</small>
      {note.tone === "big" && <small className="slip">자릿수 확인</small>}
    </>
  ) : stack !== null ? (
    note.text
  ) : p.open ? (
    `방금 넣은 ${chipsText(p.open.stack)}을 이걸로 고쳐요`
  ) : (
    "칩 개수 그대로 · 0이면 탈락"
  );
  return (
    <ChipsPad
      label="칩 업데이트"
      title="칩 업데이트"
      note={
        ref !== null ? (
          <>
            {p.open ? "방금 업데이트" : "앱이 센 스택"} <b>{chipsText(ref)}</b> <Bb v={bbPart(ref, p.level)} />
          </>
        ) : p.now.chips === null && p.now.why === "gap" ? (
          "앱이 센 스택 모름 · 결과 없는 핸드가 있어요"
        ) : (
          "앱이 센 스택 모름 · 시작 스택이 없어요"
        )
      }
      value={text}
      placeholder="지금 칩은?"
      bb={stack !== null ? bbPart(stack, p.level) : null}
      line={line}
      lineClass={err ? "bad" : note.tone === "big" ? "big" : stack === null || diff === null || diff === 0 ? "hint" : undefined}
      left={{ label: "취소", onClick: p.onClose }}
      right={{ label: "업데이트", onClick: save }}
      onValue={(v) => {
        setText(v);
        setErr(null);
      }}
      onClose={p.onClose}
    />
  );
}
