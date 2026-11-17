import { useState } from "react";
import { useBackHandler } from "../../backNav";
import { chipsText } from "./fastChips";
import { fieldsBlock, type TourneyFields } from "./fastTourney";

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
  /** Saves the fields: an error to show, or null when saved (the caller closes the sheet). */
  onSave: (f: TourneyFields) => string | null;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<TourneyFields>(p.initial);
  const [err, setErr] = useState<string | null>(null);
  useBackHandler(() => {
    p.onClose();
    return true;
  });
  const isNew = p.mode === "new";
  const stack = /^\d{1,9}$/.test(f.stack) && Number(f.stack) > 0 ? Number(f.stack) : null;
  const put = (k: keyof TourneyFields, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setErr(null);
  };

  function save() {
    const b = fieldsBlock(f);
    if (b === "clock") return setErr("시각을 읽을 수 없어요 (예: 19:00)");
    if (b === "stack") return setErr("시작 스택은 숫자로 (예: 50000)");
    setErr(p.onSave(f));
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
            <small>레벨 추정에 써요 · 모르면 비워 두세요</small>
          </label>
          <label className="tn-field">
            시작 스택
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={9}
              value={f.stack}
              placeholder="50000"
              autoComplete="off"
              onChange={(e) => put("stack", e.target.value.replace(/[^0-9]/g, "").slice(0, 9))}
            />
            <small>{stack !== null ? `= ${chipsText(stack)}칩` : "모르면 비워 두세요"}</small>
          </label>
        </div>
        <label className="tn-field">
          메모
          <textarea rows={2} maxLength={500} value={f.memo} placeholder="바이인, 테이블, 특이사항…" onChange={(e) => put("memo", e.target.value)} />
        </label>
        {!isNew && <p>시작 시간을 바꾸면 앞으로 적는 핸드의 레벨 추정이 바뀌어요 (저장된 핸드는 그대로).</p>}
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
