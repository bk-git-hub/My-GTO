import { useState } from "react";
import { useBackHandler } from "../../backNav";
import { bbPart, chipsText, signedText, type StackAt } from "./fastChips";
import { Bb } from "./FastResult";
import { fieldsBlock, type TourneyFields } from "./fastTourney";
import { STACK_MAX, type StackCheck } from "./tourney";

/**
 * 빠른 기록's tournament sheet: a new tournament (새 토너먼트 기록) or the current one's details (its title
 * tapped): 이름, 시작 시간, 시작 스택, 메모. It sits at the top of the screen, over a dimmed page, so the
 * phone's keyboard never covers the fields; a tap outside it, 취소 or the header's ‹ closes it. Nothing
 * takes focus by itself (the keyboard comes up only for the field tapped).
 */
export function TourneySheet(p: {
  mode: "new" | "edit";
  initial: TourneyFields;
  /** 이름's placeholder: the title it gets without one ("11/17 토너먼트"). */
  defaultName: string;
  /** Edit only: no hand carries it (mine or other players'), so it can be deleted. */
  canDelete?: boolean;
  /** Edit only: it is the current tournament ("지금 적는 중" by the title). */
  current?: boolean;
  /** What the 시작 시간 typed gives now ("지금 Lv3 200/400", "시작 전 · 25분 뒤"), shown under it so a wrong start shows before saving; null: nothing to show. */
  levelText?: (clock: string) => string | null;
  /** A line above the buttons (edit: what changing the start does). */
  note?: string;
  /** New only: today's hands from before tournaments still running; with some, a box (ticked) takes them into the new one. */
  join?: number;
  /** Saves the fields (`join`: the box ticked): an error to show, or null when saved (the caller closes the sheet). */
  onSave: (f: TourneyFields, join: boolean) => string | null;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<TourneyFields>(p.initial);
  const [err, setErr] = useState<string | null>(null);
  const [join, setJoin] = useState(true);
  const joinable = p.mode === "new" && (p.join ?? 0) > 0;
  useBackHandler(() => {
    p.onClose();
    return true;
  });
  const isNew = p.mode === "new";
  const stack = /^\d{1,9}$/.test(f.stack) && Number(f.stack) > 0 ? Number(f.stack) : null;
  const lv = p.levelText?.(f.clock) ?? null;
  const put = (k: keyof TourneyFields, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setErr(null);
  };

  function save() {
    const b = fieldsBlock(f);
    if (b === "clock") return setErr("시각을 읽을 수 없어요 (예: 19:00)");
    if (b === "stack") return setErr("시작 스택은 숫자로 (예: 50000)");
    setErr(p.onSave(f, joinable && join));
  }

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
        <label className="tn-field">
          이름
          <input type="text" value={f.name} maxLength={40} placeholder={p.defaultName} enterKeyHint="next" autoComplete="off" onChange={(e) => put("name", e.target.value)} />
        </label>
        <div className="tn-grid">
          <label className="tn-field">
            시작 시간
            <input type="time" value={f.clock} onChange={(e) => put("clock", e.target.value)} />
            {lv ? <small className="tn-lv">{lv}</small> : <small>레벨 추정에 써요 · 모르면 비워 두세요</small>}
          </label>
          <label className="tn-field">
            시작 스택
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={9}
              value={f.stack}
              placeholder="예: 50000"
              autoComplete="off"
              onChange={(e) => put("stack", e.target.value.replace(/[^0-9]/g, "").slice(0, 9))}
            />
            {/* Its bb at the first level's big blind (야자수 새틀 Lv1: 100/200). */}
            <small>
              {stack !== null ? (
                <>
                  = {chipsText(stack)}칩 <Bb v={bbPart(stack, 1)} className="tn-bb" /> (Lv1)
                </>
              ) : (
                "모르면 비워 두세요"
              )}
            </small>
          </label>
        </div>
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
        {p.note && <p>{p.note}</p>}
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
            <span>핸드가 없는 토너먼트예요</span>
            <button
              type="button"
              className="ghost small danger"
              onClick={() => {
                if (confirm("이 토너먼트를 지울까요?")) p.onDelete?.();
              }}
            >
              삭제
            </button>
          </div>
        )}
      </div>
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
  level: number | null,
): { read: { chips: string; bb: string | null } | null; text: string; tone: "big" | "diff" | null } {
  const stack = /^\d{1,9}$/.test(text) && Number(text) <= STACK_MAX ? Number(text) : null;
  if (stack === null) return { read: null, text: "칩 개수 그대로 (0이면 탈락)", tone: null };
  const count = now.chips;
  const ref = open ? open.stack : count;
  const diff = ref !== null ? stack - ref : null;
  const big = count !== null && stack > 0 && count > 0 && (stack >= 3 * count || stack * 3 <= count);
  const vs = diff === null ? "" : diff === 0 ? (open ? "방금과 같아요" : "앱이 센 것과 같아요") : `${open ? "방금보다" : "앱보다"} ${signedText(diff, "chips")}`;
  return { read: { chips: chipsText(stack), bb: bbPart(stack, level) }, text: [vs, big ? "자릿수 확인" : ""].filter(Boolean).join(" · ") || "칩 개수 그대로 (0이면 탈락)", tone: big ? "big" : diff ? "diff" : null };
}

/**
 * 칩 업데이트: my stack counted and typed at any moment (after a break, a rebuy or add-on, or to put the count
 * right). It shows what the app counts now (`now`: the start stack or the last stack on file plus every result
 * since; not known: why), and as the stack is typed, how far it is from that count: the difference goes on the
 * graph as an adjustment, not as a hand. `open`: the last 칩 업데이트, with no hand since, which this one puts right
 * in place: it is what the box shows ("방금 업데이트") and what the stack typed is measured against (chipUpdateNote,
 * which also tints a 0 too many or too few with "자릿수 확인"). The same sheet as the tournament's, at the top over the dimmed page; the field takes the focus (one field: the number pad comes
 * up at once where the phone allows it).
 */
export function ChipUpdateSheet(p: {
  now: StackAt;
  level: number | null;
  open: StackCheck | null;
  /** Saves the stack: an error to show, or null when saved (the caller closes the sheet). */
  onSave: (stack: number) => string | null;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useBackHandler(() => {
    p.onClose();
    return true;
  });
  const stack = /^\d{1,9}$/.test(text) && Number(text) <= STACK_MAX ? Number(text) : null;
  // The box: the 칩 업데이트 just typed while it can be put right in place, else the app's count.
  const ref = p.open ? p.open.stack : p.now.chips;
  const note = chipUpdateNote(text, p.now, p.open, p.level);
  const save = () => (stack === null ? setErr("칩 개수를 숫자로 넣어 주세요 (예: 61800)") : setErr(p.onSave(stack)));
  return (
    <div className="tn-backdrop" onClick={p.onClose}>
      <div className="tn-sheet" role="dialog" aria-modal="true" aria-label="칩 업데이트" onClick={(e) => e.stopPropagation()}>
        <b>칩 업데이트</b>
        <p>지금 칩을 세어서 넣으세요. 앱이 센 스택과 다르면 그 차이만 그래프에 보정으로 들어가요 (핸드로 세지 않아요).</p>
        <div className="tn-count">
          <span>{p.open ? "방금 업데이트" : "앱이 센 스택"}</span>
          {ref !== null ? (
            <b>
              {chipsText(ref)} <Bb v={bbPart(ref, p.level)} />
            </b>
          ) : (
            <small>{p.now.chips === null && p.now.why === "gap" ? "모름 · 결과 없는 핸드가 있어요" : "모름 · 시작 스택이 없어요"}</small>
          )}
        </div>
        <label className="tn-field">
          지금 스택
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={11}
            value={text}
            placeholder={ref !== null ? String(ref) : "예: 61800"}
            autoComplete="off"
            enterKeyHint="done"
            autoFocus
            onChange={(e) => {
              setText(e.target.value.replace(/[^0-9]/g, "").slice(0, 9));
              setErr(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
          {/* The stack typed, read back with its bb (the line keeps its height while empty: nothing moves as it is typed). */}
          <span className="tn-read" aria-live="polite">
            {note.read && (
              <>
                {note.read.chips}칩 <Bb v={note.read.bb} />
              </>
            )}
          </span>
          <small className={note.tone === "big" ? "tn-big" : note.tone === "diff" ? "tn-lv" : undefined}>{note.text}</small>
        </label>
        {p.open && <p>방금 넣은 칩 업데이트 ({chipsText(p.open.stack)})를 이걸로 고쳐요 · 그 뒤로 핸드가 없어서요.</p>}
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
            업데이트
          </button>
        </div>
      </div>
    </div>
  );
}
